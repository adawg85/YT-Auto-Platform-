import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { audioAssets, ulid } from "@ytauto/db";
import { audioLicenceTraits, normaliseAudioLicence, audioLicenceDeedUrl } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

export const dynamic = "force-dynamic";

/**
 * #110 audio-library uploads. POST multipart: audio (wav/mp3/m4a/ogg/webm,
 * ≤60MB) + optional licence metadata fields → ObjectStore under audio-library/
 * + audio_assets row. The MCP twin is register_audio_asset (URL fetch).
 * DELETE removes the row only (bytes kept — bed rows may still reference the
 * storageKey). Behind the operator Basic-auth middleware like every route.
 */

const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
};

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("audio");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "audio file is required" }, { status: 400 });
  }
  const mime = (file.type || "audio/mpeg").split(";")[0]!;
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    return NextResponse.json({ error: `Unsupported audio type "${mime}" — send wav, mp3, m4a, ogg or webm` }, { status: 400 });
  }
  if (file.size === 0 || file.size > 60 * 1024 * 1024) {
    return NextResponse.json({ error: "audio must be 1 byte to 60MB" }, { status: 400 });
  }

  const { db, providers } = await getAppContext();
  const id = ulid();
  const storageKey = `audio-library/${id.toLowerCase()}.${ext}`;
  await providers.store.put(storageKey, Buffer.from(await file.arrayBuffer()), mime);

  const field = (k: string): string | null => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const fileName = file instanceof File ? file.name.replace(/\.[a-z0-9]+$/i, "") : "";
  const licence = normaliseAudioLicence(field("licence"), field("licenceVersion"));
  const traits = audioLicenceTraits(licence);
  await db.insert(audioAssets).values({
    id,
    storageKey,
    mimeType: mime,
    title: field("title") ?? (fileName || "Untitled track"),
    creator: field("creator"),
    creatorUrl: field("creatorUrl"),
    sourceUrl: field("sourceUrl"),
    licence,
    licenceVersion: field("licenceVersion"),
    licenceUrl: field("licenceUrl") ?? audioLicenceDeedUrl(licence),
    modified: field("modified") === "true",
    commercialUse: traits.known ? traits.commercialUse : null,
    mood: field("mood"),
    notes: field("notes"),
  });
  return NextResponse.json({ ok: true, assetId: id, storageKey });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const assetId = searchParams.get("assetId") ?? "";
  if (!assetId) return NextResponse.json({ error: "assetId is required" }, { status: 400 });
  const { db } = await getAppContext();
  await db.delete(audioAssets).where(eq(audioAssets.id, assetId));
  return NextResponse.json({ ok: true });
}
