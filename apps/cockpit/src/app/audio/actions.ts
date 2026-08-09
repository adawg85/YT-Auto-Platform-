"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { audioAssets } from "@ytauto/db";
import { audioLicenceDeedUrl, audioLicenceTraits, normaliseAudioLicence } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

/** #110: edit an audio-library asset's licence metadata from the cockpit. */
export async function patchAudioAssetAction(
  assetId: string,
  fields: {
    title?: string;
    creator?: string;
    creatorUrl?: string;
    sourceUrl?: string;
    licence?: string;
    licenceUrl?: string;
    mood?: string;
    notes?: string;
    modified?: boolean;
    commercialUse?: boolean | null;
  },
): Promise<{ error?: string }> {
  const { db } = await getAppContext();
  const [existing] = await db.select().from(audioAssets).where(eq(audioAssets.id, assetId));
  if (!existing) return { error: "Asset not found." };
  const patch: Record<string, unknown> = {};
  const set = (k: keyof typeof fields, col?: string) => {
    const v = fields[k];
    if (typeof v === "string") patch[col ?? k] = v.trim() || null;
  };
  set("title");
  set("creator");
  set("creatorUrl");
  set("sourceUrl");
  set("mood");
  set("notes");
  if (typeof fields.modified === "boolean") patch.modified = fields.modified;
  if (fields.licence !== undefined) {
    const licence = normaliseAudioLicence(fields.licence);
    patch.licence = licence;
    const traits = audioLicenceTraits(licence);
    // commercialUse re-derives with the licence unless explicitly pinned below
    patch.commercialUse = traits.known ? traits.commercialUse : null;
    patch.licenceUrl = fields.licenceUrl?.trim() || audioLicenceDeedUrl(licence);
  } else if (fields.licenceUrl !== undefined) {
    patch.licenceUrl = fields.licenceUrl.trim() || null;
  }
  if (typeof fields.commercialUse === "boolean") patch.commercialUse = fields.commercialUse;
  if (patch.title === null) return { error: "Title is required." };
  if (Object.keys(patch).length) {
    await db.update(audioAssets).set(patch).where(eq(audioAssets.id, assetId));
  }
  revalidatePath("/audio");
  return {};
}

/** #110: drop a library row (the stored bytes are kept — bed rows may reference them). */
export async function deleteAudioAssetAction(assetId: string): Promise<{ error?: string }> {
  const { db } = await getAppContext();
  await db.delete(audioAssets).where(eq(audioAssets.id, assetId));
  revalidatePath("/audio");
  return {};
}
