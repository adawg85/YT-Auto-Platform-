import type { CostSink } from "@ytauto/core";
import type { ObjectStore, VoiceOption, VoiceProvider, WordTimestamp } from "../types";
import { VOICE_PRICE_PER_KCHAR } from "../pricing";

type ElevenLabsAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

/** Convert ElevenLabs character-level alignment to word-level timestamps. */
export function charsToWords(alignment: ElevenLabsAlignment): WordTimestamp[] {
  const words: WordTimestamp[] = [];
  let current = "";
  let startSec = 0;
  let endSec = 0;
  for (let i = 0; i < alignment.characters.length; i++) {
    const ch = alignment.characters[i]!;
    const cs = alignment.character_start_times_seconds[i] ?? endSec;
    const ce = alignment.character_end_times_seconds[i] ?? cs;
    if (/\s/.test(ch)) {
      if (current) words.push({ word: current, startSec, endSec });
      current = "";
    } else {
      if (!current) startSec = cs;
      current += ch;
      endSec = ce;
    }
  }
  if (current) words.push({ word: current, startSec, endSec });
  return words;
}

export function createElevenLabsProvider(
  apiKey: string,
  store: ObjectStore,
  costSink: CostSink,
): VoiceProvider {
  // Channel DNA defaults voiceId to the placeholder "default", which is not a
  // real ElevenLabs voice (TTS 404s "voice_not_found"). Resolve it to the
  // operator's configured voice (ELEVENLABS_VOICE_ID), else a stable premade
  // (Rachel). Set ELEVENLABS_VOICE_ID or the channel's voice to override.
  const fallbackVoice = process.env.ELEVENLABS_VOICE_ID?.trim() || "21m00Tcm4TlvDq8ikWAM";
  const resolveVoice = (voiceId: string) =>
    voiceId && voiceId !== "default" ? voiceId : fallbackVoice;
  return {
    name: "elevenlabs",
    async synthesize({ text, voiceId, channelId, productionId, voiceSettings, storageKeyBase }) {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(resolveVoice(voiceId))}/with-timestamps?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: process.env.ELEVENLABS_MODEL_ID ?? "eleven_turbo_v2_5",
            // Production Profile "delivery" axis → ElevenLabs voice_settings.
            ...(voiceSettings
              ? {
                  voice_settings: {
                    stability: voiceSettings.stability,
                    similarity_boost: voiceSettings.similarityBoost,
                    style: voiceSettings.style,
                    use_speaker_boost: voiceSettings.useSpeakerBoost,
                    // Persona pace (BACKLOG #26): ElevenLabs supports 0.7–1.2.
                    // Only sent when set — omitted keeps the voice's default.
                    ...(voiceSettings.speed != null
                      ? { speed: Math.min(1.2, Math.max(0.7, voiceSettings.speed)) }
                      : {}),
                  },
                }
              : {}),
          }),
        },
      );
      if (!res.ok) {
        throw new Error(`ElevenLabs TTS failed (${res.status}): ${await res.text()}`);
      }
      const json = (await res.json()) as { audio_base64: string; alignment: ElevenLabsAlignment };
      const audio = Buffer.from(json.audio_base64, "base64");
      const words = charsToWords(json.alignment);
      const durationSec = words.length ? words[words.length - 1]!.endSec + 0.3 : 0;

      const storageKey = `${storageKeyBase ?? `productions/${productionId}/voiceover`}.mp3`;
      await store.put(storageKey, audio, "audio/mpeg");
      await costSink.record({
        category: "voice",
        provider: "elevenlabs",
        model: process.env.ELEVENLABS_MODEL_ID ?? "eleven_turbo_v2_5",
        units: { chars: text.length },
        costUsd: (text.length / 1000) * VOICE_PRICE_PER_KCHAR,
        channelId,
        productionId,
      });
      return { storageKey, mimeType: "audio/mpeg", durationSec, words };
    },
    async listVoices(): Promise<VoiceOption[]> {
      // The /voices endpoint needs the `voices_read` key permission. If the key
      // lacks it (or the call fails), fall back to the stable premade voices so
      // the picker still works — the operator can pick a real voice instead of
      // being stuck typing a raw id. Add `voices_read` to the key for the full
      // library (incl. cloned voices).
      try {
        const res = await fetch("https://api.elevenlabs.io/v1/voices", {
          headers: { "xi-api-key": apiKey },
        });
        if (!res.ok) return ELEVENLABS_PREMADE_VOICES;
        const json = (await res.json()) as {
          voices: Array<{
            voice_id: string;
            name: string;
            description?: string | null;
            preview_url?: string | null;
            labels?: Record<string, string> | null;
          }>;
        };
        const mapped = (json.voices ?? []).map((v) => ({
          id: v.voice_id,
          name: v.name,
          description: v.description ?? undefined,
          previewUrl: v.preview_url ?? undefined,
          labels: v.labels ?? undefined,
        }));
        return mapped.length ? mapped : ELEVENLABS_PREMADE_VOICES;
      } catch {
        return ELEVENLABS_PREMADE_VOICES;
      }
    },
  };
}

/**
 * Stable ElevenLabs premade voices (public, unchanging ids). Used as the
 * voice-picker fallback when the API key can't list the account's library.
 */
export const ELEVENLABS_PREMADE_VOICES: VoiceOption[] = [
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", labels: { gender: "male", use_case: "narration" }, description: "Deep, engaging — documentary narration." },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", labels: { gender: "female", use_case: "narration" }, description: "Calm, warm — clear narration." },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni", labels: { gender: "male", use_case: "narration" }, description: "Well-rounded, warm." },
  { id: "VR6AewLTigWG4xSOukaG", name: "Arnold", labels: { gender: "male", use_case: "narration" }, description: "Crisp, assertive." },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", labels: { gender: "female", use_case: "narration" }, description: "Soft, expressive." },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh", labels: { gender: "male", use_case: "narration" }, description: "Young, energetic." },
  { id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam", labels: { gender: "male", use_case: "narration" }, description: "Neutral, versatile." },
  { id: "2EiwWnXFnvU5JabPnv8n", name: "Clyde", labels: { gender: "male", use_case: "character" }, description: "Gravelly character voice." },
];
