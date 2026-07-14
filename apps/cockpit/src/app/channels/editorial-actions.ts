"use server";

import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
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
  ideas,
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
  proposeReplacementEpisode,
  runWizardAssistant,
  scoreIdea,
  scoutAuthoritativeDomains,
  writeEpisodeBrief,
  type WizardChatTurn,
  type WizardPatch,
} from "@ytauto/agents";
import { greenlightAction, haltProductionAction } from "@/app/actions";
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
import { getAppContext, getMergedEnv } from "@/lib/context";
import { distillStyleCore, ingestYoutubeStyleRef } from "./style-actions";

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

/** Wizard avatar/banner engine pick (the Review-step toggle). */
export type WizardImageEngine = "fal" | "nano-banana";

/**
 * The nano-banana engine calls Google directly, so it needs the Gemini key.
 * Fail loud with a fix-it pointer instead of silently rendering on fal/flux —
 * the operator explicitly chose the engine. Skipped in forced-mock mode (the
 * mock renders a placeholder either way).
 */
async function assertEngineReady(engine: WizardImageEngine | undefined): Promise<string | null> {
  if (engine !== "nano-banana") return null;
  const env = await getMergedEnv();
  if (env.PROVIDERS_FORCE_MOCK === "1" || env.GEMINI_API_KEY) return null;
  return "Nano Banana needs a Gemini API key — add GEMINI_API_KEY on /account (Provider keys).";
}

/**
 * Wizard: generate a 1:1 channel avatar from the picked identity + DNA image
 * style. Stored under an onboarding-scoped key and returned as a cockpit media
 * URL the operator downloads and uploads to YouTube by hand. Works in mock
 * mode (SVG placeholder) and live (fal.ai, or Google-direct nano-banana when
 * the toggle picks it — hero tier, since brand art is one-off and pivotal).
 */
