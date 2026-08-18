import { describe, expect, it } from "vitest";
import type { WordTimestamp } from "@ytauto/db";
import {
  DEFAULT_MAX_SHOT_HOLD_SEC,
  planShots,
  shotPlanOptions,
  type BeatInput,
} from "../src/shots";
import { projectShotPlan } from "../src/shot-projection";
import { resolveProductionProfile } from "../src/production-profile";
import { splitNarrationSegments } from "../src/narration-segments";

// ── #130 ─────────────────────────────────────────────────────────────────────
// Production 01KZZPGB80J21ZMBFPWDBE4BT9: 17 beats, 106 recorded segments,
// imageDensity 'busy', 50 shots, 766s. The totals are fine (one image per two
// segments); the DISTRIBUTION is the defect — the per-beat cap stops cutting and
// the last shot of a long beat absorbs its remainder (~300 words ≈ 90s on one
// still) while a one-sentence rehook beat gets a whole shot to itself.

/** A sentence of `n` words, terminal-punctuated so the segment splitter sees it. */
const sentence = (n: number, seed: string) =>
  Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ") + ".";

/** A beat of `sentences` × 12 words — the long-beat shape from the ticket. */
const beat = (sentences: number, seed: string): BeatInput => ({
  type: "insight",
  text: Array.from({ length: sentences }, (_, i) => sentence(12, `${seed}${i}w`)).join(" "),
  imagePrompt: `prompt ${seed}`,
});

/** Evenly-spaced word timings at 2.5 w/s — the platform narration rate. */
function timings(beats: BeatInput[]): { words: WordTimestamp[]; durationSec: number } {
  const per = 1 / 2.5;
  const words: WordTimestamp[] = [];
  let t = 0;
  for (const b of beats) {
    for (const w of b.text.split(/\s+/).filter(Boolean)) {
      words.push({ word: w, startSec: t, endSec: t + per });
      t += per;
    }
  }
  return { words, durationSec: t };
}

const longest = (shots: { startSec: number; endSec: number }[]) =>
  Math.max(...shots.map((s) => s.endSec - s.startSec));

// The reported script's shape: rehook beats of one sentence next to habit beats
// of ~30 sentences (~380 words).
const SCRIPT: BeatInput[] = [
  beat(1, "hook"),
  beat(30, "habitsThreeFour"),
  beat(1, "rehook"),
  beat(26, "habitsFiveSix"),
  beat(1, "cta"),
];

describe("#130 — the defect: a per-beat cap makes the last shot absorb the beat", () => {
  it("holds one still for well over a minute on the reported shape", () => {
    const { words, durationSec } = timings(SCRIPT);
    const profile = resolveProductionProfile({ imageDensity: "busy", rhythm: "sentence", motion: "static" });
    const shots = planShots(SCRIPT, words, shotPlanOptions(profile, { isLong: true, durationSec, maxClipSec: 10 }));
    // 'busy' caps long-form at 4 shots per beat, so a 30-sentence beat gets 4 —
    // and the fourth carries everything the cap stopped cutting.
    expect(shots.filter((s) => s.beatIndex === 1)).toHaveLength(4);
    expect(longest(shots)).toBeGreaterThan(60);
  });

  it("gives a one-sentence rehook beat a whole shot while a 30-sentence beat gets four", () => {
    const { words, durationSec } = timings(SCRIPT);
    const profile = resolveProductionProfile({ imageDensity: "busy", rhythm: "sentence", motion: "static" });
    const shots = planShots(SCRIPT, words, shotPlanOptions(profile, { isLong: true, durationSec, maxClipSec: 10 }));
    expect(shots.filter((s) => s.beatIndex === 2)).toHaveLength(1); // rehook
    expect(shots.filter((s) => s.beatIndex === 1)).toHaveLength(4); // 30 sentences
  });
});

