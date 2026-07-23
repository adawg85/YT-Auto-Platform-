/**
 * Beat-map structural reviewer (ticket 01KY1Y9E…): a structural check that runs
 * on a BEAT MAP before full narration is written and before generation spend.
 *
 * This module is the DETERMINISTIC core — the checks that don't need an LLM and
 * that hold BLOCK authority (word budget, cross-video structural repetition) or
 * are cheap advisories (payoff position, flat runs, date-arithmetic phrases). An
 * LLM advisory layer (craft judgement, cross-model) sits on top of this in the
 * agent; the block-authority checks live here so they're pure and testable and
 * can't be rationalised away by the thing being reviewed.
 */

import type { ProductionProfile } from "@ytauto/db";
import { shotPlanOptions } from "./shots";

export type BeatMapBeatType = "hook" | "stat" | "insight" | "cta" | "rehook" | string;

export type BeatMapBeat = {
  type: BeatMapBeatType;
  /** one-line summary of the beat (not full narration) */
  summary: string;
  /** approximate word budget (or derive from timing) */
  wordBudget?: number;
  /** approximate timing in seconds from start */
  timingSec?: number;
  heroShot?: boolean;
  animates?: boolean;
  /** named real subject to source footage for (if any) */
  referenceEntity?: string;
};

export type BeatMap = {
  title: string;
  hookLine: string;
  targetLengthSec: number;
  beats: BeatMapBeat[];
};

export type BeatMapFinding = {
  rule: string;
  evidence: string;
};

/** Platform narration rate (≈2.5 words/sec), used to size word budgets. */
export const WORDS_PER_SEC = 2.5;
/** Acceptable band around the target word count before it's a blocking finding. */
export const WORD_BUDGET_BAND = 0.2;
/** Structural-similarity above this vs a recent map blocks (compliance). */
export const SIMILARITY_BLOCK_THRESHOLD = 0.85;

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Total word budget of a map — explicit budgets, else derived from timing, else summary length. */
export function beatMapWordCount(map: BeatMap): number {
  return map.beats.reduce((sum, b) => {
    if (typeof b.wordBudget === "number") return sum + b.wordBudget;
    if (typeof b.timingSec === "number") return sum; // timing alone doesn't give per-beat words
    return sum + words(b.summary);
  }, 0);
}

/**
 * Structural fingerprint: the beat-type sequence with hero markers. Ignores all
 * surface text — two maps on different topics with the same shape fingerprint
 * identically. Used for oscillation detection and the cross-video variation check.
 */
export function beatMapFingerprint(map: BeatMap): string {
  return map.beats.map((b) => `${String(b.type).slice(0, 2)}${b.heroShot ? "*" : ""}`).join(">");
}

/** Type-transition bigrams of a map (for structural similarity). */
function typeBigrams(map: BeatMap): string[] {
  const types = map.beats.map((b) => String(b.type));
  const grams: string[] = [];
  for (let i = 0; i + 1 < types.length; i++) grams.push(`${types[i]}>${types[i + 1]}`);
  return grams;
}

/**
 * Structural similarity 0-1 between two beat maps: Jaccard over type-transition
 * bigrams, blended with a length-ratio penalty so same-shape-same-length maps
 * score highest. Topic-independent by construction.
 */
export function structuralSimilarity(a: BeatMap, b: BeatMap): number {
  const ga = new Set(typeBigrams(a));
  const gb = new Set(typeBigrams(b));
  if (ga.size === 0 && gb.size === 0) return a.beats.length === b.beats.length ? 1 : 0;
  const inter = [...ga].filter((g) => gb.has(g)).length;
  const union = new Set([...ga, ...gb]).size;
  const jaccard = union === 0 ? 0 : inter / union;
  const lenRatio = Math.min(a.beats.length, b.beats.length) / Math.max(a.beats.length, b.beats.length || 1);
  return Math.round((0.75 * jaccard + 0.25 * lenRatio) * 100) / 100;
}