export async function generateChannelAvatarAction(input: {
  prompt: string;
  engine?: WizardImageEngine;
}): Promise<{ url: string } | { error: string }> {
  try {
    const notReady = await assertEngineReady(input.engine);
    if (notReady) return { error: notReady };
    const { providers } = await getAppContext();
    const { storageKey } = await providers.media.generateImage({
      prompt: input.prompt,
      aspect: "1:1",
      channelId: ONBOARDING_CHANNEL_ID,
      storageKeyBase: `avatars/onboarding-${ulid()}`,
      engine: input.engine,
      ...(input.engine === "nano-banana" ? { quality: "hero" as const } : {}),
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
  engine?: WizardImageEngine;
}): Promise<{ url: string } | { error: string }> {
  try {
    const notReady = await assertEngineReady(input.engine);
    if (notReady) return { error: notReady };
    const { providers } = await getAppContext();
    const { storageKey } = await providers.media.generateImage({
      prompt: input.prompt,
      aspect: "16:9",
      channelId: ONBOARDING_CHANNEL_ID,
      storageKeyBase: `banners/onboarding-${ulid()}`,
      engine: input.engine,
      ...(input.engine === "nano-banana" ? { quality: "hero" as const } : {}),
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
  /** #35.1 wizard-lite: YouTube video URLs whose thumbnails seed the visual
   * style — ingested + distilled + auto-activated at creation (non-fatal) */
  styleExampleUrls?: string[];
  /** the wizard-generated channel logo, as an ObjectStore key (the bytes are
   * already stored under avatars/onboarding-*); persisted so the cockpit can
   * render the real avatar instead of a placeholder. */
  avatarKey?: string | null;
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
    avatarKey: input.avatarKey ?? null,
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

  // #35.1 wizard-lite: seed the visual style from example video URLs — every
  // step best-effort; a bad URL or a failed distillation never blocks
  // channel creation (the Style tab covers it later).
  const styleUrls = (input.styleExampleUrls ?? []).map((u) => u.trim()).filter(Boolean).slice(0, 6);
  if (styleUrls.length) {
    try {
      let ingested = 0;
      for (const url of styleUrls) {
        const res = await ingestYoutubeStyleRef(channelId, url);
        if (!res.error) ingested++;
        else console.error(`[wizard] style ref skipped: ${res.error}`);
      }
      if (ingested > 0) {
        const distilled = await distillStyleCore(channelId, { autoActivate: true });
        if (distilled.error) console.error(`[wizard] style distillation failed: ${distilled.error}`);
      }
    } catch (e) {
      console.error("[wizard] style seeding failed — channel created without a style:", e);
    }
  }

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

// ── Plan-tab episode menu (2026-07-12 operator ask) ───────────────────────
// Per-episode actions without leaving the Plan tab: stop & cut, replace with
// a fresh idea (with optional direction), re-greenlight from scratch.

/** Production statuses where a pipeline run may still be alive. */
const ACTIVE_PRODUCTION = new Set([
  "greenlit",
  "scripting",
  "script_review",
  "profile_review",
  "producing_assets",
  "assembling",
  "thumbnail_review",
  "ready",
  "on_hold",
]);

/** The episode's latest production, if any. */
async function latestProductionForIdea(db: Awaited<ReturnType<typeof getAppContext>>["db"], ideaId: string) {
  const rows = await db
    .select()
    .from(productions)
    .where(eq(productions.ideaId, ideaId))
    .orderBy(desc(productions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Stop any live run and cut the episode: production → halted draft (never
 * deleted; the halt event cancels the in-flight run), idea → rejected (out of
 * the pool), episode → cut with its tentative slot cleared. A scheduled or
 * published video must be unscheduled/handled on its production page first —
 * cutting must never silently strand a live YouTube upload.
 */
export async function cutEpisodeAction(
  episodeId: string,
  notes?: string,
): Promise<{ error?: string }> {
  const { db } = await getAppContext();
  const [ep] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
  if (!ep) return { error: "Episode not found" };
  if (ep.status === "cut") return { error: "Episode is already cut" };
  if (ep.status === "published") return { error: "Episode is published — cutting it here is not supported" };

  if (ep.ideaId) {
    const prod = await latestProductionForIdea(db, ep.ideaId);
    if (prod && ["scheduled", "published"].includes(prod.status)) {
      return {
        error: "This episode's video is scheduled/published — cancel the release on its production page first",
      };
    }
    if (prod && ACTIVE_PRODUCTION.has(prod.status)) {
      await haltProductionAction(prod.id); // halted draft + run cancelled
    }
    await db.update(ideas).set({ status: "rejected" }).where(eq(ideas.id, ep.ideaId));
  }
  await db
    .update(episodes)
    .set({ status: "cut", tentativeFor: null })
    .where(eq(episodes.id, episodeId));
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId: ep.channelId,
    kind: "operator_steer",
    summary: `Episode cut from the Plan tab: "${ep.title}"`,
    detail: { episodeId, ...(notes?.trim() ? { notes: notes.trim() } : {}) },
    actor: "operator",
  });
  revalidatePath(`/channels/${ep.channelId}`);
  return {};
}

/**
 * Replace an episode with a fresh idea (operator-initiated gap-fill): the
 * planner proposes ONE materially-distinct replacement — the operator's
 * direction steers it — which inherits the vacated tentative slot and goes
 * straight to research. The old episode is cut (any live run halted first).
 */
export async function replaceEpisodeAction(
  episodeId: string,
  steer?: string,
): Promise<{ error?: string; replacementTitle?: string }> {
  const { db, providers, costSink } = await getAppContext();
  const [ep] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
  if (!ep) return { error: "Episode not found" };
  if (!ep.seriesId) return { error: "Episode has no series — replacement needs an arc to plan within" };
  if (ep.status === "published") return { error: "Episode is published — replace isn't available" };
  const [s] = await db.select().from(series).where(eq(series.id, ep.seriesId));
  const [channel] = await db.select().from(channels).where(eq(channels.id, ep.channelId));
  if (!s || !channel) return { error: "Series or channel not found" };

  if (ep.ideaId) {
    const prod = await latestProductionForIdea(db, ep.ideaId);
    if (prod && ["scheduled", "published"].includes(prod.status)) {
      return {
        error: "This episode's video is scheduled/published — cancel the release on its production page first",
      };
    }
    if (prod && ACTIVE_PRODUCTION.has(prod.status)) {
      await haltProductionAction(prod.id);
    }
    await db.update(ideas).set({ status: "rejected" }).where(eq(ideas.id, ep.ideaId));
  }

  const all = await db
    .select({ title: episodes.title, position: episodes.position })
    .from(episodes)
    .where(eq(episodes.seriesId, ep.seriesId));
  let proposal: { title: string; angle: string };
  try {
    proposal = await proposeReplacementEpisode(
      { db, llm: providers.llm, costSink, channelId: ep.channelId },
      {
        niche: channel.niche,
        seriesTitle: s.title,
        seriesDescription: s.description ?? "",
        excludeTitles: all.map((t) => t.title),
        operatorSteer: steer,
      },
    );
  } catch (err) {
    return { error: `Replacement proposal failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const newId = ulid();
  await db.insert(episodes).values({
    id: newId,
    seriesId: ep.seriesId,
    channelId: ep.channelId,
    position: Math.max(...all.map((t) => t.position), -1) + 1,
    title: proposal.title,
    angle: proposal.angle,
    status: "planned",
    tentativeFor: ep.tentativeFor, // the replacement inherits the vacated slot
  });
  await db
    .update(episodes)
    .set({ status: "cut", tentativeFor: null })
    .where(eq(episodes.id, episodeId));
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId: ep.channelId,
    kind: "operator_steer",
    summary: `Operator replaced "${ep.title}" with "${proposal.title}"`,
    detail: {
      episodeId,
      replacementEpisodeId: newId,
      ...(steer?.trim() ? { steer: steer.trim() } : {}),
    },
    actor: "operator",
  });
  await inngest.send({
    name: "editorial/episode.research.requested",
    data: { episodeId: newId, channelId: ep.channelId },
  });
  revalidatePath(`/channels/${ep.channelId}`);
  return { replacementTitle: proposal.title };
}

/**
 * Re-greenlight from the start: a FRESH production for the episode's idea —
 * new production id, so nothing is reused (the halted/failed attempt stays as
 * an inspectable draft). Available once no run is alive.
 */
export async function regreenlightEpisodeAction(episodeId: string): Promise<{ error?: string }> {
  const { db } = await getAppContext();
  const [ep] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
  if (!ep) return { error: "Episode not found" };
  if (!ep.ideaId) return { error: "Episode hasn't been handed to the idea pool yet — nothing to greenlight" };
  const prod = await latestProductionForIdea(db, ep.ideaId);
  if (prod && ACTIVE_PRODUCTION.has(prod.status)) {
    return { error: "A production is already running for this episode — halt it first" };
  }
  if (prod && ["scheduled", "published"].includes(prod.status)) {
    return { error: "This episode already has an uploaded video — manage it from its production page" };
  }
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId: ep.channelId,
    kind: "operator_steer",
    summary: `Operator re-greenlit "${ep.title}" from the start (fresh production)`,
    detail: { episodeId, previousProductionId: prod?.id ?? null },
    actor: "operator",
  });
  await greenlightAction(ep.ideaId); // fresh production + pipeline event
  return {};
}

/**
 * Force-accept an episode's research (2026-07-12 operator ask: "15 facts and
 * still fact-searching"): the operator decides the facts on hand are enough.
 * Cancels THAT episode's in-flight research chain (per-episode halt event),
 * writes the brief from the current claims, and hands off exactly like the
 * chain's own queue-idea step (idea + auto-greenlight on T2+, auto-score on
 * T0/T1). The facts-gate minimum is deliberately NOT applied — this IS the
 * override — but at least one tellable claim is required.
 */
export async function forceAcceptResearchAction(
  episodeId: string,
): Promise<{ error?: string; tellable?: number }> {
  const { db, providers, costSink } = await getAppContext();
  const [ep] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
  if (!ep) return { error: "Episode not found" };
  if (ep.ideaId) return { error: "Episode is already handed off — greenlight it from the Next step column" };
  if (!["planned", "researching", "verifying", "briefed"].includes(ep.status)) {
    return { error: `Episode is ${ep.status} — nothing to force-accept` };
  }
  const [channel] = await db.select().from(channels).where(eq(channels.id, ep.channelId));
  const [charter] = await db
    .select()
    .from(channelCharters)
    .where(eq(channelCharters.channelId, ep.channelId));
  if (!channel) return { error: "Channel not found" };

  const allClaims = await db.select().from(claims).where(eq(claims.episodeId, episodeId));
  const usable = allClaims.filter((c) => c.status === "verified" || c.status === "attributed");
  const mode = resolveFactualityMode(charter?.verificationBar ?? undefined);
  const conjecture = mode === "strict" ? [] : allClaims.filter((c) => c.status === "conjecture");
  const tellable = usable.length + conjecture.length;
  if (tellable < 1) {
    return { error: "No verified/attributed facts yet — nothing to build a script on" };
  }

  // stop THIS episode's research chain before handing off (per-episode cancel;
  // the chain's queue-idea step also guards on ideaId as belt-and-braces)
  await inngest.send({
    name: "editorial/episode.research.halt",
    data: { episodeId, channelId: ep.channelId },
  });

  // Leftover in-flight claims are CUT, not abandoned mid-"unverified" — the
  // pipeline's factuality gate reads unverified rows as verification still
  // running (2026-07-13 incident: force-accepted episode held at the gate on
  // "9 claim(s) never finished verification" despite dozens verified).
  await db
    .update(claims)
    .set({ status: "cut" })
    .where(and(eq(claims.episodeId, episodeId), eq(claims.status, "unverified")));

  let brief: Awaited<ReturnType<typeof writeEpisodeBrief>>;
  try {
    brief = await writeEpisodeBrief(
      { db, llm: providers.llm, costSink, channelId: ep.channelId },
      {
        topic: ep.title,
        angle: ep.angle,
        claims: [
          ...usable.map((c) => ({ id: c.id, tier: c.tier as string, text: c.text })),
          ...conjecture.map((c) => ({ id: c.id, tier: "conjecture", text: c.text })),
        ],
      },
    );
  } catch (err) {
    return { error: `Brief writing failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  await db
    .update(episodes)
    .set({ brief: brief as unknown as Record<string, unknown>, status: "briefed" })
    .where(eq(episodes.id, episodeId));

  const ideaId = ulid();
  await db.insert(ideas).values({
    id: ideaId,
    channelId: ep.channelId,
    title: ep.title,
    angle: ep.angle,
    sourceType: "editorial",
    researchRefs: allClaims.map((c) => c.id),
    status: channel.autonomyTier >= 2 ? "greenlit" : "inbox",
  });
  await db.update(episodes).set({ ideaId, status: "queued" }).where(eq(episodes.id, episodeId));
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId: ep.channelId,
    kind: "operator_steer",
    summary: `Research force-accepted for "${ep.title}" with ${tellable} tellable fact(s) — operator override`,
    detail: { episodeId, tellable, usable: usable.length, conjecture: conjecture.length, factualityMode: mode },
    actor: "operator",
  });

  if (channel.autonomyTier >= 2) {
    const productionId = ulid();
    await db.insert(productions).values({ id: productionId, ideaId, channelId: ep.channelId, status: "greenlit" });
    await inngest.send({ name: "production/greenlit", data: { productionId, attempt: "0" } });
  } else {
    // best-effort auto-score so the Plan tab shows a priority signal (#19)
    try {
      await scoreIdea({ db, llm: providers.llm, costSink, channelId: ep.channelId, ideaId }, ideaId);
    } catch {
      // scoring is advisory — never block the handoff
    }
  }
  revalidatePath(`/channels/${ep.channelId}`);
  return { tellable };
}

/**
 * Re-project every tentative slot for a channel (2026-07-12 operator report:
 * slots computed under the old spread clustered on consecutive days and left a
 * two-week gap after the first video). Sequences the unlocked episodes of ALL
 * active series (series age, then position) through one projectTentativeSlots
 * pass under the current cadence/plan — episodes whose idea already holds a
 * real publication keep their locked schedule and are skipped.
 */
export async function reprojectTentativeSlotsAction(
  channelId: string,
): Promise<{ error?: string; moved?: number }> {
  const { db } = await getAppContext();
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!channel) return { error: "Channel not found" };
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  const activeSeries = await db
    .select({ id: series.id })
    .from(series)
    .where(and(eq(series.channelId, channelId), eq(series.status, "active")))
    .orderBy(asc(series.createdAt));
  if (activeSeries.length === 0) return { error: "No active series to re-project" };

  const format = channel.contentFormat === "long" ? ("long" as const) : ("shorts" as const);
  const now = new Date();
  const state = await channelWarmupState(db, channelId, now, format);

  const eps: { id: string; status: string; ideaId: string | null }[] = [];
  for (const s of activeSeries) {
    eps.push(
      ...(await db
        .select({ id: episodes.id, status: episodes.status, ideaId: episodes.ideaId })
        .from(episodes)
        .where(eq(episodes.seriesId, s.id))
        .orderBy(asc(episodes.position))),
    );
  }
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
  if (target.length === 0) return { error: "Every episode is locked or terminal — nothing to move" };

  const slots = projectTentativeSlots({
    format,
    launchedAt: state?.launchedAt ?? channel.createdAt ?? now,
    now,
    count: target.length,
    releasedThisWeek: state?.releasedThisWeek ?? 0,
    cadencePerWeek: dna?.cadencePerWeek,
    releasePlan: dna?.releasePlan ?? null,
  });
  for (let i = 0; i < target.length; i++) {
    await db
      .update(episodes)
      .set({ tentativeFor: slots[i] ?? null })
      .where(eq(episodes.id, target[i]!.id));
  }
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    summary: `Calendar re-projected: ${target.length} tentative slots respread`,
    detail: { moved: target.length },
    actor: "operator",
  });
  revalidatePath(`/channels/${channelId}`);
  revalidatePath("/");
  return { moved: target.length };
}

/**
 * Move ONE tentative slot (drag-and-drop on the Schedule calendar): set the
 * episode's tentativeFor to the dropped day, keeping its original wall-clock
 * time. Real (uploaded) schedules move via reschedulePublicationAction — this
 * touches only the projection, so nothing propagates to YouTube.
 */
export async function moveTentativeSlotAction(
  episodeId: string,
  newTimeIso: string,
): Promise<{ error?: string }> {
  const { db } = await getAppContext();
  const when = new Date(newTimeIso);
  if (Number.isNaN(when.getTime())) return { error: "Invalid date" };
  if (when.getTime() <= Date.now()) return { error: "Pick a day in the future" };
  const [ep] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
  if (!ep) return { error: "Episode not found" };
  if (["cut", "published"].includes(ep.status)) {
    return { error: `Episode is ${ep.status} — its slot can't move` };
  }
  // an episode whose idea already holds a real publication is locked to the
  // real schedule; moving the projection would just be ignored downstream
  if (ep.ideaId) {
    const [lockedPub] = await db
      .select({ id: publications.id })
      .from(publications)
      .innerJoin(productions, eq(publications.productionId, productions.id))
      .where(eq(productions.ideaId, ep.ideaId))
      .limit(1);
    if (lockedPub) {
      return { error: "This episode already has a real schedule — move it via its calendar entry" };
    }
  }
  await db.update(episodes).set({ tentativeFor: when }).where(eq(episodes.id, episodeId));
  revalidatePath(`/channels/${ep.channelId}`);
  revalidatePath("/");
  return {};
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
