import type { CostSink } from "@ytauto/core";
import type { MusicProvider, ObjectStore } from "../types";
import { MUSIC_PRICE_PER_SEC } from "../pricing";

/**
 * ElevenLabs Music (https://api.elevenlabs.io/v1/music) — one instrumental
 * background bed from a text prompt, sized to the voiceover. ElevenLabs caps a
 * single composition well under long-form length, so we clamp the request and
 * let the render loop the bed to fill.
 *
 * Any failure (auth, quota, unexpected shape) degrades to the deterministic
 * mock bed and logs LOUD — a render is never blocked by the music step, and a
 * silent downgrade is visible rather than mistaken for a missing track.
 */
const MODEL_ID = process.env.ELEVENLABS_MUSIC_MODEL_ID ?? "music_v2";
/** ElevenLabs composition length bounds (ms). */
const MIN_MS = 10_000;
const MAX_MS = 300_000;
const DEFAULT_PROMPT =
  "Gentle, unobtrusive instrumental background music for a narrated video. " +
  "Soft, warm, cinematic ambient bed. No vocals. Consistent, low-key mood.";

export function createElevenLabsMusicProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
  fallback: MusicProvider,
): MusicProvider {
  return {
    name: "elevenlabs-music",
    async generateBed(req) {
      const { durationSec, prompt, channelId, productionId, storageKeyBase } = req;
      const lengthMs = Math.max(MIN_MS, Math.min(MAX_MS, Math.round(durationSec * 1000)));
      // hard ceiling so a stuck request can't hang the caller forever
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Number(process.env.ELEVENLABS_MUSIC_TIMEOUT_MS ?? "180000"));
      try {
        const res = await fetch("https://api.elevenlabs.io/v1/music", {
          method: "POST",
          headers: { "xi-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            prompt: prompt?.trim() || DEFAULT_PROMPT,
            music_length_ms: lengthMs,
            model_id: MODEL_ID,
            // it's a bed under narration — never let it sing over the voice
            force_instrumental: true,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          throw new Error(`ElevenLabs Music failed (${res.status}): ${await res.text()}`);
        }
        const audio = Buffer.from(await res.arrayBuffer());
        if (audio.length < 1024) throw new Error("ElevenLabs Music returned an empty track");
        const storageKey = `${storageKeyBase ?? `productions/${productionId}/music`}.mp3`;
        await store.put(storageKey, audio, "audio/mpeg");
        await costSink.record({
          category: "voice",
          provider: "elevenlabs-music",
          model: MODEL_ID,
          units: { audioSec: Math.round(lengthMs / 1000) },
          costUsd: (lengthMs / 1000) * MUSIC_PRICE_PER_SEC,
          channelId,
          productionId,
        });
        return { storageKey, mimeType: "audio/mpeg", durationSec: lengthMs / 1000 };
      } catch (err) {
        console.warn(
          `[music] ⚠ ElevenLabs Music FAILED — serving the deterministic mock bed instead. Check ELEVENLABS_API_KEY music permission / quota:`,
          err,
        );
        return fallback.generateBed(req);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
