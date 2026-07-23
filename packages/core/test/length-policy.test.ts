import { describe, expect, it } from "vitest";
import {
  DEFAULT_LENGTH_BANDS,
  MIDROLL_FLOOR_SEC,
  bandForRuntime,
  resolveLengthPolicy,
  reviewRuntimeFit,
} from "../src/length-policy";

describe("resolveLengthPolicy (#39 defaults + merge)", () => {
  it("fills behaviour-preserving defaults when nothing is stored", () => {
    const p = resolveLengthPolicy(null);
    expect(p.floorSec).toBe(MIDROLL_FLOOR_SEC);
    expect(p.ceilingSec).toBe(2400);
    expect(p.bands).toEqual(DEFAULT_LENGTH_BANDS);
    expect(p.principle).toMatch(/justifies the runtime/i);
  });

  it("keeps a valid partial and defaults the rest", () => {
    const p = resolveLengthPolicy({ ceilingSec: 3000, principle: "material first" });
    expect(p.floorSec).toBe(480);
    expect(p.ceilingSec).toBe(3000);
    expect(p.principle).toBe("material first");
  });

  it("rejects a ceiling below the floor and bad bands", () => {
    const p = resolveLengthPolicy({ floorSec: 600, ceilingSec: 300, bands: [{ name: "bad", minSec: 100, maxSec: 50 }] });
    expect(p.floorSec).toBe(600);
    expect(p.ceilingSec).toBe(2400); // ceiling < floor → default
    expect(p.bands).toEqual(DEFAULT_LENGTH_BANDS); // all bands invalid → defaults
  });
});

describe("bandForRuntime", () => {
  it("finds the band a runtime sits in, or null between bands", () => {
    const p = resolveLengthPolicy(null);
    expect(bandForRuntime(p, 600)?.name).toBe("short-doc");
    expect(bandForRuntime(p, 1200)?.name).toBe("standard");
    expect(bandForRuntime(p, 800)).toBeNull(); // gap between short-doc (≤720) and standard (≥900)
  });
});

describe("reviewRuntimeFit (advisory runtime↔depth)", () => {
  const policy = resolveLengthPolicy(null);

  it("flags below the mid-roll floor", () => {
    const a = reviewRuntimeFit(policy, { runtimeSec: 300, beatCount: 8, words: 750 });
    expect(a.some((x) => x.rule === "below_midroll_floor")).toBe(true);
  });

  it("flags a long runtime padded over too few beats", () => {
    // 23 min, 6 beats → 0.26 beats/min
    const a = reviewRuntimeFit(policy, { runtimeSec: 1380, beatCount: 6, words: 0 });
    expect(a.some((x) => x.rule === "runtime_padded_for_beats")).toBe(true);
  });

  it("flags a dense map crammed into a short runtime", () => {
    // 10 min, 40 beats → 4 beats/min
    const a = reviewRuntimeFit(policy, { runtimeSec: 600, beatCount: 40, words: 0 });
    expect(a.some((x) => x.rule === "runtime_compressed_for_beats")).toBe(true);
  });

  it("flags a script that outruns the runtime (words/min too high)", () => {
    // 3000 words in 10 min = 300 wpm
    const a = reviewRuntimeFit(policy, { runtimeSec: 600, beatCount: 12, words: 3000 });
    expect(a.some((x) => x.rule === "runtime_undersized_for_script")).toBe(true);
  });

  it("a well-matched map produces no runtime advisories", () => {
    // 15 min, 20 beats (1.3 beats/min), ~2250 words (150 wpm)
    const a = reviewRuntimeFit(policy, { runtimeSec: 900, beatCount: 20, words: 2250 });
    expect(a).toEqual([]);
  });
});
