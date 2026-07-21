import { describe, expect, it } from "vitest";
import {
  evaluateAlertRules,
  meetsUnderperformanceSampleGate,
  MIN_MEDIAN_VIEWS_FOR_UNDERPERFORMANCE,
  MIN_PUBLISHED_FOR_UNDERPERFORMANCE,
} from "../src/alert-rules";

// Established channel: enough history + median for a ratio to mean something.
const baseline = { medianViews: 10_000, publishedCount: 12 };

describe("alert rules", () => {
  it("flags low retention once views are meaningful", () => {
    const alerts = evaluateAlertRules({ views: 500, avgViewPct: 32, ageHours: 48 }, baseline);
    expect(alerts.some((a) => a.kind === "low_retention" && a.severity === "warning")).toBe(true);
  });

  it("ignores low retention on tiny view counts", () => {
    const alerts = evaluateAlertRules({ views: 20, avgViewPct: 25, ageHours: 48 }, baseline);
    expect(alerts.find((a) => a.kind === "low_retention")).toBeUndefined();
  });

  it("flags underperformance vs channel median after 24h on an established channel", () => {
    const warn = evaluateAlertRules({ views: 2_000, avgViewPct: 60, ageHours: 48 }, baseline);
    expect(warn.find((a) => a.kind === "underperformance")?.severity).toBe("warning");

    const crit = evaluateAlertRules({ views: 500, avgViewPct: 60, ageHours: 48 }, baseline);
    expect(crit.find((a) => a.kind === "underperformance")?.severity).toBe("critical");
  });

  it("does not flag underperformance too early", () => {
    expect(evaluateAlertRules({ views: 100, avgViewPct: 60, ageHours: 3 }, baseline)).toEqual([]);
  });

  // ── ticket 01KY1SX2…: small-sample fatigue ──────────────────────────────
  it("suppresses underperformance on a brand-new channel (few videos)", () => {
    // 5 videos, healthy median — still below the 10-video floor → no alert.
    const alerts = evaluateAlertRules(
      { views: 0, avgViewPct: 60, ageHours: 48 },
      { medianViews: 10_000, publishedCount: 5 },
    );
    expect(alerts.find((a) => a.kind === "underperformance")).toBeUndefined();
  });

  it("suppresses the exact reported case: 0 views vs a median of 2", () => {
    // The three real alerts: "0 views is 0% of the channel median (2)".
    for (const ageHours of [28, 79, 103]) {
      const alerts = evaluateAlertRules(
        { views: 0, avgViewPct: null, ageHours },
        { medianViews: 2, publishedCount: 4 },
      );
      expect(alerts).toEqual([]);
    }
  });

  it("suppresses underperformance when the median is too low even with enough videos", () => {
    // 15 videos but the channel still only medians 20 views → ratio is noise.
    const alerts = evaluateAlertRules(
      { views: 0, avgViewPct: 60, ageHours: 48 },
      { medianViews: 20, publishedCount: 15 },
    );
    expect(alerts.find((a) => a.kind === "underperformance")).toBeUndefined();
  });

  it("still fires for a genuine dud once the channel is established", () => {
    // 30 videos, median 5,000: a video stuck at 100 views after 3 days is real.
    const alerts = evaluateAlertRules(
      { views: 100, avgViewPct: 55, ageHours: 72 },
      { medianViews: 5_000, publishedCount: 30 },
    );
    expect(alerts.find((a) => a.kind === "underperformance")?.severity).toBe("critical");
  });

  it("healthy video produces no alerts", () => {
    expect(evaluateAlertRules({ views: 12_000, avgViewPct: 65, ageHours: 72 }, baseline)).toEqual([]);
  });

  it("sample gate matches the constants", () => {
    expect(
      meetsUnderperformanceSampleGate({
        publishedCount: MIN_PUBLISHED_FOR_UNDERPERFORMANCE,
        medianViews: MIN_MEDIAN_VIEWS_FOR_UNDERPERFORMANCE,
      }),
    ).toBe(true);
    expect(
      meetsUnderperformanceSampleGate({
        publishedCount: MIN_PUBLISHED_FOR_UNDERPERFORMANCE - 1,
        medianViews: MIN_MEDIAN_VIEWS_FOR_UNDERPERFORMANCE,
      }),
    ).toBe(false);
    expect(
      meetsUnderperformanceSampleGate({
        publishedCount: MIN_PUBLISHED_FOR_UNDERPERFORMANCE,
        medianViews: MIN_MEDIAN_VIEWS_FOR_UNDERPERFORMANCE - 1,
      }),
    ).toBe(false);
  });
});
