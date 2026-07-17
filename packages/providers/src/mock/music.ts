/**
 * Mock background music: writes a REAL 44.1kHz 16-bit mono WAV — a soft,
 * slowly-breathing ambient pad (root + fifth + octave with a gentle amplitude
 * LFO) sized to the requested duration. Because it is genuine low-level audio,
 * the render lays a real music bed under the narration with zero API keys.
 */
import type { CostSink } from "@ytauto/core";
import type { MusicProvider, ObjectStore } from "../types";
import { MUSIC_PRICE_MOCK } from "../pricing";

const SAMPLE_RATE = 44100;
/** A2-rooted minor-ish pad — calm, unobtrusive, key-neutral under speech. */
const PARTIALS = [
  { freq: 110.0, gain: 1.0 }, // A2 root
  { freq: 164.81, gain: 0.6 }, // E3 fifth
  { freq: 220.0, gain: 0.45 }, // A3 octave
  { freq: 277.18, gain: 0.3 }, // C#4 colour
];
/** Master level of the raw bed — kept low; the render ducks it further. */
const BED_LEVEL = 0.22;
const LFO_HZ = 0.08; // slow ~12.5s swell

function buildPadWav(durationSec: number): Buffer {
  const numSamples = Math.max(1, Math.ceil(durationSec * SAMPLE_RATE));
  const data = Buffer.alloc(numSamples * 2);
  const fade = Math.min(1.5, durationSec / 4) * SAMPLE_RATE; // ≤1.5s in/out
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    let sample = 0;
    for (const p of PARTIALS) sample += Math.sin(2 * Math.PI * p.freq * t) * p.gain;
    sample /= PARTIALS.reduce((s, p) => s + p.gain, 0);
    // slow amplitude swell so the bed breathes instead of droning flat
    const lfo = 0.75 + 0.25 * Math.sin(2 * Math.PI * LFO_HZ * t);
    // fade in/out at the edges to avoid clicks
    const env = Math.min(1, i / fade, (numSamples - i) / fade);
    const v = sample * BED_LEVEL * lfo * Math.max(0, env);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
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
  return Buffer.concat([header, data]);
}

export function createMockMusicProvider(store: ObjectStore, costSink: CostSink): MusicProvider {
  return {
    name: "mock-music",
    async generateBed({ durationSec, channelId, productionId, storageKeyBase }) {
      const dur = Math.max(1, durationSec);
      const wav = buildPadWav(dur);
      const storageKey = `${storageKeyBase ?? `productions/${productionId}/music`}.wav`;
      await store.put(storageKey, wav, "audio/wav");
      await costSink.record({
        category: "voice",
        provider: "mock-music",
        units: { audioSec: Math.round(dur) },
        costUsd: MUSIC_PRICE_MOCK,
        channelId,
        productionId,
      });
      return { storageKey, mimeType: "audio/wav", durationSec: dur };
    },
  };
}
