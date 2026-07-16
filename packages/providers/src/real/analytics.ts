import type { AnalyticsProvider, ChannelStats, YouTubeAuthResolver } from "../types";

async function getAccessToken(auth: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      refresh_token: auth.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`YouTube OAuth refresh failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * YouTube Analytics API v2 per-video stats. Requires the
 * yt-analytics.readonly scope on the channel's OAuth grant (the cockpit's
 * connect flow requests it). Analytics API has its own free quota — no
 * Data-API units consumed.
 */
export function createYouTubeAnalyticsProvider(
  resolveAuth: YouTubeAuthResolver,
): AnalyticsProvider {
  return {
    name: "youtube-analytics",
    async fetchVideoStats({ channelId, providerVideoId, publishedAt }) {
      const auth = await resolveAuth(channelId);
      if (!auth) {
        throw new Error(`Channel ${channelId} has no YouTube credentials for analytics`);
      }
      const accessToken = await getAccessToken(auth);

      // Near-real-time LIFETIME view count from the Data API v3 (this matches
      // YouTube Studio's public number within minutes). The Analytics reporting
      // API below lags ~2-3 days and returns empty rows for brand-new videos,
      // so on its own it reports 0 views until the data finishes processing.
      // videos.list?part=statistics costs 1 quota unit and works with the same
      // OAuth token. Fails soft → we fall back to the Analytics `views` metric.
      let liveViews: number | null = null;
      try {
        const vres = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(providerVideoId)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (vres.ok) {
          const vjson = (await vres.json()) as { items?: { statistics?: { viewCount?: string } }[] };
          const vc = vjson.items?.[0]?.statistics?.viewCount;
          if (vc != null) liveViews = Number(vc);
        }
      } catch {
        // ignore — fall back to the Analytics reporting metric
      }

      const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
      url.searchParams.set("ids", "channel==MINE");
      url.searchParams.set("startDate", publishedAt.slice(0, 10));
      url.searchParams.set("endDate", new Date().toISOString().slice(0, 10));
      url.searchParams.set("metrics", "views,averageViewDuration,averageViewPercentage");
      url.searchParams.set("filters", `video==${providerVideoId}`);

      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        throw new Error(`YouTube Analytics query failed (${res.status}): ${await res.text()}`);
      }
      const json = (await res.json()) as {
        columnHeaders: { name: string }[];
        rows?: (number | string)[][];
      };
      const row = json.rows?.[0] ?? [];
      const col = (name: string) => {
        const i = json.columnHeaders.findIndex((c) => c.name === name);
        return i >= 0 && row[i] !== undefined ? Number(row[i]) : null;
      };
      return {
        // prefer the near-real-time Data-API count; fall back to Analytics
        views: liveViews ?? col("views") ?? 0,
        avgViewDurationSec: col("averageViewDuration"),
        avgViewPct: col("averageViewPercentage"),
        ctr: null, // impressions CTR needs a separate report; Phase 5
        // Thumbnail impressions are a YouTube Studio metric; whether the
        // Analytics API v2 exposes them for this channel needs a live probe
        // (adding an unsupported metric would fail the whole report). Until
        // verified on a real channel, report null — the viability policy
        // treats that as "unknown" rather than silently passing/failing.
        impressions: null,
        raw: { liveViews, columnHeaders: json.columnHeaders, rows: json.rows ?? [] },
      };
    },

    async fetchChannelStats({ channelId, sinceDays }): Promise<ChannelStats> {
      const auth = await resolveAuth(channelId);
      if (!auth) {
        throw new Error(`Channel ${channelId} has no YouTube credentials for analytics`);
      }
      const accessToken = await getAccessToken(auth);

      const end = new Date();
      const start = new Date(end.getTime() - sinceDays * 86_400_000);
      const startDate = start.toISOString().slice(0, 10);
      const endDate = end.toISOString().slice(0, 10);

      const report = async (params: Record<string, string>) => {
        const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
        url.searchParams.set("ids", "channel==MINE");
        url.searchParams.set("startDate", startDate);
        url.searchParams.set("endDate", endDate);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!res.ok) {
          throw new Error(`YouTube channel analytics query failed (${res.status}): ${await res.text()}`);
        }
        return (await res.json()) as {
          columnHeaders: { name: string }[];
          rows?: (number | string)[][];
        };
      };

      // Aggregate window totals (no dimension) — the genuine windowed numbers.
      const agg = await report({ metrics: "views,subscribersGained,averageViewPercentage" });
      const aggRow = agg.rows?.[0] ?? [];
      const aggCol = (name: string) => {
        const i = agg.columnHeaders.findIndex((c) => c.name === name);
        return i >= 0 && aggRow[i] !== undefined ? Number(aggRow[i]) : null;
      };

      // Per-day views for the trend chart (dimensions=day → [day, views]).
      const byDay = await report({ metrics: "views", dimensions: "day", sort: "day" });
      const dayI = byDay.columnHeaders.findIndex((c) => c.name === "day");
      const viewsI = byDay.columnHeaders.findIndex((c) => c.name === "views");
      const dailyViews = (byDay.rows ?? [])
        .map((r) => ({ day: String(r[dayI] ?? ""), views: Number(r[viewsI] ?? 0) }))
        .filter((d) => d.day);

      return {
        views: aggCol("views") ?? 0,
        subsGained: aggCol("subscribersGained") ?? 0,
        avgViewPct: aggCol("averageViewPercentage"),
        dailyViews,
        raw: { startDate, endDate, aggHeaders: agg.columnHeaders, aggRows: agg.rows ?? [] },
      };
    },
  };
}