/**
 * The beat the detector reads as the payoff (the LAST insight/stat/hero), with
 * its index and position%. Ticket 01KY29ZW…: a bare percentage isn't actionable —
 * the author can't tell whether the detector disagrees about WHERE the payoff is
 * or is miscounting, so name the beat.
 */
export function payoffBeat(map: BeatMap): { index: number; pct: number } | null {
  if (map.beats.length <= 1) return null;
  let idx = -1;
  for (let i = 0; i < map.beats.length; i++) {
    const b = map.beats[i]!;
    if (b.heroShot || b.type === "insight" || b.type === "stat") idx = i;
  }
  if (idx < 0) return null;
  return { index: idx, pct: Math.round((idx / (map.beats.length - 1)) * 100) };
}

/** Payoff position as a percentage (back-compat wrapper over payoffBeat). */
export function payoffPositionPct(map: BeatMap): number | null {
  return payoffBeat(map)?.pct ?? null;
}

/**
 * The longest run of consecutive beats with no hook/rehook — the flat-exposition
 * risk — with the start/end beat indices so the author can fix it without
 * recounting (ticket 01KY29ZW…).
 */
export function flatRunSpan(map: BeatMap): { start: number; end: number; length: number } {
  let longest = 0;
  let run = 0;
  let runStart = 0;
  let bestStart = 0;
  let bestEnd = -1;
  for (let i = 0; i < map.beats.length; i++) {
    const b = map.beats[i]!;
    if (b.type === "hook" || b.type === "rehook") {
      run = 0;
      runStart = i + 1;
    } else {
      run += 1;
      if (run > longest) {
        longest = run;
        bestStart = runStart;
        bestEnd = i;
      }
    }
  }
  return { start: bestStart, end: bestEnd, length: longest };
}

/** Longest flat run as a count (back-compat wrapper over flatRunSpan). */
export function longestFlatRun(map: BeatMap): number {
  return flatRunSpan(map).length;
}

/**
 * The most-repeated referenceEntity and how many beats use it. Repeating one
 * generic subject across many beats sources the same photo pool repeatedly —
 * the visual-duplication smell (ticket 01KY1ZNP…), cheapest to catch here at
 * authoring time before any generation spend.
 */
export function dominantEntity(map: BeatMap): { entity: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const b of map.beats) {
    const e = b.referenceEntity?.trim();
    if (e) counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  let top: { entity: string; count: number } | null = null;
  for (const [entity, count] of counts) if (!top || count > top.count) top = { entity, count };
  return top;
}

/** Explicit "<n> years since/after <year>" claims — surfaced for fact-check. */
export function dateArithmeticClaims(map: BeatMap): string[] {
  const re = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|[a-z]+-[a-z]+)\s+years?\s+(since|after|before|ago)\b/gi;
  const out: string[] = [];
  for (const b of map.beats) {
    for (const m of b.summary.matchAll(re)) out.push(m[0]);
  }
  return out;
}

/**
 * Run the deterministic review. BLOCK on the checks that must not be
 * overridable (word budget, cross-video repetition); ADVISE on the craft ones.
 */
