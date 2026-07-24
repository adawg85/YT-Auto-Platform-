import { describe, expect, it } from "vitest";
import { resolveLengthPolicy } from "../src/length-policy";
import {
  SUGGESTED_LENGTH_MIN_MEDIAN_VIEWS,
  SUGGESTED_LENGTH_MIN_SAMPLE,
  suggestLengthFromRetention,
} from "../src/performance";

describe("suggestLengthFromRetention (ticket 01KY99AE… — clamp to policy + evidence gate)", () => {
  const policy = resolveLengthPolicy({ floorSec: 480, ceilingSec: 2400 });
  const good = { sampleSize: SUGGESTED_LENGTH_MIN_SAMPLE, medianViews: SUGGESTED_LENGTH_MIN_MEDIAN_VIEWS };

  it("suppresses the suggestion below the sample-size bar (the Wings n=5 case)", () => {
    const r = suggestLengthFromRetention(policy, {
      avgViewPct: 40,
      avgViewDurationSec: 106,
      sampleSize: 5,
      medianViews: 4,
    });
    expect(r.sufficientEvidence).toBe(false);
    expect(r.suggestedLengthSec).toBeNull();
  });

  it("suppresses when views are below the median-views bar even with enough videos", () => {
    const r = suggestLengthFromRetention(policy, {
      avgViewPct: 40,
      avgViewDurationSec: 106,
      sampleSize: 20,
      medianViews: 4,
    });
    expect(r.sufficientEvidence).toBe(false);
    expect(r.suggestedLengthSec).toBeNull();
  });

  it("NEVER emits below the policy floor — the old [20,60] clamp bug", () => {
    // low retention on short avg-duration would compute ~170s; must clamp UP to 480
    const r = suggestLengthFromRetention(policy, {
      avgViewPct: 40,
      avgViewDurationSec: 106,
      ...good,
    });
    expect(r.sufficientEvidence).toBe(true);
    expect(r.suggestedLengthSec).toBe(480); // clamped to floorSec, not 60
    expect(r.suggestedLengthSec!).toBeGreaterThanOrEqual(policy.floorSec);
  });

  it("clamps a very high suggestion down to the ceiling", () => {
    // high retention on a long avg-duration → a large number, clamp to 2400
    const r = suggestLengthFromRetention(policy, {
      avgViewPct: 85,
      avgViewDurationSec: 3000,
      ...good,
    });
    expect(r.suggestedLengthSec).toBe(2400);
  });

  it("returns a value inside the band for a mid-range case", () => {
    const r = suggestLengthFromRetention(policy, {
      avgViewPct: 80,
      avgViewDurationSec: 900,
      ...good,
    });
    expect(r.suggestedLengthSec).toBeGreaterThanOrEqual(480);
    expect(r.suggestedLengthSec).toBeLessThanOrEqual(2400);
  });

  it("no suggestion when retention is in the neutral band (45–70%)", () => {
    const r = suggestLengthFromRetention(policy, { avgViewPct: 55, avgViewDurationSec: 600, ...good });
    expect(r.suggestedLengthSec).toBeNull();
  });
});
