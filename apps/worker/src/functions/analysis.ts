import { eq } from "drizzle-orm";
import { productions, publications } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { analyzeVideo } from "@ytauto/agents";
import { getContext } from "../context";

/**
 * Per-video AI analysis (build #3.2): triggered by analytics-ingest once a
 * published video has accrued enough views. Reads the script + retention
 * snapshot, writes the hook/script analyses, and folds the learnings into the
 * shared pattern store. Idempotent — re-running refreshes the analysis in place.
 */
export const videoAnalysis = inngest.createFunction(
  { id: "video-analysis", concurrency: 1, retries: 2 },
  { event: "analysis/requested" },
  async ({ event, step }) => {
    const { publicationId } = event.data;

    const production = await step.run("mark-analysing", async () => {
      const { db } = await getContext();
      const [pub] = await db
        .select({ productionId: publications.productionId })
        .from(publications)
        .where(eq(publications.id, publicationId));
      if (!pub) return null;
      await db
        .update(productions)
        .set({ status: "analysing" })
        .where(eq(productions.id, pub.productionId));
      return pub.productionId;
    });
    if (!production) return { analyzed: false, reason: "unknown publication" };

    const result = await step.run("analyze", async () => {
      const { db, providers, costSink } = await getContext();
      const out = await analyzeVideo(
        { db, llm: providers.llm, costSink, channelId: "" },
        publicationId,
      );
      // analysis done (or skipped for lack of data): settle back to published
      await db
        .update(productions)
        .set({ status: "published" })
        .where(eq(productions.id, production));
      return { analyzed: Boolean(out) };
    });

    return { publicationId, ...result };
  },
);
