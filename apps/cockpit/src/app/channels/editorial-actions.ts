"use server";

import { revalidatePath } from "next/cache";
import { and, asc, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import {
  channelBriefings,
  channelCharters,
  channelDecisions,
  channelDna,
  channelSources,
  channels,
  citations,
  claims,
  episodes,
  experiments,
  personas,
  productions,
  publications,
  series,
  type IdentityProposal,
  type ReleasePlan,
  type SourceStrategy,
  type VerificationBar,
} from "@ytauto/db";
import {
  generatePersona,
  proposeCharter,
  proposeIdentity,
  runWizardAssistant,
  scoutAuthoritativeDomains,
  type WizardChatTurn,
  type WizardPatch,
} from "@ytauto/agents";
import {
  channelWarmupState,
  defaultPersonaDoc,
  defaultProductionProfile,
  inngest,
  projectTentativeSlots,
  resolveFactualityMode,
  PERSONA_ARCHETYPES,
  PERSONA_ARCHETYPE_LIBRARY,
  type CharterProposal,
  type IdentityProposals,
  type PersonaArchetype,
} from "@ytauto/core";
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

/**
 * Wizard: generate a 16:9 channel banner (same flow as the avatar). YouTube's
 * banner canvas is 2560×1440 with a 1546×423 safe area — the operator crops on
 * upload; we generate wide art with the key subject centered.
 */
export async function generateChannelBannerAction(input: {
  prompt: string;
}): Promise<{ url: string } | { error: string }> {
  try {
    const { providers } = await getAppContext();
    const { storageKey } = await providers.media.generateImage({
      prompt: input.prompt,
      aspect: "16:9",
      channelId: ONBOARDING_CHANNEL_ID,
      storageKeyBase: `banners/onboarding-${ulid()}`,
    });
    return { url: `/api/media/${storageKey}` };
  } catch (e) {
    console.error("[wizard] banner generation failed:", e);
    return { error: errorMessage(e) };
  }
}

/**
 * Wizard sources helper: probe each authoritative domain over https —
 * HEAD first (cheap), GET as the fallback (some hosts 405 HEAD), 6s timeout.
 */
export async function validateDomainsAction(
  domains: string[],
): Promise<{ domain: string; ok: boolean }[]> {
  const probe = async (domain: string): Promise<boolean> => {
    const host = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!host) return false;
    const attempt = async (method: "HEAD" | "GET") => {
      const res = await fetch(`https://${host}`, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(6000),
      });
      return res.ok;
    };
    try {
      if (await attempt("HEAD")) return true;
    } catch {
      /* fall through to GET */
    }
    try {
      return await attempt("GET");
    } catch {
      return false;
    }
  };
  return Promise.all(
    domains.slice(0, 20).map(async (domain) => ({ domain, ok: await probe(domain) })),
  );
}

