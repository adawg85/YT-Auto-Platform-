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
  /**
   * #101: which SEGMENT of the beat this piece is, when the beat was cut into
   * sentence-grouped takes. Null/absent = the piece is the whole beat (a legacy
   * per-beat take, or the TTS-chunk path). Purely provenance — each piece is
   * already assembled and force-aligned independently.
   */
  segIdx?: number | null;
};

export type AssembledVoiceover = {
  storageKey: string;
  mimeType: string;
  durationSec: number;
  words: WordTimestamp[];
  /** per-beat provenance for the asset meta / production page */
  sources: {
    beatIdx: number;
    segIdx?: number;
    source: "operator" | "tts";
    durationSec: number;
    /**
     * #101: HOW this piece's word timings were obtained.
     *  - "tts"       — the synth returned them (exact)
     *  - "whisper"   — forced alignment over the operator's audio (exact)
     *  - "estimated" — words spread evenly across the measured duration, because
     *                  Whisper was unavailable or failed. Captions and shot
     *                  boundaries DRIFT against the real delivery in this case,
     *                  so it must never be silent.
     */
    aligned: "tts" | "whisper" | "estimated";
  }[];
};

const wavDurationSec = (bytes: number): number =>
  Math.max(0, bytes - WAV_HEADER_BYTES) / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);

/**
 * #103 — the identity of ONE assembly piece.
 *
 * Temp files and TTS-fill storage keys used to be named by `beatIdx` alone.
 * That was correct while a piece WAS a beat, and went silently wrong when #101
 * cut each beat into sentence-sized segments: every segment of beat 3 wrote to
 * `raw-3` and normalized to `norm-3.wav`, so the last segment of the beat
 * overwrote its siblings and the concat list pointed at that one file once per
 * segment. Nothing threw — the run reported all 122 pieces, and the audio
 * played each beat's final segment on repeat.
 *
 * A piece's identity is its ORDINAL in the assembly, which is unique by
 * construction. beat/segment ride along only so a temp file stays readable.
 */
export function pieceSlug(index: number, beatIdx: number, segIdx?: number | null): string {
  return `${index}-b${beatIdx}${segIdx == null ? "" : `s${segIdx}`}`;
}

/** The per-piece file/key plan. Exported so the 1:1 invariant is unit-testable. */
export function planPieceSlugs(beats: BeatTakeInput[]): string[] {
  return beats.map((b, i) => pieceSlug(i, b.beatIdx, b.segIdx));
}

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

/**
 * BACKLOG #18/#36 long-form: split a long script into TTS-sized chunks on
 * sentence boundaries (a single call over the whole script 400s past the
 * provider's char cap). Greedy pack ≤ `limit`; a lone over-length sentence is
 * hard-split on words. Pure + unit-testable; chunks are contiguous slices so the
 * concatenated word timestamps stay a correct continuous stream.
 */
export function chunkText(text: string, limit: number): string[] {
  const clean = text.trim();
  if (clean.length <= limit) return clean ? [clean] : [];
  const sentences = clean.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [clean];
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (const s of sentences) {
    if (cur && cur.length + s.length > limit) flush();
    if (s.length > limit) {
      flush();
      let w = "";
      for (const word of s.split(/\s+/)) {
        if (w && w.length + word.length + 1 > limit) {
          chunks.push(w.trim());
          w = "";
        }
        w += (w ? " " : "") + word;
      }
      cur = w;
    } else {
      cur += s;
    }
  }
  flush();
  return chunks.filter(Boolean);
}

/**
 * FORCED ALIGNMENT — carry the SCRIPT's words onto Whisper's timings.
 *
 * Whisper returns what it HEARD. Pushing that straight into the voiceover's word
 * list replaced the operator's writing with an ASR guess, and those words are
 * what the render burns as captions and what each shot reports as its narration.
 * On a real read that meant one surname transcribed four ways (Fuscone /
 * Foscone / Fuscoen / Fusco), "Housel's account" as "households account" and
 * "Tails drive everything" as "Tales drive everything" — the operator did not
 * recognise their own script in the visuals grid, and the captions would have
 * shipped those errors.
 *
 * The audio IS the script being read, so the two token streams differ only by
 * ASR error. Align them monotonically, then emit the SCRIPT tokens with the
 * matched ASR timings — alignment, which is what this was always documented to
 * do. Words the ASR dropped are spread across the gap they sit in, so timings
 * stay monotonic and bounded by the piece.
 *
 * Pure and exported: this is the one part of the voiceover path a sandbox can
 * verify without audio.
 */
