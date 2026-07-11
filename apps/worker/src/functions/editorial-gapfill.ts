import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { channelDecisions, channels, episodes, series } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { proposeReplacementEpisode } from "@ytauto/agents";
import { getContext } from "../context";

/**
 * Gap-fill on failure (BACKLOG #23.1): an episode was cut in research or its
 * production failed, vacating a tentative slot. The planner proposes ONE
 * replacement episode for the same arc (materially distinct from every title
 * the series already used), inherits the vacated tentativeFor, and research
 * starts immediately — slots never silently vanish from the calendar.
 *
 * Loop guard: once a series has grown to 2× its planned episode count, we stop
 * replacing (a niche where everything cuts would otherwise spawn forever).
 */
export const editorialGapfill = inngest.createFunction(
  {
    id: "editorial-gapfill",
    // one replacement per vacated episode — a cut AND a later production
    // failure for the same episode must not spawn two replacements
    idempotency: "event.data.episodeId",
    retries: 2,
    cancelOn: [{ event: "editorial/research.halt", match: "data.channelId" }],
  },
  { event: "editorial/gapfill.requested" },
  async ({ event, step }) => {
    const { channelId, seriesId, episodeId } = event.data;

    const ctx0 = await step.run("load-series", async () => {
      const { db } = await getContext();
      const [s] = await db.select().from(series).where(eq(series.id, seriesId));
      const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
      const [vacated] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
      if (!s || !channel || !vacated) {
        return { skip: true as const, reason: "series/channel/episode not found" };
      }
      const all = await db
        .select({
          id: episodes.id,
          title: episodes.title,
          position: episodes.position,
        })
        .from(episodes)
        .where(eq(episodes.seriesId, seriesId));
      // loop guard: never grow a series past 2× its planned size via gap-fill
      const planned = Math.max(1, s.plannedEpisodeCount);
      if (all.length >= planned * 2) {
        return {
          skip: true as const,
          reason: `series already has ${all.length} episodes (>= 2x planned ${planned}) — not replacing`,
        };
      }
      return {
        skip: false as const,
        niche: channel.niche,
        seriesTitle: s.title,
        seriesDescription: s.description ?? "",
        excludeTitles: all.map((e) => e.title),
        vacatedTitle: vacated.title,
        vacatedTentativeFor: vacated.tentativeFor ? new Date(vacated.tentativeFor).toISOString() : null,
      };
    });
    if (ctx0.skip) {
      console.log(`[gapfill] skipped for episode ${episodeId}: ${ctx0.reason}`);
      return { skipped: true, reason: ctx0.reason };
    }

    const newEpisodeId = await step.run("propose-replacement", async () => {
      const { db, providers, costSink } = await getContext();
      const ctx = { db, llm: providers.llm, costSink, channelId };
      const proposal = await proposeReplacementEpisode(ctx, {
        niche: ctx0.niche,
        seriesTitle: ctx0.seriesTitle,
        seriesDescription: ctx0.seriesDescription,
        excludeTitles: ctx0.excludeTitles,
      });
      const id = ulid();
      // recompute max(position) at insert time — two concurrent gap-fills for
      // the same series must not collide on the (seriesId, position) unique key
      const positions = await db
        .select({ position: episodes.position })
        .from(episodes)
        .where(eq(episodes.seriesId, seriesId));
      await db.insert(episodes).values({
        id,
        seriesId,
        channelId,
        position: Math.max(...positions.map((p) => p.position), -1) + 1,
        title: proposal.title,
        angle: proposal.angle,
        status: "planned",
        // the replacement inherits the vacated tentative slot
        tentativeFor: ctx0.vacatedTentativeFor ? new Date(ctx0.vacatedTentativeFor) : null,
      });
      // the slot moved to the replacement — the dead episode no longer holds it
      await db.update(episodes).set({ tentativeFor: null }).where(eq(episodes.id, episodeId));
      await db.insert(channelDecisions).values({
        id: ulid(),
        channelId,
        kind: "series_planned",
        summary: `Gap-fill: replaced "${ctx0.vacatedTitle}" with "${proposal.title}" in "${ctx0.seriesTitle}"`,
        detail: { seriesId, vacatedEpisodeId: episodeId, replacementEpisodeId: id },
        actor: "agent",
      });
      return id;
    });

    // research the replacement immediately so the gap refills without waiting
    // for the daily planner
    await step.sendEvent("research-replacement", {
      name: "editorial/episode.research.requested",
      data: { episodeId: newEpisodeId, channelId },
    });

    return { replacementEpisodeId: newEpisodeId };
  },
);