/** Wizard sources helper: AI-scouted authoritative domains for the niche. */
export async function scoutDomainsAction(input: {
  niche: string;
  existing: string[];
}): Promise<{ domains: { domain: string; why: string }[] } | { error: string }> {
  try {
    const ctx = await agentCtx();
    const res = await scoutAuthoritativeDomains(ctx, input);
    return { domains: res.domains };
  } catch (e) {
    console.error("[wizard] domain scout failed:", e);
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
  /** BACKLOG #6/#17: this Shorts channel is derived from that long-form channel */
  derivedFromChannelId?: string | null;
  charter: {
    mission: string;
    objectives: string[];
    archetype: "evergreen_series" | "monitor_digest" | "reactive";
    sourceStrategy: SourceStrategy;
    verificationBar: VerificationBar;
    checkinCadence: string;
    /** BACKLOG #21.1/#21.4: the writing-persona archetype picked in the wizard */
    personaArchetype?: string;
    personaRationale?: string | null;
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
    derivedFromChannelId: input.derivedFromChannelId ?? null,
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
    // BACKLOG #18: seed a format-aware default Production Profile so a new
    // channel starts with sensible tool choices (editable on its Profile tab).
    productionProfile: defaultProductionProfile(input.contentFormat),
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

  // BACKLOG #21.1: create + activate the channel's writing persona v1. A live
  // LLM specialises the archetype to the niche; any failure falls back to the
  // deterministic archetype seed so creation never blocks on a provider.
  const archetype = (
    PERSONA_ARCHETYPES as readonly string[]
  ).includes(input.charter.personaArchetype ?? "")
    ? (input.charter.personaArchetype as PersonaArchetype)
    : "documentary_narrator";
  const factualityMode = resolveFactualityMode(input.charter.verificationBar);
  let personaName = PERSONA_ARCHETYPE_LIBRARY[archetype].label;
  let personaDoc = defaultPersonaDoc(archetype, input.niche);
  try {
    const { providers, costSink } = await getAppContext();
    const proposal = await generatePersona(
      { db, llm: providers.llm, costSink, channelId },
      {
        archetype,
        niche: input.niche,
        tone: input.dna.tone,
        audiencePersona: input.dna.audiencePersona,
        factualityMode,
      },
    );
    personaName = proposal.name;
    personaDoc = proposal.doc;
  } catch (e) {
    console.error("[wizard] persona generation failed — using archetype seed:", e);
  }
  const personaId = ulid();
  await db.insert(personas).values({
    id: personaId,
    channelId,
    name: personaName,
    archetype,
    version: 1,
    status: "active",
    createdBy: "operator",
    doc: personaDoc,
    rationale: input.charter.personaRationale ?? null,
  });
  await db
    .update(channelDna)
    .set({ activePersonaId: personaId })
    .where(eq(channelDna.channelId, channelId));

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

export type EpisodeBrief = {
  summary?: string;
  hookAngle?: string;
  outline?: { point: string; claimId?: string }[];
};
export type EpisodeFact = {
  id: string;
  text: string;
  tier: string;
  status: string;
  citations: { domain: string; title: string; url: string }[];
};
export type EpisodeFacts = {
  episode: { title: string; angle: string; status: string; coverageSummary: string | null; brief: EpisodeBrief | null };
  facts: EpisodeFact[];
};

/**
 * Plan tab episode popup: load one episode's brief + the actual facts that were
 * checked (verified/attributed/cut) with their citations. Read-only, fetched on
 * demand when the operator clicks an episode — keeps per-claim data out of the
 * initial Plan-tab payload. Makes "what is being validated" concrete.
 */
export async function loadEpisodeFactsAction(episodeId: string): Promise<EpisodeFacts | null> {
  const { db } = await getAppContext();
  const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
  if (!episode) return null;

  const claimRows = await db.select().from(claims).where(eq(claims.episodeId, episodeId));
  const claimIds = claimRows.map((c) => c.id);
  const citationRows = claimIds.length
    ? await db.select().from(citations).where(inArray(citations.claimId, claimIds))
    : [];
  const citesByClaim = new Map<string, { domain: string; title: string; url: string }[]>();
  for (const c of citationRows) {
    const list = citesByClaim.get(c.claimId) ?? [];
    list.push({ domain: c.domain, title: c.title, url: c.url });
    citesByClaim.set(c.claimId, list);
  }

  // verified → attributed → cut → unverified, so the popup reads best-first
  const order: Record<string, number> = { verified: 0, attributed: 1, cut: 2, unverified: 3 };
  const facts: EpisodeFact[] = claimRows
    .map((c) => ({
      id: c.id,
      text: c.text,
      tier: c.tier,
      status: c.status,
      citations: citesByClaim.get(c.id) ?? [],
    }))
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  return {
    episode: {
      title: episode.title,
      angle: episode.angle,
      status: episode.status,
      coverageSummary: episode.coverageSummary ?? null,
      brief: (episode.brief as EpisodeBrief | null) ?? null,
    },
    facts,
  };
}

/** Plan tab: kick the editorial planner (plans series + fans out episode research). */
export async function runEditorialPlanAction(channelId: string) {
  await inngest.send({ name: "editorial/plan.requested", data: { channelId } });
  revalidatePath(`/channels/${channelId}`);
}

/**
 * Plan tab: "Stop research" — kill every in-flight operation for this channel.
 * Fires the halt event (Inngest cancels the running planner + episode-research
 * runs via cancelOn) and resets any episode left mid-research back to `planned`
 * so it isn't stranded in "researching" and can be resumed cleanly by Restart.
 */
export async function stopResearchAction(channelId: string) {
  const { db } = await getAppContext();
  await inngest.send({ name: "editorial/research.halt", data: { channelId } });
  const reset = await db
    .update(episodes)
    .set({ status: "planned" })
    .where(
      and(
        eq(episodes.channelId, channelId),
        inArray(episodes.status, ["researching", "verifying"]),
      ),
    )
    .returning({ id: episodes.id });
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    summary: `Research halted by operator (${reset.length} episode${reset.length === 1 ? "" : "s"} returned to planned)`,
    detail: { resetEpisodeIds: reset.map((r) => r.id) },
    actor: "operator",
  });
  revalidatePath(`/channels/${channelId}`);
}

/**
 * Plan tab: "Restart research" — resume after a stop. Clears any lingering
 * mid-research status back to planned, then re-fires the planner, which fans
 * out the next batch (capped at 3 concurrent per channel by episode-research).
 */
export async function restartResearchAction(channelId: string) {
  const { db } = await getAppContext();
  await db
    .update(episodes)
    .set({ status: "planned" })
    .where(
      and(
        eq(episodes.channelId, channelId),
        inArray(episodes.status, ["researching", "verifying"]),
      ),
    );
  await inngest.send({ name: "editorial/plan.requested", data: { channelId } });
  revalidatePath(`/channels/${channelId}`);
}

/** Edit the charter's mission, corroboration bar, and check-in cadence in
 * Settings & DNA (BACKLOG #17) — the things set at creation stay editable. */
export async function updateCharterSettingsAction(channelId: string, formData: FormData) {
  const { db } = await getAppContext();
  const [charter] = await db.select().from(channelCharters).where(eq(channelCharters.channelId, channelId));
  if (!charter) return;
  const mission = String(formData.get("mission") ?? "").trim() || charter.mission;
  const minSources = Math.max(
    1,
    Math.min(5, Number(formData.get("establishedMinSources")) || charter.verificationBar.establishedMinSources),
  );
  const presentDebateMode = formData.get("presentDebateMode") === "on";
  const minFactsToScript = Math.max(
    1,
    Math.min(20, Number(formData.get("minFactsToScript")) || charter.verificationBar.minFactsToScript || 3),
  );
  const checkinCadence = String(formData.get("checkinCadence") ?? charter.checkinCadence) || charter.checkinCadence;
  const rawMode = String(formData.get("factualityMode") ?? "");
  const factualityMode =
    rawMode === "strict" || rawMode === "balanced" || rawMode === "entertainment"
      ? rawMode
      : charter.verificationBar.factualityMode;
  await db
    .update(channelCharters)
    .set({
      mission,
      verificationBar: {
        establishedMinSources: minSources,
        presentDebateMode,
        minFactsToScript,
        ...(factualityMode ? { factualityMode } : {}),
      },
      checkinCadence,
    })
    .where(eq(channelCharters.channelId, channelId));

  // Dual-drive (#20): an operator edit is a steer, not just a save — record
  // what changed so channelStateSummary feeds it into the planner/writer
  // prompts and the next plan works around it instead of overwriting it.
  const changes: string[] = [];
  if (mission !== charter.mission) changes.push("rewrote the mission");
  if (minSources !== charter.verificationBar.establishedMinSources)
    changes.push(`corroboration bar ${charter.verificationBar.establishedMinSources} → ${minSources}`);
  if (presentDebateMode !== charter.verificationBar.presentDebateMode)
    changes.push(`present-the-debate ${presentDebateMode ? "on" : "off"}`);
  if (minFactsToScript !== (charter.verificationBar.minFactsToScript ?? 3))
    changes.push(`facts-before-scripting ${charter.verificationBar.minFactsToScript ?? 3} → ${minFactsToScript}`);
  if (checkinCadence !== charter.checkinCadence)
    changes.push(`check-in cadence → ${checkinCadence}`);
  if (changes.length) {
    await db.insert(channelDecisions).values({
      id: ulid(),
      channelId,
      kind: "operator_steer",
      actor: "operator",
      summary: `Operator adjusted the charter: ${changes.join("; ")}`,
      detail: { changes },
    });
  }
  revalidatePath(`/channels/${channelId}`);
}

/** Edit the charter's objectives/targets (BACKLOG #17) — one per line. */
export async function updateCharterObjectivesAction(channelId: string, formData: FormData) {
  const { db } = await getAppContext();
  const [charter] = await db
    .select()
    .from(channelCharters)
    .where(eq(channelCharters.channelId, channelId));
  const objectives = String(formData.get("objectives") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
  await db
    .update(channelCharters)
    .set({ objectives })
    .where(eq(channelCharters.channelId, channelId));
  // Dual-drive (#20): target edits are steers the planner must respect.
  if (charter && JSON.stringify(charter.objectives ?? []) !== JSON.stringify(objectives)) {
    await db.insert(channelDecisions).values({
      id: ulid(),
      channelId,
      kind: "operator_steer",
      actor: "operator",
      summary: `Operator set the channel targets: ${objectives.join("; ").slice(0, 300)}`,
      detail: { objectives },
    });
  }
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
    // #23.1: instantly project TENTATIVE publish slots for the whole approved
    // arc by rolling the channel's release cadence forward (warm-up ramp caps
    // respected while still ramping). Tentative slots show on the calendars
    // and become the locked schedule when each video reaches the publish step
    // — they never touch YouTube while tentative.
    const [channel] = await db.select().from(channels).where(eq(channels.id, row.channelId));
    const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, row.channelId));
    const format = channel?.contentFormat === "long" ? ("long" as const) : ("shorts" as const);
    const now = new Date();
    const state = await channelWarmupState(db, row.channelId, now, format);
    const eps = await db
      .select({ id: episodes.id, status: episodes.status, ideaId: episodes.ideaId })
      .from(episodes)
      .where(eq(episodes.seriesId, seriesId))
      .orderBy(asc(episodes.position));
    // 2026-07-11 incident: an episode whose production already holds a REAL
    // publication (scheduled or published) must not consume a tentative slot —
    // the backfill gave slot #1 to an already-scheduled episode and shifted
    // every later episode one slot down the calendar.
    const ideaIds = eps.map((e) => e.ideaId).filter((x): x is string => !!x);
    const lockedRows = ideaIds.length
      ? await db
          .select({ ideaId: productions.ideaId })
          .from(publications)
          .innerJoin(productions, eq(publications.productionId, productions.id))
          .where(inArray(productions.ideaId, ideaIds))
      : [];
    const locked = new Set(lockedRows.map((r) => r.ideaId));
    const target = eps.filter(
      (e) => !["cut", "published"].includes(e.status) && !(e.ideaId && locked.has(e.ideaId)),
    );
    const slots = projectTentativeSlots({
      format,
      launchedAt: state?.launchedAt ?? channel?.createdAt ?? now,
      now,
      count: target.length,
      releasedThisWeek: state?.releasedThisWeek ?? 0,
      cadencePerWeek: dna?.cadencePerWeek,
      // the channel's own release plan drives the ramp (its absence falls back
      // to the built-in conservative ramp — the ~1/wk incident, fixed in core)
      releasePlan: dna?.releasePlan ?? null,
    });
    for (let i = 0; i < target.length; i++) {
      await db
        .update(episodes)
        .set({ tentativeFor: slots[i] ?? null })
        .where(eq(episodes.id, target[i]!.id));
    }
    // newly-active arc: let the planner fan out research immediately
    await inngest.send({ name: "editorial/plan.requested", data: { channelId: row.channelId } });
  }
  revalidatePath(`/channels/${row.channelId}`);
}

