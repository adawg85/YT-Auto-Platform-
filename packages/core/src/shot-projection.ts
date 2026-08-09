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
import { bindingShotConstraint, planShots, shotPlanOptions, type BeatInput } from "./shots";
import { planMotion } from "./motion";
import { WORDS_PER_SEC } from "./beat-map";
import { minSecondsPerShotOverrideWarning } from "./production-profile";

/** Default i2v clip cap when the caller can't read VIDEO_MAX_CLIP_SEC (env-only). */
export const DEFAULT_MAX_CLIP_SEC = 10;

export type ProjectionBeat = {
  beatIndex: number;
  words: number;
  /** shots this beat is projected to be cut into */
  shots: number;
  /** #106: authored imagePrompts this beat supplies (0 when none authored) —
   * compare against `shots` to see the per-beat surplus/shortfall directly */
  promptsSupplied: number;
  heroShot: boolean;
  hasMotionPrompt: boolean;
  /** at least one of this beat's shots is eligible to move */
  willMove: boolean;
};

export type ShotProjection = {
  beats: number;
  words: number;
  /** runtime this script projects to; echoes targetLengthSec when one is supplied,
   * else the word-based estimate. (#81: prefer `wordBasedDurationSec` to reason
   * about THIS script's actual length.) */
  estimatedDurationSec: number;
  /** #81: runtime derived from this script's OWN word count at the platform rate,
   * independent of any channel target — the honest length of what was written. */
  wordBasedDurationSec: number;
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
  /** #105: which constraint decided projectedShots */
  bindingConstraint: "imageDensity per-beat cap" | "minSecondsPerShot" | "i2v clip cap" | "beat count";
  /** #105: what the seconds floor ALONE would have allowed, when one is set */
  shotsIfFloorOnly: number | null;
  /** #116: the seconds the plan (and shotsIfFloorOnly) were computed over —
   * ALWAYS the word-derived runtime of this script (#105-reopen rule), stated
   * explicitly so this number reconciles with review_beat_map's estimate,
   * which may have used the map's declared targetLengthSec instead. */
  durationBasisSec: number;
  durationBasis: "narrationWords";
  notes: string[];
};

type ProjectionBeatInput = BeatInput & {
  motionPrompt?: string | null;
  animates?: boolean;
  /** #105: per-shot authored prompts (#69) — counted so a supplied-vs-cut mismatch is reported */
  imagePrompts?: (string | null)[] | null;
};

const wordsOf = (t: string) => t.split(/\s+/).filter(Boolean);

/**
 * Project the shot + motion plan for a set of authored beats under a profile.
 * Deterministic and LLM-free — safe to call at author time or in a read tool.
 */
