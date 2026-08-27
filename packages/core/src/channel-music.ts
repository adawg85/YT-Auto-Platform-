import { and, eq, inArray, sql } from "drizzle-orm";
import { audioAssets, channels, channelMusic, type Db } from "@ytauto/db";
import { publishesShorts } from "./shorts-claim-risk";

/**
 * Per-channel music bed (2026-07-21). A channel keeps a small pool (~6-8) of
 * reusable tracks; the pipeline ALTERNATES through them least-recently-used so
 * the channel sounds consistent without repeating the same bed every video.
 *
 * #119: the rotation was inert — only the pipeline's automatic pick stamped
 * `lastUsedAt`; operator/agent selections (set_production_music, the cockpit
 * music panel) never did, so the sort key stayed null on every track and the
 * same track landed on consecutive videos. EVERY selection path now stamps via
 * `stampBedTrackUsed`, `usedCount` tie-breaks fresh beds deterministically,
 * and get_music reports both so the rotation is auditable rather than trusted.
 */

/** The soft target size for a channel's bed (guidance for the UI). */
export const CHANNEL_BED_TARGET = 8;

export type ChannelBedTrack = {
  id: string;
  storageKey: string;
  mimeType: string;
  name: string | null;
  mood: string | null;
  source: string | null;
  attribution: string | null;
  license: string | null;
  durationSec: number | null;
  lastUsedAt: Date | null;
  /** #119: selection count — the rotation's audit trail + deterministic tie-break */
  usedCount: number;
  /** #110: soft pointer to the platform audio-library row, when pulled from it */
  audioAssetId: string | null;
  createdAt: Date;
};

/**
 * #119: the rotation order, as a pure comparator so it is unit-testable.
 * Least-recently-used first (never-used before any repeat), then fewest uses
 * (a fresh bed distributes instead of repeatedly selecting the first row),
 * then insertion order, then id — fully deterministic at every tie level.
 */
