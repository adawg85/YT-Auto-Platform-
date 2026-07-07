/**
 * YouTube (MIT / youtubei.js) research adapter. The live InnerTube transport
 * can't run offline, so we test the pure pieces: view-count / relative-time
 * parsing, defensive node normalisation, and the in-house outlier / velocity /
 * breakout computation that stands in for vidIQ's proprietary scores.
 */
import { describe, expect, it } from "vitest";
import {
  groupPoolToBreakout,
  mapPoolToOutliers,
  mapPoolToTrending,
  normalizeVideoNode,
  parseRelativeAgeHours,
  parseViewCount,
  type NormalizedVideo,
} from "../src/real/youtube-research";

const NOW = new Date("2026-07-01T00:00:00Z");

describe("parseViewCount", () => {
  it("handles commas, abbreviations and bare numbers", () => {
    expect(parseViewCount("1,234,567 views")).toBe(1234567);
    expect(parseViewCount("1.2M views")).toBe(1200000);
    expect(parseViewCount("3.4B")).toBe(3400000000);
    expect(parseViewCount("812 views")).toBe(812);
    expect(parseViewCount("5K views")).toBe(5000);
  });
  it("is 0 for missing / non-numeric", () => {
    expect(parseViewCount(undefined)).toBe(0);
    expect(parseViewCount("No views")).toBe(0);
  });
});

describe("parseRelativeAgeHours", () => {
  it("converts relative timestamps to hours", () => {
    expect(parseRelativeAgeHours("5 hours ago")).toBe(5);
    expect(parseRelativeAgeHours("3 days ago")).toBe(72);
    expect(parseRelativeAgeHours("2 weeks ago")).toBe(336);
    expect(parseRelativeAgeHours("1 month ago")).toBe(730);
    expect(parseRelativeAgeHours("just now")).toBe(0.5);
  });
  it("floors at 0.5h and defaults to 1h when unparseable", () => {
    expect(parseRelativeAgeHours("")).toBe(1);
    expect(parseRelativeAgeHours("a while back")).toBe(1);
  });
});

describe("normalizeVideoNode", () => {
  it("extracts fields from a Video node (text objects + author)", () => {
    const v = normalizeVideoNode({
      id: "abc123",
      title: { text: "Why the sky is blue" },
      author: { id: "UC_x", name: "SciChan" },
      view_count: { text: "1.2M views" },
      published: { text: "2 days ago" },
    });
    expect(v).toEqual<NormalizedVideo>({
      externalId: "abc123",
      title: "Why the sky is blue",
      channelId: "UC_x",
      channelName: "SciChan",
      views: 1_200_000,
      ageHours: 48,
    });
  });
  it("returns null when id or title is missing", () => {
    expect(normalizeVideoNode({ title: { text: "no id" } })).toBeNull();
    expect(normalizeVideoNode({ id: "x" })).toBeNull();
  });
});

const POOL: NormalizedVideo[] = [
  { externalId: "v1", title: "A", channelId: "c1", channelName: "C1", views: 100, ageHours: 10 },
  { externalId: "v2", title: "B", channelId: "c1", channelName: "C1", views: 200, ageHours: 10 },
  { externalId: "v3", title: "C", channelId: "c2", channelName: "C2", views: 600, ageHours: 2 },
];

describe("in-house outlier + velocity computation", () => {
  it("scores outlierFactor vs the pool median and computes vph", () => {
    const out = mapPoolToOutliers(POOL, NOW);
    // median views = 200; v3 = 600/200 = 3.0
    expect(out.find((o) => o.externalId === "v3")!.outlierFactor).toBe(3);
    expect(out.find((o) => o.externalId === "v3")!.viewsPerHour).toBe(300); // 600/2
    expect(out[0]!.publishedAt.startsWith("20")).toBe(true);
  });

  it("ranks trending by views-per-hour", () => {
    const out = mapPoolToTrending(POOL, NOW);
    expect(out[0]!.externalId).toBe("v3"); // 300 vph beats 20/10
    expect(out.every((t) => t.format === "shorts")).toBe(true);
  });

  it("groups breakout by channel, best video per channel, honoring the limit", () => {
    const out = groupPoolToBreakout("science", POOL, NOW, 5);
    expect(out).toHaveLength(2); // c1, c2
    const c1 = out.find((b) => b.externalId === "c1")!;
    expect(c1.topVideo.externalId).toBe("v2"); // 200/10 beats 100/10
    expect(groupPoolToBreakout("science", POOL, NOW, 1)).toHaveLength(1);
  });
});
