/**
 * Content-driven runtime policy (ticket 01KY61RC… / #39). Runtime should track
 * how much the topic carries, within a monetisation-aware band, instead of a
 * single fixed channel default — the same "derive from the material, don't impose
 * a constant" principle the platform already applies to shot count and structure.
 *
 * This module is the PURE core: resolve a stored policy to behaviour-preserving
 * defaults, and compute the ADVISORY runtime↔depth check surfaced at the beat-map
 * stage. The only HARD bound is floorSec (YouTube's 8-min mid-roll threshold);
 * everything else advises. The pipeline consuming a per-production runtime target
 * is a separate, deferred step — this ships as config + advisory (no live-runtime
 * change), matching how review_beat_map / review_slate landed.
 */

import type { LengthPolicy, LengthBand } from "@ytauto/db";

/** YouTube's mid-roll ad threshold: below 8 min the channel loses mid-rolls. */
export const MIDROLL_FLOOR_SEC = 480;

/**
 * Default advisory bands — named runtime targets the beat map can pick from.
 * CONTIGUOUS from the mid-roll floor (no coverage gap) so every runtime ≥ floor
 * maps to a band (ticket 01KY98YR… flagged a 720–900 hole in the first cut).
 */
export const DEFAULT_LENGTH_BANDS: LengthBand[] = [
  { name: "short-doc", minSec: 480, maxSec: 720 },
  { name: "standard", minSec: 720, maxSec: 1500 },
  { name: "deep", minSec: 1500, maxSec: 2400 },
  { name: "longform", minSec: 2400, maxSec: 7200 },
];

export const DEFAULT_LENGTH_PRINCIPLE =
  "The beat map justifies the runtime; do not pad to hit a number or compress below the material.";

/**
 * #104: short-form bands. A Shorts channel has no mid-roll lever to lose, so the
 * 8-minute floor — the one HARD bound on a long-form channel — is meaningless
 * there. The operator's Shorts were reporting "below the channel's own hard
 * floor" on every single video, a permanent advisory nobody can action, which is
 * exactly how a real advisory gets tuned out.
 */
export const SHORT_LENGTH_BANDS: LengthBand[] = [
  { name: "snap", minSec: 15, maxSec: 30 },
  { name: "standard-short", minSec: 30, maxSec: 60 },
  { name: "extended-short", minSec: 60, maxSec: 180 },
];

/** Soft ceiling for short-form — YouTube's Shorts cutoff. */
export const SHORT_CEILING_SEC = 180;

export const SHORT_LENGTH_PRINCIPLE =
  "A Short runs as long as the single idea carries and no longer; there is no mid-roll floor to clear.";

/**
 * Resolve a stored (partial/absent) policy to a complete one with defaults.
 * Behaviour-preserving: a channel with no policy gets the mid-roll floor, a soft
 * 40-min ceiling, and the default bands.
 *
 * #104: pass `{ contentFormat: "short" }` for a Shorts channel/subchannel and the
 * defaults become short-form — floor 0 (no mid-roll bound), a 3-minute soft
 * ceiling, short bands. An inherited long-form floor that sits ABOVE the ceiling
 * (the parent's 480s on a Shorts subchannel) is dropped rather than applied, since
 * it could never be satisfied. A floor deliberately set within short-form range
 * (say 30s) is kept.
 */
export function resolveLengthPolicy(
  stored: Partial<LengthPolicy> | null | undefined,
  opts?: { contentFormat?: string | null },
): LengthPolicy {
  const s = stored ?? {};
  const shortForm = opts?.contentFormat === "short";
  const storedFloor =
    typeof s.floorSec === "number" && Number.isFinite(s.floorSec) && s.floorSec > 0
      ? Math.round(s.floorSec)
      : null;
  const defaultCeiling = shortForm ? SHORT_CEILING_SEC : 2400;
  let floorSec = storedFloor ?? (shortForm ? 0 : MIDROLL_FLOOR_SEC);
  const ceilingSec =
    typeof s.ceilingSec === "number" && Number.isFinite(s.ceilingSec) && s.ceilingSec > floorSec
      ? Math.round(s.ceilingSec)
      : defaultCeiling;
  // a long-form floor inherited onto a Shorts channel can never be cleared —
  // treat it as absent instead of advising against it on every video
  if (shortForm && floorSec >= ceilingSec) floorSec = 0;
  const bands =
    Array.isArray(s.bands) && s.bands.length
      ? s.bands
          .filter(
            (b): b is LengthBand =>
              Boolean(b) &&
              typeof b.name === "string" &&
              typeof b.minSec === "number" &&
              typeof b.maxSec === "number" &&
              b.maxSec >= b.minSec,
          )
          .map((b) => ({ name: b.name.slice(0, 40), minSec: Math.round(b.minSec), maxSec: Math.round(b.maxSec) }))
      : shortForm
        ? SHORT_LENGTH_BANDS
        : DEFAULT_LENGTH_BANDS;
  const defaultBands = shortForm ? SHORT_LENGTH_BANDS : DEFAULT_LENGTH_BANDS;
  const principle =
    typeof s.principle === "string" && s.principle.trim()
      ? s.principle.trim().slice(0, 400)
      : shortForm
        ? SHORT_LENGTH_PRINCIPLE
        : DEFAULT_LENGTH_PRINCIPLE;
  return { floorSec, ceilingSec, bands: bands.length ? bands : defaultBands, principle };
}

