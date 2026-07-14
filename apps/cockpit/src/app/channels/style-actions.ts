"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  assets,
  channelCharacters,
  channelDecisions,
  channelDna,
  channels,
  productions,
  styleTestScenes,
  thumbnails,
  ulid,
  visualStyleRefs,
  visualStyles,
  type VisualStyleDoc,
} from "@ytauto/db";
import { youtubeIdFromUrl, youtubeThumbnailUrl, resolveConditioning, styleBlockForImagePrompts } from "@ytauto/core";
import { distillVisualStyle, generateCharacterSheet, MAX_STYLE_REF_IMAGES } from "@ytauto/agents";
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

// ── Recurring channel characters (2026-07-14 operator ask) ─────────────────
// A named character (e.g. an educational channel's teacher) with a canonical
// appearance and a Nano Banana reference sheet, injected into generated shots
// whose scene calls for them — consistent across every video.

/**
 * Create a character: an LLM pass distills the operator's brief into the
 * canonical appearance paragraph, then Nano Banana renders the reference
 * sheet in the channel's style (Google-direct with a Gemini key, else fal's
 * nano-banana-pro via the hero tier).
 */
export async function createChannelCharacterAction(
  channelId: string,
  formData: FormData,
): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const brief = String(formData.get("brief") ?? "").trim();
  if (!name || !brief) return;
  const { db, providers, costSink } = await getAppContext();
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  const imageStyle = dna?.visualStyle?.imageStyle || "clean flat illustration, high contrast";
  let styleBlock: string | null = null;
  if (dna?.activeStyleId) {
    const [styleRow] = await db
      .select()
      .from(visualStyles)
      .where(eq(visualStyles.id, dna.activeStyleId));
    if (styleRow?.status === "active") styleBlock = styleBlockForImagePrompts(styleRow.doc);
  }
  try {
    const sheet = await generateCharacterSheet(
      { db, llm: providers.llm, costSink, channelId },
      { name, brief, imageStyle, styleBlock },
    );
    const prompt =
      `Character reference sheet: full-body studio portrait of ${sheet.description} ` +
      `Standing upright facing the camera, whole figure visible head to toe, relaxed neutral ` +
      `pose, plain seamless background, even soft studio lighting. ${imageStyle}.`;
    const { storageKey, mimeType } = await providers.media.generateImage({
      prompt,
      aspect: "1:1",
      channelId,
      storageKeyBase: `channels/${channelId}/characters/${ulid()}`,
      quality: "hero",
      engine: "nano-banana",
    });
    await db.insert(channelCharacters).values({
      id: ulid(),
      channelId,
      name,
      brief,
      description: sheet.description,
      imageKey: storageKey,
      mimeType,
    });
    await db.insert(channelDecisions).values({
      id: ulid(),
      channelId,
      kind: "operator_steer",
      summary: `Character "${name}" created for image consistency`,
      detail: { name, brief },
      actor: "operator",
    });
  } catch (err) {
    console.error(`[style] character creation failed for ${channelId}:`, err);
  }
  revalidate(channelId);
}

export async function toggleChannelCharacterAction(channelId: string, characterId: string): Promise<void> {
  const { db } = await getAppContext();
  const [row] = await db.select().from(channelCharacters).where(eq(channelCharacters.id, characterId));
  if (!row || row.channelId !== channelId) return;
  await db
    .update(channelCharacters)
    .set({ enabled: !row.enabled })
    .where(eq(channelCharacters.id, characterId));
  revalidate(channelId);
}

export async function deleteChannelCharacterAction(channelId: string, characterId: string): Promise<void> {
  const { db } = await getAppContext();
  await db
    .delete(channelCharacters)
    .where(and(eq(channelCharacters.id, characterId), eq(channelCharacters.channelId, channelId)));
  // reference-sheet bytes stay in the store — past productions may cite them
  revalidate(channelId);
}

// ── Style-tab iteration loop (2026-07-14 operator ask) ─────────────────────
// Refine a character image with comments (current image = edit reference),
// and test a distilled style on throwaway scenes — refine those too, then
// promote keepers into the example pool as "generated" refs.

/** A URL the image vendors can fetch for the given stored image: presigned
 * when the store supports it, else an inline data: URL (Node fetch and the
 * Google adapter both consume data: URLs). Mock SVGs return null — real
 * vendors reject SVG inputs. */
