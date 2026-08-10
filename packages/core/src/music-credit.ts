import { and, eq } from "drizzle-orm";
import { audioAssets, productionMusic, type Db } from "@ytauto/db";
import { audioAttributionLine } from "./audio-assets";
import type { MusicCreditRow } from "./publish-credits";

/**
 * #110 follow-up: resolve the credit row for a production's selected track —
 * the ONE path both publish and the post-publish metadata editor use, so a
 * description is assembled from the same record everywhere.
 *
 * When the track's storage key matches a platform audio-library asset, the
 * credit comes from the LIVE asset record (the rights-holder's
 * requiredCreditFormat verbatim when set, else the current attribution line) —
 * so an operator who corrects an asset's licence record after attaching it gets
 * the corrected credit at publish, not a stale copy. Tracks with no library
 * record (openverse imports, generated beds) keep the row's own fields.
 */
export async function selectedMusicCreditRow(db: Db, productionId: string): Promise<MusicCreditRow> {
  const [row] = await db
    .select({
      name: productionMusic.name,
      storageKey: productionMusic.storageKey,
      attribution: productionMusic.attribution,
      license: productionMusic.license,
      licenseUrl: productionMusic.licenseUrl,
    })
    .from(productionMusic)
    .where(and(eq(productionMusic.productionId, productionId), eq(productionMusic.selected, true)))
    .limit(1);
  if (!row) return null;
  const [asset] = await db
    .select()
    .from(audioAssets)
    .where(eq(audioAssets.storageKey, row.storageKey))
    .limit(1);
  if (!asset) return row;
  return {
    name: row.name,
    requiredCredit: asset.requiredCreditFormat,
    attribution: audioAttributionLine(asset) ?? row.attribution,
    license: asset.licence ?? row.license,
    licenseUrl: asset.licenceUrl ?? row.licenseUrl,
  };
}
