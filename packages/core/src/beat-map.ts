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
import { MAX_SHOTS_PER_BEAT, bindingShotConstraint, shotPlanOptions, type ShotConstraint } from "./shots";
import { SEGMENT_TARGET_WORDS } from "./narration-segments";

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
  /** #69: an ORDERED list of real subjects consumed across the shots this beat
   * is cut into — so one beat can supply many distinct visual briefs without
   * inflating the beat count. Closes the entity-coverage gap on artwork channels
   * where the shot count exceeds the beat count. */
  referenceEntities?: (string | null)[];
  /** #69: explicit author marker for the payoff beat — the moment the hook's
   * promise is discharged. When present it drives payoff_position directly
   * instead of the position heuristic (which can't find a mid-map payoff on a
   * fine-grained map, where nearly every beat is insight/stat). */
  payoff?: boolean;
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
/**
 * #69: flat_run fires when a no-re-hook stretch exceeds this many SECONDS — the
 * standard retention re-hook interval is ~3-4 min, so a run past ~3.5 min is
 * where attention genuinely sags, independent of how finely the beats are cut.
 */
export const FLAT_RUN_SEC = 210;
/** Fallback beat-count threshold when the map carries no timing signal at all. */
export const FLAT_RUN_BEATS_FALLBACK = 5;

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
export function payoffBeat(map: BeatMap): { index: number; pct: number; source: "marker" | "hero" } | null {
  if (map.beats.length <= 1) return null;
  // #69: an EXPLICIT marker wins — the author says where the payoff is. Use the
  // FIRST marked beat (the promise is discharged once; later beats build on it).
  const marked = map.beats.findIndex((b) => b.payoff === true);
  if (marked >= 0) {
    return { index: marked, pct: Math.round((marked / (map.beats.length - 1)) * 100), source: "marker" };
  }
  // #69: NO marker → fall back to the last heroShot ONLY. The old heuristic also
  // counted insight/stat beats, but on a fine-grained map nearly every beat is
  // insight/stat, so "the last one" always lands just before the CTAs (~99%) and
  // the advisory fired on every well-structured episode — noise, not signal
  // (operator evidence, ticket 01KYEYF2…). A heroShot is a deliberate emphasis
  // marker, so the last one is a defensible payoff guess; absent even that, we
  // decline to guess (return null) rather than emit a false ~99%.
  let heroIdx = -1;
  for (let i = 0; i < map.beats.length; i++) if (map.beats[i]!.heroShot) heroIdx = i;
  if (heroIdx < 0) return null;
  return { index: heroIdx, pct: Math.round((heroIdx / (map.beats.length - 1)) * 100), source: "hero" };
}

/** Payoff position as a percentage (back-compat wrapper over payoffBeat). */
export function payoffPositionPct(map: BeatMap): number | null {
  return payoffBeat(map)?.pct ?? null;
}

/**
 * Per-beat duration in seconds, from the best signal available: explicit
 * `timingSec` deltas (cumulative from start), else `wordBudget / WORDS_PER_SEC`,
 * else the map's runtime spread evenly across its beats. Returns null when no
 * signal exists at all (so the caller can fall back to a beat-count rule). #69:
 * the flat-run risk is an ELAPSED-TIME property (a stretch without a re-hook),
 * not a beat-count one — 9 beats is minutes on a coarse map and seconds on a
 * fine one, so the count threshold measured granularity, not craft.
 */
