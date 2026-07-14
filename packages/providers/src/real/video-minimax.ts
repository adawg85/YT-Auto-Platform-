import type { CostSink } from "@ytauto/core";
import type { ObjectStore, VideoProvider } from "../types";
import { VIDEO_PRICE_MINIMAX_PER_SEC } from "../pricing";

/**
 * Minimax Hailuo beat clips, DIRECT via api.minimax.io's async task API.
 * Submit /v1/video_generation → poll /v1/query/video_generation → resolve the
 * file (download_url directly, or /v1/files/retrieve when only a file_id is
 * returned; GroupId rides along when configured — some account tiers need it).
 * Hailuo duration tiers are 6s or 10s; we clamp up to the nearest.
 */

const POLL_INTERVAL_MS = 10_000;

export function createMinimaxVideoProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): VideoProvider {
  const base = (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io").replace(/\/$/, "");
  const model = process.env.MINIMAX_VIDEO_MODEL ?? "MiniMax-Hailuo-2.3";
  const groupId = process.env.MINIMAX_GROUP_ID?.trim();
  const pollTimeoutMs = Number(process.env.VIDEO_POLL_TIMEOUT_SEC ?? "600") * 1000;
  const headers = { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  return {
    name: "minimax",
    async generateClip({ prompt, imageUrl, imageDataUrl, durationSec, channelId, productionId, idx, storageKeyBase }) {
      const image = imageUrl ?? imageDataUrl;
      const duration = durationSec > 6 ? 10 : 6; // Hailuo tiers
      const submit = await fetch(`${base}/v1/video_generation`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          prompt,
          duration,
          resolution: "768P",
          ...(image ? { first_frame_image: image } : {}),
        }),
      });
      if (!submit.ok) throw new Error(`Minimax submit failed (${submit.status}): ${await submit.text()}`);
      const submitted = (await submit.json()) as {
        task_id?: string;
        base_resp?: { status_code?: number; status_msg?: string };
      };
      if (submitted.base_resp?.status_code && submitted.base_resp.status_code !== 0) {
        throw new Error(`Minimax submit rejected: ${submitted.base_resp.status_msg}`);
      }
      const taskId = submitted.task_id;
      if (!taskId) throw new Error(`Minimax submit returned no task_id: ${JSON.stringify(submitted).slice(0, 300)}`);

      const deadline = Date.now() + pollTimeoutMs;
      let fileId: string | null = null;
      let directUrl: string | null = null;
      for (;;) {
        if (Date.now() > deadline) throw new Error(`Minimax task ${taskId} timed out after ${pollTimeoutMs / 1000}s`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const poll = await fetch(`${base}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, {
          headers,
        });
        if (!poll.ok) throw new Error(`Minimax poll failed (${poll.status}): ${await poll.text()}`);
        const status = (await poll.json()) as {
          status?: string;
          file_id?: string;
          video_url?: string;
          base_resp?: { status_msg?: string };
        };
        if (status.status === "Success") {
          fileId = status.file_id ?? null;
          directUrl = status.video_url ?? null;
          break;
        }
        if (status.status === "Fail") {
          throw new Error(`Minimax task ${taskId} failed: ${status.base_resp?.status_msg ?? "no message"}`);
        }
        // Preparing / Queueing / Processing → keep polling
      }

      let downloadUrl = directUrl;
      if (!downloadUrl && fileId) {
        const gid = groupId ? `&GroupId=${encodeURIComponent(groupId)}` : "";
        const file = await fetch(`${base}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}${gid}`, {
          headers,
        });
        if (!file.ok) throw new Error(`Minimax file retrieve failed (${file.status}): ${await file.text()}`);
        const fileJson = (await file.json()) as { file?: { download_url?: string } };
        downloadUrl = fileJson.file?.download_url ?? null;
      }
      if (!downloadUrl) throw new Error(`Minimax task ${taskId} succeeded but no download URL resolved`);

      const dl = await fetch(downloadUrl);
      if (!dl.ok) throw new Error(`Minimax clip download failed (${dl.status})`);
      const buf = Buffer.from(await dl.arrayBuffer());
      const storageKey = `${storageKeyBase ?? `productions/${productionId}/genclip-${idx}`}.mp4`;
      await store.put(storageKey, buf, "video/mp4");
      await costSink.record({
        category: "media",
        provider: "minimax",
        model,
        units: { seconds: duration, videos: 1 },
        costUsd: duration * VIDEO_PRICE_MINIMAX_PER_SEC,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx, i2v: !!image },
      });
      return { storageKey, mimeType: "video/mp4", durationSec: duration, engine: "minimax", model };
    },
  };
}
