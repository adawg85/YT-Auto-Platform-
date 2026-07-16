import type { CostSink } from "@ytauto/core";
import type { MediaProvider, ObjectStore } from "../types";
import { IMAGE_PRICE_SEEDREAM } from "../pricing";

/**
 * ByteDance Seedream bulk shots, DIRECT via BytePlus ModelArk (2026-07-16: fal
 * stripped — every engine is vendor-direct now). ModelArk's image endpoint is
 * OpenAI-compatible (Bearer ARK_API_KEY, {model,prompt,size,response_format},
 * response `{ data: [{ url }] }`). Selected per channel as the standard/bulk
 * engine (imageEngineFor → "seedream"); hero shots still pin to nano-banana.
 * Reference/edit is supported by passing input image URLs; a failed conditioned
 * call degrades to plain text-to-image. Base URL + model id are env-overridable
 * (ModelArk model ids are dated, e.g. seedream-4-0-250828).
 */

/** ModelArk `size` keyword by render aspect (native 2K tier). */
const SIZE_BY_ASPECT: Record<"9:16" | "16:9" | "1:1", string> = {
  "9:16": "2K",
  "16:9": "2K",
  "1:1": "2K",
};

export function createSeedreamMediaProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): MediaProvider {
  const base = (process.env.ARK_BASE_URL ?? "https://ark.ap-southeast.bytepluses.com").replace(/\/$/, "");
  const model = process.env.SEEDREAM_IMAGE_MODEL ?? "seedream-4-0-250828";

  const call = (body: Record<string, unknown>) =>
    fetch(`${base}/api/v3/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    name: "seedream",
    async generateImage({ prompt, aspect, channelId, productionId, idx, storageKeyBase, quality, referenceImageUrl }) {
      const size = SIZE_BY_ASPECT[aspect ?? "1:1"];
      const baseBody: Record<string, unknown> = {
        model,
        prompt,
        size,
        sequential_image_generation: "disabled",
        response_format: "url",
        watermark: false,
      };
      let res = await call(referenceImageUrl ? { ...baseBody, image: referenceImageUrl } : baseBody);
      if (!res.ok && referenceImageUrl) {
        console.error(`[seedream] conditioned generation failed (${res.status}) — falling back to plain`);
        res = await call(baseBody);
      }
      if (!res.ok) throw new Error(`Seedream (ModelArk) generation failed (${res.status}): ${await res.text()}`);
      const json = (await res.json()) as {
        data?: { url?: string; b64_json?: string }[];
        error?: { message?: string };
      };
      const first = json.data?.[0];
      let buf: Buffer;
      let mimeType = "image/png";
      if (first?.url) {
        const dl = await fetch(first.url);
        if (!dl.ok) throw new Error(`Seedream image download failed (${dl.status})`);
        buf = Buffer.from(await dl.arrayBuffer());
        mimeType = dl.headers.get("content-type")?.split(";")[0] || "image/png";
      } else if (first?.b64_json) {
        buf = Buffer.from(first.b64_json, "base64");
      } else {
        throw new Error(`Seedream returned no image: ${JSON.stringify(json).slice(0, 300)}`);
      }
      const ext = mimeType.includes("jpeg") ? "jpg" : "png";

      const storageKey = `${storageKeyBase ?? `productions/${productionId}/beat-${idx}`}.${ext}`;
      await store.put(storageKey, buf, mimeType);
      await costSink.record({
        category: "media",
        provider: "seedream",
        model,
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
