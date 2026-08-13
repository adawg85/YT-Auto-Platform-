import { and, eq } from "drizzle-orm";
import { assets, productions, scriptDrafts, type Db } from "@ytauto/db";
import { WORDS_PER_SEC } from "./beat-map";

/**
 * #120 — the measured operator read rate.
 *
 * `review_beat_map`'s word budget converted targetLengthSec to words at a fixed
 * 2.5 w/s, while the operator's REAL rate was already measured and stored:
 * every assembled operator narration carries `durationSec` (Whisper
 * force-aligned) against the approved script's word count. Pooled across the
 * ticket's three clean samples the operator reads at 2.89 w/s — the gate
 * under-read them by 16%, so it BLOCKED maps that would have hit the target
 * and mandated ones ~14% short.
 *
 * The rate is learned per channel from clean samples (every assembled piece
 * operator-recorded AND Whisper-aligned — a TTS fill or estimated alignment
 * pollutes the measurement), with a minimum sample size before it replaces the
 * default. Beat-dense maps read slower (each segment boundary contributes a
 * gap to the assembled duration — the ticket's 2.74 vs 3.04 spread), so the
 * fit models `duration = words/rate + gap×segments` when the samples support
 * it, and degrades to the pooled rate when they don't.
 */

export type ReadRateSample = {
  words: number;
  durationSec: number;
  /** assembled piece count — each boundary contributes a gap */
  segments: number;
};

/** Below this many clean samples the platform default stands (evidence gating,
 * same posture as suggestedLengthBasis.sufficientEvidence). */
export const READ_RATE_MIN_SAMPLES = 3;

export type ReadRateBasis =
  /** fitted from THIS channel's assembled operator narrations */
  | "operator_measured"
  /** fitted from other channels' operator narrations — the cold-start
   * inheritance (#120 request 4). Assumes one narrator per platform instance,
   * which is true today and stated here so it's revisited if that changes. */
  | "operator_platform"
  /** the 2.5 w/s platform constant — no sufficient measurement exists */
  | "default";

export type ResolvedReadRate = {
  wordsPerSec: number;
  /** per-segment silence allowance (sec); 0 when the fit is pooled-only */
  segmentGapSec: number;
  basis: ReadRateBasis;
  sampleProductions: number;
};

