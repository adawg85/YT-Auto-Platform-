"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
  channelBriefings,
  channelCharters,
  channelDecisions,
  channelDna,
  channelSources,
  channels,
  experiments,
  series,
  type IdentityProposal,
  type ReleasePlan,
  type SourceStrategy,
  type VerificationBar,
} from "@ytauto/db";
import {
  proposeCharter,
  proposeIdentity,
  runWizardAssistant,
  type WizardChatTurn,
  type WizardPatch,
} from "@ytauto/agents";
import { inngest, type CharterProposal, type IdentityProposals } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

/** Wizard agent calls happen before the channel exists — audit under this id. */
const ONBOARDING_CHANNEL_ID = "onboarding";

async function agentCtx() {
  const { db, providers, costSink } = await getAppContext();
  return { db, llm: providers.llm, costSink, channelId: ONBOARDING_CHANNEL_ID };
}

/**
 * Wizard agent actions return `{ error }` instead of throwing: Next.js
 * redacts thrown server-action messages in production (the browser only gets
 * a digest), so the wizard's error badge would be useless exactly when the
 * operator needs to read a provider failure.
 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Wizard step 1: niche + intent + channel defaults → AI-drafted charter + DNA. */
export async function proposeCharterWizardAction(input: {
  niche: string;
  intent: string;
  format?: string;
  researchDepth?: string;
  monetisationSafe?: boolean;
}): Promise<{ proposal: CharterProposal } | { error: string }> {
  try {
    const ctx = await agentCtx();
    return { proposal: await proposeCharter(ctx, input) };
  } catch (e) {
    console.error("[wizard] charter draft failed:", e);
    return { error: errorMessage(e) };
  }
}

/**
 * Wizard step 2: 3 AI-proposed identities (name/@handle/avatar concept).
 * `instructions`/`avoid` power the "Generate 3 more" re-roll — pass the names
 * already shown so the new options are genuinely different.
 */
export async function proposeIdentityWizardAction(input: {
  niche: string;
  mission: string;
  instructions?: string;
  avoid?: string[];
}): Promise<{ proposals: IdentityProposals } | { error: string }> {
  try {
    const ctx = await agentCtx();
    return { proposals: await proposeIdentity(ctx, input) };
  } catch (e) {
    console.error("[wizard] identity proposal failed:", e);
    return { error: errorMessage(e) };
  }
}

/**
 * Persistent wizard co-pilot: conversational replies plus optional field edits
 * (`patch`) the wizard merges into its draft. Returns `{ error }` on failure so
 * the dock can surface provider issues (see errorMessage note above).
 */
export async function wizardAssistantAction(input: {
  step: string;
  fields: WizardPatch;
  history: WizardChatTurn[];
  message: string;
}): Promise<{ reply: string; patch: WizardPatch } | { error: string }> {
  try {
    const ctx = await agentCtx();
    const res = await runWizardAssistant(ctx, input);
    return { reply: res.reply, patch: res.patch };
  } catch (e) {
    console.error("[wizard] assistant failed:", e);
    return { error: errorMessage(e) };
  }
}

/**
 * Wizard: generate a 1:1 channel avatar from the picked identity + DNA image
 * style. Stored under an onboarding-scoped key and returned as a cockpit media
 * URL the operator downloads and uploads to YouTube by hand. Works in mock
 * mode (SVG placeholder) and live (fal.ai).
 */
export async function generateChannelAvatarAction(input: {
  prompt: string;
}): Promise<{ url: string } | { error: string }> {
  try {
    const { providers } = await getAppContext();
    const { storageKey } = await providers.media.generateImage({
      prompt: input.prompt,
      aspect: "1:1",
      channelId: ONBOARDING_CHANNEL_ID,
      storageKeyBase: `avatars/onboarding-${ulid()}`,
    });
    return { url: `/api/media/${storageKey}` };
  } catch (e) {
    console.error("[wizard] avatar generation failed:", e);
    return { error: errorMessage(e) };
  }
}

