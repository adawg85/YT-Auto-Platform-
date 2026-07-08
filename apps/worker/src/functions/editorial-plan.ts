import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import { channelCharters, channelDecisions, channels, episodes, series } from "@ytauto/db";
import { channelStateSummary, inngest } from "@ytauto/core";
import { planSeries } from "@ytauto/agents";
import { getContext } from "../context";

/** Plan the next arc while this many episodes (or fewer) remain un-queued. */
const RESEARCH_AHEAD_THRESHOLD = 2;
/** How many planned episodes to push into research per run. */
const RESEARCH_BATCH = 3;

/**
 * Editorial planner (build #5): the stateful layer above the pipeline. Daily
 * (before market/trend scans so research lands ahead of ideation), per
 * charter'd evergreen channel:
 *   a) no active series → plan one (auto-activated on T2+, else `proposed`
 *      for operator approval on the Plan tab);
 *   b) research-ahead: the active series is running down → plan the NEXT arc;
 *   c) fan out episode research for the next few planned episodes.
 */
export const editorialPlan = inngest.createFunction(
  {
    id: "editorial-plan",
    concurrency: 1,
    retries: 2,
    // a manual plan run for a channel is cancelled by "Stop research"
    cancelOn: [{ event: "editorial/research.halt", match: "data.channelId" }],
  },
  [{ cron: "0 5 * * *" }, { event: "editorial/plan.requested" }],
  async ({ event, step }) => {
    const onlyChannelId =
      event?.name === "editorial/plan.requested" ? event.data.channelId : undefined;

    const charterChannels = await step.run("list-charter-channels", async () => {
      const { db } = await getContext();
      const rows = await db
        .select({ channel: channels, charter: channelCharters })
        .from(channelCharters)
        .innerJoin(channels, eq(channelCharters.channelId, channels.id))
        .where(eq(channels.status, "active"));
      return rows.filter(
        (r) =>
          r.charter.archetype === "evergreen_series" &&
          (!onlyChannelId || r.channel.id === onlyChannelId),
      );
    });

    let seriesPlanned = 0;
    let researchKicked = 0;

    for (const { channel, charter } of charterChannels) {
      const planned = await step.run(`plan-${channel.id}`, async () => {
        const { db, providers, costSink } = await getContext();
        const ctx = { db, llm: providers.llm, costSink, channelId: channel.id };

        const chSeries = await db
          .select()
          .from(series)
          .where(eq(series.channelId, channel.id));
        const active = chSeries.filter((s) => s.status === "active");
        const proposed = chSeries.filter((s) => s.status === "proposed");

        // is the active arc running down? (few episodes not yet queued into production)
        let runningDown = false;
        if (active.length > 0) {
          const remaining = await db
            .select({ id: episodes.id })
            .from(episodes)
            .where(
              and(
                inArray(episodes.seriesId, active.map((s) => s.id)),
                inArray(episodes.status, ["planned", "researching", "verifying", "briefed"]),
              ),
            );
          runningDown = remaining.length <= RESEARCH_AHEAD_THRESHOLD;
        }

        // plan a new arc when there's nothing active (bootstrap) or the active
        // one is running down — but never stack up multiple proposals
        const needsPlan = (active.length === 0 || runningDown) && proposed.length === 0;
        if (!needsPlan) return { planned: false };

        const state = (await channelStateSummary(db, channel.id)) ?? `MISSION: ${charter.mission}`;
        const plan = await planSeries(ctx, {
          niche: channel.niche,
          mission: charter.mission,
          stateSummary: state,
        });

        // bootstrap arc auto-activates on supervised+ channels; research-ahead
        // arcs and low-tier channels wait for operator approval
        const status =
          active.length === 0 && channel.autonomyTier >= 2 ? ("active" as const) : ("proposed" as const);
        const seriesId = ulid();
        await db.insert(series).values({
          id: seriesId,
          channelId: channel.id,
          title: plan.title,
          description: plan.description,
          status,
          plannedEpisodeCount: plan.episodes.length,
          position: chSeries.length,
        });
        await db.insert(episodes).values(
          plan.episodes.map((e, i) => ({
            id: ulid(),
            seriesId,
            channelId: channel.id,
            position: i,
            title: e.title,
            angle: e.angle,
          })),
        );
        await db.insert(channelDecisions).values({
          id: ulid(),
          channelId: channel.id,
          kind: "series_planned",
          summary: `Planned series "${plan.title}" (${plan.episodes.length} episodes, ${status})`,
          detail: { seriesId, episodeTitles: plan.episodes.map((e) => e.title) },
          actor: "agent",
        });
        return { planned: true };
      });
      if (planned.planned) seriesPlanned++;

      // fan out research for the next few planned episodes of ACTIVE series
      const toResearch = await step.run(`next-episodes-${channel.id}`, async () => {
        const { db } = await getContext();
        const rows = await db
          .select({ id: episodes.id, position: episodes.position })
          .from(episodes)
          .innerJoin(series, eq(episodes.seriesId, series.id))
          .where(
            and(
              eq(episodes.channelId, channel.id),
              eq(episodes.status, "planned"),
              eq(series.status, "active"),
            ),
          )
          .orderBy(series.position, episodes.position)
          .limit(RESEARCH_BATCH);
        return rows.map((r) => r.id);
      });

      for (const episodeId of toResearch) {
        await step.sendEvent(`research-${episodeId}`, {
          name: "editorial/episode.research.requested",
          data: { episodeId, channelId: channel.id },
        });
        researchKicked++;
      }
    }

    return { channels: charterChannels.length, seriesPlanned, researchKicked };
  },
);
