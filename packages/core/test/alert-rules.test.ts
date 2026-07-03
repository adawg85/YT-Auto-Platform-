import { describe, expect, it } from "vitest";
import { evaluateAlertRules } from "../src/alert-rules";

const baseline = { medianViews: 10_000, publishedCount: 5 };

describe("alert rules", () => {
  it("flags low retention once views are meaningful", () => {
    const alerts = evaluateAlertRules({ views: 500, avgViewPct: 32, ageHours: 48 }, baseline);
    expect(alerts.some((a) => a.kind === "low_retention" && a.severity === "warning")).toBe(true);
  });

  it("ignores low retention on tiny view counts", () => {
    const alerts = evaluateAlertRules({ views: 20, avgViewPct: 25, ageHours: 48 }, baseline);
    expect(alerts.find((a) => a.kind === "low_retention")).toBeUndefined();
  });

  it("flags underperformance vs channel median after 24h", () => {
    const warn = evaluateAlertRules({ views: 2_000, avgViewPct: 60, ageHours: 48 }, baseline);
    expect(warn.find((a) => a.kind === "underperformance")?.severity).toBe("warning");

    const crit = evaluateAlertRules({ views: 500, avgViewPct: 60, ageHours: 48 }, baseline);
    expect(crit.find((a) => a.kind === "underperformance")?.severity).toBe("critical");
  });

  it("does not flag underperformance too early or with a thin baseline", () => {
    expect(
      evaluateAlertRules({ views: 100, avgViewPct: 60, ageHours: 3 }, baseline),
    ).toEqual([]);
    expect(
      evaluateAlertRules(
        { views: 100, avgViewPct: 60, ageHours: 48 },
        { medianViews: 10_000, publishedCount: 2 },
      ),
    ).toEqual([]);
  });

  it("healthy video produces no alerts", () => {
    expect(
      evaluateAlertRules({ views: 12_000, avgViewPct: 65, ageHours: 72 }, baseline),
    ).toEqual([]);
  });
});
