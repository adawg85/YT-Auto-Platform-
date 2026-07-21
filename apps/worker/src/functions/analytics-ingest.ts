import { and, desc, eq, isNotNull } from "drizzle-orm";
import { ulid } from "ulid";
import {
  alerts,
  analyticsSnapshots,
  assets,
  hookAnalyses,
  productions,
  publications,
} from "@ytauto/db";
import { evaluateAlertRules, meetsUnderperformanceSampleGate, inngest, type ChannelBaseline } from "@ytauto/core";
import { getContext } from "../context";

/** minimum views before a video is worth analysing (enough retention signal) */
const MIN_VIEWS_FOR_ANALYSIS = 50;

/**
 * Monitoring loop (spec §5.4): pull per-video stats on a schedule (or on
 * demand), snapshot them, and run the alerting rules. The snapshots feed the
 * scorer/ideation prompts via channelPerformanceSummary.
 */
export const analyticsIngest = inngest.createFunction(
  { id: "analytics-ingest", concurrency: 1, retries: 2 },
  [{ cron: "0 */6 * * *" }, { event: "analytics/ingest.requested" }],
  async ({ event, step }) => {
    const onlyChannelId =
      event?.name === "analytics/ingest.requested" ? event.data.channelId : undefined;

    const pubs = await step.run("list-publications", async () => {
      const { db } = await getContext();
      const rows = await db
        .select({
          publicationId: publications.id,
          providerVideoId: publications.providerVideoId,
          publishedAt: publications.publishedAt,
          productionId: publications.productionId,
          channelId: productions.channelId,
        })
        .from(publications)
        .innerJoin(productions, eq(publications.productionId, productions.id))
        // only actually-published videos have analytics (#8: scheduled rows
        // now exist too, with null providerVideoId/publishedAt — skip them)
        .where(isNotNull(publications.publishedAt));
      return rows.filter((r) => !onlyChannelId || r.channelId === onlyChannelId);
    });

    let alertCount = 0;
    let analysisRequested = 0;
    for (const pub of pubs) {
      const created = await step.run(`snapshot-${pub.publicationId}`, async () => {
        const { db, providers } = await getContext();

        const [render] = await db
          .select({ durationSec: assets.durationSec })
          .from(assets)
          .where(and(eq(assets.productionId, pub.productionId), eq(assets.kind, "render")));

        // pub crossed a step boundary, so Date fields are ISO strings here
        const publishedAt = pub.publishedAt ?? new Date().toISOString();
        const stats = await providers.analytics.fetchVideoStats({
          channelId: pub.channelId,
          providerVideoId: pub.providerVideoId ?? "", // non-null after the isNotNull filter above
          publishedAt,
          durationSec: render?.durationSec ?? null,
        });

        await db.insert(analyticsSnapshots).values({
          id: ulid(),
          publicationId: pub.publicationId,
          capturedAt: new Date(),
          views: stats.views,
          avgViewDurationSec: stats.avgViewDurationSec,
          avgViewPct: stats.avgViewPct,
          ctr: stats.ctr,
          // viability guardrail (BACKLOG #10): cumulative impressions accrue
          // here so the 28-day channel figure is computable when checks start
          impressions: stats.impressions ?? null,
          // Shorts-native retention signals (build #3.2): the drill-down curve +
          // 3s-hold + swipe-away feed the per-video analysis and pattern store.
          retentionCurve: stats.retentionCurve,
          swipeAwayPct: stats.swipeAwayPct,
          returningViewerPct: stats.returningViewerPct,
          subsGained: stats.subsGained,
          // engagement + watch-time + traffic (ticket 01KY1VEZ… — the fields
          // that were absent entirely). null when the metric/scope isn't available.
          estimatedMinutesWatched: stats.estimatedMinutesWatched ?? null,
          likes: stats.likes ?? null,
          comments: stats.comments ?? null,
          shares: stats.shares ?? null,
          trafficSources: stats.trafficSources ?? null,
          raw: stats.raw,
        });

        // channel baseline: latest snapshot per publication on this channel
        const channelSnaps = await db
          .select({
            publicationId: analyticsSnapshots.publicationId,
            views: analyticsSnapshots.views,
            capturedAt: analyticsSnapshots.capturedAt,
          })
          .from(analyticsSnapshots)
          .innerJoin(publications, eq(analyticsSnapshots.publicationId, publications.id))
          .innerJoin(productions, eq(publications.productionId, productions.id))
          .where(eq(productions.channelId, pub.channelId))
          .orderBy(desc(analyticsSnapshots.capturedAt));
        const latestViews = new Map<string, number>();
        for (const s of channelSnaps) {
          if (!latestViews.has(s.publicationId)) latestViews.set(s.publicationId, s.views);
        }
        const sorted = [...latestViews.values()].sort((a, b) => a - b);
        const baseline: ChannelBaseline = {
          medianViews: sorted[Math.floor(sorted.length / 2)] ?? 0,
          publishedCount: sorted.length,
        };

        const ageHours =
          (Date.now() - new Date(publishedAt).getTime()) / 3_600_000;
        const drafts = evaluateAlertRules(
          { views: stats.views, avgViewPct: stats.avgViewPct, ageHours },
          baseline,
        );

        // Self-heal (ticket 01KY1SX2…): a channel that no longer clears the
        // underperformance sample gate (too few videos / median too low) must
        // not keep a stale open underperformance alert — ack it so the raised
        // thresholds retroactively clear the old critical alerts on the next
        // ingest, without a manual sweep.
        if (!meetsUnderperformanceSampleGate(baseline)) {
          await db
            .update(alerts)
            .set({ status: "acked" })
            .where(
              and(
                eq(alerts.publicationId, pub.publicationId),
                eq(alerts.kind, "underperformance"),
                eq(alerts.status, "open"),
              ),
            );
        }

        // one open alert per (publication, kind): refresh message, don't spam
        let newAlerts = 0;
        for (const draft of drafts) {
          const [existing] = await db
            .select()
            .from(alerts)
            .where(
              and(
                eq(alerts.publicationId, pub.publicationId),
                eq(alerts.kind, draft.kind),
                eq(alerts.status, "open"),
              ),
            );
          if (existing) {
            await db
              .update(alerts)
              .set({ message: draft.message, severity: draft.severity })
              .where(eq(alerts.id, existing.id));
          } else {
            await db.insert(alerts).values({
              id: ulid(),
              channelId: pub.channelId,
              publicationId: pub.publicationId,
              kind: draft.kind,
              severity: draft.severity,
              message: draft.message,
            });
            newAlerts++;
          }
        }
        // request first-time AI analysis once the video has enough signal
        let requestAnalysis = false;
        if (stats.views >= MIN_VIEWS_FOR_ANALYSIS) {
          const [analysed] = await db
            .select({ id: hookAnalyses.id })
            .from(hookAnalyses)
            .where(eq(hookAnalyses.publicationId, pub.publicationId));
          requestAnalysis = !analysed;
        }

        return { views: stats.views, newAlerts, requestAnalysis };
      });
      alertCount += created.newAlerts;
      if (created.requestAnalysis) {
        await step.sendEvent(`analyse-${pub.publicationId}`, {
          name: "analysis/requested",
          data: { publicationId: pub.publicationId },
        });
        analysisRequested++;
      }
    }

    return { snapshots: pubs.length, newAlerts: alertCount, analysisRequested };
  },
);
