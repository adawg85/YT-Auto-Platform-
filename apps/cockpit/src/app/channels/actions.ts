"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { channelDna, channels } from "@ytauto/db";
import { channelTokenName, deleteSecret } from "@ytauto/core";
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
  await db
    .update(channelDna)
    .set({
      tone: str(formData, "tone"),
      audiencePersona: str(formData, "audiencePersona"),
      hookStyles: list(formData, "hookStyles"),
      forbiddenTopics: list(formData, "forbiddenTopics"),
      visualStyle: {
        primaryColor: str(formData, "primaryColor"),
        font: str(formData, "font"),
        imageStyle: str(formData, "imageStyle"),
      },
      voiceId: str(formData, "voiceId"),
      ctaTemplate: str(formData, "ctaTemplate"),
      targetLengthSec: Number(str(formData, "targetLengthSec", "40")),
      cadencePerWeek: Number(str(formData, "cadencePerWeek", "3")),
    })
    .where(eq(channelDna.channelId, channelId));
  revalidatePath(`/channels/${channelId}`);
  revalidatePath("/channels");
}

export async function disconnectYouTubeAction(channelId: string) {
  const { db } = await getAppContext();
  await deleteSecret(db, channelTokenName(channelId));
  await db.update(channels).set({ youtubeChannelId: null, oauthTokenRef: null }).where(eq(channels.id, channelId));
  invalidateProviderCache();
  revalidatePath(`/channels/${channelId}`);
}
