import { describe, expect, it } from "vitest";
import { planShots, planShotsFromDirection, shotPlanOptions, type BeatInput } from "../src/shots";
import type { DirectedShot } from "../src/beats";
import type { WordTimestamp } from "@ytauto/db";

/** Evenly-spaced words, `sec` apart, starting at `start`. */
function words(text: string, start: number, sec = 0.4): WordTimestamp[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => ({ word, startSec: start + i * sec, endSec: start + i * sec + sec * 0.8 }));
}

describe("planShots", () => {
  it("section rhythm keeps one shot per beat (today's behaviour)", () => {
    const beats: BeatInput[] = [
      { type: "hook", text: "one two three four five", imagePrompt: "A" },
      { type: "cta", text: "six seven eight", imagePrompt: "B" },
    ];
    const w = [...words("one two three four five", 0), ...words("six seven eight", 2.2)];
    const shots = planShots(beats, w, { rhythm: "section", durationSec: 4 });
    expect(shots).toHaveLength(2);
    expect(shots[0]!.imagePrompt).toBe("A");
    expect(shots.map((s) => s.beatIndex)).toEqual([0, 1]);
  });

  it("sentence rhythm splits a multi-sentence beat into multiple shots", () => {
    // one long beat, two sentences, each ~2.4s so both clear MIN_SHOT_SEC
    const text = "The Spitfire climbed fast and high. Its engine roared over the channel.";
    const beats: BeatInput[] = [{ type: "insight", text, imagePrompt: "aircraft", referenceEntity: "Supermarine Spitfire" }];
    const w = words(text, 0, 0.4);
    const shots = planShots(beats, w, { rhythm: "sentence", durationSec: w[w.length - 1]!.endSec + 0.1 });
    expect(shots.length).toBeGreaterThanOrEqual(2);
    // 2026-07-12: EVERY shot of the beat may source the beat's real subject
    // (shot-0-only capped real imagery at one per beat) — the vision fit gate
    // rejects wrong matches per shot.
    expect(shots[0]!.referenceEntity).toBe("Supermarine Spitfire");
    expect(shots[1]!.referenceEntity).toBe("Supermarine Spitfire");
    expect(shots[0]!.imagePrompt).toBe("aircraft");
  });

  it("narration NEVER enters the generation prompt (2026-07-12 'horses pulling planes' fix)", () => {
    const text = "The gauge read empty over the Atlantic. The needle had simply failed mid-flight.";
    const beats: BeatInput[] = [{ type: "insight", text, imagePrompt: "vintage cockpit, moody light" }];
    const w = words(text, 0, 0.4);
    const shots = planShots(beats, w, { rhythm: "sentence", durationSec: w[w.length - 1]!.endSec + 0.1 });
    expect(shots.length).toBe(2);
    // every shot keeps the beat's SCENE prompt; the spoken sentence rides on
    // `text` only (prompt-builder context + fit scoring), never in the prompt
    // — FLUX literalizes narration metaphors when they leak in.
    for (const s of shots) expect(s.imagePrompt).toBe("vintage cockpit, moody light");
    expect(shots[1]!.text).toContain("needle");
  });

  it("passes visualBrief through and flags hero on the beat's first shot only", () => {
    const text = "First sentence runs long enough here. Second sentence also runs long enough.";
    const beats: BeatInput[] = [
      { type: "hook", text, imagePrompt: "scene", visualBrief: "1936 drafting office, drawing board close-up", heroShot: true },
    ];
    const w = words(text, 0, 0.4);
    const shots = planShots(beats, w, { rhythm: "sentence", durationSec: w[w.length - 1]!.endSec + 0.1 });
    expect(shots.length).toBe(2);
    expect(shots[0]!.visualBrief).toBe("1936 drafting office, drawing board close-up");
    expect(shots[1]!.visualBrief).toBe("1936 drafting office, drawing board close-up");
    expect(shots[0]!.heroShot).toBe(true);
    expect(shots[1]!.heroShot).toBe(false); // one hero image per hero beat
  });

  it("minShotSec raises the floor: long-form grouping yields fewer, longer shots", () => {
    const text =
      "Alpha bravo charlie delta echo. Foxtrot golf hotel india juliet. Kilo lima mike november oscar. Papa quebec romeo sierra tango.";
    const beats: BeatInput[] = [{ type: "insight", text, imagePrompt: "scene" }];
    const w = words(text, 0, 0.5); // 20 words ≈ 10s of narration
    const fine = planShots(beats, w, { rhythm: "sentence", durationSec: 10.2 });
    const coarse = planShots(beats, w, { rhythm: "sentence", durationSec: 10.2, minShotSec: 7 });
    expect(coarse.length).toBeLessThan(fine.length);
  });

  it("shots tile the timeline with no gaps and end at durationSec", () => {
    const beats: BeatInput[] = [
      { type: "hook", text: "alpha bravo charlie delta. echo foxtrot golf hotel.", imagePrompt: "A" },
      { type: "cta", text: "india juliet kilo", imagePrompt: "B" },
    ];
    const w = [
      ...words("alpha bravo charlie delta echo foxtrot golf hotel", 0),
      ...words("india juliet kilo", 3.6),
    ];
    const dur = 6;
    const shots = planShots(beats, w, { rhythm: "sentence", durationSec: dur });
    expect(shots[0]!.startSec).toBe(0);
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i]!.startSec).toBe(shots[i - 1]!.endSec); // contiguous
    }
    expect(shots[shots.length - 1]!.endSec).toBe(dur); // last shot runs to the end
  });

  it("caps shots per beat and respects the minimum shot length", () => {
    // 6 short sentences but a tiny cap → at most maxShotsPerBeat shots
    const text = "a b. c d. e f. g h. i j. k l.";
    const beats: BeatInput[] = [{ type: "insight", text, imagePrompt: "X" }];
    const w = words(text.replace(/\./g, ""), 0, 0.5);
    const shots = planShots(beats, w, { rhythm: "sentence", durationSec: 8, maxShotsPerBeat: 2 });
    expect(shots.length).toBeLessThanOrEqual(2);
    // every shot is at least MIN_SHOT_SEC long (except possibly the last, clamped to duration)
    for (const s of shots.slice(0, -1)) {
      expect(s.endSec - s.startSec).toBeGreaterThanOrEqual(2 - 1e-9);
    }
  });

  it("pause rhythm cuts on a long word gap", () => {
    const beats: BeatInput[] = [{ type: "hook", text: "one two three four five six", imagePrompt: "A" }];
    // first segment ~2.5s (clears MIN_SHOT_SEC), then a big gap before word 4
    const w = words("one two three", 0, 0.9).concat(words("four five six", 5, 0.9));
    const dur = w[w.length - 1]!.endSec + 0.1;
    const shots = planShots(beats, w, { rhythm: "pause", durationSec: dur });
    expect(shots.length).toBe(2);
    expect(shots[0]!.text).toContain("three");
    expect(shots[1]!.text).toContain("four");
  });

  it("is deterministic (same inputs → identical shots)", () => {
    const beats: BeatInput[] = [{ type: "insight", text: "one two three. four five six.", imagePrompt: "A" }];
    const w = words("one two three four five six", 0);
    const a = planShots(beats, w, { rhythm: "sentence", durationSec: 3 });
    const b = planShots(beats, w, { rhythm: "sentence", durationSec: 3 });
    expect(a).toEqual(b);
  });

  it("maxShotSec force-splits a long section shot so every shot fits the clip cap", () => {
    // one ~22s 'section' beat: no rhythm cuts, would be a single un-animatable shot
    const text = Array.from({ length: 44 }, (_, i) => `w${i}`).join(" ");
    const beats: BeatInput[] = [{ type: "insight", text, imagePrompt: "scene" }];
    const w = words(text, 0, 0.5); // 44 words × 0.5s ≈ 22s
    const dur = w[w.length - 1]!.endSec + 0.1;
    const still = planShots(beats, w, { rhythm: "section", durationSec: dur });
    expect(still).toHaveLength(1); // unchanged: one long still
    // maxShotSec = clipCap - 1 leaves ~1 word of headroom, so shots stay under
    // the 10s clip cap even though the cut lands on the word that reaches 9s
    const animatable = planShots(beats, w, { rhythm: "section", durationSec: dur, maxShotSec: 9, minShotSec: 7 });
    expect(animatable.length).toBeGreaterThanOrEqual(3);
    for (const s of animatable) expect(s.endSec - s.startSec).toBeLessThanOrEqual(10);
  });
});

