"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import {
  agentActions,
  channelCharacters,
  channelDecisions,
  channelDna,
  channels,
  claims,
  costRecords,
  productions,
  publications,
  secrets,
  styleTestScenes,
  visualStyles,
} from "@ytauto/db";
import {
  channelTokenName,
  deleteSecret,
  productionProfileSchema,
  styleBlockForImagePrompts,
} from "@ytauto/core";
import type { ProductionProfile } from "@ytauto/db";
import { getAppContext, invalidateProviderCache } from "@/lib/context";
import { referenceUrlFor } from "@/lib/reference-url";
import { composeBrandArtPrompt, type BrandArtSpec } from "./brand-prompts";

function str(formData: FormData, name: string, fallback = ""): string {
  return String(formData.get(name) ?? fallback).trim();
}

function list(formData: FormData, name: string): string[] {
  return str(formData, name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function createChannelAction(formData: FormData) {
  const { db } = await getAppContext();
  const channelId = ulid();
  await db.insert(channels).values({
    id: channelId,
    name: str(formData, "name") || "New channel",
    handle: str(formData, "handle") || "@new-channel",
    niche: str(formData, "niche") || "general interest shorts",
    autonomyTier: Number(str(formData, "autonomyTier", "0")),
  });
  await db.insert(channelDna).values({
    id: ulid(),
    channelId,
    tone: str(formData, "tone") || "punchy, curious, plain language",
    audiencePersona: str(formData, "audiencePersona") || "general short-form viewers",
    hookStyles: list(formData, "hookStyles"),
    forbiddenTopics: list(formData, "forbiddenTopics"),
    visualStyle: {
      primaryColor: str(formData, "primaryColor") || "#38bdf8",
      font: str(formData, "font") || "Inter",
      imageStyle: str(formData, "imageStyle") || "clean flat illustration, high contrast",
    },
    voiceId: str(formData, "voiceId") || "default",
    ctaTemplate: str(formData, "ctaTemplate") || "Follow for more.",
    targetLengthSec: Number(str(formData, "targetLengthSec", "40")),
    cadencePerWeek: Number(str(formData, "cadencePerWeek", "3")),
  });
  revalidatePath("/channels");
  redirect(`/channels/${channelId}`);
}

export async function updateChannelAction(channelId: string, formData: FormData) {
  const { db } = await getAppContext();
  await db
    .update(channels)
    .set({
      name: str(formData, "name"),
      handle: str(formData, "handle"),
      niche: str(formData, "niche"),
      autonomyTier: Number(str(formData, "autonomyTier", "0")),
    })
    .where(eq(channels.id, channelId));
  // Voice & tone fields moved to the Persona tab — the Settings form no longer
  // posts them (hideVoiceTone), so only update the ones the form submitted.
  const dnaSet: Partial<typeof channelDna.$inferInsert> = {
    forbiddenTopics: list(formData, "forbiddenTopics"),
    visualStyle: {
      primaryColor: str(formData, "primaryColor"),
      font: str(formData, "font"),
      imageStyle: str(formData, "imageStyle"),
    },
    targetLengthSec: Number(str(formData, "targetLengthSec", "40")),
    cadencePerWeek: Number(str(formData, "cadencePerWeek", "3")),
  };
  if (formData.get("tone") != null) dnaSet.tone = str(formData, "tone");
  if (formData.get("audiencePersona") != null) dnaSet.audiencePersona = str(formData, "audiencePersona");
  if (formData.get("hookStyles") != null) dnaSet.hookStyles = list(formData, "hookStyles");
  if (formData.get("voiceId") != null) dnaSet.voiceId = str(formData, "voiceId");
  if (formData.get("ctaTemplate") != null) dnaSet.ctaTemplate = str(formData, "ctaTemplate");
  await db.update(channelDna).set(dnaSet).where(eq(channelDna.channelId, channelId));
  revalidatePath(`/channels/${channelId}`);
  revalidatePath("/channels");
}

/**
 * Persona tab → Voice & tone panel: the narrator-adjacent DNA fields (voice,
 * tone, audience, hooks, CTA) now live next to the writing persona instead of
 * Settings & DNA.
 */
export async function updateVoiceToneAction(channelId: string, formData: FormData) {
  const { db } = await getAppContext();
  const voiceId = str(formData, "voiceId");
  await db
    .update(channelDna)
    .set({
      tone: str(formData, "tone"),
      audiencePersona: str(formData, "audiencePersona"),
      hookStyles: list(formData, "hookStyles"),
      ctaTemplate: str(formData, "ctaTemplate"),
      ...(voiceId ? { voiceId } : {}),
    })
    .where(eq(channelDna.channelId, channelId));
  revalidatePath(`/channels/${channelId}`);
}

/**
 * Save the per-channel Production Profile (BACKLOG #18) + the persona voice.
 * The dashboard posts the tile selections as hidden fields; we validate them
 * against the shared schema (garbage → the DB keeps its prior value, never a
 * bad enum) and store the profile on channelDna alongside the voice id.
 */
export async function updateProductionProfileAction(channelId: string, formData: FormData) {
  const { db } = await getAppContext();
  const parsed = productionProfileSchema.safeParse({
    visualMode: str(formData, "visualMode"),
    motion: str(formData, "motion"),
    rhythm: str(formData, "rhythm"),
    imageDensity: str(formData, "imageDensity") || undefined,
    visualDirector: str(formData, "visualDirector") === "on",
    captions: str(formData, "captions") === "on",
    music: str(formData, "music"),
    musicMood: str(formData, "musicMood") || undefined,
    delivery: str(formData, "delivery"),
    archivalStrength: str(formData, "archivalStrength") || undefined,
    imageEngine: str(formData, "imageEngine") || undefined,
    heroImageEngine: str(formData, "heroImageEngine") || undefined,
    characterImageEngine: str(formData, "characterImageEngine") || undefined,
    thumbnailImageEngine: str(formData, "thumbnailImageEngine") || undefined,
    videoEngine: str(formData, "videoEngine") || undefined,
    characterVideoEngine: str(formData, "characterVideoEngine") || undefined,
    heroVideoEngine: str(formData, "heroVideoEngine") || undefined,
    maxAiClips: str(formData, "maxAiClips") ? Number(str(formData, "maxAiClips")) : undefined,
    artDirection: str(formData, "artDirection") || undefined,
    notes: str(formData, "notes") || undefined,
    // BACKLOG #36 gate automation
    autoApproveVisuals: str(formData, "autoApproveVisuals") === "on",
    autoApproveFinal: str(formData, "autoApproveFinal") === "on",
  });
  if (!parsed.success) return; // invalid submission — leave the stored profile untouched
  const profile: ProductionProfile = parsed.data;
  const voiceId = str(formData, "voiceId");
  await db
    .update(channelDna)
    .set({ productionProfile: profile, ...(voiceId ? { voiceId } : {}) })
    .where(eq(channelDna.channelId, channelId));
  revalidatePath(`/channels/${channelId}`);
}

/**
 * Permanently delete a channel and everything under it. Most children cascade
 * from the channels row, but `productions.channelId` and `publications.productionId`
 * have no ON DELETE CASCADE, so those (and the plain-column audit rows in
 * agentActions/costRecords/claims) are cleared first inside a transaction.
 */
export async function deleteChannelAction(channelId: string) {
  const { db } = await getAppContext();
  await db.transaction(async (tx) => {
    const prods = await tx
      .select({ id: productions.id })
      .from(productions)
      .where(eq(productions.channelId, channelId));
    const prodIds = prods.map((p) => p.id);
    if (prodIds.length) {
      await tx.delete(publications).where(inArray(publications.productionId, prodIds));
    }
    await tx.delete(productions).where(eq(productions.channelId, channelId));
    // plain-column audit/cost rows (no FK, so no cascade) — clear the orphans
    await tx.delete(agentActions).where(eq(agentActions.channelId, channelId));
    await tx.delete(costRecords).where(eq(costRecords.channelId, channelId));
    await tx.delete(claims).where(eq(claims.channelId, channelId));
    // the rest (dna, charter, ideas→scores, sources, series, episodes, memory,
    // decisions, briefings, experiments, alerts) cascade from this delete
    await tx.delete(channels).where(eq(channels.id, channelId));
  });
  // best-effort: drop the per-channel YouTube refresh token secret
  try {
    await deleteSecret(db, channelTokenName(channelId));
  } catch {
    /* no token stored — nothing to remove */
  }
  invalidateProviderCache();
  revalidatePath("/channels");
  redirect("/channels");
}

export async function disconnectYouTubeAction(channelId: string) {
  const { db } = await getAppContext();
  await deleteSecret(db, channelTokenName(channelId));
  await db.update(channels).set({ youtubeChannelId: null, oauthTokenRef: null }).where(eq(channels.id, channelId));
  invalidateProviderCache();
  revalidatePath(`/channels/${channelId}`);
}

/** Set (or clear, with null) a channel's logo/avatar ObjectStore key. Used by
 * the upload route's companion "Remove" control on the Settings tab. */
export async function setChannelLogoAction(channelId: string, avatarKey: string | null) {
  const { db } = await getAppContext();
  await db.update(channels).set({ avatarKey }).where(eq(channels.id, channelId));
  revalidatePath(`/channels/${channelId}`);
  revalidatePath("/");
}

/** Set (or clear, with null) a channel's banner ObjectStore key (Settings tab). */
export async function setChannelBannerAction(channelId: string, bannerKey: string | null) {
  const { db } = await getAppContext();
  await db.update(channels).set({ bannerKey }).where(eq(channels.id, channelId));
  revalidatePath(`/channels/${channelId}`);
}

/** Options for the Settings-tab brand-art generators (2026-07-15 v2: the
 * operator ticks the standard choices and the prompt is COMPOSED — the old
 * free-prompt flow re-prefixed a cast character's description server-side
 * and the logo became the character). */
type BrandArtOpts = {
  /** "refine" edits the current art with small changes (2026-07-15) */
  mode?: "generate" | "refine";
  /** refine: what to change — required in refine mode */
  changes?: string;
  /** render the channel name as typography (refine: ADD it) */
  includeName?: boolean;
  /** tagline typography line — persisted on the DNA for next time */
  tagline?: string;
  /** flat solid background vs rich styled scene; "keep" = leave as-is (refine) */
  background?: "clear" | "styled" | "keep";
  /** tie the art to the active style guide (default true when one exists) */
  alignStyle?: boolean;
  /** short operator direction appended to the composed prompt */
  extra?: string;
  /** feature a channel character IN the art (one element, never the subject) */
  characterId?: string;
  /** condition on a style test scene's image (palette/mood only) */
  sceneId?: string;
  /** condition on the CURRENT logo/banner (rework, keep composition) */
  useCurrent?: boolean;
};

/** mime from a stored key's extension — channels only store the key. */
function mimeFromKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return (
    { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext] ??
    "image/png"
  );
}

/** Shared logo/banner generator: default template → operator edits →
 * optional character/scene/current-image reference → hero engine → persist
 * key + audit the exact prompt in the channel decision ledger. */
async function generateBrandArt(
  channelId: string,
  surface: "logo" | "banner",
  opts: BrandArtOpts,
): Promise<{ url: string; prompt: string } | { error: string }> {
  try {
    const { db, providers } = await getAppContext();
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
    if (!channel) return { error: "Channel not found" };
    const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
    // active style guide wins over the wizard-era imageStyle free text
    // (2026-07-15 operator ask) — same guard as the pipeline: the DNA pointer
    // only counts while that version is still the active one
    let styleBlock: string | null = null;
    if (dna?.activeStyleId) {
      const [style] = await db.select().from(visualStyles).where(eq(visualStyles.id, dna.activeStyleId));
      if (style && style.status === "active") styleBlock = styleBlockForImagePrompts(style.doc);
    }

    // Refine (2026-07-15): the CURRENT art is always the primary reference —
    // small edits on what was just generated. A character/scene then rides as
    // an EXTRA reference (gemini multi-image), so "edit my logo AND keep the
    // character on-model" works in one call.
    const refine = opts.mode === "refine";
    let currentRefUrl: string | undefined;
    if (refine) {
      if (!opts.changes?.trim()) return { error: "Describe what to change first" };
      const currentKey = surface === "logo" ? channel.avatarKey : channel.bannerKey;
      if (!currentKey) return { error: `No current ${surface} to refine — generate one first` };
      currentRefUrl = (await referenceUrlFor(providers.store, currentKey, mimeFromKey(currentKey))) ?? undefined;
    }

    // one reference slot per generation (refine adds it as an extra). The
    // reference is used IN the art — the composed prompt says HOW (character
    // = one element, scene = palette only, current = rework) and the gemini
    // adapter passes images inline, so the instruction text is the whole
    // control surface.
    let character: { name: string; description: string } | null = null;
    let referenceImageUrl: string | undefined;
    let referenceLabel: string | null = null;
    if (opts.characterId) {
      const [row] = await db
        .select()
        .from(channelCharacters)
        .where(and(eq(channelCharacters.id, opts.characterId), eq(channelCharacters.channelId, channelId)));
      if (!row) return { error: "Character not found on this channel" };
      character = { name: row.name, description: row.description };
      const ref = await referenceUrlFor(providers.store, row.imageKey, row.mimeType);
      if (ref) referenceImageUrl = ref;
      referenceLabel = `character:${row.name}`;
    } else if (opts.sceneId) {
      const [scene] = await db
        .select()
        .from(styleTestScenes)
        .where(and(eq(styleTestScenes.id, opts.sceneId), eq(styleTestScenes.channelId, channelId)));
      if (!scene) return { error: "Style scene not found on this channel" };
      const ref = await referenceUrlFor(providers.store, scene.imageKey, scene.mimeType);
      if (ref) referenceImageUrl = ref;
      referenceLabel = "scene";
    } else if (opts.useCurrent && !refine) {
      const currentKey = surface === "logo" ? channel.avatarKey : channel.bannerKey;
      if (currentKey) {
        const ref = await referenceUrlFor(providers.store, currentKey, mimeFromKey(currentKey));
        if (ref) referenceImageUrl = ref;
        referenceLabel = "current";
      }
    }

    const spec: BrandArtSpec = {
      surface,
      name: channel.name,
      niche: channel.niche,
      mode: refine ? "refine" : "generate",
      changes: opts.changes ?? null,
      includeName: opts.includeName ?? false,
      tagline: opts.tagline ?? null,
      background: opts.background ?? (refine ? "keep" : surface === "logo" ? "clear" : "styled"),
      alignStyle: opts.alignStyle ?? !refine,
      imageStyle: dna?.visualStyle?.imageStyle ?? null,
      styleBlock,
      character,
      sceneRef: referenceLabel === "scene",
      currentRef: referenceLabel === "current",
      extra: opts.extra ?? null,
    };
    const finalPrompt = composeBrandArtPrompt(spec);

    // refine: current art is the image being edited (first); a character
    // sheet / scene ref rides second — the prompt says what each one is
    const primaryRef = refine ? currentRefUrl : referenceImageUrl;
    const extraRefs = refine && referenceImageUrl ? [referenceImageUrl] : [];
    const { storageKey } = await providers.media.generateImage({
      prompt: finalPrompt,
      aspect: surface === "logo" ? "1:1" : "16:9",
      channelId,
      storageKeyBase: `channels/${channelId}/${surface === "logo" ? "avatar" : "banner"}-${ulid()}`,
      quality: "hero",
      engine: "nano-banana", // brand art is hero-tier; fal retired
      ...(primaryRef ? { referenceImageUrl: primaryRef } : {}),
      ...(extraRefs.length ? { extraReferenceImageUrls: extraRefs } : {}),
    });
    await db
      .update(channels)
      .set(surface === "logo" ? { avatarKey: storageKey } : { bannerKey: storageKey })
      .where(eq(channels.id, channelId));
    // remember the tagline for next time (visualStyle jsonb — no migration)
    const tagline = opts.tagline?.trim();
    if (dna && tagline && tagline !== dna.visualStyle?.tagline) {
      await db
        .update(channelDna)
        .set({ visualStyle: { ...dna.visualStyle, tagline } })
        .where(eq(channelDna.channelId, channelId));
    }
    // audit trail: the ledger keeps the EXACT prompt each brand image came from
    await db.insert(channelDecisions).values({
      id: ulid(),
      channelId,
      kind: "operator_steer",
      summary: `Channel ${surface} ${refine ? "refined" : "generated"}${referenceLabel ? ` (ref ${referenceLabel})` : ""}`,
      detail: { surface, mode: refine ? "refine" : "generate", prompt: finalPrompt, reference: referenceLabel, storageKey },
      actor: "operator",
    });
    revalidatePath(`/channels/${channelId}`);
    if (surface === "logo") revalidatePath("/");
    return { url: `/api/media/${storageKey}`, prompt: finalPrompt };
  } catch (e) {
    console.error(`[channel] ${surface} generation failed:`, e);
    return { error: e instanceof Error ? e.message : `${surface} generation failed` };
  }
}

/** Push the current banner art to the connected YouTube channel
 * (2026-07-15 operator ask: one click instead of download → manual upload).
 * The channel AVATAR has no public YouTube API — that one stays manual. */
export async function pushBannerToYouTubeAction(
  channelId: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    const { db, providers } = await getAppContext();
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
    if (!channel) return { error: "Channel not found" };
    if (!channel.bannerKey) return { error: "No banner to push — generate or upload one first" };
    const [token] = await db.select({ id: secrets.name }).from(secrets).where(eq(secrets.name, channelTokenName(channelId)));
    if (!token) return { error: "YouTube isn't connected — connect it above first" };
    await providers.publish.setChannelBanner({ channelId, imageStorageKey: channel.bannerKey });
    await db.insert(channelDecisions).values({
      id: ulid(),
      channelId,
      kind: "operator_steer",
      summary: "Channel banner pushed to YouTube",
      detail: { surface: "banner", mode: "push_youtube", storageKey: channel.bannerKey },
      actor: "operator",
    });
    return { ok: true };
  } catch (e) {
    console.error("[channel] banner push failed:", e);
    const msg = e instanceof Error ? e.message : "Banner push failed";
    return {
      error: /insufficient|forbidden|403/i.test(msg)
        ? `${msg} — your YouTube connection may be missing the banner permission; disconnect and reconnect YouTube, then retry`
        : msg,
    };
  }
}

