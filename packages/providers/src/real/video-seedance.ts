import type { CostSink } from "@ytauto/core";
import type { ObjectStore, VideoProvider } from "../types";
import { VIDEO_PRICE_SEEDANCE_PER_SEC } from "../pricing";

/**
 * ByteDance Seedance image-to-video, DIRECT via BytePlus ModelArk (2026-07-16:
 * fal stripped — vendor-direct only). ModelArk video is an async content-
 * generation task: create → poll → download, same submit/poll shape as the Wan
 * adapter but on ModelArk's `/api/v3/contents/generations/tasks` surface
 * (Bearer ARK_API_KEY). The keyframe rides as an image_url content part. Base
 * URL, model id, resolution env-overridable (ModelArk model ids are dated).
 * Reserved for character clips (fed the character's Nano keyframe still).
 */

const POLL_INTERVAL_MS = 10_000;
const MIN_CLIP_SEC = 3;

export function createSeedanceVideoProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): VideoProvider {
  const base = (process.env.ARK_BASE_URL ?? "https://ark.ap-southeast.bytepluses.com").replace(/\/$/, "");
  // verified 2026-07-16 against the operator's activated model
  const model = process.env.SEEDANCE_VIDEO_MODEL ?? "dreamina-seedance-2-0-260128";
  const maxClipSec = Number(process.env.VIDEO_MAX_CLIP_SEC ?? "10");
  const pollTimeoutMs = Number(process.env.VIDEO_POLL_TIMEOUT_SEC ?? "600") * 1000;

  return {
    name: "seedance",
    async generateClip({ prompt, imageUrl, imageDataUrl, durationSec, aspect, channelId, productionId, idx, storageKeyBase }) {
      const image = imageUrl ?? imageDataUrl;
      // i2v needs a first-frame image; without one there's nothing to preserve
      // identity from — let the caller's fallback keep the still.
      if (!image) throw new Error("Seedance i2v requires a keyframe image");
      const seconds = Math.min(maxClipSec, Math.max(MIN_CLIP_SEC, Math.ceil(durationSec)));
      const ratio = aspect ?? "16:9";

      const submit = await fetch(`${base}/api/v3/contents/generations/tasks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        // Seedance 2.0 shape (verified live 2026-07-16): the keyframe image needs
        // `role: "first_frame"`, and params are TOP-LEVEL fields — not `--flags`.
        body: JSON.stringify({
          model,
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: image }, role: "first_frame" },
          ],
          ratio,
          duration: seconds,
          generate_audio: false,
          watermark: false,
        }),
      });
      if (!submit.ok) throw new Error(`Seedance (ModelArk) submit failed (${submit.status}): ${await submit.text()}`);
      const submitted = (await submit.json()) as { id?: string };
      const taskId = submitted.id;
      if (!taskId) throw new Error(`Seedance submit returned no task id: ${JSON.stringify(submitted).slice(0, 300)}`);

      const deadline = Date.now() + pollTimeoutMs;
      let videoUrl: string | null = null;
      for (;;) {
        if (Date.now() > deadline) throw new Error(`Seedance task ${taskId} timed out`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const poll = await fetch(`${base}/api/v3/contents/generations/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!poll.ok) throw new Error(`Seedance poll failed (${poll.status}): ${await poll.text()}`);
        const status = (await poll.json()) as {
          status?: string;
          content?: { video_url?: string };
          error?: { message?: string };
        };
        const s = status.status;
        if (s === "succeeded") {
          videoUrl = status.content?.video_url ?? null;
          break;
        }
        if (s === "failed" || s === "canceled" || s === "cancelled") {
          throw new Error(`Seedance task ${taskId} ${s}: ${status.error?.message ?? "no message"}`);
        }
        // queued / running → keep polling
      }
      if (!videoUrl) throw new Error(`Seedance task ${taskId} succeeded but returned no video_url`);

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
