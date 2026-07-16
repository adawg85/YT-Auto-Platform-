import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  alerts,
  analyticsSnapshots,
  channels,
  costRecords,
  ideas,
  productions,
  publications,
  reviewGates,
} from "@ytauto/db";
import type { ChannelStats, Providers } from "@ytauto/providers";
import { getAppContext } from "@/lib/context";
import { alertKindLabel, prodStatusLabel } from "@/lib/format";
import { WAITING_STATUSES, WORKING_STATUSES, type StatusSummary } from "@/lib/status";

const DAY = 86_400_000;
const TIERS = ["T0 manual", "T1 assisted", "T2 supervised", "T3 exception-only"];
export const tierLabel = (t: number) => TIERS[t] ?? `T${t}`;

/** Estimated revenue assumption until real AdSense/analytics revenue is wired:
 * $/1000 views. Global default, override with EST_RPM; make per-channel later. */
export const EST_RPM = Number(process.env.EST_RPM ?? 3);

function dayKey(d: Date | string | null): string {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

/** last N day-keys, oldest first */
function lastDays(n: number): string[] {
  // Anchor to UTC midnight of "today" derived from the newest possible row.
  const out: string[] = [];
  const base = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(new Date(base - i * DAY).toISOString().slice(0, 10));
  return out;
}

function bucket(days: string[], rows: { day: string; v: number }[]): number[] {
  const m = new Map(days.map((d) => [d, 0]));
  for (const r of rows) if (m.has(r.day)) m.set(r.day, (m.get(r.day) ?? 0) + r.v);
  return days.map((d) => m.get(d) ?? 0);
}

/** Rolling window for the portfolio "30d" KPIs + channel-card views. */
const STATS_WINDOW_DAYS = 30;

/**
 * Channel-level views/subs/retention come STRAIGHT FROM YouTube (Analytics API)
 * — not reconstructed by summing per-video snapshots, which double-counted the
 * cumulative snapshot rows and inflated the numbers ~100×. YouTube analytics
 * only refreshes daily, so a short module-level memo keeps the (force-dynamic)
 * overview from firing N live API calls on every render. A failed fetch (no
 * creds / API error) falls back to the last cached value, else null → zeros.
 */
const CHANNEL_STATS_TTL_MS = 30 * 60_000;
const channelStatsCache = new Map<string, { at: number; stats: ChannelStats }>();

async function getChannelStats(
  providers: Providers,
  channelId: string,
  sinceDays: number,
): Promise<ChannelStats | null> {
  const key = `${channelId}:${sinceDays}`;
  const hit = channelStatsCache.get(key);
  if (hit && Date.now() - hit.at < CHANNEL_STATS_TTL_MS) return hit.stats;
  try {
    const stats = await providers.analytics.fetchChannelStats({ channelId, sinceDays });
    channelStatsCache.set(key, { at: Date.now(), stats });
    return stats;
  } catch (err) {
    if (hit) return hit.stats; // serve stale rather than blank on a transient error
    console.warn(`[overview] channel stats unavailable for ${channelId}:`, (err as Error).message);
    return null;
  }
}

export type ChannelCard = {
  id: string;
  name: string;
  handle: string;
  niche: string;
  tier: number;
  status: string;
  connected: boolean;
  avatarKey: string | null;
  views30: number;
  retention: number | null;
  published7: number;
  totalPublished: number;
  scheduled: number;
  inPipeline: number;
  costWeek: number;
  spark: number[];
};

export type AttentionItem = {
  kind: "gate" | "alert";
  severity: "info" | "warn" | "crit";
  title: string;
  sub: string;
  href: string;
  when: Date;
};

export async function loadPortfolio() {
  const { db, providers } = await getAppContext();
  const now = Date.now();
  const d30 = new Date(now - 30 * DAY);
  const d7 = new Date(now - 7 * DAY);
  const days14 = lastDays(14);

  const chans = await db.select().from(channels);

  // --- cost aggregates ---
  const costAll = await db
    .select({
      channelId: costRecords.channelId,
      createdAt: costRecords.createdAt,
      cost: costRecords.costUsd,
    })
    .from(costRecords);

  let spend30 = 0;
  const costWeekBy = new Map<string, number>();
  const spendByDay = new Map<string, number>();
  for (const r of costAll) {
    const c = Number(r.cost);
    const created = r.createdAt ? new Date(r.createdAt) : null;
    if (created && created >= d30) spend30 += c;
    if (created && created >= d7) costWeekBy.set(r.channelId, (costWeekBy.get(r.channelId) ?? 0) + c);
    const k = dayKey(created);
    if (k) spendByDay.set(k, (spendByDay.get(k) ?? 0) + c);
  }
  const spendSeries = days14.map((d) => Number((spendByDay.get(d) ?? 0).toFixed(2)));

  // --- publications (published counts) ---
  const pubs = await db
    .select({ id: publications.id, productionId: publications.productionId, publishedAt: publications.publishedAt })
    .from(publications);
  const published7 = pubs.filter((p) => p.publishedAt && new Date(p.publishedAt) >= d7).length;

  // production → channel (to attribute analytics + published counts per channel)
  const prodRows = await db
    .select({ id: productions.id, channelId: productions.channelId, status: productions.status })
    .from(productions);
  const prodChannel = new Map(prodRows.map((p) => [p.id, p.channelId]));
  const publishedByChannel = new Map<string, number>();
  for (const p of pubs) {
    if (!(p.publishedAt && new Date(p.publishedAt) >= d7)) continue;
    const ch = prodChannel.get(p.productionId);
    if (ch) publishedByChannel.set(ch, (publishedByChannel.get(ch) ?? 0) + 1);
  }

  // --- channel-level views/subs/retention: STRAIGHT FROM YouTube ---
  // Per connected channel, YouTube's real windowed totals (Analytics API),
  // memoised ~30 min. This replaces the old summing of per-video cumulative
  // snapshots, which double-counted (~4 snapshots/day × 30 days) and inflated
  // "Views 30d" by orders of magnitude. Channels with no creds → skipped (0).
  const statsByChannel = new Map<string, ChannelStats>();
  await Promise.all(
    chans.map(async (c) => {
      const stats = await getChannelStats(providers, c.id, STATS_WINDOW_DAYS);
      if (stats) statsByChannel.set(c.id, stats);
    }),
  );

  let views30 = 0;
  let subs30 = 0;
  let retWeighted = 0; // Σ(avgViewPct × views) for a views-weighted portfolio retention
  let retWeight = 0;
  const viewsByChannel = new Map<string, number>();
  const viewsByDay = new Map<string, number>();
  for (const [ch, s] of statsByChannel) {
    views30 += s.views;
    subs30 += s.subsGained;
    viewsByChannel.set(ch, s.views);
    if (s.avgViewPct != null && s.views > 0) {
      retWeighted += s.avgViewPct * s.views;
      retWeight += s.views;
    }
    for (const d of s.dailyViews) viewsByDay.set(d.day, (viewsByDay.get(d.day) ?? 0) + d.views);
  }
  const viewsSeries = days14.map((d) => viewsByDay.get(d) ?? 0);
  const retention = retWeight ? retWeighted / retWeight : null;

  // --- needs-attention: pending gates + open alerts ---
  const gates = await db
    .select({ gate: reviewGates, production: productions, idea: ideas })
    .from(reviewGates)
    .innerJoin(productions, eq(reviewGates.productionId, productions.id))
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .where(eq(reviewGates.status, "pending"))
    .orderBy(desc(reviewGates.createdAt))
    .limit(20);
  const openAlerts = await db
    .select({ alert: alerts, channel: channels })
    .from(alerts)
    // leftJoin: platform-scoped alerts (#21.7 capacity) have no channel
    .leftJoin(channels, eq(alerts.channelId, channels.id))
    .where(eq(alerts.status, "open"))
    .orderBy(desc(alerts.createdAt))
    .limit(20);
  // productions that stalled or hard-failed — surfaced so they don't sit
  // invisibly on their last stage (soft = on_hold, hard = failed).
  const stalled = await db
    .select({ production: productions, idea: ideas, channel: channels })
    .from(productions)
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .innerJoin(channels, eq(productions.channelId, channels.id))
    .where(inArray(productions.status, ["failed", "on_hold"]))
    .orderBy(desc(productions.updatedAt))
    .limit(20);

  const attention: AttentionItem[] = [
    ...gates.map((g): AttentionItem => ({
      kind: "gate",
      severity: g.gate.kind === "thumbnail_review" ? "info" : "warn",
      title: g.gate.kind === "thumbnail_review" ? "Final review" : "Script review",
      sub: g.idea.title,
      href: `/productions/${g.production.id}`,
      when: new Date(g.gate.createdAt),
    })),
    ...openAlerts.map((a): AttentionItem => ({
      kind: "alert",
      severity: a.alert.severity === "critical" ? "crit" : a.alert.severity === "warning" ? "warn" : "info",
      title: alertKindLabel(a.alert.kind),
      sub: `${a.alert.message} · ${a.channel?.name ?? "Platform"}`,
      href: a.channel ? `/channels/${a.channel.id}` : "/alerts",
      when: new Date(a.alert.createdAt),
    })),
    ...stalled.map((s): AttentionItem => ({
      kind: "alert",
      severity: s.production.status === "failed" ? "crit" : "warn",
      title: s.production.status === "failed" ? "Production failed" : "Production on hold",
      sub: `${s.idea.title}${s.production.failureReason ? ` — ${s.production.failureReason}` : ""} · ${s.channel.name}`,
      href: `/productions/${s.production.id}`,
      when: new Date(s.production.updatedAt),
    })),
  ]
    .sort((x, y) => y.when.getTime() - x.when.getTime())
    .slice(0, 8);

  const pendingGateCount = gates.length;

  // all-time published + in-flight/scheduled counts per channel (cheap, from
  // the rows already loaded) — richer channel-card metrics.
  const totalPublishedByChannel = new Map<string, number>();
  for (const p of pubs) {
    if (!p.publishedAt) continue;
    const ch = prodChannel.get(p.productionId);
    if (ch) totalPublishedByChannel.set(ch, (totalPublishedByChannel.get(ch) ?? 0) + 1);
  }
  const scheduledByChannel = new Map<string, number>();
  const inPipelineByChannel = new Map<string, number>();
  for (const p of prodRows) {
    if (p.status === "scheduled") scheduledByChannel.set(p.channelId, (scheduledByChannel.get(p.channelId) ?? 0) + 1);
    if ((WORKING_STATUSES as readonly string[]).includes(p.status))
      inPipelineByChannel.set(p.channelId, (inPipelineByChannel.get(p.channelId) ?? 0) + 1);
  }

  // --- per-channel cards ---
  const cards: ChannelCard[] = chans.map((c) => {
    const s = statsByChannel.get(c.id);
    return {
      id: c.id,
      name: c.name,
      handle: c.handle,
      niche: c.niche,
      tier: c.autonomyTier,
      status: c.status,
      connected: !!c.youtubeChannelId,
      avatarKey: c.avatarKey ?? null,
      views30: s?.views ?? 0,
      retention: s?.avgViewPct ?? null,
      published7: publishedByChannel.get(c.id) ?? 0,
      totalPublished: totalPublishedByChannel.get(c.id) ?? 0,
      scheduled: scheduledByChannel.get(c.id) ?? 0,
      inPipeline: inPipelineByChannel.get(c.id) ?? 0,
      costWeek: costWeekBy.get(c.id) ?? 0,
      spark: buildChannelSpark(c.id, costAll, days14),
    };
  });

  // --- system-status strip counts (task #21) ---
  const countBy = (keys: readonly string[]) => prodRows.filter((p) => keys.includes(p.status)).length;
  const systemStatus: StatusSummary = {
    working: countBy(WORKING_STATUSES),
    waiting: countBy(WAITING_STATUSES),
    scheduled: countBy(["scheduled"]),
    failed: countBy(["failed"]),
  };

  // pipeline health: in-flight productions grouped by their current stage.
  const activeStatuses = new Set<string>([...WORKING_STATUSES, ...WAITING_STATUSES]);
  const stageCount = new Map<string, number>();
  for (const p of prodRows) if (activeStatuses.has(p.status)) stageCount.set(p.status, (stageCount.get(p.status) ?? 0) + 1);
  const pipeline = [...stageCount.entries()]
    .map(([status, count]) => ({ stage: prodStatusLabel(status), waiting: WAITING_STATUSES.includes(status as never), count }))
    .sort((a, b) => b.count - a.count);

  // profitability estimate (until real revenue is wired): views × RPM.
  const estRevenue30 = (views30 * EST_RPM) / 1000;

  return {
    systemStatus,
    pipeline,
    kpis: {
      views30,
      subs30,
      retention,
      published7,
      spend30,
      estRevenue30,
      estNet30: estRevenue30 - spend30,
      estRpm: EST_RPM,
      needsReview: pendingGateCount + openAlerts.length + stalled.length,
      pendingScripts: gates.filter((g) => g.gate.kind === "script_review").length,
      pendingFinals: gates.filter((g) => g.gate.kind === "thumbnail_review").length,
    },
    spendSeries,
    viewsSeries,
    hasTrend: viewsSeries.some((v) => v > 0) || spendSeries.some((v) => v > 0),
    attention,
    cards,
  };
}

function buildChannelSpark(
  channelId: string,
  costAll: { channelId: string; createdAt: unknown; cost: string }[],
  days: string[],
): number[] {
  const rows = costAll
    .filter((r) => r.channelId === channelId && r.createdAt)
    .map((r) => ({ day: dayKey(r.createdAt as Date), v: Number(r.cost) }));
  const b = bucket(days, rows);
  return b.some((v) => v > 0) ? b : days.map(() => 0);
}

export type TopVideo = {
  publicationId: string;
  productionId: string;
  title: string;
  channelId: string;
  channelName: string;
  videoId: string | null;
  publishedAt: string | null;
  views: number;
  retention: number | null;
  ctr: number | null;
  impressions: number | null;
  subsGained: number | null;
};

/**
 * Published videos with their latest analytics snapshot — feeds the sortable
 * top-videos performance strip. Sortable/filterable client-side; impressions/
 * CTR are null until the analytics ingest supplies them.
 */
export async function loadTopVideos(limit = 25): Promise<TopVideo[]> {
  const { db } = await getAppContext();
  const rows = await db
    .select({
      publicationId: publications.id,
      productionId: publications.productionId,
      videoId: publications.providerVideoId,
      publishedAt: publications.publishedAt,
      title: ideas.title,
      channelId: channels.id,
      channelName: channels.name,
    })
    .from(publications)
    .innerJoin(productions, eq(publications.productionId, productions.id))
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .innerJoin(channels, eq(productions.channelId, channels.id))
    .where(isNotNull(publications.publishedAt));

  const snaps = await db
    .select({
      publicationId: analyticsSnapshots.publicationId,
      capturedAt: analyticsSnapshots.capturedAt,
      views: analyticsSnapshots.views,
      avgViewPct: analyticsSnapshots.avgViewPct,
      ctr: analyticsSnapshots.ctr,
      impressions: analyticsSnapshots.impressions,
      subsGained: analyticsSnapshots.subsGained,
    })
    .from(analyticsSnapshots);
  const latest = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) {
    const cur = latest.get(s.publicationId);
    if (!cur || new Date(s.capturedAt) > new Date(cur.capturedAt)) latest.set(s.publicationId, s);
  }

  return rows
    .map((r): TopVideo => {
      const s = latest.get(r.publicationId);
      return {
        publicationId: r.publicationId,
        productionId: r.productionId,
        title: r.title,
        channelId: r.channelId,
        channelName: r.channelName,
        videoId: r.videoId ?? null,
        publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
        views: s?.views ?? 0,
        retention: s?.avgViewPct ?? null,
        ctr: s?.ctr ?? null,
        impressions: s?.impressions ?? null,
        subsGained: s?.subsGained ?? null,
      };
    })
    .sort((a, b) => b.views - a.views)
    .slice(0, limit);
}
