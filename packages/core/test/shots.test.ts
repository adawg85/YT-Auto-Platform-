import { describe, expect, it } from "vitest";
import { planShots, type BeatInput } from "../src/shots";
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
});
