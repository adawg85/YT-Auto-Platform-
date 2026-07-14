import { and, eq, inArray, lt } from "drizzle-orm";
import { ulid } from "ulid";
import { channelCharters, channelDecisions, channels, episodes, series } from "@ytauto/db";
import { channelStateSummary, inngest } from "@ytauto/core";
import { planSeries } from "@ytauto/agents";
import { getContext } from "../context";

/** Plan the next arc while this many episodes (or fewer) remain un-queued. */
const RESEARCH_AHEAD_THRESHOLD = 2;
/**
 * How many planned episodes to push into research per run (#23.1: format-
 * aware). Shorts channels burn through episodes far faster (up to ~7/wk on the
 * graduated ramp), so they research 6 ahead; long-form stays at 3.
 */
const RESEARCH_BATCH_SHORT = 6;
const RESEARCH_BATCH_LONG = 3;
/**
 * Self-heal (2026-07-14, "Atom and Friends" stall): an episode-research run
 * that dies past its retries (deploy restart, LLM/schema error) strands the
 * episode at researching/verifying, and the fan-out below only ever saw
 * `planned` — stuck meant stuck forever. Episodes untouched for this long are
 * re-fired; the research chain is idempotent and resumes from the top. Two
 * hours clears any legitimately long run (3-concurrent cap included) without
 * double-running one that's merely slow.
 */
const RESEARCH_STALL_MS = 2 * 60 * 60 * 1000;

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
      // (#23.1: shorts channels research deeper ahead than long-form)
      const researchBatch =
        channel.contentFormat === "short" ? RESEARCH_BATCH_SHORT : RESEARCH_BATCH_LONG;
      const toResearch = await step.run(`next-episodes-${channel.id}`, async () => {
        const { db } = await getContext();
        // stalled runs first — they were already promised to the operator
        const stalled = await db
          .select({ id: episodes.id, title: episodes.title })
          .from(episodes)
          .innerJoin(series, eq(episodes.seriesId, series.id))
          .where(
            and(
              eq(episodes.channelId, channel.id),
              inArray(episodes.status, ["researching", "verifying"]),
              eq(series.status, "active"),
              lt(episodes.updatedAt, new Date(Date.now() - RESEARCH_STALL_MS)),
            ),
          )
          .orderBy(series.position, episodes.position);
        if (stalled.length) {
          await db.insert(channelDecisions).values({
            id: ulid(),
            channelId: channel.id,
            kind: "retro_observation",
            summary: `Rescued ${stalled.length} stalled research run${stalled.length === 1 ? "" : "s"} (stuck >2h, re-fired)`,
            detail: { episodeIds: stalled.map((s) => s.id), titles: stalled.map((s) => s.title) },
            actor: "agent",
          });
        }
        // The batch is a cap on TOTAL in-flight research, not a per-run
        // increment (2026-07-14 operator report: every planner run — button
        // press or cron — stacked the NEXT batch on top of the previous one,
        // until the whole arc sat at "researching"). Count what's already
        // healthily in flight and only top up the difference.
        const inFlight = await db
          .select({ id: episodes.id })
          .from(episodes)
          .innerJoin(series, eq(episodes.seriesId, series.id))
          .where(
            and(
              eq(episodes.channelId, channel.id),
              inArray(episodes.status, ["researching", "verifying"]),
              eq(series.status, "active"),
            ),
          );
        const healthy = inFlight.length - stalled.length;
        const room = Math.max(0, researchBatch - stalled.length - healthy);
        const rows = room
          ? await db
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
              .limit(room)
          : [];
        return [...stalled.map((s) => s.id), ...rows.map((r) => r.id)];
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
