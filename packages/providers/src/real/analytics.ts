import type { AnalyticsProvider, YouTubeAuthResolver } from "../types";

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
        views: col("views") ?? 0,
        avgViewDurationSec: col("averageViewDuration"),
        avgViewPct: col("averageViewPercentage"),
        ctr: null, // impressions CTR needs a separate report; Phase 5
        raw: { columnHeaders: json.columnHeaders, rows: json.rows ?? [] },
      };
    },
  };
}
