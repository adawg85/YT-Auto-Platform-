import { eq } from "drizzle-orm";
import { channels, type Db } from "@ytauto/db";

/**
 * Subchannel model — SHORTS-DERIVATION-SPEC §1 (Phase 2).
 *
 * A subchannel is an ordinary `channels` row (contentFormat "short",
 * derivedFromChannelId = parent) that publishes short-form with its OWN styling.
 * The one new piece of plumbing is WHOSE YouTube account its Shorts upload to,
 * carried by channels.youtubeAuthChannelId:
 *
 *   • "parent-youtube" (Mode 1, DEFAULT) — youtubeAuthChannelId = parent id.
 *     Shorts upload to the parent channel's YouTube account, so one YouTube
 *     channel carries both long-form and Shorts (Shorts are native to a channel).
 *   • "own-youtube" (Mode 2) — youtubeAuthChannelId = null (→ self). A separate
 *     Shorts YouTube channel with its own OAuth token (the classic
 *     derivedFromChannelId companion).
 *
 * Everything else — DNA-lite, productionProfile, captionStyle, titleTemplates,
 * cadence, gates, scheduling, analytics — is reused from the existing per-channel
 * systems. Only the shared-auth resolve below is new.
 */
export type SubchannelPublishTarget = "parent-youtube" | "own-youtube";

export const SUBCHANNEL_PUBLISH_TARGETS: readonly SubchannelPublishTarget[] = [
  "parent-youtube",
  "own-youtube",
] as const;

export const DEFAULT_SUBCHANNEL_PUBLISH_TARGET: SubchannelPublishTarget = "parent-youtube";

/**
 * The publish-auth pointer to store on a subchannel for a given publish target.
 * `parent-youtube` → the parent id (upload with the parent's credentials);
 * `own-youtube` → null (the subchannel uses its own token).
 */
export function subchannelAuthChannelId(opts: {
  parentChannelId: string;
  publishTarget: SubchannelPublishTarget;
}): string | null {
  return opts.publishTarget === "parent-youtube" ? opts.parentChannelId : null;
}

/**
 * Reverse of the above: read a channel row's publish target back out. A channel
 * whose youtubeAuthChannelId points at another channel is on parent-youtube;
 * anything else (null, empty, or self) is own-youtube.
 */
export function subchannelPublishTarget(row: {
  id: string;
  youtubeAuthChannelId: string | null;
}): SubchannelPublishTarget {
  const ref = row.youtubeAuthChannelId?.trim();
  return ref && ref !== row.id ? "parent-youtube" : "own-youtube";
}

/**
 * The channel-row fields that make a channel a subchannel of `parentChannelId`.
 * Merge over the rest of the row at insert time. Pure — no DB.
 */
export function subchannelChannelFields(opts: {
  parentChannelId: string;
  publishTarget?: SubchannelPublishTarget;
}): {
  contentFormat: "short";
  derivedFromChannelId: string;
  youtubeAuthChannelId: string | null;
} {
  const publishTarget = opts.publishTarget ?? DEFAULT_SUBCHANNEL_PUBLISH_TARGET;
  return {
    contentFormat: "short",
    derivedFromChannelId: opts.parentChannelId,
    youtubeAuthChannelId: subchannelAuthChannelId({
      parentChannelId: opts.parentChannelId,
      publishTarget,
    }),
  };
}

/**
 * Pure: given a channel's id and its youtubeAuthChannelId, return the id whose
 * YouTube credentials should be used to publish/read analytics for it. A blank
 * or self-referential pointer resolves to the channel itself (Mode 2 / normal
 * channel — unchanged behavior). One hop only: a subchannel points at a real
 * parent that holds its own token; we never chase the parent's own pointer, so
 * a mis-configured cycle can't loop.
 */
export function pickAuthChannelId(row: {
  id: string;
  youtubeAuthChannelId: string | null;
}): string {
  const ref = row.youtubeAuthChannelId?.trim();
  return ref && ref !== row.id ? ref : row.id;
}

/**
 * DB wrapper over pickAuthChannelId: load the channel and resolve its effective
 * publish-auth channel id. Falls back to the given id when the channel row is
 * missing (nothing to redirect to). Used by loadChannelToken so both the publish
 * and analytics paths transparently honor Mode 1 shared-auth.
 */
export async function resolveYoutubeAuthChannelId(db: Db, channelId: string): Promise<string> {
  const [row] = await db
    .select({ id: channels.id, youtubeAuthChannelId: channels.youtubeAuthChannelId })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!row) return channelId;
  return pickAuthChannelId(row);
}
