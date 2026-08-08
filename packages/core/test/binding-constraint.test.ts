import { describe, expect, it } from "vitest";
import { bindingShotConstraint } from "../src/shots";
import { projectShotPlan } from "../src/shot-projection";

/** minimal well-typed beat — projectShotPlan only reads text/imagePrompts here */
const beat = (text: string, imagePrompts?: string[]) =>
  ({ type: "insight" as const, imagePrompt: "p", text, ...(imagePrompts ? { imagePrompts } : {}) });

describe("bindingShotConstraint (#105) — name what actually decided the shot count", () => {
  it("THE REPORTED CASE: the density per-beat cap binds, not the seconds floor", () => {
    // 2-min Short, 8 beats, imageDensity 'relaxed' caps short-form to 2/beat,
    // explicit minSecondsPerShot 6 would have implied ~23 shots over 140s
    const r = bindingShotConstraint({
      projectedShots: 14,
      beats: 8,
      durationSec: 140,
      maxShotsPerBeat: 2,
      minShotSec: 6,
    });
    expect(r.constraint).toBe("imageDensity per-beat cap");
    expect(r.shotsIfFloorOnly).toBe(23);
    // and it must say the thing the operator had to work out for themselves
    expect(r.note).toMatch(/BINDING/);
    expect(r.note).toMatch(/imageDensity/);
    expect(r.note).toMatch(/will NOT raise the count/i);
  });

  it("reports the FLOOR when that is what binds", () => {
    // long holds, cap nowhere near
    const r = bindingShotConstraint({
      projectedShots: 6,
      beats: 10,
      durationSec: 140,
      maxShotsPerBeat: 4,
      minShotSec: 22,
    });
    expect(r.constraint).toBe("minSecondsPerShot");
    expect(r.note).toBeNull(); // nothing surprising to report
  });

  it("reports the clip cap when an animating floor was clamped to it", () => {
    const r = bindingShotConstraint({
      projectedShots: 12,
      beats: 20,
      durationSec: 140,
      maxShotsPerBeat: 4,
      minShotSec: 9,
      maxShotSec: 9,
      clampedByClipCap: true,
    });
    expect(r.constraint).toBe("i2v clip cap");
  });

  it("falls back to beat count when nothing else binds", () => {
    const r = bindingShotConstraint({ projectedShots: 3, beats: 3, durationSec: 300, minShotSec: 5 });
    expect(r.constraint).toBe("beat count");
  });

  it("stays quiet when the cap costs only a shot or two", () => {
    // cap binds, but the floor would only have given 15 vs 14 — not worth noise
    const r = bindingShotConstraint({
      projectedShots: 14,
      beats: 7,
      durationSec: 140,
      maxShotsPerBeat: 2,
      minShotSec: 9,
    });
    expect(r.constraint).toBe("imageDensity per-beat cap");
    expect(r.note).toBeNull();
  });
});

