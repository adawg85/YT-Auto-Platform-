import { and, eq } from "drizzle-orm";
import { channels, productions, publications, type Db } from "@ytauto/db";
import { inngest } from "./inngest";

/**
 * YouTube-native scheduled releases (BACKLOG #20). Videos upload immediately
 * on final approval with `status.publishAt`; YouTube flips them public at the
 * slot itself — no sleeping pipeline run holds the video. This helper is the
 * shared "the video just went (or is going) live" bookkeeping used by the
 * publish-finalize cron and the operator's publish-now click:
 *
 *  - publications row → public + publishedAt
 *  - production row → published
 *  - post-publish events (analysis/memory carry-over + derive-shorts), which
 *    fire at the moment the video is actually live, not at upload time.
 *
 * Derived Shorts clips (masterProductionId set) get the row updates but no
 * post-publish events — same as the pre-publishAt behaviour, where only the
 * main pipeline emitted `production/published`.
 */
export async function markPublicationLive(
  db: Db,
  opts: {
    publicationId: string;
    productionId: string;
    /** the nominal go-live moment (the schedule slot, or "now" for publish-now) */
    publishedAt: Date;
    /** false when the video already emitted its post-publish events (legacy
     * private uploads were marked published at upload time) */
    emitEvents?: boolean;
  },
): Promise<void> {
  const emitEvents = opts.emitEvents ?? true;
  await db
    .update(publications)
    .set({ privacyStatus: "public", publishedAt: opts.publishedAt })
    .where(eq(publications.id, opts.publicationId));
  await db
    .update(productions)
    .set({ status: "published", currentGateId: null })
    .where(eq(productions.id, opts.productionId));

  if (!emitEvents) return;
  const [prod] = await db
    .select({ master: productions.masterProductionId, channelId: productions.channelId })
    .from(productions)
    .where(eq(productions.id, opts.productionId));
  if (!prod || prod.master) return; // derived clip: no post-publish events

  await inngest.send({
    name: "production/published",
    data: { productionId: opts.productionId, publicationId: opts.publicationId },
  });
  // Long→Shorts (#6): a master whose channel feeds a linked Shorts channel
  // derives clips once it is actually live (clips stagger from publish time).
  const [linked] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.derivedFromChannelId, prod.channelId), eq(channels.status, "active")));
  if (linked) {
    await inngest.send({
      name: "editorial/derive-shorts.requested",
      data: { masterProductionId: opts.productionId },
    });
  }
}

/**
 * A scheduled release was cancelled (platform "Cancel schedule" click, or a
 * Studio-side cancel/delete picked up by reconciliation): the video stays
 * uploaded + private until an explicit release. Mirrors the legacy
 * private-until-release state — publishedAt stays null so a later release
 * still fires the post-publish events exactly once.
 */
export async function markScheduleCancelled(
  db: Db,
  opts: { publicationId: string; productionId: string },
): Promise<void> {
  await db
    .update(publications)
    .set({ privacyStatus: "private", scheduledFor: null })
    .where(eq(publications.id, opts.publicationId));
  await db
    .update(productions)
    .set({ status: "published", currentGateId: null })
    .where(eq(productions.id, opts.productionId));
}