/** The band a runtime falls in (first match), or null if it's between/outside bands. */
export function bandForRuntime(policy: LengthPolicy, runtimeSec: number): LengthBand | null {
  return policy.bands.find((b) => runtimeSec >= b.minSec && runtimeSec <= b.maxSec) ?? null;
}

export type RuntimeAdvisory = { rule: string; evidence: string };

/**
 * ADVISORY check for the beat-map stage (never a block, except the floor is called
 * out as the one hard bound): is the proposed runtime matched to how much the map
 * actually carries? Uses beat count + word budget as the depth proxy. Flags:
 *  - below the mid-roll floor (the hard bound — surfaced as a strong advisory);
 *  - above the soft ceiling;
 *  - a long runtime on too few/thin beats (padding risk);
 *  - a dense map compressed into too short a runtime (cramming risk).
 * `words` is the beat map's total word budget (0 if unknown → density checks skip).
 */
export function reviewRuntimeFit(
  policy: LengthPolicy,
  input: {
    runtimeSec: number;
    beatCount: number;
    words: number;
    /** #69: the channel's motion + imageDensity, so a deliberate shot-supply
     * strategy on a still-image essay channel isn't flagged as cramming. */
    motion?: string;
    imageDensity?: string;
  },
): RuntimeAdvisory[] {
  const out: RuntimeAdvisory[] = [];
  const { runtimeSec, beatCount, words } = input;
  if (runtimeSec <= 0) return out;

  // #104: floorSec 0 means "no floor applies" (short-form) — never advise against it
  if (policy.floorSec > 0 && runtimeSec < policy.floorSec) {
    out.push({
      rule: "below_midroll_floor",
      evidence: `Proposed runtime ${Math.round(runtimeSec / 60)} min (${runtimeSec}s) is below the ${Math.round(policy.floorSec / 60)}-min mid-roll floor (${policy.floorSec}s) — the channel loses the mid-roll ad lever entirely below it. This is the one hard bound; raise the runtime or accept no mid-rolls.`,
    });
  } else if (runtimeSec > policy.ceilingSec) {
    out.push({
      rule: "above_soft_ceiling",
      evidence: `Proposed runtime ${Math.round(runtimeSec / 60)} min (${runtimeSec}s) exceeds the channel's soft ceiling (${Math.round(policy.ceilingSec / 60)} min / ${policy.ceilingSec}s). Fine if the material carries it — but confirm it isn't padded.`,
    });
  }

  // Density proxy: beats per minute + words per minute. Speaking pace ~150 wpm.
  const minutes = runtimeSec / 60;
  if (beatCount > 0 && minutes > 0) {
    const beatsPerMin = beatCount / minutes;
    if (beatsPerMin < 0.5 && runtimeSec >= policy.floorSec) {
      out.push({
        rule: "runtime_padded_for_beats",
        evidence: `${beatCount} beats across ${Math.round(minutes)} min is ${beatsPerMin.toFixed(2)} beats/min — thin for the runtime (padding risk). Either the map needs more distinct beats or the runtime should come down to fit the material.`,
      });
    }
    // #69: on a still-image essay channel (motion:static + imageDensity:relaxed),
    // a high beats/min is a SHOT-SUPPLY strategy (feeding distinct visual briefs to
    // the shot planner), not cramming — the word budget (runtime_undersized_for_script,
    // wpm>200) is the real cramming test there. Skip this beat-density flag for that
    // combination so it stops fighting the shotEstimate's "supply more briefs" note.
    const stillEssay = input.motion === "static" && input.imageDensity === "relaxed";
    if (beatsPerMin > 3 && !stillEssay) {
      out.push({
        rule: "runtime_compressed_for_beats",
        evidence: `${beatCount} beats in ${Math.round(minutes)} min is ${beatsPerMin.toFixed(1)} beats/min — dense; the map may be compressed below what it carries (cramming risk). Consider a longer runtime or fewer/merged beats.`,
      });
    }
  }
  if (words > 0 && minutes > 0) {
    const wpm = words / minutes;
    if (wpm > 200) {
      out.push({
        rule: "runtime_undersized_for_script",
        evidence: `~${words} words in ${Math.round(minutes)} min is ${Math.round(wpm)} words/min — faster than a natural ~150 wpm delivery. The runtime is likely undersized for the script; lengthen it or trim words.`,
      });
    } else if (wpm > 0 && wpm < 90 && runtimeSec >= policy.floorSec) {
      out.push({
        rule: "runtime_oversized_for_script",
        evidence: `~${words} words in ${Math.round(minutes)} min is ${Math.round(wpm)} words/min — slower than a natural ~150 wpm delivery, so the runtime outruns the script (padding risk).`,
      });
    }
  }
  return out;
}
