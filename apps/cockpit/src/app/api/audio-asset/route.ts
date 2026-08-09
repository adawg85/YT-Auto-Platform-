import { NextRequest, NextResponse } from "next/server";
import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { audioAssets, ulid } from "@ytauto/db";
import { audioLicenceTraits, normaliseAudioLicence, audioLicenceDeedUrl } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

export const dynamic = "force-dynamic";

/**
 * #110 audio-library uploads. The operator hit a ~20MB per-request ceiling in
 * the platform chain (our route allowed 60MB but big requests never arrived),
 * so uploads are CHUNKED: the client slices the file into ~8MB parts and POSTs
 * them sequentially; the server appends to a temp file and, on the last part,
 * validates the total against the client-declared size, stores the assembled
 * file, and creates the audio_assets row. No single request can hit a proxy
 * body cap. The old single-shot `audio` field still works for small files.
 * DELETE removes the row only (bytes kept — bed rows may still reference the
 * storageKey). Behind the operator Basic-auth middleware like every route.
 */

const MAX_BYTES = 60 * 1024 * 1024;
const UPLOAD_DIR = join(tmpdir(), "ytauto-audio-uploads");
const UPLOAD_ID = /^[a-z0-9-]{8,64}$/i;

// Wider than the first cut (#110 follow-up: "some upload, others not") — FLAC,
// AAC and the many spellings browsers use for the same container all land.
const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "application/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/x-mpeg": "mp3",
  "audio/mpeg3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};
const MIME_BY_EXT: Record<string, string> = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/mp4",
  flac: "audio/flac",
};

/** Resolve a storable mime + extension from the browser-reported type, falling
 * back to the FILENAME extension — file.type is unreliable ("" or
 * application/octet-stream on plenty of real audio files). */
function resolveAudioType(reportedMime: string, fileName: string): { mime: string; ext: string } | null {
  const mime = (reportedMime || "").split(";")[0]!.trim().toLowerCase();
  const ext = EXT_BY_MIME[mime];
  if (ext) return { mime: MIME_BY_EXT[ext] ?? mime, ext };
  const nameExt = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const byName = MIME_BY_EXT[nameExt];
  if (byName) return { mime: byName, ext: nameExt === "aac" ? "m4a" : nameExt };
  return null;
}

/** Abandoned partial uploads linger in tmp — sweep anything older than 2h. */
async function pruneStaleUploads(): Promise<void> {
  try {
    const names = await readdir(UPLOAD_DIR);
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const n of names) {
      const p = join(UPLOAD_DIR, n);
      const st = await stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) await unlink(p).catch(() => {});
    }
  } catch {
    // dir may not exist yet — nothing to prune
  }
}

async function storeAssembled(opts: {
  buf: Buffer;
  reportedMime: string;
  fileName: string;
  fields: (k: string) => string | null;
}): Promise<NextResponse> {
  const { buf, reportedMime, fileName, fields } = opts;
  if (buf.length === 0 || buf.length > MAX_BYTES) {
    return NextResponse.json({ error: `audio must be 1 byte to ${MAX_BYTES / 1024 / 1024}MB` }, { status: 400 });
  }
  const type = resolveAudioType(reportedMime, fileName);
  if (!type) {
    return NextResponse.json(
      { error: `Unsupported audio type "${reportedMime || "unknown"}" (${fileName}) — send mp3, wav, m4a, aac, ogg, flac or webm` },
      { status: 400 },
    );
  }
  const { db, providers } = await getAppContext();
  const id = ulid();
  const storageKey = `audio-library/${id.toLowerCase()}.${type.ext}`;
  await providers.store.put(storageKey, buf, type.mime);
  const baseName = fileName.replace(/\.[a-z0-9]+$/i, "");
  const licence = normaliseAudioLicence(fields("licence"), fields("licenceVersion"));
  const traits = audioLicenceTraits(licence);
  await db.insert(audioAssets).values({
    id,
    storageKey,
    mimeType: type.mime,
    title: fields("title") ?? (baseName || "Untitled track"),
    creator: fields("creator"),
    creatorUrl: fields("creatorUrl"),
    sourceUrl: fields("sourceUrl"),
    licence,
    licenceVersion: fields("licenceVersion"),
    licenceUrl: fields("licenceUrl") ?? audioLicenceDeedUrl(licence),
    modified: fields("modified") === "true",
    commercialUse: traits.known ? traits.commercialUse : null,
    mood: fields("mood"),
    notes: fields("notes"),
  });
  return NextResponse.json({ ok: true, assetId: id, storageKey });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const field = (k: string): string | null => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  // Legacy single-shot path (small files; also what dev/local uses happily).
  const whole = form.get("audio");
  if (whole instanceof Blob) {
    const fileName = whole instanceof File ? whole.name : "upload";
    return storeAssembled({
      buf: Buffer.from(await whole.arrayBuffer()),
      reportedMime: whole.type,
      fileName,
      fields: field,
    });
  }

  // Chunked path.
  const chunk = form.get("chunk");
  const uploadId = field("uploadId");
  const seq = Number(field("seq") ?? "-1");
  const last = field("last") === "true";
  if (!(chunk instanceof Blob) || !uploadId || !UPLOAD_ID.test(uploadId) || !Number.isInteger(seq) || seq < 0) {
    return NextResponse.json({ error: "send `audio` (single-shot) or `chunk`+`uploadId`+`seq` (chunked)" }, { status: 400 });
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  if (seq === 0) await pruneStaleUploads();
  const partPath = join(UPLOAD_DIR, uploadId.toLowerCase());
  const existing = await stat(partPath).catch(() => null);
  // over-cap guard while parts accumulate — kill the temp file, not the disk
  if ((existing?.size ?? 0) + chunk.size > MAX_BYTES) {
    await unlink(partPath).catch(() => {});
    return NextResponse.json({ error: `audio must be at most ${MAX_BYTES / 1024 / 1024}MB` }, { status: 413 });
  }
  await appendFile(partPath, Buffer.from(await chunk.arrayBuffer()));
  if (!last) return NextResponse.json({ ok: true, received: seq });

  const buf = await readFile(partPath);
  await unlink(partPath).catch(() => {});
  const declared = Number(field("totalBytes") ?? "0");
  if (declared > 0 && buf.length !== declared) {
    return NextResponse.json(
      { error: `upload incomplete — assembled ${buf.length} bytes but the file is ${declared}. Retry the upload.` },
      { status: 400 },
    );
  }
  return storeAssembled({
    buf,
    reportedMime: field("mime") ?? "",
    fileName: field("fileName") ?? "upload",
    fields: field,
  });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const assetId = searchParams.get("assetId") ?? "";
  if (!assetId) return NextResponse.json({ error: "assetId is required" }, { status: 400 });
  const { db } = await getAppContext();
  await db.delete(audioAssets).where(eq(audioAssets.id, assetId));
  return NextResponse.json({ ok: true });
}
