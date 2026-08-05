/**
 * #101 — narration SEGMENTS: the unit the operator actually records.
 *
 * The recording booth used to offer one card per BEAT. Beats are authored
 * paragraphs — always sentence-complete, so they never asked for half a
 * sentence, but on a long-form script they run 50-110 words (20-45 seconds).
 * That is a long take to land cleanly, and a stumble at word 90 means reading
 * the whole paragraph again.
 *
 * Segments cut each beat into shorter takes, breaking ONLY at sentence
 * boundaries. A flub then costs one sentence-ish chunk, not a paragraph.
 *
 * The rules, in order:
 *  - never split mid-sentence — a single sentence longer than the target is its
 *    own segment rather than being cut (the operator reads it in one breath or
 *    not at all; a mid-sentence seam is audible and unfixable);
 *  - group consecutive short sentences up to `targetWords`, so "It didn't."
 *    doesn't become its own card;
 *  - preserve the text EXACTLY — concatenating the segments with a single space
 *    reproduces the beat, so alignment and captions can't drift from the script.
 */

/** Default target length for one take: ~25 words ≈ 10s at the platform's rate. */
export const SEGMENT_TARGET_WORDS = 25;

/**
 * Split narration into sentence-grouped segments.
 *
 * Sentence detection is deliberately simple (terminal punctuation + following
 * space) and guards the common abbreviations that would otherwise cause a false
 * break mid-sentence — the one failure this must not have.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "vs", "etc", "eg", "ie",
  "approx", "no", "vol", "fig", "al", "ca", "c", "ad", "bc", "ce", "bce",
]);

function splitSentences(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const out: string[] = [];
  let cur = "";
  // walk tokens so an abbreviation's full stop can be rejected as a boundary
  const tokens = clean.split(/(\s+)/);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    cur += tok;
    if (!/[.!?]["')\]]*$/.test(tok)) continue;
    const bare = tok.replace(/[^A-Za-z.]/g, "").replace(/\.$/, "").toLowerCase();
    // "Dr." / "vs." / "No." — not a sentence end
    if (ABBREVIATIONS.has(bare)) continue;
    // a lone initial ("J." in "J. R. R.") — not a sentence end
    if (/^[A-Za-z]\.$/.test(tok)) continue;
    // a decimal or version ("3.5") — not a sentence end
    if (/\d\.$/.test(tok) && i + 2 < tokens.length && /^\d/.test(tokens[i + 2] ?? "")) continue;
    out.push(cur.trim());
    cur = "";
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/**
 * Group a beat's sentences into take-sized segments.
 *
 * `targetWords` is a soft ceiling: a group stops growing once adding the next
 * sentence would exceed it, but a single over-long sentence is never cut.
 */
export function splitNarrationSegments(
  text: string,
  targetWords: number = SEGMENT_TARGET_WORDS,
): string[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  const target = Math.max(1, targetWords);
  const segments: string[] = [];
  let cur: string[] = [];
  let curWords = 0;
  for (const s of sentences) {
    const w = wordCount(s);
    // start a new segment when this sentence would push us past the target —
    // unless nothing is buffered yet, in which case the sentence stands alone
    if (cur.length > 0 && curWords + w > target) {
      segments.push(cur.join(" "));
      cur = [];
      curWords = 0;
    }
    cur.push(s);
    curWords += w;
  }
  if (cur.length > 0) segments.push(cur.join(" "));
  return segments;
}

/**
 * Take-asset index encoding.
 *
 * `voiceover_take` rows are unique on (productionId, kind, idx), and idx used to
 * be the BEAT index. Segment takes need two coordinates, so they are encoded
 * into that one integer — offset well clear of the legacy range so an existing
 * per-beat take can never collide with a segment take and be overwritten.
 */
export const SEGMENT_TAKE_BASE = 100_000;
const SEGMENTS_PER_BEAT = 1_000;

export function segmentTakeIdx(beatIdx: number, segIdx: number): number {
  return SEGMENT_TAKE_BASE + beatIdx * SEGMENTS_PER_BEAT + segIdx;
}

/**
 * Decode a take's idx. `segIdx: null` means a LEGACY whole-beat take recorded
 * before segments shipped — those still play, and still count as that beat's
 * narration.
 */
export function decodeTakeIdx(idx: number): { beatIdx: number; segIdx: number | null } {
  if (idx < SEGMENT_TAKE_BASE) return { beatIdx: idx, segIdx: null };
  const rel = idx - SEGMENT_TAKE_BASE;
  return { beatIdx: Math.floor(rel / SEGMENTS_PER_BEAT), segIdx: rel % SEGMENTS_PER_BEAT };
}

export type NarrationSegment = {
  beatIdx: number;
  segIdx: number;
  text: string;
  /** the encoded asset idx a take for this segment is stored under */
  takeIdx: number;
};

/** Flatten a script's beats into the ordered list of recordable segments. */
export function narrationSegments(
  beats: { text: string }[],
  targetWords: number = SEGMENT_TARGET_WORDS,
): NarrationSegment[] {
  const out: NarrationSegment[] = [];
  beats.forEach((b, beatIdx) => {
    splitNarrationSegments(b.text ?? "", targetWords).forEach((text, segIdx) => {
      out.push({ beatIdx, segIdx, text, takeIdx: segmentTakeIdx(beatIdx, segIdx) });
    });
  });
  return out;
}

/**
 * #101: the reserved take index for ONE FILE COVERING THE WHOLE SCRIPT.
 *
 * The segment recorder suits reading in the browser, but a narrator working in a
 * DAW records the episode in one pass and exports a single file. That file is
 * stored under this index and, when present, becomes the ENTIRE narration — the
 * pipeline aligns it against the full script with Whisper, so shot boundaries
 * and captions still come from real word timings.
 *
 * Sits in the GAP between the legacy per-beat range (small beat indices) and the
 * segment range (SEGMENT_TAKE_BASE and up), so it can never collide with either.
 */
export const FULL_NARRATION_TAKE_IDX = 50_000;

export function isFullNarrationTake(idx: number): boolean {
  return idx === FULL_NARRATION_TAKE_IDX;
}