export const DEFAULT_READ_RATE: ResolvedReadRate = {
  wordsPerSec: WORDS_PER_SEC,
  segmentGapSec: 0,
  basis: "default",
  sampleProductions: 0,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Plausibility guards: human narration sits between these; a fit outside them
 * is a degenerate solve (tiny sample, collinear rows), not a measurement. The
 * gap cap is deliberately tight — assembly concatenates takes with sub-second
 * silences, so a "gap" beyond ~1s is the solver absorbing slower delivery into
 * the wrong parameter (the ticket's own 3 samples decompose into 4.14 w/s +
 * 1.9s/segment, which reproduces them exactly but would overshoot any sparse
 * map) — in that case the pooled rate is the honest model. */
const MIN_WPS = 1;
const MAX_WPS = 6;
const MAX_SEGMENT_GAP_SEC = 1;

/**
 * Fit `durationSec ≈ words/wordsPerSec + segmentGapSec × segments` by least
 * squares. Falls back to the pooled rate (Σwords/Σduration, gap 0) when the
 * two-parameter solve is degenerate or lands outside plausible human ranges.
 * Returns null when no usable sample exists.
 */
export function fitReadRate(
  samples: ReadRateSample[],
): { wordsPerSec: number; segmentGapSec: number } | null {
  const clean = samples.filter((s) => s.words > 0 && s.durationSec > 0 && s.segments > 0);
  if (clean.length === 0) return null;
  const totalWords = clean.reduce((a, s) => a + s.words, 0);
  const totalSec = clean.reduce((a, s) => a + s.durationSec, 0);
  const pooled = { wordsPerSec: round2(totalWords / totalSec), segmentGapSec: 0 };
  if (pooled.wordsPerSec < MIN_WPS || pooled.wordsPerSec > MAX_WPS) return null;
  if (clean.length < 2) return pooled;
  // normal equations for d = a·w + b·s  (a = sec/word, b = gap sec/segment)
  let sww = 0;
  let sws = 0;
  let sss = 0;
  let swd = 0;
  let ssd = 0;
  for (const s of clean) {
    sww += s.words * s.words;
    sws += s.words * s.segments;
    sss += s.segments * s.segments;
    swd += s.words * s.durationSec;
    ssd += s.segments * s.durationSec;
  }
  const det = sww * sss - sws * sws;
  if (det <= 1e-9) return pooled;
  const a = (swd * sss - ssd * sws) / det;
  const b = (ssd * sww - swd * sws) / det;
  const wps = a > 0 ? 1 / a : NaN;
  if (!Number.isFinite(wps) || wps < MIN_WPS || wps > MAX_WPS || b < 0 || b > MAX_SEGMENT_GAP_SEC) {
    return pooled;
  }
  return { wordsPerSec: round2(wps), segmentGapSec: round2(b) };
}

/**
 * Evidence-gated resolution: the channel's own samples win, a platform-wide
 * pool covers the cold start (same narrator — stated assumption), and the 2.5
 * default stands below the sample floor. Pure, so the gating is testable.
 */
export function resolveReadRate(
  channelSamples: ReadRateSample[],
  platformSamples: ReadRateSample[] = [],
): ResolvedReadRate {
  if (channelSamples.length >= READ_RATE_MIN_SAMPLES) {
    const fit = fitReadRate(channelSamples);
    if (fit) return { ...fit, basis: "operator_measured", sampleProductions: channelSamples.length };
  }
  if (platformSamples.length >= READ_RATE_MIN_SAMPLES) {
    const fit = fitReadRate(platformSamples);
    if (fit) return { ...fit, basis: "operator_platform", sampleProductions: platformSamples.length };
  }
  return DEFAULT_READ_RATE;
}

type AssembledSourcePiece = { source?: string; aligned?: string };

/**
 * Collect CLEAN read-rate samples from assembled voiceovers: `meta.source`
 * "operator" and every piece operator-recorded AND Whisper-aligned (a TTS fill
 * speaks at the synth's rate and an "estimated" piece has no real timings —
 * either pollutes the measurement; this is the ticket's `alignment.estimated:
 * 0` condition, tightened to exclude TTS fills too). Words come from the
 * production's newest script draft; segments are the assembled piece count.
 */
export async function collectReadRateSamples(
  db: Db,
  channelId?: string,
): Promise<ReadRateSample[]> {
  const rows = await db
    .select({
      productionId: assets.productionId,
      durationSec: assets.durationSec,
      meta: assets.meta,
      channelId: productions.channelId,
    })
    .from(assets)
    .innerJoin(productions, eq(assets.productionId, productions.id))
    .where(
      channelId
        ? and(eq(assets.kind, "voiceover"), eq(assets.idx, 0), eq(productions.channelId, channelId))
        : and(eq(assets.kind, "voiceover"), eq(assets.idx, 0)),
    );
  const out: ReadRateSample[] = [];
  for (const row of rows) {
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    if (meta.source !== "operator") continue;
    const sources = meta.sources as AssembledSourcePiece[] | undefined;
    if (!Array.isArray(sources) || sources.length === 0) continue;
    if (!sources.every((s) => s.source === "operator" && s.aligned === "whisper")) continue;
    if (!row.durationSec || row.durationSec <= 0) continue;
    const drafts = await db
      .select({ wordCount: scriptDrafts.wordCount, version: scriptDrafts.version })
      .from(scriptDrafts)
      .where(eq(scriptDrafts.productionId, row.productionId!));
    const newest = drafts.sort((a, b) => b.version - a.version)[0];
    if (!newest?.wordCount || newest.wordCount <= 0) continue;
    out.push({ words: newest.wordCount, durationSec: row.durationSec, segments: sources.length });
  }
  return out;
}

/**
 * The channel's resolved read rate: own samples → platform pool → 2.5 default.
 * One call per review/config read; the sample sets are a handful of rows.
 */
export async function channelReadRate(db: Db, channelId: string): Promise<ResolvedReadRate> {
  const own = await collectReadRateSamples(db, channelId);
  if (own.length >= READ_RATE_MIN_SAMPLES) return resolveReadRate(own);
  const platform = await collectReadRateSamples(db);
  return resolveReadRate(own, platform);
}
