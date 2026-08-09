import type { ProductionProfile, WordTimestamp } from "@ytauto/db";
import type { BeatType, DirectedShot, ShotMedium, ShotScale } from "./beats";

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
  /** #69 (append): the GENERATED-shot twin of `referenceEntities` — an ORDERED
   * list of per-shot image prompts consumed across the shots this beat is cut
   * into (shot i takes imagePrompts[i], falling back to the single `imagePrompt`).
   * A generated beat that fans into N shots can supply N DISTINCT prompts instead
   * of rendering one prompt N times (two takes of the same diagram read as an
   * error). Mirrors referenceEntities, but for shots that generate rather than
   * source. */
  imagePrompts?: (string | null)[];
  referenceEntity?: string | null;
  /** #69: an ORDERED list of real subjects consumed across the shots this beat
   * is cut into — shot i takes referenceEntities[i], falling back to the single
   * `referenceEntity` then null. Lets one beat supply N distinct briefs without
   * inflating the beat count (an artwork channel's whole visual identity). */
  referenceEntities?: (string | null)[];
  /** the scriptwriter's concrete visual ASK for this section (2026-07-12) —
   * a self-contained scene an image model can execute; narration never
   * belongs in a generation prompt (metaphors get literalized) */
  visualBrief?: string | null;
  /** one of the story's pivotal moments — routed to the hero image model */
  heroShot?: boolean;
  /** #72: render this beat as a typeset quote card instead of an image. */
  quoteCard?: { text: string; attribution?: string | null };
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
  /** the beat's visual ask (see BeatInput.visualBrief) */
  visualBrief: string | null;
  /** first shot of a hero beat — generate on the hero model tier */
  heroShot: boolean;
  /** #72: when set, this shot renders a typeset quote card, not an image. */
  quoteCard?: { text: string; attribution?: string | null } | null;
  startSec: number;
  endSec: number;
  // ── Visual Director fields (#37) — present only when the director cut this
  // shot; the mechanical planShots leaves them undefined. ──
  /** framing the director asked for */
  shotScale?: ShotScale | null;
  angle?: string | null;
  /** the medium the director chose (drives motion planning) */
  medium?: ShotMedium | null;
  motif?: string | null;
  /** one-line directorial intent — grounds the per-shot prompt articulation */
  intent?: string | null;
  /** the recurring character the director placed in this shot, by name, or null
   * (#37 Phase 2 — director casting authority) */
  character?: string | null;
};

/** A shot must run at least this long — avoids frantic sub-second cutting. */
export const MIN_SHOT_SEC = 2;
/** Never split one beat into more than this many shots (cost + pacing guard). */
export const MAX_SHOTS_PER_BEAT = 4;
/** A gap between words longer than this reads as a deliberate pause (seconds). */
export const PAUSE_GAP = 0.35;

const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

/**
 * #69: the referenceEntity for shot ordinal `i` within a beat — the i-th entry
 * of the beat's ordered `referenceEntities` list, falling back to its single
 * `referenceEntity`, then null. So a beat cut into N shots supplies N distinct
 * briefs when the list has them, without every shot re-querying one subject.
 */
function shotEntity(beat: Pick<BeatInput, "referenceEntity" | "referenceEntities">, i: number): string | null {
  const listed = beat.referenceEntities?.[i];
  const e = typeof listed === "string" ? listed.trim() : "";
  if (e) return e;
  return beat.referenceEntity ?? null;
}

/**
 * #69 (append): the image prompt for shot ordinal `i` within a beat — the i-th
 * entry of the beat's ordered `imagePrompts` list, falling back to the single
 * `imagePrompt`. So a generated beat cut into N shots renders N distinct prompts
 * when the list has them, instead of duplicating one prompt across sibling shots.
 */
function shotImagePrompt(beat: Pick<BeatInput, "imagePrompt" | "imagePrompts">, i: number): string {
  const listed = beat.imagePrompts?.[i];
  const p = typeof listed === "string" ? listed.trim() : "";
  return p || beat.imagePrompt;
}
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

/** Greedily group a beat's words into shots, honouring boundaries + min length.
 * When `maxShotSec` is set (animation on), a group is force-cut once it reaches
 * that length even without a rhythm boundary and even past the `maxShots` soft
 * cap — a shot longer than the i2v clip cap would freeze mid-clip, which is
 * worse than one extra image. */
