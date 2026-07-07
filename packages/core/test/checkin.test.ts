/**
 * Build #5.2 pure logic: check-in cadence math, the deterministic experiment
 * evaluator, and the review-board verdict fold.
 */
import { describe, expect, it } from "vitest";
import {
  boardVerdict,
  briefingDue,
  evaluateExperimentOutcome,
  normalizeCadence,
  type BoardCheckerResult,
} from "../src";

const DAY = 86_400_000;

describe("briefingDue", () => {
  const now = new Date("2026-07-06T07:00:00Z");

  it("is due when no briefing was ever sent", () => {
    expect(briefingDue("weekly", null, now)).toBe(true);
  });

  it("weekly: due at 7 days, not before", () => {
    expect(briefingDue("weekly", new Date(now.getTime() - 6 * DAY), now)).toBe(false);
    expect(briefingDue("weekly", new Date(now.getTime() - 7 * DAY), now)).toBe(true);
  });

  it("monthly: due at 28 days, not at 7", () => {
    expect(briefingDue("monthly", new Date(now.getTime() - 7 * DAY), now)).toBe(false);
    expect(briefingDue("monthly", new Date(now.getTime() - 28 * DAY), now)).toBe(true);
  });

  it("unknown cadence falls back to weekly", () => {
    expect(normalizeCadence("fortnightly-ish")).toBe("weekly");
    expect(normalizeCadence(null)).toBe("weekly");
    expect(briefingDue("whenever", new Date(now.getTime() - 8 * DAY), now)).toBe(true);
  });
});

describe("evaluateExperimentOutcome", () => {
  const metrics = (avgPctViewed: number | null, avgViews: number | null, sampleSize: number) => ({
    avgPctViewed,
    avgViews,
    sampleSize,
  });

  it("wins on a ≥10% retention lift with a full sample", () => {
    const out = evaluateExperimentOutcome({
      baseline: metrics(50, 1000, 5),
      variant: metrics(58, 900, 3),
    });
    expect(out.result).toBe("win");
    expect(out.metric).toBe("avgPctViewed");
    expect(out.deltaPct).toBeCloseTo(0.16);
  });

  it("loses on a ≥10% retention drop", () => {
    const out = evaluateExperimentOutcome({
      baseline: metrics(50, 1000, 5),
      variant: metrics(42, 1200, 3),
    });
    expect(out.result).toBe("loss");
  });

  it("is inconclusive inside the ±10% band", () => {
    const out = evaluateExperimentOutcome({
      baseline: metrics(50, 1000, 5),
      variant: metrics(52, 1000, 3),
    });
    expect(out.result).toBe("inconclusive");
  });

  it("is inconclusive when the variant sample is short", () => {
    const out = evaluateExperimentOutcome({
      baseline: metrics(50, 1000, 5),
      variant: metrics(90, 9000, 2),
      minSample: 3,
    });
    expect(out.result).toBe("inconclusive");
    expect(out.readout).toContain("insufficient sample");
  });

  it("falls back to views when retention is missing on both sides", () => {
    const out = evaluateExperimentOutcome({
      baseline: metrics(null, 1000, 5),
      variant: metrics(null, 1300, 3),
    });
    expect(out.result).toBe("win");
    expect(out.metric).toBe("avgViews");
  });

  it("is inconclusive when the cohorts have no comparable metric", () => {
    const out = evaluateExperimentOutcome({
      baseline: metrics(50, null, 5),
      variant: metrics(null, 1300, 3),
    });
    expect(out.result).toBe("inconclusive");
  });
});

describe("boardVerdict", () => {
  const r = (
    checker: BoardCheckerResult["checker"],
    severity: BoardCheckerResult["severity"],
    pass: boolean,
  ): BoardCheckerResult => ({ checker, severity, pass, reason: `${checker} reason`, issues: [] });

  it("passes when every checker passes", () => {
    const v = boardVerdict([
      r("compliance", "hard", true),
      r("alignment", "hard", true),
      r("safety", "hard", true),
      r("quality", "advisory", true),
    ]);
    expect(v.blocked).toBe(false);
    expect(v.reason).toBeNull();
  });

  it("blocks on any hard failure and names the checkers", () => {
    const v = boardVerdict([
      r("compliance", "hard", false),
      r("safety", "hard", false),
      r("quality", "advisory", true),
    ]);
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain("compliance");
    expect(v.reason).toContain("safety");
  });

  it("does NOT block on an advisory (quality) failure", () => {
    const v = boardVerdict([
      r("compliance", "hard", true),
      r("alignment", "hard", true),
      r("safety", "hard", true),
      r("quality", "advisory", false),
    ]);
    expect(v.blocked).toBe(false);
  });
});