export type CreateChannelWithCharterInput = {
  name: string;
  handle: string;
  niche: string;
  /** "short" | "long" | "both" */
  contentFormat: string;
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
    releasePlan?: ReleasePlan | null;
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
    contentFormat: input.contentFormat || "short",
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
    releasePlan: input.dna.releasePlan ?? null,
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

/** Edit the charter's objectives/targets (BACKLOG #17) — one per line. */
export async function updateCharterObjectivesAction(channelId: string, formData: FormData) {
  const { db } = await getAppContext();
  const objectives = String(formData.get("objectives") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
  await db
    .update(channelCharters)
    .set({ objectives })
    .where(eq(channelCharters.channelId, channelId));
  revalidatePath(`/channels/${channelId}`);
}

/** Briefings tab: compose a check-in right now (skips the cadence window). */
export async function runBriefingNowAction(channelId: string) {
  await inngest.send({
    name: "editorial/briefing.requested",
    data: { channelId, force: true },
  });
  revalidatePath(`/channels/${channelId}`);
}

/**
 * Briefings tab (build #5.2): the operator's answer to "do you agree?".
 * The response becomes a briefing_response decision row (so it feeds straight
 * into planner/writer prompts via channelStateSummary), and an agreed
 * experiment suggestion activates its proposed experiments row.
 */
export async function respondBriefingAction(briefingId: string, formData: FormData) {
  const { db } = await getAppContext();
  const [briefing] = await db
    .select()
    .from(channelBriefings)
    .where(eq(channelBriefings.id, briefingId));
  if (!briefing || briefing.status !== "open") return;

  const note = String(formData.get("note") ?? "").trim();
  const responses: Record<string, "agree" | "disagree"> = {};
  for (const s of briefing.suggestions) {
    const v = formData.get(`sugg-${s.id}`);
    if (v === "agree" || v === "disagree") responses[s.id] = v;
  }

  await db
    .update(channelBriefings)
    .set({
      status: "acknowledged",
      responses,
      operatorNote: note || null,
      respondedAt: new Date(),
    })
    .where(eq(channelBriefings.id, briefingId));

  const agreed = briefing.suggestions.filter((s) => responses[s.id] === "agree");
  const disagreed = briefing.suggestions.filter((s) => responses[s.id] === "disagree");
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId: briefing.channelId,
    kind: "briefing_response",
    summary:
      `Briefing answered: agreed [${agreed.map((s) => s.label).join("; ") || "none"}], ` +
      `disagreed [${disagreed.map((s) => s.label).join("; ") || "none"}]` +
      (note ? ` — steer: ${note.slice(0, 200)}` : ""),
    detail: { briefingId, responses, note },
    actor: "operator",
  });

  // experiment suggestions: agree → activate the proposed row (one active per
  // channel — the partial unique index is the backstop); disagree → abandon
  for (const s of briefing.suggestions) {
    if (s.kind !== "experiment" || !s.experimentId || !responses[s.id]) continue;
    const [exp] = await db.select().from(experiments).where(eq(experiments.id, s.experimentId));
    if (!exp || exp.status !== "proposed") continue;
    if (responses[s.id] === "disagree") {
      await db
        .update(experiments)
        .set({ status: "abandoned" })
        .where(eq(experiments.id, exp.id));
      continue;
    }
    const [active] = await db
      .select({ id: experiments.id })
      .from(experiments)
      .where(and(eq(experiments.channelId, briefing.channelId), eq(experiments.status, "active")));
    if (active) continue; // one variable at a time — leave it proposed
    await db
      .update(experiments)
      .set({ status: "active", startedAt: new Date() })
      .where(eq(experiments.id, exp.id));
    await db.insert(channelDecisions).values({
      id: ulid(),
      channelId: briefing.channelId,
      kind: "experiment_started",
      summary: `Experiment approved by operator: ${exp.variable} → ${exp.variant}`,
      detail: { experimentId: exp.id, hypothesis: exp.hypothesis },
      actor: "operator",
    });
  }

  revalidatePath(`/channels/${briefing.channelId}`);
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
