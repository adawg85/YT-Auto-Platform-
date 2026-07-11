import { eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import { channels, marketOpportunities } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { discoverOpportunities, runMetaAnalysisForNiche } from "@ytauto/agents";
import { getContext } from "../context";

/**
 * Meta-analysis engine (backlog build #4): the outward-facing intelligence
 * layer. On a daily schedule (ahead of the trend-scan + ideation cron so the
 * grounding is fresh), per active-channel niche, pull down over-performing
 * external content and analyse it into the shared pattern store. Own-video
 * analysis tells us what worked for us; this tells us what's working in the
 * market before we commit spend.
 *
 * BACKLOG #22 adds a GLOBAL discovery step (no niche seed): trend categories +
 * platform-wide breakout channels → the portfolio strategist agent → the
 * market_opportunities table (new niches / topic waves / working styles),
 * surfaced on the Ideas page. Runs one niche at a time (concurrency 1) so the
 * pattern-store read-modify-write upserts stay correct.
 */
export const marketScan = inngest.createFunction(
  { id: "market-scan", concurrency: 1, retries: 2 },
  [{ cron: "0 6 * * *" }, { event: "market/scan.requested" }],
  async ({ event, step }) => {
    const only =
      event?.name === "market/scan.requested" ? event.data : ({} as { channelId?: string; niche?: string });

    const niches = await step.run("list-niches", async () => {
      const { db } = await getContext();
      // an explicit niche request scans just that niche
      if (only.niche) return [only.niche];
      const rows = await db.select().from(channels).where(eq(channels.status, "active"));
      const scoped = rows.filter((c) => !only.channelId || c.id === only.channelId);
      // BACKLOG #23.3 per-channel intel cadence — applies to the CRON run only
      // (an explicit market/scan.requested event always bypasses it):
      //   "off"    → the channel never drives a scheduled scan;
      //   "weekly" → its niche is only scanned when the daily cron lands on a
      //              Monday (UTC — the cron itself fires at 06:00 UTC);
      //   "daily"  → scanned every run (default).
      // A niche is scanned if ANY of its active channels is due today.
      const isCron = event?.name !== "market/scan.requested";
      const due = isCron
        ? scoped.filter((c) => {
            if (c.intelCadence === "off") return false;
            if (c.intelCadence === "weekly") return new Date().getUTCDay() === 1; // Monday UTC
            return true;
          })
        : scoped;
      return [...new Set(due.map((c) => c.niche))];
    });

    const results = [];
    for (const niche of niches) {
      const result = await step.run(`scan-${niche}`, async () => {
        const { db, providers, costSink } = await getContext();
        return runMetaAnalysisForNiche(
          { db, llm: providers.llm, costSink, channelId: "" },
          providers.research,
          { niche },
        );
      });
      results.push(result);
    }

    // BACKLOG #22: global cross-niche discovery — skipped for scoped
    // (single-channel/-niche) requests and for providers without a global
    // trends surface. Dismissed opportunities are never resurrected: their
    // labels stay in the "known" list handed to the strategist, and the
    // upsert only bumps non-dismissed rows.
    const opportunities = await step.run("discover-opportunities", async () => {
      if (only.niche || only.channelId) return { skipped: true as const, found: 0 };
      const { db, providers, costSink } = await getContext();
      const research = providers.research;
      if (!research.trendCategories || !research.globalBreakoutChannels) {
        return { skipped: true as const, found: 0 };
      }
      const [categories, breakouts] = await Promise.all([
        research.trendCategories().catch(() => []),
        research.globalBreakoutChannels().catch(() => []),
      ]);
      if (categories.length === 0 && breakouts.length === 0) {
        return { skipped: true as const, found: 0 };
      }

      const activeChannels = await db
        .select({ niche: channels.niche })
        .from(channels)
        .where(eq(channels.status, "active"));
      const known = await db
        .select({ id: marketOpportunities.id, kind: marketOpportunities.kind, label: marketOpportunities.label, status: marketOpportunities.status })
        .from(marketOpportunities);

      const out = await discoverOpportunities(
        { db, llm: providers.llm, costSink, channelId: "" },
        {
          categories,
          breakouts,
          existingNiches: [...new Set(activeChannels.map((c) => c.niche))],
          knownLabels: known.map((k) => k.label),
        },
      );

      // bump re-observed non-dismissed rows the agent was told to skip but
      // whose underlying signals are still present in this scan
      const signalLabels = new Set(
        [...categories.map((c) => c.category.toLowerCase()), ...breakouts.map((b) => b.niche.toLowerCase())].filter(Boolean),
      );
      const reobserved = known.filter((k) => k.status !== "dismissed" && signalLabels.has(k.label.toLowerCase()));
      if (reobserved.length) {
        await db
          .update(marketOpportunities)
          .set({ lastSeen: new Date(), updatedAt: new Date() })
          .where(inArray(marketOpportunities.id, reobserved.map((r) => r.id)));
      }

      let inserted = 0;
      for (const o of out.opportunities) {
        const label = o.label.trim().toLowerCase();
        if (!label) continue;
        const existing = known.find((k) => k.kind === o.kind && k.label === label);
        if (existing) {
          if (existing.status !== "dismissed") {
            await db
              .update(marketOpportunities)
              .set({
                summary: o.summary,
                momentum: Math.round(o.momentum),
                lastSeen: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(marketOpportunities.id, existing.id));
          }
          continue;
        }
        await db.insert(marketOpportunities).values({
          id: ulid(),
          kind: o.kind,
          label,
          summary: o.summary,
          suggestedNiche: o.suggestedNiche ?? null,
          suggestedIntent: o.suggestedIntent ?? null,
          momentum: Math.max(0, Math.min(100, Math.round(o.momentum))),
          evidence: {
            categories: categories.map((c) => c.category).slice(0, 8),
            channels: breakouts
              .slice(0, 6)
              .map((b) => ({ name: b.channelName, subscribers: b.subscribers, growthRate: b.growthRate })),
            sampleTitles: categories.flatMap((c) => c.sampleTitles ?? []).slice(0, 6),
          },
          status: "new",
        });
        inserted++;
      }
      return { skipped: false as const, found: out.opportunities.length, inserted };
    });

    return {
      niches: niches.length,
      ingested: results.reduce((a, r) => a + r.ingested, 0),
      analysed: results.reduce((a, r) => a + r.analysed, 0),
      patternsWritten: results.reduce(
        (a, r) => a + r.hookPatterns + r.structurePatterns + r.topicSignals,
        0,
      ),
      opportunities,
    };
  },
);
