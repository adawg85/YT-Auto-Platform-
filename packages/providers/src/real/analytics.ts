import type { AnalyticsProvider, ChannelStats, YouTubeAuthResolver } from "../types";

type Report = { columnHeaders?: { name: string }[]; rows?: (number | string)[][] };

/** First-row value of a named metric column, or null. */
export function reportCol(rep: Report | null, name: string): number | null {
  if (!rep?.columnHeaders) return null;
  const i = rep.columnHeaders.findIndex((c) => c.name === name);
  const row = rep.rows?.[0];
  return i >= 0 && row && row[i] !== undefined ? Number(row[i]) : null;
}

/**
 * Audience-retention report → a 0-100 relative-retention curve, curve[0]≈100.
 * YouTube returns `audienceWatchRatio` (≈1.0 at the start) at even
 * `elapsedVideoTimeRatio` steps; we scale to percent and round. Null if the
 * report is empty (brand-new video, or the scope doesn't grant retention).
 */
export function parseRetentionCurve(rep: Report | null): number[] | null {
  if (!rep?.columnHeaders || !rep.rows?.length) return null;
  const ratioI = rep.columnHeaders.findIndex((c) => c.name === "elapsedVideoTimeRatio");
  const watchI = rep.columnHeaders.findIndex((c) => c.name === "audienceWatchRatio");
  if (watchI < 0) return null;
  const points = rep.rows
    .map((r) => ({
      at: ratioI >= 0 ? Number(r[ratioI]) : 0,
      pct: Math.round(Number(r[watchI]) * 100),
    }))
    .filter((p) => Number.isFinite(p.pct))
    .sort((a, b) => a.at - b.at)
    .map((p) => p.pct);
  return points.length ? points : null;
}

/** Traffic-source report → [{ source, views }] descending, or null. */
export function parseTrafficSources(rep: Report | null): { source: string; views: number }[] | null {
  if (!rep?.columnHeaders || !rep.rows?.length) return null;
  const srcI = rep.columnHeaders.findIndex((c) => c.name === "insightTrafficSourceType");
  const viewsI = rep.columnHeaders.findIndex((c) => c.name === "views");
  if (srcI < 0 || viewsI < 0) return null;
  const out = rep.rows
    .map((r) => ({ source: String(r[srcI] ?? "UNKNOWN"), views: Number(r[viewsI] ?? 0) }))
    .filter((s) => s.views > 0)
    .sort((a, b) => b.views - a.views);
  return out.length ? out : null;
}

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

      const startDate = publishedAt.slice(0, 10);
      const endDate = new Date().toISOString().slice(0, 10);
      // Each metric group is a SEPARATE report. A metric/dimension one OAuth
      // scope doesn't grant (retention, traffic) fails only its own request, so
      // an unsupported field never nulls the ones that do work. `required`
      // reports throw (auth/scope failure the caller must see); the rest are
      // best-effort (→ null).
      const report = async (params: Record<string, string>, required: boolean): Promise<Report | null> => {
        try {
          const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
          url.searchParams.set("ids", "channel==MINE");
          url.searchParams.set("startDate", startDate);
          url.searchParams.set("endDate", endDate);
          url.searchParams.set("filters", `video==${providerVideoId}`);
          for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
          const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!res.ok) {
            if (required) throw new Error(`YouTube Analytics query failed (${res.status}): ${await res.text()}`);
            return null;
          }
          return (await res.json()) as Report;
        } catch (e) {
          if (required) throw e;
          return null; // best-effort metric — degrade to null, don't break the snapshot
        }
      };

      const [basic, engagement, retention, traffic] = await Promise.all([
        report({ metrics: "views,averageViewDuration,averageViewPercentage" }, true),
        // watch time + subs + engagement (one report; all standard metrics)
        report({ metrics: "estimatedMinutesWatched,subscribersGained,likes,comments,shares" }, false),
        // audience-retention curve — the highest-value drill-down (ticket 01KY1VEZ…)
        report(
          { metrics: "audienceWatchRatio", dimensions: "elapsedVideoTimeRatio", sort: "elapsedVideoTimeRatio" },
          false,
        ),
        // where the views came from
        report({ metrics: "views", dimensions: "insightTrafficSourceType", sort: "-views" }, false),
      ]);

      return {
        // prefer the near-real-time Data-API count; fall back to Analytics
        views: liveViews ?? reportCol(basic, "views") ?? 0,
        avgViewDurationSec: reportCol(basic, "averageViewDuration"),
        avgViewPct: reportCol(basic, "averageViewPercentage"),
        // NOT available via the YouTube Analytics API v2 — impressions and
        // impressionClickThroughRate (CTR) are YouTube Studio-only metrics. They
        // require the Reporting API bulk exports or manual entry, not this report.
        // Left null deliberately (see the ticket resolution for the plan).
        ctr: null,
        impressions: null,
        estimatedMinutesWatched: reportCol(engagement, "estimatedMinutesWatched"),
        subsGained: reportCol(engagement, "subscribersGained"),
        likes: reportCol(engagement, "likes"),
        comments: reportCol(engagement, "comments"),
        shares: reportCol(engagement, "shares"),
        retentionCurve: parseRetentionCurve(retention),
        trafficSources: parseTrafficSources(traffic),
        raw: { liveViews, basic, engagement, retention, traffic },
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
      const agg = await report({ metrics: "views,subscribersGained,averageViewPercentage,estimatedMinutesWatched" });
      const aggRow = agg.rows?.[0] ?? [];
      const aggCol = (name: string) => {
        const i = agg.columnHeaders.findIndex((c) => c.name === name);
        return i >= 0 && aggRow[i] !== undefined ? Number(aggRow[i]) : null;
      };

      // Current total subscriber count (Data API v3, fail-soft — 1 quota unit).
      let subscriberCount: number | null = null;
      try {
        const cres = await fetch(
          "https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true",
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (cres.ok) {
          const cjson = (await cres.json()) as { items?: { statistics?: { subscriberCount?: string } }[] };
          const sc = cjson.items?.[0]?.statistics?.subscriberCount;
          if (sc != null) subscriberCount = Number(sc);
        }
      } catch {
        // ignore — subscriber count stays null
      }

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
        estimatedMinutesWatched: aggCol("estimatedMinutesWatched"),
        subscriberCount,
        dailyViews,
        raw: { startDate, endDate, aggHeaders: agg.columnHeaders, aggRows: agg.rows ?? [] },
      };
    },
  };
}