describe("shotPlanOptions", () => {
  const base = { isLong: true, durationSec: 30, maxClipSec: 10 };
  it("static keeps fewest-images (no maxShotSec), long-form floor", () => {
    const o = shotPlanOptions({ rhythm: "section", motion: "static" }, base);
    expect(o.maxShotSec).toBeUndefined();
    expect(o.minShotSec).toBe(7);
    expect(o.maxShotsPerBeat).toBe(3);
  });
  it("animating caps shot length just under the clip cap", () => {
    const o = shotPlanOptions({ rhythm: "section", motion: "partial" }, base);
    expect(o.maxShotSec).toBe(9);
    expect(o.minShotSec).toBe(7); // ≤ maxShotSec so a shot can still fit a clip
  });

  it("imageDensity defaults to standard (byte-identical to before)", () => {
    const withDefault = shotPlanOptions({ rhythm: "section", motion: "static" }, base);
    const explicit = shotPlanOptions(
      { rhythm: "section", motion: "static", imageDensity: "standard" },
      base,
    );
    expect(withDefault).toEqual(explicit);
    expect(explicit.minShotSec).toBe(7);
    expect(explicit.maxShotsPerBeat).toBe(3);
  });

  it("relaxed holds stills longer + trims splits (fewer images)", () => {
    const o = shotPlanOptions({ rhythm: "section", motion: "static", imageDensity: "relaxed" }, base);
    expect(o.minShotSec).toBeCloseTo(11.2); // 7 × 1.6
    expect(o.maxShotsPerBeat).toBe(2);
  });

  it("relaxed floor is clamped under the clip cap when animating", () => {
    const o = shotPlanOptions({ rhythm: "section", motion: "partial", imageDensity: "relaxed" }, base);
    expect(o.maxShotSec).toBe(9);
    expect(o.minShotSec).toBe(9); // 11.2 clamped down to the clip cap
  });

  it("busy cuts more often (lower floor, more splits)", () => {
    const o = shotPlanOptions({ rhythm: "section", motion: "static", imageDensity: "busy" }, base);
    expect(o.minShotSec).toBeCloseTo(4.9); // 7 × 0.7
    expect(o.maxShotsPerBeat).toBe(4);
  });

  it("relaxed gives short-form a floor; standard short-form has none", () => {
    const short = { isLong: false, durationSec: 30, maxClipSec: 10 };
    expect(shotPlanOptions({ rhythm: "sentence", motion: "static" }, short).minShotSec).toBeUndefined();
    const relaxed = shotPlanOptions({ rhythm: "sentence", motion: "static", imageDensity: "relaxed" }, short);
    expect(relaxed.minShotSec).toBe(4.5);
    expect(relaxed.maxShotsPerBeat).toBe(2);
  });
});