function groupWords(
  words: WordTimestamp[],
  boundaries: Set<number>,
  maxShots: number,
  minShotSec: number,
  maxShotSec?: number,
): WordTimestamp[][] {
  if (words.length === 0) return [[]];
  const groups: WordTimestamp[][] = [];
  let cur: WordTimestamp[] = [];
  let curStart = words[0]!.startSec;
  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]!);
    const shotLen = words[i]!.endSec - curStart;
    const longEnough = shotLen >= minShotSec;
    const roomForMore = groups.length < maxShots - 1;
    const boundaryCut = boundaries.has(i) && longEnough && roomForMore;
    // hard cut: never let a shot exceed the clip cap (ignores the maxShots cap)
    const lengthCut = maxShotSec !== undefined && shotLen >= maxShotSec && longEnough;
    if ((boundaryCut || lengthCut) && i < words.length - 1) {
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
  opts: {
    rhythm: ShotRhythm;
    durationSec: number;
    maxShotsPerBeat?: number;
    /** min seconds per shot (2026-07-12 operator: long-form was over-cut at
     * 82 images/8min — a good image can hold the frame longer) */
    minShotSec?: number;
    /** max seconds per shot — set when the video animates so every shot fits
     * the i2v clip cap (2026-07-15: long "per section" shots never animated) */
    maxShotSec?: number;
  },
): Shot[] {
  const maxShots = Math.max(1, opts.maxShotsPerBeat ?? MAX_SHOTS_PER_BEAT);
  const minShotSec = Math.max(1, opts.minShotSec ?? MIN_SHOT_SEC);
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
    const groups = groupWords(beatWords, boundaries, maxShots, minShotSec, opts.maxShotSec);

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]!;
      const groupText = g.map((w) => w.word).join(" ").trim() || beat.text;
      shots.push({
        beatIndex: bi,
        type: beat.type,
        text: groupText,
        // 2026-07-12 fix ("horses pulling planes"): NARRATION NEVER enters the
        // generation prompt — FLUX literalizes every noun, so a metaphor in the
        // spoken sentence became the picture. The prompt is the beat's scene
        // idea; the shot's own sentence rides separately on `text` for the
        // prompt-builder's relevance context and the vision fit-scorer. #69: a
        // beat's ordered imagePrompts[] gives shot gi its own distinct prompt.
        imagePrompt: shotImagePrompt(beat, gi),
        // every shot may source a real photo of the beat's subject (was shot 0
        // only, which capped real imagery at one per beat); the vision fit
        // gate + archival dial reject wrong matches per shot. #69: when the beat
        // supplies an ordered referenceEntities list, shot gi takes the gi-th.
        referenceEntity: shotEntity(beat, gi),
        visualBrief: beat.visualBrief ?? null,
        // hero = the beat's pivotal moment — one hero image per hero beat
        heroShot: gi === 0 && !!beat.heroShot,
        // #72: a quote-card beat renders a typeset card for every shot it spans
        ...(beat.quoteCard ? { quoteCard: beat.quoteCard } : {}),
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

/**
 * Visual Director time-cut (#37, 2026-07-16): place a director-authored
 * `VisualSequence` onto the real clock. The director already decided WHERE the
 * cuts land (on meaning); here we map each directed shot's narration span to
 * word-timed start/end and carry its framing/medium/intent onto the Shot the
 * rest of the pipeline consumes. Deterministic.
 *
 * Fallback (#37 Phase 2): PER-BEAT. A beat the director didn't cover — or cut
 * into more shots than it has words — degrades to a single mechanical shot for
 * THAT beat only, so one bad beat never throws away the whole plan. A malformed
 * sequence (a shot pointing at a non-existent beat) still returns `null` so the
 * caller uses the mechanical `planShots` for the whole video.
 */
export function planShotsFromDirection(
  beats: BeatInput[],
  words: WordTimestamp[],
  sequence: DirectedShot[],
  opts: { durationSec: number; maxShotSec?: number },
): Shot[] | null {
  if (!sequence.length) return null;
  const byBeat = new Map<number, DirectedShot[]>();
  for (const d of sequence) {
    if (!Number.isInteger(d.beatIndex) || d.beatIndex < 0 || d.beatIndex >= beats.length) return null;
    const arr = byBeat.get(d.beatIndex);
    if (arr) arr.push(d);
    else byBeat.set(d.beatIndex, [d]);
  }

  const shots: Shot[] = [];
  let cursor = 0;
  let prevBeatEnd = 0;
  for (let bi = 0; bi < beats.length; bi++) {
    const beat = beats[bi]!;
    const wc = wordCount(beat.text);
    const beatWords = words.slice(cursor, cursor + wc);
    cursor += wc;
    const ds = byBeat.get(bi);

    const isLastBeat = bi === beats.length - 1;
    const beatStart = prevBeatEnd;
    const beatEnd = isLastBeat
      ? opts.durationSec
      : beatWords.length
        ? beatWords[beatWords.length - 1]!.endSec + 0.05
        : beatStart + 1;
    prevBeatEnd = beatEnd;

    // per-beat fallback: uncovered, or more shots than words → one mechanical
    // shot for this beat (no director fields, so it behaves like planShots)
    if (!ds?.length || beatWords.length < ds.length) {
      shots.push({
        beatIndex: bi,
        type: beat.type,
        text: beatWords.map((w) => w.word).join(" ").trim() || beat.text,
        imagePrompt: shotImagePrompt(beat, 0),
        referenceEntity: shotEntity(beat, 0),
        visualBrief: beat.visualBrief ?? null,
        heroShot: !!beat.heroShot,
        ...(beat.quoteCard ? { quoteCard: beat.quoteCard } : {}),
        startSec: beatStart,
        endSec: beatEnd,
      });
      continue;
    }

    // slice the beat's words into groups sized by each span's word count
    const weights = ds.map((d) => Math.max(1, wordCount(d.narrationSpan)));
    const sumW = weights.reduce((a, b) => a + b, 0);
    const L = beatWords.length;
    const sizes = weights.map((w) => Math.max(1, Math.round((L * w) / sumW)));
    let total = sizes.reduce((a, b) => a + b, 0);
    while (total > L) {
      let mi = -1;
      for (let k = 0; k < sizes.length; k++) if (sizes[k]! > 1 && (mi < 0 || sizes[k]! > sizes[mi]!)) mi = k;
      if (mi < 0) break;
      sizes[mi]!--;
      total--;
    }
    while (total < L) {
      let mi = 0;
      for (let k = 1; k < sizes.length; k++) if (sizes[k]! > sizes[mi]!) mi = k;
      sizes[mi]!++;
      total++;
    }

    let wi = 0;
    for (let j = 0; j < ds.length; j++) {
      const d = ds[j]!;
      const g = beatWords.slice(wi, wi + sizes[j]!);
      wi += sizes[j]!;
      shots.push({
        beatIndex: bi,
        type: beat.type,
        text: g.map((w) => w.word).join(" ").trim() || d.narrationSpan || beat.text,
        // the director's SUBJECT seeds the prompt; narration still drives the
        // literal subject downstream via `text`. #69: else the beat's per-shot
        // imagePrompts[j] (falling back to the single imagePrompt).
        imagePrompt: d.subject || shotImagePrompt(beat, j),
        // real-footage shots source a photo of the subject; others keep the
        // beat's reference entity (or none). #69: index the beat's ordered
        // referenceEntities by this shot's ordinal `j` within the beat.
        referenceEntity:
          d.medium === "real_footage" ? (shotEntity(beat, j) ?? d.subject ?? null) : shotEntity(beat, j),
        // the fallback prompt (when the builder is unavailable) must be a VISUAL
        // (the subject), NOT the directorial intent note — else a builder hiccup
        // renders "Comic beat — scientists giving up" literally (2026-07-16). The
        // director's intent still reaches the builder via the separate `intent`.
        visualBrief: d.subject || beat.visualBrief || null,
        heroShot: !!d.hero,
        ...(beat.quoteCard ? { quoteCard: beat.quoteCard } : {}),
        startSec: beatStart,
        endSec: Math.min(g.length ? g[g.length - 1]!.endSec + 0.05 : beatEnd, beatEnd),
        shotScale: d.shotScale,
        angle: d.angle ?? null,
        medium: d.medium,
        motif: d.motif ?? null,
        intent: d.intent ?? null,
        character: d.character ?? null,
      });
    }
    if (shots.length) shots[shots.length - 1]!.endSec = beatEnd;
  }

  // tile contiguously (same final pass as planShots)
  for (let i = 0; i < shots.length; i++) {
    shots[i]!.startSec = i === 0 ? 0 : shots[i - 1]!.endSec;
    if (shots[i]!.endSec < shots[i]!.startSec) shots[i]!.endSec = shots[i]!.startSec;
    shots[i]!.endSec = Math.min(shots[i]!.endSec, opts.durationSec);
  }
  // a "motion" shot longer than the clip cap can't be a full clip — keep its
  // still rather than let it freeze mid-clip (matches planShots' length guard)
  if (opts.maxShotSec !== undefined) {
    for (const s of shots) if (s.medium === "motion" && s.endSec - s.startSec > opts.maxShotSec) s.medium = "still";
  }
  return shots;
}

/**
 * The single source of truth for planShots options, so the render, the
 * after-the-fact Animate path, and the cockpit estimate all compute IDENTICAL
 * shot boundaries (a mismatch would write clip-<idx> onto the wrong beat).
 * When the video animates (motion !== "static") every shot is capped just under
 * the i2v clip cap so it can be turned into a moving clip end-to-end; static
 * videos keep the "fewest images / a still can hold the frame" behaviour.
 */
export function shotPlanOptions(
  profile: Pick<ProductionProfile, "rhythm" | "motion" | "imageDensity" | "minSecondsPerShot">,
  o: { isLong: boolean; durationSec: number; maxClipSec: number },
): {
  rhythm: ShotRhythm;
  durationSec: number;
  maxShotsPerBeat?: number;
  minShotSec?: number;
  maxShotSec?: number;
} {
  // image density (2026-07-16): a finer frequency dial ON TOP of rhythm.
  // "standard" reproduces the previous behaviour EXACTLY; "relaxed" holds each
  // still longer + caps splits (fewer images); "busy" cuts more often.
  const density = profile.imageDensity ?? "standard";
  const maxShotSec = profile.motion !== "static" ? Math.max(2, o.maxClipSec - 1) : undefined;
  // long-form still floor (7s baseline) scaled by density; short-form only gets
  // a floor under "relaxed" (otherwise MIN_SHOT_SEC applies as before)
  const longFloor = 7 * (density === "relaxed" ? 1.6 : density === "busy" ? 0.7 : 1);
  const shortFloor = density === "relaxed" ? 4.5 : undefined;
  // #73: an explicit numeric floor overrides the density tier entirely — a
  // contemplative still-image channel wants ~20-25s holds that the tiers (max
  // ~11s on relaxed) can't reach. Fewer, longer shots for the same runtime.
  const explicitFloor =
    typeof profile.minSecondsPerShot === "number" && profile.minSecondsPerShot > 0
      ? profile.minSecondsPerShot
      : undefined;
  let minShotSec = explicitFloor ?? (o.isLong ? longFloor : shortFloor);
  // when animating, don't let the floor exceed the clip cap or a shot couldn't
  // fit a clip end-to-end
  if (minShotSec !== undefined && maxShotSec !== undefined) minShotSec = Math.min(minShotSec, maxShotSec);
  // splits per beat: long-form was 3; relaxed trims to 2, busy loosens to 4.
  // short-form was uncapped (MAX_SHOTS_PER_BEAT=4); only relaxed caps it to 2.
  //
  // #105: an explicit `minSecondsPerShot` overrides the density tier ENTIRELY
  // (#73's stated intent) — including its per-beat cap, not just its floor.
  // Previously the floor was overridden but the cap survived, so a channel-level
  // `relaxed` (correct for a 20-minute documentary) silently held a 2-minute
  // Short to 2 shots/beat — 14 shots where the operator's explicit 6s floor
  // implied ~23, and half their authored per-shot prompts went unused. Scoped to
  // SHORT-FORM: a long-form channel's cap is the cost guard the tier is for, and
  // loosening it unattended would raise image spend on live channels.
  const explicitFloorGovernsCap = !o.isLong && explicitFloor !== undefined;
  const maxShotsPerBeat = o.isLong
    ? density === "relaxed"
      ? 2
      : density === "busy"
        ? 4
        : 3
    : density === "relaxed" && !explicitFloorGovernsCap
      ? 2
      : undefined;
  return {
    rhythm: profile.rhythm,
    durationSec: o.durationSec,
    ...(maxShotsPerBeat !== undefined ? { maxShotsPerBeat } : {}),
    ...(minShotSec !== undefined ? { minShotSec } : {}),
    ...(maxShotSec !== undefined ? { maxShotSec } : {}),
  };
}

/**
 * #105: WHICH constraint actually decided the shot count.
 *
 * Four things can bind — the per-beat cap from `imageDensity`, the
 * `minSecondsPerShot` floor, the i2v clip cap when animating, and simply having
 * few beats — and only one of them wins. The operator hit the density cap on a
 * 2-minute Short: `relaxed` caps short-form to 2 shots/beat, so 8 beats gave ~14
 * shots while their explicit 6s floor implied ~23. Nothing said so, and 13 of
 * their 27 authored per-shot prompts would have been discarded in silence.
 *
 * The platform already warns about the equivalent case (a floor going inert
 * under animating motion). This is the same class, previously unreported.
 *
 * Pure: it compares what each constraint ALONE would have allowed against what
 * was actually planned, so it stays honest if the planner changes.
 */
export type ShotConstraint =
  | "imageDensity per-beat cap"
  | "minSecondsPerShot"
  | "i2v clip cap"
  | "beat count";

export function bindingShotConstraint(input: {
  /** shots the planner actually produced */
  projectedShots: number;
  beats: number;
  durationSec: number;
  /** resolved options the planner ran with */
  maxShotsPerBeat?: number;
  minShotSec?: number;
  maxShotSec?: number;
  /** true when the floor was clamped down to the clip cap (animating) */
  clampedByClipCap?: boolean;
}): { constraint: ShotConstraint; shotsIfFloorOnly: number | null; note: string | null } {
  const { projectedShots, beats, durationSec } = input;
  // what the seconds floor alone would allow across the whole runtime
  const shotsIfFloorOnly =
    input.minShotSec && input.minShotSec > 0 ? Math.floor(durationSec / input.minShotSec) : null;
  // what the per-beat cap alone would allow
  const capCeiling = input.maxShotsPerBeat != null ? beats * input.maxShotsPerBeat : null;

  // The planner allocates per beat, so a binding cap is rarely saturated to the
  // exact ceiling (7 beats can want 3 shots and get 2, twice over). Detecting
  // "the cap bound" therefore can't mean "projected === capCeiling" — it means
  // the cap was the TIGHTER of the two ceilings while more than one shot per
  // beat was actually in play.
  let constraint: ShotConstraint;
  if (input.clampedByClipCap) {
    constraint = "i2v clip cap";
  } else if (capCeiling != null && projectedShots >= capCeiling) {
    constraint = "imageDensity per-beat cap";
  } else if (
    capCeiling != null &&
    projectedShots > beats &&
    (shotsIfFloorOnly == null || capCeiling < shotsIfFloorOnly)
  ) {
    constraint = "imageDensity per-beat cap";
  } else if (shotsIfFloorOnly != null && projectedShots >= shotsIfFloorOnly) {
    constraint = "minSecondsPerShot";
  } else {
    constraint = "beat count";
  }

  // #108: the remedy is DERIVED from the constraint — each binding knob names
  // itself and says which knobs will NOT move the number. Only worth a note when
  // the constraint cost the operator materially (a fifth or more of what the
  // floor alone would have given); the floor binding stays quiet — lowering the
  // floor is the obvious remedy and it actually works.
  let note: string | null = null;
  const materiallyBelowFloorOnly = shotsIfFloorOnly != null && shotsIfFloorOnly > projectedShots * 1.2;
  if (constraint === "imageDensity per-beat cap" && materiallyBelowFloorOnly) {
    note =
      `imageDensity's per-beat cap (${input.maxShotsPerBeat} shot(s) per beat over ${beats} beats) is the BINDING constraint, not minSecondsPerShot. ` +
      `The ${input.minShotSec}s floor alone would allow ~${shotsIfFloorOnly} shots across ${Math.round(durationSec)}s, but the cap holds it to ${projectedShots}. ` +
      `To cut more often set imageDensity 'busy' (or 'standard'); lowering minSecondsPerShot alone will NOT raise the count.`;
  } else if (constraint === "beat count" && materiallyBelowFloorOnly && projectedShots <= beats) {
    // "beat count" is also the fallback bucket when sentence grouping lands
    // between the ceilings — only claim beats are the knob when the plan really
    // sits at ~one shot per beat.
    note =
      `beat count (${beats}) is the BINDING constraint — the plan stays near one shot per beat. ` +
      `The ${input.minShotSec}s floor alone would allow ~${shotsIfFloorOnly} shots across ${Math.round(durationSec)}s. ` +
      `Add beats to cut more often; changing minSecondsPerShot or imageDensity will NOT raise the count.`;
  } else if (constraint === "i2v clip cap") {
    note =
      `the i2v clip cap (~${input.maxShotSec}s) is the BINDING constraint — animating shots are force-cut at the cap, so the count tracks runtime ÷ cap` +
      (input.clampedByClipCap && input.minShotSec != null
        ? `, and the ${input.minShotSec}s minSecondsPerShot floor was clamped down to it (a floor above the cap is inert while motion is on)`
        : "") +
      `. Changing minSecondsPerShot or imageDensity will NOT move it; set motion 'static'/'partial' for longer holds.`;
  }
  return { constraint, shotsIfFloorOnly, note };
}
