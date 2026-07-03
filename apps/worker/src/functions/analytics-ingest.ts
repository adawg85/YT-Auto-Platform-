import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
  alerts,
  analyticsSnapshots,
  assets,
  productions,
  publications,
} from "@ytauto/db";
import { evaluateAlertRules, inngest, type ChannelBaseline } from "@ytauto/core";
import { getContext } from "../context";

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
        .innerJoin(productions, eq(publications.productionId, productions.id));
      return rows.filter((r) => !onlyChannelId || r.channelId === onlyChannelId);
    });

    let alertCount = 0;
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
          providerVideoId: pub.providerVideoId,
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
        return { views: stats.views, newAlerts };
      });
      alertCount += created.newAlerts;
    }

    return { snapshots: pubs.length, newAlerts: alertCount };
  },
);