describe("planShotsFromDirection (Visual Director #37)", () => {
  const ds = (beatIndex: number, narrationSpan: string, over: Partial<DirectedShot> = {}): DirectedShot => ({
    beatIndex,
    narrationSpan,
    subject: "a subject",
    shotScale: "wide",
    medium: "still",
    hero: false,
    intent: "convey the idea",
    ...over,
  });

  const beats: BeatInput[] = [
    { type: "hook", text: "one two three four five", imagePrompt: "A" },
    { type: "cta", text: "six seven eight", imagePrompt: "B" },
  ];
  const w = [...words("one two three four five", 0), ...words("six seven eight", 2.2)];

  it("places a directed sequence onto the clock and carries its fields", () => {
    const seq = [
      ds(0, "one two three", { shotScale: "wide", medium: "still", intent: "establish" }),
      ds(0, "four five", { shotScale: "close", medium: "motion", intent: "tighten" }),
      ds(1, "six seven eight", { hero: true, medium: "real_footage", intent: "resolve" }),
    ];
    const shots = planShotsFromDirection(beats, w, seq, { durationSec: 4 })!;
    expect(shots).not.toBeNull();
    expect(shots).toHaveLength(3);
    expect(shots.map((s) => s.beatIndex)).toEqual([0, 0, 1]);
    expect(shots[0]!.shotScale).toBe("wide");
    expect(shots[1]!.medium).toBe("motion");
    expect(shots[2]!.heroShot).toBe(true);
    expect(shots[2]!.intent).toBe("resolve");
    // tiles the timeline contiguously with no gaps
    expect(shots[0]!.startSec).toBe(0);
    for (let i = 1; i < shots.length; i++) expect(shots[i]!.startSec).toBe(shots[i - 1]!.endSec);
    expect(shots[shots.length - 1]!.endSec).toBeLessThanOrEqual(4);
  });

  it("real_footage shots get a reference entity to source", () => {
    const seq = [ds(0, "one two three four five"), ds(1, "six seven eight", { medium: "real_footage", subject: "Big Ben" })];
    const shots = planShotsFromDirection(beats, w, seq, { durationSec: 4 })!;
    expect(shots[1]!.referenceEntity).toBe("Big Ben");
  });

  it("per-beat fallback: an uncovered beat becomes ONE mechanical shot", () => {
    const seq = [ds(0, "one two three", { shotScale: "wide" }), ds(0, "four five")]; // beat 1 uncovered
    const shots = planShotsFromDirection(beats, w, seq, { durationSec: 4 })!;
    expect(shots).not.toBeNull();
    // 2 director shots for beat 0 + 1 mechanical fallback shot for beat 1
    expect(shots.map((s) => s.beatIndex)).toEqual([0, 0, 1]);
    expect(shots[2]!.shotScale).toBeUndefined(); // fallback shot carries no director fields
    expect(shots[2]!.imagePrompt).toBe("B");
  });

  it("per-beat fallback: an over-cut beat becomes ONE mechanical shot", () => {
    const seq = [
      ds(0, "one two three four five"),
      ds(1, "six"),
      ds(1, "seven"),
      ds(1, "eight"),
      ds(1, "extra"), // 4 shots on a 3-word beat → beat 1 falls back
    ];
    const shots = planShotsFromDirection(beats, w, seq, { durationSec: 4 })!;
    expect(shots.map((s) => s.beatIndex)).toEqual([0, 1]); // beat 1 collapsed to one shot
    expect(shots[1]!.intent).toBeUndefined();
  });

  it("returns null (whole-video fallback) on a malformed sequence", () => {
    const seq = [ds(0, "one two three four five"), ds(9, "six seven eight")]; // beat 9 doesn't exist
    expect(planShotsFromDirection(beats, w, seq, { durationSec: 4 })).toBeNull();
  });

  it("carries the director's character placement onto the shot", () => {
    const seq = [ds(0, "one two three four five", { character: "Dr Atom" }), ds(1, "six seven eight", { character: null })];
    const shots = planShotsFromDirection(beats, w, seq, { durationSec: 4 })!;
    expect(shots[0]!.character).toBe("Dr Atom");
    expect(shots[1]!.character).toBeNull();
  });

  it("downgrades a 'motion' shot longer than the clip cap to a still", () => {
    const long: BeatInput[] = [{ type: "insight", text: "a b c d e f g h i j", imagePrompt: "X" }];
    const lw = words("a b c d e f g h i j", 0, 1.2); // ~12s beat
    const seq = [ds(0, "a b c d e f g h i j", { medium: "motion" })];
    const shots = planShotsFromDirection(long, lw, seq, { durationSec: lw[lw.length - 1]!.endSec + 0.1, maxShotSec: 9 })!;
    expect(shots[0]!.endSec - shots[0]!.startSec).toBeGreaterThan(9);
    expect(shots[0]!.medium).toBe("still"); // too long to animate → kept as a still
  });
});