export function reviewBeatMapDeterministic(
  map: BeatMap,
  opts: {
    recentMaps?: BeatMap[];
    /** target payoff position as a fraction (from the channel's notes), default 0.6 */
    payoffTargetPct?: number;
    similarityThreshold?: number;
  } = {},
): { blockingFindings: BeatMapFinding[]; advisoryFindings: BeatMapFinding[] } {
  const blocking: BeatMapFinding[] = [];
  const advisory: BeatMapFinding[] = [];

  // BLOCK — word budget outside the acceptable band around target.
  const target = Math.round(map.targetLengthSec * WORDS_PER_SEC);
  const actual = beatMapWordCount(map);
  if (target > 0 && actual > 0) {
    const low = Math.round(target * (1 - WORD_BUDGET_BAND));
    const high = Math.round(target * (1 + WORD_BUDGET_BAND));
    if (actual < low || actual > high) {
      blocking.push({
        rule: "word_budget",
        evidence: `Beat-map budget ${actual} words vs target ${target} (band ${low}-${high} for ${map.targetLengthSec}s).`,
      });
    }
  }

  // BLOCK — structural repetition vs the channel's recent maps (compliance).
  const threshold = opts.similarityThreshold ?? SIMILARITY_BLOCK_THRESHOLD;
  let worst = 0;
  for (const prev of opts.recentMaps ?? []) {
    const sim = structuralSimilarity(map, prev);
    if (sim > worst) worst = sim;
  }
  if (worst >= threshold) {
    blocking.push({
      rule: "structural_repetition",
      evidence: `Structure ${Math.round(worst * 100)}% similar to a recent video on this channel (block ≥ ${Math.round(threshold * 100)}%).`,
    });
  }

  // ADVISE — payoff position (name the beat, not just a %).
  const payoff = payoffBeat(map);
  const targetPayoff = Math.round((opts.payoffTargetPct ?? 0.6) * 100);
  if (payoff != null && payoff.pct > targetPayoff + 10) {
    advisory.push({
      rule: "payoff_position",
      evidence: `Payoff detected at beat ${payoff.index} of ${map.beats.length} (${payoff.pct}%); channel target ~${targetPayoff}%. If your intended payoff is earlier, an insight/stat/heroShot beat later than it is being read as the payoff.`,
    });
  }

  // ADVISE — long flat-exposition run (name the span).
  const flat = flatRunSpan(map);
  if (flat.length >= 5) {
    advisory.push({
      rule: "flat_run",
      evidence: `${flat.length} consecutive beats with no re-hook (beats ${flat.start}-${flat.end}). Add a rehook beat within this span.`,
    });
  }

  // ADVISE — date arithmetic to verify.
  const dates = dateArithmeticClaims(map);
  if (dates.length) {
    advisory.push({ rule: "date_arithmetic", evidence: `Verify date claim(s): ${dates.join("; ")}.` });
  }

  // ADVISE — one entity repeated across many beats → duplicate-image risk
  // (ticket 01KY1ZNP…). Fires at ≥5 beats or ≥40% of the map.
  const dom = dominantEntity(map);
  if (dom && (dom.count >= 5 || (map.beats.length > 0 && dom.count / map.beats.length >= 0.4))) {
    advisory.push({
      rule: "repeated_entity",
      evidence: `referenceEntity "${dom.entity}" on ${dom.count}/${map.beats.length} beats — sources the same photo pool repeatedly. Use shot-specific entities ("${dom.entity} cockpit", "${dom.entity} at takeoff") or drop it on beats you want generated.`,
    });
  }

  return { blockingFindings: blocking, advisoryFindings: advisory };
}

/**
 * Choose which stored maps a submission is compared against for the
 * structural_repetition (cross-episode) check (ticket 01KY62TW…). Given the
 * channel's stored maps NEWEST-FIRST:
 *  - drop prior drafts of the SAME episode (same ideaId) — iterating a blocked
 *    map must not trip the block against the draft it supersedes;
 *  - keep only the LATEST map per OTHER episode — a superseded draft shouldn't
 *    dilute or pollute the variation baseline;
 *  - legacy rows with no ideaId each count once (can't be grouped).
 * The comparison stays strict for genuinely different episodes.
 */