export function projectShotPlan(
  beats: ProjectionBeatInput[],
  profile: Pick<ProductionProfile, "rhythm" | "motion" | "imageDensity" | "minSecondsPerShot" | "visualMode" | "maxAiClips">,
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
  // #81: the runtime this SCRIPT projects to at the platform narration rate,
  // always derived from its own word count (never the channel target). When a
  // targetLengthSec is supplied, `estimatedDurationSec` echoes the TARGET — which
  // is what review_beat_map's padded/crammed advisories and the lengthPolicy floor
  // are scored against — so a script that is written well under (or over) its
  // target is silently mis-scoped. Exposing both, plus a divergence note, makes
  // the gap visible (the reported case: 1,838 words ≈ 735s at 2.5 w/s vs a 1,380s
  // channel target — the "estimate" tracked the target, not the script).
  const wordBasedDurationSec = Math.max(1, totalWords * perWordSec);
  const estimatedDurationSec =
    opts.targetLengthSec && opts.targetLengthSec > 0 ? opts.targetLengthSec : wordBasedDurationSec;

  // #105 (reopen): plan against THIS SCRIPT'S OWN runtime, never the channel
  // target echo. The pipeline plans against `voiceover.durationSec` — the real
  // audio — and the closest honest stand-in before spend is the word-based
  // estimate. Passing `estimatedDurationSec` meant a 140s Short on a channel
  // whose targetLengthSec is 1200 was planned as if it ran 1200s: the last shot
  // was given a 1,060-second tail, and `shotsIfFloorOnly` reported 240 (1200÷5)
  // where the true headroom is ~28 (140÷5) — an order of magnitude off, pointing
  // at the wrong remedy. `estimatedDurationSec` stays a REPORTED field only.
  const planDurationSec = wordBasedDurationSec;
  const spo = shotPlanOptions(profile, { isLong: opts.isLong, durationSec: planDurationSec, maxClipSec });
  const shots = planShots(beats, words, spo);
  // Mark shots whose beat carries an authored motionPrompt so the projection
  // reflects ai_video's author-preferred, evenly-distributed selection (01KY3HWK…).
  const motion = planMotion(
    shots.map((s) => ({
      ...s,
      preferMotion: Boolean(beats[s.beatIndex]?.motionPrompt?.trim()) || Boolean(beats[s.beatIndex]?.animates),
    })),
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

  const beatPromptCount = (b: ProjectionBeatInput): number =>
    Array.isArray(b.imagePrompts) ? b.imagePrompts.filter((p) => (p ?? "").trim()).length : 0;

  const perBeat: ProjectionBeat[] = beats.map((b, bi) => ({
    beatIndex: bi,
    words: wordsOf(b.text).length,
    shots: shotsByBeat.get(bi) ?? 0,
    promptsSupplied: beatPromptCount(b),
    heroShot: !!b.heroShot,
    hasMotionPrompt: !!b.motionPrompt?.trim(),
    willMove: moveByBeat.get(bi) ?? false,
  }));

  const unusedMotionPromptBeats = perBeat.filter((p) => p.hasMotionPrompt && !p.willMove).map((p) => p.beatIndex);
  const projectedMovingShots = motion.filter((m) => m.mode !== "none").length;

  const notes: string[] = [];
  // #105: name WHICH constraint decided the count. The operator hit the density
  // per-beat cap on a Short and had to reverse-engineer it from 8 x 2 = 14.
  const binding = bindingShotConstraint({
    projectedShots: shots.length,
    beats: beats.length,
    durationSec: planDurationSec,
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
  if (binding.note) notes.push(binding.note);
  // #105: authored per-shot prompts are the expensive part of the operator's
  // work — 27 supplied against 14 shots means 13 silently discarded. Say so.
  const authoredPromptCount = beats.reduce((n, b) => n + beatPromptCount(b), 0);
  if (authoredPromptCount > shots.length) {
    notes.push(
      `${authoredPromptCount} authored imagePrompts supplied but only ${shots.length} shots will be cut — ${authoredPromptCount - shots.length} will go UNUSED. ` +
        `Shots are the limit, not prompts: raise the shot count (imageDensity 'busy' / a lower minSecondsPerShot / more beats) or trim the prompt list to match.`,
    );
  }
  // #106: the OTHER direction is the dangerous one and was silent. A beat
  // supplying fewer imagePrompts than its shot count means the uncovered shots
  // fall back to the beat's single `imagePrompt` (shots.ts shotImagePrompt) —
  // and on an authored production the prompt-builder is skipped, so that
  // fallback renders VERBATIM: near-identical images inside one beat. Per beat,
  // by name, because the total can balance while individual beats are short.
  const underSupplied = perBeat.filter((p) => p.promptsSupplied > 0 && p.promptsSupplied < p.shots);
  for (const p of underSupplied) {
    notes.push(
      `beat ${p.beatIndex} supplies ${p.promptsSupplied} imagePrompt(s) but will be cut into ${p.shots} shots — ` +
        `shot(s) ${p.promptsSupplied + 1}-${p.shots} fall back to the beat's single imagePrompt and will likely render near-identical images. ` +
        `Supply ${p.shots} prompts for the beat (see perBeat[].shots), or accept the repeat deliberately.`,
    );
  }
  if (profile.rhythm === "pause") {
    notes.push("rhythm is 'pause' — shots cut on real audio gaps, so this projected count is a lower bound.");
  }
  // #69 (append): a minSecondsPerShot floor above the clip cap is inert while
  // motion animates — say so here instead of the generic "raise minSecondsPerShot".
  const floorOverride = minSecondsPerShotOverrideWarning(profile, maxClipSec);
  if (floorOverride) notes.push(floorOverride);
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
  // #81: when the reported runtime is the channel TARGET, warn if the script's own
  // projected length diverges from it by >25% — the operator is scoping against a
  // number the script doesn't hit (padded/crammed advisories + the length floor are
  // all scored against estimatedDurationSec).
  if (opts.targetLengthSec && opts.targetLengthSec > 0) {
    const target = opts.targetLengthSec;
    const ratio = wordBasedDurationSec / target;
    if (ratio < 0.75 || ratio > 1.25) {
      const dir = ratio < 1 ? "UNDER" : "OVER";
      notes.push(
        `estimatedDurationSec (${Math.round(target)}s) is the channel TARGET, but this script's ${totalWords} words project to ~${Math.round(wordBasedDurationSec)}s at ${WORDS_PER_SEC} w/s — ${Math.round(Math.abs(1 - ratio) * 100)}% ${dir} target. review_beat_map advisories and the length floor score against the target, so the script is mis-scoped; add/cut words or adjust targetLengthSec.`,
      );
    }
  }

  return {
    beats: beats.length,
    words: totalWords,
    estimatedDurationSec: Math.round(estimatedDurationSec),
    wordBasedDurationSec: Math.round(wordBasedDurationSec),
    projectedShots: shots.length,
    projectedMovingShots,
    distinctReferenceEntities,
    repeatedEntityShots,
    unusedMotionPromptBeats,
    perBeat,
    // #105: which of the four constraints actually decided projectedShots, and
    // what the seconds floor alone would have allowed — so the number is
    // explainable without reverse-engineering it.
    bindingConstraint: binding.constraint,
    shotsIfFloorOnly: binding.shotsIfFloorOnly,
    // #116: the basis stated outright, so the two surfaces reconcile.
    durationBasisSec: Math.round(planDurationSec * 10) / 10,
    durationBasis: "narrationWords",
    notes,
  };
}
