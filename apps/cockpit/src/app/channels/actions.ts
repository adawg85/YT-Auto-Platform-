"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import {
  agentActions,
  channelDna,
  channels,
  claims,
  costRecords,
  productions,
  publications,
} from "@ytauto/db";
import { channelTokenName, deleteSecret, productionProfileSchema } from "@ytauto/core";
import type { ProductionProfile } from "@ytauto/db";
import { getAppContext, invalidateProviderCache } from "@/lib/context";

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
    captions: str(formData, "captions") === "on",
    music: str(formData, "music"),
    delivery: str(formData, "delivery"),
    archivalStrength: str(formData, "archivalStrength") || undefined,
    artDirection: str(formData, "artDirection") || undefined,
    notes: str(formData, "notes") || undefined,
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

/** Generate 16:9 channel banner art with the hero image model from the
 * channel's name/niche/DNA image style, store it, and set it as the banner
 * (2026-07-14 operator ask: banner creation after the fact, from Settings &
 * DNA — previously only the creation wizard could generate one). YouTube's
 * API can't set banners, so the operator downloads and uploads by hand. */
export async function generateChannelBannerAssetAction(
  channelId: string,
): Promise<{ url: string } | { error: string }> {
  try {
    const { db, providers } = await getAppContext();
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
    if (!channel) return { error: "Channel not found" };
    const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
    const imageStyle = dna?.visualStyle?.imageStyle || "clean flat vector, bold, high contrast";
    const prompt =
      `Wide channel banner art for a YouTube channel named "${channel.name}" about ${channel.niche}. ` +
      `${imageStyle}. Cinematic 16:9 composition with the key subject centered in the middle third ` +
      `(YouTube crops the edges on TV/desktop), rich atmospheric background, room for the channel ` +
      `name to sit over it later, no text.`;
    const { storageKey } = await providers.media.generateImage({
      prompt,
      aspect: "16:9",
      channelId,
      storageKeyBase: `channels/${channelId}/banner-${ulid()}`,
      quality: "hero",
    });
    await db.update(channels).set({ bannerKey: storageKey }).where(eq(channels.id, channelId));
    revalidatePath(`/channels/${channelId}`);
    return { url: `/api/media/${storageKey}` };
  } catch (e) {
    console.error("[channel] banner generation failed:", e);
    return { error: e instanceof Error ? e.message : "Banner generation failed" };
  }
}

/** Generate a channel logo with the hero image model (nano-banana-pro) from the
 * channel's name/niche/DNA image style, store it, and set it as the avatar.
 * Mirrors the wizard's generator but persists onto an existing channel. */
export async function generateChannelLogoAction(
  channelId: string,
): Promise<{ url: string } | { error: string }> {
  try {
    const { db, providers } = await getAppContext();
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
    if (!channel) return { error: "Channel not found" };
    const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
    const imageStyle = dna?.visualStyle?.imageStyle || "clean flat vector, bold, high contrast";
    const prompt =
      `Channel avatar / logo for a YouTube channel named "${channel.name}" about ${channel.niche}. ` +
      `${imageStyle}. A single bold centered emblem or icon — simple, memorable mark with strong ` +
      `figure-ground contrast, legible at small size, flat background, no text.`;
    const { storageKey } = await providers.media.generateImage({
      prompt,
      aspect: "1:1",
      channelId,
      storageKeyBase: `channels/${channelId}/avatar-${ulid()}`,
      quality: "hero",
    });
    await db.update(channels).set({ avatarKey: storageKey }).where(eq(channels.id, channelId));
    revalidatePath(`/channels/${channelId}`);
    revalidatePath("/");
    return { url: `/api/media/${storageKey}` };
  } catch (e) {
    console.error("[channel] logo generation failed:", e);
    return { error: e instanceof Error ? e.message : "Logo generation failed" };
  }
}
