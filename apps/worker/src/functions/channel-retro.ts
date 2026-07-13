import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  agentActions,
  channelDecisions,
  channelPlaybook,
  channels,
  experiments,
  hookAnalyses,
  ideas,
  productions,
  publications,
  scriptAnalyses,
  analyticsSnapshots,
  ulid,
} from "@ytauto/db";
import {
  computeChannelMaturity,
  inngest,
  isVideoMatured,
  MAX_QUEUED_EXPERIMENTS,
  retroDue,
  validateRetroProposal,
} from "@ytauto/core";
import { channelRetro, type RetroVideoInput } from "@ytauto/agents";
import { getContext } from "../context";

/**
 * Channel retro (#21.5/#21.6) — the learning loop's decision engine. On a
 * maturity-gated cadence (warming: observe-only; establishing: ~28d;
 * established: ~14d), it reads MATURED post-publish analyses vs the channel
 * baseline and lets the retro agent propose playbook adoptions/retirements +
 * experiment candidates. Honesty guards live in CODE: unmatured videos are
 * excluded from the input query, adoptions need ≥3 evidence videos, counts
 * are bounded, and autonomy tier decides adopt-vs-trial.
 */
export const channelRetroFn = inngest.createFunction(
  { id: "channel-retro", concurrency: 1, retries: 1 },
  [{ cron: "30 8 * * *" }, { event: "learning/retro.requested" }],
  async ({ event, step }) => {
    const forcedChannelId =
      event?.name === "learning/retro.requested" ? event.data.channelId : undefined;

    const channelRows = await step.run("list-channels", async () => {
      const { db } = await getContext();
      return db
        .select({
          id: channels.id,
          contentFormat: channels.contentFormat,
          autonomyTier: channels.autonomyTier,
          maturityOverride: channels.maturityOverride,
        })
        .from(channels)
        .where(
          forcedChannelId ? eq(channels.id, forcedChannelId) : eq(channels.status, "active"),
        );
    });

    const outcomes: Record<string, string> = {};
    for (const channel of channelRows) {
      const outcome = await step.run(`retro-${channel.id}`, async () => {
        const { db, providers, costSink } = await getContext();
        const format = channel.contentFormat === "long" ? ("long" as const) : ("short" as const);

        // All published videos, oldest first — maturity gate applied in code.
        const pubs = await db
          .select({
            id: publications.id,
            productionId: publications.productionId,
            publishedAt: publications.publishedAt,
          })
          .from(publications)
          .innerJoin(productions, eq(productions.id, publications.productionId))
          .where(and(eq(productions.channelId, channel.id), isNotNull(publications.publishedAt)))
          .orderBy(publications.publishedAt);
        const matured = pubs.filter((p) =>
          isVideoMatured(p.publishedAt!, format, "retention"),
        );
        const maturedIds = new Set(matured.map((p) => p.id));

        const phase = computeChannelMaturity({
          firstPublishedAt: pubs[0]?.publishedAt ?? null,
          maturedCount: matured.length,
          override: channel.maturityOverride,
        });

        // cadence gate (bypassed on an explicit operator request)
        if (!forcedChannelId) {
          const [lastRetro] = await db
            .select({ createdAt: agentActions.createdAt })
            .from(agentActions)
            .where(
              and(
                eq(agentActions.agentName, "channel_retro"),
                eq(agentActions.channelId, channel.id),
              ),
            )
            .orderBy(desc(agentActions.createdAt))
            .limit(1);
          const { due } = retroDue(phase, lastRetro?.createdAt ?? null);
          if (!due) return "not-due";
        }
        const { observeOnly } = retroDue(phase, null);

        if (matured.length < 3) return `skipped: ${matured.length} matured video(s)`;

        // matured evidence: latest snapshot + analyses per publication
        const videos: RetroVideoInput[] = [];
        for (const pub of matured.slice(-25)) {
          const [snap] = await db
            .select()
            .from(analyticsSnapshots)
            .where(eq(analyticsSnapshots.publicationId, pub.id))
            .orderBy(desc(analyticsSnapshots.capturedAt))
            .limit(1);
          const [hook] = await db
            .select()
            .from(hookAnalyses)
            .where(eq(hookAnalyses.publicationId, pub.id));
          const [script] = await db
            .select()
            .from(scriptAnalyses)
            .where(eq(scriptAnalyses.publicationId, pub.id));
          const [ideaRow] = await db
            .select({ title: ideas.title })
            .from(productions)
            .innerJoin(ideas, eq(ideas.id, productions.ideaId))
            .where(eq(productions.id, pub.productionId));
          videos.push({
            publicationId: pub.id,
            title: ideaRow?.title ?? pub.id,
            views: snap?.views ?? 0,
            avgViewPct: snap?.avgViewPct ?? null,
            vsChannelAvgPct: hook?.vsChannelAvgPct ?? null,
            hookArchetype: hook?.archetype ?? null,
            hookTags: (hook?.tags as string[] | null) ?? [],
            hookAssessment: hook?.assessment ?? null,
            strengths: script?.strengths ?? null,
            trimSuggestion: script?.trimSuggestion ?? null,
          });
        }

        const viewCounts = videos.map((v) => v.views).sort((a, b) => a - b);
        const medianViews = viewCounts[Math.floor(viewCounts.length / 2)] ?? 0;
        const retentions = videos.map((v) => v.avgViewPct).filter((n): n is number => n != null);
        const baseline = {
          medianViews,
          avgViewPct: retentions.length
            ? retentions.reduce((a, b) => a + b, 0) / retentions.length
            : null,
          publishedCount: pubs.length,
        };

        const playbookRows = await db
          .select()
          .from(channelPlaybook)
          .where(
            and(
              eq(channelPlaybook.channelId, channel.id),
              inArray(channelPlaybook.status, ["trial", "adopted"]),
            ),
          );

        const raw = await channelRetro(
          { db, llm: providers.llm, costSink, channelId: channel.id },
          {
            maturity: phase,
            baseline,
            videos,
            playbook: playbookRows.map((p) => ({
              id: p.id,
              scope: p.scope,
              directive: p.directive,
              status: p.status,
              why: p.why,
            })),
          },
        );
        const proposal = validateRetroProposal(
          raw,
          maturedIds,
          new Set(playbookRows.map((p) => p.id)),
        );

        // warming: observe only — log, adopt nothing
        if (observeOnly) {
          await db.insert(channelDecisions).values({
            id: ulid(),
            channelId: channel.id,
            kind: "retro_observation",
            summary: `Retro (warming, observe-only): ${proposal.observations}`.slice(0, 500),
            detail: proposal as unknown as Record<string, unknown>,
            actor: "agent",
          });
          return `observed (warming): ${proposal.adoptions.length} candidate(s) logged`;
        }

        const autoAdopt = channel.autonomyTier >= 2;
        let adopted = 0;
        for (const a of proposal.adoptions) {
          const dup = playbookRows.some(
            (p) => p.directive.trim().toLowerCase() === a.directive.trim().toLowerCase(),
          );
          if (dup) continue;
          await db.insert(channelPlaybook).values({
            id: ulid(),
            channelId: channel.id,
            directive: a.directive,
            scope: a.scope,
            origin: "analysis",
            status: autoAdopt ? "adopted" : "trial",
            why: a.why,
            evidence: { videoIds: a.evidenceVideoIds, note: a.why },
            confidence: a.confidence,
            adoptedAt: autoAdopt ? new Date() : null,
          });
          adopted++;
        }
        let retired = 0;
        if (autoAdopt) {
          for (const r of proposal.retirements) {
            await db
              .update(channelPlaybook)
              .set({ status: "retired", retiredAt: new Date() })
              .where(eq(channelPlaybook.id, r.playbookId));
            retired++;
          }
        }

        // experiment queue: bounded, no duplicate variable among open rows
        let queued = 0;
        const open = await db
          .select({ id: experiments.id, variable: experiments.variable, status: experiments.status })
          .from(experiments)
          .where(
            and(
              eq(experiments.channelId, channel.id),
              inArray(experiments.status, ["proposed", "active"]),
            ),
          );
        for (const c of proposal.experimentCandidates) {
          const proposedCount = open.filter((e) => e.status === "proposed").length + queued;
          if (proposedCount >= MAX_QUEUED_EXPERIMENTS) break;
          if (open.some((e) => e.variable === c.variable)) continue;
          await db.insert(experiments).values({
            id: ulid(),
            channelId: channel.id,
            variable: c.variable,
            hypothesis: c.hypothesis,
            baseline: c.baseline,
            variant: c.variant,
            directive: c.directive,
            status: "proposed",
            priority: Math.max(1, Math.round(c.priority)),
          });
          queued++;
        }

        await db.insert(channelDecisions).values({
          id: ulid(),
          channelId: channel.id,
          kind: "retro_decision",
          summary:
            `Retro (${phase}): ${adopted} playbook ${autoAdopt ? "adopted" : "proposed"}, ${retired} retired, ${queued} experiment(s) queued. ${proposal.observations}`.slice(
              0,
              500,
            ),
          detail: proposal as unknown as Record<string, unknown>,
          actor: "agent",
        });
        return `adopted=${adopted} retired=${retired} queued=${queued}`;
      });
      outcomes[channel.id] = outcome;
    }
    return outcomes;
  },
);