/**
 * Plan tab steer box (BACKLOG #23.2): free-text operator direction ("lean into
 * engine failures", "more human stories") recorded as an operator_steer
 * decision row. channelStateSummary folds recent steers into the "state of the
 * world" block that grounds BOTH the series planner and the scriptwriter, so
 * the next plan/scripts work around it — the same dual-drive pattern as
 * charter edits (#20).
 */
export async function savePlanSteerAction(channelId: string, formData: FormData) {
  const steer = String(formData.get("steer") ?? "").trim();
  if (!steer) return;
  const { db } = await getAppContext();
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    summary: `Plan steer: ${steer.slice(0, 140)}`,
    detail: { steer },
    actor: "operator",
  });
  revalidatePath(`/channels/${channelId}`);
}

// ── Writing personas (BACKLOG #21.1) ──────────────────────────────────────

/**
 * Activate a persona version: flip the DNA pointer, retire the previous
 * active version. Editing never mutates — activation is the only state flip
 * an operator does in place.
 */
export async function activatePersonaAction(channelId: string, personaId: string) {
  const { db } = await getAppContext();
  const [row] = await db.select().from(personas).where(eq(personas.id, personaId));
  if (!row || row.channelId !== channelId) return;
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  if (dna?.activePersonaId && dna.activePersonaId !== personaId) {
    await db
      .update(personas)
      .set({ status: "retired" })
      .where(eq(personas.id, dna.activePersonaId));
  }
  await db.update(personas).set({ status: "active" }).where(eq(personas.id, personaId));
  await db
    .update(channelDna)
    .set({ activePersonaId: personaId })
    .where(eq(channelDna.channelId, channelId));
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    summary: `Persona "${row.name}" v${row.version} activated`,
    detail: { personaId, version: row.version },
    actor: "operator",
  });
  revalidatePath(`/channels/${channelId}`);
}

