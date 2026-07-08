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
    async synthesize({ text, voiceId, channelId, productionId }) {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(resolveVoice(voiceId))}/with-timestamps?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: process.env.ELEVENLABS_MODEL_ID ?? "eleven_turbo_v2_5",
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

      const storageKey = `productions/${productionId}/voiceover.mp3`;
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
      const res = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": apiKey },
      });
      if (!res.ok) {
        throw new Error(`ElevenLabs voices failed (${res.status}): ${await res.text()}`);
      }
      const json = (await res.json()) as {
        voices: Array<{
          voice_id: string;
          name: string;
          description?: string | null;
          preview_url?: string | null;
          labels?: Record<string, string> | null;
        }>;
      };
      return (json.voices ?? []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        description: v.description ?? undefined,
        previewUrl: v.preview_url ?? undefined,
        labels: v.labels ?? undefined,
      }));
    },
  };
}
