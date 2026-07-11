"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { channels, ideas, marketOpportunities, ulid } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

/**
 * Market-opportunity lifecycle actions (BACKLOG #22). Opportunities are
 * portfolio-level intel — the actions either steer their status or convert
 * them into concrete work (a new channel via the wizard, or a seeded idea on
 * an existing channel).
 */

export async function setOpportunityStatusAction(
  id: string,
  status: "shortlisted" | "dismissed",
): Promise<void> {
  const { db } = await getAppContext();
  await db.update(marketOpportunities).set({ status }).where(eq(marketOpportunities.id, id));
  revalidatePath("/ideas");
}

/** kind=niche: mark actioned and hand off to the charter wizard, pre-filled. */
export async function startChannelFromOpportunityAction(id: string): Promise<void> {
  const { db } = await getAppContext();
  const [opp] = await db.select().from(marketOpportunities).where(eq(marketOpportunities.id, id));
  if (!opp) return;
  await db
    .update(marketOpportunities)
    .set({ status: "actioned" })
    .where(eq(marketOpportunities.id, id));
  const params = new URLSearchParams();
  params.set("niche", opp.suggestedNiche ?? opp.label);
  if (opp.suggestedIntent) params.set("intent", opp.suggestedIntent);
  redirect(`/channels/new?${params.toString()}`);
}

/** kind=topic: seed an inbox idea on a chosen existing channel. */
export async function seedOpportunityIdeaAction(id: string, formData: FormData): Promise<void> {
  const channelId = String(formData.get("channelId") ?? "");
  if (!channelId) return;
  const { db } = await getAppContext();
  const [opp] = await db.select().from(marketOpportunities).where(eq(marketOpportunities.id, id));
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!opp || !channel) return;

  const title = opp.label.length > 80 ? opp.label.slice(0, 80) : opp.label;
  const [dupe] = await db
    .select({ id: ideas.id })
    .from(ideas)
    .where(and(eq(ideas.channelId, channel.id), eq(ideas.title, title)));
  if (!dupe) {
    await db.insert(ideas).values({
      id: ulid(),
      channelId: channel.id,
      title,
      angle: opp.summary,
      sourceType: "research",
      researchRefs: [{ marketOpportunity: opp.label, kind: opp.kind }],
    });
  }
  await db
    .update(marketOpportunities)
    .set({ status: "actioned" })
    .where(eq(marketOpportunities.id, id));
  await inngest.send({ name: "ideas/autoscore.requested", data: { channelId } });
  revalidatePath("/ideas");
}
