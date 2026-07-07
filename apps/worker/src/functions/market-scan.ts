import { eq } from "drizzle-orm";
import { channels } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { runMetaAnalysisForNiche } from "@ytauto/agents";
import { getContext } from "../context";

/**
 * Meta-analysis engine (backlog build #4): the outward-facing intelligence
 * layer. On a daily schedule (ahead of the trend-scan + ideation cron so the
 * grounding is fresh), per active-channel niche, pull down over-performing
 * external content and analyse it into the shared pattern store. Own-video
 * analysis tells us what worked for us; this tells us what's working in the
 * market before we commit spend.
 *
 * Runs one niche at a time (concurrency 1) so the pattern-store read-modify-write
 * upserts stay correct, same as the own-video analysis worker.
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
      return [...new Set(scoped.map((c) => c.niche))];
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

    return {
      niches: niches.length,
      ingested: results.reduce((a, r) => a + r.ingested, 0),
      analysed: results.reduce((a, r) => a + r.analysed, 0),
      patternsWritten: results.reduce(
        (a, r) => a + r.hookPatterns + r.structurePatterns + r.topicSignals,
        0,
      ),
    };
  },
);
