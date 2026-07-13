"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  assets,
  channelDecisions,
  channelDna,
  channels,
  productions,
  thumbnails,
  ulid,
  visualStyleRefs,
  visualStyles,
  type VisualStyleDoc,
} from "@ytauto/db";
import { youtubeIdFromUrl, youtubeThumbnailUrl, resolveConditioning } from "@ytauto/core";
import { distillVisualStyle, MAX_STYLE_REF_IMAGES } from "@ytauto/agents";
import { getAppContext } from "@/lib/context";

/**
 * #35.1 visual style DNA actions: ingest example images (YouTube thumbnails,
 * promoted own assets — uploads go through /api/style-ref), distill them into
 * a versioned style doc, activate versions, dial conditioning. Mirrors the
 * persona actions' conventions (new version on every edit, explicit
 * activation, decision-ledger rows).
 */

const revalidate = (channelId: string) => revalidatePath(`/channels/${channelId}`);

/** Shared ingestion used by the action AND the wizard-lite create path. */
export async function ingestYoutubeStyleRef(
  channelId: string,
  url: string,
): Promise<{ refId?: string; error?: string }> {
  const videoId = youtubeIdFromUrl(url);
  if (!videoId) return { error: `Not a recognizable YouTube video URL: ${url.slice(0, 80)}` };
  const { db, providers } = await getAppContext();
  const res = await fetch(youtubeThumbnailUrl(videoId));
  if (!res.ok) return { error: `Could not fetch the thumbnail for ${videoId} (${res.status})` };
  const refId = ulid();
  const storageKey = `channels/${channelId}/style/ref-${refId}.jpg`;
  await providers.store.put(storageKey, Buffer.from(await res.arrayBuffer()), "image/jpeg");
  await db.insert(visualStyleRefs).values({
    id: refId,
    channelId,
    storageKey,
    mimeType: "image/jpeg",
    source: { type: "youtube", videoId, url },
  });
  return { refId };
}

export async function addYoutubeStyleRefAction(
  channelId: string,
  formData: FormData,
): Promise<void> {
  const url = String(formData.get("url") ?? "").trim();
  if (!url) return;
  await ingestYoutubeStyleRef(channelId, url);
  revalidate(channelId);
}

/** Promote an existing production asset/thumbnail into the style pool (bytes
 * COPIED — production deletion must never orphan the pool). */
export async function promoteAssetStyleRefAction(
  channelId: string,
  opts: { assetId?: string; thumbnailId?: string },
): Promise<{ error?: string }> {
  const { db, providers } = await getAppContext();
  let storageKey: string | undefined;
  let mimeType = "image/jpeg";
  let sourceAssetId: string | undefined;
  if (opts.assetId) {
    const [row] = await db
      .select({ storageKey: assets.storageKey, mimeType: assets.mimeType, productionId: assets.productionId })
      .from(assets)
      .where(eq(assets.id, opts.assetId));
    if (!row) return { error: "Asset not found" };
    const [prod] = await db
      .select({ channelId: productions.channelId })
      .from(productions)
      .where(eq(productions.id, row.productionId));
    if (prod?.channelId !== channelId) return { error: "Asset belongs to another channel" };
    storageKey = row.storageKey;
    mimeType = row.mimeType;
    sourceAssetId = opts.assetId;
  } else if (opts.thumbnailId) {
    const [row] = await db
      .select({ storageKey: thumbnails.storageKey, productionId: thumbnails.productionId })
      .from(thumbnails)
      .where(eq(thumbnails.id, opts.thumbnailId));
    if (!row) return { error: "Thumbnail not found" };
    const [prod] = await db
      .select({ channelId: productions.channelId })
      .from(productions)
      .where(eq(productions.id, row.productionId));
    if (prod?.channelId !== channelId) return { error: "Thumbnail belongs to another channel" };
    storageKey = row.storageKey;
    sourceAssetId = opts.thumbnailId;
  }
  if (!storageKey) return { error: "Nothing to promote" };

  const bytes = await providers.store.getBuffer(storageKey);
  const refId = ulid();
  const ext = storageKey.slice(storageKey.lastIndexOf(".") + 1) || "jpg";
  const poolKey = `channels/${channelId}/style/ref-${refId}.${ext}`;
  await providers.store.put(poolKey, bytes, mimeType);
  await db.insert(visualStyleRefs).values({
    id: refId,
    channelId,
    storageKey: poolKey,
    mimeType,
    source: { type: "asset", assetId: sourceAssetId },
  });
  revalidate(channelId);
  return {};
}

/** Distill the newest ≤8 enabled refs into a NEW draft style version. Shared
 * by the Style tab action and the wizard-lite create path (autoActivate). */
