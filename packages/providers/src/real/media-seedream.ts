import type { CostSink } from "@ytauto/core";
import type { MediaProvider, ObjectStore } from "../types";
import { IMAGE_PRICE_SEEDREAM } from "../pricing";

/**
 * ByteDance Seedream bulk shots via fal (2026-07-16 operator pick: nicer
 * filler than Qwen at a comparable price — strong photoreal + composition).
 * Selected per channel as the standard/bulk engine (imageEngineFor →
 * "seedream"); hero shots still pin to nano-banana. Reuses the FAL_KEY the base
 * fal provider already uses. Synchronous fal.run, same response shape as the
 * base fal adapter. If a conditioned (reference) call fails it falls back to
 * plain text-to-image — Seedream's /edit takes up to 10 image_urls.
 */

/** fal image_size enum by render aspect (Seedream native sizes). */
const SIZE_BY_ASPECT: Record<"9:16" | "16:9" | "1:1", string> = {
  "9:16": "portrait_16_9",
  "16:9": "landscape_16_9",
  "1:1": "square_hd",
};

export function createSeedreamMediaProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): MediaProvider {
  const model = process.env.SEEDREAM_IMAGE_MODEL ?? "fal-ai/bytedance/seedream/v4.5/text-to-image";
  const editModel = process.env.SEEDREAM_IMAGE_MODEL_EDIT ?? "fal-ai/bytedance/seedream/v4.5/edit";

  const call = (endpoint: string, body: Record<string, unknown>) =>
    fetch(`https://fal.run/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Key ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    name: "seedream",
    async generateImage({ prompt, aspect, channelId, productionId, idx, storageKeyBase, quality, referenceImageUrl }) {
      const image_size = SIZE_BY_ASPECT[aspect ?? "1:1"];
      const baseBody = { prompt, image_size, num_images: 1 };
      let res: Response;
      let usedModel = model;
      if (referenceImageUrl) {
        res = await call(editModel, { prompt, image_urls: [referenceImageUrl], num_images: 1 });
        usedModel = editModel;
        if (!res.ok) {
          console.error(
            `[seedream] conditioned generation failed (${res.status}) — falling back to plain generation`,
          );
          res = await call(model, baseBody);
          usedModel = model;
        }
      } else {
        res = await call(model, baseBody);
      }
      if (!res.ok) throw new Error(`Seedream image generation failed (${res.status}): ${await res.text()}`);
      const json = (await res.json()) as { images?: { url: string; content_type?: string }[] };
      const image = json.images?.[0];
      if (!image) throw new Error("Seedream returned no images");

      const imgRes = await fetch(image.url);
      if (!imgRes.ok) throw new Error(`Seedream image download failed (${imgRes.status})`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const mimeType = image.content_type ?? "image/png";
      const ext = mimeType.includes("jpeg") ? "jpg" : "png";

      const storageKey = `${storageKeyBase ?? `productions/${productionId}/beat-${idx}`}.${ext}`;
      await store.put(storageKey, buf, mimeType);
      await costSink.record({
        category: "media",
        provider: "seedream",
        model: usedModel,
        units: { images: 1 },
        costUsd: IMAGE_PRICE_SEEDREAM,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx, ...(quality === "hero" ? { hero: true } : {}) },
      });
      return { storageKey, mimeType };
    },
  };
}
