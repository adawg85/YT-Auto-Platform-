/**
 * Shot-plan projection (ticket 01KY25DN… / #28). The number of SHOTS a script
 * produces — and how many of them will MOVE — is emergent from planShots (rhythm
 * + imageDensity) and planMotion (motion axis + heroShot + maxAiClips), and was
 * only visible AFTER generation at the visuals gate. An operator authored 19
 * beats, the pipeline cut 83 shots, and 64 of them re-queried the same few
 * referenceEntity strings → duplicate images. Nine motionPrompts were supplied;
 * one shot moved.
 *
 * This projects both numbers from the authored beats BEFORE spend, by running
 * the REAL planShots + planMotion against synthetic evenly-spaced word timings
 * (the platform narration rate). It reuses the production functions verbatim so
 * the projection tracks the pipeline as those evolve.
 *
 * Caveats (surfaced in `notes`):
 *  - Word timings are synthesized at a constant rate, so `pause` rhythm (which
 *    cuts on real audio gaps) can't be projected precisely — its shot count is a
 *    LOWER BOUND.
 *  - For real/mixed channels a "moving" shot may be a sourced stock CLIP or an
 *    i2v fallback; a shot counted as moving still keeps a still if no clip is
 *    found. The count is the number of shots ELIGIBLE to move, not a guarantee.
 */
import type { ProductionProfile, WordTimestamp } from "@ytauto/db";
import { planShots, shotPlanOptions, type BeatInput } from "./shots";
import { planMotion } from "./motion";
import { WORDS_PER_SEC } from "./beat-map";

/** Default i2v clip cap when the caller can't read VIDEO_MAX_CLIP_SEC (env-only). */
export const DEFAULT_MAX_CLIP_SEC = 10;

export type ProjectionBeat = {
  beatIndex: number;
  words: number;
  /** shots this beat is projected to be cut into */
  shots: number;
  heroShot: boolean;
  hasMotionPrompt: boolean;
  /** at least one of this beat's shots is eligible to move */
  willMove: boolean;
};

export type ShotProjection = {
  beats: number;
  words: number;
  estimatedDurationSec: number;
  /** total shots the pipeline is projected to cut */
  projectedShots: number;
  /** shots eligible to move (i2v clip or sourced stock clip), given the motion axis */
  projectedMovingShots: number;
  /** distinct non-empty referenceEntity strings — the size of the "brief" pool */
  distinctReferenceEntities: number;
  /** shots that will re-query an already-used referenceEntity (duplicate-image risk) */
  repeatedEntityShots: number;
  /** beats that carry a motionPrompt but whose shots won't move (prompt is ignored) */
  unusedMotionPromptBeats: number[];
  perBeat: ProjectionBeat[];
  notes: string[];
};

type ProjectionBeatInput = BeatInput & { motionPrompt?: string | null };

const wordsOf = (t: string) => t.split(/\s+/).filter(Boolean);

/**
 * Project the shot + motion plan for a set of authored beats under a profile.
 * Deterministic and LLM-free — safe to call at author time or in a read tool.
 */
export function projectShotPlan(
  beats: ProjectionBeatInput[],
  profile: Pick<ProductionProfile, "rhythm" | "motion" | "imageDensity" | "visualMode" | "maxAiClips">,
  opts: { isLong: boolean; targetLengthSec?: number; maxClipSec?: number },
): ShotProjection {
  const maxClipSec = opts.maxClipSec ?? DEFAULT_MAX_CLIP_SEC;
  const perWordSec = 1 / WORDS_PER_SEC;

  // synthesize contiguous, evenly-spaced word timings (no pauses) at the
  // platform narration rate — the same rate the pipeline sizes budgets with.
  const words: WordTimestamp[] = [];
  let t = 0;
  for (const b of beats) {
    for (const w of wordsOf(b.text)) {
      words.push({ word: w, startSec: t, endSec: t + perWordSec });
      t += perWordSec;
    }
  }
  const totalWords = words.length;
  const estimatedDurationSec =
    opts.targetLengthSec && opts.targetLengthSec > 0 ? opts.targetLengthSec : Math.max(1, totalWords * perWordSec);

  const spo = shotPlanOptions(profile, { isLong: opts.isLong, durationSec: estimatedDurationSec, maxClipSec });
  const shots = planShots(beats, words, spo);
  // Mark shots whose beat carries an authored motionPrompt so the projection
  // reflects ai_video's author-preferred, evenly-distributed selection (01KY3HWK…).
  const motion = planMotion(
    shots.map((s) => ({ ...s, preferMotion: Boolean(beats[s.beatIndex]?.motionPrompt?.trim()) })),
    profile,
    { maxClipSec, maxAiClips: profile.maxAiClips ?? 12 },
  );

  // per-beat rollup
  const shotsByBeat = new Map<number, number>();
  const moveByBeat = new Map<number, boolean>();
  const entityUse = new Map<string, number>();
  let repeatedEntityShots = 0;
  shots.forEach((s, idx) => {
    shotsByBeat.set(s.beatIndex, (shotsByBeat.get(s.beatIndex) ?? 0) + 1);
    const moving = motion[idx]?.mode !== "none";
    if (moving) moveByBeat.set(s.beatIndex, true);
    const ent = s.referenceEntity?.trim().toLowerCase();
    if (ent) {
      const seen = entityUse.get(ent) ?? 0;
      if (seen > 0) repeatedEntityShots++; // every re-use past the first draws the same pool
      entityUse.set(ent, seen + 1);
    }
  });

  const perBeat: ProjectionBeat[] = beats.map((b, bi) => ({
    beatIndex: bi,
    words: wordsOf(b.text).length,
    shots: shotsByBeat.get(bi) ?? 0,
    heroShot: !!b.heroShot,
    hasMotionPrompt: !!b.motionPrompt?.trim(),
    willMove: moveByBeat.get(bi) ?? false,
  }));

  const unusedMotionPromptBeats = perBeat.filter((p) => p.hasMotionPrompt && !p.willMove).map((p) => p.beatIndex);
  const projectedMovingShots = motion.filter((m) => m.mode !== "none").length;

  const notes: string[] = [];
  if (profile.rhythm === "pause") {
    notes.push("rhythm is 'pause' — shots cut on real audio gaps, so this projected count is a lower bound.");
  }
  if (profile.motion === "static") {
    notes.push("motion is 'static' — no shots move regardless of motionPrompts.");
  } else if (profile.motion === "partial") {
    notes.push(
      "motion is 'partial' — ONLY heroShot beats' first shot is eligible to move; motionPrompt does not select a shot, it only styles one already chosen. To move more shots, mark more beats heroShot or set motion 'ai_video'.",
    );
  }
  if (unusedMotionPromptBeats.length) {
    notes.push(
      `${unusedMotionPromptBeats.length} motionPrompt(s) will be ignored (their beat isn't selected to move): beats ${unusedMotionPromptBeats.join(", ")}.`,
    );
  }
  const distinctReferenceEntities = entityUse.size;
  if (repeatedEntityShots > 0) {
    notes.push(
      `${repeatedEntityShots} shot(s) re-query an already-used referenceEntity across ${distinctReferenceEntities} distinct subject(s) — duplicate-image risk. Supply more distinct briefs (finer beats / shot-specific entities) to fill ${shots.length} slots.`,
    );
  }

  return {
    beats: beats.length,
    words: totalWords,
    estimatedDurationSec: Math.round(estimatedDurationSec),
    projectedShots: shots.length,
    projectedMovingShots,
    distinctReferenceEntities,
    repeatedEntityShots,
    unusedMotionPromptBeats,
    perBeat,
    notes,
  };
}
