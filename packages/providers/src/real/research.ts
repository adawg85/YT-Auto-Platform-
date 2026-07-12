import type {
  BreakoutChannel,
  KeywordStat,
  OutlierVideo,
  ResearchProvider,
  TrendingVideo,
} from "../types";

/**
 * Real research adapter backed by vidIQ. vidIQ ships an MCP server (not a REST
 * API), so the transport is an MCP client; this module keeps the vidIQ→
 * ResearchProvider mapping pure and transport-agnostic behind a `VidiqCaller`,
 * so the mapping is unit-tested against real captured fixtures while the
 * transport (see ./vidiq-mcp) stays a thin, swappable layer.
 *
 * Tool → method mapping (each vidIQ call costs credits, so we stay frugal):
 *   outliers        → vidiq_outliers
 *   keywords        → vidiq_keyword_research
 *   trendingVideos  → vidiq_trending_videos
 *   breakoutChannels→ vidiq_channel_search (breakoutChannel) + one vidiq_outliers
 *                     join to resolve each channel's top video
 *   transcript      → vidiq_video_transcript (Shorts often lack captions → null)
 */

/**
 * Calls a vidIQ tool and returns the first content block's raw text. Throws
 * Error(message) when the tool reports an error (e.g. "No transcript
 * available"), which callers may catch and interpret.
 */
export type VidiqCaller = (tool: string, args: Record<string, unknown>) => Promise<string>;

const YT_WATCH = "https://www.youtube.com/watch?v=";

/** vidIQ mixes Unix-seconds (outliers) and ISO strings (trending) for dates. */
export function vidiqDateToIso(v: number | string | null | undefined): string {
  if (v == null) return new Date(0).toISOString();
  if (typeof v === "number") return new Date(v * 1000).toISOString();
  return v;
}

// ── Raw vidIQ response shapes (only the fields we consume) ────────────────

type VidiqOutlier = {
  videoId: string;
  videoTitle: string;
  channelId?: string;
  channelTitle: string;
  viewCount: number;
  vph?: number;
  breakoutScore?: number;
  videoPublishedAt: number | string;
};
type VidiqTrending = {
  videoId: string;
  videoTitle: string;
  channelTitle: string;
  viewCount: number;
  vph?: number;
  engagementRate?: number;
  videoPublishedAt: number | string;
};
type VidiqKeyword = { keyword: string; estimatedMonthlySearch?: number; competition?: number };
type VidiqChannel = {
  channelId: string;
  channelTitle: string;
  niche?: string;
  subscriberCount?: number;
  subsGrowth30d?: number;
  shortVideoCount30d?: number;
};

// ── Pure mappers (exported for tests) ─────────────────────────────────────

export function mapOutliers(raw: { videos?: VidiqOutlier[] }): OutlierVideo[] {
  return (raw.videos ?? []).map((v) => ({
    externalId: v.videoId,
    title: v.videoTitle,
    channelName: v.channelTitle,
    views: v.viewCount ?? 0,
    viewsPerHour: v.vph,
    publishedAt: vidiqDateToIso(v.videoPublishedAt),
    outlierFactor: v.breakoutScore ?? 0,
    url: `${YT_WATCH}${v.videoId}`,
  }));
}

export function mapTrending(raw: { videos?: VidiqTrending[] }): TrendingVideo[] {
  return (raw.videos ?? []).map((v) => ({
    externalId: v.videoId,
    title: v.videoTitle,
    channelName: v.channelTitle,
    views: v.viewCount ?? 0,
    viewsPerHour: v.vph ?? 0,
    engagementRate: v.engagementRate ?? 0,
    publishedAt: vidiqDateToIso(v.videoPublishedAt),
    format: "shorts",
  }));
}

export function mapKeywords(raw: {
  seedKeyword?: VidiqKeyword;
  relatedKeywords?: VidiqKeyword[];
}): KeywordStat[] {
  const all = [raw.seedKeyword, ...(raw.relatedKeywords ?? [])].filter(
    (k): k is VidiqKeyword => Boolean(k?.keyword),
  );
  // vidIQ competition is 0-100; normalise to 0-1 to match the mock's scale
  return all.map((k) => ({
    keyword: k.keyword,
    monthlyVolume: Math.round(k.estimatedMonthlySearch ?? 0),
    competition: Math.round(((k.competition ?? 0) / 100) * 100) / 100,
  }));
}

/**
 * Join breakout channels to their top short (from a single outliers call keyed
 * by channelIds). Channels with no resolvable top video are dropped — the
 * engine needs a video to analyse.
 */
export function mapBreakoutChannels(
  niche: string,
  channelsRaw: { channels?: VidiqChannel[] },
  videosRaw: { videos?: VidiqOutlier[] },
): BreakoutChannel[] {
  const bestByChannel = new Map<string, VidiqOutlier>();
  for (const v of videosRaw.videos ?? []) {
    if (!v.channelId) continue;
    const cur = bestByChannel.get(v.channelId);
    if (!cur || (v.vph ?? 0) > (cur.vph ?? 0)) bestByChannel.set(v.channelId, v);
  }

  const out: BreakoutChannel[] = [];
  for (const c of channelsRaw.channels ?? []) {
    const top = bestByChannel.get(c.channelId);
    if (!top) continue;
    out.push({
      externalId: c.channelId,
      channelName: c.channelTitle,
      niche: c.niche ?? niche,
      subscribers: c.subscriberCount ?? 0,
      growthRate: Math.round((c.subsGrowth30d ?? 0) * 10) / 10,
      publishedPerWeek: Math.round((c.shortVideoCount30d ?? 0) / 4.3),
      topVideo: {
        externalId: top.videoId,
        title: top.videoTitle,
        views: top.viewCount ?? 0,
        viewsPerHour: top.vph ?? 0,
        publishedAt: vidiqDateToIso(top.videoPublishedAt),
      },
    });
  }
  return out;
}

