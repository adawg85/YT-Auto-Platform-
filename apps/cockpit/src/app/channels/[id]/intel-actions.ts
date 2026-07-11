"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { channelCompetitors, channels, externalVideos, ideas } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

/**
 * Niche intel tab actions (BACKLOG #23.3): per-channel competitor tagging,
 * scan-cadence control, and click-to-act on scouted intel (seed an idea from a
 * rising pattern / make an idea from a trending video). Everything lands in
 * the normal idea inbox and goes through the usual scoring gates — intel
 * informs, it never bypasses review.
 */

/** Cadence control: how often the market-scan cron scouts this channel's niche. */
export async function setIntelCadenceAction(channelId: string, cadence: string) {
  if (!["daily", "weekly", "off"].includes(cadence)) return;
  const { db } = await getAppContext();
  await db.update(channels).set({ intelCadence: cadence }).where(eq(channels.id, channelId));
  revalidatePath(`/channels/${channelId}`);
}

/** Shared insert with the (channelId, name) dedupe the unique index backs. */
async function insertCompetitor(
  channelId: string,
  input: { name: string; url?: string | null; source: "operator" | "scan" },
) {
  const { db } = await getAppContext();
  const name = input.name.trim().slice(0, 120);
  if (!name) return;
  const [dupe] = await db
    .select({ id: channelCompetitors.id })
    .from(channelCompetitors)
    .where(and(eq(channelCompetitors.channelId, channelId), eq(channelCompetitors.name, name)));
  if (dupe) return;
  await db.insert(channelCompetitors).values({
    id: ulid(),
    channelId,
    name,
    url: input.url?.trim() || null,
    source: input.source,
  });
  revalidatePath(`/channels/${channelId}`);
}

/** Competitors panel add form: operator hand-tags a competitor (name + url). */
export async function addCompetitorAction(channelId: string, formData: FormData) {
  const url = String(formData.get("url") ?? "").trim();
  await insertCompetitor(channelId, {
    name: String(formData.get("name") ?? ""),
    // tolerate a bare domain — stored urls always resolve as links
    url: url ? (/^https?:\/\//.test(url) ? url : `https://${url}`) : null,
    source: "operator",
  });
}

/** "Tag" on a scouted video's channel: persist it as a competitor (source scan). */
export async function tagCompetitorAction(channelId: string, name: string) {
  await insertCompetitor(channelId, { name, source: "scan" });
}

export async function removeCompetitorAction(competitorId: string) {
  const { db } = await getAppContext();
  const [row] = await db
    .select({ channelId: channelCompetitors.channelId })
    .from(channelCompetitors)
    .where(eq(channelCompetitors.id, competitorId));
  if (!row) return;
  await db.delete(channelCompetitors).where(eq(channelCompetitors.id, competitorId));
  revalidatePath(`/channels/${row.channelId}`);
}

/**
 * "Seed idea" on a rising pattern — the channel-direct variant of the /market
 * page's seedIdeaFromPatternAction: this tab already knows WHICH channel, so
 * the idea lands on it rather than on the first channel in the niche.
 */
export async function seedIdeaFromNichePatternAction(
  channelId: string,
  input: { label: string; angle: string },
) {
  const { db } = await getAppContext();
  const [channel] = await db
    .select({ niche: channels.niche })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!channel) return;

  const title = input.label.length > 80 ? input.label.slice(0, 80) : input.label;
  // avoid obvious duplicates from repeated clicks
  const [dupe] = await db
    .select({ id: ideas.id })
    .from(ideas)
    .where(and(eq(ideas.channelId, channelId), eq(ideas.title, title)));
  if (dupe) return;

  await db.insert(ideas).values({
    id: ulid(),
    channelId,
    title,
    angle: input.angle,
    sourceType: "research",
    researchRefs: [{ marketPattern: input.label, niche: channel.niche }],
  });
  await inngest.send({ name: "ideas/autoscore.requested", data: { channelId } });
  revalidatePath(`/channels/${channelId}`);
  revalidatePath("/ideas");
}

/**
 * "Make an idea" on a trending-feed video: an inbox idea framed as our own
 * take on it, provenance-tagged with the external video id. The autoscorer
 * picks it up immediately; the variation check downstream keeps the script
 * from cloning the source.
 */
export async function makeIdeaFromVideoAction(channelId: string, externalVideoId: string) {
  const { db } = await getAppContext();
  const [video] = await db
    .select()
    .from(externalVideos)
    .where(eq(externalVideos.id, externalVideoId));
  if (!video) return;

  const title = video.title.length > 80 ? video.title.slice(0, 80) : video.title;
  const [dupe] = await db
    .select({ id: ideas.id })
    .from(ideas)
    .where(and(eq(ideas.channelId, channelId), eq(ideas.title, title)));
  if (dupe) return;

  await db.insert(ideas).values({
    id: ulid(),
    channelId,
    title,
    angle: `Our take on: ${video.title}`,
    sourceType: "research",
    researchRefs: [{ externalVideoId: video.id }],
  });
  await inngest.send({ name: "ideas/autoscore.requested", data: { channelId } });
  revalidatePath(`/channels/${channelId}`);
  revalidatePath("/ideas");
}