export async function distillStyleCore(
  channelId: string,
  opts: { notes?: string; autoActivate?: boolean } = {},
): Promise<{ styleId?: string; error?: string }> {
  const notes = opts.notes;
  const { db, providers, costSink } = await getAppContext();
  const refs = await db
    .select()
    .from(visualStyleRefs)
    .where(and(eq(visualStyleRefs.channelId, channelId), eq(visualStyleRefs.enabled, true)))
    .orderBy(desc(visualStyleRefs.createdAt))
    .limit(MAX_STYLE_REF_IMAGES);
  if (refs.length === 0) return { error: "Add at least one example image first" };

  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  if (!channel) return { error: "Channel not found" };

  const images = [];
  for (const r of refs) {
    try {
      images.push({ bytes: await providers.store.getBuffer(r.storageKey), mimeType: r.mimeType });
    } catch {
      // a missing blob never blocks distillation of the rest
    }
  }
  if (images.length === 0) return { error: "No readable example images" };

  let distilled;
  try {
    distilled = await distillVisualStyle(
      { db, llm: providers.llm, costSink, channelId },
      {
        images,
        niche: channel.niche,
        imageStyle: dna?.visualStyle?.imageStyle ?? "",
        notes,
      },
    );
  } catch (err) {
    return { error: `Distillation failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const existing = await db
    .select({ version: visualStyles.version, id: visualStyles.id, status: visualStyles.status })
    .from(visualStyles)
    .where(eq(visualStyles.channelId, channelId))
    .orderBy(desc(visualStyles.version));
  const active = existing.find((s) => s.status === "active");
  const { rationale, ...docFields } = distilled;
  const doc: VisualStyleDoc = {
    ...docFields,
    refIds: refs.map((r) => r.id),
    conditioning: { scope: "thumbs_hero", strength: 0.45 },
  };
  const styleId = ulid();
  await db.insert(visualStyles).values({
    id: styleId,
    channelId,
    name: `Style v${(existing[0]?.version ?? 0) + 1}`,
    version: (existing[0]?.version ?? 0) + 1,
    parentId: active?.id ?? null,
    status: opts.autoActivate ? "active" : "draft",
    createdBy: "operator",
    doc,
    rationale,
  });
  if (opts.autoActivate) {
    await db
      .update(channelDna)
      .set({ activeStyleId: styleId })
      .where(eq(channelDna.channelId, channelId));
  }
  revalidate(channelId);
  return { styleId };
}

/** Style-tab form action wrapper over distillStyleCore (form actions return void). */
export async function distillStyleAction(channelId: string, formData: FormData): Promise<void> {
  const res = await distillStyleCore(channelId, {
    notes: String(formData.get("notes") ?? "").trim() || undefined,
  });
  if (res.error) console.error(`[style] distillation failed for ${channelId}: ${res.error}`);
}

/** Activate a version: retire the previous active, flip the DNA pointer. */
export async function activateStyleAction(channelId: string, styleId: string): Promise<void> {
  const { db } = await getAppContext();
  const [style] = await db.select().from(visualStyles).where(eq(visualStyles.id, styleId));
  if (!style || style.channelId !== channelId) return;
  await db
    .update(visualStyles)
    .set({ status: "retired" })
    .where(
      and(
        eq(visualStyles.channelId, channelId),
        inArray(visualStyles.status, ["active"]),
      ),
    );
  await db.update(visualStyles).set({ status: "active" }).where(eq(visualStyles.id, styleId));
  await db.update(channelDna).set({ activeStyleId: styleId }).where(eq(channelDna.channelId, channelId));
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    summary: `Visual style v${style.version} activated`,
    detail: { styleId, version: style.version },
    actor: "operator",
  });
  revalidate(channelId);
}

/** Conditioning is a DIAL, not a style change — updates in place (mirrors
 * updatePersonaPaceAction). Everything else about a doc needs a new version. */
export async function updateStyleConditioningAction(
  channelId: string,
  styleId: string,
  formData: FormData,
): Promise<void> {
  const { db } = await getAppContext();
  const [style] = await db.select().from(visualStyles).where(eq(visualStyles.id, styleId));
  if (!style || style.channelId !== channelId) return;
  const next = resolveConditioning({
    conditioning: {
      scope: String(formData.get("scope") ?? ""),
      strength: Number(formData.get("strength")),
    },
  });
  await db
    .update(visualStyles)
    .set({ doc: { ...style.doc, conditioning: next } })
    .where(eq(visualStyles.id, styleId));
  revalidate(channelId);
}

export async function toggleStyleRefAction(channelId: string, refId: string): Promise<void> {
  const { db } = await getAppContext();
  const [ref] = await db.select().from(visualStyleRefs).where(eq(visualStyleRefs.id, refId));
  if (!ref || ref.channelId !== channelId) return;
  await db
    .update(visualStyleRefs)
    .set({ enabled: !ref.enabled })
    .where(eq(visualStyleRefs.id, refId));
  revalidate(channelId);
}

export async function deleteStyleRefAction(channelId: string, refId: string): Promise<void> {
  const { db } = await getAppContext();
  await db
    .delete(visualStyleRefs)
    .where(and(eq(visualStyleRefs.id, refId), eq(visualStyleRefs.channelId, channelId)));
  // bytes kept — refIds snapshots on distilled versions may still cite them
  revalidate(channelId);
}