export function beatDurationsSec(map: BeatMap, wordsPerSec: number = WORDS_PER_SEC): number[] | null {
  const n = map.beats.length;
  if (n === 0) return null;
  const timings = map.beats.map((b) => (typeof b.timingSec === "number" ? b.timingSec : null));
  const haveAllTimings = timings.every((t) => t != null);
  if (haveAllTimings && n > 1) {
    const vals = timings as number[];
    // #82: `timingSec` arrives in one of two shapes and the schema doesn't force
    // one, so infer it. CUMULATIVE offsets-from-start (the documented form) are
    // monotonic AND sum to far more than the runtime (≈ n·T/2); PER-BEAT durations
    // (what an author naturally supplies — "they sum to the runtime") sum to ≈ T.
    // The old code ALWAYS assumed cumulative, so per-beat values made the LAST beat
    // absorb `targetLengthSec − lastValue`, ballooning a span's elapsed time to
    // roughly the whole runtime (the reported "16.8 min for a 5.0 min span").
    const sum = vals.reduce((a, b) => a + b, 0);
    const monotonic = vals.every((v, i) => i === 0 || v >= vals[i - 1]!);
    const looksCumulative = monotonic && (map.targetLengthSec > 0 ? sum > map.targetLengthSec * 1.3 : true);
    if (looksCumulative) {
      // Deltas between cumulative timings; last beat gets the map's tail (runtime−lastStart)
      // or the average delta when runtime is unknown/short.
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const cur = vals[i]!;
        const next = i + 1 < n ? vals[i + 1]! : Math.max(cur, map.targetLengthSec || cur);
        out.push(Math.max(0, next - cur));
      }
      return out;
    }
    // Per-beat durations: use verbatim (a span's elapsed time is then their sum).
    return vals.map((v) => Math.max(0, v));
  }
  const haveAllBudgets = map.beats.every((b) => typeof b.wordBudget === "number" && b.wordBudget! > 0);
  if (haveAllBudgets) return map.beats.map((b) => b.wordBudget! / wordsPerSec);
  if (map.targetLengthSec > 0) return map.beats.map(() => map.targetLengthSec / n);
  return null;
}

/**
 * #120: roughly how many narration SEGMENTS (the ~25-word units the operator
 * records — narration-segments.ts) this map will cut into. Each segment
 * boundary contributes a silence gap to the assembled duration, which is why
 * beat-dense maps read slower (the ticket's 2.74 vs 3.04 w/s spread). Beats
 * without a wordBudget count as one segment.
 */
export function estimateMapSegments(map: BeatMap): number {
  return map.beats.reduce(
    (sum, b) =>
      sum +
      (typeof b.wordBudget === "number" && b.wordBudget > 0
        ? Math.max(1, Math.ceil(b.wordBudget / SEGMENT_TARGET_WORDS))
        : 1),
    0,
  );
}

/**
 * The longest run of consecutive beats with no hook/rehook — the flat-exposition
 * risk — with the start/end beat indices AND its elapsed seconds (#69) so the
 * author can fix it without recounting (ticket 01KY29ZW…). `elapsedSec` is null
 * when the map carries no timing/budget/runtime signal to estimate from.
 */