async function referenceUrlFor(
  store: { presignGet?: (key: string, ttlSec: number) => Promise<string>; getBuffer: (key: string) => Promise<Buffer> },
  imageKey: string,
  mimeType: string,
): Promise<string | null> {
  if (mimeType.includes("svg")) return null;
  if (store.presignGet) return store.presignGet(imageKey, 3600);
  const buf = await store.getBuffer(imageKey);
  return `data:${mimeType};base64,${buf.toString("base64")}`;
}

/**
 * Regenerate a character's reference sheet per operator comments: the sheet
 * agent applies the comments to the canonical description (unmentioned
 * details stay verbatim), then the image model reworks the CURRENT image
 * (nano edit) toward the revised look — description and pixels stay in sync.
 */
export async function refineChannelCharacterAction(
  channelId: string,
  characterId: string,
  comments: string,
): Promise<{ url: string } | { error: string }> {
  const text = comments.trim();
  if (!text) return { error: "Describe the changes you want first" };
  const { db, providers, costSink } = await getAppContext();
  const [character] = await db
    .select()
    .from(channelCharacters)
    .where(and(eq(channelCharacters.id, characterId), eq(channelCharacters.channelId, channelId)));
  if (!character) return { error: "Character not found" };
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  const imageStyle = dna?.visualStyle?.imageStyle || "clean flat illustration, high contrast";
  try {
    const sheet = await generateCharacterSheet(
      { db, llm: providers.llm, costSink, channelId },
      {
        name: character.name,
        brief: character.brief,
        imageStyle,
        currentDescription: character.description,
        comments: text,
      },
    );
    const referenceImageUrl = await referenceUrlFor(providers.store, character.imageKey, character.mimeType);
    const prompt =
      `Character reference sheet: full-body studio portrait of ${sheet.description} ` +
      `Apply this change to the existing character: ${text}. Keep the SAME person — identical ` +
      `face and identity — standing upright facing the camera, whole figure visible head to toe, ` +
      `plain seamless background, even soft studio lighting. ${imageStyle}.`;
    const { storageKey, mimeType } = await providers.media.generateImage({
      prompt,
      aspect: "1:1",
      channelId,
      storageKeyBase: `channels/${channelId}/characters/${ulid()}`,
      quality: "hero",
      engine: "nano-banana",
      ...(referenceImageUrl ? { referenceImageUrl } : {}),
    });
    await db
      .update(channelCharacters)
      .set({ description: sheet.description, imageKey: storageKey, mimeType })
      .where(eq(channelCharacters.id, characterId));
    await db.insert(channelDecisions).values({
      id: ulid(),
      channelId,
      kind: "operator_steer",
      summary: `Character "${character.name}" refined: ${text.slice(0, 120)}`,
      detail: { characterId, comments: text },
      actor: "operator",
    });
    revalidate(channelId);
    return { url: `/api/media/${storageKey}` };
  } catch (err) {
    console.error(`[style] character refine failed for ${characterId}:`, err);
    return { error: err instanceof Error ? err.message : "Refine failed" };
  }
}

/**
 * Generate a style test scene: the scene ask + (optionally) a character's
 * canonical description + the style doc's prompt block, rendered on the hero
 * model. Casting a character also conditions on its reference sheet — the
 * exact input combination the production pipeline will use.
 */