describe("projectShotPlan (#105) — the projection reports it end to end", () => {
  // 8 beats x 4 sentences x 11 words — shots are cut on sentence boundaries, so
  // a beat has to hold several sentences before a per-beat cap can bind at all
  const beats = Array.from({ length: 8 }, (_, i) =>
    beat(
      Array.from({ length: 4 }, (_, s) =>
        Array.from({ length: 11 }, (_, w) => `w${i}x${s}x${w}`).join(" ") + ".",
      ).join(" "),
    ),
  );

  it("surfaces bindingConstraint and the floor-only comparison", () => {
    // channel-level `relaxed` with no per-video floor: the density cap IS what
    // decides the count, and the projection now says so out loud
    const p = projectShotPlan(beats, {
      rhythm: "steady",
      motion: "static",
      imageDensity: "relaxed",
      visualMode: "ai_images",
    } as never, { isLong: false });
    expect(p.bindingConstraint).toBe("imageDensity per-beat cap");
    expect(p.shotsIfFloorOnly).toBeGreaterThan(p.projectedShots);
    expect(p.notes.join(" ")).toMatch(/imageDensity/);
  });

  // #105 item 3 — the operator's actual ask: a long-form density default must
  // not be a blocker they clear by hand on every Short.
  it("an explicit minSecondsPerShot on a SHORT now beats the density tier's cap", () => {
    // beats long enough that a 6s floor would allow 4 cuts each — so the tier's
    // 2/beat cap is demonstrably the thing that used to hold the count down
    const roomyBeats = Array.from({ length: 8 }, (_, i) =>
      beat(
        Array.from({ length: 6 }, (_, s) =>
          Array.from({ length: 12 }, (_, w) => `w${i}x${s}x${w}`).join(" ") + ".",
        ).join(" "),
      ),
    );
    const capped = projectShotPlan(roomyBeats, {
      rhythm: "steady",
      motion: "static",
      imageDensity: "relaxed",
      visualMode: "ai_images",
    } as never, { isLong: false });
    const withFloor = projectShotPlan(roomyBeats, {
      rhythm: "steady",
      motion: "static",
      imageDensity: "relaxed",
      minSecondsPerShot: 6,
      visualMode: "ai_images",
    } as never, { isLong: false });
    // stating a 6s floor is now honoured instead of being overruled at 2/beat
    expect(withFloor.projectedShots).toBeGreaterThan(capped.projectedShots);
    expect(withFloor.bindingConstraint).not.toBe("imageDensity per-beat cap");
    expect(withFloor.notes.join(" ")).not.toMatch(/BINDING/);
  });

  it("a LONG-form channel keeps its density cap — that cap is the cost guard", () => {
    const longBeats = Array.from({ length: 20 }, (_, i) =>
      beat(
        Array.from({ length: 6 }, (_, s) =>
          Array.from({ length: 30 }, (_, w) => `w${i}x${s}x${w}`).join(" ") + ".",
        ).join(" "),
      ),
    );
    const p = projectShotPlan(longBeats, {
      rhythm: "steady",
      motion: "static",
      imageDensity: "relaxed",
      minSecondsPerShot: 6,
      visualMode: "ai_images",
    } as never, { isLong: true });
    expect(p.projectedShots).toBeLessThanOrEqual(20 * 2);
  });

  it("warns when authored imagePrompts exceed the shots that will be cut", () => {
    const withPrompts = beats.map(() => beat("One. Two. Three. Four.", ["a", "b", "c", "d", "e"]));
    const p = projectShotPlan(withPrompts, {
      rhythm: "steady",
      motion: "static",
      imageDensity: "relaxed",
      visualMode: "ai_images",
    } as never, { isLong: false });
    const note = p.notes.find((n) => n.includes("authored imagePrompts"));
    expect(note).toBeTruthy();
    expect(note).toMatch(/UNUSED/);
  });

  it("says nothing about prompts when they fit", () => {
    const p = projectShotPlan(
      [beat("One. Two. Three. Four. Five. Six.", ["a"])],
      { rhythm: "steady", motion: "static", imageDensity: "busy", visualMode: "ai_images" } as never,
      { isLong: false },
    );
    expect(p.notes.some((n) => n.includes("authored imagePrompts"))).toBe(false);
  });
});

// ── #105 REOPENED — two defects found on a real 2-minute Short ──────────────
describe("#105 reopen — the projection must describe the plan that will ACTUALLY run", () => {
  // 8 beats x ~44 words ≈ 350 words ≈ 140s at the platform rate, authored on a
  // channel whose targetLengthSec is 1200. The operator's exact shape.
  const shortScript = Array.from({ length: 8 }, (_, i) =>
    beat(
      Array.from({ length: 4 }, (_, s) =>
        Array.from({ length: 11 }, (_, w) => `w${i}x${s}x${w}`).join(" ") + ".",
      ).join(" "),
    ),
  );

  it("THE DEFECT: shotsIfFloorOnly is measured against the SCRIPT's runtime, not the channel target", () => {
    const p = projectShotPlan(
      shortScript,
      { rhythm: "steady", motion: "static", imageDensity: "busy", minSecondsPerShot: 5, visualMode: "ai_images" } as never,
      { isLong: false, targetLengthSec: 1200 },
    );
    // the target is still echoed — #81's distinction is preserved
    expect(p.estimatedDurationSec).toBe(1200);
    expect(p.wordBasedDurationSec).toBeLessThan(200);
    // ...but the floor-only headroom is 140/5 ≈ 28, NOT 1200/5 = 240
    expect(p.shotsIfFloorOnly).toBeLessThan(40);
    expect(p.shotsIfFloorOnly).toBeGreaterThan(20);
    // the floor-only note, if any, must not quote the channel target as the
    // runtime — the #81 target-divergence note DOES quote it, correctly, and is
    // exactly how the operator spotted this
    expect(p.notes.join(" ")).not.toMatch(/across 1200s/);
    expect(p.notes.join(" ")).toMatch(/1200s\) is the channel TARGET/);
  });

  it("the last shot no longer gets a tail out to the channel target", () => {
    const p = projectShotPlan(
      shortScript,
      { rhythm: "steady", motion: "static", imageDensity: "standard", visualMode: "ai_images" } as never,
      { isLong: false, targetLengthSec: 1200 },
    );
    // every projected shot lives inside the script's own runtime
    expect(p.wordBasedDurationSec).toBeLessThan(200);
    expect(p.projectedShots).toBeGreaterThan(0);
  });

  it("a script sitting AT its channel target is unaffected — the old and new divisors agree", () => {
    const p = projectShotPlan(
      shortScript,
      { rhythm: "steady", motion: "static", imageDensity: "busy", minSecondsPerShot: 5, visualMode: "ai_images" } as never,
      { isLong: false, targetLengthSec: Math.round(8 * 44 / 2.5) },
    );
    expect(Math.abs(p.estimatedDurationSec - p.wordBasedDurationSec)).toBeLessThan(2);
  });
});
