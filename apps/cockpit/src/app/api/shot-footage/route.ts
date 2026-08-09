import { NextRequest, NextResponse } from "next/server";
import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { assets, productions, ulid } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

export const dynamic = "force-dynamic";

/**
 * #112: operator-recorded FOOTAGE upload for one shot (the video counterpart to
 * /api/voiceover-take). CHUNKED like /api/audio-asset — the platform chain caps
 * a single request around 20MB and video files are the biggest we take. The
 * route stores the RAW file and fires production/operator-clip.requested; the
 * WORKER trims/scales it to the shot window (ffmpeg lives there) and attaches
 * it as the shot's video_clip with operatorFootage meta. Returns the reqToken
 * the existing Animate poller (clipStatusAction) resolves against, so the row
 * flags queued → done exactly like an i2v clip. Behind the operator Basic-auth
 * middleware like every route.
 */

const MAX_BYTES = 150 * 1024 * 1024; // the worker normalizes in memory — bounded on purpose
const UPLOAD_DIR = join(tmpdir(), "ytauto-footage-uploads");
const UPLOAD_ID = /^[a-z0-9-]{8,64}$/i;
const TERMINAL = new Set(["published", "rejected", "failed", "halted", "retired", "superseded"]);

const EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-m4v": "m4v",
};
const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
};

function resolveVideoType(reportedMime: string, fileName: string): { mime: string; ext: string } | null {
  const mime = (reportedMime || "").split(";")[0]!.trim().toLowerCase();
  const ext = EXT_BY_MIME[mime];
  if (ext) return { mime, ext };
  const nameExt = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const byName = MIME_BY_EXT[nameExt];
  if (byName) return { mime: byName, ext: nameExt };
  return null;
}

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
    /* dir may not exist yet */
  }
}

async function attach(opts: {
  productionId: string;
  shotIdx: number;
  buf: Buffer;
  reportedMime: string;
  fileName: string;
}): Promise<NextResponse> {
  const { productionId, shotIdx, buf, reportedMime, fileName } = opts;
  if (buf.length === 0 || buf.length > MAX_BYTES) {
    return NextResponse.json({ error: `video must be 1 byte to ${MAX_BYTES / 1024 / 1024}MB` }, { status: 400 });
  }
  const type = resolveVideoType(reportedMime, fileName);
  if (!type) {
    return NextResponse.json(
      { error: `Unsupported video type "${reportedMime || "unknown"}" (${fileName}) — send mp4, mov, m4v or webm` },
      { status: 400 },
    );
  }
  const { db, providers } = await getAppContext();
  const [prod] = await db
    .select({ id: productions.id, status: productions.status })
    .from(productions)
    .where(eq(productions.id, productionId));
  if (!prod) return NextResponse.json({ error: "Production not found" }, { status: 404 });
  if (TERMINAL.has(prod.status)) {
    return NextResponse.json({ error: `Production is ${prod.status} — footage can't be attached` }, { status: 400 });
  }
  const [img] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image"), eq(assets.idx, shotIdx)));
  if (!img) {
    return NextResponse.json(
      { error: `Shot ${shotIdx + 1} has no image row yet — footage attaches to an existing shot (wait for visuals, or pick another shot)` },
      { status: 400 },
    );
  }
  const reqToken = ulid().toLowerCase();
  const rawKey = `productions/${productionId}/operator-raw-${shotIdx}-${reqToken}.${type.ext}`;
  await providers.store.put(rawKey, buf, type.mime);
  await inngest.send({
    name: "production/operator-clip.requested",
    data: { productionId, idx: shotIdx, rawKey, dedupe: reqToken },
  });
  return NextResponse.json({ ok: true, reqToken, rawKey });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const field = (k: string): string | null => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const productionId = field("productionId") ?? "";
  const shotIdx = Number(field("shotIdx") ?? "-1");
  if (!productionId || !Number.isInteger(shotIdx) || shotIdx < 0) {
    return NextResponse.json({ error: "productionId and shotIdx are required" }, { status: 400 });
  }

  // single-shot path (small files)
  const whole = form.get("video");
  if (whole instanceof Blob) {
    const fileName = whole instanceof File ? whole.name : "footage";
    return attach({ productionId, shotIdx, buf: Buffer.from(await whole.arrayBuffer()), reportedMime: whole.type, fileName });
  }

  // chunked path (the normal one for video)
  const chunk = form.get("chunk");
  const uploadId = field("uploadId");
  const seq = Number(field("seq") ?? "-1");
  const last = field("last") === "true";
  if (!(chunk instanceof Blob) || !uploadId || !UPLOAD_ID.test(uploadId) || !Number.isInteger(seq) || seq < 0) {
    return NextResponse.json({ error: "send `video` (single-shot) or `chunk`+`uploadId`+`seq` (chunked)" }, { status: 400 });
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  if (seq === 0) await pruneStaleUploads();
  const partPath = join(UPLOAD_DIR, uploadId.toLowerCase());
  const existing = await stat(partPath).catch(() => null);
  if ((existing?.size ?? 0) + chunk.size > MAX_BYTES) {
    await unlink(partPath).catch(() => {});
    return NextResponse.json({ error: `video must be at most ${MAX_BYTES / 1024 / 1024}MB` }, { status: 413 });
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
  return attach({
    productionId,
    shotIdx,
    buf,
    reportedMime: field("mime") ?? "",
    fileName: field("fileName") ?? "footage",
  });
}
