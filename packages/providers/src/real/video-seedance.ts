import type { CostSink } from "@ytauto/core";
import type { ObjectStore, VideoProvider } from "../types";
import { VIDEO_PRICE_SEEDANCE_PER_SEC } from "../pricing";

/**
 * ByteDance Seedance Pro image-to-video via fal's async QUEUE API (2026-07-16):
 * best keyframe-identity i2v — reserved for clips whose shot carries the
 * recurring character (fed the character's Nano keyframe still). Same
 * submit → poll → download → store shape as the Wan/Minimax adapters, but over
 * fal's queue (video tasks take minutes). Reuses the FAL_KEY the image
 * providers use. Resolution defaults to 720p to keep the per-second cost near
 * Wan's; SEEDANCE_VIDEO_RESOLUTION / _MODEL override.
 */

const POLL_INTERVAL_MS = 10_000;
const MIN_CLIP_SEC = 3;

export function createSeedanceVideoProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): VideoProvider {
  const model = process.env.SEEDANCE_VIDEO_MODEL ?? "fal-ai/bytedance/seedance/v1/pro/image-to-video";
  const resolution = process.env.SEEDANCE_VIDEO_RESOLUTION ?? "720p";
  const maxClipSec = Number(process.env.VIDEO_MAX_CLIP_SEC ?? "10");
  const pollTimeoutMs = Number(process.env.VIDEO_POLL_TIMEOUT_SEC ?? "600") * 1000;

  return {
    name: "seedance",
    async generateClip({ prompt, imageUrl, imageDataUrl, durationSec, aspect, channelId, productionId, idx, storageKeyBase }) {
      const image = imageUrl ?? imageDataUrl;
      // Seedance i2v needs a first-frame image; without one there's nothing to
      // preserve identity from — let the caller's fallback keep the still.
      if (!image) throw new Error("Seedance i2v requires a keyframe image");
      const seconds = Math.min(maxClipSec, Math.max(MIN_CLIP_SEC, Math.ceil(durationSec)));
      // fal Seedance exposes duration as a small enum (5/10) — bucket to the
      // nearest supported length; we bill the requested seconds either way.
      const duration = seconds > 7 ? "10" : "5";

      const submit = await fetch(`https://queue.fal.run/${model}`, {
        method: "POST",
        headers: { Authorization: `Key ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          image_url: image,
          resolution,
          duration,
          aspect_ratio: aspect ?? "16:9",
        }),
      });
      if (!submit.ok) throw new Error(`Seedance submit failed (${submit.status}): ${await submit.text()}`);
      const submitted = (await submit.json()) as {
        request_id?: string;
        status_url?: string;
        response_url?: string;
      };
      const statusUrl = submitted.status_url;
      const responseUrl = submitted.response_url;
      if (!statusUrl || !responseUrl) {
        throw new Error(`Seedance submit returned no queue urls: ${JSON.stringify(submitted).slice(0, 300)}`);
      }

      const deadline = Date.now() + pollTimeoutMs;
      for (;;) {
        if (Date.now() > deadline) throw new Error(`Seedance task ${submitted.request_id} timed out`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const poll = await fetch(statusUrl, { headers: { Authorization: `Key ${apiKey}` } });
        if (!poll.ok) throw new Error(`Seedance poll failed (${poll.status}): ${await poll.text()}`);
        const status = (await poll.json()) as { status?: string };
        if (status.status === "COMPLETED") break;
        if (status.status && !["IN_QUEUE", "IN_PROGRESS"].includes(status.status)) {
          throw new Error(`Seedance task ${submitted.request_id} status ${status.status}`);
        }
      }

      const result = await fetch(responseUrl, { headers: { Authorization: `Key ${apiKey}` } });
      if (!result.ok) throw new Error(`Seedance result fetch failed (${result.status}): ${await result.text()}`);
      const out = (await result.json()) as { video?: { url?: string } };
      const videoUrl = out.video?.url;
      if (!videoUrl) throw new Error(`Seedance task ${submitted.request_id} returned no video url`);

      const dl = await fetch(videoUrl);
      if (!dl.ok) throw new Error(`Seedance clip download failed (${dl.status})`);
      const buf = Buffer.from(await dl.arrayBuffer());
      const storageKey = `${storageKeyBase ?? `productions/${productionId}/genclip-${idx}`}.mp4`;
      await store.put(storageKey, buf, "video/mp4");
      await costSink.record({
        category: "media",
        provider: "seedance",
        model,
        units: { seconds, videos: 1 },
        costUsd: seconds * VIDEO_PRICE_SEEDANCE_PER_SEC,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx, i2v: true },
      });
      return { storageKey, mimeType: "video/mp4", durationSec: seconds, engine: "seedance", model };
    },
  };
}
