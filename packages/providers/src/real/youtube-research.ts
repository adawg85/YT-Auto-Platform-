import { Innertube } from "youtubei.js";
import type {
  BreakoutChannel,
  KeywordStat,
  OutlierVideo,
  ResearchProvider,
  TrendingVideo,
} from "../types";

/**
 * MIT-licensed research adapter backed by youtubei.js (LuanRT/YouTube.js), which
 * speaks YouTube's internal InnerTube API — no API key, no vendor credits.
 *
 * vidIQ sells proprietary *analytics* (outlier-vs-channel scoring, keyword
 * search volume) on top of raw YouTube data. YouTube exposes the raw data for
 * free; the analytics we reconstruct in-house, matching the platform's
 * "numbers from data, narrative from the LLM" philosophy:
 *   - outlierFactor  = a video's views ÷ the median of the niche result set
 *                      (a batch-relative over-performance proxy)
 *   - viewsPerHour   = views ÷ hours since publish
 * Two things vidIQ does that we can't from raw data: true search *volume*
 * (YouTube doesn't expose it → keyword volume is 0/unknown here) and historical
 * channel growth (subscriber deltas → breakout growthRate is 0/unknown; the
 * platform accumulates its own snapshots over time instead).
 *
 * Caveat: youtubei.js scrapes an unofficial API — keyless and MIT, but ToS-gray
 * and liable to break when YouTube changes shape. Extraction below is defensive.
 */

// ── Pure, tested helpers ──────────────────────────────────────────────────

/** Parse "1,234,567 views" / "1.2M views" / "3.4B" / "812" → integer. */
export function parseViewCount(text: string | undefined): number {
  if (!text) return 0;
  const m = /([\d,.]+)\s*([KMB])?/i.exec(text.trim());
  if (!m) return 0;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  const mult = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

const UNIT_HOURS: Record<string, number> = {
  second: 1 / 3600,
  minute: 1 / 60,
  hour: 1,
  day: 24,
  week: 168,
  month: 730, // ~30.4 days
  year: 8760,
};

/**
 * Parse a relative timestamp ("3 days ago", "5 hours ago") → hours (min 0.5),
 * or NULL when the text is missing/unparseable. 2026-07-12 accuracy fix: this
 * used to default to 1, which made velocity (views/ageHours) collapse to ==
 * views — YouTube's search API intermittently omits `published`, so every
 * video showed a fabricated "views/hour" equal to its total views and the
 * trending sort was meaningless. Unknown age now stays unknown.
 */
export function parseRelativeAgeHours(text: string | undefined): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/just now|moments? ago/.test(t)) return 0.5;
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?/.exec(t);
  if (!m) return null;
  const hours = Number(m[1]) * (UNIT_HOURS[m[2]!] ?? 1);
  return Math.max(0.5, Math.round(hours * 10) / 10);
}

export type NormalizedVideo = {
  externalId: string;
  title: string;
  channelId: string;
  channelName: string;
  views: number;
  /** hours since publish, or null when YouTube didn't return a publish age */
  ageHours: number | null;
};