async function callJson<T>(
  caller: VidiqCaller,
  tool: string,
  args: Record<string, unknown>,
): Promise<T> {
  return JSON.parse(await caller(tool, args)) as T;
}

export function createVidIQResearchProvider(
  caller: VidiqCaller,
  opts: { outlierLimit?: number; trendingLimit?: number; breakoutLimit?: number } = {},
): ResearchProvider {
  const outlierLimit = opts.outlierLimit ?? 20;
  const trendingLimit = opts.trendingLimit ?? 15;
  const breakoutLimit = opts.breakoutLimit ?? 5;

  return {
    name: "vidiq-research",

    async outliers(niche) {
      const raw = await callJson<{ videos?: VidiqOutlier[] }>(caller, "vidiq_outliers", {
        keyword: niche,
        contentType: "short",
        limit: outlierLimit,
        sort: "breakoutScore",
      });
      return mapOutliers(raw);
    },

    async keywords(seed) {
      const raw = await callJson<{ seedKeyword?: VidiqKeyword; relatedKeywords?: VidiqKeyword[] }>(
        caller,
        "vidiq_keyword_research",
        { keyword: seed, mode: "research" },
      );
      return mapKeywords(raw);
    },

    async trendingVideos(niche) {
      const raw = await callJson<{ videos?: VidiqTrending[] }>(caller, "vidiq_trending_videos", {
        videoFormat: "short",
        titleQuery: niche,
        // 2026-07-12 (validated against live vidIQ): titleQuery is a loose
        // semantic match — "aviation history" bled in unrelated football
        // shorts. Require every term so a high-velocity off-topic video can't
        // dominate the niche feed.
        requireAllTitleTerms: true,
        sortBy: "vph",
        limit: trendingLimit,
      });
      return mapTrending(raw);
    },

    async breakoutChannels(niche) {
      const channelsRaw = await callJson<{ channels?: VidiqChannel[] }>(
        caller,
        "vidiq_channel_search",
        { query: niche, breakoutChannel: true, channelType: "short", limit: breakoutLimit },
      );
      const channelIds = (channelsRaw.channels ?? []).map((c) => c.channelId);
      if (channelIds.length === 0) return [];
      // one join call resolves a top short per channel
      const videosRaw = await callJson<{ videos?: VidiqOutlier[] }>(caller, "vidiq_outliers", {
        channelIds,
        contentType: "short",
        limit: Math.min(100, channelIds.length * 3),
        sort: "vph",
      });
      return mapBreakoutChannels(niche, channelsRaw, videosRaw);
    },

    // BACKLOG #22 cross-niche discovery: vidIQ's global trends surface, no
    // niche input. Payload parsing is defensive — the MCP tools' exact schema
    // isn't a stable contract.
    async trendCategories() {
      const raw = await callJson<{
        categories?: Array<{
          category?: string;
          name?: string;
          momentum?: number;
          score?: number;
          sampleTitles?: string[];
          videos?: Array<{ title?: string }>;
        }>;
      }>(caller, "vidiq_trend_categories", {});
      return (raw.categories ?? [])
        .map((c) => ({
          category: (c.category ?? c.name ?? "").trim(),
          momentum: typeof c.momentum === "number" ? c.momentum : c.score,
          sampleTitles:
            c.sampleTitles ?? c.videos?.map((v) => v.title ?? "").filter(Boolean) ?? undefined,
        }))
        .filter((c) => c.category.length > 0);
    },

    async globalBreakoutChannels() {
      const raw = await callJson<{
        channels?: Array<{
          channelId?: string;
          title?: string;
          name?: string;
          niche?: string;
          category?: string;
          subscriberCount?: number;
          subscribers?: number;
          growthRate?: number;
          videosPerWeek?: number;
        }>;
      }>(caller, "vidiq_breakout_channels", { limit: breakoutLimit * 3 });
      return (raw.channels ?? [])
        .filter((c) => c.channelId)
        .map((c) => ({
          externalId: c.channelId!,
          channelName: c.title ?? c.name ?? "unknown",
          niche: c.niche ?? c.category ?? "",
          subscribers: c.subscriberCount ?? c.subscribers ?? 0,
          growthRate: c.growthRate ?? 0,
          publishedPerWeek: c.videosPerWeek ?? 0,
          topVideo: { externalId: "", title: "", views: 0, viewsPerHour: 0, publishedAt: "" },
        }));
    },

    async transcript(externalId) {
      try {
        const text = await caller("vidiq_video_transcript", { videoId: externalId });
        const trimmed = text.trim();
        // some tools wrap payloads as JSON; a transcript may come back as raw
        // text or as a JSON string/object — normalise to plain text
        if (trimmed.startsWith("{") || trimmed.startsWith("\"")) {
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (typeof parsed === "string") return parsed || null;
            if (parsed && typeof parsed === "object" && "transcript" in parsed) {
              const t = (parsed as { transcript?: unknown }).transcript;
              return typeof t === "string" ? t || null : null;
            }
          } catch {
            // not JSON — fall through to raw text
          }
        }
        return trimmed || null;
      } catch (err) {
        // Shorts frequently have no captions — that's a normal null, not a failure
        if (err instanceof Error && /no transcript/i.test(err.message)) return null;
        throw err;
      }
    },
  };
}
