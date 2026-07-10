import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
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
import { getAppContext } from "@/lib/context";
import { alertKindLabel } from "@/lib/format";
import { WAITING_STATUSES, WORKING_STATUSES, type StatusSummary } from "@/lib/status";

const DAY = 86_400_000;
const TIERS = ["T0 manual", "T1 assisted", "T2 supervised", "T3 exception-only"];
export const tierLabel = (t: number) => TIERS[t] ?? `T${t}`;

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

export type ChannelCard = {
  id: string;
  name: string;
  handle: string;
  niche: string;
  tier: number;
  status: string;
  connected: boolean;
  views30: number;
  retention: number | null;
  published7: number;
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
  const { db } = await getAppContext();
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
  const pubProd = new Map(pubs.map((p) => [p.id, p.productionId]));
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

  // --- analytics snapshots (views + retention) ---
  const snaps = await db
    .select({
      publicationId: analyticsSnapshots.publicationId,
      capturedAt: analyticsSnapshots.capturedAt,
      views: analyticsSnapshots.views,
      avgViewPct: analyticsSnapshots.avgViewPct,
    })
    .from(analyticsSnapshots);

  let views30 = 0;
  let retSum = 0;
  let retN = 0;
  const viewsByDay = new Map<string, number>();
  const viewsByChannel = new Map<string, number>();
  const retByChannel = new Map<string, { sum: number; n: number }>();
  for (const s of snaps) {
    const captured = s.capturedAt ? new Date(s.capturedAt) : null;
    const ch = prodChannel.get(pubProd.get(s.publicationId) ?? "");
    if (captured && captured >= d30) {
      views30 += s.views ?? 0;
      if (ch) viewsByChannel.set(ch, (viewsByChannel.get(ch) ?? 0) + (s.views ?? 0));
    }
    if (s.avgViewPct != null) {
      retSum += s.avgViewPct;
      retN++;
      if (ch) {
        const r = retByChannel.get(ch) ?? { sum: 0, n: 0 };
        r.sum += s.avgViewPct;
        r.n++;
        retByChannel.set(ch, r);
      }
    }
    const k = dayKey(captured);
    if (k) viewsByDay.set(k, (viewsByDay.get(k) ?? 0) + (s.views ?? 0));
  }
  const viewsSeries = days14.map((d) => viewsByDay.get(d) ?? 0);
  const retention = retN ? retSum / retN : null;

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
    .innerJoin(channels, eq(alerts.channelId, channels.id))
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
      sub: `${a.alert.message} · ${a.channel.name}`,
      href: `/channels/${a.channel.id}`,
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

  // --- per-channel cards ---
  const cards: ChannelCard[] = chans.map((c) => {
    const r = retByChannel.get(c.id);
    return {
      id: c.id,
      name: c.name,
      handle: c.handle,
      niche: c.niche,
      tier: c.autonomyTier,
      status: c.status,
      connected: !!c.youtubeChannelId,
      views30: viewsByChannel.get(c.id) ?? 0,
      retention: r ? r.sum / r.n : null,
      published7: publishedByChannel.get(c.id) ?? 0,
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

  return {
    systemStatus,
    kpis: {
      views30,
      retention,
      published7,
      spend30,
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