/** views/hour when age is known, else undefined — never a fabricated number. */
function velocity(views: number, ageHours: number | null): number | undefined {
  return ageHours && ageHours > 0 ? Math.round(views / ageHours) : undefined;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function isoFromAgeHours(ageHours: number | null, now: Date): string | undefined {
  return ageHours == null ? undefined : new Date(now.getTime() - ageHours * 3_600_000).toISOString();
}

/** Map a normalised pool to outliers: over-performance vs the pool median. */
export function mapPoolToOutliers(pool: NormalizedVideo[], now: Date): OutlierVideo[] {
  const med = median(pool.map((v) => v.views).filter((v) => v > 0)) || 1;
  return pool.map((v) => ({
    externalId: v.externalId,
    title: v.title,
    channelName: v.channelName,
    views: v.views,
    viewsPerHour: velocity(v.views, v.ageHours),
    publishedAt: isoFromAgeHours(v.ageHours, now) ?? now.toISOString(),
    outlierFactor: Math.round((v.views / med) * 10) / 10,
    url: `https://www.youtube.com/watch?v=${v.externalId}`,
  }));
}

/**
 * Map a normalised pool to trending, ranked by velocity when known and by
 * raw views otherwise — a video with unknown age never jumps the ranking on
 * a fabricated velocity (2026-07-12 accuracy fix).
 */
export function mapPoolToTrending(pool: NormalizedVideo[], now: Date): TrendingVideo[] {
  const rank = (v: NormalizedVideo) => velocity(v.views, v.ageHours) ?? v.views / 720; // ~30-day floor
  return pool
    .map((v) => ({
      externalId: v.externalId,
      title: v.title,
      channelName: v.channelName,
      views: v.views,
      viewsPerHour: velocity(v.views, v.ageHours) ?? 0,
      engagementRate: 0, // likes/comments not in search results → unknown
      publishedAt: isoFromAgeHours(v.ageHours, now) ?? now.toISOString(),
      format: "shorts" as const,
    }))
    .map((t, i) => ({ t, r: rank(pool[i]!) }))
    .sort((a, b) => b.r - a.r)
    .map((x) => x.t);
}

/**
 * Group a pool by channel into breakout candidates (best video per channel).
 * Subscriber count + growth aren't in search results → 0/unknown; the engine
 * consumes topVideo, which is what matters for meta-analysis.
 */
export function groupPoolToBreakout(
  niche: string,
  pool: NormalizedVideo[],
  now: Date,
  limit: number,
): BreakoutChannel[] {
  // rank by velocity when known, else by raw views (unknown age never wins on
  // a fabricated number) — 2026-07-12 accuracy fix
  const score = (v: NormalizedVideo) => velocity(v.views, v.ageHours) ?? v.views / 720;
  const best = new Map<string, NormalizedVideo>();
  for (const v of pool) {
    if (!v.channelId) continue;
    const cur = best.get(v.channelId);
    if (!cur || score(v) > score(cur)) best.set(v.channelId, v);
  }
  return [...best.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map((v) => ({
      externalId: v.channelId,
      channelName: v.channelName,
      niche,
      subscribers: 0,
      growthRate: 0,
      publishedPerWeek: 0,
      topVideo: {
        externalId: v.externalId,
        title: v.title,
        views: v.views,
        viewsPerHour: velocity(v.views, v.ageHours) ?? 0,
        publishedAt: isoFromAgeHours(v.ageHours, now) ?? now.toISOString(),
      },
    }));
}

// ── Defensive extraction from youtubei.js nodes ───────────────────────────
// youtubei node shapes are large unions and version-fluid, so we read fields
// off a loose view rather than coupling to the exact generated types.

type LooseText = string | { text?: string } | undefined;
type LooseVideoNode = {
  type?: string;
  id?: string;
  video_id?: string;
  title?: LooseText;
  author?: { id?: string; name?: string };
  view_count?: LooseText;
  short_view_count?: LooseText;
  published?: LooseText;
};

function textOf(t: LooseText): string {
  if (!t) return "";
  return typeof t === "string" ? t : (t.text ?? "");
}

export function normalizeVideoNode(node: LooseVideoNode): NormalizedVideo | null {
  const externalId = node.id ?? node.video_id;
  const title = textOf(node.title);
  if (!externalId || !title) return null;
  const views = parseViewCount(textOf(node.view_count) || textOf(node.short_view_count));
  return {
    externalId,
    title,
    channelId: node.author?.id ?? "",
    channelName: node.author?.name ?? "unknown",
    views,
    ageHours: parseRelativeAgeHours(textOf(node.published)),
  };
}

// ── Provider ──────────────────────────────────────────────────────────────

export function createYouTubeResearchProvider(
  opts: { searchLimit?: number; breakoutLimit?: number; now?: () => Date } = {},
): ResearchProvider {
  const searchLimit = opts.searchLimit ?? 20;
  const breakoutLimit = opts.breakoutLimit ?? 5;
  const now = opts.now ?? (() => new Date());

  let ytPromise: Promise<Innertube> | null = null;
  const getYt = () => (ytPromise ??= Innertube.create());

  async function searchOnce(niche: string): Promise<NormalizedVideo[]> {
    const yt = await getYt();
    // short-duration recent videos give us Shorts-scale content while keeping
    // the reliable Video-node shape (view_count/published/author) we extract
    const search = await yt.search(niche, {
      type: "video",
      duration: "under_three_mins",
      upload_date: "month",
    });
    const nodes = (search.results ?? []) as unknown as LooseVideoNode[];
    const out: NormalizedVideo[] = [];
    for (const n of nodes) {
      const v = normalizeVideoNode(n);
      if (v) out.push(v);
      if (out.length >= searchLimit) break;
    }
    return out;
  }

  // one search per niche feeds outliers/trending/breakout (frugal on calls).
  // 2026-07-12: YouTube's InnerTube intermittently returns a node variant with
  // NO publish age (velocity then unknowable). If most of the pool lacks an
  // age, re-search ONCE — the cold response usually warms up — and keep the
  // pool with more usable ages.
  async function pool(niche: string): Promise<NormalizedVideo[]> {
    const first = await searchOnce(niche);
    const aged = (p: NormalizedVideo[]) => p.filter((v) => v.ageHours != null).length;
    if (first.length > 0 && aged(first) / first.length >= 0.5) return first;
    const second = await searchOnce(niche).catch(() => first);
    return aged(second) >= aged(first) ? second : first;
  }

  return {
    name: "youtube-research",

    async outliers(niche) {
      return mapPoolToOutliers(await pool(niche), now());
    },

    async trendingVideos(niche) {
      return mapPoolToTrending(await pool(niche), now());
    },

    async breakoutChannels(niche) {
      return groupPoolToBreakout(niche, await pool(niche), now(), breakoutLimit);
    },

    async keywords(seed) {
      const yt = await getYt();
      const suggestions = (await yt.getSearchSuggestions(seed)) as string[];
      // YouTube doesn't expose search volume → ideas only, metrics unknown (0)
      return suggestions.slice(0, 20).map((keyword) => ({
        keyword,
        monthlyVolume: 0,
        competition: 0,
      }));
    },

    async transcript(externalId) {
      try {
        const yt = await getYt();
        const info = await yt.getInfo(externalId);
        const transcript = await info.getTranscript();
        const segments =
          transcript?.transcript?.content?.body?.initial_segments ??
          ([] as Array<{ snippet?: { text?: string } }>);
        const text = segments
          .map((s) => s.snippet?.text ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        return text || null;
      } catch {
        // Shorts / disabled captions → no transcript (normal, not an error)
        return null;
      }
    },
  };
}