export function bedRotationCompare(
  a: Pick<ChannelBedTrack, "lastUsedAt" | "usedCount" | "createdAt" | "id">,
  b: Pick<ChannelBedTrack, "lastUsedAt" | "usedCount" | "createdAt" | "id">,
): number {
  const aUsed = a.lastUsedAt?.getTime() ?? -Infinity; // never-used sorts first
  const bUsed = b.lastUsedAt?.getTime() ?? -Infinity;
  if (aUsed !== bUsed) return aUsed - bUsed;
  if (a.usedCount !== b.usedCount) return a.usedCount - b.usedCount;
  const aCreated = a.createdAt?.getTime() ?? 0;
  const bCreated = b.createdAt?.getTime() ?? 0;
  if (aCreated !== bCreated) return aCreated - bCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Every track in a channel's bed, in rotation order (see bedRotationCompare). */
export async function listChannelBed(db: Db, channelId: string): Promise<ChannelBedTrack[]> {
  const rows = await db
    .select({
      id: channelMusic.id,
      storageKey: channelMusic.storageKey,
      mimeType: channelMusic.mimeType,
      name: channelMusic.name,
      mood: channelMusic.mood,
      source: channelMusic.source,
      attribution: channelMusic.attribution,
      license: channelMusic.license,
      durationSec: channelMusic.durationSec,
      lastUsedAt: channelMusic.lastUsedAt,
      usedCount: channelMusic.usedCount,
      audioAssetId: channelMusic.audioAssetId,
      createdAt: channelMusic.createdAt,
    })
    .from(channelMusic)
    .where(eq(channelMusic.channelId, channelId));
  return rows.sort(bedRotationCompare);
}

/**
 * #119: advance the rotation cursor — stamp `lastUsedAt` and bump `usedCount`
 * on the bed row matching this storage key. Called from EVERY path that makes
 * a track a production's selected bed: the pipeline's automatic pick,
 * set_production_music (useBedStorageKey / useAudioAssetId / candidate
 * selection), and the cockpit music panel. A storage key with no bed row on
 * this channel is a no-op (one-off tracks aren't part of the rotation).
 */
export async function stampBedTrackUsed(db: Db, channelId: string, storageKey: string): Promise<void> {
  await db
    .update(channelMusic)
    .set({ lastUsedAt: new Date(), usedCount: sql`${channelMusic.usedCount} + 1` })
    .where(and(eq(channelMusic.channelId, channelId), eq(channelMusic.storageKey, storageKey)));
}

/**
 * Pick the next bed track for a video and STAMP it used (advances the rotation
 * cursor) in one shot. Returns null when the channel has no bed yet — the
 * caller then falls back to generating a bed. Least-recently-used wins, so a
 * channel cycles through all its tracks before any repeats.
 */
export async function pickChannelBedTrack(db: Db, channelId: string): Promise<ChannelBedTrack | null> {
  const bed = await listChannelBed(db, channelId);
  if (bed.length === 0) return null;
  const [next] = await eligibleBedTracks(db, channelId, bed);
  if (!next) return null;
  await stampBedTrackUsed(db, channelId, next.storageKey);
  return next;
}

/**
 * #132: drop bed tracks that must not be picked for THIS channel.
 *
 * The automatic rotation is how the platform bought the same block twice: an
 * operator never chose Aphelion for the Short it killed — the least-recently-used
 * cursor landed on it. So the skip belongs here, in the picker, not only in the
 * attach paths a human drives.
 *
 * Only tracks OBSERVED to have blocked a Short are skipped, and only on channels
 * that publish Shorts. A merely Content-ID-registered track stays in rotation:
 * most of them publish perfectly well, and refusing them all would empty the bed
 * and push the pipeline onto a billed AI-generated bed instead.
 *
 * If every track is ineligible the caller gets null and falls back exactly as it
 * does for an empty bed — better a generated bed than a guaranteed block.
 */
async function eligibleBedTracks(
  db: Db,
  channelId: string,
  bed: ChannelBedTrack[],
): Promise<ChannelBedTrack[]> {
  const [channel] = await db
    .select({ contentFormat: channels.contentFormat })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!publishesShorts(channel?.contentFormat)) return bed;
  const assetIds = bed.map((t) => t.audioAssetId).filter((id): id is string => Boolean(id));
  if (assetIds.length === 0) return bed;
  const blocked = await db
    .select({ id: audioAssets.id })
    .from(audioAssets)
    .where(and(inArray(audioAssets.id, assetIds), eq(audioAssets.shortsBlocked, true)));
  if (blocked.length === 0) return bed;
  const blockedIds = new Set(blocked.map((r) => r.id));
  const usable = bed.filter((t) => !(t.audioAssetId && blockedIds.has(t.audioAssetId)));
  if (usable.length === 0) {
    console.error(
      `[music] channel ${channelId}: every bed track is flagged shortsBlocked — falling back to a generated bed. Add a usable track to the bed.`,
    );
  }
  return usable;
}

/** Add a track to a channel's bed (idempotent on channelId+storageKey). */
export async function addChannelBedTrack(
  db: Db,
  channelId: string,
  track: {
    id: string;
    storageKey: string;
    mimeType: string;
    name?: string | null;
    mood?: string | null;
    source?: string | null;
    attribution?: string | null;
    license?: string | null;
    durationSec?: number | null;
    audioAssetId?: string | null;
  },
): Promise<void> {
  await db
    .insert(channelMusic)
    .values({
      id: track.id,
      channelId,
      storageKey: track.storageKey,
      mimeType: track.mimeType,
      name: track.name ?? null,
      mood: track.mood ?? null,
      source: track.source ?? null,
      attribution: track.attribution ?? null,
      license: track.license ?? null,
      durationSec: track.durationSec ?? null,
      audioAssetId: track.audioAssetId ?? null,
    })
    .onConflictDoNothing({ target: [channelMusic.channelId, channelMusic.storageKey] });
}

/** Remove a bed track by id (scoped to the channel to prevent cross-channel deletes). */
export async function removeChannelBedTrack(db: Db, channelId: string, id: string): Promise<void> {
  await db.delete(channelMusic).where(and(eq(channelMusic.id, id), eq(channelMusic.channelId, channelId)));
}
