import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { ObjectStore, VoiceProvider, WordTimestamp } from "@ytauto/providers";
import type { CostSink } from "@ytauto/core";

const run = promisify(execFile);
const FF = ffmpegPath as unknown as string;

/**
 * #27 operator-recorded voiceover assembly. Per beat: use the operator's
 * recorded take when one exists, else TTS-fill in the persona voice (hybrid
 * for free). Every piece is normalized to 44.1kHz stereo PCM (duration then
 * computes EXACTLY from byte length — no ffprobe, no stderr parsing),
 * concatenated, and encoded to one mp3 — downstream (shots/captions/render)
 * sees the same single voiceover asset shape TTS produces.
 *
 * Word timestamps per beat: TTS beats carry their own (offset by the beat's
 * start); recorded beats go through Whisper (OPENAI_API_KEY, word
 * granularity) or degrade to a linear estimate over the measured duration —
 * captions stay on, shot cutting keeps working, offline runs stay green.
 */

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

export type BeatTakeInput = {
  beatIdx: number;
  text: string;
  /** operator take, when recorded */
  takeKey?: string;
};

export type AssembledVoiceover = {
  storageKey: string;
  mimeType: string;
  durationSec: number;
  words: WordTimestamp[];
  /** per-beat provenance for the asset meta / production page */
  sources: { beatIdx: number; source: "operator" | "tts"; durationSec: number }[];
};

const wavDurationSec = (bytes: number): number =>
  Math.max(0, bytes - WAV_HEADER_BYTES) / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);

/** Evenly spread the beat's script words across its measured duration. */
export function linearWordEstimate(
  text: string,
  durationSec: number,
  offsetSec: number,
): WordTimestamp[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || durationSec <= 0) return [];
  const pad = durationSec * 0.02;
  const usable = durationSec - pad * 2;
  const per = usable / words.length;
  return words.map((word, i) => ({
    word,
    startSec: offsetSec + pad + i * per,
    endSec: offsetSec + pad + (i + 1) * per,
  }));
}

/** Whisper word-level transcription of one normalized beat wav (best-effort). */
async function whisperWords(
  wav: Buffer,
  apiKey: string,
  offsetSec: number,
): Promise<WordTimestamp[] | null> {
  try {
    const form = new FormData();
    form.set("model", "whisper-1");
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "beat.wav");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { words?: { word: string; start: number; end: number }[] };
    if (!json.words?.length) return null;
    return json.words.map((w) => ({
      word: w.word.trim(),
      startSec: offsetSec + w.start,
      endSec: offsetSec + w.end,
    }));
  } catch {
    return null;
  }
}

export async function assembleOperatorVoiceover(input: {
  store: ObjectStore;
  voice: VoiceProvider;
  costSink: CostSink;
  env: NodeJS.ProcessEnv;
  productionId: string;
  channelId: string;
  voiceId: string;
  voiceSettings?: Parameters<VoiceProvider["synthesize"]>[0]["voiceSettings"];
  beats: BeatTakeInput[];
}): Promise<AssembledVoiceover> {
  const { store, voice, env, productionId, channelId } = input;
  const dir = await mkdtemp(path.join(tmpdir(), "vo-"));
  try {
    const pieces: { file: string; beatIdx: number; source: "operator" | "tts"; text: string; ttsWords?: WordTimestamp[] }[] = [];

    // 1) collect per-beat audio: operator take or TTS fill
    for (const beat of input.beats) {
      const raw = path.join(dir, `raw-${beat.beatIdx}`);
      if (beat.takeKey) {
        await writeFile(raw, await store.getBuffer(beat.takeKey));
        pieces.push({ file: raw, beatIdx: beat.beatIdx, source: "operator", text: beat.text });
      } else {
        const tts = await voice.synthesize({
          text: beat.text,
          voiceId: input.voiceId,
          channelId,
          productionId,
          voiceSettings: input.voiceSettings,
          storageKeyBase: `productions/${productionId}/vo-tts-${beat.beatIdx}`,
        });
        await writeFile(raw, await store.getBuffer(tts.storageKey));
        pieces.push({
          file: raw,
          beatIdx: beat.beatIdx,
          source: "tts",
          text: beat.text,
          ttsWords: tts.words,
        });
      }
    }

    // 2) normalize every piece to 44.1kHz stereo PCM wav (webm/opus/mp3/wav in)
    const normalized: { wav: string; bytes: number }[] = [];
    for (const p of pieces) {
      const out = path.join(dir, `norm-${p.beatIdx}.wav`);
      await run(
        FF,
        ["-y", "-i", p.file, "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-c:a", "pcm_s16le", out],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const bytes = (await readFile(out)).length;
      normalized.push({ wav: out, bytes });
    }

    // 3) word timestamps per beat, offset by the running start
    const words: WordTimestamp[] = [];
    const sources: AssembledVoiceover["sources"] = [];
    let offset = 0;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      const dur = wavDurationSec(normalized[i]!.bytes);
      if (p.source === "tts" && p.ttsWords?.length) {
        words.push(
          ...p.ttsWords.map((w) => ({ ...w, startSec: offset + w.startSec, endSec: offset + w.endSec })),
        );
      } else {
        const wav = await readFile(normalized[i]!.wav);
        const viaWhisper = env.OPENAI_API_KEY
          ? await whisperWords(wav, env.OPENAI_API_KEY, offset)
          : null;
        if (viaWhisper && env.OPENAI_API_KEY) {
          await input.costSink.record({
            category: "voice",
            provider: "openai-whisper",
            model: "whisper-1",
            units: { audioSec: Math.round(dur) },
            costUsd: (dur / 60) * 0.006,
            channelId,
            productionId,
          });
        }
        words.push(...(viaWhisper ?? linearWordEstimate(p.text, dur, offset)));
      }
      sources.push({ beatIdx: p.beatIdx, source: p.source, durationSec: Math.round(dur * 100) / 100 });
      offset += dur;
    }

    // 4) concat + encode one mp3
    const listFile = path.join(dir, "list.txt");
    await writeFile(
      listFile,
      normalized.map((n) => `file '${n.wav.replace(/'/g, "'\\''")}'`).join("\n"),
    );
    const finalPath = path.join(dir, "voiceover.mp3");
    await run(
      FF,
      ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c:a", "libmp3lame", "-b:a", "128k", finalPath],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const finalBuf = await readFile(finalPath);
    const storageKey = `productions/${productionId}/voiceover.mp3`;
    await store.put(storageKey, finalBuf, "audio/mpeg");

    return {
      storageKey,
      mimeType: "audio/mpeg",
      durationSec: Math.round(offset * 100) / 100,
      words,
      sources,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
