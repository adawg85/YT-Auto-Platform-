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

/**
 * #104: validate a proposed parent BEFORE writing the pointer. The subchannel
 * model resolves auth with ONE hop (pickAuthChannelId never chases the parent's
 * own pointer), so a chain — or a self-reference, or a parent that is itself a
 * subchannel — would silently publish to the wrong YouTube account rather than
 * erroring. Pure so the rules are unit-testable without a DB.
 *
 * Returns an error message, or null when the pointer is safe to store.
 */
export function validateSubchannelParent(input: {
  /** the channel being made into a subchannel (null when it's being created) */
  childId?: string | null;
  parentId: string;
  /** the parent row as loaded, or null when no such channel exists */
  parent: { id: string; derivedFromChannelId: string | null; status?: string | null } | null;
  /** ids of channels that already point at the child as THEIR parent */
  childHasChildren?: boolean;
}): string | null {
  const parentId = input.parentId.trim();
  if (!parentId) return "derivedFromChannelId is empty — pass a real parent channel id, or null to clear it.";
  if (input.childId && parentId === input.childId) {
    return "A channel cannot be its own parent (derivedFromChannelId === the channel's own id).";
  }
  if (!input.parent) {
    return `derivedFromChannelId "${parentId}" is not a channel on this platform — check list_channels for the parent's id.`;
  }
  const grandparent = input.parent.derivedFromChannelId?.trim();
  if (grandparent && grandparent !== input.parent.id) {
    return `Channel "${parentId}" is ITSELF a subchannel (its derivedFromChannelId is "${grandparent}"). Subchannel nesting is not supported — publish-auth resolves one hop only, so a chain would upload to the wrong YouTube account. Point at the top-level parent instead.`;
  }
  if (input.childHasChildren) {
    return "This channel already has subchannels of its own, so it cannot become a subchannel — that would create a two-level chain, and publish-auth resolves one hop only.";
  }
  return null;
}