/**
 * Persona narration pace (BACKLOG #26): a small delivery-level dial on the
 * ACTIVE persona doc (doc.pace → TTS speed multiplier in the pipeline). Kept
 * as an in-place doc update rather than a new version — pace is a delivery
 * setting like voice/tone, not a change to WHO is speaking.
 */
export async function updatePersonaPaceAction(channelId: string, pace: string) {
  if (!["slow", "natural", "brisk"].includes(pace)) return;
  const { db } = await getAppContext();
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  if (!dna?.activePersonaId) return;
  const [active] = await db.select().from(personas).where(eq(personas.id, dna.activePersonaId));
  if (!active || active.channelId !== channelId) return;
  await db
    .update(personas)
    .set({ doc: { ...active.doc, pace: pace as "slow" | "natural" | "brisk" } })
    .where(eq(personas.id, active.id));
  revalidatePath(`/channels/${channelId}`);
}

/**
 * Operator-initiated new persona version: regenerate from the current active
 * doc with optional tweak notes. Lands as a DRAFT — the operator reviews and
 * activates it explicitly (same no-silent-drift rule agents follow).
 */
export async function regeneratePersonaAction(
  channelId: string,
  input: { tweakNotes?: string },
): Promise<{ personaId: string } | { error: string }> {
  try {
    const { db, providers, costSink } = await getAppContext();
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
    const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
    const [charter] = await db
      .select()
      .from(channelCharters)
      .where(eq(channelCharters.channelId, channelId));
    if (!channel) return { error: "Channel not found" };
    const [active] = dna?.activePersonaId
      ? await db.select().from(personas).where(eq(personas.id, dna.activePersonaId))
      : [];
    const archetype = (
      PERSONA_ARCHETYPES as readonly string[]
    ).includes(active?.archetype ?? "")
      ? (active!.archetype as PersonaArchetype)
      : "documentary_narrator";
    const proposal = await generatePersona(
      { db, llm: providers.llm, costSink, channelId },
      {
        archetype,
        niche: channel.niche,
        tone: dna?.tone,
        audiencePersona: dna?.audiencePersona,
        factualityMode: resolveFactualityMode(charter?.verificationBar ?? null),
        tweakNotes: input.tweakNotes?.trim() || undefined,
        baseDoc: active?.doc,
      },
    );
    const personaId = ulid();
    await db.insert(personas).values({
      id: personaId,
      channelId,
      name: proposal.name,
      archetype,
      version: (active?.version ?? 0) + 1,
      parentId: active?.id ?? null,
      status: "draft",
      createdBy: "operator",
      doc: proposal.doc,
      rationale: input.tweakNotes?.trim() || "operator-requested regeneration",
    });
    revalidatePath(`/channels/${channelId}`);
    return { personaId };
  } catch (e) {
    console.error("[persona] regeneration failed:", e);
    return { error: errorMessage(e) };
  }
}
