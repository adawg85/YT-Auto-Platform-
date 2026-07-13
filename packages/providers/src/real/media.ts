import type { CostSink } from "@ytauto/core";
import type { MediaProvider, ObjectStore } from "../types";
import { IMAGE_PRICE_EACH, IMAGE_PRICE_HERO } from "../pricing";

/**
 * fal.ai image generation (synchronous run endpoint). Model env-overridable;
 * default is a fast/cheap flux variant. Hero tier (thumbnails + hero beat
 * shots) ALWAYS routes to nano-banana-pro (Gemini image model — real-world
 * knowledge, far better historical accuracy, and flux is unacceptable for
 * these frames); FAL_IMAGE_MODEL_HERO overrides the exact model but hero can
 * never fall back to the standard flux model.
 */

/** nano-banana / gemini endpoints take aspect_ratio+resolution, not image_size */
const usesAspectRatioSchema = (model: string) => /nano-banana|gemini/i.test(model);

export function createFalMediaProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): MediaProvider {
  const standardModel = process.env.FAL_IMAGE_MODEL ?? "fal-ai/flux/schnell";
  // Hero tier (thumbnails + hero beat shots) ALWAYS uses nano-banana-pro:
  // operator decision (fal/flux is unacceptable for these highest-leverage
  // frames). Env can override the exact model, but it can never fall back to
  // the standard flux model — the previous `|| null` silently downgraded hero
  // to flux whenever the env was unset (see the flux-era thumbnails in prod).
  const heroModel = process.env.FAL_IMAGE_MODEL_HERO?.trim() || "fal-ai/nano-banana-pro";
  return {
    name: "fal",
    async generateImage({ prompt, aspect, channelId, productionId, idx, storageKeyBase, quality, referenceImageUrl, referenceStrength }) {
      const hero = quality === "hero" && !!heroModel;
      const model = hero ? heroModel! : standardModel;
      const [w, h] = aspect === "9:16" ? [1080, 1920] : aspect === "16:9" ? [1920, 1080] : [1080, 1080];
      const nanoSchema = usesAspectRatioSchema(model);
      const baseBody = nanoSchema
        ? {
            prompt,
            aspect_ratio: aspect ?? "1:1",
            resolution: "2K",
            num_images: 1,
            output_format: "jpeg",
          }
        : { prompt, image_size: { width: w, height: h }, num_images: 1 };
      // image-conditioned variant (2026-07-12): nano-banana edits via /edit
      // (image_urls), flux via /image-to-image (image_url + strength). If the
      // conditioned call fails (model without that variant), fall back plain.
      const call = async (endpoint: string, body: Record<string, unknown>) =>
        fetch(`https://fal.run/${endpoint}`, {
          method: "POST",
          headers: { Authorization: `Key ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      let res: Response;
      if (referenceImageUrl) {
        const refEndpoint = nanoSchema ? `${model}/edit` : `${model}/image-to-image`;
        const refBody = nanoSchema
          ? { ...baseBody, image_urls: [referenceImageUrl] }
          : // 0.8 = heavy rework (swap dialog default); style-transfer
            // conditioning (#35.1) passes ~0.45 via referenceStrength
            { ...baseBody, image_url: referenceImageUrl, strength: referenceStrength ?? 0.8 };
        res = await call(refEndpoint, refBody);
        if (!res.ok) {
          console.error(
            `[fal] conditioned generation on ${refEndpoint} failed (${res.status}) — falling back to plain generation`,
          );
          res = await call(model, baseBody);
        }
      } else {
        res = await call(model, baseBody);
      }
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
