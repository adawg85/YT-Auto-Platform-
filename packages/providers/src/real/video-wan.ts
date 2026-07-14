import type { CostSink } from "@ytauto/core";
import type { ObjectStore, VideoProvider } from "../types";
import { VIDEO_PRICE_WAN_PER_SEC } from "../pricing";

/**
 * Alibaba Wan beat clips, DIRECT via DashScope's native async task API (no
 * fal). Submit → poll task → download. Model ids are the knob that churns as
 * Wan versions ship (2.6 → 2.7 → …) — both tiers are env-overridable, as is
 * the base URL. NOTE: this is DashScope's NATIVE api/v1 surface, not the
 * OpenAI-compatible-mode path the LLM router uses (DASHSCOPE_BASE_URL) —
 * hence the separate DASHSCOPE_VIDEO_BASE_URL.
 */

const POLL_INTERVAL_MS = 10_000;

/** Wan duration support varies by model tier; clamp requests into [min,max]. */
const MIN_CLIP_SEC = 3;

export function createWanVideoProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): VideoProvider {
  const base = (process.env.DASHSCOPE_VIDEO_BASE_URL ?? "https://dashscope-intl.aliyuncs.com").replace(/\/$/, "");
  const modelT2v = process.env.WAN_VIDEO_MODEL_T2V ?? "wan2.6-t2v";
  const modelI2v = process.env.WAN_VIDEO_MODEL_I2V ?? "wan2.6-i2v-flash";
  const maxClipSec = Number(process.env.VIDEO_MAX_CLIP_SEC ?? "10");
  const pollTimeoutMs = Number(process.env.VIDEO_POLL_TIMEOUT_SEC ?? "600") * 1000;

  return {
    name: "wan",
    async generateClip({ prompt, imageUrl, imageDataUrl, durationSec, aspect, channelId, productionId, idx, storageKeyBase }) {
      const image = imageUrl ?? imageDataUrl;
      const model = image ? modelI2v : modelT2v;
      const duration = Math.min(maxClipSec, Math.max(MIN_CLIP_SEC, Math.ceil(durationSec)));
      const size = aspect === "9:16" ? "720*1280" : "1280*720";

      const submit = await fetch(`${base}/api/v1/services/aigc/video-generation/video-synthesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "X-DashScope-Async": "enable",
        },
        body: JSON.stringify({
          model,
          input: { prompt, ...(image ? { img_url: image } : {}) },
          // t2v takes size; i2v derives the frame from the image and takes
          // resolution — sending both is tolerated, but keep it tidy per mode
          parameters: image
            ? { resolution: "720P", duration }
            : { size, duration },
        }),
      });
      if (!submit.ok) {
        throw new Error(`Wan submit failed (${submit.status}): ${await submit.text()}`);
      }
      const submitted = (await submit.json()) as { output?: { task_id?: string } };
      const taskId = submitted.output?.task_id;
      if (!taskId) throw new Error(`Wan submit returned no task_id: ${JSON.stringify(submitted).slice(0, 300)}`);

      const deadline = Date.now() + pollTimeoutMs;
      let videoUrl: string | null = null;
      for (;;) {
        if (Date.now() > deadline) throw new Error(`Wan task ${taskId} timed out after ${pollTimeoutMs / 1000}s`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const poll = await fetch(`${base}/api/v1/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!poll.ok) throw new Error(`Wan poll failed (${poll.status}): ${await poll.text()}`);
        const status = (await poll.json()) as {
          output?: { task_status?: string; video_url?: string; message?: string };
        };
        const s = status.output?.task_status;
        if (s === "SUCCEEDED") {
          videoUrl = status.output?.video_url ?? null;
          break;
        }
        if (s === "FAILED" || s === "CANCELED" || s === "UNKNOWN") {
          throw new Error(`Wan task ${taskId} ${s}: ${status.output?.message ?? "no message"}`);
        }
        // PENDING / RUNNING → keep polling
      }
      if (!videoUrl) throw new Error(`Wan task ${taskId} succeeded but returned no video_url`);

      const dl = await fetch(videoUrl);
      if (!dl.ok) throw new Error(`Wan clip download failed (${dl.status})`);
      const buf = Buffer.from(await dl.arrayBuffer());
      const storageKey = `${storageKeyBase ?? `productions/${productionId}/genclip-${idx}`}.mp4`;
      await store.put(storageKey, buf, "video/mp4");
      await costSink.record({
        category: "media",
        provider: "wan",
        model,
        units: { seconds: duration, videos: 1 },
        costUsd: duration * VIDEO_PRICE_WAN_PER_SEC,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx, i2v: !!image },
      });
      return { storageKey, mimeType: "video/mp4", durationSec: duration, engine: "wan", model };
    },
  };
}
