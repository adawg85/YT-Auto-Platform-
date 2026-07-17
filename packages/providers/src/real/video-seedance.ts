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

/** ~sub-second freeze we'll tolerate rather than jump to the next-longer clip.
 * The caller already pads the request by ~0.4s, so this absorbs that plus a
 * frame or two — a beat that's essentially clip-length snaps DOWN cleanly. */
const COVER_SLACK = 0.6;

/**
 * Dreamina/Seedance i2v accepts only DISCRETE durations, not any integer — a
 * request for 6s is rejected with InvalidParameter ("duration ... is not valid
 * for model dreamina-seedance-2-0 in i2v").
 *
 * Snap UP to the smallest allowed value that COVERS the beat, so after the
 * render trims the clip to the beat length there is real motion the whole way
 * through — never a frozen last frame held to fill a gap (operator, 2026-07-17:
 * a still tail on a moving clip "looks terrible"). Beats within COVER_SLACK of a
 * shorter allowed value snap down to it (a <~0.2s hold is invisible and avoids
 * generating a needlessly long clip). Override the set with
 * SEEDANCE_ALLOWED_DURATIONS="5,10" if the activated model differs.
 */
export function seedanceDuration(wantSec: number, allowedEnv: string | undefined): number {
  const allowed = (allowedEnv ?? "5,10")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (allowed.length === 0) return Math.max(MIN_CLIP_SEC, Math.round(wantSec));
  const need = wantSec - COVER_SLACK;
  // smallest allowed clip that covers the beat; if the beat is longer than the
  // longest clip we can make, use the longest (the only unavoidable freeze).
  return allowed.find((d) => d >= need) ?? allowed[allowed.length - 1]!;
}

export function createSeedanceVideoProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
  opts: { model?: string; pricePerSec?: number; name?: string } = {},
): VideoProvider {
  const base = (process.env.ARK_BASE_URL ?? "https://ark.ap-southeast.bytepluses.com").replace(/\/$/, "");
  // Default is the cheaper MINI tier (2026-07-17 operator: Pro is too expensive
  // for cartoon channels). The factory passes the Pro model for the separate
  // "seedance-pro" engine. Env overrides the plain-seedance model.
  const model = opts.model ?? process.env.SEEDANCE_VIDEO_MODEL ?? "dreamina-seedance-2-0-mini-260615";
  const pricePerSec = opts.pricePerSec ?? VIDEO_PRICE_SEEDANCE_PER_SEC;
  const engineName = opts.name ?? "seedance";
  const pollTimeoutMs = Number(process.env.VIDEO_POLL_TIMEOUT_SEC ?? "600") * 1000;

  return {
    name: engineName,
    async generateClip({ prompt, imageUrl, imageDataUrl, durationSec, aspect, channelId, productionId, idx, storageKeyBase }) {
      const image = imageUrl ?? imageDataUrl;
      // i2v needs a first-frame image; without one there's nothing to preserve
      // identity from — let the caller's fallback keep the still.
      if (!image) throw new Error("Seedance i2v requires a keyframe image");
      // Seedance i2v only takes discrete durations — snap UP to one that covers
      // the beat (6s etc. 400s as InvalidParameter). The render trims to the
      // beat, so a covering clip means full motion, no frozen tail.
      const seconds = seedanceDuration(durationSec, process.env.SEEDANCE_ALLOWED_DURATIONS);
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
        provider: engineName,
        model,
        units: { seconds, videos: 1 },
        costUsd: seconds * pricePerSec,
        channelId,
        productionId,
        meta: { prompt: prompt.slice(0, 200), idx, i2v: true },
      });
      return { storageKey, mimeType: "video/mp4", durationSec: seconds, engine: engineName, model };
    },
  };
}
