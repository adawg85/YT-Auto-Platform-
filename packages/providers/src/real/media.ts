import type { CostSink } from "@ytauto/core";
import type { MediaProvider, ObjectStore } from "../types";
import { IMAGE_PRICE_EACH } from "../pricing";

/**
 * fal.ai image generation (synchronous run endpoint). Model env-overridable;
 * default is a fast/cheap flux variant.
 */
export function createFalMediaProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): MediaProvider {
  const model = process.env.FAL_IMAGE_MODEL ?? "fal-ai/flux/schnell";
  return {
    name: "fal",
    async generateImage({ prompt, aspect, channelId, productionId, idx, storageKeyBase }) {
      const [w, h] = aspect === "9:16" ? [1080, 1920] : [1080, 1080];
      const res = await fetch(`https://fal.run/${model}`, {
        method: "POST",
        headers: { Authorization: `Key ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          image_size: { width: w, height: h },
          num_images: 1,
        }),
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
        costUsd: IMAGE_PRICE_EACH,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx },
      });
      return { storageKey, mimeType };
    },
  };
}
