import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { assets, productions, ulid } from "@ytauto/db";
import { getAppContext } from "@/lib/context";

export const dynamic = "force-dynamic";

/**
 * #27 operator voiceover takes. POST multipart form: productionId, beatIdx,
 * audio (webm/ogg/wav/mp3 from MediaRecorder). One take per beat — re-record
 * overwrites. Takes are PERMANENT assets (voice-clone source material) and
 * downloadable via /api/media/<storageKey>. DELETE removes a take (that beat
 * falls back to TTS at assembly). Behind the operator Basic-auth middleware
 * like every other route.
 */

const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
};

const TERMINAL = new Set(["published", "rejected", "failed", "halted"]);

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const productionId = String(form.get("productionId") ?? "");
  const beatIdx = Number(form.get("beatIdx"));
  const file = form.get("audio");
  if (!productionId || !Number.isInteger(beatIdx) || beatIdx < 0 || !(file instanceof Blob)) {
    return NextResponse.json({ error: "productionId, beatIdx and audio are required" }, { status: 400 });
  }
  if (file.size === 0 || file.size > 50 * 1024 * 1024) {
    return NextResponse.json({ error: "audio must be 0-50MB" }, { status: 400 });
  }

  const { db, providers } = await getAppContext();
  const [prod] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!prod) return NextResponse.json({ error: "Production not found" }, { status: 404 });
  if (TERMINAL.has(prod.status)) {
    return NextResponse.json({ error: `Production is ${prod.status}` }, { status: 409 });
  }

  const mime = (file.type || "audio/webm").split(";")[0]!;
  const ext = EXT_BY_MIME[mime] ?? "webm";
  const storageKey = `productions/${productionId}/vo-take-${beatIdx}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await providers.store.put(storageKey, buf, mime);

  await db
    .insert(assets)
    .values({
      id: ulid(),
      productionId,
      kind: "voiceover_take",
      idx: beatIdx,
      storageKey,
      mimeType: mime,
      meta: { source: "operator", bytes: buf.length, recordedAt: new Date().toISOString() },
    })
    .onConflictDoUpdate({
      target: [assets.productionId, assets.kind, assets.idx],
      set: {
        storageKey,
        mimeType: mime,
        meta: { source: "operator", bytes: buf.length, recordedAt: new Date().toISOString() },
      },
    });

  return NextResponse.json({ ok: true, storageKey });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const productionId = searchParams.get("productionId") ?? "";
  const beatIdx = Number(searchParams.get("beatIdx"));
  if (!productionId || !Number.isInteger(beatIdx)) {
    return NextResponse.json({ error: "productionId and beatIdx are required" }, { status: 400 });
  }
  const { db } = await getAppContext();
  await db
    .delete(assets)
    .where(
      and(
        eq(assets.productionId, productionId),
        eq(assets.kind, "voiceover_take"),
        eq(assets.idx, beatIdx),
      ),
    );
  // storage bytes intentionally kept — irreplaceable human audio (clone source)
  return NextResponse.json({ ok: true });
}
