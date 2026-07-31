import { describe, expect, it } from "vitest";
import { analyticsCoverage } from "../src/performance";

describe("analyticsCoverage (#17: coverage/dataState must reflect real data, not presence)", () => {
  it("no snapshot → none, nothing covered", () => {
    const { dataState, coverage } = analyticsCoverage(null, null);
    expect(dataState).toBe("none");
    expect(coverage.views).toBe(false);
    expect(coverage.watchPct).toBe(false);
  });

  it("a stored 0 on watch metrics reads as PENDING/uncovered, not a real measurement", () => {
    // the exact reported case: 18 views but avgViewPct/watchTime stored as 0
    const { dataState, coverage } = analyticsCoverage(
      { views: 18, avgViewPct: 0, estimatedMinutesWatched: 0, likes: 0, impressions: 0, ctr: 0 },
      null,
    );
    expect(dataState).toBe("pending"); // was "partial" — the bug
    expect(coverage.watchPct).toBe(false); // was true
    expect(coverage.watchTime).toBe(false); // was true
    expect(coverage.impressionsCtr).toBe(false);
  });

  it("real watch data → partial (no retention) / full (with retention)", () => {
    const partial = analyticsCoverage({ views: 18, avgViewPct: 28, estimatedMinutesWatched: 54 }, null);
    expect(partial.dataState).toBe("partial");
    expect(partial.coverage.watchPct).toBe(true);
    expect(partial.coverage.watchTime).toBe(true);

    const full = analyticsCoverage({ views: 18, avgViewPct: 28, estimatedMinutesWatched: 54 }, [100, 80, 60]);
    expect(full.dataState).toBe("full");
    expect(full.coverage.retentionCurve).toBe(true);
  });

  it("an empty retention curve is NOT coverage", () => {
    const { coverage } = analyticsCoverage({ views: 5, avgViewPct: 20 }, []);
    expect(coverage.retentionCurve).toBe(false);
  });

  it("engagement/subs stay presence-based (0 likes is a legitimate real value)", () => {
    const { coverage } = analyticsCoverage(
      { views: 5, avgViewPct: 20, likes: 0, comments: 0, shares: 0, subsGained: 0 },
      null,
    );
    expect(coverage.engagement).toBe(true); // we DID get engagement data; it's genuinely 0
    expect(coverage.subs).toBe(true);
  });

  it("real impressions/ctr count as covered", () => {
    const { coverage } = analyticsCoverage({ views: 18, avgViewPct: 28, impressions: 570, ctr: 2.3 }, null);
    expect(coverage.impressionsCtr).toBe(true);
  });
});
