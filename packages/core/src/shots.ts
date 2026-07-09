import type { WordTimestamp } from "@ytauto/db";
import type { BeatType } from "./beats";

/**
 * Shots (BACKLOG #18 #4 — the "boring stills" fix). A single static image held
 * for a whole spoken beat reads as boring, so each beat is sub-divided into
 * SHOTS cut on the spoken rhythm (sentence boundaries or audio pauses derived
 * from the voiceover word timestamps). Each shot gets its own image, so the
 * frame keeps moving. The render is unchanged — it already draws one image per
 * timed segment; we just hand it more, shorter segments.
 *
 * `rhythm` (Production Profile axis) picks the granularity:
 *  - `section`  → one shot per beat (today's behaviour; cheapest)
 *  - `sentence` → cut on sentence boundaries (default)
 *  - `pause`    → cut where the narration pauses (word-gap > PAUSE_GAP)
 */

export type ShotRhythm = "sentence" | "section" | "pause";

export type BeatInput = {
  type: BeatType;
  text: string;
  imagePrompt: string;
  referenceEntity?: string | null;
};

export type Shot = {
  /** index of the parent beat (for debugging / provenance) */
  beatIndex: number;
  type: BeatType;
  /** the spoken text this shot covers */
  text: string;
  /** image-generation prompt for this shot's visual */
  imagePrompt: string;
  /** real subject to source a licensed photo for, or null to generate */
  referenceEntity: string | null;
  startSec: number;
  endSec: number;
};

/** A shot must run at least this long — avoids frantic sub-second cutting. */
export const MIN_SHOT_SEC = 2;
/** Never split one beat into more than this many shots (cost + pacing guard). */
export const MAX_SHOTS_PER_BEAT = 4;
/** A gap between words longer than this reads as a deliberate pause (seconds). */
export const PAUSE_GAP = 0.35;

const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;
const SENTENCE_SPLIT = /[^.!?]+[.!?]*/g;

/** Word indices AFTER which a cut is allowed, per the chosen rhythm. */
function cutBoundaries(text: string, words: WordTimestamp[], rhythm: ShotRhythm): Set<number> {
  const boundaries = new Set<number>();
  if (words.length <= 1) return boundaries;
  if (rhythm === "section") return boundaries;
  if (rhythm === "pause") {
    for (let i = 1; i < words.length; i++) {
      if (words[i]!.startSec - words[i - 1]!.endSec > PAUSE_GAP) boundaries.add(i - 1);
    }
    return boundaries;
  }
  // sentence: a boundary after the last word of each sentence (but not the last)
  const sentences = (text.match(SENTENCE_SPLIT) ?? []).map((s) => s.trim()).filter(Boolean);
  let idx = -1;
  for (let s = 0; s < sentences.length - 1; s++) {
    idx += Math.max(1, wordCount(sentences[s]!));
    if (idx >= 0 && idx < words.length - 1) boundaries.add(idx);
  }
  return boundaries;
}

/** Greedily group a beat's words into shots, honouring boundaries + min length. */
function groupWords(
  words: WordTimestamp[],
  boundaries: Set<number>,
  maxShots: number,
): WordTimestamp[][] {
  if (words.length === 0) return [[]];
  const groups: WordTimestamp[][] = [];
  let cur: WordTimestamp[] = [];
  let curStart = words[0]!.startSec;
  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]!);
    const longEnough = words[i]!.endSec - curStart >= MIN_SHOT_SEC;
    const roomForMore = groups.length < maxShots - 1;
    if (boundaries.has(i) && longEnough && roomForMore && i < words.length - 1) {
      groups.push(cur);
      cur = [];
      curStart = words[i + 1]!.startSec;
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Plan the shot list for a script. Deterministic — the same beats + word
 * timestamps always yield the same shots (so retries/resumes are stable).
 */
export function planShots(
  beats: BeatInput[],
  words: WordTimestamp[],
  opts: { rhythm: ShotRhythm; durationSec: number; maxShotsPerBeat?: number },
): Shot[] {
  const maxShots = Math.max(1, opts.maxShotsPerBeat ?? MAX_SHOTS_PER_BEAT);
  const shots: Shot[] = [];
  let cursor = 0;
  let prevBeatEnd = 0;
  for (let bi = 0; bi < beats.length; bi++) {
    const beat = beats[bi]!;
    const wc = wordCount(beat.text);
    const beatWords = words.slice(cursor, cursor + wc);
    cursor += wc;
    const isLastBeat = bi === beats.length - 1;
    const beatStart = prevBeatEnd;
    const beatEnd = isLastBeat
      ? opts.durationSec
      : beatWords.length
        ? beatWords[beatWords.length - 1]!.endSec + 0.05
        : beatStart + 1;
    prevBeatEnd = beatEnd;

    const boundaries = cutBoundaries(beat.text, beatWords, opts.rhythm);
    const groups = groupWords(beatWords, boundaries, maxShots);

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]!;
      const groupText = g.map((w) => w.word).join(" ").trim() || beat.text;
      shots.push({
        beatIndex: bi,
        type: beat.type,
        text: groupText,
        // shot 0 keeps the beat's authored prompt (+ its reference photo); later
        // shots append their sentence so the generator returns a distinct image.
        imagePrompt: gi === 0 ? beat.imagePrompt : `${beat.imagePrompt} — ${groupText}`,
        referenceEntity: gi === 0 ? beat.referenceEntity ?? null : null,
        startSec: beatStart, // fixed up to be contiguous below
        endSec: Math.min(g.length ? g[g.length - 1]!.endSec + 0.05 : beatEnd, beatEnd),
      });
    }
    // the last shot of the beat always runs to the beat's end
    if (shots.length) shots[shots.length - 1]!.endSec = beatEnd;
  }

  // final pass: make shots tile the timeline with no gaps/overlaps
  for (let i = 0; i < shots.length; i++) {
    shots[i]!.startSec = i === 0 ? 0 : shots[i - 1]!.endSec;
    if (shots[i]!.endSec < shots[i]!.startSec) shots[i]!.endSec = shots[i]!.startSec;
    shots[i]!.endSec = Math.min(shots[i]!.endSec, opts.durationSec);
  }
  return shots;
}
