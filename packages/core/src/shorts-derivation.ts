import type { WordTimestamp } from "@ytauto/db";

/**
 * Shorts derivation — the DETERMINISTIC cut planner (spec: docs/SHORTS-DERIVATION-SPEC.md).
 *
 * A Short is a pure ffmpeg SLICE of an already-published long-form master render —
 * no re-render, no re-TTS. This module owns the "where do the cuts land" math so it
 * is testable without a DB, a render, or YouTube: given the master runtime and the
 * operator's knobs (how many Shorts, and/or their average length), produce the ordered
 * windows to slice, snapped to word boundaries so a cut never lands mid-word.
 *
 * The `even` selection mode lives here. `ai-best` (transcript + retention) and
 * `manual` modes feed the SAME `ShortWindow[]` shape downstream, so slicing/styling
 * is mode-agnostic.
 */

/** YouTube Shorts hard cap: a Short must be ≤ 180s (3 min). */
export const SHORT_MAX_SEC = 180;
/** Below this a "Short" isn't worth cutting. */
export const SHORT_MIN_SEC = 10;
/** Fallback average length when neither count nor avgLength is given. */
export const DEFAULT_SHORT_SEC = 60;

export type ShortWindow = {
  /** 0-based order in the batch */
  index: number;
  startSec: number;
  endSec: number;
  /** "Part 1", "Part 2", … — the default overlay label */
  label: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * `even` split: tile a master runtime into N ordered windows.
 *
 * Give `count` OR `avgLengthSec` (count wins if both are present); if neither,
 * fall back to DEFAULT_SHORT_SEC. Each window is bounded to [minSec, maxSec] with
 * maxSec never exceeding the 180s Shorts cap.
 *
 * Behaviour by slot size (slot = duration / n):
 *  - slot within [min, max]  → contiguous tiling (window i = [i·slot, (i+1)·slot]).
 *  - slot > max              → each window is `max` long, CENTERED in its slot, so N
 *    Shorts sample evenly across the whole video ("give me 5 Shorts from a 20-min
 *    video" → 5 spread max-length samples, since 5 contiguous 4-min pieces can't be
 *    Shorts).
 *  - slot < min              → n is reduced so every window is at least `min`
 *    (a runtime can only yield floor(duration/min) Shorts).
 *
 * Pure. Snap to real word/sentence boundaries with `snapWindowsToWords`.
 */
export function planEvenWindows(opts: {
  durationSec: number;
  count?: number;
  avgLengthSec?: number;
  maxSec?: number;
  minSec?: number;
}): ShortWindow[] {
  const duration = Number.isFinite(opts.durationSec) ? Math.max(0, opts.durationSec) : 0;
  const max = clamp(opts.maxSec ?? SHORT_MAX_SEC, 1, SHORT_MAX_SEC);
  const min = clamp(opts.minSec ?? SHORT_MIN_SEC, 1, max);
  if (duration < min) return []; // too short to yield even one Short

  // requested window count
  let n: number;
  if (typeof opts.count === "number" && opts.count > 0) {
    n = Math.floor(opts.count);
  } else if (typeof opts.avgLengthSec === "number" && opts.avgLengthSec > 0) {
    n = Math.max(1, Math.round(duration / clamp(opts.avgLengthSec, min, max)));
  } else {
    n = Math.max(1, Math.round(duration / DEFAULT_SHORT_SEC));
  }
  // never ask for more Shorts than the runtime can give at the minimum length
  n = clamp(n, 1, Math.max(1, Math.floor(duration / min)));

  const slot = duration / n;
  const winLen = clamp(slot, min, max);
  const windows: ShortWindow[] = [];
  for (let i = 0; i < n; i++) {
    const slotStart = i * slot;
    // centre the window in its slot (a no-op when winLen === slot)
    const start = clamp(slotStart + (slot - winLen) / 2, 0, Math.max(0, duration - winLen));
    const end = Math.min(duration, start + winLen);
    windows.push({ index: i, startSec: round1(start), endSec: round1(end), label: `Part ${i + 1}` });
  }
  return windows;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Snap each window's start/end to real word boundaries so a slice never begins or
 * ends mid-word (and, in practice, lands on sentence starts because word gaps line
 * up with them). Start snaps to the nearest word START; end snaps to the nearest word
 * END. Words need not be sorted. If the snap would invert or collapse a window it is
 * left unchanged. Empty `words` → windows returned as-is. Pure.
 */
export function snapWindowsToWords(windows: ShortWindow[], words: WordTimestamp[]): ShortWindow[] {
  const valid = (words ?? []).filter(
    (w) => w && Number.isFinite(w.startSec) && Number.isFinite(w.endSec) && w.endSec >= w.startSec,
  );
  if (valid.length === 0) return windows;
  const starts = valid.map((w) => w.startSec);
  const ends = valid.map((w) => w.endSec);
  const nearest = (arr: number[], target: number) =>
    arr.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), arr[0]!);

  return windows.map((win) => {
    const snappedStart = nearest(starts, win.startSec);
    const snappedEnd = nearest(ends, win.endSec);
    if (snappedEnd - snappedStart < SHORT_MIN_SEC || snappedStart >= snappedEnd) return win; // snap unusable → keep original
    return { ...win, startSec: round1(snappedStart), endSec: round1(snappedEnd) };
  });
}
