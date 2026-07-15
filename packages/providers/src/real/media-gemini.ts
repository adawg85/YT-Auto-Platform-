import type { CostSink } from "@ytauto/core";
import type { MediaProvider, ObjectStore } from "../types";
import { IMAGE_PRICE_NANO, IMAGE_PRICE_NANO_PRO } from "../pricing";

/**
 * Google Gemini image generation ("Nano Banana"), called DIRECTLY against the
 * generativelanguage API with the operator's GEMINI_API_KEY — no fal.ai in the
 * path. Standard tier is nano-banana (gemini-2.5-flash-image); hero tier is
 * nano-banana-pro (gemini-3-pro-image, the GA model — the older
 * gemini-3-pro-image-preview was retired 2026-07-17) at 2K. Both env-overridable
 * via GEMINI_IMAGE_MODEL / GEMINI_IMAGE_MODEL_HERO.
 */

/** Pro-family models take an imageConfig.imageSize; flash-image is fixed 1K. */
const supportsImageSize = (model: string) => /pro-image/i.test(model);

type GeminiPart = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
};

export function createGeminiMediaProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): MediaProvider {
  const standardModel = process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image";
  const heroModel = process.env.GEMINI_IMAGE_MODEL_HERO?.trim() || "gemini-3-pro-image";
  return {
    name: "gemini",
    async generateImage({
      prompt,
      aspect,
      channelId,
      productionId,
      idx,
      storageKeyBase,
      quality,
      referenceImageUrl,
      extraReferenceImageUrls,
    }) {
      const hero = quality === "hero";
      const model = hero ? heroModel : standardModel;

      // Image-conditioned generation: nano-banana edits natively — references
      // go in as inline image parts ahead of the instruction, in order
      // (primary first, extras after — the prompt says what each one is for).
      const parts: GeminiPart[] = [];
      for (const url of [referenceImageUrl, ...(extraReferenceImageUrls ?? [])]) {
        if (!url) continue;
        const refRes = await fetch(url);
        if (refRes.ok) {
          const refBuf = Buffer.from(await refRes.arrayBuffer());
          parts.push({
            inlineData: {
              mimeType: refRes.headers.get("content-type")?.split(";")[0] || "image/png",
              data: refBuf.toString("base64"),
            },
          });
        } else {
          console.error(
            `[gemini] reference image fetch failed (${refRes.status}) — continuing without this reference`,
          );
        }
      }
      parts.push({ text: prompt });

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"],
              imageConfig: {
                aspectRatio: aspect ?? "1:1",
                ...(supportsImageSize(model) ? { imageSize: "2K" } : {}),
              },
            },
          }),
        },
      );
      if (!res.ok) {
        throw new Error(`Gemini image generation failed (${res.status}): ${await res.text()}`);
      }
      const json = (await res.json()) as {
        candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
        promptFeedback?: { blockReason?: string };
      };
      const image = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
      if (!image) {
        const why =
          json.promptFeedback?.blockReason ?? json.candidates?.[0]?.finishReason ?? "no image part";
        throw new Error(`Gemini returned no image (${why})`);
      }

      const buf = Buffer.from(image.data, "base64");
      const mimeType = image.mimeType || "image/png";
      const ext = mimeType.includes("jpeg") ? "jpg" : "png";

      const storageKey = `${storageKeyBase ?? `productions/${productionId}/beat-${idx}`}.${ext}`;
      await store.put(storageKey, buf, mimeType);
      await costSink.record({
        category: "media",
        provider: "gemini",
        model,
        units: { images: 1 },
        costUsd: hero ? IMAGE_PRICE_NANO_PRO : IMAGE_PRICE_NANO,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx, ...(hero ? { hero: true } : {}) },
      });
      return { storageKey, mimeType };
    },
  };
}
