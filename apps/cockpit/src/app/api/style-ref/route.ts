import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { channels, ulid, visualStyleRefs } from "@ytauto/db";
import { getAppContext } from "@/lib/context";

export const dynamic = "force-dynamic";

/**
 * #35.1 style reference uploads. POST multipart: channelId + image
 * (jpeg/png/webp, ≤10MB) → ObjectStore under channels/<id>/style/ +
 * visual_style_refs row. DELETE removes the row only (bytes kept — a
 * distilled version's refIds snapshot may still cite it). Behind the
 * operator Basic-auth middleware like every route.
 */

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const channelId = String(form.get("channelId") ?? "");
  const file = form.get("image");
  if (!channelId || !(file instanceof Blob)) {
    return NextResponse.json({ error: "channelId and image are required" }, { status: 400 });
  }
  const mime = (file.type || "").split(";")[0]!;
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    return NextResponse.json({ error: "image must be JPEG, PNG or WebP" }, { status: 400 });
  }
  if (file.size === 0 || file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "image must be 0-10MB" }, { status: 400 });
  }

  const { db, providers } = await getAppContext();
  const [channel] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId));
  if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 });

  const refId = ulid();
  const storageKey = `channels/${channelId}/style/ref-${refId}.${ext}`;
  await providers.store.put(storageKey, Buffer.from(await file.arrayBuffer()), mime);
  await db.insert(visualStyleRefs).values({
    id: refId,
    channelId,
    storageKey,
    mimeType: mime,
    source: { type: "upload" },
  });
  return NextResponse.json({ ok: true, refId, storageKey });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const refId = searchParams.get("refId") ?? "";
  if (!refId) return NextResponse.json({ error: "refId is required" }, { status: 400 });
  const { db } = await getAppContext();
  await db.delete(visualStyleRefs).where(eq(visualStyleRefs.id, refId));
  return NextResponse.json({ ok: true });
}
