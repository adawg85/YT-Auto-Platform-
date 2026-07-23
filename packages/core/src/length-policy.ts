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

/** Default advisory bands — named runtime targets the beat map can pick from. */
export const DEFAULT_LENGTH_BANDS: LengthBand[] = [
  { name: "short-doc", minSec: 480, maxSec: 720 },
  { name: "standard", minSec: 900, maxSec: 1500 },
  { name: "deep", minSec: 1500, maxSec: 2400 },
  { name: "longform", minSec: 3600, maxSec: 7200 },
];

export const DEFAULT_LENGTH_PRINCIPLE =
  "The beat map justifies the runtime; do not pad to hit a number or compress below the material.";

/**
 * Resolve a stored (partial/absent) policy to a complete one with defaults.
 * Behaviour-preserving: a channel with no policy gets the mid-roll floor, a soft
 * 40-min ceiling, and the default bands.
 */
export function resolveLengthPolicy(stored: Partial<LengthPolicy> | null | undefined): LengthPolicy {
  const s = stored ?? {};
  const floorSec =
    typeof s.floorSec === "number" && Number.isFinite(s.floorSec) && s.floorSec > 0
      ? Math.round(s.floorSec)
      : MIDROLL_FLOOR_SEC;
  const ceilingSec =
    typeof s.ceilingSec === "number" && Number.isFinite(s.ceilingSec) && s.ceilingSec > floorSec
      ? Math.round(s.ceilingSec)
      : 2400;
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
      : DEFAULT_LENGTH_BANDS;
  const principle =
    typeof s.principle === "string" && s.principle.trim() ? s.principle.trim().slice(0, 400) : DEFAULT_LENGTH_PRINCIPLE;
  return { floorSec, ceilingSec, bands: bands.length ? bands : DEFAULT_LENGTH_BANDS, principle };
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
  input: { runtimeSec: number; beatCount: number; words: number },
): RuntimeAdvisory[] {
  const out: RuntimeAdvisory[] = [];
  const { runtimeSec, beatCount, words } = input;
  if (runtimeSec <= 0) return out;

  if (runtimeSec < policy.floorSec) {
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
    if (beatsPerMin > 3) {
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
