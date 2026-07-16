import { createHmac } from "node:crypto";
import type { CostSink } from "@ytauto/core";
import type { ObjectStore, VideoProvider } from "../types";
import { VIDEO_PRICE_KLING_PER_SEC } from "../pricing";

/**
 * Kling (Kuaishou) image-to-video, DIRECT via the Kling Open Platform
 * (2026-07-16 operator add — premium cinematic tier). Auth is a short-lived
 * HS256 JWT minted per request from an Access Key + Secret Key (tokens expire
 * in 30 min, so we sign fresh each call). Submit → poll → download → store,
 * same shape as the Wan/Seedance adapters. Base URL, model id and mode
 * (std/pro) are env-overridable (Kling model ids churn: kling-v2-6, kling-v3…).
 */

const POLL_INTERVAL_MS = 10_000;

/** Mint a Kling JWT: header {HS256}, payload {iss:ak, exp:+30m, nbf:-5s}. */
function klingToken(accessKey: string, secretKey: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: accessKey, exp: now + 1800, nbf: now - 5 });
  const sig = createHmac("sha256", secretKey).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export function createKlingVideoProvider(
  accessKey: string,
  secretKey: string,
  store: ObjectStore,
  costSink: CostSink,
): VideoProvider {
  const base = (process.env.KLING_BASE_URL ?? "https://api.klingai.com").replace(/\/$/, "");
  const model = process.env.KLING_VIDEO_MODEL ?? "kling-v2-6";
  const mode = process.env.KLING_MODE ?? "std"; // std | pro
  const pollTimeoutMs = Number(process.env.VIDEO_POLL_TIMEOUT_SEC ?? "600") * 1000;

  const headers = () => ({
    Authorization: `Bearer ${klingToken(accessKey, secretKey)}`,
    "content-type": "application/json",
  });

  return {
    name: "kling",
    async generateClip({ prompt, imageUrl, imageDataUrl, durationSec, aspect, channelId, productionId, idx, storageKeyBase }) {
      // Kling image field takes a URL or bare base64 (no data: prefix).
      const image = imageUrl ?? (imageDataUrl ? imageDataUrl.replace(/^data:[^,]+,/, "") : undefined);
      if (!image) throw new Error("Kling i2v requires a keyframe image");
      const duration = durationSec > 7 ? "10" : "5"; // Kling supports 5 or 10s
      const aspect_ratio = aspect === "9:16" ? "9:16" : aspect === "16:9" ? "16:9" : "1:1";

      const submit = await fetch(`${base}/v1/videos/image2video`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model_name: model, mode, image, prompt, duration, aspect_ratio }),
      });
      if (!submit.ok) throw new Error(`Kling submit failed (${submit.status}): ${await submit.text()}`);
      const submitted = (await submit.json()) as {
        code?: number;
        message?: string;
        data?: { task_id?: string };
      };
      const taskId = submitted.data?.task_id;
      if (!taskId) throw new Error(`Kling submit returned no task_id: ${JSON.stringify(submitted).slice(0, 300)}`);

      const deadline = Date.now() + pollTimeoutMs;
      let videoUrl: string | null = null;
      for (;;) {
        if (Date.now() > deadline) throw new Error(`Kling task ${taskId} timed out`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const poll = await fetch(`${base}/v1/videos/image2video/${taskId}`, { headers: headers() });
        if (!poll.ok) throw new Error(`Kling poll failed (${poll.status}): ${await poll.text()}`);
        const status = (await poll.json()) as {
          data?: { task_status?: string; task_status_msg?: string; task_result?: { videos?: { url?: string }[] } };
        };
        const s = status.data?.task_status;
        if (s === "succeed") {
          videoUrl = status.data?.task_result?.videos?.[0]?.url ?? null;
          break;
        }
        if (s === "failed") {
          throw new Error(`Kling task ${taskId} failed: ${status.data?.task_status_msg ?? "no message"}`);
        }
        // submitted / processing → keep polling
      }
      if (!videoUrl) throw new Error(`Kling task ${taskId} succeeded but returned no video url`);

      const dl = await fetch(videoUrl);
      if (!dl.ok) throw new Error(`Kling clip download failed (${dl.status})`);
      const buf = Buffer.from(await dl.arrayBuffer());
      const seconds = Number(duration);
      const storageKey = `${storageKeyBase ?? `productions/${productionId}/genclip-${idx}`}.mp4`;
      await store.put(storageKey, buf, "video/mp4");
      await costSink.record({
        category: "media",
        provider: "kling",
        model: `${model}/${mode}`,
        units: { seconds, videos: 1 },
        costUsd: seconds * VIDEO_PRICE_KLING_PER_SEC,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx, i2v: true },
      });
      return { storageKey, mimeType: "video/mp4", durationSec: seconds, engine: "kling", model };
    },
  };
}