const normToken = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]/g, "");

/** Cheap similarity so an ASR near-miss aligns to its script word rather than
 *  being treated as an unrelated token. */
function tokenScore(a: string, b: string): number {
  if (!a || !b) return -1;
  if (a === b) return 2;
  // same opening and close in length — the shape of a mis-heard proper noun
  if (a[0] === b[0] && Math.abs(a.length - b.length) <= 2) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 1;
  return -1;
}

const GAP = -1;

export function alignScriptToAsr(
  scriptText: string,
  asr: WordTimestamp[],
  bounds: { offsetSec: number; durationSec: number },
): WordTimestamp[] {
  const script = scriptText.split(/\s+/).filter(Boolean);
  if (script.length === 0) return [];
  if (asr.length === 0) return linearWordEstimate(scriptText, bounds.durationSec, bounds.offsetSec);

  const S = script.map(normToken);
  const A = asr.map((w) => normToken(w.word));
  const n = S.length;
  const m = A.length;

  // Needleman-Wunsch. n,m are a segment's worth of words (~25); the whole-script
  // path is larger but still a one-off O(n·m) pass over Int32/Uint8 buffers.
  const prev = new Int32Array(m + 1);
  const cur = new Int32Array(m + 1);
  // traceback: 0 = diagonal (pair), 1 = up (script word unmatched), 2 = left (asr word dropped)
  const back = new Uint8Array((n + 1) * (m + 1));
  for (let j = 1; j <= m; j++) {
    prev[j] = j * GAP;
    back[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i * GAP;
    back[i * (m + 1)] = 1;
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1]! + tokenScore(S[i - 1]!, A[j - 1]!);
      const up = prev[j]! + GAP;
      const left = cur[j - 1]! + GAP;
      let best = diag;
      let dir = 0;
      if (up > best) {
        best = up;
        dir = 1;
      }
      if (left > best) {
        best = left;
        dir = 2;
      }
      cur[j] = best;
      back[i * (m + 1) + j] = dir;
    }
    prev.set(cur);
  }

  // walk back: for each SCRIPT index, the ASR index it paired with (or -1)
  const pairedAsr = new Int32Array(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const dir = back[i * (m + 1) + j]!;
    if (dir === 0) {
      pairedAsr[i - 1] = j - 1;
      i--;
      j--;
    } else if (dir === 1) i--;
    else j--;
  }

  const lo = bounds.offsetSec;
  const hi = bounds.offsetSec + Math.max(bounds.durationSec, 0);
  const out: WordTimestamp[] = script.map((word, k) => {
    const a = pairedAsr[k]!;
    return a >= 0
      ? { word, startSec: asr[a]!.startSec, endSec: asr[a]!.endSec }
      : { word, startSec: NaN, endSec: NaN };
  });

  // fill unmatched runs by spreading them across the gap they sit in, so the
  // stream stays monotonic and inside the piece
  let k = 0;
  while (k < out.length) {
    if (!Number.isNaN(out[k]!.startSec)) {
      k++;
      continue;
    }
    let end = k;
    while (end < out.length && Number.isNaN(out[end]!.startSec)) end++;
    const from = k > 0 ? out[k - 1]!.endSec : lo;
    const to = end < out.length ? out[end]!.startSec : hi;
    const span = Math.max(0, to - from);
    const per = span / (end - k);
    for (let x = k; x < end; x++) {
      out[x] = { word: out[x]!.word, startSec: from + (x - k) * per, endSec: from + (x - k + 1) * per };
    }
    k = end;
  }
  return out;
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
  /** ElevenLabs TTS model (Production Profile voiceModel) for the per-beat fill. */
  model?: string;
  beats: BeatTakeInput[];
}): Promise<AssembledVoiceover> {
  const { store, voice, env, productionId, channelId } = input;
  // #103: one file per PIECE, never per beat. Verified up front so a future
  // change that reintroduces a collision fails loudly here instead of shipping
  // an assembly that repeats one take — the failure mode that made the whole
  // operator-narration path unusable while every count still read correct.
  const slugs = planPieceSlugs(input.beats);
  if (new Set(slugs).size !== slugs.length) {
    throw new Error(
      `[voiceover] assembly plan is not 1:1 — ${slugs.length} pieces map to only ${new Set(slugs).size} distinct files. ` +
        `Refusing to assemble: pieces sharing a file overwrite each other and the output repeats one take (#103).`,
    );
  }
  const dir = await mkdtemp(path.join(tmpdir(), "vo-"));
  try {
    const pieces: { file: string; slug: string; beatIdx: number; segIdx?: number | null; source: "operator" | "tts"; text: string; ttsWords?: WordTimestamp[] }[] = [];

    // 1) collect per-piece audio: operator take or TTS fill
    for (const [i, beat] of input.beats.entries()) {
      const slug = slugs[i]!;
      const raw = path.join(dir, `raw-${slug}`);
      if (beat.takeKey) {
        await writeFile(raw, await store.getBuffer(beat.takeKey));
        pieces.push({ file: raw, slug, beatIdx: beat.beatIdx, segIdx: beat.segIdx ?? null, source: "operator", text: beat.text });
      } else {
        const tts = await voice.synthesize({
          text: beat.text,
          voiceId: input.voiceId,
          channelId,
          productionId,
          voiceSettings: input.voiceSettings,
          model: input.model,
          // per-PIECE key: segments of one beat used to share `vo-tts-<beat>`
          // and overwrite each other in the store as well as on disk (#103)
          storageKeyBase: `productions/${productionId}/vo-tts-${slug}`,
        });
        await writeFile(raw, await store.getBuffer(tts.storageKey));
        pieces.push({
          file: raw,
          slug,
          beatIdx: beat.beatIdx,
          segIdx: beat.segIdx ?? null,
          source: "tts",
          text: beat.text,
          ttsWords: tts.words,
        });
      }
    }

    // 2) normalize every piece to 44.1kHz stereo PCM wav (webm/opus/mp3/wav in)
    const normalized: { wav: string; bytes: number }[] = [];
    for (const p of pieces) {
      const out = path.join(dir, `norm-${p.slug}.wav`);
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
      let aligned: "tts" | "whisper" | "estimated";
      if (p.source === "tts" && p.ttsWords?.length) {
        words.push(
          ...p.ttsWords.map((w) => ({ ...w, startSec: offset + w.startSec, endSec: offset + w.endSec })),
        );
        aligned = "tts";
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
        aligned = viaWhisper ? "whisper" : "estimated";
        if (!viaWhisper) {
          // #101: a silent degrade here means the operator records a whole
          // episode and only discovers drifting captions by watching it. Say so.
          console.warn(
            `[voiceover] ⚠ beat ${p.beatIdx}${p.segIdx != null ? ` seg ${p.segIdx}` : ""}: word timings ESTIMATED, not aligned — ` +
              (env.OPENAI_API_KEY
                ? "Whisper returned no alignment (rate limit / transient error?)."
                : "OPENAI_API_KEY is not set on this worker.") +
              " Captions and shot boundaries will drift against the real delivery.",
          );
        }
        // ALIGN, don't transcribe: Whisper supplies the timings, the SCRIPT
        // supplies the words. Pushing viaWhisper directly put ASR errors into
        // the render's captions and into every shot's reported narration.
        words.push(
          ...(viaWhisper
            ? alignScriptToAsr(p.text, viaWhisper, { offsetSec: offset, durationSec: dur })
            : linearWordEstimate(p.text, dur, offset)),
        );
      }
      sources.push({
        beatIdx: p.beatIdx,
        ...(p.segIdx != null ? { segIdx: p.segIdx } : {}),
        source: p.source,
        durationSec: Math.round(dur * 100) / 100,
        aligned,
      });
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
