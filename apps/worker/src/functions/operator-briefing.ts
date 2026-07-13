import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import {
  alerts,
  analyticsSnapshots,
  channelBriefings,
  channelCharters,
  channelDecisions,
  channelPlaybook,
  channels,
  costRecords,
  episodes,
  experiments,
  productions,
  publications,
  reviewGates,
  series,
  type BriefingSuggestion,
} from "@ytauto/db";
import {
  briefingDue,
  channelStateSummary,
  evaluateExperimentOutcome,
  inngest,
  normalizeCadence,
  patternsToPromptLines,
  topPatternsForNiche,
  type ExperimentMetrics,
} from "@ytauto/core";
import { composeBriefing, narrateExperimentOutcome } from "@ytauto/agents";
import { getContext } from "../context";

/** How many recent non-experiment videos form the baseline cohort. */
const BASELINE_COHORT = 10;

type Db = Awaited<ReturnType<typeof getContext>>["db"];

/** Latest analytics snapshot per publication for a set of production ids. */
async function cohortMetrics(db: Db, productionIds: string[]): Promise<ExperimentMetrics> {
  if (productionIds.length === 0) return { avgPctViewed: null, avgViews: null, sampleSize: 0 };
  const rows = await db
    .select({
      publicationId: analyticsSnapshots.publicationId,
      views: analyticsSnapshots.views,
      avgViewPct: analyticsSnapshots.avgViewPct,
      capturedAt: analyticsSnapshots.capturedAt,
    })
    .from(analyticsSnapshots)
    .innerJoin(publications, eq(analyticsSnapshots.publicationId, publications.id))
    .where(inArray(publications.productionId, productionIds))
    .orderBy(desc(analyticsSnapshots.capturedAt));
  const latest = new Map<string, { views: number; avgViewPct: number | null }>();
  for (const r of rows) {
    if (!latest.has(r.publicationId)) {
      latest.set(r.publicationId, { views: r.views, avgViewPct: r.avgViewPct });
    }
  }
  const cohort = [...latest.values()];
  if (cohort.length === 0) return { avgPctViewed: null, avgViews: null, sampleSize: 0 };
  const pcts = cohort.filter((c) => c.avgViewPct != null).map((c) => c.avgViewPct!);
  return {
    avgPctViewed: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null,
    avgViews: cohort.reduce((a, b) => a + b.views, 0) / cohort.length,
    sampleSize: cohort.length,
  };
}

/**
 * Operator briefings + experiment lifecycle (build #5.2). Daily, per
 * charter'd active channel:
 *   a) conclude a ripe active experiment (deterministic verdict vs the
 *      channel baseline; the LLM only narrates) → decisions ledger;
 *   b) when the charter's checkinCadence window has elapsed, compose the
 *      check-in briefing ("what happened / direction / suggestions / do you
 *      agree?") and store it for the cockpit Briefings tab. An experiment
 *      suggestion becomes a `proposed` experiments row — auto-activated on
 *      T2+ channels, awaiting the operator's "agree" on T0/T1.
 */