describe("#130 — rhythm 'segment': cut on what the operator recorded", () => {
  const profile = resolveProductionProfile({
    imageDensity: "busy",
    rhythm: "segment",
    motion: "static",
    minSecondsPerShot: 3,
  });

  it("no shot holds longer than the ceiling the rhythm brings with it", () => {
    const { words, durationSec } = timings(SCRIPT);
    const shots = planShots(SCRIPT, words, shotPlanOptions(profile, { isLong: true, durationSec, maxClipSec: 10 }));
    expect(longest(shots)).toBeLessThanOrEqual(DEFAULT_MAX_SHOT_HOLD_SEC + 0.5);
  });

  it("allocates per recorded segment, so a long beat is no longer capped at four", () => {
    const { words, durationSec } = timings(SCRIPT);
    const shots = planShots(SCRIPT, words, shotPlanOptions(profile, { isLong: true, durationSec, maxClipSec: 10 }));
    const segs = splitNarrationSegments(SCRIPT[1]!.text).length;
    const beatShots = shots.filter((s) => s.beatIndex === 1).length;
    expect(beatShots).toBeGreaterThan(4); // the cap no longer binds
    // ~one shot per two segments (the operator's "an image to each or two"),
    // give or take the seconds floor merging very short segments
    expect(beatShots).toBeLessThanOrEqual(Math.ceil(segs / 2) + 1);
  });

  it("honours segmentsPerShot — 1 gives roughly one image per recorded take", () => {
    const { words, durationSec } = timings(SCRIPT);
    const perTwo = planShots(
      SCRIPT,
      words,
      shotPlanOptions(profile, { isLong: true, durationSec, maxClipSec: 10 }),
    ).length;
    const perOne = planShots(
      SCRIPT,
      words,
      shotPlanOptions(
        resolveProductionProfile({ ...profile, segmentsPerShot: 1 }),
        { isLong: true, durationSec, maxClipSec: 10 },
      ),
    ).length;
    expect(perOne).toBeGreaterThan(perTwo);
  });

  it("does NOT require more beats — the same beats yield more, evenly-spread shots", () => {
    const { words, durationSec } = timings(SCRIPT);
    const before = planShots(
      SCRIPT,
      words,
      shotPlanOptions(
        resolveProductionProfile({ imageDensity: "busy", rhythm: "sentence", motion: "static" }),
        { isLong: true, durationSec, maxClipSec: 10 },
      ),
    );
    const after = planShots(SCRIPT, words, shotPlanOptions(profile, { isLong: true, durationSec, maxClipSec: 10 }));
    expect(after.length).toBeGreaterThan(before.length);
    expect(longest(after)).toBeLessThan(longest(before) / 2);
    // beat count is untouched — no beat rewrite, so no re-record
    expect(new Set(after.map((s) => s.beatIndex)).size).toBe(SCRIPT.length);
  });
});

describe("#130 — the hold ceiling", () => {
  it("forces a cut on a beat-based rhythm too, past the per-beat cap", () => {
    const { words, durationSec } = timings(SCRIPT);
    const capped = resolveProductionProfile({
      imageDensity: "busy",
      rhythm: "sentence",
      motion: "static",
      maxShotHoldSec: 20,
    });
    const shots = planShots(SCRIPT, words, shotPlanOptions(capped, { isLong: true, durationSec, maxClipSec: 10 }));
    expect(longest(shots)).toBeLessThanOrEqual(20.5);
    expect(shots.filter((s) => s.beatIndex === 1).length).toBeGreaterThan(4);
  });

  it("is OFF by default — an unconfigured channel plans exactly as it did before #130", () => {
    const { words, durationSec } = timings(SCRIPT);
    const before = resolveProductionProfile({ imageDensity: "busy", rhythm: "sentence", motion: "static" });
    const opts = shotPlanOptions(before, { isLong: true, durationSec, maxClipSec: 10 });
    expect(opts.maxShotSec).toBeUndefined(); // no ceiling on a static video
    expect(opts.segmentsPerShot).toBeUndefined();
    expect(longest(planShots(SCRIPT, words, opts))).toBeGreaterThan(60);
  });

  it("never lets the floor exceed the ceiling (or the ceiling would silently do nothing)", () => {
    const p = resolveProductionProfile({
      rhythm: "sentence",
      motion: "static",
      minSecondsPerShot: 40,
      maxShotHoldSec: 15,
    });
    const opts = shotPlanOptions(p, { isLong: true, durationSec: 600, maxClipSec: 10 });
    expect(opts.minShotSec).toBeLessThanOrEqual(opts.maxShotSec!);
  });
});

describe("#130 — the warning lands at authoring time, before spend", () => {
  it("names the over-long shot and its duration in shotPlan.notes", () => {
    const projection = projectShotPlan(
      SCRIPT,
      resolveProductionProfile({ imageDensity: "busy", rhythm: "sentence", motion: "static" }),
      { isLong: true },
    );
    expect(projection.longestHoldSec).toBeGreaterThan(60);
    expect(projection.longHoldShots.length).toBeGreaterThan(0);
    const note = projection.notes.find((n) => n.includes("hold longer than"));
    expect(note).toBeTruthy();
    expect(note).toContain("shot ");
    expect(note).toContain("rhythm 'segment'"); // names the remedy that keeps the takes
  });

  it("goes quiet once the plan is bounded", () => {
    const projection = projectShotPlan(
      SCRIPT,
      resolveProductionProfile({
        imageDensity: "busy",
        rhythm: "segment",
        motion: "static",
        minSecondsPerShot: 3,
      }),
      { isLong: true },
    );
    expect(projection.longHoldShots).toEqual([]);
    expect(projection.notes.some((n) => n.includes("hold longer than"))).toBe(false);
  });
});
