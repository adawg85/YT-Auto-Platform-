"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
  channelCharters,
  channelDecisions,
  channelDna,
  channelSources,
  channels,
  series,
  type IdentityProposal,
  type SourceStrategy,
  type VerificationBar,
} from "@ytauto/db";
import { proposeCharter, proposeIdentity } from "@ytauto/agents";
import { inngest, type CharterProposal, type IdentityProposals } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

/** Wizard agent calls happen before the channel exists — audit under this id. */
const ONBOARDING_CHANNEL_ID = "onboarding";

async function agentCtx() {
  const { db, providers, costSink } = await getAppContext();
  return { db, llm: providers.llm, costSink, channelId: ONBOARDING_CHANNEL_ID };
}

/** Wizard step 1: niche + operator intent → AI-drafted charter + DNA defaults. */
export async function proposeCharterWizardAction(input: {
  niche: string;
  intent: string;
}): Promise<CharterProposal> {
  const ctx = await agentCtx();
  return proposeCharter(ctx, input);
}

/** Wizard step 2: 3 AI-proposed identities (name/@handle/avatar concept). */
export async function proposeIdentityWizardAction(input: {
  niche: string;
  mission: string;
}): Promise<IdentityProposals> {
  const ctx = await agentCtx();
  return proposeIdentity(ctx, input);
}

export type CreateChannelWithCharterInput = {
  name: string;
  handle: string;
  niche: string;
  autonomyTier: number;
  charter: {
    mission: string;
    objectives: string[];
    archetype: "evergreen_series" | "monitor_digest" | "reactive";
    sourceStrategy: SourceStrategy;
    verificationBar: VerificationBar;
    checkinCadence: string;
  };
  dna: {
    tone: string;
    audiencePersona: string;
    hookStyles: string[];
    forbiddenTopics: string[];
    imageStyle: string;
    primaryColor: string;
    font: string;
    voiceId: string;
    ctaTemplate: string;
    targetLengthSec: number;
    cadencePerWeek: number;
  };
  identityProposals: { options: IdentityProposal[]; pickedIndex: number | null };
};

/** Wizard step 4: create channel + DNA + charter + standing sources + decision row. */
export async function createChannelWithCharterAction(
  input: CreateChannelWithCharterInput,
): Promise<{ channelId: string }> {
  const { db } = await getAppContext();
  const channelId = ulid();

  await db.insert(channels).values({
    id: channelId,
    name: input.name || "New channel",
    handle: input.handle || "@new-channel",
    niche: input.niche,
    autonomyTier: input.autonomyTier,
  });
  await db.insert(channelDna).values({
    id: ulid(),
    channelId,
    tone: input.dna.tone,
    audiencePersona: input.dna.audiencePersona,
    hookStyles: input.dna.hookStyles,
    forbiddenTopics: input.dna.forbiddenTopics,
    visualStyle: {
      primaryColor: input.dna.primaryColor || "#38bdf8",
      font: input.dna.font || "Inter",
      imageStyle: input.dna.imageStyle,
    },
    voiceId: input.dna.voiceId || "default",
    ctaTemplate: input.dna.ctaTemplate || "Follow for the next episode.",
    targetLengthSec: input.dna.targetLengthSec || 40,
    cadencePerWeek: input.dna.cadencePerWeek || 3,
  });
  await db.insert(channelCharters).values({
    id: ulid(),
    channelId,
    mission: input.charter.mission,
    objectives: input.charter.objectives,
    archetype: input.charter.archetype,
    sourceStrategy: input.charter.sourceStrategy,
    verificationBar: input.charter.verificationBar,
    identityProposals: input.identityProposals,
    checkinCadence: input.charter.checkinCadence || "weekly",
  });

  // standing truth sources: one web source per authoritative domain + a
  // niche-wide youtube query; episode research adds topic-specific ones
  const sourceRows = [
    ...input.charter.sourceStrategy.authoritativeDomains.map((domain) => ({
      id: ulid(),
      channelId,
      kind: "web" as const,
      name: domain,
      config: { url: `https://${domain}` },
      proposedBy: "agent" as const,
    })),
    {
      id: ulid(),
      channelId,
      kind: "youtube" as const,
      name: `youtube: ${input.niche}`,
      config: { query: input.niche },
      proposedBy: "agent" as const,
    },
  ];
  if (sourceRows.length) await db.insert(channelSources).values(sourceRows);

  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "charter_created",
    summary: `Charter created via setup wizard: ${input.charter.mission.slice(0, 140)}`,
    detail: { charter: input.charter, identityProposals: input.identityProposals },
    actor: "operator",
  });

  revalidatePath("/channels");
  return { channelId };
}

/** Plan tab: kick the editorial planner (plans series + fans out episode research). */
export async function runEditorialPlanAction(channelId: string) {
  await inngest.send({ name: "editorial/plan.requested", data: { channelId } });
  revalidatePath(`/channels/${channelId}`);
}

/** Plan tab: approve or reject a `proposed` series arc. */
export async function decideSeriesAction(seriesId: string, decision: "approve" | "reject") {
  const { db } = await getAppContext();
  const [row] = await db.select().from(series).where(eq(series.id, seriesId));
  if (!row || row.status !== "proposed") return;
  await db
    .update(series)
    .set({ status: decision === "approve" ? "active" : "archived" })
    .where(eq(series.id, seriesId));
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId: row.channelId,
    kind: "operator_steer",
    summary: `Series "${row.title}" ${decision === "approve" ? "approved" : "rejected"} by operator`,
    detail: { seriesId },
    actor: "operator",
  });
  if (decision === "approve") {
    // newly-active arc: let the planner fan out research immediately
    await inngest.send({ name: "editorial/plan.requested", data: { channelId: row.channelId } });
  }
  revalidatePath(`/channels/${row.channelId}`);
}
