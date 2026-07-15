import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { channelDecisions, channels, ulid } from "@ytauto/db";
import { getAppContext } from "@/lib/context";

export const dynamic = "force-dynamic";

/**
 * Channel logo upload. POST multipart: channelId + image (jpeg/png/webp,
 * ≤10MB) → ObjectStore under channels/<id>/avatar-* → set channels.avatar_key.
 * Behind the operator Basic-auth middleware like every route. The wizard-
 * generated logo is persisted at creation; this is the after-the-fact path
 * (upload your own) that complements the AI "Generate logo" action.
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

  const storageKey = `channels/${channelId}/avatar-${ulid()}.${ext}`;
  await providers.store.put(storageKey, Buffer.from(await file.arrayBuffer()), mime);
  await db.update(channels).set({ avatarKey: storageKey }).where(eq(channels.id, channelId));
  // ledger row (2026-07-15): uploads join the brand-art version history, so
  // the Settings dialog can offer them as revert targets alongside generates
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    summary: "Channel logo uploaded",
    detail: { surface: "logo", mode: "upload", storageKey },
    actor: "operator",
  });
  return NextResponse.json({ ok: true, storageKey, url: `/api/media/${storageKey}` });
}
