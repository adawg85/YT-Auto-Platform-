import { eq } from "drizzle-orm";
import { audioAssets, type Db } from "@ytauto/db";
import { AUDIO_DURATION_HEAD_BYTES, estimateAudioDurationSec } from "@ytauto/core";
import type { ObjectStore } from "@ytauto/providers";

type AudioAssetRow = typeof audioAssets.$inferSelect;

/**
 * #110 follow-up ("durationSec is null on every registered asset"): read a
 * stored file's head and estimate its duration. Duration is the one field not
 * discoverable from the source page — it lives in the bytes — and with it null,
 * `list_audio_assets(minDurationSec)` matched nothing, so the designed defence
 * against the under-a-Short loop trap was inert.
 */
async function probeStoredDuration(store: ObjectStore, storageKey: string, mimeType: string): Promise<number | null> {
  const { stream, contentLength } = await store.getStream(storageKey);
  const chunks: Buffer[] = [];
  let got = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.from(chunk));
      got += chunk.length;
      if (got >= AUDIO_DURATION_HEAD_BYTES) break;
    }
  } finally {
    (stream as { destroy?: () => void }).destroy?.();
  }
  let head: Buffer = Buffer.concat(chunks);
  let totalBytes = contentLength ?? 0;
  if (!totalBytes) {
    // no declared length (some stores) — a full read is the honest fallback,
    // and this runs at most once per row (the result is persisted)
    const buf = await store.getBuffer(storageKey);
    totalBytes = buf.length;
    head = buf.subarray(0, AUDIO_DURATION_HEAD_BYTES);
  }
  return estimateAudioDurationSec(head, totalBytes, mimeType);
}

/**
 * Fill `durationSec` for any of the given library rows still null, persisting
 * what the probe finds — the lazy backfill for assets ingested before the
 * probe existed. Failures are per-row and non-fatal (a storage hiccup must not
 * take the listing down); a row whose container we can't read stays null,
 * completable via patch_audio_asset.
 */
export async function backfillAudioDurations(db: Db, store: ObjectStore, rows: AudioAssetRow[]): Promise<AudioAssetRow[]> {
  const out: AudioAssetRow[] = [];
  for (const row of rows) {
    if (row.durationSec != null) {
      out.push(row);
      continue;
    }
    let durationSec: number | null = null;
    try {
      durationSec = await probeStoredDuration(store, row.storageKey, row.mimeType);
    } catch {
      durationSec = null;
    }
    if (durationSec != null) {
      await db.update(audioAssets).set({ durationSec }).where(eq(audioAssets.id, row.id));
      out.push({ ...row, durationSec });
    } else {
      out.push(row);
    }
  }
  return out;
}
