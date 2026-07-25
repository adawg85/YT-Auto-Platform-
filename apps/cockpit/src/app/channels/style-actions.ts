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
} from "@ytauto/db";
import {
  CHARACTER_CAST_MODES,
  inngest,
  resolveConditioning,
  styleBlockForImagePrompts,
  youtubeIdFromUrl,
  youtubeThumbnailUrl,
} from "@ytauto/core";
import { getAppContext } from "@/lib/context";
import { referenceUrlFor } from "@/lib/reference-url";
import { generateStyleTestScene, refineStyleTestScene } from "@/lib/style-tests";
import {
  asCharacterEngine,
  createChannelCharacter,
  refineChannelCharacter,
  setChannelCharacterCast,
  deleteChannelCharacter,
} from "@/lib/characters";

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

/**
 * Kick a distillation run ON THE WORKER (2026-07-14, 502 fix): the vision
 * pass over ≤8 example images was the cockpit's heaviest sync request —
 * Render's edge killed it (~100s) and small instances OOM'd → operator 502s.
 * The action now validates cheaply, fires the event, and returns instantly;
 * the worker downscales refs and writes the new version (or a failure row
 * in the decisions ledger). Shared by the Style tab and the wizard-lite
 * create path (autoActivate).
 */
export async function requestStyleDistill(
  channelId: string,
  opts: { notes?: string; autoActivate?: boolean } = {},
): Promise<{ queued?: boolean; error?: string }> {
  const { db } = await getAppContext();
  const [ref] = await db
    .select({ id: visualStyleRefs.id })
    .from(visualStyleRefs)
    .where(and(eq(visualStyleRefs.channelId, channelId), eq(visualStyleRefs.enabled, true)))
    .limit(1);
  if (!ref) return { error: "Add at least one example image first" };
  try {
    await inngest.send({
      name: "style/distill.requested",
      data: { channelId, notes: opts.notes, autoActivate: opts.autoActivate },
    });
  } catch (err) {
    return { error: `Could not queue the distill: ${err instanceof Error ? err.message : String(err)}` };
  }
  revalidate(channelId);
  return { queued: true };
}

/** Style-tab form action wrapper over requestStyleDistill (form actions return void). */
export async function distillStyleAction(channelId: string, formData: FormData): Promise<void> {
  const res = await requestStyleDistill(channelId, {
    notes: String(formData.get("notes") ?? "").trim() || undefined,
  });
  if (res.error) console.error(`[style] distill queue failed for ${channelId}: ${res.error}`);
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

/**
 * Set (or clear) the channel's HOUSE IMAGE STYLE — the plain-language render
 * register that steers every generated image when no distilled style is active.
 * Blank clears it, and blank genuinely means NO style clause anywhere: the
 * platform never substitutes a default the operator didn't choose (2026-07-25
 * operator). The same value is settable over MCP via
 * `set_channel_config` → `dna.imageStyle`.
 */
export async function setChannelImageStyleAction(channelId: string, formData: FormData): Promise<void> {
  const { db } = await getAppContext();
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  if (!dna) return;
  const next = String(formData.get("imageStyle") ?? "").trim().slice(0, 400);
  if (next === (dna.visualStyle?.imageStyle ?? "")) return;
  await db
    .update(channelDna)
    .set({ visualStyle: { ...(dna.visualStyle ?? {}), imageStyle: next } })
    .where(eq(channelDna.channelId, channelId));
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    actor: "operator",
    summary: next ? `House image style set: ${next.slice(0, 120)}` : "House image style cleared",
    detail: { imageStyle: next },
  });
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
  const imageEngine = asCharacterEngine(String(formData.get("imageEngine") ?? ""));
  try {
    await createChannelCharacter(channelId, { name, brief, imageEngine });
  } catch (err) {
    console.error(`[style] character creation failed for ${channelId}:`, err);
  }
  revalidate(channelId);
}

export async function toggleChannelCharacterAction(channelId: string, characterId: string): Promise<void> {
  const { db } = await getAppContext();
  const [row] = await db.select().from(channelCharacters).where(eq(channelCharacters.id, characterId));
  if (!row || row.channelId !== channelId) return;
  await setChannelCharacterCast(channelId, characterId, { enabled: !row.enabled });
  revalidate(channelId);
}

/** How often to cast a character (2026-07-15 mascot channels): "auto" =
 * builder decides per scene, "always" = every generated shot, "off" = never. */
export async function setCharacterCastModeAction(
  channelId: string,
  characterId: string,
  mode: string,
): Promise<void> {
  if (!(CHARACTER_CAST_MODES as readonly string[]).includes(mode)) return;
  await setChannelCharacterCast(channelId, characterId, { castMode: mode });
  revalidate(channelId);
}

/** Target share of shots for cast_mode="smart" (2026-07-16): the character
 * lands on ~this % of shots (importance-ranked); the rest ride the cheap bulk
 * engine as establishing/diagram filler. Clamped 0–100. */
export async function setCharacterCastTargetAction(
  channelId: string,
  characterId: string,
  target: number,
): Promise<void> {
  await setChannelCharacterCast(channelId, characterId, { castTarget: target });
  revalidate(channelId);
}

export async function deleteChannelCharacterAction(channelId: string, characterId: string): Promise<void> {
  await deleteChannelCharacter(channelId, characterId);
  // reference-sheet bytes stay in the store — past productions may cite them
  revalidate(channelId);
}

// ── Style-tab iteration loop (2026-07-14 operator ask) ─────────────────────
// Refine a character image with comments (current image = edit reference),
// and test a distilled style on throwaway scenes — refine those too, then
// promote keepers into the example pool as "generated" refs.

// referenceUrlFor moved to @/lib/reference-url (2026-07-14) — the Settings
// tab's logo/banner actions need it too, and "use server" files may only
// export actions.

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
  imageEngine?: string,
): Promise<{ url: string } | { error: string }> {
  const text = comments.trim();
  if (!text) return { error: "Describe the changes you want first" };
  try {
    const { imageKey } = await refineChannelCharacter(channelId, characterId, text, {
      imageEngine: asCharacterEngine(imageEngine),
    });
    revalidate(channelId);
    return { url: `/api/media/${imageKey}` };
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
  input: { styleId?: string | null; scene: string; characterIds?: string[]; imageEngine?: string | null },
): Promise<{ url: string; note: string } | { error: string }> {
  try {
    const res = await generateStyleTestScene(channelId, {
      scene: input.scene,
      characterIds: input.characterIds ?? [],
      styleId: input.styleId ?? null,
      imageEngine: input.imageEngine ?? null,
    });
    revalidate(channelId);
    const styleNote =
      res.styleUsed.kind === "distilled"
        ? `distilled style v${res.styleUsed.version}`
        : res.styleUsed.kind === "house"
          ? "the channel house style"
          : "no style set";
    const castNote = res.charactersCast.length
      ? ` · cast ${res.charactersCast.map((c) => c.name).join(", ")}`
      : "";
    return { url: res.url, note: `Rendered on ${res.engine} with ${styleNote}${castNote}` };
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
  try {
    const res = await refineStyleTestScene(channelId, sceneId, comments);
    revalidate(channelId);
    return { url: res.url };
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