export function flatRunSpan(map: BeatMap): { start: number; end: number; length: number; elapsedSec: number | null } {
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
  const durations = beatDurationsSec(map);
  let elapsedSec: number | null = null;
  if (durations && bestEnd >= 0) {
    elapsedSec = 0;
    for (let i = bestStart; i <= bestEnd; i++) elapsedSec += durations[i] ?? 0;
    elapsedSec = Math.round(elapsedSec);
  }
  return { start: bestStart, end: bestEnd, length: longest, elapsedSec };
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
    /** #120: the channel's measured read rate — the word budget was sized at a
     * fixed 2.5 w/s while the operator provably reads at 2.89, so the gate
     * BLOCKED maps that would have hit the target and mandated ~14%-short ones.
     * segmentGapSec models the per-segment silence that makes beat-dense maps
     * read slower. Omitted → the platform default, unchanged behaviour. */
    readRate?: { wordsPerSec: number; segmentGapSec?: number; basis?: string };
  } = {},
): { blockingFindings: BeatMapFinding[]; advisoryFindings: BeatMapFinding[] } {
  const blocking: BeatMapFinding[] = [];
  const advisory: BeatMapFinding[] = [];

  // BLOCK — word budget outside the acceptable band around target. #120: the
  // budget is sized at the channel's RESOLVED rate (measured from assembled
  // operator narration when enough clean samples exist), minus the per-segment
  // gap allowance for this map's own density; the evidence names the rate and
  // where it came from so an author sees which number they're held to.
  const rate = opts.readRate?.wordsPerSec ?? WORDS_PER_SEC;
  const gap = opts.readRate?.segmentGapSec ?? 0;
  const speakingSec =
    gap > 0
      ? Math.max(map.targetLengthSec - gap * estimateMapSegments(map), map.targetLengthSec * 0.5)
      : map.targetLengthSec;
  const target = Math.round(speakingSec * rate);
  const actual = beatMapWordCount(map);
  if (target > 0 && actual > 0) {
    const low = Math.round(target * (1 - WORD_BUDGET_BAND));
    const high = Math.round(target * (1 + WORD_BUDGET_BAND));
    const rateNote =
      opts.readRate && opts.readRate.basis !== "default"
        ? ` at your measured ${rate} w/s read rate${gap > 0 ? ` (incl. ~${gap}s/segment pause allowance)` : ""}`
        : "";
    if (actual < low || actual > high) {
      blocking.push({
        rule: "word_budget",
        evidence: `Beat-map budget ${actual} words vs target ${target} (band ${low}-${high} for ${map.targetLengthSec}s${rateNote}).`,
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

  // ADVISE — payoff position (name the beat, not just a %). #69: only fires when
  // the payoff is actually locatable — an explicit beats[].payoff marker, or a
  // heroShot to fall back on. On a marker-less, hero-less map payoffBeat returns
  // null and this stays silent instead of emitting a false ~99% on every map.
  const payoff = payoffBeat(map);
  const targetPayoff = Math.round((opts.payoffTargetPct ?? 0.6) * 100);
  if (payoff != null && payoff.pct > targetPayoff + 10) {
    const how =
      payoff.source === "marker"
        ? "Your marked payoff beat sits late"
        : `No beats[].payoff marker was set, so the last heroShot beat is read as the payoff — mark the real payoff with payoff:true if it's earlier`;
    advisory.push({
      rule: "payoff_position",
      evidence: `Payoff at beat ${payoff.index} of ${map.beats.length} (${payoff.pct}%); channel target ~${targetPayoff}%. ${how}.`,
    });
  }

  // ADVISE — long flat-exposition run. #69: keyed to ELAPSED SECONDS, not beat
  // count — a re-hook interval is a time property, so a 9-beat run is minutes on
  // a coarse map (real risk) but under two minutes on a fine one (not). Falls
  // back to the beat-count rule only when the map carries no timing signal.
  const flat = flatRunSpan(map);
  const flatFires =
    flat.elapsedSec != null ? flat.elapsedSec >= FLAT_RUN_SEC : flat.length >= FLAT_RUN_BEATS_FALLBACK;
  if (flat.length > 0 && flatFires) {
    const span =
      flat.elapsedSec != null
        ? `${Math.round(flat.elapsedSec / 6) / 10} min with no re-hook (${flat.length} beats ${flat.start}-${flat.end})`
        : `${flat.length} consecutive beats with no re-hook (beats ${flat.start}-${flat.end})`;
    advisory.push({
      rule: "flat_run",
      evidence: `${span}. Add a re-hook within this span (target a re-hook every ~${Math.round(FLAT_RUN_SEC / 6) / 10} min).`,
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
  /** #69: distinct visual briefs the map supplies — each beat contributes its
   * referenceEntities[] length (deduped) or 1 for a single referenceEntity. */
  suppliedEntities: number;
  /** #69: suppliedEntities / estimatedShots, 0-1 (the coverage the operator was
   * measuring by hand). >=1 means enough briefs to fill every shot. */
  entityCoverage: number;
  /** #108: WHICH constraint decided estimatedShots — the same field
   * author_script's shotPlan carries (#105), so the CHEAP gate names the knob
   * that moves the number instead of leaving it to the expensive one. */
  bindingConstraint: ShotConstraint;
  /** #108: what the minSecondsPerShot floor alone would allow across the MAP's
   * own targetLengthSec (never a channel target — the #105-reopen divisor rule). */
  shotsIfFloorOnly: number | null;
  /** #116: the seconds this estimate was computed over, and where they came
   * from — so this number and author_script's are reconcilable when they
   * differ (the map may declare 100s while the narration runs 114s). */
  durationBasisSec: number;
  durationBasis: "timingSec" | "wordBudget" | "targetLengthSec";
  /** #116: true when no per-beat signal (wordBudget/timingSec) was supplied —
   * shots were spread evenly over the declared runtime, so treat the integer
   * as a rough envelope, not a brief count to author against. */
  coarse: boolean;
  notes: string[];
};

/** #69: distinct real subjects a beat supplies — its referenceEntities list
 * (non-empty, deduped) if present, else 1 for a single referenceEntity, else 0. */
export function beatSuppliedEntities(beat: BeatMapBeat): number {
  const list = Array.isArray(beat.referenceEntities)
    ? beat.referenceEntities.filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    : [];
  if (list.length) return new Set(list.map((e) => e.trim().toLowerCase())).size;
  return beat.referenceEntity?.trim() ? 1 : 0;
}

/** #116: the average spoken sentence at 2.5 w/s (~15 words) — the real planner
 * (planShots) only cuts at SENTENCE boundaries, so at map time (no narration
 * yet) cuts can't plausibly land more often than this. */
export const EST_AVG_SENTENCE_SEC = 6;

export function estimateBeatMapShotPlan(
  map: BeatMap,
  profile: Pick<ProductionProfile, "rhythm" | "motion" | "imageDensity" | "minSecondsPerShot" | "maxAiClips">,
  opts: { isLong: boolean; maxClipSec?: number; /** #120: resolved read rate for wordBudget→sec */ wordsPerSec?: number },
): BeatMapShotEstimate {
  const maxClipSec = opts.maxClipSec ?? 10;
  const wordsPerSec = opts.wordsPerSec ?? WORDS_PER_SEC;
  const beats = map.beats.length;

  // #116: duration basis — the best PER-BEAT signal the map supplies, the same
  // cascade beatDurationsSec runs (timingSec deltas → wordBudget/2.5 → runtime
  // spread evenly). author_script plans over the narration's word-derived
  // runtime, so a map with full wordBudget now uses the same basis instead of
  // the declared targetLengthSec (the 33-vs-38 shotsIfFloorOnly split in #116).
  const haveAllTimings = beats > 1 && map.beats.every((b) => typeof b.timingSec === "number");
  const haveAllBudgets = map.beats.every((b) => typeof b.wordBudget === "number" && b.wordBudget! > 0);
  const durationBasis: BeatMapShotEstimate["durationBasis"] = haveAllTimings
    ? "timingSec"
    : haveAllBudgets
      ? "wordBudget"
      : "targetLengthSec";
  const coarse = durationBasis === "targetLengthSec";
  const fallbackSec = map.targetLengthSec > 0 ? map.targetLengthSec : Math.max(1, beatMapWordCount(map) / wordsPerSec);
  const perBeatSec = beatDurationsSec(map, wordsPerSec) ?? map.beats.map(() => fallbackSec / Math.max(1, beats));
  const durationSec = Math.max(1, perBeatSec.reduce((a, b) => a + b, 0)) || fallbackSec;

  const spo = shotPlanOptions(profile, { isLong: opts.isLong, durationSec, maxClipSec });

  let estimatedShots: number;
  if (spo.maxShotSec !== undefined) {
    // animating → every shot force-cut at the clip cap dominates the count
    estimatedShots = Math.max(beats, Math.round(durationSec / spo.maxShotSec));
  } else {
    // #116: static → allocate PER BEAT, the way planShots actually cuts, instead
    // of the old flat `beats × cap` fan-out (which assumed every beat saturates
    // the cap and over-estimated the ticket's 7-beat map by 75%). A beat yields
    // roughly one shot per cut interval — the density/explicit floor, but never
    // finer than a spoken sentence (planShots only cuts at sentence ends) —
    // ROUNDED (the planner gives the tail remainder its own shot), clamped to
    // [1, per-beat cap].
    const capPerBeat = Math.max(1, spo.maxShotsPerBeat ?? MAX_SHOTS_PER_BEAT);
    const cutSec = Math.max(spo.minShotSec ?? 0, EST_AVG_SENTENCE_SEC);
    const perBeatSum = perBeatSec.reduce(
      (sum, sec) => sum + Math.min(capPerBeat, Math.max(1, Math.round(sec / cutSec))),
      0,
    );
    // the floor is also a GLOBAL rate limit (total shots ≤ duration/floor —
    // per-beat rounding can slightly overshoot it), and one beat is always at
    // least one shot.
    const floorCeiling = spo.minShotSec ? Math.floor(durationSec / spo.minShotSec) : Infinity;
    estimatedShots = Math.max(beats, Math.min(perBeatSum, floorCeiling));
  }

  const heroBeats = map.beats.filter((b) => b.heroShot).length;
  const animatesRequested = map.beats.filter((b) => b.animates).length;
  const maxAiClips = profile.maxAiClips ?? 12;
  let projectedMovingShots: number;
  if (profile.motion === "static") projectedMovingShots = 0;
  else if (profile.motion === "partial") projectedMovingShots = Math.min(heroBeats, maxAiClips);
  else projectedMovingShots = Math.min(estimatedShots, maxAiClips); // ai_video

  // #69: how many distinct visual briefs the map actually supplies vs the shots
  // it will cut. A beat's referenceEntities[] can supply many, so a fine-shot map
  // no longer has to inflate its beat count to close the gap.
  const suppliedEntities = map.beats.reduce((sum, b) => sum + beatSuppliedEntities(b), 0);
  const entityCoverage = estimatedShots > 0 ? Math.min(1, suppliedEntities / estimatedShots) : 0;

  // #108: name the knob that decides the count, exactly as author_script's
  // shotPlan does (#105) — durationSec here is the map's OWN targetLengthSec
  // (or its word budget), never a channel target.
  const binding = bindingShotConstraint({
    projectedShots: estimatedShots,
    beats,
    durationSec,
    maxShotsPerBeat: spo.maxShotsPerBeat,
    minShotSec: spo.minShotSec,
    maxShotSec: spo.maxShotSec,
    clampedByClipCap:
      spo.maxShotSec != null &&
      typeof profile.minSecondsPerShot === "number" &&
      profile.minSecondsPerShot > spo.maxShotSec,
    // #111: resolved tier + format, so the remedy never names a no-op knob
    density: profile.imageDensity ?? "standard",
    isLong: opts.isLong,
  });

  // #116: name the duration basis in the note so this number and
  // author_script's are reconcilable when they differ.
  const basisLabel =
    durationBasis === "wordBudget"
      ? "from summed wordBudget"
      : durationBasis === "timingSec"
        ? "from beat timings"
        : "from the declared targetLengthSec";
  const notes: string[] = [];
  if (binding.note) notes.push(binding.note);
  if (coarse) {
    notes.push(
      `This estimate is COARSE: no beats[].wordBudget (or timingSec) supplied, so the runtime was spread evenly across beats. Supply wordBudget per beat for a per-beat estimate that matches author_script's shotPlan; the exact count only exists once narration does.`,
    );
  }
  if (suppliedEntities > 0 && entityCoverage < 1) {
    // some entities are supplied but not enough to fill every shot → the real,
    // measurable shortfall (the operator's 86% case), with the #69 remedy.
    notes.push(
      `~${estimatedShots} shots estimated for ${Math.round(durationSec)}s (${basisLabel}) but only ${suppliedEntities} distinct visual brief(s) supplied (${Math.round(entityCoverage * 100)}% coverage) — the ${estimatedShots - suppliedEntities} uncovered shot(s) re-query an existing subject's photo pool (duplicate images). Add briefs WITHOUT adding beats via beats[].referenceEntities (an ordered list consumed across the shots one beat is cut into), or raise minSecondsPerShot so fewer, longer shots need fewer briefs.`,
    );
  } else {
    notes.push(
      `~${estimatedShots} shots estimated for ${Math.round(durationSec)}s (${basisLabel}) — supply enough distinct visual briefs (beats[].referenceEntities across a beat's shots, or finer beats) to fill them, or the same subject re-queries one photo pool (duplicate images).`,
    );
  }
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
  return {
    estimatedShots,
    projectedMovingShots,
    animatesRequested,
    heroBeats,
    suppliedEntities,
    entityCoverage,
    bindingConstraint: binding.constraint,
    shotsIfFloorOnly: binding.shotsIfFloorOnly,
    durationBasisSec: Math.round(durationSec * 10) / 10,
    durationBasis,
    coarse,
    notes,
  };
}

export type BeatMapVerdict = "pass" | "advise" | "block";

export function beatMapVerdict(r: { blockingFindings: unknown[]; advisoryFindings: unknown[] }): BeatMapVerdict {
  if (r.blockingFindings.length > 0) return "block";
  if (r.advisoryFindings.length > 0) return "advise";
  return "pass";
}