/** Revert the channel logo/banner to a previous version (2026-07-15
 * operator ask: "reject a change and revert"). Every generate/refine/upload
 * writes a NEW key and old blobs are never deleted, so reverting is just
 * pointing the channel back at an older key from the decision ledger. */
export async function revertBrandArtAction(
  channelId: string,
  surface: "logo" | "banner",
  storageKey: string,
): Promise<{ url: string } | { error: string }> {
  // ledger keys are channel-scoped — never point at another channel's blob
  if (!storageKey.startsWith(`channels/${channelId}/`)) {
    return { error: "That image doesn't belong to this channel" };
  }
  const { db } = await getAppContext();
  const [channel] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId));
  if (!channel) return { error: "Channel not found" };
  await db
    .update(channels)
    .set(surface === "logo" ? { avatarKey: storageKey } : { bannerKey: storageKey })
    .where(eq(channels.id, channelId));
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    summary: `Channel ${surface} reverted to a previous version`,
    detail: { surface, mode: "revert", storageKey },
    actor: "operator",
  });
  revalidatePath(`/channels/${channelId}`);
  if (surface === "logo") revalidatePath("/");
  return { url: `/api/media/${storageKey}` };
}

/** Generate 16:9 channel banner art with the hero image model
 * (2026-07-14 operator ask: banner creation after the fact, from Settings &
 * DNA — previously only the creation wizard could generate one). YouTube's
 * API can't set banners, so the operator downloads and uploads by hand. */
export async function generateChannelBannerAssetAction(
  channelId: string,
  opts: BrandArtOpts = {},
): Promise<{ url: string; prompt: string } | { error: string }> {
  return generateBrandArt(channelId, "banner", opts);
}

/** Generate a channel logo with the hero image model (nano-banana-pro).
 * Mirrors the wizard's generator but persists onto an existing channel. */
export async function generateChannelLogoAction(
  channelId: string,
  opts: BrandArtOpts = {},
): Promise<{ url: string; prompt: string } | { error: string }> {
  return generateBrandArt(channelId, "logo", opts);
}