export const operatorBriefing = inngest.createFunction(
  { id: "operator-briefing", concurrency: 1, retries: 2 },
  [{ cron: "0 7 * * *" }, { event: "editorial/briefing.requested" }],
  async ({ event, step }) => {
    const isManual = event?.name === "editorial/briefing.requested";
    const onlyChannelId = isManual ? event.data.channelId : undefined;
    const force = isManual ? (event.data.force ?? false) : false;

    const targets = await step.run("list-charter-channels", async () => {
      const { db } = await getContext();
      const rows = await db
        .select({ channel: channels, charter: channelCharters })
        .from(channelCharters)
        .innerJoin(channels, eq(channelCharters.channelId, channels.id))
        .where(eq(channels.status, "active"));
      return rows.filter((r) => !onlyChannelId || r.channel.id === onlyChannelId);
    });

    let briefingsSent = 0;
    let experimentsConcluded = 0;

    for (const { channel, charter } of targets) {
      // ── a) conclude the active experiment when its sample is complete ──
      const concluded = await step.run(`conclude-experiment-${channel.id}`, async () => {
        const { db, providers, costSink } = await getContext();
        const [exp] = await db
          .select()
          .from(experiments)
          .where(and(eq(experiments.channelId, channel.id), eq(experiments.status, "active")));
        if (!exp) return null;

        const variantProds = await db
          .select({ id: productions.id })
          .from(productions)
          .where(
            and(eq(productions.experimentId, exp.id), eq(productions.status, "published")),
          );
        if (variantProds.length < exp.targetSampleSize) return null;

        const baselineProds = await db
          .select({ id: productions.id })
          .from(productions)
          .where(
            and(
              eq(productions.channelId, channel.id),
              eq(productions.status, "published"),
              isNull(productions.experimentId),
            ),
          )
          .orderBy(desc(productions.createdAt))
          .limit(BASELINE_COHORT);

        const variant = await cohortMetrics(db, variantProds.map((p) => p.id));
        const baseline = await cohortMetrics(db, baselineProds.map((p) => p.id));
        const evaluation = evaluateExperimentOutcome({
          baseline,
          variant,
          minSample: exp.targetSampleSize,
        });

        const ctx = { db, llm: providers.llm, costSink, channelId: channel.id };
        const outcome = await narrateExperimentOutcome(ctx, {
          variable: exp.variable,
          hypothesis: exp.hypothesis,
          baseline: exp.baseline,
          variant: exp.variant,
          evaluation,
        });

        await db
          .update(experiments)
          .set({
            status: "concluded",
            result: evaluation.result,
            outcome,
            concludedAt: new Date(),
          })
          .where(eq(experiments.id, exp.id));
        await db.insert(channelDecisions).values({
          id: ulid(),
          channelId: channel.id,
          kind: "experiment_concluded",
          summary: `Experiment "${exp.variable} → ${exp.variant}" concluded: ${evaluation.result} (${evaluation.readout})`,
          detail: { experimentId: exp.id, evaluation },
          actor: "agent",
        });

        // #21.5: a WIN graduates into the channel playbook as a standing
        // directive (origin=experiment, the strongest evidence class); a loss
        // stays in the ledger — what was learned is the concluded row itself.
        if (evaluation.result === "win") {
          await db.insert(channelPlaybook).values({
            id: ulid(),
            channelId: channel.id,
            directive: exp.directive,
            scope: "structure",
            origin: "experiment",
            status: channel.autonomyTier >= 2 ? "adopted" : "trial",
            why: `Experiment win: ${evaluation.readout}`,
            evidence: { videoIds: variantProds.map((p) => p.id), note: outcome },
            confidence: 0.8,
            adoptedAt: channel.autonomyTier >= 2 ? new Date() : null,
          });
        }

        // #21.5 experiment queue: when the active experiment concludes, the
        // next queued (proposed, lowest priority number first) auto-starts on
        // T2/T3; assisted channels keep the operator approval step.
        if (channel.autonomyTier >= 2) {
          const [next] = await db
            .select()
            .from(experiments)
            .where(
              and(eq(experiments.channelId, channel.id), eq(experiments.status, "proposed")),
            )
            .orderBy(sql`${experiments.priority} asc nulls last`, experiments.createdAt)
            .limit(1);
          if (next) {
            await db
              .update(experiments)
              .set({ status: "active", startedAt: new Date() })
              .where(eq(experiments.id, next.id));
            await db.insert(channelDecisions).values({
              id: ulid(),
              channelId: channel.id,
              kind: "experiment_started",
              summary: `Queued experiment auto-started: "${next.variable} → ${next.variant}"`,
              detail: { experimentId: next.id, fromQueue: true },
              actor: "agent",
            });
          }
        }
        return { experimentId: exp.id, result: evaluation.result };
      });
      if (concluded) experimentsConcluded++;

      // ── b) compose the check-in when the cadence window has elapsed ──
      const sent = await step.run(`brief-${channel.id}`, async () => {
        const { db, providers, costSink } = await getContext();
        const now = new Date();

        const [last] = await db
          .select()
          .from(channelBriefings)
          .where(eq(channelBriefings.channelId, channel.id))
          .orderBy(desc(channelBriefings.createdAt))
          .limit(1);
        if (!force && !briefingDue(charter.checkinCadence, last ? new Date(last.createdAt) : null, now)) {
          return false;
        }

        const periodStart = last ? new Date(last.createdAt) : new Date(channel.createdAt);

        // facts: publishing + audience + workload + spend, all exact SQL
        const periodProds = await db
          .select({ id: productions.id })
          .from(productions)
          .innerJoin(publications, eq(publications.productionId, productions.id))
          .where(
            and(eq(productions.channelId, channel.id), gte(publications.publishedAt, periodStart)),
          );
        const audience = await cohortMetrics(db, periodProds.map((p) => p.id));

        const [gateRow] = await db
          .select({ n: sql<number>`count(*)` })
          .from(reviewGates)
          .innerJoin(productions, eq(reviewGates.productionId, productions.id))
          .where(and(eq(productions.channelId, channel.id), eq(reviewGates.status, "pending")));
        const [alertRow] = await db
          .select({ n: sql<number>`count(*)` })
          .from(alerts)
          .where(and(eq(alerts.channelId, channel.id), eq(alerts.status, "open")));
        const [costRow] = await db
          .select({ usd: sql<string>`coalesce(sum(${costRecords.costUsd}), 0)` })
          .from(costRecords)
          .where(and(eq(costRecords.channelId, channel.id), gte(costRecords.createdAt, periodStart)));

        const [activeSeries] = await db
          .select()
          .from(series)
          .where(and(eq(series.channelId, channel.id), eq(series.status, "active")))
          .limit(1);
        const remaining = activeSeries
          ? await db
              .select({ n: sql<number>`count(*)` })
              .from(episodes)
              .where(
                and(
                  eq(episodes.seriesId, activeSeries.id),
                  inArray(episodes.status, ["planned", "researching", "verifying", "briefed"]),
                ),
              )
          : null;

        const [activeExp] = await db
          .select()
          .from(experiments)
          .where(and(eq(experiments.channelId, channel.id), eq(experiments.status, "active")));
        const activeExpSample = activeExp
          ? await db
              .select({ n: sql<number>`count(*)` })
              .from(productions)
              .where(
                and(
                  eq(productions.experimentId, activeExp.id),
                  eq(productions.status, "published"),
                ),
              )
          : null;
        const periodConcluded = await db
          .select()
          .from(experiments)
          .where(
            and(
              eq(experiments.channelId, channel.id),
              eq(experiments.status, "concluded"),
              gte(experiments.concludedAt, periodStart),
            ),
          );

        const patternRows = await topPatternsForNiche(db, { niche: channel.niche, limit: 3 });
        const stateSummary = await channelStateSummary(db, channel.id);

        const ctx = { db, llm: providers.llm, costSink, channelId: channel.id };
        const composed = await composeBriefing(ctx, {
          channelName: channel.name,
          niche: channel.niche,
          cadence: normalizeCadence(charter.checkinCadence),
          periodStart,
          periodEnd: now,
          stateSummary,
          published: periodProds.length,
          avgPctViewed: audience.avgPctViewed,
          totalViews: Math.round((audience.avgViews ?? 0) * audience.sampleSize),
          openGates: Number(gateRow?.n ?? 0),
          openAlerts: Number(alertRow?.n ?? 0),
          costUsd: Number(costRow?.usd ?? 0),
          activeSeries: activeSeries
            ? { title: activeSeries.title, remaining: Number(remaining?.[0]?.n ?? 0) }
            : null,
          patternLines: patternsToPromptLines(patternRows),
          activeExperiment: activeExp
            ? {
                variable: activeExp.variable,
                variant: activeExp.variant,
                sampleSize: Number(activeExpSample?.[0]?.n ?? 0),
              }
            : null,
          concludedExperiments: periodConcluded.map((e) => ({
            variable: e.variable,
            variant: e.variant,
            result: e.result ?? "inconclusive",
            readout: e.outcome ?? "",
          })),
        });

        // persist suggestions; an experiment suggestion becomes a `proposed`
        // experiments row (one at a time — drop extras or any proposed while
        // one is active/pending)
        const briefingId = ulid();
        const hasOpenExperiment =
          !!activeExp ||
          (
            await db
              .select({ id: experiments.id })
              .from(experiments)
              .where(
                and(eq(experiments.channelId, channel.id), eq(experiments.status, "proposed")),
              )
          ).length > 0;
        let experimentAttached = hasOpenExperiment;
        const suggestions: BriefingSuggestion[] = [];
        for (let i = 0; i < composed.suggestions.length; i++) {
          const s = composed.suggestions[i]!;
          const id = `s${i + 1}`;
          if (s.kind === "experiment" && s.experiment && !experimentAttached) {
            const experimentId = ulid();
            const autoActivate = channel.autonomyTier >= 2;
            await db.insert(experiments).values({
              id: experimentId,
              channelId: channel.id,
              variable: s.experiment.variable,
              hypothesis: s.experiment.hypothesis,
              baseline: s.experiment.baseline,
              variant: s.experiment.variant,
              directive: s.experiment.directive,
              status: autoActivate ? "active" : "proposed",
              startedAt: autoActivate ? now : null,
              briefingId,
            });
            if (autoActivate) {
              await db.insert(channelDecisions).values({
                id: ulid(),
                channelId: channel.id,
                kind: "experiment_started",
                summary: `Experiment auto-started (T${channel.autonomyTier}): ${s.experiment.variable} → ${s.experiment.variant}`,
                detail: { experimentId, hypothesis: s.experiment.hypothesis },
                actor: "agent",
              });
            }
            experimentAttached = true;
            suggestions.push({ id, kind: "experiment", label: s.label, detail: s.detail, experimentId });
          } else if (s.kind === "steer") {
            suggestions.push({ id, kind: "steer", label: s.label, detail: s.detail });
          }
          // experiment suggestions beyond the first (or while one is open) are dropped
        }

        await db.insert(channelBriefings).values({
          id: briefingId,
          channelId: channel.id,
          periodStart,
          periodEnd: now,
          body: {
            whatHappened: composed.whatHappened,
            direction: composed.direction,
            question: composed.question,
          },
          suggestions,
        });
        return true;
      });
      if (sent) briefingsSent++;
    }

    return { channels: targets.length, briefingsSent, experimentsConcluded };
  },
);
