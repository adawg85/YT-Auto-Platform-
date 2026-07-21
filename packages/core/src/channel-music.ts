import { and, asc, eq, sql } from "drizzle-orm";
import { channelMusic, type Db } from "@ytauto/db";

/**
 * Per-channel music bed (2026-07-21). A channel keeps a small pool (~6-8) of
 * reusable tracks; the pipeline ALTERNATES through them least-recently-used so
 * the channel sounds consistent without repeating the same bed every video.
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
};

/** Every track in a channel's bed, never-used first then least-recently-used. */
export async function listChannelBed(db: Db, channelId: string): Promise<ChannelBedTrack[]> {
  return db
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
    })
    .from(channelMusic)
    .where(eq(channelMusic.channelId, channelId))
    // NULLS FIRST so a never-used track is always preferred before any repeat.
    .orderBy(sql`${channelMusic.lastUsedAt} asc nulls first`, asc(channelMusic.createdAt));
}

/**
 * Pick the next bed track for a video and STAMP it used (advances the rotation
 * cursor) in one shot. Returns null when the channel has no bed yet — the
 * caller then falls back to generating a bed. Least-recently-used wins, so a
 * channel cycles through all its tracks before any repeats.
 */
export async function pickChannelBedTrack(db: Db, channelId: string): Promise<ChannelBedTrack | null> {
  const [next] = await listChannelBed(db, channelId);
  if (!next) return null;
  await db.update(channelMusic).set({ lastUsedAt: new Date() }).where(eq(channelMusic.id, next.id));
  return next;
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
    })
    .onConflictDoNothing({ target: [channelMusic.channelId, channelMusic.storageKey] });
}

/** Remove a bed track by id (scoped to the channel to prevent cross-channel deletes). */
export async function removeChannelBedTrack(db: Db, channelId: string, id: string): Promise<void> {
  await db.delete(channelMusic).where(and(eq(channelMusic.id, id), eq(channelMusic.channelId, channelId)));
}
