"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { channelPlaybook, ulid } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

const SCOPES = ["hook", "pacing", "structure", "visual", "topic", "title"] as const;
type Scope = (typeof SCOPES)[number];

/** #21.5: operator-authored standing directive — adopted immediately. */
export async function addPlaybookEntryAction(formData: FormData) {
  const channelId = String(formData.get("channelId") ?? "");
  const directive = String(formData.get("directive") ?? "").trim();
  const scopeRaw = String(formData.get("scope") ?? "structure");
  const scope: Scope = (SCOPES as readonly string[]).includes(scopeRaw)
    ? (scopeRaw as Scope)
    : "structure";
  if (!channelId || !directive) return;
  const { db } = await getAppContext();
  await db.insert(channelPlaybook).values({
    id: ulid(),
    channelId,
    directive: directive.slice(0, 300),
    scope,
    origin: "operator",
    status: "adopted",
    why: "Operator directive",
    confidence: 1,
    adoptedAt: new Date(),
  });
  revalidatePath(`/channels/${channelId}`);
}

export async function adoptPlaybookEntryAction(channelId: string, entryId: string) {
  const { db } = await getAppContext();
  await db
    .update(channelPlaybook)
    .set({ status: "adopted", adoptedAt: new Date() })
    .where(and(eq(channelPlaybook.id, entryId), eq(channelPlaybook.channelId, channelId)));
  revalidatePath(`/channels/${channelId}`);
}

export async function retirePlaybookEntryAction(channelId: string, entryId: string) {
  const { db } = await getAppContext();
  await db
    .update(channelPlaybook)
    .set({ status: "retired", retiredAt: new Date() })
    .where(and(eq(channelPlaybook.id, entryId), eq(channelPlaybook.channelId, channelId)));
  revalidatePath(`/channels/${channelId}`);
}

/** Run the retro now (bypasses the maturity cadence for this channel). */
export async function runRetroNowAction(channelId: string) {
  await inngest.send({ name: "learning/retro.requested", data: { channelId } });
  revalidatePath(`/channels/${channelId}`);
}
