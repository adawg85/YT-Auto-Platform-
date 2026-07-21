import { describe, expect, it } from "vitest";
import { parseRetentionCurve, parseTrafficSources, reportCol } from "../src/real/analytics";

describe("YouTube analytics report parsers (ticket 01KY1VEZ…)", () => {
  it("reportCol reads a named metric from the first row", () => {
    const rep = {
      columnHeaders: [{ name: "views" }, { name: "subscribersGained" }],
      rows: [[1234, 7]],
    };
    expect(reportCol(rep, "views")).toBe(1234);
    expect(reportCol(rep, "subscribersGained")).toBe(7);
    expect(reportCol(rep, "missing")).toBeNull();
    expect(reportCol(null, "views")).toBeNull();
  });

  it("parseRetentionCurve → 0-100 percentages sorted by elapsed ratio, ~100 at start", () => {
    const rep = {
      columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }],
      // out of order on purpose — parser sorts
      rows: [
        [0.5, 0.62],
        [0, 1.0],
        [1.0, 0.28],
      ],
    };
    const curve = parseRetentionCurve(rep);
    expect(curve).toEqual([100, 62, 28]);
    expect(curve![0]).toBe(100);
  });

  it("parseRetentionCurve → null on an empty report (brand-new video)", () => {
    expect(parseRetentionCurve({ columnHeaders: [{ name: "audienceWatchRatio" }], rows: [] })).toBeNull();
    expect(parseRetentionCurve(null)).toBeNull();
  });

  it("parseTrafficSources → sources descending by views, zero-view sources dropped", () => {
    const rep = {
      columnHeaders: [{ name: "insightTrafficSourceType" }, { name: "views" }],
      rows: [
        ["YT_SEARCH", 40],
        ["SUGGESTED_VIDEO", 120],
        ["NO_LINK_OTHER", 0],
      ],
    };
    expect(parseTrafficSources(rep)).toEqual([
      { source: "SUGGESTED_VIDEO", views: 120 },
      { source: "YT_SEARCH", views: 40 },
    ]);
  });

  it("parseTrafficSources → null when the dimension is absent", () => {
    expect(parseTrafficSources({ columnHeaders: [{ name: "views" }], rows: [[10]] })).toBeNull();
  });
});
