import { and, eq, isNotNull, lte } from "drizzle-orm";
import { productions, publications } from "@ytauto/db";
import { inngest, markPublicationLive } from "@ytauto/core";
import { getContext } from "../context";

/**
 * Go-live bookkeeping for YouTube-native scheduled releases (BACKLOG #20).
 * Videos upload immediately with `status.publishAt` and YouTube flips them
 * public at the slot itself — no pipeline run is alive at that moment, so this
 * cron sweeps publications whose slot has passed and:
 *   - marks the publication public + publishedAt (the slot time),
 *   - marks the production published,
 *   - fires the post-publish events (analysis/memory carry-over, derive-shorts)
 *     at the moment the video is actually live.
 * Legacy rows from the sleep-based pipeline are untouched: they were uploaded
 * as privacyStatus "private", never "scheduled".
 */
export const publishFinalize = inngest.createFunction(
  { id: "publish-finalize", retries: 3 },
  { cron: "*/10 * * * *" },
  async ({ step }) => {
    const due = await step.run("find-due", async () => {
      const { db } = await getContext();
      const rows = await db
        .select({
          publicationId: publications.id,
          productionId: publications.productionId,
          scheduledFor: publications.scheduledFor,
        })
        .from(publications)
        .innerJoin(productions, eq(productions.id, publications.productionId))
        .where(
          and(
            eq(publications.privacyStatus, "scheduled"),
            isNotNull(publications.providerVideoId),
            lte(publications.scheduledFor, new Date()),
          ),
        );
      return rows.map((r) => ({
        publicationId: r.publicationId,
        productionId: r.productionId,
        scheduledFor: r.scheduledFor ? new Date(r.scheduledFor).toISOString() : null,
      }));
    });

    for (const row of due) {
      await step.run(`go-live-${row.publicationId}`, async () => {
        const { db } = await getContext();
        await markPublicationLive(db, {
          publicationId: row.publicationId,
          productionId: row.productionId,
          publishedAt: row.scheduledFor ? new Date(row.scheduledFor) : new Date(),
        });
      });
    }

    return { released: due.length };
  },
);
