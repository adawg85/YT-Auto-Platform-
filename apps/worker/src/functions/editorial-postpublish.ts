import { and, desc, eq, sql } from "drizzle-orm";
import { episodes, memoryChunks, productions, scriptDrafts } from "@ytauto/db";
import { ingestMemory, inngest } from "@ytauto/core";
import { summarizeCoverage } from "@ytauto/agents";
import { getContext } from "../context";

/**
 * Post-publish memory carry-over (build #5). Raw research stays episode-local;
 * what carries into channel memory is lean — the published transcript + a
 * coverage summary (what we said, how it was framed) for continuity, callbacks
 * and dedup. The episode's research dump is marked prunable, not deleted.
 * No-op for productions that didn't come from an episode (legacy channels).
 */
export const editorialPostpublish = inngest.createFunction(
  { id: "editorial-postpublish", concurrency: 1, retries: 2 },
  { event: "production/published" },
  async ({ event, step }) => {
    const { productionId } = event.data;

    const loaded = await step.run("resolve-episode", async () => {
      const { db } = await getContext();
      const [production] = await db
        .select()
        .from(productions)
        .where(eq(productions.id, productionId));
      if (!production) return null;
      const [episode] = await db
        .select()
        .from(episodes)
        .where(eq(episodes.ideaId, production.ideaId));
      if (!episode) return null; // not an editorial-engine production
      const [draft] = await db
        .select()
        .from(scriptDrafts)
        .where(eq(scriptDrafts.productionId, productionId))
        .orderBy(desc(scriptDrafts.version))
        .limit(1);
      return {
        episodeId: episode.id,
        channelId: episode.channelId,
        title: episode.title,
        transcript: draft?.fullText ?? "",
      };
    });
    if (!loaded) return { skipped: true };

    await step.run("carry-over-memory", async () => {
      const { db, providers, costSink } = await getContext();
      const ctx = { db, llm: providers.llm, costSink, channelId: loaded.channelId };

      const coverage = await summarizeCoverage(ctx, {
        topic: loaded.title,
        transcript: loaded.transcript || loaded.title,
      });

      await db
        .update(episodes)
        .set({ status: "published", coverageSummary: coverage.summary })
        .where(eq(episodes.id, loaded.episodeId));

      if (loaded.transcript) {
        await ingestMemory(db, providers.embeddings, {
          channelId: loaded.channelId,
          episodeId: loaded.episodeId,
          scope: "channel",
          kind: "transcript",
          title: `Transcript: ${loaded.title}`,
          content: loaded.transcript,
          meta: { productionId },
        });
      }
      await ingestMemory(db, providers.embeddings, {
        channelId: loaded.channelId,
        episodeId: loaded.episodeId,
        scope: "channel",
        kind: "coverage_summary",
        title: `Coverage: ${loaded.title}`,
        content: coverage.summary,
        meta: { productionId },
      });

      // the raw research dump is prunable insurance now, never retrieval fodder
      await db
        .update(memoryChunks)
        .set({ meta: sql`coalesce(${memoryChunks.meta}, '{}'::jsonb) || '{"prunable": true}'::jsonb` })
        .where(
          and(
            eq(memoryChunks.episodeId, loaded.episodeId),
            eq(memoryChunks.scope, "episode"),
          ),
        );
      return { coverage: coverage.summary.slice(0, 120) };
    });

    return { episodeId: loaded.episodeId, outcome: "carried-over" };
  },
);