export function selectComparisonMaps<T extends { map: BeatMap; ideaId: string | null }>(
  rowsNewestFirst: T[],
  currentIdeaId: string | null,
  limit = 30,
): BeatMap[] {
  const seenIdeas = new Set<string>();
  const out: BeatMap[] = [];
  for (const r of rowsNewestFirst) {
    if (currentIdeaId && r.ideaId === currentIdeaId) continue;
    if (r.ideaId) {
      if (seenIdeas.has(r.ideaId)) continue;
      seenIdeas.add(r.ideaId);
    }
    out.push(r.map);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Coarse shot + motion estimate from a BEAT MAP (ticket 01KY25DN… / #28). The
 * map has no full narration, so this can't run the real planShots — but it gives
 * the author the two numbers that matter BEFORE writing: roughly how many shots
 * the pipeline will demand (so brief count can be matched to it), and how many
 * shots will actually MOVE under the channel's motion axis (so "I marked 9
 * animates and got 1" is caught at the shape stage).
 *
 * The dominant driver when the video animates is NOT rhythm — every shot is
 * force-cut at the i2v clip cap, so shots ≈ duration / maxShotSec. Static videos
 * fall back to the density floor. Both are approximate; author_script /
 * get_production return the exact projection once narration exists.
 */
export type BeatMapShotEstimate = {
  estimatedShots: number;
  /** shots that will MOVE given the motion axis + heroShot count */
  projectedMovingShots: number;
  /** beats the author marked `animates: true` */
  animatesRequested: number;
  heroBeats: number;
  notes: string[];
};

export function estimateBeatMapShotPlan(
  map: BeatMap,
  profile: Pick<ProductionProfile, "rhythm" | "motion" | "imageDensity" | "maxAiClips">,
  opts: { isLong: boolean; maxClipSec?: number },
): BeatMapShotEstimate {
  const maxClipSec = opts.maxClipSec ?? 10;
  const durationSec = map.targetLengthSec > 0 ? map.targetLengthSec : Math.max(1, beatMapWordCount(map) / WORDS_PER_SEC);
  const spo = shotPlanOptions(profile, { isLong: opts.isLong, durationSec, maxClipSec });
  const beats = map.beats.length;

  let estimatedShots: number;
  if (spo.maxShotSec !== undefined) {
    // animating → every shot force-cut at the clip cap dominates the count
    estimatedShots = Math.max(beats, Math.round(durationSec / spo.maxShotSec));
  } else {
    // static → bounded by the density floor and the per-beat cap
    const byFloor = spo.minShotSec ? Math.round(durationSec / spo.minShotSec) : beats * (spo.maxShotsPerBeat ?? 4);
    const byBeatCap = beats * (spo.maxShotsPerBeat ?? 4);
    estimatedShots = Math.max(beats, Math.min(byFloor, byBeatCap));
  }

  const heroBeats = map.beats.filter((b) => b.heroShot).length;
  const animatesRequested = map.beats.filter((b) => b.animates).length;
  const maxAiClips = profile.maxAiClips ?? 12;
  let projectedMovingShots: number;
  if (profile.motion === "static") projectedMovingShots = 0;
  else if (profile.motion === "partial") projectedMovingShots = Math.min(heroBeats, maxAiClips);
  else projectedMovingShots = Math.min(estimatedShots, maxAiClips); // ai_video

  const notes: string[] = [];
  notes.push(
    `~${estimatedShots} shots estimated for ${Math.round(durationSec)}s — supply enough distinct visual briefs (finer beats / shot-specific referenceEntity) to fill them, or the same subject re-queries one photo pool (duplicate images).`,
  );
  if (profile.motion === "partial") {
    notes.push(
      `motion 'partial' → only heroShot beats move (${heroBeats} hero → ~${projectedMovingShots} moving). motionPrompt/animates on non-hero beats is ignored.`,
    );
  } else if (profile.motion === "static") {
    notes.push("motion 'static' → nothing moves.");
  }
  if (animatesRequested > projectedMovingShots) {
    notes.push(
      `${animatesRequested} beat(s) marked animates but only ~${projectedMovingShots} will move under '${profile.motion}' — mark those beats heroShot, or set motion 'ai_video', to actually animate them.`,
    );
  }
  return { estimatedShots, projectedMovingShots, animatesRequested, heroBeats, notes };
}

export type BeatMapVerdict = "pass" | "advise" | "block";

export function beatMapVerdict(r: { blockingFindings: unknown[]; advisoryFindings: unknown[] }): BeatMapVerdict {
  if (r.blockingFindings.length > 0) return "block";
  if (r.advisoryFindings.length > 0) return "advise";
  return "pass";
}
