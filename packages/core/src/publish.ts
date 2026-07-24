import { and, eq, isNotNull, ne } from "drizzle-orm";
import { channels, productions, publications, type Db } from "@ytauto/db";
import { inngest } from "./inngest";

/**
 * Whether a publication row should BLOCK re-publishing an idea (pure, so the rule
 * is unit-testable without a DB). A record blocks when it has a real video id AND
 * it isn't a known phantom: `published_unverified` records (ticket 01KY4VVP…) carry
 * a dead id and must NOT false-block a legitimate re-upload — that was exactly the
 * failure where a phantom Bell X-1 record kept a re-run from proceeding.
 */
export function publicationBlocksRepublish(status: string, providerVideoId: string | null): boolean {
  return Boolean(providerVideoId) && status !== "published_unverified";
}

/**
 * Remediation §2.1 — duplicate-publish guard. Returns the already-uploaded video
 * for an idea (any production of the same idea whose publication has a real
 * YouTube id), or null. Used to block a re-greenlight/authoring from shipping a
 * SECOND video for an idea that already published one. `excludeProductionId`
 * skips the current run (for the pipeline's own defense-in-depth check).
 * A `published_unverified` (phantom, dead-id) record is IGNORED so it can't
 * false-block a re-upload (ticket 01KY4VVP…).
 */
export async function publishedVideoForIdea(
  db: Db,
  ideaId: string,
  excludeProductionId?: string,
): Promise<{ providerVideoId: string; productionId: string } | null> {
  const conds = [
    eq(productions.ideaId, ideaId),
    isNotNull(publications.providerVideoId),
    ne(productions.status, "published_unverified"),
  ];
  if (excludeProductionId) conds.push(ne(productions.id, excludeProductionId));
  const [row] = await db
    .select({ providerVideoId: publications.providerVideoId, productionId: productions.id })
    .from(publications)
    .innerJoin(productions, eq(productions.id, publications.productionId))
    .where(and(...conds))
    .limit(1);
  return row?.providerVideoId ? { providerVideoId: row.providerVideoId, productionId: row.productionId } : null;
}

/**
 * The go-live moment to stamp when a scheduled video is observed PUBLIC
 * (ticket 01KY9C9R…). Previously the finalize cron blindly used the scheduled
 * SLOT, which is wrong whenever the video went public off-slot — e.g. the
 * operator releases early in YouTube Studio: the real go-live is "now"
 * (earlier), but the slot is days in the FUTURE, so the record ended up with a
 * publishedAt that hadn't happened yet, and analytics ingest queried an empty
 * (inverted) date window.
 *
 * Rules, in order:
 *  1. YouTube's real `snippet.publishedAt` when the provider reports it — the
 *     authoritative go-live time.
 *  2. else the scheduled slot, but only if it is NOT in the future (a slot that
 *     has already passed is a fine approximation).
 *  3. else `now` — a public video's publishedAt must never be in the future.
 */
export function resolveGoLivePublishedAt(input: {
  remotePublishedAt?: string | null;
  scheduledFor?: Date | string | null;
  now: Date;
}): Date {
  if (input.remotePublishedAt) {
    const d = new Date(input.remotePublishedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (input.scheduledFor != null) {
    const slot = new Date(input.scheduledFor);
    if (!Number.isNaN(slot.getTime()) && slot.getTime() <= input.now.getTime()) return slot;
  }
  return input.now;
}

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
