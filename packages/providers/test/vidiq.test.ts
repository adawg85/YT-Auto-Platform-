/**
 * vidIQ real research adapter. The mappers are tested against REAL vidIQ API
 * responses (captured live via the MCP tools), and the provider is driven end
 * to end through a fake caller so the tool→method wiring is exercised without a
 * live MCP connection.
 */
import { describe, expect, it } from "vitest";
import {
  createVidIQResearchProvider,
  mapBreakoutChannels,
  mapKeywords,
  mapOutliers,
  mapTrending,
  vidiqDateToIso,
  type VidiqCaller,
} from "../src/real/research";

// ── Real captured fixtures (trimmed) ──────────────────────────────────────
const OUTLIERS = {
  videos: [
    {
      videoId: "frqP1yWVRD8",
      videoTitle: "#science #facts",
      channelId: "UCrQDnfbMunlsKCN7OgN0GoA",
      channelTitle: "QuizFuel",
      viewCount: 26024,
      breakoutScore: 27.13,
      vph: 0.14,
      videoPublishedAt: 1778614205, // unix seconds
    },
    {
      videoId: "QqBUk0FBgbU",
      videoTitle: "Facts about Earth and Mars",
      channelId: "UCffGSpcq44cqxlaP5OWGtgA",
      channelTitle: "Morris M Kokulo",
      viewCount: 563587,
      breakoutScore: 280.98,
      vph: 43.73,
      videoPublishedAt: 1780762435,
    },
  ],
};
const TRENDING = {
  videos: [
    {
      videoId: "JBr5IP8Vzvo",
      videoTitle: "Amazing Science Facts Quiz",
      channelTitle: "CoolCert Quiz",
      viewCount: 68241,
      vph: 549.51,
      engagementRate: 0.013,
      videoPublishedAt: "2026-06-30T18:35:07.000Z", // ISO string
    },
  ],
};
const KEYWORDS = {
  seedKeyword: { keyword: "everyday science", estimatedMonthlySearch: 47568, competition: 38 },
  relatedKeywords: [{ keyword: "science", estimatedMonthlySearch: 818638, competition: 54 }],
};
const CHANNELS = {
  channels: [
    {
      channelId: "UC_A",
      channelTitle: "Tiny Mind Talks",
      niche: "Science Education",
      subscriberCount: 30,
      subsGrowth30d: 11.11,
      shortVideoCount30d: 32,
    },
    { channelId: "UC_B", channelTitle: "No Videos Chan", subscriberCount: 105, subsGrowth30d: 133.3, shortVideoCount30d: 23 },
  ],
};
const CHANNEL_VIDEOS = {
  videos: [
    { videoId: "vA", videoTitle: "Top A", channelId: "UC_A", channelTitle: "Tiny Mind Talks", viewCount: 1000, vph: 5, videoPublishedAt: 1778614205 },
  ],
};

describe("vidIQ date normalisation", () => {
  it("converts unix seconds to ISO and passes ISO through", () => {
    expect(vidiqDateToIso(1778614205)).toBe(new Date(1778614205 * 1000).toISOString());
    expect(vidiqDateToIso("2026-06-30T18:35:07.000Z")).toBe("2026-06-30T18:35:07.000Z");
    expect(vidiqDateToIso(null)).toBe(new Date(0).toISOString());
  });
});

describe("vidIQ mappers (real shapes)", () => {
  it("maps outliers with velocity, breakout score and watch url", () => {
    const out = mapOutliers(OUTLIERS);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      externalId: "frqP1yWVRD8",
      title: "#science #facts",
      channelName: "QuizFuel",
      views: 26024,
      viewsPerHour: 0.14,
      outlierFactor: 27.13,
      url: "https://www.youtube.com/watch?v=frqP1yWVRD8",
    });
    expect(out[0]!.publishedAt.startsWith("20")).toBe(true);
  });

  it("maps trending, tagging shorts format and keeping ISO dates", () => {
    const out = mapTrending(TRENDING);
    expect(out[0]).toMatchObject({
      externalId: "JBr5IP8Vzvo",
      viewsPerHour: 549.51,
      engagementRate: 0.013,
      format: "shorts",
      publishedAt: "2026-06-30T18:35:07.000Z",
    });
  });

  it("maps keywords (seed + related), normalising competition to 0-1", () => {
    const out = mapKeywords(KEYWORDS);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ keyword: "everyday science", monthlyVolume: 47568, competition: 0.38 });
    expect(out[1]!.competition).toBe(0.54);
  });

  it("joins breakout channels to a top video, dropping channels with none", () => {
    const out = mapBreakoutChannels("everyday science", CHANNELS, CHANNEL_VIDEOS);
    expect(out).toHaveLength(1); // UC_B has no video → dropped
    expect(out[0]).toMatchObject({
      externalId: "UC_A",
      subscribers: 30,
      growthRate: 11.1,
      publishedPerWeek: 7, // round(32 / 4.3)
    });
    expect(out[0]!.topVideo.externalId).toBe("vA");
  });
});

describe("vidIQ provider via a fake caller", () => {
  const caller: VidiqCaller = async (tool, args) => {
    switch (tool) {
      case "vidiq_outliers":
        // breakout join passes channelIds; niche outliers pass keyword
        return JSON.stringify(args.channelIds ? CHANNEL_VIDEOS : OUTLIERS);
      case "vidiq_trending_videos":
        return JSON.stringify(TRENDING);
      case "vidiq_keyword_research":
        return JSON.stringify(KEYWORDS);
      case "vidiq_channel_search":
        return JSON.stringify(CHANNELS);
      case "vidiq_video_transcript":
        if (args.videoId === "missing") throw new Error("No transcript available for video missing.");
        if (args.videoId === "boom") throw new Error("upstream 500");
        return "the scouted transcript text";
      default:
        throw new Error(`unexpected tool ${tool}`);
    }
  };
  const research = createVidIQResearchProvider(caller);

  it("wires each method to its tool", async () => {
    expect((await research.outliers("everyday science"))[0]!.externalId).toBe("frqP1yWVRD8");
    expect((await research.trendingVideos("everyday science"))[0]!.format).toBe("shorts");
    expect((await research.keywords("everyday science"))[0]!.keyword).toBe("everyday science");
    const breakout = await research.breakoutChannels("everyday science");
    expect(breakout[0]!.topVideo.externalId).toBe("vA");
  });

  it("returns transcript text, null when unavailable, and rethrows real errors", async () => {
    expect(await research.transcript("vA")).toBe("the scouted transcript text");
    expect(await research.transcript("missing")).toBeNull();
    await expect(research.transcript("boom")).rejects.toThrow(/500/);
  });
});
