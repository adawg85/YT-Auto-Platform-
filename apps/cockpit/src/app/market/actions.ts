"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { channels, ideas, ulid } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

/** Kick the meta-analysis engine outside its daily cron. */
export async function runMarketScanNowAction(niche?: string) {
  await inngest.send({ name: "market/scan.requested", data: niche ? { niche } : {} });
  revalidatePath("/market");
}

/**
 * "Borrow this pattern → seed an idea" (build #4). Turns a rising market signal
 * into an inbox idea on the first channel in that niche, tagged with the pattern
 * it came from. The scorer/scriptwriter then apply the usual gates — the
 * pattern informs the angle, it does not bypass review.
 */
export async function seedIdeaFromPatternAction(input: {
  niche: string;
  label: string;
  angle: string;
}): Promise<void> {
  const { db } = await getAppContext();
  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.niche, input.niche));
  if (!channel) return; // no channel in this niche → nothing to seed

  const title = input.label.length > 80 ? input.label.slice(0, 80) : input.label;
  // avoid obvious duplicates from repeated clicks
  const [dupe] = await db
    .select({ id: ideas.id })
    .from(ideas)
    .where(and(eq(ideas.channelId, channel.id), eq(ideas.title, title)));
  if (dupe) return;

  await db.insert(ideas).values({
    id: ulid(),
    channelId: channel.id,
    title,
    angle: input.angle,
    sourceType: "research",
    researchRefs: [{ marketPattern: input.label, niche: input.niche }],
  });
  revalidatePath("/market");
  revalidatePath("/ideas");
}