export async function generateStyleTestSceneAction(
  channelId: string,
  input: { styleId: string; scene: string; characterId?: string | null },
): Promise<{ url: string } | { error: string }> {
  const scene = input.scene.trim();
  if (!scene) return { error: "Describe the scene first" };
  const { db, providers, costSink } = await getAppContext();
  void costSink;
  const [style] = await db
    .select()
    .from(visualStyles)
    .where(and(eq(visualStyles.id, input.styleId), eq(visualStyles.channelId, channelId)));
  if (!style) return { error: "Style version not found" };
  const character = input.characterId
    ? (
        await db
          .select()
          .from(channelCharacters)
          .where(and(eq(channelCharacters.id, input.characterId), eq(channelCharacters.channelId, channelId)))
      )[0]
    : undefined;
  try {
    const referenceImageUrl = character
      ? await referenceUrlFor(providers.store, character.imageKey, character.mimeType)
      : null;
    const prompt = [
      character ? `${character.description} — ${scene}` : scene,
      "Explicit natural lighting, cinematic composition.",
      styleBlockForImagePrompts(style.doc),
    ]
      .filter(Boolean)
      .join(" ");
    const { storageKey, mimeType } = await providers.media.generateImage({
      prompt,
      aspect: "16:9",
      channelId,
      storageKeyBase: `channels/${channelId}/style-tests/${ulid()}`,
      quality: "hero",
      engine: "nano-banana",
      ...(referenceImageUrl ? { referenceImageUrl } : {}),
    });
    await db.insert(styleTestScenes).values({
      id: ulid(),
      channelId,
      styleId: style.id,
      characterId: character?.id ?? null,
      prompt: scene,
      imageKey: storageKey,
      mimeType,
    });
    revalidate(channelId);
    return { url: `/api/media/${storageKey}` };
  } catch (err) {
    console.error(`[style] test scene generation failed for ${channelId}:`, err);
    return { error: err instanceof Error ? err.message : "Scene generation failed" };
  }
}

/** Refine a test scene: regenerate with the CURRENT image as the edit
 * reference plus the operator's comments ("add extras", tweaks, …). */
export async function refineStyleTestSceneAction(
  channelId: string,
  sceneId: string,
  comments: string,
): Promise<{ url: string } | { error: string }> {
  const text = comments.trim();
  if (!text) return { error: "Describe the changes you want first" };
  const { db, providers } = await getAppContext();
  const [sceneRow] = await db
    .select()
    .from(styleTestScenes)
    .where(and(eq(styleTestScenes.id, sceneId), eq(styleTestScenes.channelId, channelId)));
  if (!sceneRow) return { error: "Test scene not found" };
  const [style] = await db.select().from(visualStyles).where(eq(visualStyles.id, sceneRow.styleId));
  try {
    const referenceImageUrl = await referenceUrlFor(providers.store, sceneRow.imageKey, sceneRow.mimeType);
    const prompt = [
      `Rework this scene: ${sceneRow.prompt}.`,
      `Changes to apply: ${text}.`,
      "Keep everything not mentioned the same.",
      style ? styleBlockForImagePrompts(style.doc) : "",
    ]
      .filter(Boolean)
      .join(" ");
    const { storageKey, mimeType } = await providers.media.generateImage({
      prompt,
      aspect: "16:9",
      channelId,
      storageKeyBase: `channels/${channelId}/style-tests/${ulid()}`,
      quality: "hero",
      engine: "nano-banana",
      ...(referenceImageUrl ? { referenceImageUrl } : {}),
    });
    await db
      .update(styleTestScenes)
      .set({ imageKey: storageKey, mimeType, lastComments: text })
      .where(eq(styleTestScenes.id, sceneId));
    revalidate(channelId);
    return { url: `/api/media/${storageKey}` };
  } catch (err) {
    console.error(`[style] test scene refine failed for ${sceneId}:`, err);
    return { error: err instanceof Error ? err.message : "Refine failed" };
  }
}

/** Promote an approved test scene into the example pool: it becomes a
 * "generated" visualStyleRef and feeds the next distill/conditioning exactly
 * like an uploaded example. */
export async function promoteTestSceneAction(channelId: string, sceneId: string): Promise<void> {
  const { db } = await getAppContext();
  const [sceneRow] = await db
    .select()
    .from(styleTestScenes)
    .where(and(eq(styleTestScenes.id, sceneId), eq(styleTestScenes.channelId, channelId)));
  if (!sceneRow) return;
  await db.insert(visualStyleRefs).values({
    id: ulid(),
    channelId,
    storageKey: sceneRow.imageKey,
    mimeType: sceneRow.mimeType,
    source: { type: "generated", sceneId },
    enabled: true,
  });
  revalidate(channelId);
}

export async function deleteTestSceneAction(channelId: string, sceneId: string): Promise<void> {
  const { db } = await getAppContext();
  await db
    .delete(styleTestScenes)
    .where(and(eq(styleTestScenes.id, sceneId), eq(styleTestScenes.channelId, channelId)));
  // bytes kept — a promoted ref may share the storage key
  revalidate(channelId);
}
