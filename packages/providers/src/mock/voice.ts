/**
 * Mock TTS: writes a REAL 44.1kHz 16-bit mono WAV (a soft beep per word with
 * gaps) plus evenly spaced word timestamps. Because the audio and timestamps
 * are genuine, Remotion renders true synced captions with zero API keys.
 */
import type { CostSink } from "@ytauto/core";
import type { ObjectStore, VoiceOption, VoiceProvider, WordTimestamp } from "../types";
import { VOICE_PRICE_PER_KCHAR } from "../pricing";
import { fnv1a } from "./hash";

const SAMPLE_RATE = 44100;
const WORD_SEC = 0.28;
const GAP_SEC = 0.12;

/** A small deterministic voice library so the picker works with zero API keys. */
const MOCK_VOICES: VoiceOption[] = [
  {
    id: "mock-adam",
    name: "Adam (mock)",
    description: "Deep, warm male narrator — documentary tone. Good for history/aviation.",
    labels: { gender: "male", age: "middle_aged", use_case: "narration" },
  },
  {
    id: "mock-rachel",
    name: "Rachel (mock)",
    description: "Calm, clear female narrator.",
    labels: { gender: "female", age: "young", use_case: "narration" },
  },
  {
    id: "mock-clyde",
    name: "Clyde (mock)",
    description: "Energetic male presenter — punchy shorts.",
    labels: { gender: "male", age: "middle_aged", use_case: "characters" },
  },
];

function buildWav(words: string[]): { wav: Buffer; durationSec: number; timestamps: WordTimestamp[] } {
  const totalSec = words.length * (WORD_SEC + GAP_SEC) + 0.5;
  const numSamples = Math.ceil(totalSec * SAMPLE_RATE);
  const data = Buffer.alloc(numSamples * 2);
  const timestamps: WordTimestamp[] = [];

  let cursorSec = 0.25; // lead-in silence
  for (const word of words) {
    const startSec = cursorSec;
    const endSec = startSec + WORD_SEC;
    timestamps.push({ word, startSec, endSec });

    const freq = 440 + (fnv1a(word) % 400); // per-word pitch, deterministic
    const startSample = Math.floor(startSec * SAMPLE_RATE);
    const endSample = Math.floor(endSec * SAMPLE_RATE);
    for (let i = startSample; i < endSample && i < numSamples; i++) {
      const t = (i - startSample) / SAMPLE_RATE;
      // fade in/out to avoid clicks
      const env = Math.min(1, t / 0.02, (endSec - startSec - t) / 0.02);
      const sample = Math.sin(2 * Math.PI * freq * t) * 0.25 * Math.max(0, env);
      data.writeInt16LE(Math.round(sample * 32767), i * 2);
    }
    cursorSec = endSec + GAP_SEC;
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  return { wav: Buffer.concat([header, data]), durationSec: totalSec, timestamps };
}

export function createMockVoiceProvider(store: ObjectStore, costSink: CostSink): VoiceProvider {
  return {
    name: "mock-voice",
    async synthesize({ text, channelId, productionId }) {
      const words = text.split(/\s+/).filter(Boolean);
      const { wav, durationSec, timestamps } = buildWav(words);
      const storageKey = `productions/${productionId}/voiceover.wav`;
      await store.put(storageKey, wav, "audio/wav");
      await costSink.record({
        category: "voice",
        provider: "mock-voice",
        units: { chars: text.length },
        costUsd: (text.length / 1000) * VOICE_PRICE_PER_KCHAR,
        channelId,
        productionId,
      });
      return { storageKey, mimeType: "audio/wav", durationSec, words: timestamps };
    },
    async listVoices(): Promise<VoiceOption[]> {
      return MOCK_VOICES;
    },
  };
}
