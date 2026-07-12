import type { CostSink } from "@ytauto/core";
import type { MediaProvider, ObjectStore } from "../types";
import { IMAGE_PRICE_EACH, IMAGE_PRICE_HERO } from "../pricing";

/**
 * fal.ai image generation (synchronous run endpoint). Model env-overridable;
 * default is a fast/cheap flux variant. Hero tier (2026-07-12): pivotal shots
 * route to FAL_IMAGE_MODEL_HERO (e.g. fal-ai/nano-banana-pro — Gemini image
 * model with real world knowledge, far better historical accuracy) when set;
 * unset → hero renders on the standard model, no behaviour change.
 */

/** nano-banana / gemini endpoints take aspect_ratio+resolution, not image_size */
const usesAspectRatioSchema = (model: string) => /nano-banana|gemini/i.test(model);

export function createFalMediaProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): MediaProvider {
  const standardModel = process.env.FAL_IMAGE_MODEL ?? "fal-ai/flux/schnell";
  const heroModel = process.env.FAL_IMAGE_MODEL_HERO?.trim() || null;
  return {
    name: "fal",
    async generateImage({ prompt, aspect, channelId, productionId, idx, storageKeyBase, quality }) {
      const hero = quality === "hero" && !!heroModel;
      const model = hero ? heroModel! : standardModel;
      const [w, h] = aspect === "9:16" ? [1080, 1920] : aspect === "16:9" ? [1920, 1080] : [1080, 1080];
      const body = usesAspectRatioSchema(model)
        ? {
            prompt,
            aspect_ratio: aspect ?? "1:1",
            resolution: "2K",
            num_images: 1,
            output_format: "jpeg",
          }
        : { prompt, image_size: { width: w, height: h }, num_images: 1 };
      const res = await fetch(`https://fal.run/${model}`, {
        method: "POST",
        headers: { Authorization: `Key ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`fal.ai image generation failed (${res.status}): ${await res.text()}`);
      }
      const json = (await res.json()) as { images: { url: string; content_type?: string }[] };
      const image = json.images?.[0];
      if (!image) throw new Error("fal.ai returned no images");

      const imgRes = await fetch(image.url);
      if (!imgRes.ok) throw new Error(`Failed to download generated image (${imgRes.status})`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const mimeType = image.content_type ?? "image/png";
      const ext = mimeType.includes("jpeg") ? "jpg" : "png";

      const storageKey = `${storageKeyBase ?? `productions/${productionId}/beat-${idx}`}.${ext}`;
      await store.put(storageKey, buf, mimeType);
      await costSink.record({
        category: "media",
        provider: "fal",
        model,
        units: { images: 1 },
        costUsd: hero ? IMAGE_PRICE_HERO : IMAGE_PRICE_EACH,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx, ...(hero ? { hero: true } : {}) },
      });
      return { storageKey, mimeType };
    },
  };
}
