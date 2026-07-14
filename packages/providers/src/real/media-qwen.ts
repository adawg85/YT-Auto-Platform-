import type { CostSink } from "@ytauto/core";
import type { MediaProvider, ObjectStore } from "../types";
import { IMAGE_PRICE_QWEN } from "../pricing";

/**
 * Qwen-Image bulk shots, DIRECT via DashScope's native async task API (no
 * fal) — the fal-free standard tier (2026-07-14 operator pick: ~3-4x Flux
 * schnell's price for a large quality jump; typography leader). Hero-tier
 * requests never land here — imageEngineFor pins hero to nano-banana — but
 * the adapter honours `quality` anyway in case a caller routes explicitly.
 * Same submit → poll → download shape as the Wan video adapter.
 */

const POLL_INTERVAL_MS = 5_000;

/** DashScope task sizes per render aspect (qwen-image native resolutions). */
const SIZE_BY_ASPECT: Record<"9:16" | "16:9" | "1:1", string> = {
  "9:16": "928*1664",
  "16:9": "1664*928",
  "1:1": "1328*1328",
};

export function createQwenMediaProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): MediaProvider {
  const base = (process.env.DASHSCOPE_IMAGE_BASE_URL ?? "https://dashscope-intl.aliyuncs.com").replace(/\/$/, "");
  const model = process.env.QWEN_IMAGE_MODEL ?? "qwen-image";
  const editModel = process.env.QWEN_IMAGE_MODEL_EDIT ?? "qwen-image-edit";
  const pollTimeoutMs = Number(process.env.VIDEO_POLL_TIMEOUT_SEC ?? "600") * 1000;

  const submitAndPoll = async (body: Record<string, unknown>): Promise<string> => {
    const submit = await fetch(`${base}/api/v1/services/aigc/text2image/image-synthesis`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify(body),
    });
    if (!submit.ok) throw new Error(`Qwen-Image submit failed (${submit.status}): ${await submit.text()}`);
    const submitted = (await submit.json()) as { output?: { task_id?: string } };
    const taskId = submitted.output?.task_id;
    if (!taskId) throw new Error(`Qwen-Image submit returned no task_id: ${JSON.stringify(submitted).slice(0, 300)}`);

    const deadline = Date.now() + pollTimeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`Qwen-Image task ${taskId} timed out`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const poll = await fetch(`${base}/api/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!poll.ok) throw new Error(`Qwen-Image poll failed (${poll.status}): ${await poll.text()}`);
      const status = (await poll.json()) as {
        output?: { task_status?: string; results?: { url?: string }[]; message?: string };
      };
      const s = status.output?.task_status;
      if (s === "SUCCEEDED") {
        const url = status.output?.results?.find((r) => r.url)?.url;
        if (!url) throw new Error(`Qwen-Image task ${taskId} succeeded but returned no image url`);
        return url;
      }
      if (s === "FAILED" || s === "CANCELED" || s === "UNKNOWN") {
        throw new Error(`Qwen-Image task ${taskId} ${s}: ${status.output?.message ?? "no message"}`);
      }
    }
  };

  return {
    name: "qwen-image",
    async generateImage({ prompt, aspect, channelId, productionId, idx, storageKeyBase, quality, referenceImageUrl }) {
      const size = SIZE_BY_ASPECT[aspect ?? "1:1"];
      let url: string;
      // Image-conditioned variant: the edit model reworks the reference per
      // the prompt. If that call fails (schema drift, model unavailable),
      // fall back to plain generation — same pattern as the fal adapter.
      if (referenceImageUrl) {
        try {
          url = await submitAndPoll({
            model: editModel,
            input: { prompt, image_url: referenceImageUrl },
            parameters: { n: 1 },
          });
        } catch (err) {
          console.error(`[qwen-image] conditioned generation failed — falling back to plain:`, err);
          url = await submitAndPoll({ model, input: { prompt }, parameters: { size, n: 1 } });
        }
      } else {
        url = await submitAndPoll({ model, input: { prompt }, parameters: { size, n: 1 } });
      }

      const imgRes = await fetch(url);
      if (!imgRes.ok) throw new Error(`Qwen-Image download failed (${imgRes.status})`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const mimeType = imgRes.headers.get("content-type")?.split(";")[0] || "image/png";
      const ext = mimeType.includes("jpeg") ? "jpg" : "png";

      const storageKey = `${storageKeyBase ?? `productions/${productionId}/beat-${idx}`}.${ext}`;
      await store.put(storageKey, buf, mimeType);
      await costSink.record({
        category: "media",
        provider: "qwen-image",
        model: referenceImageUrl ? editModel : model,
        units: { images: 1 },
        costUsd: IMAGE_PRICE_QWEN,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx, ...(quality === "hero" ? { hero: true } : {}) },
      });
      return { storageKey, mimeType };
    },
  };
}
