/**
 * BACKLOG #36 — Claude-app MCP connector tool registry.
 *
 * Each tool exposes a slice of the platform's own action API to a remote MCP
 * client (the Claude desktop/mobile app added as a custom connector). The
 * operator ideates in a normal Claude chat grounded in the platform's REAL
 * intel, and "make it so" actually seeds ideas / drafts charters / creates
 * channels here.
 *
 * Compliance (same rule the assistant's runControl follows): every MUTATING
 * tool writes the same rows the cockpit buttons write, and channel-scoped
 * mutations log a `channel_decisions` row with actor `operator` — the bearer
 * token IS the operator, so an MCP-driven change is an operator change.
 */
import { and, desc, eq, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import {
  agentTickets,
  alerts,
  assets,
  beatMaps,
  channelCharters,
  channelDecisions,
  channelDna,
  channelPlaybook,
  channels,
  costRecords,
  episodes,
  evalResults,
  evalRuns,
  hookAnalyses,
  ideas,
  marketOpportunities,
  patterns,
  productions,
  productionMusic,
  publications,
  reviewGates,
  scriptAnalyses,
  scriptDrafts,
  series,
  serviceVersions,
  shotJobs,
  thumbnails,
  ulid,
  type ScriptBeat,
  type SourceStrategy,
  type VerificationBar,
} from "@ytauto/db";
import { MCP_GUIDE } from "./guide";
import { auditGuideToolReferences } from "./guide-audit";
import {
  beatMapFingerprint,
  beatMapVerdict,
  CHARACTER_CAST_MODES,
  charterProposalSchema,
  estimateBeatMapShotPlan,
  DEFERRED_WORK,
  deferredByStatus,
  channelPerformanceSummary,
  channelStateSummary,
  classifyPublication,
  findSuspiciousPublications,
  GATE_DEAD_PRODUCTION_STATUSES,
  inngest,
  isConfirmedPhantom,
  isReconcileMismatch,
  publishedAtDrift,
  PUBLISHED_AT_DRIFT_TOLERANCE_MS,
  markPublicationLive,
  markScheduleCancelled,
  resolveGoLivePublishedAt,
  projectShotPlan,
  resolveProductionProfile,
  VIDEO_ENGINES,
  videoAspect,
  reviewBeatMapDeterministic,
  selectComparisonMaps,
  beatMapWordCount,
  resolveLengthPolicy,
  reviewRuntimeFit,
  reviewSlateDeterministic,
  slateVerdict,
  regenShotMode,
  imageSourceKind,
  duplicateRiskGroups,
  outstandingDuplicateShotCount,
  fragmentedHookStyleWarnings,
  lengthPolicyFloorWarnings,
  madeForKidsWarnings,
  listChannelBed,
  CHANNEL_BED_TARGET,
  type SlateFinding,
  type SlateIdea,
  videoPerformance,
  type BeatMap,
  type CharterProposal,
} from "@ytauto/core";
import { proposeCharter, reviewSlateSemantic, AGENT_PROMPTS, complianceRelevantPrompts } from "@ytauto/agents";
import { getAppContext, getMergedEnv } from "@/lib/context";
import { createGithubIssue, commentOnGithubIssue } from "@/lib/github-issues";
// NOTE: decideGateAction is intentionally NOT imported here — gate approval is a
// human cockpit action and must not be reachable over MCP (remediation §0.1).
import {
  createChannelWithCharterAction,
  type CreateChannelWithCharterInput,
} from "@/app/channels/editorial-actions";
import {
  authorProduction,
  resolveIdeaRef,
  createSeriesDirect,
  updateSeries,
  setEpisodeStatus,
  setIdeaStatus,
  updateIdea,
  getChannelStrategy,
  setChannelStrategy,
  setChannelConfig,
  setPublicationMetadata,
  writeIdea,
  type AuthoredBeat,
} from "@/app/mcp-authoring-actions";
import {
  decideGateAction,
  swapShotImageAction,
  regenerateThumbnailsAction,
  haltProductionAction,
  resumeProductionAction,
  retryFromStageAction,
  forceForwardAction,
  retireProductionAction,
  correctPublishedProductionAction,
  releasePublicationAction,
  greenlightAction,
  greenlightAllowDuplicateAction,
  dedupeRealImagesAction,
  queueShotOpAction,
  scanTrendsAction,
  saveScriptBeatsAction,
  refineThumbnailAction,
  setAudioLevelsAction,
  type RetryStage,
  type HaltDiscard,
} from "@/app/actions";
import { promoteTestSceneAction } from "@/app/channels/style-actions";
import { addCompetitorAction, setIntelCadenceAction } from "@/app/channels/[id]/intel-actions";
import { setOpportunityStatusAction } from "@/app/ideas/opportunity-actions";
import { ackAlertAction, runIngestNowAction } from "@/app/alerts/actions";
import { addPlaybookEntryAction, adoptPlaybookEntryAction, retirePlaybookEntryAction } from "@/app/channels/[id]/playbook-actions";
import {
  reviseSeriesAction,
  cutEpisodeAction,
  replaceEpisodeAction,
  regreenlightEpisodeAction,
  restoreEpisodeResearchAction,
  runEditorialPlanAction,
} from "@/app/channels/editorial-actions";
import {
  generateMusicCandidateAction,
  useLibraryTrackAction,
  selectMusicAction,
  searchOpenverseMusicAction,
  addOpenverseTrackToBedAction,
  useOpenverseTrackForProductionAction,
  addProductionTrackToBedAction,
  useBedTrackForProductionAction,
  removeBedTrackAction,
  type OpenverseTrack,
} from "@/app/actions";
import { generateChannelLogoAction, generateChannelBannerAssetAction } from "@/app/channels/actions";
import { generateStyleTestScene, listStyleTestScenes, refineStyleTestScene } from "@/lib/style-tests";
import {
  asCharacterEngine,
  listChannelCharacters,
  createChannelCharacter,
  refineChannelCharacter,
  setChannelCharacterCast,
  deleteChannelCharacter,
} from "@/lib/characters";

/** MCP tool definition: a name, a description, a JSON-Schema input contract,
 * and an executor returning any JSON-serialisable value. */
export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

/** MCP-invoked mutations are operator actions — audit them like the cockpit. */
async function logDecision(
  db: Awaited<ReturnType<typeof getAppContext>>["db"],
  channelId: string,
  summary: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    actor: "operator",
    summary,
    detail: { ...detail, via: "mcp" },
  });
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * resume_production / correct_published_production wrap cockpit server actions
 * that finish by calling Next's redirect() (which THROWS a NEXT_REDIRECT). By
 * then the DB work has committed, so we catch that specific throw and pull the
 * new production id out of the redirect target (`/productions/<id>`). Any other
 * error is a real failure and is re-thrown.
 */
async function runExpectingRedirect(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null; // no redirect happened (older behaviour) — caller handles null
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return digest.match(/\/productions\/([A-Za-z0-9]+)/)?.[1] ?? null;
    }
    throw err;
  }
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (!v) throw new Error(`Missing required argument: ${key}`);
  return v;
}

/** JSON-Schema for an Openverse track object, as returned by search_free_music
 * and accepted back by set_music_bed / set_production_music. */
const OPENVERSE_TRACK_SCHEMA = {
  type: "object",
  description: "A free-music track exactly as returned by search_free_music (pass one straight through).",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    audioUrl: { type: "string" },
    pageUrl: { type: "string" },
    creator: { type: "string" },
    license: { type: "string" },
    durationSec: { type: "number" },
  },
  required: ["id", "title", "audioUrl", "pageUrl", "creator", "license"],
  additionalProperties: false,
} as const;

/** Parse an Openverse track object off an MCP arg (from search_free_music). */
function parseOpenverseTrack(args: Record<string, unknown>, key: string): OpenverseTrack {
  const v = args[key];
  if (!v || typeof v !== "object") {
    throw new Error(`Missing ${key}: pass a track object from search_free_music.`);
  }
  const t = v as Record<string, unknown>;
  const audioUrl = typeof t.audioUrl === "string" ? t.audioUrl.trim() : "";
  if (!audioUrl) throw new Error(`${key}.audioUrl is required — pass a track object from search_free_music.`);
  return {
    id: typeof t.id === "string" ? t.id : audioUrl,
    title: typeof t.title === "string" ? t.title : "Untitled",
    audioUrl,
    pageUrl: typeof t.pageUrl === "string" ? t.pageUrl : "",
    creator: typeof t.creator === "string" ? t.creator : "Unknown",
    license: typeof t.license === "string" ? t.license : "",
    durationSec: typeof t.durationSec === "number" ? t.durationSec : undefined,
  };
}

/** Remediation §5.2: flag DNA↔charter contradictions (surface, don't correct). */
function charterDnaWarnings(objectives: string[], targetLengthSec: number): string[] {
  const warnings: string[] = [];
  const text = objectives.join(" ").toLowerCase();
  // "10-15 min", "10 to 15 minutes", or a single "10 minute" mention
  const m = text.match(/(\d+)\s*(?:-|to|–|—)\s*(\d+)\s*min/) ?? text.match(/(\d+)\s*min/);
  if (m) {
    const low = Number(m[1]);
    if (Number.isFinite(low) && low > 0 && targetLengthSec > 0 && targetLengthSec < low * 60) {
      const range = m[2] ? `${low}-${m[2]}` : `${low}`;
      warnings.push(
        `Charter objectives target ~${range} min videos, but DNA targetLengthSec is ${Math.round(targetLengthSec / 60)} min (${targetLengthSec}s) — the channel is undershooting its own stated length target.`,
      );
    }
  }
  return warnings;
}

/** Format → DNA defaults, mirroring the setup wizard (#17 format→length). */
function dnaDefaultsForFormat(format: string): {
  contentFormat: string;
  targetLengthSec: number;
  cadencePerWeek: number;
} {
  if (format === "long") return { contentFormat: "long", targetLengthSec: 480, cadencePerWeek: 2 };
  if (format === "both") return { contentFormat: "both", targetLengthSec: 480, cadencePerWeek: 4 };
  return { contentFormat: "short", targetLengthSec: 45, cadencePerWeek: 7 };
}

/**
 * Assemble the full channel-creation payload from an AI-drafted charter
 * proposal + the operator's chosen identity, exactly as the wizard's Review
 * step would — so an MCP `create_channel` runs the same vetted path as the UI.
 */
function buildCreateInput(
  proposal: CharterProposal,
  input: {
    name: string;
    handle: string;
    niche: string;
    format: string;
    autonomyTier: number;
    derivedFromChannelId?: string | null;
    styleExampleUrls?: string[];
  },
): CreateChannelWithCharterInput {
  const fmt = dnaDefaultsForFormat(input.format);
  return {
    name: input.name,
    handle: input.handle,
    niche: input.niche,
    contentFormat: fmt.contentFormat,
    autonomyTier: input.autonomyTier,
    derivedFromChannelId: input.derivedFromChannelId ?? null,
    charter: {
      mission: proposal.mission,
      objectives: proposal.objectives,
      archetype: proposal.archetype,
      sourceStrategy: proposal.sourceStrategy as SourceStrategy,
      verificationBar: proposal.verificationBar as VerificationBar,
      checkinCadence: "weekly",
      personaArchetype: proposal.personaArchetype,
      personaRationale: proposal.personaRationale ?? null,
    },
    dna: {
      tone: proposal.dnaDefaults.tone,
      audiencePersona: proposal.dnaDefaults.audiencePersona,
      hookStyles: proposal.dnaDefaults.hookStyles,
      forbiddenTopics: proposal.dnaDefaults.forbiddenTopics,
      // #58 (ticket 01KYDSN9…): commit the REVIEWED imageStyle from the charter,
      // exactly as the other five dnaDefaults fields flow through — dropping it
      // silently violated "what you reviewed is what's committed" (#27) and left a
      // generated-visual channel with no house register. It's still only what the
      // operator approved: an empty proposal value stays blank (blank means blank),
      // never invented. Trim/cap to match set_channel_config's imageStyle write.
      imageStyle: (proposal.dnaDefaults.imageStyle ?? "").trim().slice(0, 400),
      primaryColor: "#38bdf8",
      font: "Inter",
      voiceId: "default",
      ctaTemplate: proposal.dnaDefaults.ctaTemplate,
      targetLengthSec: fmt.targetLengthSec,
      cadencePerWeek: fmt.cadencePerWeek,
      releasePlan: null,
    },
    identityProposals: { options: [], pickedIndex: null },
    styleExampleUrls: input.styleExampleUrls,
  };
}

export const MCP_TOOLS: McpTool[] = [
  // ── Read ────────────────────────────────────────────────────────────────
  {
    name: "list_channels",
    description:
      "List every channel on the platform with its id, name, @handle, niche, content format, and autonomy tier. Start here to get channel ids for the other tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const { db } = await getAppContext();
      const rows = await db.select().from(channels).orderBy(desc(channels.createdAt));
      return rows.map((c) => ({
        id: c.id,
        name: c.name,
        handle: c.handle,
        niche: c.niche,
        contentFormat: c.contentFormat,
        autonomyTier: c.autonomyTier,
        derivedFromChannelId: c.derivedFromChannelId ?? null,
      }));
    },
  },
  {
    name: "get_channel_state",
    description:
      "Read a channel's charter (mission + objectives), its distilled 'state of the world' summary (recent decisions, plan, coverage), and a performance summary (published count, views, retention, best/worst). Use before proposing changes so ideation is grounded in what the channel already is and how it's doing.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string", description: "channel id from list_channels" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const { db } = await getAppContext();
      const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
      if (!channel) throw new Error("Channel not found");
      const [charter] = await db
        .select()
        .from(channelCharters)
        .where(eq(channelCharters.channelId, channelId));
      const stateSummary = await channelStateSummary(db, channelId);
      const performance = await channelPerformanceSummary(db, channelId);
      return {
        channel: {
          id: channel.id,
          name: channel.name,
          handle: channel.handle,
          niche: channel.niche,
          contentFormat: channel.contentFormat,
          autonomyTier: channel.autonomyTier,
        },
        charter: charter
          ? { mission: charter.mission, objectives: charter.objectives, archetype: charter.archetype }
          : null,
        stateSummary,
        performance,
      };
    },
  },
  {
    name: "get_intel",
    description:
      "Market intelligence for ideation: rising cross-niche opportunities (new niches/topics/styles trending) and the top over-performing patterns (breakout hooks, script structures, topic signals) from the pattern store. Optionally filter to one niche. This is the REAL scouted intel — ground channel/idea proposals in it.",
    inputSchema: {
      type: "object",
      properties: {
        niche: { type: "string", description: "optional: only patterns for this niche" },
        limit: { type: "number", description: "max rows per section (default 10)" },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const { db } = await getAppContext();
      const niche = str(args, "niche");
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
      const opportunities = await db
        .select()
        .from(marketOpportunities)
        .where(inArray(marketOpportunities.status, ["new", "shortlisted"]))
        .orderBy(desc(marketOpportunities.momentum))
        .limit(limit);
      const patternRows = await db
        .select()
        .from(patterns)
        .where(niche ? eq(patterns.niche, niche) : undefined)
        .orderBy(desc(patterns.performanceScore))
        .limit(limit);
      return {
        opportunities: opportunities.map((o) => ({
          id: o.id,
          kind: o.kind,
          label: o.label,
          summary: o.summary,
          suggestedNiche: o.suggestedNiche,
          suggestedIntent: o.suggestedIntent,
          momentum: o.momentum,
        })),
        patterns: patternRows.map((p) => ({
          kind: p.kind,
          label: p.label,
          niche: p.niche,
          format: p.format,
          source: p.source,
          performanceScore: p.performanceScore,
          observations: p.observations,
        })),
      };
    },
  },
  {
    name: "get_playbook",
    description:
      "A channel's learned playbook — the standing directives (hook/pacing/structure/visual/topic) the platform has adopted or is trialling from its own evidence, each with the WHY and a confidence score. Read it to understand what already works for a channel before suggesting changes.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const { db } = await getAppContext();
      const rows = await db
        .select()
        .from(channelPlaybook)
        .where(
          and(
            eq(channelPlaybook.channelId, channelId),
            inArray(channelPlaybook.status, ["adopted", "trial"]),
          ),
        )
        .orderBy(desc(channelPlaybook.confidence));
      return rows.map((r) => ({
        directive: r.directive,
        scope: r.scope,
        status: r.status,
        origin: r.origin,
        why: r.why,
        confidence: r.confidence,
      }));
    },
  },
  {
    name: "get_eval_results",
    description:
      "Recent model-quality eval runs (the golden-set bake-off): per candidate model, average judge score and how many fixtures ran ok vs errored. Use to answer 'which model should this channel's scripts run on'.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "how many recent runs (default 3)" } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const { db } = await getAppContext();
      const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 10);
      const runs = await db.select().from(evalRuns).orderBy(desc(evalRuns.createdAt)).limit(limit);
      const out = [];
      for (const run of runs) {
        const results = await db.select().from(evalResults).where(eq(evalResults.runId, run.id));
        const byModel = new Map<string, { overall: number[]; ok: number; error: number }>();
        for (const r of results) {
          const m = byModel.get(r.modelRef) ?? { overall: [], ok: 0, error: 0 };
          if (r.status === "error") m.error++;
          else {
            m.ok++;
            if (r.judge?.overall != null) m.overall.push(r.judge.overall);
          }
          byModel.set(r.modelRef, m);
        }
        out.push({
          runId: run.id,
          status: run.status,
          createdAt: run.createdAt,
          models: Array.from(byModel.entries()).map(([modelRef, m]) => ({
            modelRef,
            avgOverall: m.overall.length
              ? Number((m.overall.reduce((a, b) => a + b, 0) / m.overall.length).toFixed(2))
              : null,
            ok: m.ok,
            error: m.error,
          })),
        });
      }
      return out;
    },
  },

  // ── Act ─────────────────────────────────────────────────────────────────
  {
    name: "run_market_scan",
    description:
      "Kick the meta-analysis / market-scan engine now (outside its daily cron) to refresh intel — global opportunity discovery when no niche is given, or a scoped scan for one niche. Results land in get_intel shortly after; this returns immediately.",
    inputSchema: {
      type: "object",
      properties: { niche: { type: "string", description: "optional niche to scope the scan" } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const niche = str(args, "niche");
      await inngest.send({ name: "market/scan.requested", data: niche ? { niche } : {} });
      return { ok: true, queued: true, niche: niche ?? null };
    },
  },
  {
    name: "seed_idea",
    description:
      "Add a video idea to a channel's inbox and auto-score it. The idea flows through the normal scoring/production gates — seeding never bypasses review. Use to turn a chat brainstorm into real backlog on a specific channel.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        title: { type: "string", description: "the idea's title/hook (<=80 chars kept)" },
        angle: { type: "string", description: "one line on the angle/treatment" },
      },
      required: ["channelId", "title", "angle"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const title = requireStr(args, "title").slice(0, 80);
      const angle = requireStr(args, "angle");
      const { db } = await getAppContext();
      const [channel] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.id, channelId));
      if (!channel) throw new Error("Channel not found");
      const [dupe] = await db
        .select({ id: ideas.id })
        .from(ideas)
        .where(and(eq(ideas.channelId, channelId), eq(ideas.title, title)));
      if (dupe) return { ok: true, ideaId: dupe.id, duplicate: true };
      const ideaId = ulid();
      await db.insert(ideas).values({
        id: ideaId,
        channelId,
        title,
        angle,
        sourceType: "research",
        researchRefs: [{ via: "mcp" }],
      });
      await logDecision(db, channelId, `Idea seeded via Claude (MCP): "${title}"`, { ideaId, angle });
      await inngest.send({ name: "ideas/autoscore.requested", data: { channelId } });
      return { ok: true, ideaId };
    },
  },
  {
    name: "propose_channel",
    description:
      "Draft a channel charter for a niche + intent WITHOUT creating anything — returns the AI-proposed mission, objectives, verification bar, persona archetype, and DNA defaults for review. Iterate in chat, then pass the returned `charter` object to create_channel (with a name + handle) so the reviewed artefact is committed VERBATIM. Do NOT rely on create_channel re-drafting from niche+intent — that produces a different charter.",
    inputSchema: {
      type: "object",
      properties: {
        niche: { type: "string" },
        intent: { type: "string", description: "what the channel is for / its angle" },
        format: { type: "string", enum: ["short", "long", "both"], description: "default short" },
        researchDepth: { type: "string", enum: ["standard", "deep"] },
        monetisationSafe: { type: "boolean" },
      },
      required: ["niche", "intent"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const { db, providers, costSink } = await getAppContext();
      const proposal = await proposeCharter(
        { db, llm: providers.llm, costSink, channelId: "onboarding" },
        {
          niche: requireStr(args, "niche"),
          intent: requireStr(args, "intent"),
          format: str(args, "format"),
          researchDepth: str(args, "researchDepth"),
          monetisationSafe: typeof args.monetisationSafe === "boolean" ? args.monetisationSafe : undefined,
        },
      );
      // Backward-compatible: proposal fields stay top-level (existing readers
      // keep working); pass this whole object back as create_channel's `charter`
      // (the schema ignores the extra `next` hint).
      return {
        ...proposal,
        next: "To commit THIS reviewed charter unchanged, call create_channel with { charter: <this whole object>, name, handle } — you pick the name/handle. Passing `charter` skips the re-draft so nothing drifts (esp. forbiddenTopics + verificationBar).",
      };
    },
  },
  {
    name: "create_channel",
    description:
      "Create a new channel end-to-end. IMPORTANT: to commit exactly what you reviewed, pass the `charter` object that propose_channel returned — it is used VERBATIM and the drafting LLM is skipped (same rails as an authored image prompt). WITHOUT `charter`, a fresh, non-deterministic charter is drafted here — so the compliance-relevant fields (forbiddenTopics, verificationBar) can differ from what you reviewed. Then it provisions the channel + DNA + charter + persona + standing sources, exactly like the setup wizard. YouTube account/channel creation stays a MANUAL operator step (returned as a checklist).",
    inputSchema: {
      type: "object",
      properties: {
        niche: { type: "string" },
        intent: { type: "string", description: "what the channel is for / its angle" },
        name: { type: "string", description: "channel display name" },
        handle: { type: "string", description: "@handle, e.g. @hangar-histories" },
        charter: {
          type: "object",
          description:
            "The exact charter object returned by propose_channel. When supplied it is committed verbatim (no re-draft) — pass it so what you reviewed is what's created.",
          additionalProperties: true,
        },
        format: { type: "string", enum: ["short", "long", "both"], description: "default short" },
        autonomyTier: {
          type: "number",
          description: "0 manual … 3 exception-only (default 1 — assisted, human gates)",
        },
        derivedFromChannelId: {
          type: "string",
          description: "optional: if this is a Shorts companion fed by a long-form channel, its id",
        },
        styleExampleUrls: {
          type: "array",
          items: { type: "string" },
          description: "optional YouTube video URLs whose thumbnails seed the visual style",
        },
        researchDepth: { type: "string", enum: ["standard", "deep"] },
        monetisationSafe: { type: "boolean" },
      },
      required: ["niche", "intent", "name", "handle"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const niche = requireStr(args, "niche");
      const intent = requireStr(args, "intent");
      const name = requireStr(args, "name");
      const handle = requireStr(args, "handle");
      const format = str(args, "format") ?? "short";
      const autonomyTier = Math.min(Math.max(Number(args.autonomyTier ?? 1) || 1, 0), 3);
      const styleExampleUrls = Array.isArray(args.styleExampleUrls)
        ? args.styleExampleUrls.filter((u): u is string => typeof u === "string")
        : undefined;

      const { db, providers, costSink } = await getAppContext();
      // Seeded-charter rails (ticket 01KY255X…): if the caller passes the charter
      // they reviewed via propose_channel, commit it VERBATIM — no re-draft — so
      // the reviewed artefact (esp. forbiddenTopics + verificationBar) is exactly
      // what lands. Only draft a fresh one when no charter is supplied.
      const charterArg = (args as { charter?: unknown }).charter;
      let proposal: CharterProposal;
      let charterSource: "reviewed" | "drafted";
      if (charterArg != null) {
        const parsed = charterProposalSchema.safeParse(charterArg);
        if (!parsed.success) {
          throw new Error(
            `Invalid charter (must be the object propose_channel returned): ${parsed.error.issues
              .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
              .join("; ")}`,
          );
        }
        proposal = parsed.data;
        charterSource = "reviewed";
      } else {
        proposal = await proposeCharter(
          { db, llm: providers.llm, costSink, channelId: "onboarding" },
          {
            niche,
            intent,
            format,
            researchDepth: str(args, "researchDepth"),
            monetisationSafe: typeof args.monetisationSafe === "boolean" ? args.monetisationSafe : undefined,
          },
        );
        charterSource = "drafted";
      }
      const createInput = buildCreateInput(proposal, {
        name,
        handle,
        niche,
        format,
        autonomyTier,
        derivedFromChannelId: str(args, "derivedFromChannelId") ?? null,
        styleExampleUrls,
      });
      const { channelId } = await createChannelWithCharterAction(createInput);
      // createChannelWithCharterAction already logs a `charter_created` decision;
      // add an MCP-provenance steer so the origin is unambiguous in the ledger.
      await logDecision(db, channelId, `Channel "${name}" created via Claude (MCP)`, {
        niche,
        intent,
        format,
        autonomyTier,
        charterSource,
      });
      return {
        ok: true,
        channelId,
        charterSource,
        note:
          charterSource === "reviewed"
            ? "Committed the charter you reviewed verbatim (no re-draft)."
            : "No charter supplied — drafted a fresh one. It may differ from any propose_channel output you reviewed; verify with get_channel_config, or re-create passing the reviewed `charter`.",
        mission: proposal.mission,
        provisioningChecklist: [
          "Create (or reuse) the pod Google/Brand account with a unique recovery phone/email.",
          `Create the YouTube channel and set the name to "${name}" and handle to "${handle}" by hand (the API can't set these).`,
          "Connect it to the platform via the channel's Settings → YouTube OAuth (youtube.force-ssl scope).",
          // ticket 01KY2A8H…: MCP create_channel does NOT generate branding — that
          // lives in the cockpit wizard/Settings — so don't imply assets exist here.
          "Generate the avatar + banner in the cockpit (channel Settings → Branding), then apply them in YouTube Studio; the platform runs upload/thumbnails/metadata/scheduling from here. get_channel_branding shows whether they're set yet.",
        ],
      };
    },
  },

  // ── Direct authoring (BACKLOG #36): Claude writes content, platform executes ──
  {
    name: "get_channel_config",
    description:
      "Read a channel's full current configuration so you can author against it: DNA (tone, hook styles, forbidden topics, CTA, voice, target length, cadence, imageStyle — the house image style, null when blank), the resolved Production Profile (all visual/motion/rhythm/caption/music/engine axes), charter (mission, objectives, verification bar), autonomy tier, and content format. Read this before set_channel_config or author_script.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const { db } = await getAppContext();
      const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
      if (!channel) throw new Error("Channel not found");
      const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
      const [charter] = await db.select().from(channelCharters).where(eq(channelCharters.channelId, channelId));
      return {
        channel: { id: channel.id, name: channel.name, niche: channel.niche, contentFormat: channel.contentFormat, autonomyTier: channel.autonomyTier, madeForKids: channel.madeForKids ?? null, ideationPaused: channel.ideationPaused },
        dna: dna
          ? {
              tone: dna.tone,
              audiencePersona: dna.audiencePersona,
              hookStyles: dna.hookStyles,
              forbiddenTopics: dna.forbiddenTopics,
              ctaTemplate: dna.ctaTemplate,
              voiceId: dna.voiceId,
              targetLengthSec: dna.targetLengthSec,
              cadencePerWeek: dna.cadencePerWeek,
              titleTemplates: dna.titleTemplates ?? null,
              searchTerms: dna.searchTerms ?? null,
              // #64 (ticket 01KYE…): the channel HOUSE IMAGE STYLE was write-only —
              // set_channel_config wrote dna.visualStyle.imageStyle but get_channel_config
              // never returned it, so it couldn't be read before unsetting/restoring
              // (and #58's committed-at-create imageStyle wasn't verifiable). Return it
              // now (null when blank — blank means BLANK, no style clause is written).
              imageStyle: dna.visualStyle?.imageStyle ?? null,
              // #39: resolved content-driven runtime band (floor hard, rest advisory);
              // targetLengthSec above stays the soft anchor / fallback.
              lengthPolicy: resolveLengthPolicy(dna.lengthPolicy ?? null),
              productionProfile: (() => {
                const p = resolveProductionProfile(dna.productionProfile ?? null, { contentFormat: channel.contentFormat });
                // remediation §5.1: maxAiClips resolves to undefined when unset
                // (dropped by JSON) — surface the effective default so the cap is
                // visible. The pipeline applies VIDEO_MAX_AI_CLIPS (default 12).
                return { ...p, maxAiClips: p.maxAiClips ?? 12 };
              })(),
            }
          : null,
        charter: charter ? { mission: charter.mission, objectives: charter.objectives, verificationBar: charter.verificationBar } : null,
        // Remediation §5.2: warn where DNA contradicts charter objectives (don't
        // auto-correct) — e.g. an objective naming 10-15 min videos while
        // targetLengthSec is 8 min, so the channel undershoots its own target.
        // Plus (ticket 01KY6FGE…) flag hookStyles that look comma-shredded, so the
        // pre-fix corruption is visible on every read (backfill audit by reading).
        consistencyWarnings: [
          ...charterDnaWarnings(charter?.objectives ?? [], dna?.targetLengthSec ?? 0),
          ...fragmentedHookStyleWarnings(dna?.hookStyles ?? []),
          // #48: soft anchor below the channel's own hard lengthPolicy floor.
          ...(dna ? lengthPolicyFloorWarnings(dna.targetLengthSec ?? 0, resolveLengthPolicy(dna.lengthPolicy ?? null)) : []),
          // #53: Made-for-Kids designation gaps (undeclared kids channel; or a
          // charter that commits to end-cards/comments MFK disables).
          ...madeForKidsWarnings({ madeForKids: channel.madeForKids ?? null, audiencePersona: dna?.audiencePersona, objectives: charter?.objectives ?? [] }),
        ],
        // ticket 01KY98YR…: `productionProfile` and `lengthPolicy` above are the
        // RESOLVED (effective) values — defaults are filled in on READ, not persisted
        // on write. A partial set_channel_config only stores the axes you send; the
        // extra fields you see here (voiceModel, a full lengthPolicy, etc.) are
        // resolved defaults, not silent drift. set_channel_config's `stored` echo
        // returns the RAW persisted values so you can see exactly what was written.
        note: "productionProfile + lengthPolicy are RESOLVED (defaults filled on read), not the raw stored values — a partial write only persists the axes you sent.",
      };
    },
  },
  {
    name: "get_channel_strategy",
    description:
      "Read a channel's durable STRATEGY document (#61) — its taxonomy, competitive analysis, dated decisions + reasons, open questions and long-term vision. High-capacity and section-scoped. CRUCIALLY this is SEPARATE from creative instruction: it is NOT read by the authoring pipeline (script/image/thumbnail prompts), so writing strategy here never pollutes generation the way productionProfile.notes/artDirection or charter.mission would. This is the durable memory a fresh session reads to learn what the channel is TRYING to become, not just what it's configured to do. Returns each section's content + updatedAt + char count.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => getChannelStrategy(requireStr(args, "channelId")),
  },
  {
    name: "set_channel_strategy",
    description:
      "Write or update one SECTION of a channel's strategy document (#61). Section-scoped so you can append a decision without rewriting a 40,000-char document — pass `section` (e.g. 'taxonomy', 'competitive', 'decisions', 'open-questions', 'vision'; defaults to 'main') and `content`. Each section is timestamped so superseded reasoning survives. Empty `content` clears that section. Per-section cap 100,000 chars; the document as a whole is unbounded. This content is NEVER injected into an authoring prompt — it's planning/operator memory only (read it with get_channel_strategy; the ideation + slate agents reading it is a documented opt-in follow-up, not on yet).",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        content: { type: "string", description: "the section's full text (replaces that section); empty clears it" },
        section: { type: "string", description: "section name, e.g. 'taxonomy' | 'decisions' | 'vision' (default 'main')" },
      },
      required: ["channelId", "content"],
      additionalProperties: false,
    },
    execute: async (args) =>
      setChannelStrategy({
        channelId: requireStr(args, "channelId"),
        // allow "" through (clears the section); requireStr would reject empty
        content: typeof args.content === "string" ? args.content : "",
        section: str(args, "section"),
      }),
  },
  {
    name: "get_channel_branding",
    description:
      "Read a channel's branding assets — avatar + banner (ticket 01KY2A8H…). Returns each asset's URL (served from /api/media) or null if not generated, plus whether it's set. NOTE: create_channel does NOT generate branding, so a freshly created channel reads both as unset — generate them with generate_brand_art (or in the cockpit under Settings → Branding). Applying to YouTube stays a manual operator step (no avatar API; the banner push is a cockpit action).",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const { db } = await getAppContext();
      const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
      if (!channel) throw new Error("Channel not found");
      const mediaUrl = (key: string | null) => (key ? `/api/media/${key}` : null);
      const avatarUrl = mediaUrl(channel.avatarKey);
      const bannerUrl = mediaUrl(channel.bannerKey);
      return {
        channelId,
        avatar: { set: Boolean(avatarUrl), url: avatarUrl, aspect: "1:1", note: "YouTube avatar is 800x800 square; upload is manual (no avatar API)." },
        banner: { set: Boolean(bannerUrl), url: bannerUrl, aspect: "16:9", note: "YouTube banner needs >=2048x1152; keep the subject in the central safe area (~1235x338 visible on mobile)." },
        note:
          avatarUrl && bannerUrl
            ? "Both assets generated. Apply them in YouTube Studio if you haven't."
            : "Generate missing assets in the cockpit (channel Settings → Branding) against the channel's DNA imageStyle; MCP create_channel does not generate branding.",
      };
    },
  },
  {
    name: "list_ideas",
    description: "List a channel's recent ideas (title, angle, status). Use to find an ideaId to author a script against, or to see the backlog.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" }, status: { type: "string", description: "optional filter: inbox/scored/greenlit/rejected/archived" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const status = str(args, "status");
      const { db } = await getAppContext();
      const rows = await db.select().from(ideas).where(eq(ideas.channelId, channelId)).orderBy(desc(ideas.createdAt)).limit(50);
      return rows.filter((r) => !status || r.status === status).map((r) => ({ id: r.id, title: r.title, angle: r.angle, status: r.status }));
    },
  },
  {
    name: "list_series",
    description: "List a channel's story arcs (series) with episode counts and statuses.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const { db } = await getAppContext();
      const rows = await db.select().from(series).where(eq(series.channelId, channelId)).orderBy(desc(series.createdAt));
      const out = [];
      for (const s of rows) {
        const eps = await db.select({ id: episodes.id, title: episodes.title, status: episodes.status }).from(episodes).where(eq(episodes.seriesId, s.id)).orderBy(episodes.position);
        out.push({ id: s.id, title: s.title, status: s.status, plannedEpisodeCount: s.plannedEpisodeCount, episodes: eps });
      }
      return out;
    },
  },
  {
    name: "list_productions",
    description:
      "List recent productions (in-flight and done) for a channel, with status and costUsd per row (#49 — the successful spend booked to that production, so cost concentration on a repeatedly re-run idea is visible without a separate get_channel_costs join). Use to check what author_script / write_idea kicked off.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" }, status: { type: "string", description: "optional status filter" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const status = str(args, "status");
      const { db } = await getAppContext();
      // Explicit projection (remediation §3.2): avoid a full-row deserialization
      // of productions (jsonb profile, numeric cols) as a failure vector.
      const rows = await db
        .select({
          id: productions.id,
          ideaId: productions.ideaId,
          status: productions.status,
          externalScript: productions.externalScript,
          failureReason: productions.failureReason,
          updatedAt: productions.updatedAt,
        })
        .from(productions)
        .where(eq(productions.channelId, channelId))
        .orderBy(desc(productions.createdAt))
        .limit(40);
      // #49 (ticket 01KY9E1S…): attach the booked spend per production so the join
      // back to cost is no longer manual. One grouped query over the channel's cost
      // records, mapped onto the rows we're returning.
      const costRows = await db
        .select({ productionId: costRecords.productionId, total: sql<string>`sum(${costRecords.costUsd})` })
        .from(costRecords)
        .where(and(eq(costRecords.channelId, channelId), isNotNull(costRecords.productionId)))
        .groupBy(costRecords.productionId);
      const costByProd = new Map(costRows.map((r) => [r.productionId, Number(Number(r.total).toFixed(4))]));
      return rows
        .filter((r) => !status || r.status === status)
        .map((r) => ({ ...r, costUsd: costByProd.get(r.id) ?? 0 }));
    },
  },
  {
    name: "get_production",
    description:
      "Read one production: status, its idea, a summary of the current script draft (hook, beat count, word count), a `shotPlan` projection (projectedShots, projectedMovingShots, unusedMotionPromptBeats — why 'I supplied 9 motion prompts and got 1 clip'), `clipFailures` (clips that failed or produced no usable output and fell back to a still), and `publication` (the live/scheduled video: url, providerVideoId, publishedAt, privacyStatus) so a published production is never mistaken for un-published when its status row is stale.",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const [prod] = await db.select().from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      const [idea] = await db.select().from(ideas).where(eq(ideas.id, prod.ideaId));
      const [draft] = await db.select().from(scriptDrafts).where(eq(scriptDrafts.productionId, productionId)).orderBy(desc(scriptDrafts.version)).limit(1);
      // Remediation §4.1: surface clip/animation failures (recorded as
      // retro_observation decisions whose detail.productionId matches) so a lost
      // shot / Ken-Burns fallback is visible, not silent.
      const issues = await db
        .select({ summary: channelDecisions.summary, detail: channelDecisions.detail, at: channelDecisions.createdAt })
        .from(channelDecisions)
        .where(and(eq(channelDecisions.kind, "retro_observation"), sql`${channelDecisions.detail}->>'productionId' = ${productionId}`))
        .orderBy(desc(channelDecisions.createdAt))
        .limit(20);
      // #28: project the shot + motion plan from the stored script so "83 shots,
      // 1 moved, 8 motionPrompts unused" is visible without opening the gate.
      // Resolved against the same profile the pipeline uses.
      let shotPlan: ReturnType<typeof projectShotPlan> | null = null;
      if (draft) {
        const [chan] = await db.select().from(channels).where(eq(channels.id, prod.channelId));
        const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, prod.channelId));
        const resolved = resolveProductionProfile(prod.productionProfile ?? dna?.productionProfile ?? null, {
          contentFormat: chan?.contentFormat,
        });
        const isLong = chan?.contentFormat === "long" || (dna?.targetLengthSec ?? 0) > 90;
        shotPlan = projectShotPlan(draft.beats as ScriptBeat[], resolved, {
          isLong,
          targetLengthSec: dna?.targetLengthSec ?? undefined,
        });
      }
      // #81: surface the publication so a stale status row (e.g. a production
      // left "on_hold" by a gate timeout that later published) is disambiguated in
      // the SAME tool that reports the status — a live `url`/`publishedAt` sitting
      // next to `status:"on_hold"` makes the contradiction visible instead of the
      // production reading as "nothing published". Prefer the live row, else the
      // most recent (a scheduled row exists before go-live).
      const pubRows = await db
        .select({
          id: publications.id,
          providerVideoId: publications.providerVideoId,
          url: publications.url,
          privacyStatus: publications.privacyStatus,
          publishedAt: publications.publishedAt,
          scheduledFor: publications.scheduledFor,
        })
        .from(publications)
        .where(eq(publications.productionId, productionId))
        .orderBy(desc(publications.publishedAt), desc(publications.createdAt));
      const pub = pubRows.find((p) => p.publishedAt) ?? pubRows[0] ?? null;
      return {
        id: prod.id,
        status: prod.status,
        externalScript: prod.externalScript,
        failureReason: prod.failureReason,
        idea: idea ? { id: idea.id, title: idea.title, angle: idea.angle } : null,
        script: draft ? { version: draft.version, hookText: draft.hookText, beatCount: (draft.beats as unknown[]).length, wordCount: draft.wordCount } : null,
        shotPlan,
        clipFailures: issues.map((r) => ({ summary: r.summary, at: r.at })),
        publication: pub
          ? {
              id: pub.id,
              providerVideoId: pub.providerVideoId,
              url: pub.url,
              privacyStatus: pub.privacyStatus,
              publishedAt: pub.publishedAt,
              scheduledFor: pub.scheduledFor,
              /** true when a live/scheduled publication exists but the production
               * row still reads terminal/blocked — a stale-status signal (#81). */
              statusMismatch:
                Boolean(pub.publishedAt) && ["on_hold", "failed", "rejected"].includes(prod.status),
            }
          : null,
      };
    },
  },
  {
    name: "get_production_shots",
    description:
      "List a production's SHOTS individually (ticket 01KY5W4T… / #30 item 6) — one entry per rendered image, so you can inspect the visuals gate over MCP and find a specific bad/duplicate shot to fix with regenerate_shot. Each: idx (the shot's image index — NOT the beat index; one beat can fan into up to 4 shots), narration (the spoken line the shot covers), source ('sourced' = a real photo/clip, 'generated' = model image), entity (the referenceEntity sourced), imagePrompt, engineRequested/engineServed (the image model asked-for vs used), heroShot, animated (has a motion clip), and imageUrl. Also returns outstandingDuplicateShots + duplicateRiskGroups (ticket 01KY6DCD…): STILL-SOURCED shots sharing a referenceEntity with another shot — a duplicate-image risk to fix with regenerate_shot BEFORE approving the visuals gate, since the per-shot fix window closes the moment the production advances past visuals_review. A shot already regenerated from an authored imagePrompt (source 'generated') is NOT counted — its entity is historical and no longer describes the image (#52). Also returns renderAspect (the aspect this video renders at) + per-shot aspect + aspectMismatchShots + shotsWithUnknownAspect (#50) so a wrongly-oriented shot is auditable over MCP; regenerate_shot takes an aspectRatio override to force one. Each shot also carries assetType (#65/#67): 'still' | 'generated_clip' (AI i2v) | 'sourced_clip' (real archival footage) — the `animated` boolean conflated the last two; a sourced_clip carries clipProvenance (source/entity/attribution). Top-level assetCounts gives the AI-vs-real split the publish AI-disclosure flag depends on, PLUS clipsBilledToVideoEngine + generatedClipLedgerMismatch (#67): assetType reads stored clip ROWS, so a generated_clip row that was never billed (a phantom/stale pipeline row) shows as a mismatch against the cost ledger — trust the ledger, not the row, when they disagree. NOTE: imageUrl is the STILL poster; for a sourced_clip the rendered asset is the clip, not this still.",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const [prod] = await db.select().from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      const [shotChannel] = await db.select().from(channels).where(eq(channels.id, prod.channelId));
      const [shotDna] = await db.select().from(channelDna).where(eq(channelDna.channelId, prod.channelId));
      // #50: the aspect this production renders at — the SAME derivation regenerate_shot
      // uses, so a shot regenerated now records an aspect that matches this exactly.
      const renderAspect = videoAspect({
        contentFormat: shotChannel?.contentFormat ?? "short",
        targetLengthSec: shotDna?.targetLengthSec,
        orientation: resolveProductionProfile(shotDna?.productionProfile ?? null).orientation,
      });
      const imgs = await db
        .select({ id: assets.id, idx: assets.idx, key: assets.storageKey, meta: assets.meta })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")))
        .orderBy(assets.idx);
      // #65/#67: read clip META, not just the idx set — a video_clip is either a
      // GENERATED (i2v/seedance) clip (meta.generated, no source) or a SOURCED archival
      // clip (meta.source/license/attribution). The old `animated` boolean conflated
      // them, and a sourced clip's provenance was stranded on this row (the shot read
      // source:'generated'/entity:null off the still). Surface both.
      const clipRows = await db
        .select({ idx: assets.idx, meta: assets.meta })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip")));
      const animatedIdx = new Set(clipRows.map((c) => c.idx));
      const clipByIdx = new Map(clipRows.map((c) => [c.idx, (c.meta ?? {}) as Record<string, unknown>]));
      const shots = imgs.map((im) => {
        const m = (im.meta ?? {}) as Record<string, unknown>;
        const clipMeta = clipByIdx.get(im.idx);
        // the true asset behind this shot: a still, a generated clip, or a sourced clip.
        const assetType: "still" | "generated_clip" | "sourced_clip" = !clipMeta
          ? "still"
          : imageSourceKind(clipMeta) === "sourced"
            ? "sourced_clip"
            : "generated_clip";
        // #65 provenance: when the rendered asset is a SOURCED clip, its origin lives on
        // the clip row — surface it so a real-footage shot is auditable, not null.
        const clipProvenance =
          assetType === "sourced_clip"
            ? {
                source: typeof clipMeta!.source === "string" ? clipMeta!.source : null,
                entity: typeof clipMeta!.entity === "string" ? clipMeta!.entity : null,
                attribution: typeof clipMeta!.attribution === "string" ? clipMeta!.attribution : null,
              }
            : null;
        return {
          idx: im.idx,
          narration: typeof m.narration === "string" ? m.narration : null,
          source: imageSourceKind(m),
          entity: typeof m.entity === "string" ? m.entity : null,
          imagePrompt: typeof m.prompt === "string" ? m.prompt : typeof m.draftPrompt === "string" ? m.draftPrompt : null,
          engineRequested: typeof m.engineRequested === "string" ? m.engineRequested : null,
          engineServed: typeof m.engineServed === "string" ? m.engineServed : null,
          heroShot: m.hero === true,
          animated: animatedIdx.has(im.idx),
          // #65/#67: what actually renders — still | generated_clip | sourced_clip.
          // `animated` stays for back-compat but assetType is the unambiguous field.
          assetType,
          ...(clipProvenance ? { clipProvenance } : {}),
          imageUrl: `/api/media/${im.key}`,
          // #50: the render aspect recorded when this image was generated/re-sourced.
          // null on shots produced before aspect recording landed — regenerate to stamp it.
          aspect: typeof m.aspect === "string" ? m.aspect : null,
        };
      });
      // #50: flag shots whose RECORDED aspect disagrees with the production's render
      // aspect (a genuine orientation mismatch), plus how many shots predate aspect
      // recording (aspect null) and so can't be verified without a regenerate.
      const aspectMismatchShots = shots.filter((s) => s.aspect && s.aspect !== renderAspect).map((s) => s.idx);
      const shotsWithUnknownAspect = shots.filter((s) => !s.aspect).length;
      // Duplicate-image RISK (ticket 01KY6DCD…): shots sharing a referenceEntity
      // with another shot draw the same source pool. Surface it so the operator
      // sees how many suspect shots remain BEFORE approving the visuals gate —
      // after approval regenerate_shot is gone and the fix window has closed.
      // #52 (ticket 01KY9ECS…): the risk is real only for shots STILL SOURCED under
      // that entity. regenerate_shot with an authored imagePrompt overwrites the
      // image with a distinct generated still but LEAVES the planning entity in
      // place — that entity is now historical and no longer describes the pixels,
      // so a regenerated (source 'generated') shot must NOT count as a duplicate.
      // Group on what actually produced the current image, not the superseded plan.
      const dupGroups = duplicateRiskGroups(
        shots.filter((s) => s.source === "sourced").map((s) => ({ idx: s.idx, entity: s.entity })),
      );
      const outstandingDuplicateShots = outstandingDuplicateShotCount(dupGroups);
      // #65: the AI-generated vs real-footage split, which is what the AI-disclosure
      // flag on publish depends on — a still and a generated clip are AI, a sourced
      // clip is real archival footage.
      // #67: reconcile the generated_clip ASSET rows against the cost ledger. Every
      // genuine generated clip bills one video-engine line; if there are MORE
      // generated_clip rows than billed clips, the extras are phantom/orphaned rows (a
      // stale pipeline re-entry that upserted a clip row without a billed generation) —
      // surface the discrepancy so the gate never asserts a clip that was never made.
      // (Operator on #67: the count read as fact must be checkable against billing.)
      const clipCostRows = await db
        .select({ lines: sql<number>`count(*)` })
        .from(costRecords)
        .where(
          and(
            eq(costRecords.productionId, productionId),
            eq(costRecords.category, "media"),
            inArray(costRecords.provider, [...VIDEO_ENGINES]),
          ),
        );
      const clipsBilledToVideoEngine = Number(clipCostRows[0]?.lines ?? 0);
      const generatedClips = shots.filter((s) => s.assetType === "generated_clip").length;
      const assetCounts = {
        stills: shots.filter((s) => s.assetType === "still").length,
        generatedClips,
        sourcedClips: shots.filter((s) => s.assetType === "sourced_clip").length,
        // billed video-engine clip lines (re-billed replacements inflate this) — the
        // ground truth to check generatedClips against.
        clipsBilledToVideoEngine,
        // true when the generated_clip asset rows and the billed-clip count disagree:
        // extra rows = phantom/stale clip rows; fewer = a clip was replaced/removed.
        generatedClipLedgerMismatch: generatedClips !== clipsBilledToVideoEngine,
      };
      return {
        productionId,
        status: prod.status,
        shotCount: shots.length,
        atVisualsGate: prod.status === "visuals_review",
        outstandingDuplicateShots,
        duplicateRiskGroups: dupGroups,
        // #65/#67: what actually renders per shot (assetType) + the AI-vs-real split.
        assetCounts,
        // #50: the aspect this video renders at, so a wrongly-oriented shot is
        // auditable over MCP. aspectMismatchShots = shots whose recorded aspect
        // disagrees; shotsWithUnknownAspect = shots generated before aspect
        // recording (regenerate one to stamp its aspect, or pass aspectRatio to
        // regenerate_shot to force it). Per-pixel width/height capture at every
        // generation site is a deferred follow-up (see get_deferred_work).
        renderAspect,
        aspectMismatchShots,
        shotsWithUnknownAspect,
        shots,
        note:
          prod.status === "visuals_review"
            ? `At the visuals gate — fix a specific shot with regenerate_shot(productionId, idx, {...}); it stays for your review.${outstandingDuplicateShots > 0 ? ` ${outstandingDuplicateShots} shot(s) across ${dupGroups.length} entity group(s) still share a referenceEntity (duplicate-image risk) — fix or accept them BEFORE approving the gate, as regenerate_shot is unavailable once the production advances.` : ""}`
            : `regenerate_shot only runs while the production is at the visuals gate (status visuals_review); this production is ${prod.status}, so the per-shot fix window has closed.${outstandingDuplicateShots > 0 ? ` ${outstandingDuplicateShots} shot(s) still share a referenceEntity — reopening the visuals gate for these is an operator action in the cockpit (a corrected copy re-bills the whole production).` : ""}`,
      };
    },
  },
  {
    name: "get_production_shot",
    description:
      "Read ONE shot by index (#66) — the cheap 'did shot N change?' check after a regenerate_shot that timed out at the connector, without pulling all N shots. Returns the same per-shot fields as get_production_shots (idx, narration, source, entity, imagePrompt, engineRequested/engineServed, heroShot, animated, assetType, clipProvenance, aspect, imageUrl), or found:false if there's no image at that idx.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        shotIndex: { type: "number", description: "the shot's image idx" },
      },
      required: ["productionId", "shotIndex"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const shotIndex = Number(args.shotIndex);
      if (!Number.isInteger(shotIndex) || shotIndex < 0) throw new Error("shotIndex must be a non-negative integer");
      const { db } = await getAppContext();
      const [im] = await db
        .select({ id: assets.id, idx: assets.idx, key: assets.storageKey, meta: assets.meta })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image"), eq(assets.idx, shotIndex)));
      if (!im) return { productionId, shotIndex, found: false as const, note: `No image shot at idx ${shotIndex} — call get_production_shots for valid indices.` };
      const [clip] = await db
        .select({ meta: assets.meta })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip"), eq(assets.idx, shotIndex)));
      const m = (im.meta ?? {}) as Record<string, unknown>;
      const clipMeta = clip ? ((clip.meta ?? {}) as Record<string, unknown>) : undefined;
      const assetType: "still" | "generated_clip" | "sourced_clip" = !clipMeta
        ? "still"
        : imageSourceKind(clipMeta) === "sourced"
          ? "sourced_clip"
          : "generated_clip";
      return {
        productionId,
        found: true as const,
        idx: im.idx,
        narration: typeof m.narration === "string" ? m.narration : null,
        source: imageSourceKind(m),
        entity: typeof m.entity === "string" ? m.entity : null,
        imagePrompt: typeof m.prompt === "string" ? m.prompt : typeof m.draftPrompt === "string" ? m.draftPrompt : null,
        engineRequested: typeof m.engineRequested === "string" ? m.engineRequested : null,
        engineServed: typeof m.engineServed === "string" ? m.engineServed : null,
        heroShot: m.hero === true,
        animated: Boolean(clipMeta),
        assetType,
        ...(assetType === "sourced_clip" && clipMeta
          ? { clipProvenance: { source: typeof clipMeta.source === "string" ? clipMeta.source : null, entity: typeof clipMeta.entity === "string" ? clipMeta.entity : null, attribution: typeof clipMeta.attribution === "string" ? clipMeta.attribution : null } }
          : {}),
        aspect: typeof m.aspect === "string" ? m.aspect : null,
        imageUrl: `/api/media/${im.key}`,
      };
    },
  },
  {
    name: "regenerate_shot",
    description:
      "Fix ONE shot at the visuals gate WITHOUT re-running the whole production or re-billing the other shots (ticket 01KY5W4T…) — the same action as the per-shot Regenerate/Re-source buttons in the cockpit. The production MUST be at the visuals gate (status visuals_review). Modes (inferred from what you pass): referenceEntity → RE-SOURCE a real photo (of that subject; dedupes against images already used); imagePrompt and/or imageEngine → REGENERATE the still (verbatim prompt, chosen model qwen/seedream/nano-banana); characterId → CAST a recurring character into the regenerated still (#70, composes with imagePrompt); nothing → regenerate the still with its existing prompt/engine (to reroll a bad generation). The shot's cost appends to the production's costs. The visuals gate stays OPEN for your review — regenerating NEVER auto-approves. For a published video, make a corrected copy instead.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        shotIndex: { type: "number", description: "the shot's image idx (from get_production_shots), not the beat index" },
        imagePrompt: { type: "string", description: "regenerate the still from this prompt (used verbatim)" },
        referenceEntity: { type: "string", description: "re-source a real photo of this subject instead of generating" },
        imageEngine: { type: "string", enum: ["qwen", "seedream", "nano-banana"], description: "image model for a regenerated still" },
        characterId: {
          type: "string",
          description:
            "#70: cast a recurring character (id from list_characters) into the regenerated still — the same per-image character injection as the cockpit. The character's canonical description leads the prompt and its reference sheet conditions the render (identity wins). Composes with imagePrompt: state the character's position/crop in the prompt. Ignored when re-sourcing (referenceEntity). The character must belong to this channel.",
        },
        aspectRatio: {
          type: "string",
          enum: ["16:9", "9:16", "1:1"],
          description:
            "#50: force the render aspect for THIS shot, overriding the production-derived orientation — the escape hatch for a shot that came back the wrong shape. Omit to use the production's own aspect (the default; generated stills already inherit it). The chosen aspect is recorded on the shot and reported by get_production_shots.",
        },
      },
      required: ["productionId", "shotIndex"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const shotIndex = Number(args.shotIndex);
      if (!Number.isInteger(shotIndex) || shotIndex < 0) throw new Error("shotIndex must be a non-negative integer");
      const imagePrompt = str(args, "imagePrompt");
      const referenceEntity = str(args, "referenceEntity");
      const imageEngine = str(args, "imageEngine") as "qwen" | "seedream" | "nano-banana" | undefined;
      const characterId = str(args, "characterId");
      const aspectRatio = str(args, "aspectRatio") as "16:9" | "9:16" | "1:1" | undefined;

      const { db } = await getAppContext();
      const [prod] = await db.select().from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      // Scoped to the visuals gate: the pending gate simply stays open (never
      // auto-approved), so there's no mid-flight pipeline resume to manage and human
      // approval remains mandatory. Any other status → refuse with guidance.
      if (prod.status !== "visuals_review") {
        const recovery =
          prod.status === "thumbnail_review"
            ? "It's at the final (thumbnail_review) gate — the per-shot fix window has closed. Reopening the visuals gate is an operator action in the cockpit (Revise visuals on the final gate); once reopened, regenerate_shot works again. Otherwise a corrected copy re-bills the whole production."
            : ["published", "scheduled"].includes(prod.status)
              ? "It's already published/scheduled — make a corrected copy to fix shots."
              : "Wait for it to reach the visuals gate, or in the cockpit retry from render.";
        throw new Error(
          `regenerate_shot only runs at the visuals gate (status visuals_review); this production is ${prod.status}. ${recovery}`,
        );
      }
      const [img] = await db
        .select({ id: assets.id, meta: assets.meta })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image"), eq(assets.idx, shotIndex)));
      if (!img) throw new Error(`No image shot at idx ${shotIndex} — call get_production_shots to see the valid indices`);

      // Re-source real footage (optionally of a NEW subject: point the shot's entity
      // at referenceEntity first, since the re-source reads it from the asset meta).
      const mode = regenShotMode({ referenceEntity, heroShot: (img.meta as Record<string, unknown> | null)?.hero === true });
      const opts: {
        prompt?: string;
        engine?: "qwen" | "seedream" | "nano-banana";
        aspectOverride?: "16:9" | "9:16" | "1:1";
        characterId?: string;
      } = {};
      // #50: an explicit aspectRatio forces this shot's orientation regardless of mode.
      if (aspectRatio) opts.aspectOverride = aspectRatio;
      if (mode === "real") {
        // point the shot's entity at the requested subject; the re-source reads it from meta
        const meta = { ...((img.meta ?? {}) as Record<string, unknown>), entity: referenceEntity };
        await db.update(assets).set({ meta }).where(eq(assets.id, img.id));
      } else {
        if (imagePrompt) opts.prompt = imagePrompt;
        if (imageEngine) opts.engine = imageEngine;
        // #70: cast a character into the regenerated still (identity-led, ref-sheet conditioned).
        if (characterId) opts.characterId = characterId;
      }

      const result = await swapShotImageAction(productionId, img.id, mode, opts);
      if (result.error) throw new Error(result.error);
      await logDecision(db, prod.channelId, `Regenerated shot ${shotIndex} (${mode}) via MCP`, {
        productionId,
        shotIndex,
        mode,
        ...(referenceEntity ? { referenceEntity } : {}),
        ...(imageEngine ? { imageEngine } : {}),
      });
      return {
        productionId,
        shotIndex,
        mode,
        imageUrl: result.storageKey ? `/api/media/${result.storageKey}` : null,
        clipRemoved: result.clipRemoved ?? false,
        // #50: the render aspect this shot was (re)generated at — recorded on the
        // shot and reported by get_production_shots so orientation is auditable.
        aspect: result.aspect ?? null,
        note: `Shot regenerated at aspect ${result.aspect ?? "(production default)"}; the visuals gate is still OPEN — review it in the cockpit and approve when satisfied (regenerating never auto-approves). The cost was appended to this production.`,
      };
    },
  },
  {
    name: "regenerate_thumbnail",
    description:
      "Render or SOURCE a NEW thumbnail candidate WITHOUT re-running the production (ticket 01KY6F1X…) — the MCP twin of the cockpit's thumbnail Regenerate button, and the counterpart to regenerate_shot for the thumbnail. Pass thumbnailPrompt (used VERBATIM; two variants rendered — your prompt + an alternative-composition twin) and/or referenceEntity (#74: SOURCE a real archival photo of that subject — the same archival/stock path regenerate_shot's re-source mode uses, vision-scored + auto-credited — for the one image that most needs a real photograph; up to 3 candidates, deduped against those already added) and/or referenceImages (#74 append: operator-supplied conditioning IMAGE url(s) — generate FROM your photo, so a specific hard-to-render subject like a 1950s airframe is factually correct; the photo conditions geometry/markings while thumbnailPrompt drives composition). Optionally imageEngine (qwen/seedream/nano-banana; default follows the channel's thumbnailImageEngine) and quality ('hero' for the premium model). Omit both prompt and referenceEntity to re-roll from the channel's thumbnail template/spec. #76: runs at thumbnail_review (candidates land on the open gate to pick) AND while scheduled/published/ready (candidates are added but NOT applied — use set_video_thumbnail to push a chosen one to the live/scheduled video). Cost appends; NEVER auto-approves or publishes. NOTE: set_publication_metadata only STORES thumbnailPrompt (it does not render); use THIS to actually generate/source the image.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        thumbnailPrompt: { type: "string", description: "thumbnail image prompt, used verbatim (two variants rendered). Omit to re-roll from the channel's thumbnail template/spec." },
        referenceEntity: { type: "string", description: "#74: SOURCE a real archival photo of this named subject (e.g. 'Convair YF-102A Delta Dagger') as a candidate instead of generating — auto-credited. Combine with thumbnailPrompt to also generate." },
        referenceImages: {
          type: "array",
          items: { type: "string" },
          description:
            "#74 (append): operator-supplied conditioning IMAGE url(s) — the generator works FROM the photo (airframe geometry/markings) while thumbnailPrompt drives composition/lighting/caption. Use when text-to-image can't render a specific subject (e.g. a 1950s airframe): you pick the correct photograph, so factual fidelity is your call. First url is the primary reference; extras give more angles. Pass a fetchable https URL. Best paired with a verbatim thumbnailPrompt (which skips the channel imageStyle that could fight the reference).",
        },
        imageEngine: { type: "string", enum: ["qwen", "seedream", "nano-banana"], description: "image model; default follows the channel's thumbnailImageEngine profile axis" },
        quality: { type: "string", enum: ["standard", "hero"], description: "'hero' uses the premium image model/quality; default standard" },
      },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const thumbnailPrompt = str(args, "thumbnailPrompt");
      const referenceEntity = str(args, "referenceEntity");
      const imageEngine = str(args, "imageEngine") as "qwen" | "seedream" | "nano-banana" | undefined;
      const quality = str(args, "quality") === "hero" ? "hero" : "standard";

      const { db } = await getAppContext();
      const [prod] = await db.select().from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      // #76: the thumbnail is no longer frozen at gate approval. Allowed at
      // thumbnail_review (candidates land on the OPEN gate) and afterwards while
      // the video is still uploaded — scheduled/published/ready — where the video
      // is typically private for hours. Adding a candidate never auto-applies or
      // publishes; a scheduled/published video needs an explicit set_video_thumbnail
      // to push the chosen image to YouTube. Earlier stages still can't (no thumbnail yet).
      const THUMB_OK = new Set(["thumbnail_review", "ready", "scheduled", "published"]);
      if (!THUMB_OK.has(prod.status)) {
        throw new Error(
          `regenerate_thumbnail runs at the final gate (thumbnail_review) or after (ready/scheduled/published); this production is ${prod.status}, before a thumbnail exists — let the pipeline reach thumbnail_review first.`,
        );
      }

      const referenceImages = Array.isArray(args.referenceImages)
        ? args.referenceImages.filter((u): u is string => typeof u === "string" && u.trim().length > 0)
        : [];
      const result = await regenerateThumbnailsAction(productionId, {
        ...(thumbnailPrompt ? { prompt: thumbnailPrompt } : {}),
        ...(referenceEntity ? { referenceEntity } : {}),
        ...(referenceImages.length ? { referenceImages } : {}),
        model: quality,
        ...(imageEngine ? { engine: imageEngine } : {}),
      });
      if (result.error) throw new Error(result.error);
      await logDecision(db, prod.channelId, `Regenerated thumbnail via MCP`, {
        productionId,
        added: result.added ?? 0,
        ...(result.sourced ? { sourced: result.sourced } : {}),
        ...(thumbnailPrompt ? { authoredPrompt: true } : {}),
        ...(referenceEntity ? { referenceEntity } : {}),
        ...(imageEngine ? { imageEngine } : {}),
        quality,
      });
      const postGate = prod.status !== "thumbnail_review";
      return {
        productionId,
        added: result.added ?? 0,
        ...(result.sourced ? { sourced: result.sourced } : {}),
        note: postGate
          ? `New candidate(s) added, but this production is ${prod.status} (past the gate) — nothing was applied. Review the candidates in the cockpit, then call set_video_thumbnail(productionId, thumbnailId) to push the chosen one to the ${prod.status === "published" ? "live" : "scheduled"} video on YouTube. Cost appended; nothing auto-published.`
          : "New thumbnail candidate(s) added; the final (thumbnail_review) gate is still OPEN — review the options in the cockpit and approve the one you want (regenerating never auto-approves or publishes). The cost was appended to this production.",
      };
    },
  },
  {
    name: "author_script",
    description:
      "Author a full video script DIRECTLY and run it through the production pipeline — no platform scripting LLM. Provide the hook and the beats (each: type hook/stat/insight/cta, spoken text, optional imagePrompt/referenceEntity/visualBrief/heroShot). Optionally set a per-video productionProfile (skips the profile-proposal LLM). The human script gate is skipped (you wrote it); the anti-clone check + review board still run, then voiceover → images → render → publish. Provide either ideaId (existing idea) or ideaTitle+ideaAngle to mint one. RETURNS a `shotPlan` projection (deterministic, computed up front): projectedShots (how many shots the pipeline WILL cut — match your distinct-brief count to it or the same subject re-queries one photo pool), projectedMovingShots, unusedMotionPromptBeats (beats whose motionPrompt is ignored because the shot won't move), and per-beat detail — the numbers that were previously only visible at the visuals gate.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        ideaId: { type: "string", description: "author against this existing idea (from list_ideas) — OR a series EPISODE id from list_series (#86: resolved to the episode's backing idea, minting + linking one if the episode isn't queued yet, so the arc episode reconciles to published). Else provide ideaTitle+ideaAngle." },
        ideaTitle: { type: "string" },
        ideaAngle: { type: "string" },
        hookText: { type: "string", description: "the spoken first 1-2 seconds" },
        beats: {
          type: "array",
          description: "the script beats in order",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["hook", "stat", "insight", "cta", "rehook"], description: "rehook = a mid-video beat that re-grabs attention; use it to break a long exposition run (matches review_beat_map's flat-run check)." },
              text: { type: "string", description: "spoken narration for this beat" },
              imagePrompt: { type: "string", description: "image-generation prompt. Provide a FULL prompt to own it — for an authored production a complete prompt (>=20 chars) is used VERBATIM and the builder LLM is skipped; leave it thin/empty and the platform elaborates one from the beat." },
              imagePrompts: {
                type: "array",
                items: { type: "string" },
                description:
                  "#69: optional ORDERED list of per-shot GENERATED image prompts, consumed across the shots this ONE beat is cut into (shot i → imagePrompts[i], falling back to imagePrompt). The generative twin of referenceEntities: when a beat fans into N GENERATED shots, supply N distinct prompts so it doesn't render the same prompt N times (two takes of one diagram read as an error). Use for generated channels; use referenceEntities for sourced/real ones.",
              },
              referenceEntity: { type: "string", description: "optional: a named real subject to source a real photo of (e.g. 'Supermarine Spitfire')" },
              referenceEntities: {
                type: "array",
                items: { type: "string" },
                description:
                  "#69: optional ORDERED list of real subjects, consumed across the shots this ONE beat is cut into (shot i → referenceEntities[i], falling back to referenceEntity). Supply N distinct briefs for a beat that fans into N shots WITHOUT adding beats — the fix for an artwork/still-image channel where the shot count exceeds the beat count. Check review_beat_map's entityCoverage.",
              },
              visualBrief: { type: "string", description: "optional: the concrete visual ask for this beat, never echoing the narration" },
              heroShot: { type: "boolean", description: "true only on the 2-4 pivotal beats (premium image model)" },
              quoteCard: {
                type: "object",
                description:
                  "#72: render THIS beat as a typeset QUOTE CARD (centred text on a plain near-black ground) instead of an image — the section-boundary device (a quote, a verse ref). Held for the beat's spoken duration.",
                properties: {
                  text: { type: "string", description: "the quote/line to typeset" },
                  attribution: { type: "string", description: "optional source line (e.g. 'John 8:32')" },
                },
                required: ["text"],
                additionalProperties: false,
              },
              motionPrompt: { type: "string", description: "optional image-to-video motion prompt (subject action + camera move, no on-screen text) — used verbatim if this beat animates, skipping the platform's vision LLM. Only matters when the channel's motion axis animates shots." },
              animates: { type: "boolean", description: "under motion 'ai_video', prioritise THIS beat for a clip so movement lands where you want it (supplying a motionPrompt implies this). The clip budget is distributed across your marked beats." },
            },
            required: ["type", "text"],
            additionalProperties: false,
          },
        },
        substanceFingerprint: { type: "string", description: "optional 'topic | hook | facts' string for the anti-clone check; auto-derived if omitted" },
        productionProfile: { type: "object", description: "optional per-video Production Profile axes (visualMode, motion, rhythm, captions, music, delivery, engines, etc.)" },
        title: { type: "string", description: "authored video title (overrides the auto title from the idea)" },
        description: { type: "string", description: "authored YouTube description — image credits + the AI-disclosure line are still appended" },
        tags: { type: "array", items: { type: "string" }, description: "authored tags (overrides the auto ones)" },
        thumbnailPrompt: { type: "string", description: "authored thumbnail image prompt — used verbatim as the top candidate" },
      },
      required: ["channelId", "hookText", "beats"],
      additionalProperties: false,
    },
    execute: async (args) =>
      authorProduction({
        channelId: requireStr(args, "channelId"),
        ideaId: str(args, "ideaId"),
        ideaTitle: str(args, "ideaTitle"),
        ideaAngle: str(args, "ideaAngle"),
        hookText: requireStr(args, "hookText"),
        beats: (args.beats as AuthoredBeat[]) ?? [],
        substanceFingerprint: str(args, "substanceFingerprint"),
        productionProfile: (args.productionProfile as Record<string, unknown>) ?? undefined,
        title: str(args, "title"),
        description: str(args, "description"),
        tags: Array.isArray(args.tags) ? (args.tags as unknown[]).filter((t): t is string => typeof t === "string") : undefined,
        thumbnailPrompt: str(args, "thumbnailPrompt"),
      }),
  },
  {
    name: "set_publication_metadata",
    description:
      "Set a production's PUBLISHED packaging: title, description, tags, and/or thumbnailPrompt. Overrides the auto-generated values (image credits + the AI-disclosure line are still appended to the description). Locked once the video is published/scheduled — make a corrected copy after that. Packaging is the main discovery lever, so use this to control it. IMPORTANT — thumbnailPrompt: this only STORES the prompt string; it does NOT render an image. The thumbnail image is generated BEFORE the thumbnail_review (final) gate opens, so setting thumbnailPrompt once the production is at that gate is a no-op for the image (the response says so). To actually render a thumbnail from a prompt at the final gate, use regenerate_thumbnail. Setting thumbnailPrompt EARLIER (before thumbnails are generated) does feed thumbnail generation.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        thumbnailPrompt: { type: "string" },
      },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) =>
      setPublicationMetadata({
        productionId: requireStr(args, "productionId"),
        title: str(args, "title"),
        description: str(args, "description"),
        tags: Array.isArray(args.tags) ? (args.tags as unknown[]).filter((t): t is string => typeof t === "string") : undefined,
        thumbnailPrompt: str(args, "thumbnailPrompt"),
      }),
  },
  {
    name: "set_channel_config",
    description:
      "Set channel options DIRECTLY (no wizard/planner LLM). Patch any of: autonomy tier; contentFormat (long/short/both — #51, the channel-level format that drives render orientation/aspect + shot planner + scriptwriter; per-video orientation is productionProfile.orientation); DNA (tone, audiencePersona, hookStyles, forbiddenTopics, ctaTemplate, voiceId, targetLengthSec, cadencePerWeek, titleTemplates — named title families for review_slate's drift check; imageStyle — the channel HOUSE IMAGE STYLE that steers every generated image, characters and scenes, the chat lever for a non-photoreal channel; lengthPolicy — content-driven runtime band {floorSec hard, ceilingSec soft, bands, principle}, partial-merged, with targetLengthSec staying the soft anchor); the Production Profile (partial — merged over the stored one); charter mission/objectives/verificationBar (verificationBar is partial-merged — patch establishedMinSources/presentDebateMode/minFactsToScript/factualityMode to fix charter drift on the compliance bar). Only provided fields change. Array fields (hookStyles/forbiddenTopics/…) are stored VERBATIM — commas inside an entry are kept, so a multi-clause hook style is one entry. The response echoes `stored` with the written array fields so you can confirm the value without a separate get_channel_config.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        autonomyTier: { type: "number", description: "0 manual … 3 exception-only" },
        contentFormat: {
          type: "string",
          enum: ["long", "short", "both"],
          description:
            "the channel content format (#51). NOT just a label — it drives the render orientation/aspect (16:9 vs 9:16), the shot planner and the scriptwriter. 'both' pairs long-form with short-form discovery. Per-VIDEO orientation is a separate axis (productionProfile.orientation); contentFormat is the channel-level default.",
        },
        madeForKids: {
          type: ["boolean", "null"],
          description:
            "YouTube Made-for-Kids (COPPA) self-designation (#53). true = MFK, false = not MFK, null = undeclared. Load-bearing, not a label: the publish path sends it to YouTube as selfDeclaredMadeForKids, and MFK DISABLES comments, end screens/cards, the notification bell and save-to-playlist (ads become contextual-only). Set it on any channel aimed at under-13s; get_channel_config.consistencyWarnings then flags charter objectives that depend on now-disabled features (end-cards, comment CTAs).",
        },
        ideationPaused: {
          type: "boolean",
          description:
            "Pause automatic ideation for this channel (#68). When true, the daily trend-scan/ideation cron SKIPS this channel — no auto-generated ideas land in the backlog while you establish its format. Manual write_idea/seed_idea and series planning are unaffected. Set false to resume.",
        },
        dna: {
          type: "object",
          properties: {
            tone: { type: "string" },
            audiencePersona: { type: "string" },
            hookStyles: { type: "array", items: { type: "string" } },
            forbiddenTopics: { type: "array", items: { type: "string" } },
            ctaTemplate: { type: "string" },
            voiceId: { type: "string" },
            targetLengthSec: { type: "number", description: "target video length in seconds (e.g. 1800 for 30 min)" },
            cadencePerWeek: { type: "number" },
            titleTemplates: {
              type: "array",
              description: "named title families so review_slate can flag title-format drift; each: name + pattern (+ optional example)",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  pattern: { type: "string", description: "the format, e.g. 'claim about the text, then a withheld payoff'" },
                  example: { type: "string" },
                },
                required: ["name", "pattern"],
                additionalProperties: false,
              },
            },
            searchTerms: {
              type: "array",
              items: { type: "string" },
              description: "the terms your audience actually searches (e.g. 'Book of Enoch', 'Qumran') — review_slate's keyword-position check uses these, NOT the niche description",
            },
            imageStyle: {
              type: "string",
              description: "the channel's HOUSE IMAGE STYLE — a plain-language render register (e.g. 'bold graphic illustration, painted graphic-novel look, NOT photographic') that steers EVERY generated image, characters and scenes alike. This is the chat lever for a non-photoreal channel. NOTE: if the channel has an active distilled Style-tab style (built from uploaded examples), THAT wins for the render and this string is the fallback used when there is none. Character briefs should carry identity only — set the look here, not in the brief.",
            },
            lengthPolicy: {
              type: "object",
              description: "content-driven runtime band (#39; partial-merged over the resolved policy). targetLengthSec stays the soft anchor.",
              properties: {
                floorSec: { type: "number", description: "HARD floor — below it the channel loses YouTube mid-rolls (default 480 = 8 min)" },
                ceilingSec: { type: "number", description: "soft ceiling (advisory; default 2400)" },
                bands: {
                  type: "array",
                  description: "named advisory runtime targets the beat map picks from",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      minSec: { type: "number" },
                      maxSec: { type: "number" },
                    },
                    required: ["name", "minSec", "maxSec"],
                    additionalProperties: false,
                  },
                },
                principle: { type: "string", description: "the operating principle surfaced to the author" },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        productionProfile: { type: "object", description: "partial Production Profile axes, merged over the stored profile" },
        charter: {
          type: "object",
          properties: {
            mission: { type: "string" },
            objectives: { type: "array", items: { type: "string" } },
            verificationBar: {
              type: "object",
              description: "partial — patch to fix charter drift on the compliance bar; unset fields are kept",
              properties: {
                establishedMinSources: { type: "number", description: "1-5: independent sources an established fact needs" },
                presentDebateMode: { type: "boolean", description: "contested history: state mainstream + attribute the alternative" },
                minFactsToScript: { type: "number", description: "1-20: min verified facts before an episode may be scripted" },
                factualityMode: { type: "string", enum: ["strict", "balanced", "entertainment"] },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) =>
      setChannelConfig({
        channelId: requireStr(args, "channelId"),
        autonomyTier: typeof args.autonomyTier === "number" ? args.autonomyTier : undefined,
        contentFormat: (str(args, "contentFormat") as "long" | "short" | "both" | undefined) ?? undefined,
        // #53: distinguish "not passed" (undefined → no change) from an explicit
        // true/false/null (null clears the designation back to undeclared).
        madeForKids: "madeForKids" in args ? (args.madeForKids as boolean | null) : undefined,
        // #68: pause/resume automatic ideation.
        ideationPaused: typeof args.ideationPaused === "boolean" ? args.ideationPaused : undefined,
        dna: (args.dna as SetChannelConfigDna) ?? undefined,
        productionProfile: (args.productionProfile as Record<string, unknown>) ?? undefined,
        charter: (args.charter as {
          mission?: string;
          objectives?: string[];
          verificationBar?: {
            establishedMinSources?: number;
            presentDebateMode?: boolean;
            minFactsToScript?: number;
            factualityMode?: "strict" | "balanced" | "entertainment";
          };
        }) ?? undefined,
      }),
  },
  // ── Recurring characters ──────────────────────────────────────────────────
  {
    name: "list_characters",
    description:
      "List the recurring on-screen characters on a channel (e.g. a teacher, a mascot, or two co-hosts). Each has a canonical appearance the pipeline injects into shots for visual consistency across every video. Returns id, name, brief, canonical description, role, castMode, castTarget, and enabled. A channel can have MANY characters and the pipeline can cast several onto the same video (see castMode). Start here to get characterIds for set_character_cast / refine_character / delete_character.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const characters = await listChannelCharacters(requireStr(args, "channelId"));
      return {
        characters: characters.map((c) => ({
          id: c.id,
          name: c.name,
          brief: c.brief,
          description: c.description,
          role: c.role,
          castMode: c.castMode,
          castTarget: c.castTarget,
          enabled: c.enabled,
        })),
      };
    },
  },
  {
    name: "create_character",
    description:
      "Create a recurring on-screen character for a channel from a plain-language brief (e.g. 'a warm 40s physics teacher with round glasses and a cardigan'). An LLM distills the brief into a canonical appearance paragraph and Nano Banana renders a reference sheet in the channel's active visual style; both are then injected into generated shots so the character looks the same in every video. IMPORTANT — the brief describes physical IDENTITY only (age, build, hair, skin, face, signature clothing, palette); do NOT specify render medium/register (photoreal, painterly, animation), pose, camera/crop (portrait, full-body), background, or scale. The channel's active visual style (the Style tab) supplies the LOOK and each scene supplies the framing, so the same character can appear human-sized, god-size, or mid-action without being locked into a photoreal portrait. To change the look, change the channel style, not the brief. Add several characters to a channel for a multi-host show. `castMode` sets how often the pipeline FORCES the character on-screen: 'auto' (default — the scene-builder decides per scene), 'off' (never), 'smart' (~castTarget% of shots, importance-ranked), fixed '25'/'50'/'75', or 'always' (every generated shot; a mascot). With several forcing characters the pipeline gives each its own share without double-booking a shot. NOTE: image generation runs synchronously, so this call takes a few seconds.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        name: { type: "string", description: "the character's name, e.g. 'Dr Atom' — used to cast them into scenes by name" },
        brief: {
          type: "string",
          description: "a plain-language creative brief of who they are and their physical appearance (age, build, hair, skin, face, signature clothing, palette); the LLM distils this into the canonical identity paragraph. Identity only — the render medium/style comes from the channel's visual style, and pose/scale/setting from each scene, so leave those out.",
        },
        role: {
          type: "string",
          description: "'main' (default) is the channel's lead presenter and is filled first when two characters want the same shot; anything else (e.g. 'support', 'co-host') is a secondary character",
        },
        castMode: {
          type: "string",
          enum: [...CHARACTER_CAST_MODES],
          description: "how often to force the character on-screen (default 'auto' = builder discretion). 'smart'/'25'/'50'/'75'/'always' force presence; 'off' disables casting.",
        },
        castTarget: {
          type: "number",
          description: "for castMode 'smart' only: target share (0-100) of shots the character lands on, importance-ranked (default 55). Ignored for the fixed buckets.",
        },
        imageEngine: {
          type: "string",
          enum: ["nano-banana", "qwen", "seedream"],
          description: "which image model renders the reference sheet. Omitted → the channel's Production Profile characterImageEngine (Nano Banana unless set). Nano Banana conditions on the existing sheet, so it holds the same face best on a later refine_character.",
        },
      },
      required: ["channelId", "name", "brief"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const created = await createChannelCharacter(
        channelId,
        {
          name: requireStr(args, "name"),
          brief: requireStr(args, "brief"),
          role: str(args, "role"),
          castMode: str(args, "castMode"),
          castTarget: typeof args.castTarget === "number" ? args.castTarget : undefined,
          imageEngine: asCharacterEngine(str(args, "imageEngine")),
        },
        { via: "mcp" },
      );
      return {
        id: created.id,
        name: created.name,
        description: created.description,
        role: created.role,
        castMode: created.castMode,
        castTarget: created.castTarget,
        enabled: created.enabled,
        note: "Reference sheet generated. Use refine_character to iterate on the look, or set_character_cast to change how often it appears.",
      };
    },
  },
  {
    name: "set_character_cast",
    description:
      "Change how often a character appears and whether it is active, WITHOUT re-rendering its look. Patch any of: castMode (off/auto/smart/25/50/75/always), castTarget (0-100, the share for castMode 'smart'), enabled (false removes the character from the pipeline entirely without deleting it). Only provided fields change. Use this to stand up a two-host show (give each host castMode '50'), quiet a mascot down, or temporarily bench a character.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        characterId: { type: "string", description: "from list_characters" },
        castMode: { type: "string", enum: [...CHARACTER_CAST_MODES] },
        castTarget: { type: "number", description: "0-100; the share for castMode 'smart'" },
        enabled: { type: "boolean", description: "false benches the character (kept, but never cast); true re-activates it" },
      },
      required: ["channelId", "characterId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const updated = await setChannelCharacterCast(
        requireStr(args, "channelId"),
        requireStr(args, "characterId"),
        {
          castMode: str(args, "castMode"),
          castTarget: typeof args.castTarget === "number" ? args.castTarget : undefined,
          enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
        },
        { via: "mcp" },
      );
      return { id: updated.id, name: updated.name, castMode: updated.castMode, castTarget: updated.castTarget, enabled: updated.enabled };
    },
  },
  {
    name: "refine_character",
    description:
      "Revise a character's look with a plain-language change (e.g. 'give her shorter hair and a red scarf'). The sheet agent applies the comment to the canonical description — keeping every unmentioned detail verbatim — and Nano Banana reworks the CURRENT reference image toward the new look, so the same face/identity is preserved. This RE-RENDERS the reference sheet (takes a few seconds) and updates the canonical description used in all future videos.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        characterId: { type: "string", description: "from list_characters" },
        comments: { type: "string", description: "the change to apply to the look" },
        imageEngine: {
          type: "string",
          enum: ["nano-banana", "qwen", "seedream"],
          description: "which image model renders the reference sheet. Omitted → the channel's Production Profile characterImageEngine (Nano Banana unless set). Nano Banana conditions on the existing sheet, so it holds the same face best on a later refine_character.",
        },
      },
      required: ["channelId", "characterId", "comments"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const res = await refineChannelCharacter(
        requireStr(args, "channelId"),
        requireStr(args, "characterId"),
        requireStr(args, "comments"),
        { via: "mcp", imageEngine: asCharacterEngine(str(args, "imageEngine")) },
      );
      return { description: res.description, note: "Reference sheet re-rendered and canonical description updated." };
    },
  },
  {
    name: "delete_character",
    description:
      "Permanently remove a character from a channel. Its reference-sheet image bytes stay in the store (past productions may still cite them), but the character is no longer cast into any future video. To keep the character but stop casting it, prefer set_character_cast with enabled:false.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        characterId: { type: "string", description: "from list_characters" },
      },
      required: ["channelId", "characterId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      await deleteChannelCharacter(requireStr(args, "channelId"), requireStr(args, "characterId"));
      return { ok: true };
    },
  },
  {
    name: "generate_test_scene",
    description:
      "Render a THROWAWAY test scene for a channel — the fastest way to see what the channel's look and its characters actually produce BEFORE authoring a video (2026-07-25 operator ask). Write the scene in plain language and optionally CAST ANY NUMBER of characters into it via characterIds: every cast character's canonical description is injected AND its reference sheet is fed to the model as an image reference, so you can check they hold distinct identities together in one frame. Does NOT require a distilled style — it renders against the channel's active/newest distilled style if there is one, else the plain house imageStyle, else no style at all. Returns the image URL plus exactly what steered it (style used, cast, engine). Costs one hero image; it is NOT part of any production and never publishes. Use list_test_scenes to see previous ones and refine_test_scene to iterate on one.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        scene: {
          type: "string",
          description: "the scene to render, in plain language — lead with the action/subject, e.g. 'a robed scribe copying by lamplight in a vast stone hall, seen from behind'",
        },
        characterIds: {
          type: "array",
          items: { type: "string" },
          description: "characters to cast into the scene (from list_characters). Any number — each one's reference sheet is fed to the model so identities stay distinct. Omit for a scene with no characters.",
        },
        styleId: {
          type: "string",
          description: "pin a specific distilled style version to test. Omitted → the channel's active style, else its newest draft, else the house style.",
        },
        imageEngine: {
          type: "string",
          enum: ["nano-banana", "qwen", "seedream"],
          description: "image model. Omitted → the channel's heroImageEngine (Nano Banana unless set).",
        },
      },
      required: ["channelId", "scene"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const res = await generateStyleTestScene(requireStr(args, "channelId"), {
        scene: requireStr(args, "scene"),
        characterIds: Array.isArray(args.characterIds) ? (args.characterIds as string[]) : [],
        styleId: str(args, "styleId") ?? null,
        imageEngine: str(args, "imageEngine") ?? null,
      });
      return {
        ...res,
        note: "Test scene only — not part of any production. Promote a keeper into the example pool from the cockpit Style tab so the next distill learns from it.",
      };
    },
  },
  {
    name: "list_test_scenes",
    description:
      "List a channel's rendered test scenes, newest first: the scene ask, the image URL, which characters were cast, which distilled style version it used (null = house style or none), and any refine comments. Use it to review what a look/cast actually produced before authoring.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => ({ scenes: await listStyleTestScenes(requireStr(args, "channelId")) }),
  },
  {
    name: "refine_test_scene",
    description:
      "Rework an existing test scene from plain-language comments — its CURRENT image rides as the edit reference, so the scene stays recognisably the same while your changes apply (e.g. 'pull the camera back and add a second figure at the door'). Costs one hero image. Get sceneId from list_test_scenes or generate_test_scene.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        sceneId: { type: "string", description: "from list_test_scenes / generate_test_scene" },
        comments: { type: "string", description: "the changes to apply" },
      },
      required: ["channelId", "sceneId", "comments"],
      additionalProperties: false,
    },
    execute: async (args) =>
      refineStyleTestScene(
        requireStr(args, "channelId"),
        requireStr(args, "sceneId"),
        requireStr(args, "comments"),
      ),
  },
  {
    name: "generate_brand_art",
    description:
      "Generate (or refine) a channel's LOGO or BANNER — the cockpit's Branding generator, opened to chat (2026-07-25 operator ask). Two ways to drive it: (a) pass `prompt` and it is used VERBATIM — nothing is prepended, no channel preamble, no style block, no character description, exactly what you write goes to the image model; or (b) omit `prompt` and the platform COMPOSES one from the channel name/niche plus your options (includeName, tagline, background, alignStyle, extra). Set mode:'refine' with `changes` (or a verbatim `prompt`) to edit the CURRENT art in place instead of starting fresh. Reference IMAGES can ride along in both cases: characterId features a character sheet in the art, sceneId conditions on a test scene's palette/mood, useCurrent reworks the existing art. The result is applied to the channel immediately (old versions are kept — revert in the cockpit) and the exact prompt is written to the decision ledger. Renders on the hero model; returns the image URL and the prompt actually used. Reading assets back: get_channel_branding. NOTE: applying a banner to YouTube is a separate cockpit action, and YouTube has no avatar API (that upload stays manual).",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        surface: { type: "string", enum: ["logo", "banner"], description: "logo = 1:1 avatar art; banner = 16:9 channel art" },
        prompt: {
          type: "string",
          description: "an AUTHORED prompt used VERBATIM — replaces the composed template entirely. Omit to let the platform compose one from the options below.",
        },
        mode: { type: "string", enum: ["generate", "refine"], description: "'refine' edits the CURRENT art in place (needs `changes` or a verbatim `prompt`); default 'generate'" },
        changes: { type: "string", description: "refine mode: what to change, e.g. 'make the pendulum brass and thicken the outline'" },
        includeName: { type: "boolean", description: "composed mode: render the channel name as typography in the art (default off — text in art is easy to garble)" },
        tagline: { type: "string", description: "composed mode: a short supporting typography line (also remembered on the channel DNA)" },
        background: { type: "string", enum: ["clear", "styled", "keep"], description: "composed mode: flat solid background vs a rich styled scene; 'keep' (refine) leaves it alone" },
        alignStyle: { type: "boolean", description: "composed mode: tie the art to the channel's active distilled style guide (default true when one exists)" },
        extra: { type: "string", description: "composed mode: a short extra direction appended to the composed prompt" },
        characterId: { type: "string", description: "feature this character IN the art as ONE element (never the whole image) — from list_characters" },
        sceneId: { type: "string", description: "condition on a style test scene's image for palette/mood — from list_test_scenes" },
        useCurrent: { type: "boolean", description: "condition on the CURRENT logo/banner (rework, keeping its composition)" },
      },
      required: ["channelId", "surface"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const surface = requireStr(args, "surface");
      if (surface !== "logo" && surface !== "banner") throw new Error("surface must be 'logo' or 'banner'");
      const opts = {
        ...(str(args, "prompt") ? { prompt: str(args, "prompt") } : {}),
        ...(str(args, "mode") === "refine" ? { mode: "refine" as const } : {}),
        ...(str(args, "changes") ? { changes: str(args, "changes") } : {}),
        ...(typeof args.includeName === "boolean" ? { includeName: args.includeName } : {}),
        ...(str(args, "tagline") ? { tagline: str(args, "tagline") } : {}),
        ...(str(args, "background") ? { background: str(args, "background") as "clear" | "styled" | "keep" } : {}),
        ...(typeof args.alignStyle === "boolean" ? { alignStyle: args.alignStyle } : {}),
        ...(str(args, "extra") ? { extra: str(args, "extra") } : {}),
        ...(str(args, "characterId") ? { characterId: str(args, "characterId") } : {}),
        ...(str(args, "sceneId") ? { sceneId: str(args, "sceneId") } : {}),
        ...(args.useCurrent === true ? { useCurrent: true } : {}),
      };
      const res =
        surface === "logo"
          ? await generateChannelLogoAction(channelId, opts)
          : await generateChannelBannerAssetAction(channelId, opts);
      if ("error" in res) throw new Error(res.error);
      return {
        surface,
        url: res.url,
        promptUsed: res.prompt,
        verbatim: Boolean(str(args, "prompt")),
        note:
          surface === "banner"
            ? "Applied to the channel. Pushing the banner to YouTube is a separate cockpit action."
            : "Applied to the channel. YouTube has no avatar API — uploading the avatar stays a manual step.",
      };
    },
  },
  {
    name: "create_series",
    description:
      "Author a story arc (series) and its episodes DIRECTLY — no editorial-planner LLM. The arc is created active by default (skips the proposed→approve step). Each episode is title + angle. Episodes then flow into research/production as normal.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        episodes: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, angle: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
        status: { type: "string", enum: ["active", "proposed"], description: "default active" },
      },
      required: ["channelId", "title", "episodes"],
      additionalProperties: false,
    },
    execute: async (args) =>
      createSeriesDirect({
        channelId: requireStr(args, "channelId"),
        title: requireStr(args, "title"),
        description: str(args, "description") ?? "",
        episodes: (args.episodes as { title: string; angle: string }[]) ?? [],
        status: args.status === "proposed" ? "proposed" : "active",
      }),
  },
  {
    name: "update_series",
    description:
      "Mutate an existing story arc (#59) — the planning surface used to be write-once. Rename (title), re-describe (description), change status (proposed | active | completed | archived — so a proposed arc can finally be promoted to active instead of re-creating it), and/or reorder its episodes (episodeOrder = every episode id in the arc, exactly once, in the new order). Only provided fields change. Read the arc + its episode ids with list_series first.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        seriesId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["proposed", "active", "completed", "archived"] },
        episodeOrder: {
          type: "array",
          items: { type: "string" },
          description: "the full set of the arc's episode ids in the new order (all of them, exactly once)",
        },
      },
      required: ["channelId", "seriesId"],
      additionalProperties: false,
    },
    execute: async (args) =>
      updateSeries({
        channelId: requireStr(args, "channelId"),
        seriesId: requireStr(args, "seriesId"),
        title: str(args, "title"),
        description: str(args, "description"),
        status: str(args, "status") as "proposed" | "active" | "completed" | "archived" | undefined,
        episodeOrder: Array.isArray(args.episodeOrder) ? (args.episodeOrder as string[]) : undefined,
      }),
  },
  {
    name: "set_episode_status",
    description:
      "Set ONE episode's status (#59): planned | researching | verifying | briefed | queued | produced | published | cut. Use it to drop an episode from an arc (cut) or move it back to planned/queued — previously an episode could only advance by authoring a script against it. Get episode ids from list_series.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        episodeId: { type: "string" },
        status: {
          type: "string",
          enum: ["planned", "researching", "verifying", "briefed", "queued", "produced", "published", "cut"],
        },
      },
      required: ["channelId", "episodeId", "status"],
      additionalProperties: false,
    },
    execute: async (args) =>
      setEpisodeStatus({
        channelId: requireStr(args, "channelId"),
        episodeId: requireStr(args, "episodeId"),
        status: requireStr(args, "status") as
          | "planned"
          | "researching"
          | "verifying"
          | "briefed"
          | "queued"
          | "produced"
          | "published"
          | "cut",
      }),
  },
  {
    name: "set_idea_status",
    description:
      "Set the status of one or MORE backlog ideas (#59): inbox | scored | greenlit | rejected | archived. The realistic cleanup is archiving/rejecting many duplicate ideas at once, so pass a batch of ideaIds. Only ideas on this channel are touched; unknown ids are returned in `skipped`. Get idea ids from list_ideas. (This prunes the backlog that scoring + review_slate's near-duplicate check compare against.)",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        ideaIds: { type: "array", items: { type: "string" }, description: "one or more idea ids to update" },
        status: { type: "string", enum: ["inbox", "scored", "greenlit", "rejected", "archived"] },
      },
      required: ["channelId", "ideaIds", "status"],
      additionalProperties: false,
    },
    execute: async (args) =>
      setIdeaStatus({
        channelId: requireStr(args, "channelId"),
        ideaIds: Array.isArray(args.ideaIds) ? (args.ideaIds as string[]) : [],
        status: requireStr(args, "status") as "inbox" | "scored" | "greenlit" | "rejected" | "archived",
      }),
  },
  {
    name: "update_idea",
    description:
      "Edit a backlog idea's title and/or angle (#60) — the common case is 'this idea is nearly right' rather than binning it. Only provided fields change. To retire an idea instead, use set_idea_status (rejected/archived). Get idea ids from list_ideas.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        ideaId: { type: "string" },
        title: { type: "string" },
        angle: { type: "string" },
      },
      required: ["channelId", "ideaId"],
      additionalProperties: false,
    },
    execute: async (args) =>
      updateIdea({
        channelId: requireStr(args, "channelId"),
        ideaId: requireStr(args, "ideaId"),
        title: str(args, "title"),
        angle: str(args, "angle"),
      }),
  },
  {
    name: "write_idea",
    description:
      "Write a single video idea directly to a channel's backlog. By default it lands in the inbox and auto-scores; set greenlight:true to send it straight into production (skips scoring). For a full authored script, use author_script instead.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        title: { type: "string" },
        angle: { type: "string" },
        greenlight: { type: "boolean", description: "true → create a production immediately" },
      },
      required: ["channelId", "title", "angle"],
      additionalProperties: false,
    },
    execute: async (args) =>
      writeIdea({
        channelId: requireStr(args, "channelId"),
        title: requireStr(args, "title"),
        angle: requireStr(args, "angle"),
        greenlight: typeof args.greenlight === "boolean" ? args.greenlight : false,
      }),
  },

  // ── Review gates (BACKLOG #36): drive the pipeline's halts through the MCP ──
  {
    name: "list_gates",
    description:
      "List review gates currently waiting for a decision (the pipeline's halts) — script_review, profile_review, visuals_review, thumbnail_review (final). Optionally scope to one channel. Use to see what's waiting on you, then get_gate to inspect and decide_gate to act.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string", description: "optional: only this channel's gates" } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = str(args, "channelId");
      const { db } = await getAppContext();
      const rows = await db
        .select({
          gateId: reviewGates.id,
          kind: reviewGates.kind,
          productionId: reviewGates.productionId,
          createdAt: reviewGates.createdAt,
          channelId: productions.channelId,
          ideaTitle: ideas.title,
        })
        .from(reviewGates)
        .innerJoin(productions, eq(reviewGates.productionId, productions.id))
        .innerJoin(ideas, eq(productions.ideaId, ideas.id))
        // Only gates whose production is still active — a retired/failed/halted/
        // superseded/rejected production's gate is stale work (ticket 01KY1SWM…).
        .where(
          and(
            eq(reviewGates.status, "pending"),
            notInArray(productions.status, [...GATE_DEAD_PRODUCTION_STATUSES]),
          ),
        )
        .orderBy(desc(reviewGates.createdAt));
      return rows
        .filter((r) => !channelId || r.channelId === channelId)
        .map((r) => ({ gateId: r.gateId, kind: r.kind, productionId: r.productionId, channelId: r.channelId, video: r.ideaTitle, waitingSince: r.createdAt }));
    },
  },
  {
    name: "get_gate",
    description:
      "Inspect one pending gate. For a visuals_review gate it returns each shot's narration + the image (and whether a clip was animated) so you (or the operator) can review the look before approving, PLUS outstandingDuplicateShots + duplicateRiskGroups (shots sharing a referenceEntity — duplicate-image risk to fix with regenerate_shot before approval, since that window closes on approval). For a thumbnail_review gate it returns the thumbnail CANDIDATES (#66): thumbnails[] {id, url, predictedCtr, selected, prompt, engine, sourced, createdAt} + thumbnailCount — so the thumbnail decision can be prepared over MCP, AND a timed-out regenerate_thumbnail is recoverable (a rising thumbnailCount / fresh createdAt means it landed — don't blind-retry). The reviewPath is the cockpit page to open. Gate APPROVAL stays human (decide_gate is cockpit-only).",
    inputSchema: {
      type: "object",
      properties: { gateId: { type: "string" } },
      required: ["gateId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const gateId = requireStr(args, "gateId");
      const { db } = await getAppContext();
      const [gate] = await db.select().from(reviewGates).where(eq(reviewGates.id, gateId));
      if (!gate) throw new Error("Gate not found");
      const [prod] = await db.select().from(productions).where(eq(productions.id, gate.productionId));
      const [idea] = prod ? await db.select().from(ideas).where(eq(ideas.id, prod.ideaId)) : [];
      const base: Record<string, unknown> = {
        gateId: gate.id,
        kind: gate.kind,
        status: gate.status,
        productionId: gate.productionId,
        video: idea?.title ?? null,
        reviewPath: `/productions/${gate.productionId}`,
      };
      if (gate.kind === "visuals_review") {
        const [draft] = await db
          .select({ beats: scriptDrafts.beats })
          .from(scriptDrafts)
          .where(eq(scriptDrafts.productionId, gate.productionId))
          .orderBy(desc(scriptDrafts.version))
          .limit(1);
        const beats = (draft?.beats as ScriptBeat[] | undefined) ?? [];
        const imgs = await db
          .select({ idx: assets.idx, key: assets.storageKey, meta: assets.meta })
          .from(assets)
          .where(and(eq(assets.productionId, gate.productionId), eq(assets.kind, "image")));
        const clips = await db
          .select({ idx: assets.idx, meta: assets.meta })
          .from(assets)
          .where(and(eq(assets.productionId, gate.productionId), eq(assets.kind, "video_clip")));
        const clipIdx = new Set(clips.map((c) => c.idx));
        // #65/#67: distinguish generated vs sourced clips at the gate (see get_production_shots).
        const gateClipByIdx = new Map(clips.map((c) => [c.idx, (c.meta ?? {}) as Record<string, unknown>]));
        // #50: production render aspect (same derivation as regenerate_shot) so a
        // wrongly-oriented shot is auditable at the gate.
        const [gateProd] = await db.select().from(productions).where(eq(productions.id, gate.productionId));
        const [gateChannel] = gateProd ? await db.select().from(channels).where(eq(channels.id, gateProd.channelId)) : [];
        const [gateDna] = gateProd ? await db.select().from(channelDna).where(eq(channelDna.channelId, gateProd.channelId)) : [];
        const gateRenderAspect = videoAspect({
          contentFormat: gateChannel?.contentFormat ?? "short",
          targetLengthSec: gateDna?.targetLengthSec,
          orientation: resolveProductionProfile(gateDna?.productionProfile ?? null).orientation,
        });
        base.renderAspect = gateRenderAspect;
        base.shots = imgs
          .sort((a, b) => a.idx - b.idx)
          .map((im) => {
            const m = (im.meta ?? {}) as Record<string, unknown>;
            const clipMeta = gateClipByIdx.get(im.idx);
            const assetType: "still" | "generated_clip" | "sourced_clip" = !clipMeta
              ? "still"
              : imageSourceKind(clipMeta) === "sourced"
                ? "sourced_clip"
                : "generated_clip";
            return {
              idx: im.idx,
              narration: beats[im.idx]?.text ?? null,
              image: `/api/media/${im.key}`,
              animated: clipIdx.has(im.idx),
              // #65/#67: the true asset behind this shot (a sourced clip is real footage,
              // not a generated still) — the `image` above is the still poster only.
              assetType,
              ...(assetType === "sourced_clip" && clipMeta
                ? { clipProvenance: { source: typeof clipMeta.source === "string" ? clipMeta.source : null, entity: typeof clipMeta.entity === "string" ? clipMeta.entity : null } }
                : {}),
              aspect: typeof m.aspect === "string" ? m.aspect : null,
            };
          });
        base.aspectMismatchShots = (base.shots as { idx: number; aspect: string | null }[])
          .filter((s) => s.aspect && s.aspect !== gateRenderAspect)
          .map((s) => s.idx);
        // Duplicate-image risk (ticket 01KY6DCD…): flag how many shots still share
        // a referenceEntity BEFORE approval, so the operator knows what's unfixed —
        // regenerate_shot is gone the moment this gate is approved.
        // #52 (ticket 01KY9ECS…): count only shots STILL SOURCED under the entity —
        // a shot regenerated from an authored imagePrompt is a distinct generated
        // still whose entity is historical, so it no longer draws the source pool.
        const dupGroups = duplicateRiskGroups(
          imgs
            .map((im) => {
              const m = (im.meta ?? {}) as Record<string, unknown>;
              return { idx: im.idx, entity: typeof m.entity === "string" ? m.entity : null, source: imageSourceKind(m) };
            })
            .filter((s) => s.source === "sourced"),
        );
        base.outstandingDuplicateShots = outstandingDuplicateShotCount(dupGroups);
        base.duplicateRiskGroups = dupGroups;
        if (dupGroups.length > 0) {
          base.duplicateRiskNote = `${outstandingDuplicateShotCount(dupGroups)} shot(s) across ${dupGroups.length} entity group(s) share a referenceEntity (duplicate-image risk). Fix them with regenerate_shot, or accept the risk, BEFORE approving — the per-shot fix window closes on approval.`;
        }
      }
      if (gate.kind === "thumbnail_review") {
        // #66: return the thumbnail CANDIDATES so the decision can be prepared over
        // MCP AND a timed-out regenerate_thumbnail is recoverable (check the count /
        // newest createdAt instead of blind-retrying and double-billing).
        const cands = await db
          .select()
          .from(thumbnails)
          .where(eq(thumbnails.productionId, gate.productionId))
          .orderBy(desc(thumbnails.predictedCtr), desc(thumbnails.createdAt));
        base.thumbnailCount = cands.length;
        base.thumbnails = cands.map((t) => {
          const m = (t.meta ?? {}) as Record<string, unknown>;
          return {
            id: t.id,
            url: `/api/media/${t.storageKey}`,
            predictedCtr: t.predictedCtr,
            selected: t.selected,
            prompt: typeof m.prompt === "string" ? m.prompt : null,
            engine: typeof m.engine === "string" ? m.engine : typeof m.source === "string" ? m.source : null,
            sourced: m.sourced === true,
            ...(typeof m.attribution === "string" ? { attribution: m.attribution } : {}),
            createdAt: t.createdAt,
          };
        });
        base.thumbnailNote =
          "Pick one and apply it: at this gate the operator approves in the cockpit; post-gate use set_video_thumbnail(productionId, thumbnailId). After a regenerate_thumbnail that TIMED OUT, re-read this — a rising thumbnailCount / a fresh createdAt means it landed (don't blind-retry; that double-bills).";
      }
      return base;
    },
  },
  // NOTE (remediation brief §0.1/§3.1): gate APPROVAL is deliberately NOT exposed
  // over MCP. Approving the visuals/final gate is a human action taken in the
  // cockpit — the approval log is the editorial-judgment evidence that protects
  // the channels under YouTube's inauthentic-content enforcement. list_gates +
  // get_gate (read-only, above) let an AI operator SEE and FLAG what's waiting;
  // clearing a gate stays human. Do not add a decide_gate tool here.

  // ── Costs + per-video analytics (remediation §3.3/§3.6) ───────────────────
  {
    name: "get_production_costs",
    description:
      "Cost breakdown for one production — grouped by stage (llm/voice/media/render/publish/research) and provider, with a USD total. NOTE: only SUCCESSFUL operations are recorded, so a failed step's own spend isn't captured, but partial spend on a failed production persists and shows here.",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const rows = await db
        .select({
          category: costRecords.category,
          provider: costRecords.provider,
          total: sql<string>`sum(${costRecords.costUsd})`,
          lines: sql<number>`count(*)`,
        })
        .from(costRecords)
        .where(eq(costRecords.productionId, productionId))
        .groupBy(costRecords.category, costRecords.provider);
      const byStage: Record<string, number> = {};
      let total = 0;
      const items = rows.map((r) => {
        const usd = Number(r.total) || 0;
        byStage[r.category] = (byStage[r.category] ?? 0) + usd;
        total += usd;
        return { stage: r.category, provider: r.provider, costUsd: Number(usd.toFixed(4)), lines: Number(r.lines) };
      });
      // #38: per-engine media breakdown so the image-engine (e.g. Seedream vs Qwen)
      // quality/cost tradeoff is visible without adding up the media rows by hand.
      const mediaByEngine = items
        .filter((r) => r.stage === "media")
        .map((r) => ({ engine: r.provider, costUsd: r.costUsd, images: r.lines }));
      return {
        productionId,
        totalUsd: Number(total.toFixed(4)),
        byStage: Object.fromEntries(Object.entries(byStage).map(([k, v]) => [k, Number(v.toFixed(4))])),
        ...(mediaByEngine.length ? { mediaByEngine } : {}),
        items,
      };
    },
  },
  {
    name: "get_channel_costs",
    description:
      "Cost rollup for a channel — totals by stage across all its productions (USD), per-production totals (highest first), AND byIdea (#49): cumulative spend per idea {ideaId, title, attempts, publishedCount, cumulativeUsd}, sorted by cumulativeUsd, so a re-greenlit idea with many abandoned attempts is visible in one call. NOTE: only SUCCESSFUL operations are billed, so true burn is higher than shown.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const { db } = await getAppContext();
      const byCat = await db
        .select({ category: costRecords.category, total: sql<string>`sum(${costRecords.costUsd})` })
        .from(costRecords)
        .where(eq(costRecords.channelId, channelId))
        .groupBy(costRecords.category);
      const byProd = await db
        .select({ productionId: costRecords.productionId, total: sql<string>`sum(${costRecords.costUsd})` })
        .from(costRecords)
        .where(and(eq(costRecords.channelId, channelId), isNotNull(costRecords.productionId)))
        .groupBy(costRecords.productionId);
      const byStage = Object.fromEntries(byCat.map((r) => [r.category, Number(Number(r.total).toFixed(4))]));
      const total = byCat.reduce((a, r) => a + (Number(r.total) || 0), 0);
      // #49 (ticket 01KY9E1S…): roll spend up BY IDEA so a re-greenlit idea that has
      // silently accrued many abandoned attempts is legible in ONE call — the concen-
      // tration used to require summing perProduction rows and hand-joining them back
      // to ideaId via list_productions. Advisory only; nothing is blocked.
      const costByProd = new Map(byProd.map((r) => [r.productionId, Number(r.total) || 0]));
      const prodRows = await db
        .select({ id: productions.id, ideaId: productions.ideaId, status: productions.status })
        .from(productions)
        .where(eq(productions.channelId, channelId));
      const ideaRows = await db
        .select({ id: ideas.id, title: ideas.title })
        .from(ideas)
        .where(eq(ideas.channelId, channelId));
      const titleByIdea = new Map(ideaRows.map((r) => [r.id, r.title]));
      const ideaAgg = new Map<string, { attempts: number; publishedCount: number; cumulativeUsd: number }>();
      for (const p of prodRows) {
        if (!p.ideaId) continue;
        const a = ideaAgg.get(p.ideaId) ?? { attempts: 0, publishedCount: 0, cumulativeUsd: 0 };
        a.attempts += 1;
        // published_unverified is deliberately NOT a live published video (it's a
        // phantom row — see productionStatus), so it doesn't count toward payoff.
        if (p.status === "published") a.publishedCount += 1;
        a.cumulativeUsd += costByProd.get(p.id) ?? 0;
        ideaAgg.set(p.ideaId, a);
      }
      const byIdea = [...ideaAgg.entries()]
        .map(([ideaId, a]) => ({
          ideaId,
          title: titleByIdea.get(ideaId) ?? null,
          attempts: a.attempts,
          publishedCount: a.publishedCount,
          cumulativeUsd: Number(a.cumulativeUsd.toFixed(4)),
        }))
        .sort((x, y) => y.cumulativeUsd - x.cumulativeUsd);
      // Advisory concentration flag: an idea that has consumed real spend across
      // several attempts with nothing published is exactly the Krypton-rework shape.
      const burnConcentration = byIdea.filter((i) => i.publishedCount === 0 && i.attempts >= 3 && i.cumulativeUsd > 0);
      return {
        channelId,
        totalUsd: Number(total.toFixed(4)),
        byStage,
        perProduction: byProd
          .map((r) => ({ productionId: r.productionId, costUsd: Number(Number(r.total).toFixed(4)) }))
          .sort((a, b) => b.costUsd - a.costUsd),
        byIdea,
        ...(burnConcentration.length
          ? {
              note: `${burnConcentration.length} idea(s) have accrued spend across ≥3 attempts with nothing published — see byIdea (sorted by cumulativeUsd). NOTE: only SUCCESSFUL steps are billed, so the true burn is higher than shown. Continuing is your call; this is advisory.`,
            }
          : {}),
      };
    },
  },
  {
    name: "get_video_analytics",
    description:
      "Per-video analytics for a PUBLISHED production: views, CTR, impressions, avg view %, the retention curve, the 3s hook hold, plus any hook/script analysis. NOTE: on real YouTube channels the retention curve + CTR/impressions populate as the Analytics API matures and may be null early (the mock fills them).",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const [pub] = await db
        .select({ id: publications.id })
        .from(publications)
        .where(and(eq(publications.productionId, productionId), isNotNull(publications.publishedAt)))
        .limit(1);
      if (!pub) return { productionId, published: false, note: "No published publication for this production yet." };
      const performance = await videoPerformance(db, pub.id);
      const [hook] = await db.select().from(hookAnalyses).where(eq(hookAnalyses.publicationId, pub.id)).limit(1);
      const [scriptA] = await db.select().from(scriptAnalyses).where(eq(scriptAnalyses.publicationId, pub.id)).limit(1);
      return { productionId, published: true, performance, hookAnalysis: hook ?? null, scriptAnalysis: scriptA ?? null };
    },
  },
  {
    name: "get_channel_analytics",
    description:
      "Channel-level analytics (ticket 01KY1VEZ…): windowed views, subscribers gained, current subscriber count, watch hours, average retention, and per-video view distribution (median + mean, and how many videos actually have analytics). `sinceDays` sets the window (default 28). Windowed figures come straight from YouTube (not summed snapshots); median/mean come from the latest snapshot per published video. #17: windowed now also returns impressions + ctr (thumbnail impressions + click-through-rate %, via videoThumbnailImpressions[ClickRate] — added to the Analytics API 2026-01-15; null until reported for a new channel, subject to YouTube's 24-72h lag).",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        sinceDays: { type: "number", description: "trailing window in days (default 28)" },
      },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const rawDays = (args as Record<string, unknown>).sinceDays;
      const sinceDays = Math.max(1, Math.min(365, Math.round(typeof rawDays === "number" && Number.isFinite(rawDays) ? rawDays : 28)));
      const { db, providers } = await getAppContext();
      const [channel] = await db.select({ id: channels.id, name: channels.name }).from(channels).where(eq(channels.id, channelId)).limit(1);
      if (!channel) throw new Error("Channel not found");
      const dist = await channelPerformanceSummary(db, channelId);
      let windowed: {
        views: number;
        subsGained: number;
        avgViewPct: number | null;
        watchHours: number | null;
        subscriberCount: number | null;
        impressions: number | null;
        ctr: number | null;
        dailyViews: { day: string; views: number }[];
      } | null = null;
      let note: string | undefined;
      try {
        const cs = await providers.analytics.fetchChannelStats({ channelId, sinceDays });
        windowed = {
          views: cs.views,
          subsGained: cs.subsGained,
          avgViewPct: cs.avgViewPct,
          watchHours: cs.estimatedMinutesWatched != null ? Math.round((cs.estimatedMinutesWatched / 60) * 10) / 10 : null,
          subscriberCount: cs.subscriberCount,
          // #17: thumbnail impressions + CTR% (now in the Analytics API, 2026-01-15)
          impressions: cs.impressions,
          ctr: cs.ctr,
          dailyViews: cs.dailyViews,
        };
      } catch (e) {
        note = `Live channel analytics unavailable (${e instanceof Error ? e.message : String(e)}). Distribution below is from stored snapshots.`;
      }
      return {
        channelId,
        channel: channel.name,
        window: { sinceDays },
        windowed,
        distribution: {
          publishedCount: dist.publishedCount,
          withAnalytics: dist.withAnalytics,
          medianViews: dist.medianViews,
          meanViews: dist.meanViews,
          avgViewPct: dist.avgViewPct,
          best: dist.best ?? null,
          worst: dist.worst ?? null,
        },
        note,
      };
    },
  },

  {
    name: "get_agent_prompts",
    description:
      "Read-only index of every LLM agent the platform runs (ticket 01KY1X58…): name, purpose, source file, model tier, whether it's compliance-relevant, and whether the authored path bypasses it. Use to see the agent surface for diagnosis (e.g. which agent produces a bad output) and to audit the compliance-relevant agents. Full prompt-text/editing/versioning is a cockpit follow-up; this is the read surface.",
    inputSchema: {
      type: "object",
      properties: { complianceOnly: { type: "boolean", description: "only the compliance-relevant agents" } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const complianceOnly = (args as { complianceOnly?: unknown }).complianceOnly === true;
      const list = complianceOnly ? complianceRelevantPrompts() : AGENT_PROMPTS;
      return {
        count: list.length,
        agents: list,
        note: "Read-only. To view/edit the exact prompt text, open the agent's source file; centralised prompt editing + version history is a planned cockpit follow-up.",
      };
    },
  },

  {
    name: "get_deferred_work",
    description:
      "The durable record of work that is shipped-but-not-yet-verifiable or deliberately deferred — so a CLOSED ticket is never mis-read as 'not done', and a deploy-timing-gated fix is never mis-read as a failure. `status`: 'shipped_pending_verification' = code deployed + tested, effect appears only after a data cycle (next analytics-ingest, YouTube's 24-72h lag) or a live check the sandbox can't run — verify the RIGHT signal, not the pre-deploy state; 'deferred' = intentionally not built yet (usually because it changes live production behaviour and needs the operator present). Each item names its source ticket + the next step.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["shipped_pending_verification", "deferred"], description: "optional filter" } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const status = str(args, "status");
      const items = status === "shipped_pending_verification" || status === "deferred" ? deferredByStatus(status) : DEFERRED_WORK;
      return {
        count: items.length,
        items,
        note: "When a fix looks unapplied, check here first: some fixes are deployed but their EFFECT is gated on the next analytics-ingest cycle or YouTube's data lag.",
      };
    },
  },

  // ── Help, diagnostics, and the issue bridge (BACKLOG #36) ──────────────────
  {
    name: "get_guide",
    description:
      "Return the platform operating guide — how to use these tools correctly across the end-to-end flow (authoring, the config surface, real-image sourcing, gates, gotchas). Read this first if you're unsure how to drive the platform.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      // Self-audit BOTH directions: a guide-named-but-unregistered tool (#29, a
      // phantom you'd chase) AND a registered-but-unguided tool (#59, a capability
      // you were never told about). Either is drift; surface it over MCP.
      const audit = auditGuideToolReferences();
      if (audit.ok) return { guide: MCP_GUIDE };
      const warnings: string[] = [];
      if (audit.missing.length) {
        warnings.push(
          `Guide references ${audit.missing.length} tool(s) not in the MCP registry: ${audit.missing.join(", ")}. These are documented but not callable — report_issue so the guide/registry are reconciled.`,
        );
      }
      if (audit.undocumented.length) {
        warnings.push(
          `${audit.undocumented.length} registered tool(s) are NOT mentioned in this guide: ${audit.undocumented.join(", ")}. They ARE callable — the guide is just behind. report_issue so it's documented (or the tool is allowlisted if it's a deliberate omission).`,
        );
      }
      return { guide: MCP_GUIDE, warnings };
    },
  },
  {
    name: "get_diagnostics",
    description:
      "A debug console: recent blocked productions (failed/on_hold) with their reason, open alerts, and the deployed build versions. Use to find and explain what went wrong. Optionally scope to one channel.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string", description: "optional: only this channel" } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = str(args, "channelId");
      const { db } = await getAppContext();
      const blocked = await db
        .select({ id: productions.id, channelId: productions.channelId, status: productions.status, failureReason: productions.failureReason, updatedAt: productions.updatedAt })
        .from(productions)
        .where(
          channelId
            ? and(eq(productions.channelId, channelId), inArray(productions.status, ["failed", "on_hold"]))
            : inArray(productions.status, ["failed", "on_hold"]),
        )
        .orderBy(desc(productions.updatedAt))
        .limit(20);
      const openAlerts = await db
        .select({ id: alerts.id, channelId: alerts.channelId, kind: alerts.kind, severity: alerts.severity, message: alerts.message })
        .from(alerts)
        .where(eq(alerts.status, "open"))
        .limit(30);
      const versions = await db.select().from(serviceVersions);
      // Cheap DB-only publication smell test (ticket 01KY1VFP…) — surfaces
      // duplicate-publish clusters + records with no video id without hitting
      // YouTube. reconcile_publications does the live confirmation.
      const suspicious = await findSuspiciousPublications(db, channelId);
      const hasPublicationIssues =
        suspicious.duplicateIdeaClusters.length > 0 ||
        suspicious.publishedWithoutVideoId.length > 0 ||
        suspicious.duplicateVideoIds.length > 0;
      return {
        blockedProductions: blocked.filter((b) => !channelId || b.channelId === channelId),
        openAlerts: openAlerts.filter((a) => !channelId || a.channelId === channelId),
        deploy: versions.map((v) => ({ service: v.service, commit: v.commit, bootedAt: v.bootedAt })),
        publicationIssues: hasPublicationIssues
          ? { ...suspicious, note: "Run reconcile_publications to confirm against live YouTube." }
          : null,
        note: "For per-render media/engine diagnostics open /api/diag/media and /api/diag/clips in the cockpit.",
      };
    },
  },
  {
    name: "review_beat_map",
    description:
      "Structural pre-check on a BEAT MAP before you write full narration or spend on generation (ticket 01KY1Y9E…). Submit the shape — for each beat its type (hook/stat/insight/cta/rehook), a one-line summary, optional wordBudget/timingSec/heroShot — plus title, hookLine, targetLengthSec. Returns verdict pass/advise/block with specific findings: BLOCKS on word-budget-out-of-band and structural repetition vs this channel's recent maps (the compliance check — templated low-variation structure is what YouTube's inauthentic-content enforcement targets); ADVISES on payoff position, flat runs, and date-arithmetic to verify (#69: payoff_position keys on an explicit beats[].payoff marker — else the last heroShot, else silent — and flat_run keys on elapsed narration time, ~3.5 min, not beat count, so neither fires spuriously on a fine-grained map). A block means don't proceed as-is — revise the shape and re-submit. Each submission is stored so the variation check gets stronger over time. When iterating, PASS `ideaId`: revisions sharing an ideaId are excluded from the structural-repetition comparison, so re-submitting a revised map is never blocked as a near-duplicate of the draft it supersedes — only genuine cross-EPISODE similarity blocks (the corpus keeps just the latest map per other episode). Also returns `lengthPolicy` (#39): the channel's runtime band + which band the proposed targetLengthSec sits in, and ADVISES (never blocks) when the runtime is mismatched to the map's depth (padding a thin map to a long runtime, or cramming a dense one) or below the 8-min mid-roll floor — length should track the material. Also returns a `shotEstimate`: roughly how many shots this length WILL cut (so you supply enough distinct briefs) and how many will MOVE under the channel's motion axis — flags when more beats are marked animates than will actually animate. (This is opt-in and advisory to you as the author; it does not by itself halt the pipeline.)",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        ideaId: {
          type: "string",
          description:
            "The idea (list_ideas) OR series episode (list_series) this map is a draft of. PASS IT when iterating — revisions sharing an ideaId are excluded from the structural-repetition comparison, so re-submitting a revised map doesn't trip the block against the draft it supersedes. Cross-episode comparison stays strict. #86: an episode id is accepted and resolved the SAME way author_script resolves it, and an id matching neither is flagged (ideaIdWarning) up front rather than only failing at author_script. Omit only for a truly standalone one-off check.",
        },
        productionId: {
          type: "string",
          description: "Optional link to the production this map became (stored for audit/lineage).",
        },
        beatMap: {
          type: "object",
          properties: {
            title: { type: "string" },
            hookLine: { type: "string" },
            targetLengthSec: { type: "number" },
            beats: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  summary: { type: "string" },
                  wordBudget: { type: "number" },
                  timingSec: { type: "number" },
                  heroShot: { type: "boolean" },
                  animates: { type: "boolean" },
                  referenceEntity: { type: "string" },
                  referenceEntities: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "#69: ordered real subjects consumed across the shots this beat is cut into — supply N distinct briefs per beat without adding beats. The returned shotEstimate reports suppliedEntities + entityCoverage against estimatedShots.",
                  },
                  payoff: {
                    type: "boolean",
                    description:
                      "#69: mark the ONE beat that discharges the hook's promise (the payoff). Drives payoff_position directly; without it the check falls back to the last heroShot and stays silent if there's neither.",
                  },
                },
                required: ["type", "summary"],
                additionalProperties: false,
              },
            },
          },
          required: ["title", "targetLengthSec", "beats"],
          additionalProperties: false,
        },
      },
      required: ["channelId", "beatMap"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const ideaIdRaw = str(args, "ideaId") || null;
      const productionId = str(args, "productionId") || null;
      const bmRaw = (args as { beatMap?: unknown }).beatMap as BeatMap | undefined;
      if (!bmRaw || !Array.isArray(bmRaw.beats) || bmRaw.beats.length === 0) {
        throw new Error("beatMap.beats must be a non-empty array");
      }
      const beatMap: BeatMap = {
        title: String(bmRaw.title ?? "Untitled"),
        hookLine: String(bmRaw.hookLine ?? ""),
        targetLengthSec: Number(bmRaw.targetLengthSec) || 0,
        beats: bmRaw.beats.map((b) => ({
          type: String(b.type),
          summary: String(b.summary ?? ""),
          wordBudget: typeof b.wordBudget === "number" ? b.wordBudget : undefined,
          timingSec: typeof b.timingSec === "number" ? b.timingSec : undefined,
          heroShot: Boolean(b.heroShot),
          animates: Boolean(b.animates),
          referenceEntity: typeof b.referenceEntity === "string" ? b.referenceEntity : undefined,
          referenceEntities: Array.isArray((b as { referenceEntities?: unknown }).referenceEntities)
            ? ((b as { referenceEntities: unknown[] }).referenceEntities.map((e) => (typeof e === "string" ? e : null)))
            : undefined,
          payoff: typeof (b as { payoff?: unknown }).payoff === "boolean" ? (b as { payoff?: boolean }).payoff : undefined,
        })),
      };
      const { db } = await getAppContext();
      const [channel] = await db
        .select({ id: channels.id, name: channels.name, contentFormat: channels.contentFormat })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);
      if (!channel) throw new Error("Channel not found");
      // #86: review_beat_map and author_script both take an `ideaId`, but review used
      // to accept ANY string (it's only a comparison key) while author validates it
      // against the ideas table — so an id could pass review yet fail authoring. Both
      // now resolve it the same way: a series-EPISODE id is valid and normalizes to
      // its backing idea (so review and author share the same same-episode key), and
      // an id matching NEITHER is surfaced now (cheap call) rather than only after the
      // full authoring payload is built.
      const idRef = ideaIdRaw ? await resolveIdeaRef(db, ideaIdRaw) : null;
      const ideaId = idRef?.kind === "episode" ? (idRef.ideaId ?? ideaIdRaw) : ideaIdRaw;
      const ideaIdWarning =
        idRef?.kind === "unknown"
          ? `ideaId "${ideaIdRaw}" matches neither a backlog idea (list_ideas) nor a series episode (list_series) — author_script will reject it. Check the id before writing narration.`
          : null;
      // Recent maps for the CROSS-EPISODE variation check (compliance). Exclude
      // prior drafts of the SAME episode (same ideaId) so iterating a blocked map
      // doesn't trip the block against the draft it supersedes (ticket 01KY62TW…),
      // and collapse to the LATEST map per other episode so a superseded draft
      // doesn't pollute the baseline. Legacy rows with no ideaId each count once.
      const recentRows = await db
        .select({ map: beatMaps.map, ideaId: beatMaps.ideaId })
        .from(beatMaps)
        .where(eq(beatMaps.channelId, channelId))
        .orderBy(desc(beatMaps.createdAt))
        .limit(100);
      const recentMaps = selectComparisonMaps(
        recentRows.map((r) => ({ map: r.map as BeatMap, ideaId: r.ideaId })),
        ideaId,
      );
      const review = reviewBeatMapDeterministic(beatMap, { recentMaps });
      const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
      // #39 content-driven runtime: ADVISE (never block) when the proposed runtime
      // is mismatched to the map's depth (beat count + word budget), and flag the
      // hard mid-roll floor. targetLengthSec is the proposed runtime here.
      const lengthPolicy = resolveLengthPolicy(dna?.lengthPolicy ?? null);
      // #28/#69: resolve the profile first so the runtime-fit + shot estimate both
      // see the channel's motion + imageDensity axes.
      const resolvedProfile = resolveProductionProfile(dna?.productionProfile ?? null, {
        contentFormat: channel.contentFormat,
      });
      const runtimeAdvisories = reviewRuntimeFit(lengthPolicy, {
        runtimeSec: beatMap.targetLengthSec,
        beatCount: beatMap.beats.length,
        words: beatMapWordCount(beatMap),
        // #69: don't flag a still-image essay channel's high beats/min as cramming.
        motion: resolvedProfile.motion,
        imageDensity: resolvedProfile.imageDensity,
      });
      review.advisoryFindings.push(...runtimeAdvisories);
      const verdict = beatMapVerdict(review);
      // #28: coarse shot + motion estimate from the map's shape, so the author
      // can match brief count to slot count and see how many shots will move
      // BEFORE writing narration. Resolved against the channel's motion axis.
      const isLong = channel.contentFormat === "long" || (dna?.targetLengthSec ?? 0) > 90;
      const shotEstimate = estimateBeatMapShotPlan(beatMap, resolvedProfile, { isLong });
      // Store the submission so future checks compare against it. ideaId ties
      // revisions of one episode together so they're excluded from each other's
      // comparison (ticket 01KY62TW…).
      await db.insert(beatMaps).values({
        id: ulid(),
        channelId,
        ideaId,
        productionId,
        title: beatMap.title,
        map: beatMap,
        fingerprint: beatMapFingerprint(beatMap),
        verdict,
      });
      return {
        channelId,
        verdict,
        // #86: flag an ideaId that won't author (neither idea nor episode), up front.
        ...(ideaIdWarning ? { ideaIdWarning } : {}),
        blockingFindings: review.blockingFindings,
        advisoryFindings: review.advisoryFindings,
        comparedAgainst: recentMaps.length,
        comparedScope: ideaId
          ? "distinct OTHER episodes on this channel (this episode's own prior drafts excluded)"
          : "distinct episodes on this channel (no ideaId supplied — pass ideaId when iterating so your own prior drafts are excluded)",
        shotEstimate,
        // #39: the channel's runtime band + which band the proposed targetLengthSec
        // sits in, so the author picks a length that fits the material (advisory).
        lengthPolicy: {
          floorSec: lengthPolicy.floorSec,
          ceilingSec: lengthPolicy.ceilingSec,
          bands: lengthPolicy.bands,
          principle: lengthPolicy.principle,
          proposedRuntimeSec: beatMap.targetLengthSec,
          proposedBand: lengthPolicy.bands.find((b) => beatMap.targetLengthSec >= b.minSec && beatMap.targetLengthSec <= b.maxSec)?.name ?? null,
        },
        note:
          verdict === "block"
            ? "Blocking findings must be resolved — revise the beat map's shape and re-submit before writing narration."
            : verdict === "advise"
              ? "No blockers. Advisory findings are craft judgement — your call whether to adjust."
              : "Clean pass — proceed to author_script.",
      };
    },
  },
  {
    name: "review_slate",
    description:
      "Review a BATCH of proposed ideas/titles against a channel's OWN rules BEFORE they enter the backlog (ticket 01KY2BJ9…) — the cheapest gate in the pipeline, one stage earlier than review_beat_map. Submit channelId + ideas[] (title, one-line angle, optional arc). BLOCKS on: a title/angle that violates the channel's forbiddenTopics (semantic match — an LLM catches 'Enoch's Calendar Has 364 Days' as 'mechanics of the luminaries'), an overclaim that contradicts a stored rule, and near-duplicates of the slate itself or the existing backlog/published titles. ADVISES on: intra-slate structural clustering (five titles of the same shape), keyword position, title-family drift (needs titleTemplates set on DNA), substance overlap, and PRODUCIBILITY (#54 — flags ideas the channel's own production reality can't build: a live host / props / a real shoot on a faceless generative channel, or a rap/song/chant the TTS voiceover can't perform). Returns verdict pass/advise/block with {rule, evidence} findings. Run it before write_idea/create_series; a block means revise the batch. Opt-in and advisory to you as the author — it does not by itself gate write_idea.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        ideas: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              angle: { type: "string", description: "one-line angle" },
              arc: { type: "string", description: "optional intended arc/series" },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["channelId", "ideas"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const rawIdeas = (args as { ideas?: unknown }).ideas;
      if (!Array.isArray(rawIdeas) || rawIdeas.length === 0) throw new Error("ideas must be a non-empty array");
      const slate: SlateIdea[] = rawIdeas.map((r) => {
        const o = r as { title?: unknown; angle?: unknown; arc?: unknown };
        if (typeof o.title !== "string" || !o.title.trim()) throw new Error("every idea needs a title");
        return {
          title: o.title.trim(),
          angle: typeof o.angle === "string" ? o.angle.trim() : undefined,
          arc: typeof o.arc === "string" ? o.arc.trim() : undefined,
        };
      });

      const { db, providers, costSink } = await getAppContext();
      const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
      if (!channel) throw new Error("Channel not found");
      const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
      const [charter] = await db.select().from(channelCharters).where(eq(channelCharters.channelId, channelId));

      // Existing titles: backlog ideas + published (idea title, or its authored override).
      // #60: exclude rejected/archived ideas from the comparison set — a retired idea
      // must not keep tripping the near-duplicate check (it would eventually block a
      // good idea against one nobody intends to make). set_idea_status retires them.
      const backlog = await db
        .select({ title: ideas.title })
        .from(ideas)
        .where(and(eq(ideas.channelId, channelId), notInArray(ideas.status, ["rejected", "archived"])))
        .limit(500);
      const published = await db
        .select({ title: ideas.title, authored: productions.authoredMetadata })
        .from(publications)
        .innerJoin(productions, eq(publications.productionId, productions.id))
        .innerJoin(ideas, eq(productions.ideaId, ideas.id))
        .where(eq(productions.channelId, channelId))
        .limit(300);
      const existingTitles = [
        ...backlog.map((r) => r.title),
        ...published.map((r) => (r.authored as { title?: string } | null)?.title ?? r.title),
      ].filter((t): t is string => Boolean(t));

      const forbiddenTopics = (dna?.forbiddenTopics ?? []) as string[];
      const titleTemplates = (dna?.titleTemplates ?? undefined) as
        | { name: string; pattern: string; example?: string }[]
        | undefined;
      const searchTerms = (dna?.searchTerms ?? undefined) as string[] | undefined;

      // #54: the channel's resolved visual mode drives the producibility check —
      // a faceless generative mode (ai_images/ai_video/simple) can't film a live host.
      const slateVisualMode = resolveProductionProfile(dna?.productionProfile ?? null, {
        contentFormat: channel.contentFormat,
      }).visualMode;

      // Deterministic checks (clustering, duplicates, keyword position, overclaim
      // verbs, producibility).
      const det = reviewSlateDeterministic(slate, {
        existingTitles,
        searchTerms,
        titleTemplatesDeclared: Boolean(titleTemplates?.length),
        visualMode: slateVisualMode,
        madeForKids: channel.madeForKids === true, // #53: flag comment CTAs on MFK channels
      });

      // Semantic checks (forbiddenTopics violation, overclaim-vs-rule, family drift, overlap).
      const blocking: SlateFinding[] = [...det.blockingFindings];
      const advisory: SlateFinding[] = [...det.advisoryFindings];
      let semanticError: string | null = null;
      try {
        const vb = charter?.verificationBar as { establishedMinSources?: number; presentDebateMode?: boolean } | undefined;
        const semantic = await reviewSlateSemantic(
          { db, llm: providers.llm, costSink, channelId },
          {
            niche: channel.niche,
            forbiddenTopics,
            titleTemplates,
            verificationBarNote: vb
              ? `established facts need ${vb.establishedMinSources ?? 1} source(s); presentDebateMode=${vb.presentDebateMode ?? false}`
              : undefined,
            slate,
          },
        );
        for (const f of semantic.findings) {
          const label = slate[f.index] ? `idea ${f.index} ("${slate[f.index]!.title}")` : `idea ${f.index}`;
          const finding: SlateFinding = { rule: f.rule, evidence: `${label}: ${f.evidence}` };
          if (f.severity === "block") blocking.push(finding);
          else advisory.push(finding);
        }
      } catch (e) {
        // The deterministic checks still stand if the LLM layer errors — report it,
        // don't fail the whole review.
        semanticError = e instanceof Error ? e.message : String(e);
      }

      const verdict = slateVerdict({ blockingFindings: blocking, advisoryFindings: advisory });
      return {
        channelId,
        verdict,
        blockingFindings: blocking,
        advisoryFindings: advisory,
        checked: slate.length,
        comparedAgainstExisting: existingTitles.length,
        forbiddenTopicsCount: forbiddenTopics.length,
        titleFamiliesDeclared: titleTemplates?.length ?? 0,
        searchTermsSet: Boolean(searchTerms?.length),
        ...(searchTerms?.length ? {} : { keywordCheckSkipped: "Set dna.searchTerms (the terms your audience searches, e.g. 'Book of Enoch') to enable the keyword-position check." }),
        ...(semanticError ? { semanticCheckError: `Semantic (forbiddenTopics) check failed: ${semanticError}. Deterministic findings still apply.` } : {}),
        note:
          verdict === "block"
            ? "Blocking findings must be resolved — revise or cut the flagged ideas before writing them to the backlog. forbiddenTopics violations are your channel's own constraints."
            : verdict === "advise"
              ? "No blockers. Advisory findings are craft judgement — your call. Declare titleTemplates on DNA to make title-family drift detectable."
              : "Clean pass — proceed to write_idea / create_series.",
      };
    },
  },
  {
    name: "reconcile_publications",
    description:
      "Verify every publication record against the live YouTube video (ticket 01KY1VFP…): flags records whose video is missing, deleted, private, a stuck shell, or has no video id — the cause of published-count drift (platform said 7, YouTube showed 5). ALSO flags publishedAt DATE DRIFT (ticket 01KY9C9R…): a live record whose stored publish date disagrees with YouTube's real publishedAt by >1h — e.g. a scheduled video released early in Studio still carrying its future slot as publishedAt, which strands analytics ingest on an empty date window. Makes one YouTube read per published video. Optionally scope to one channel. Pass fix:true to (a) demote confirmed phantoms — id resolves to no live video (missing/shell/no-id) — from 'published' to 'published_unverified' (id kept for history, so counts/averages are right and they stop blocking re-publishing), and (b) correct drifted publishedAt to YouTube's real value, re-triggering analytics ingest when the date moves backward so the missed window is picked up. fix NEVER touches 'unknown' (provider unreachable — the mock always returns unknown) or a merely-private live video.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "optional: only this channel" },
        fix: { type: "boolean", description: "when true, demote confirmed-phantom published records to published_unverified (a WRITE)" },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = str(args, "channelId");
      const fix = args.fix === true;
      const { db, providers } = await getAppContext();
      const rows = await db
        .select({
          publicationId: publications.id,
          productionId: productions.id,
          channelId: productions.channelId,
          providerVideoId: publications.providerVideoId,
          publishedAt: publications.publishedAt,
          status: productions.status,
          title: ideas.title,
        })
        .from(publications)
        .innerJoin(productions, eq(publications.productionId, productions.id))
        .innerJoin(ideas, eq(productions.ideaId, ideas.id))
        .where(channelId ? eq(productions.channelId, channelId) : isNotNull(publications.id))
        .orderBy(desc(publications.publishedAt))
        .limit(200);

      const results = [];
      for (const r of rows) {
        let live: Awaited<ReturnType<typeof providers.publish.videoStatus>> = { state: "unknown" };
        if (r.providerVideoId) {
          try {
            live = await providers.publish.videoStatus({ channelId: r.channelId, providerVideoId: r.providerVideoId });
          } catch {
            live = { state: "unknown" };
          }
        }
        const believedLive = r.status === "published" && Boolean(r.publishedAt);
        const { verdict, note } = classifyPublication({ providerVideoId: r.providerVideoId, believedLive, live });
        // Date-drift check: only a record we currently treat as live-published
        // ('ok' against a real live video, with a stored publishedAt) is compared
        // to YouTube's real publishedAt. Phantoms/private/unknown are excluded.
        const remotePublishedAt = live.state === "found" ? live.publishedAt : null;
        const drift =
          verdict === "ok" && r.publishedAt
            ? publishedAtDrift({ storedPublishedAt: r.publishedAt, remotePublishedAt })
            : { drifted: false, deltaMs: 0, direction: "none" as const };
        results.push({
          publicationId: r.publicationId,
          productionId: r.productionId,
          channelId: r.channelId,
          title: r.title,
          providerVideoId: r.providerVideoId,
          status: r.status,
          verdict,
          note,
          mismatch: isReconcileMismatch(verdict),
          // only a CURRENTLY-published record that's a confirmed phantom gets cleaned
          phantom: isConfirmedPhantom(verdict) && r.status === "published",
          recordedPublishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
          remotePublishedAt,
          dateDrift:
            drift.drifted && remotePublishedAt
              ? {
                  direction: drift.direction,
                  deltaHours: Math.round((drift.deltaMs / 3_600_000) * 10) / 10,
                  correctTo: remotePublishedAt,
                }
              : null,
        });
      }
      const mismatches = results.filter((r) => r.mismatch);
      const drifted = results.filter((r) => r.dateDrift);

      // fix mode: demote confirmed phantoms to published_unverified (WRITE). Never
      // deletes — the id is kept for history; publishedAt is cleared so the record
      // stops counting as a live video and stops blocking re-publishing.
      const cleaned: { productionId: string; title: string; providerVideoId: string | null }[] = [];
      // fix mode: correct drifted publishedAt to YouTube's real value; a BACKWARD
      // move re-triggers analytics ingest (the missed early window was empty while
      // publishedAt sat in the future). Dedupe re-ingest per channel.
      const corrected: { productionId: string; title: string; from: string | null; to: string; direction: string }[] = [];
      const reingestChannels = new Set<string>();
      if (fix) {
        for (const r of results.filter((x) => x.phantom)) {
          await db.update(productions).set({ status: "published_unverified" }).where(eq(productions.id, r.productionId));
          await db.update(publications).set({ publishedAt: null }).where(eq(publications.id, r.publicationId));
          cleaned.push({ productionId: r.productionId, title: r.title, providerVideoId: r.providerVideoId });
        }
        for (const r of drifted) {
          if (!r.dateDrift) continue;
          await db
            .update(publications)
            .set({ publishedAt: new Date(r.dateDrift.correctTo) })
            .where(eq(publications.id, r.publicationId));
          corrected.push({
            productionId: r.productionId,
            title: r.title,
            from: r.recordedPublishedAt,
            to: r.dateDrift.correctTo,
            direction: r.dateDrift.direction,
          });
          if (r.dateDrift.direction === "backward") reingestChannels.add(r.channelId);
        }
        for (const channelId of reingestChannels) {
          await inngest.send({ name: "analytics/ingest.requested", data: { channelId } });
        }
      }

      const phantomCount = results.filter((r) => r.phantom).length;
      const driftCount = drifted.length;
      const fixHints: string[] = [];
      if (!fix && phantomCount > 0)
        fixHints.push(`demote ${phantomCount} confirmed-phantom record(s) to published_unverified`);
      if (!fix && driftCount > 0)
        fixHints.push(`correct ${driftCount} drifted publishedAt date(s) to YouTube's real value`);
      return {
        checked: results.length,
        okCount: results.filter((r) => r.verdict === "ok").length,
        mismatchCount: mismatches.length,
        unknownCount: results.filter((r) => r.verdict === "unknown").length,
        phantomCount,
        driftCount,
        mismatches: mismatches.map(({ phantom, publicationId, channelId, remotePublishedAt, recordedPublishedAt, dateDrift, ...m }) => ({ ...m, phantom })),
        dateDrift: drifted.map((r) => ({
          productionId: r.productionId,
          title: r.title,
          recordedPublishedAt: r.recordedPublishedAt,
          realPublishedAt: r.remotePublishedAt,
          direction: r.dateDrift?.direction,
          deltaHours: r.dateDrift?.deltaHours,
        })),
        ...(fix
          ? {
              cleaned,
              cleanedCount: cleaned.length,
              corrected,
              correctedCount: corrected.length,
              reingestChannelCount: reingestChannels.size,
            }
          : fixHints.length > 0
            ? { fixHint: `Re-run with fix:true to ${fixHints.join(" and ")}.` }
            : {}),
        note:
          mismatches.length === 0 && driftCount === 0
            ? "Every publication resolves to a real video with a correct publish date (or the provider couldn't be reached)."
            : fix
              ? `Demoted ${cleaned.length} confirmed-phantom record(s) and corrected ${corrected.length} drifted date(s)${reingestChannels.size ? ` (re-triggered analytics ingest on ${reingestChannels.size} channel(s))` : ""}. 'unknown'/private records were left untouched.`
              : "Records flagged 'mismatch' do not correspond to a live video; 'dateDrift' rows have a stored publishedAt that disagrees with YouTube. Re-run with fix:true to clean/correct them.",
      };
    },
  },
  {
    name: "set_publication_schedule",
    description:
      "Set, change, or cancel a production's scheduled publish time over MCP (ticket 01KY9C9R…) — the scheduling control the connector was missing. YouTube-native: the video is already uploaded PRIVATE and YouTube flips it public at the slot, so this is one videos.update, not a re-upload. Pass `scheduledFor` (future ISO-8601) to set/move the slot; pass `cancel:true` to clear the schedule. #76: `cancel:true` clears the calendar slot and leaves the video uploaded + PRIVATE — it sets the production status to `published` (parked private), it does NOT reopen the thumbnail_review gate. To change the thumbnail on a scheduled/private (or live) video you don't need to cancel: regenerate_thumbnail still runs post-gate, then set_video_thumbnail pushes the chosen candidate to YouTube. Only works while the video is uploaded and NOT already public: a not-yet-uploaded production schedules at its final review gate instead, and an already-public video must be unpublished first. Mirrors the cockpit Reschedule/Cancel buttons.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        scheduledFor: { type: "string", description: "future ISO-8601 timestamp for the new slot (omit when cancel:true)" },
        cancel: { type: "boolean", description: "clear the schedule instead of setting one (video stays private)" },
      },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const cancel = args.cancel === true;
      const scheduledForRaw = str(args, "scheduledFor");
      const { db, providers } = await getAppContext();
      const [prod] = await db
        .select({ id: productions.id, channelId: productions.channelId })
        .from(productions)
        .where(eq(productions.id, productionId))
        .limit(1);
      if (!prod) throw new Error("Production not found");
      const [pub] = await db
        .select()
        .from(publications)
        .where(eq(publications.productionId, productionId))
        .orderBy(desc(publications.createdAt))
        .limit(1);
      if (!pub) throw new Error("No publication row for this production — it hasn't reached the publish/schedule stage yet.");
      if (!pub.providerVideoId)
        throw new Error("This video hasn't been uploaded yet — set its schedule at the final review gate, not here.");
      if (pub.privacyStatus === "public")
        throw new Error("This video is already public — unpublish it first if you want to (re)schedule it.");
      // #53: a videos.update replaces status wholesale, so re-send the COPPA
      // designation or a made-for-kids video loses it on (re)schedule/cancel.
      const [schedChannel] = await db
        .select({ madeForKids: channels.madeForKids })
        .from(channels)
        .where(eq(channels.id, prod.channelId))
        .limit(1);
      const madeForKids = schedChannel?.madeForKids === true;

      if (cancel) {
        if (pub.privacyStatus !== "scheduled")
          throw new Error("Only an uploaded, scheduled video can be unscheduled.");
        await providers.publish.schedule({ channelId: prod.channelId, providerVideoId: pub.providerVideoId, publishAt: null, madeForKids });
        await markScheduleCancelled(db, { publicationId: pub.id, productionId });
        await logDecision(db, prod.channelId, `Cancelled scheduled release for production ${productionId}`, {
          productionId,
          publicationId: pub.id,
          action: "cancel_schedule",
        });
        return { productionId, action: "cancelled", privacyStatus: "private", scheduledFor: null, note: "Schedule cleared — the video stays uploaded and private until an explicit release." };
      }

      if (!scheduledForRaw) throw new Error("Pass `scheduledFor` (a future ISO-8601 timestamp) to set the slot, or `cancel:true` to clear it.");
      const when = new Date(scheduledForRaw);
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now())
        throw new Error("`scheduledFor` must be a valid timestamp in the future.");
      await providers.publish.schedule({ channelId: prod.channelId, providerVideoId: pub.providerVideoId, publishAt: when.toISOString(), madeForKids });
      await db
        .update(publications)
        .set({ privacyStatus: "scheduled", scheduledFor: when, publishedAt: null })
        .where(eq(publications.id, pub.id));
      await db.update(productions).set({ status: "scheduled" }).where(eq(productions.id, productionId));
      await logDecision(db, prod.channelId, `Scheduled production ${productionId} for ${when.toISOString()}`, {
        productionId,
        publicationId: pub.id,
        action: "set_schedule",
        scheduledFor: when.toISOString(),
      });
      return { productionId, action: "scheduled", privacyStatus: "scheduled", scheduledFor: when.toISOString() };
    },
  },
  {
    name: "set_video_thumbnail",
    description:
      "#76: push a chosen thumbnail candidate to the LIVE or SCHEDULED YouTube video via thumbnails.set — a one-call swap, NOT a re-upload or a rebuild. This is how you change a thumbnail after the gate closed (the video is typically private for hours after scheduling, and swapping a thumbnail on a live video is standard practice). First add candidates with regenerate_thumbnail (which now runs post-gate); then call this with the thumbnailId to apply. Omit thumbnailId to apply the highest-predictedCtr candidate (else the most recent). The video must be uploaded (scheduled or published). Requires the youtube thumbnails.set OAuth scope. Cost is trivial (50 quota units).",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        thumbnailId: { type: "string", description: "id of a thumbnail candidate (from list_thumbnails); omit to apply the highest-predictedCtr candidate" },
      },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const thumbnailId = str(args, "thumbnailId");
      const { db, providers } = await getAppContext();
      const [prod] = await db
        .select({ id: productions.id, channelId: productions.channelId, status: productions.status })
        .from(productions)
        .where(eq(productions.id, productionId))
        .limit(1);
      if (!prod) throw new Error("Production not found");
      const [pub] = await db
        .select()
        .from(publications)
        .where(eq(publications.productionId, productionId))
        .orderBy(desc(publications.createdAt))
        .limit(1);
      if (!pub || !pub.providerVideoId)
        throw new Error("This video hasn't been uploaded to YouTube yet — there's nothing live to set a thumbnail on. Pick the thumbnail at the thumbnail_review gate instead.");

      // pick the candidate: explicit id, else the highest predicted CTR, else newest.
      const cands = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.productionId, productionId))
        .orderBy(desc(thumbnails.predictedCtr), desc(thumbnails.createdAt));
      if (!cands.length) throw new Error("No thumbnail candidates for this production — add one with regenerate_thumbnail first.");
      const chosen = thumbnailId ? cands.find((c) => c.id === thumbnailId) : cands[0];
      if (!chosen) throw new Error(`Thumbnail ${thumbnailId} not found for this production — check the id, or omit it to apply the best candidate.`);

      try {
        await providers.publish.setThumbnail({
          channelId: prod.channelId,
          productionId,
          providerVideoId: pub.providerVideoId,
          imageStorageKey: chosen.storageKey,
        });
      } catch (err) {
        throw new Error(
          `YouTube thumbnail set failed: ${err instanceof Error ? err.message : String(err)}. If it's a permission error, re-consent the channel with the youtube thumbnails.set scope on /account.`,
        );
      }
      // mark the applied candidate selected (single winner)
      await db.update(thumbnails).set({ selected: false }).where(eq(thumbnails.productionId, productionId));
      await db.update(thumbnails).set({ selected: true }).where(eq(thumbnails.id, chosen.id));
      await logDecision(db, prod.channelId, `Applied thumbnail to live video via MCP`, {
        productionId,
        thumbnailId: chosen.id,
        providerVideoId: pub.providerVideoId,
        action: "set_video_thumbnail",
      });
      return {
        productionId,
        thumbnailId: chosen.id,
        providerVideoId: pub.providerVideoId,
        note: `Thumbnail pushed to the ${prod.status === "published" ? "live" : "scheduled/private"} video on YouTube (thumbnails.set). It may take a few minutes to appear.`,
      };
    },
  },
  {
    name: "sync_publication_from_youtube",
    description:
      "Reconcile ONE production's publication record to YouTube's truth (ticket 01KY9C9R…). Use when the operator published a video MANUALLY/externally (a legitimate, recurring case) or a scheduled video went live off-slot: this pulls the real publishedAt, privacy, and — if you pass `providerVideoId` for a fully-external upload the platform never recorded — attaches the id. When YouTube reports the video PUBLIC, the record is marked published with YouTube's REAL publishedAt (never a future slot) and analytics ingest is re-triggered so the missed early window is picked up. This is the single-record complement to reconcile_publications (which sweeps all records). Requires the channel's YouTube credentials; with the mock provider it reports 'unknown' and makes no change.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        providerVideoId: { type: "string", description: "attach this YouTube id when the record has none (a fully-external upload)" },
      },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const suppliedVideoId = str(args, "providerVideoId");
      const { db, providers } = await getAppContext();
      const [prod] = await db
        .select({ id: productions.id, channelId: productions.channelId, status: productions.status })
        .from(productions)
        .where(eq(productions.id, productionId))
        .limit(1);
      if (!prod) throw new Error("Production not found");
      const [pub] = await db
        .select()
        .from(publications)
        .where(eq(publications.productionId, productionId))
        .orderBy(desc(publications.createdAt))
        .limit(1);
      if (!pub) throw new Error("No publication row for this production — nothing to sync.");
      const videoId = suppliedVideoId ?? pub.providerVideoId;
      if (!videoId)
        throw new Error("This record has no YouTube video id — pass `providerVideoId` for an externally-uploaded video.");

      let live: Awaited<ReturnType<typeof providers.publish.videoStatus>>;
      try {
        live = await providers.publish.videoStatus({ channelId: prod.channelId, providerVideoId: videoId });
      } catch (e) {
        return { productionId, changed: false, note: `Provider read failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (live.state === "unknown")
        return { productionId, changed: false, note: "Provider couldn't resolve the video (no YouTube credentials / mock mode) — no change made." };
      if (live.state === "missing")
        return { productionId, changed: false, note: `YouTube has no video with id ${videoId} — check the id, or use reconcile_publications to demote a phantom record.` };

      // Attach a newly-supplied id (external upload the platform never recorded).
      const attachedId = !pub.providerVideoId && suppliedVideoId ? suppliedVideoId : undefined;
      if (attachedId) {
        await db
          .update(publications)
          .set({ providerVideoId: attachedId, url: `https://www.youtube.com/watch?v=${attachedId}` })
          .where(eq(publications.id, pub.id));
      }

      if (live.privacyStatus !== "public") {
        // Uploaded but not public yet — reflect the id/scheduled state, don't go live.
        if (live.publishAt) {
          await db.update(publications).set({ privacyStatus: "scheduled", scheduledFor: new Date(live.publishAt) }).where(eq(publications.id, pub.id));
        }
        return {
          productionId,
          changed: Boolean(attachedId || live.publishAt),
          privacyStatus: live.privacyStatus,
          scheduledFor: live.publishAt,
          note: `Video is ${live.privacyStatus} on YouTube, not public yet — ${live.publishAt ? "scheduled state synced" : "left as-is"}. Nothing marked live.`,
        };
      }

      // Public on YouTube → mark the record live with the REAL publishedAt.
      const realPublishedAt = resolveGoLivePublishedAt({ remotePublishedAt: live.publishedAt, scheduledFor: pub.scheduledFor, now: new Date() });
      const wasAlreadyPublished = Boolean(pub.publishedAt);
      await markPublicationLive(db, {
        publicationId: pub.id,
        productionId,
        publishedAt: realPublishedAt,
        // don't re-fire post-publish events if the record was already live
        emitEvents: !wasAlreadyPublished,
      });
      // Re-trigger ingest whenever the corrected date is EARLIER than what we held
      // (or the record is newly live): the earlier window was never collected.
      const movedBackward = !wasAlreadyPublished || (pub.publishedAt != null && realPublishedAt.getTime() < new Date(pub.publishedAt).getTime());
      if (movedBackward) {
        await inngest.send({ name: "analytics/ingest.requested", data: { channelId: prod.channelId } });
      }
      await logDecision(db, prod.channelId, `Synced production ${productionId} from YouTube (marked live)`, {
        productionId,
        publicationId: pub.id,
        providerVideoId: videoId,
        action: "sync_from_youtube",
        publishedAt: realPublishedAt.toISOString(),
        previousPublishedAt: pub.publishedAt ? new Date(pub.publishedAt).toISOString() : null,
      });
      return {
        productionId,
        changed: true,
        privacyStatus: "public",
        publishedAt: realPublishedAt.toISOString(),
        previousPublishedAt: pub.publishedAt ? new Date(pub.publishedAt).toISOString() : null,
        reingestTriggered: movedBackward,
        note: wasAlreadyPublished
          ? "publishedAt corrected to YouTube's real value."
          : "Marked live from YouTube with the real publishedAt; post-publish analysis + analytics ingest triggered.",
      };
    },
  },
  {
    name: "report_issue",
    description:
      "File an issue/ticket when something goes wrong or needs the operator's or developer's attention (a stuck production, a bad result, a missing capability, a question). It's logged on the platform's Tickets page for a human to read and act on. Include enough detail to reproduce.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "one-line summary" },
        detail: { type: "string", description: "what happened, steps, ids, what you expected" },
        severity: { type: "string", enum: ["info", "warn", "error"], description: "default info" },
        channelId: { type: "string" },
        productionId: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const { db } = await getAppContext();
      const sev = (str(args, "severity") === "warn" || str(args, "severity") === "error") ? str(args, "severity")! : "info";
      const title = requireStr(args, "title").slice(0, 200);
      const detail = str(args, "detail") ?? null;
      const channelId = str(args, "channelId") ?? null;
      const productionId = str(args, "productionId") ?? null;
      const id = ulid();
      await db.insert(agentTickets).values({ id, title, detail, severity: sev as "info" | "warn" | "error", channelId, productionId, source: "mcp" });

      // Best-effort GitHub-issue mirror so the developer can read/answer directly.
      // Never fails the ticket; returns a specific note on what to configure.
      let githubUrl: string | null = null;
      let note: string;
      try {
        const body = [
          detail ?? "(no detail provided)",
          "",
          "---",
          `Filed via the YT-Auto MCP connector (report_issue). Ticket \`${id}\`, severity **${sev}**.`,
          channelId ? `Channel: \`${channelId}\`` : "",
          productionId ? `Production: \`${productionId}\`` : "",
        ].filter(Boolean).join("\n");
        const issue = await createGithubIssue(await getMergedEnv(), { title, body, labels: ["mcp-ticket", sev] });
        if (issue.ok) {
          githubUrl = issue.url;
          await db.update(agentTickets).set({ githubUrl, githubNumber: issue.number }).where(eq(agentTickets.id, id));
          note = "Logged on the Tickets page and mirrored to a GitHub issue for the developer.";
        } else if (issue.reason === "unconfigured") {
          note =
            `Logged on the cockpit Tickets page. GitHub mirroring is OFF — set \`${issue.missing}\` ` +
            "(a GitHub token with Issues:write on the repo) on the cockpit /account page to mirror " +
            "tickets to GitHub; optionally set `GITHUB_ISSUE_REPO` to target a different repo.";
        } else {
          note = `Logged on the cockpit Tickets page. GitHub mirroring is configured but failed: ${issue.detail}.`;
        }
      } catch (e) {
        note = `Logged on the cockpit Tickets page. GitHub mirror errored: ${e instanceof Error ? e.message : String(e)}.`;
      }
      return { ok: true, ticketId: id, githubUrl, note };
    },
  },
  {
    name: "list_issues",
    description:
      "List filed issues/tickets (yours and the operator's). Use to check whether something was already reported or resolved. Each ticket may carry a `resolution` — the developer's answer synced from the linked GitHub issue (body + comments); read it before deciding whether to resolve_issue. Returns an envelope { appliedStatus, count, total, tickets[] } (#62): `appliedStatus` echoes the filter that was applied (a specific status, or \"open+acknowledged\" when none was passed) so a caller can ASSERT the filter was honoured, `count` is how many tickets came back, and `total` is the board size so truncation is visible.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["open", "acknowledged", "closed"], description: "default: open + acknowledged" } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const status = str(args, "status");
      // The statuses this call is meant to return. A specific status → just that
      // one; no status → the default open+acknowledged working set.
      const wanted: ("open" | "acknowledged" | "closed")[] = status
        ? [status as "open" | "acknowledged" | "closed"]
        : ["open", "acknowledged"];
      const { db } = await getAppContext();
      const rows = await db
        .select()
        .from(agentTickets)
        .where(status ? eq(agentTickets.status, status as "open" | "acknowledged" | "closed") : or(eq(agentTickets.status, "open"), eq(agentTickets.status, "acknowledged")))
        .orderBy(desc(agentTickets.createdAt))
        .limit(500);
      // #62 (ticket 01KYEFKZ…): the operator saw list_issues(status:"closed") return
      // the whole board with rows still carrying status:"open". The SQL WHERE already
      // filters by status, but a status-filtered list that ever leaks an off-status
      // row is a reporting-integrity failure (a closed-set that hides an open COPPA
      // ticket is the worst case). So GUARANTEE the invariant in code — never return a
      // ticket whose status isn't the one asked for — rather than trust the query
      // layer alone. If the two ever disagree, this is the belt that holds.
      const matched = rows.filter((r) => wanted.includes(r.status));
      const [totals] = await db.select({ total: sql<number>`count(*)` }).from(agentTickets);
      const total = Number(totals?.total ?? 0);
      return {
        appliedStatus: status ?? "open+acknowledged",
        count: matched.length,
        total,
        tickets: matched.map((r) => ({ id: r.id, title: r.title, detail: r.detail, severity: r.severity, status: r.status, channelId: r.channelId, productionId: r.productionId, githubUrl: r.githubUrl, resolution: r.resolution, createdAt: r.createdAt })),
      };
    },
  },
  {
    name: "resolve_issue",
    description: "Set a ticket's status: open (reopen a wrongly-closed one), acknowledged (in progress / seen), or closed (done). Reopen exists so a ticket closed prematurely can be corrected (ticket 01KY22PV…).",
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "string" }, status: { type: "string", enum: ["open", "acknowledged", "closed"] } },
      required: ["ticketId", "status"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const ticketId = requireStr(args, "ticketId");
      const status = requireStr(args, "status");
      if (status !== "open" && status !== "acknowledged" && status !== "closed") {
        throw new Error("status must be open, acknowledged, or closed");
      }
      const { db } = await getAppContext();
      await db.update(agentTickets).set({ status }).where(eq(agentTickets.id, ticketId));
      return { ok: true, ticketId, status };
    },
  },
  {
    name: "append_to_issue",
    description:
      "Add evidence or a follow-up to an EXISTING ticket (ticket 01KY6FGE…) — posts a comment on the linked GitHub issue so a new instance of a KNOWN defect lands on the open ticket instead of spawning a near-duplicate. Use this (after list_issues shows the defect is already filed) rather than report_issue for anything that's more data on an existing report. Needs the ticket to have been mirrored to GitHub (check githubUrl on list_issues).",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "the ticket id from report_issue / list_issues" },
        detail: { type: "string", description: "the evidence/follow-up to append (markdown ok)" },
      },
      required: ["ticketId", "detail"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const ticketId = requireStr(args, "ticketId");
      const detail = requireStr(args, "detail");
      const { db } = await getAppContext();
      const [ticket] = await db.select().from(agentTickets).where(eq(agentTickets.id, ticketId));
      if (!ticket) throw new Error(`Ticket ${ticketId} not found — check the id via list_issues.`);
      if (ticket.githubNumber == null) {
        throw new Error(
          `Ticket ${ticketId} has no linked GitHub issue (mirroring was off when it was filed), so there's nowhere to append. Configure GitHub mirroring on /account, or file with report_issue.`,
        );
      }
      const body = [
        detail,
        "",
        "---",
        `Appended via the YT-Auto MCP connector (append_to_issue). Ticket \`${ticketId}\`.`,
      ].join("\n");
      const res = await commentOnGithubIssue(await getMergedEnv(), { issueNumber: ticket.githubNumber, body });
      if (!res.ok) {
        throw new Error(
          res.reason === "unconfigured"
            ? `GitHub mirroring is off — set \`${res.missing}\` on /account to append to issues.`
            : `Couldn't append to GitHub issue #${ticket.githubNumber}: ${res.detail}.`,
        );
      }
      return { ok: true, ticketId, githubNumber: ticket.githubNumber, commentUrl: res.url, note: "Appended as a comment on the linked GitHub issue." };
    },
  },
  // ── Background music (2026-07-26 operator: "open the music to the mcp") ──────
  // Two scopes: the CHANNEL BED is a reusable pool of ~8 tracks the render
  // rotates through (least-recently-used first) so a channel keeps a consistent
  // sound; a PRODUCTION track is the bed for one video only. get_music reads
  // both; set_music_bed edits the channel pool; set_production_music picks the
  // track for one video; generate_music makes a paid AI bed for one video.
  {
    name: "get_music",
    description:
      "Read a production's music: the resolved musicMood, the channel's reusable music BED (bedTarget tracks the render rotates through least-recently-used first for a consistent channel sound), and this production's candidate tracks (which one is selected for the render). Use before set_production_music / set_music_bed.",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
      if (!production) throw new Error(`Production ${productionId} not found.`);
      const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
      const profile = resolveProductionProfile(production.productionProfile ?? dna?.productionProfile ?? null);
      const bed = await listChannelBed(db, production.channelId);
      const candidates = await db
        .select()
        .from(productionMusic)
        .where(eq(productionMusic.productionId, productionId))
        .orderBy(desc(productionMusic.createdAt));
      const selected = candidates.find((c) => c.selected) ?? null;
      return {
        productionId,
        channelId: production.channelId,
        musicMood: profile.musicMood ?? null,
        bedTarget: CHANNEL_BED_TARGET,
        bed: bed.map((t) => ({
          id: t.id,
          storageKey: t.storageKey,
          name: t.name,
          mood: t.mood,
          source: t.source,
          license: t.license,
          durationSec: t.durationSec,
          lastUsedAt: t.lastUsedAt,
        })),
        candidates: candidates.map((c) => ({
          id: c.id,
          storageKey: c.storageKey,
          name: c.name,
          mood: c.mood,
          engine: c.engine,
          durationSec: c.durationSec,
          selected: c.selected,
        })),
        selectedTrack: selected ? { id: selected.id, name: selected.name, storageKey: selected.storageKey } : null,
      };
    },
  },
  {
    name: "search_free_music",
    description:
      "Search Openverse for free, Creative-Commons background music. Returns tracks[] {id,title,audioUrl,pageUrl,creator,license,durationSec}. Pass a returned track object straight into set_music_bed (addOpenverseTrack) to add it to a channel's bed, or into set_production_music (useOpenverseTrack) for one video. (Unavailable in mock mode.)",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "e.g. 'calm ambient piano', 'upbeat synthwave'" } },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const query = requireStr(args, "query");
      const res = await searchOpenverseMusicAction(query);
      if (res.error) throw new Error(res.error);
      return { query, tracks: res.tracks ?? [] };
    },
  },
  {
    name: "set_music_bed",
    description:
      "Edit a CHANNEL's reusable music bed (the ~8-track pool the render rotates through for every video on the channel). Exactly one operation per call: addOpenverseTrack (a track object from search_free_music, optional mood) to import a free track; addProductionStorageKey to promote a production's track into the bed; or removeBedTrackId to drop one. Returns the updated bed.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        addOpenverseTrack: OPENVERSE_TRACK_SCHEMA,
        mood: { type: "string", description: "optional mood label for addOpenverseTrack" },
        addProductionStorageKey: {
          type: "string",
          description: "storageKey of a production track (from get_music candidates) to promote into the bed",
        },
        removeBedTrackId: { type: "string", description: "bed track id (from get_music bed[]) to remove" },
      },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const { db } = await getAppContext();
      const ops = ["addOpenverseTrack", "addProductionStorageKey", "removeBedTrackId"].filter((k) => args[k] != null);
      if (ops.length !== 1) {
        throw new Error("Pass exactly one of: addOpenverseTrack, addProductionStorageKey, removeBedTrackId.");
      }
      const action = ops[0]!;
      if (args.addOpenverseTrack != null) {
        const track = parseOpenverseTrack(args, "addOpenverseTrack");
        const res = await addOpenverseTrackToBedAction(channelId, track, str(args, "mood"));
        if (res.error) throw new Error(res.error);
      } else if (args.addProductionStorageKey != null) {
        const res = await addProductionTrackToBedAction(channelId, requireStr(args, "addProductionStorageKey"));
        if (res.error) throw new Error(res.error);
      } else {
        const res = await removeBedTrackAction(channelId, requireStr(args, "removeBedTrackId"));
        if (res.error) throw new Error(res.error);
      }
      const bed = await listChannelBed(db, channelId);
      return {
        channelId,
        action,
        bedTarget: CHANNEL_BED_TARGET,
        bedCount: bed.length,
        bed: bed.map((t) => ({ id: t.id, storageKey: t.storageKey, name: t.name, mood: t.mood, source: t.source, license: t.license })),
      };
    },
  },
  {
    name: "set_production_music",
    description:
      "Pick the background track for ONE video (does not touch the channel bed). Exactly one operation per call: selectCandidateId to select an existing candidate; useBedStorageKey to pull a channel-bed track in; useLibraryStorageKey to reuse a previously generated track from any video; or useOpenverseTrack (a track object from search_free_music) for a one-off free track. Returns the newly selected track.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        selectCandidateId: { type: "string", description: "id of an existing candidate (from get_music) to select" },
        useBedStorageKey: { type: "string", description: "storageKey of a channel-bed track (from get_music bed[])" },
        useLibraryStorageKey: { type: "string", description: "storageKey of a prior generated track to reuse on this video" },
        useOpenverseTrack: OPENVERSE_TRACK_SCHEMA,
      },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const ops = ["selectCandidateId", "useBedStorageKey", "useLibraryStorageKey", "useOpenverseTrack"].filter(
        (k) => args[k] != null,
      );
      if (ops.length !== 1) {
        throw new Error("Pass exactly one of: selectCandidateId, useBedStorageKey, useLibraryStorageKey, useOpenverseTrack.");
      }
      const action = ops[0]!;
      if (args.selectCandidateId != null) {
        const res = await selectMusicAction(productionId, requireStr(args, "selectCandidateId"));
        if (res.error) throw new Error(res.error);
      } else if (args.useBedStorageKey != null) {
        const res = await useBedTrackForProductionAction(productionId, requireStr(args, "useBedStorageKey"));
        if (res.error) throw new Error(res.error);
      } else if (args.useLibraryStorageKey != null) {
        const res = await useLibraryTrackAction(productionId, requireStr(args, "useLibraryStorageKey"));
        if (res.error) throw new Error(res.error);
      } else {
        const track = parseOpenverseTrack(args, "useOpenverseTrack");
        const res = await useOpenverseTrackForProductionAction(productionId, track);
        if (res.error) throw new Error(res.error);
      }
      const [selected] = await db
        .select()
        .from(productionMusic)
        .where(and(eq(productionMusic.productionId, productionId), eq(productionMusic.selected, true)))
        .limit(1);
      return {
        productionId,
        action,
        selectedTrack: selected
          ? { id: selected.id, name: selected.name, storageKey: selected.storageKey, engine: selected.engine }
          : null,
      };
    },
  },
  {
    name: "generate_music",
    description:
      "Generate a NEW AI background-music bed for ONE video (paid — ElevenLabs). Sizes the track to the voiceover and uses the given mood (or the channel default). The first candidate on a production auto-selects. Prefer set_production_music with a channel-bed or free track first — this spends money. Returns the new candidate id.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        mood: { type: "string", description: "e.g. 'tense cinematic'; omit to use the channel's default mood" },
      },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const res = await generateMusicCandidateAction(productionId, str(args, "mood"));
      if (res.error) throw new Error(res.error);
      return { productionId, candidateId: res.id, note: "Generated and (if it's the first) selected as the render's bed." };
    },
  },
  // ── Production lifecycle & recovery (2026-07-28: parity audit) ───────────────
  // An agent could AUTHOR a production but not recover one — halt/resume/retry/
  // force-forward/retire/corrected-copy were cockpit-only. Gate DECISIONS stay
  // human (approve/reject/revise is the editorial-judgement record); these are
  // the pre-/post-decision lifecycle controls the cockpit already exposes.
  {
    name: "halt_production",
    description:
      "Cancel an in-flight production and hand its idea back to the pool, keeping a halted draft (the cockpit Halt button). Optionally DISCARD artifact groups you don't want reused on resume: script/voiceover/images/render/thumbnails (omit to keep everything). Use to stop a run that's going wrong; resume_production later reuses what survived. Does NOT touch a published video (use retire_production / correct_published_production for those).",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        discard: { type: "array", items: { type: "string", enum: ["script", "voiceover", "images", "render", "thumbnails"] }, description: "artifact groups to drop so resume regenerates them; omit to keep all" },
      },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const discard = Array.isArray(args.discard)
        ? (args.discard.filter((d): d is HaltDiscard => typeof d === "string" && ["script", "voiceover", "images", "render", "thumbnails"].includes(d)))
        : [];
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      await haltProductionAction(productionId, discard);
      await logDecision(db, prod.channelId, `Halted production via MCP`, { productionId, discard });
      return { productionId, status: "halted", discarded: discard, note: "Production halted; the idea is back in the pool. Use resume_production to restart it (reusing what wasn't discarded)." };
    },
  },
  {
    name: "resume_production",
    description:
      "Restart a HALTED production as a fresh production, reusing whatever script/media survived the halt and skipping the script gate (the cockpit Resume button). Returns the NEW productionId — track that one from here.",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string", description: "the halted production's id" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId, status: productions.status }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      if (prod.status !== "halted") throw new Error(`resume_production only restarts a halted production; this one is ${prod.status}.`);
      const newProductionId = await runExpectingRedirect(() => resumeProductionAction(productionId));
      await logDecision(db, prod.channelId, `Resumed production via MCP`, { fromProductionId: productionId, newProductionId });
      return { fromProductionId: productionId, newProductionId, note: "Resumed as a new production — track the newProductionId from here (the old halted row stays as history)." };
    },
  },
  {
    name: "retry_production",
    description:
      "Re-run a production FROM a stage without re-authoring — script | visuals | render | publish (the cockpit per-stage Retry / 'Regenerate all beat visuals'). 'visuals' regenerates every beat image and reopens the visuals gate — the agent-usable way to redo the whole storyboard (per-shot fixes are regenerate_shot). Use to recover a stuck/failed stage or to force a fresh pass.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        stage: { type: "string", enum: ["script", "visuals", "render", "publish"], description: "the stage to re-run from" },
      },
      required: ["productionId", "stage"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const stage = requireStr(args, "stage") as RetryStage;
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      const res = await retryFromStageAction(productionId, stage);
      if (res.error) throw new Error(res.error);
      await logDecision(db, prod.channelId, `Retried production from ${stage} via MCP`, { productionId, stage });
      return { productionId, stage, note: `Re-running from ${stage}. Poll get_production for status; ${stage === "visuals" ? "it will stop at the visuals gate for review" : "it flows through the normal gates"}.` };
    },
  },
  {
    name: "force_forward",
    description:
      "Un-stick a BLOCKED production (status on_hold / failed / rejected) and resume it in place, waiving the soft checks that halted it (the cockpit Force-forward). Use when you've judged the block a false positive. Only applies to on_hold/failed/rejected — not a way past a human gate decision.",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId, status: productions.status }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      await forceForwardAction(productionId);
      await logDecision(db, prod.channelId, `Force-forwarded blocked production via MCP`, { productionId, fromStatus: prod.status });
      return { productionId, note: "Force-forwarded — the production resumes past the soft check that blocked it. Poll get_production." };
    },
  },
  {
    name: "retire_production",
    description:
      "Archive a production (terminal 'retired' — hidden from lists, any pending gate cancelled). Does NOT touch a live YouTube video (it stays up). Use to clear a dead/abandoned production from the board. Distinct from correct_published_production (which mints a fixed copy).",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      const res = await retireProductionAction(productionId);
      if (res.error) throw new Error(res.error);
      await logDecision(db, prod.channelId, `Retired production via MCP`, { productionId });
      return { productionId, status: "retired", note: "Retired and hidden from the board; any live YouTube video is untouched." };
    },
  },
  {
    name: "correct_published_production",
    description:
      "Mint a CORRECTED COPY of a published/scheduled production — the 'corrected copy' path the guide kept pointing at. mode 'fix' (default) reuses everything (script, voiceover, stills, clips) and lands at the visuals gate to swap what's wrong; mode 'rebuild' keeps the approved script but regenerates ALL visuals. Both skip the script gate. The ORIGINAL live video is left alone (deleting it stays a human action in the cockpit). Returns the new productionId.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string", description: "the published/scheduled production to correct" },
        mode: { type: "string", enum: ["fix", "rebuild"], description: "'fix' reuses all assets (default); 'rebuild' regenerates all visuals from the approved script" },
      },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const mode = str(args, "mode") === "rebuild" ? "rebuild" : "fix";
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId, status: productions.status }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      if (!["published", "scheduled"].includes(prod.status)) {
        throw new Error(`correct_published_production only corrects a published/scheduled production; this one is ${prod.status}. For an in-flight run use retry_production or resume_production.`);
      }
      const newProductionId = await runExpectingRedirect(() => correctPublishedProductionAction(productionId, false, mode));
      await logDecision(db, prod.channelId, `Made corrected copy (${mode}) via MCP`, { fromProductionId: productionId, newProductionId, mode });
      return { fromProductionId: productionId, newProductionId, mode, note: `Corrected copy created (${mode}) — it lands at the visuals gate for review. The original live video is untouched; delete it in the cockpit if you want to replace it.` };
    },
  },
  {
    name: "release_publication",
    description:
      "Publish an uploaded-but-private video NOW (flip it public immediately) — the cockpit Release button. Works on a video sitting SCHEDULED (releases it now and clears its future YouTube slot in the same call) OR one parked private. The immediate counterpart to set_publication_schedule (which sets/moves a future slot). The channel's Made-for-Kids (COPPA) designation is preserved on go-live. Outward-facing: it makes the video live. Fails if the video is already public or not yet uploaded.",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      const [pub] = await db.select().from(publications).where(eq(publications.productionId, productionId)).orderBy(desc(publications.createdAt)).limit(1);
      if (!pub) throw new Error("No publication row for this production — it hasn't reached the publish stage yet.");
      const res = await releasePublicationAction(pub.id);
      if (res.error) throw new Error(res.error);
      await logDecision(db, prod.channelId, `Released publication NOW via MCP`, { productionId, publicationId: pub.id });
      return { productionId, publicationId: pub.id, note: "Released — the video is now public on YouTube (may take a moment to reflect)." };
    },
  },
  {
    name: "greenlight_idea",
    description:
      "Send an existing backlog idea straight into production (the cockpit Greenlight). Use when an idea is ready to produce and you're NOT hand-authoring the script (author_script is the authored path; write_idea can greenlight on create). Set allowDuplicate:true to override the guard when the idea already published a video (a deliberate second upload).",
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string" },
        allowDuplicate: { type: "boolean", description: "greenlight even though this idea already has a live published video" },
      },
      required: ["ideaId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const ideaId = requireStr(args, "ideaId");
      const allowDuplicate = args.allowDuplicate === true;
      const { db } = await getAppContext();
      const [idea] = await db.select({ channelId: ideas.channelId, title: ideas.title }).from(ideas).where(eq(ideas.id, ideaId));
      if (!idea) throw new Error("Idea not found");
      if (allowDuplicate) await greenlightAllowDuplicateAction(ideaId);
      else await greenlightAction(ideaId);
      await logDecision(db, idea.channelId, `Greenlit idea via MCP`, { ideaId, allowDuplicate });
      return { ideaId, note: `Greenlit "${idea.title}" — a production has started. Track it via list_productions / get_production.` };
    },
  },
  {
    name: "dedupe_shot_images",
    description:
      "One-click de-dupe of reused REAL photos across a production's shots at the visuals gate (the cockpit De-dupe button) — re-sources fresh archival images for shots that share a photo with another shot, so the same picture doesn't repeat. Run before approving the visuals gate on a real-footage/mixed channel. Complements get_production_shots' duplicateRiskGroups (which just reports them).",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      const res = (await dedupeRealImagesAction(productionId)) as { error?: string; replaced?: number } | void;
      if (res && res.error) throw new Error(res.error);
      const replaced = (res && res.replaced) ?? undefined;
      await logDecision(db, prod.channelId, `De-duped real shot images via MCP`, { productionId, replaced });
      return { productionId, ...(replaced != null ? { replaced } : {}), note: "Re-sourced fresh archival photos for duplicate real shots. Re-read get_production_shots to confirm duplicateRiskGroups shrank." };
    },
  },
  {
    name: "fill_thin_prompts",
    description:
      "Fill every THIN/empty image prompt on a production with an AI-elaborated one (the cockpit 'Fill prompts') — so no shot falls back to a bare/derived prompt before render. #83: ASYNC — this QUEUES a worker job and returns a `jobId` immediately (the pass fans out over an LLM and would otherwise outlive the MCP timeout). Poll `get_job(jobId)` for status, or re-read `get_production_shots` once it's done. Use after authoring when some beats were left with sparse imagePrompts.",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      // #83: enqueue the durable worker job (op already handled by shot-op.ts) and
      // return its id — instead of running the LLM pass inline and timing out. The
      // caller polls get_job(jobId); no held-open connection, no ambiguous timeout.
      const res = await queueShotOpAction(productionId, "fill-prompts");
      if (res.error) throw new Error(res.error);
      await logDecision(db, prod.channelId, `Queued fill-thin-prompts via MCP`, { productionId, jobId: res.jobId });
      return {
        productionId,
        jobId: res.jobId,
        status: "running",
        note: "Queued a worker pass to elaborate thin/empty image prompts. Poll get_job(jobId) for status, then re-read get_production_shots to see the filled prompts.",
      };
    },
  },
  {
    name: "get_job",
    description:
      "#83: poll a background worker job by its `jobId` (returned by async tools like fill_thin_prompts). Returns `status` (queued | running | done | failed), the `op`, timestamps, and `error` if it failed. Poll this instead of retrying the original call — a retry on a timeout is what double-bills. Read-only.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const jobId = requireStr(args, "jobId");
      const { db } = await getAppContext();
      const [job] = await db.select().from(shotJobs).where(eq(shotJobs.id, jobId)).limit(1);
      if (!job) throw new Error("Job not found — check the jobId returned by the tool that queued it.");
      return {
        jobId: job.id,
        productionId: job.productionId,
        op: job.op,
        status: job.status,
        error: job.error ?? null,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        detail: job.detail ?? null,
      };
    },
  },
  {
    name: "run_trend_scan",
    description:
      "Trigger the trend fast-lane scan (the cockpit ideas-page Scan) — pulls timely trend-driven idea candidates into the backlog across channels, distinct from run_market_scan (the broader market-intel engine). No arguments. Use to refresh the idea pool on demand.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      await scanTrendsAction();
      return { note: "Trend scan kicked off — new candidates land in the backlog. Read list_ideas shortly to see them." };
    },
  },
  {
    name: "run_analytics_ingest",
    description:
      "Kick the analytics ingest now, outside its 6-hourly cron — pulls the latest YouTube analytics into the platform so get_video_analytics / get_channel_analytics reflect current data (subject to YouTube's own 24-72h reporting lag). Use to refresh before reading analytics, or to verify a fix that's gated on the next ingest cycle. No arguments — ingests all channels.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      await runIngestNowAction();
      return { note: "Analytics ingest requested. Re-read get_video_analytics / get_channel_analytics after it completes; YouTube's 24-72h reporting lag still applies to brand-new videos." };
    },
  },
  {
    name: "ack_alert",
    description:
      "Acknowledge (clear) a diagnostics alert by id — the ids come from get_diagnostics' openAlerts. Use to dismiss an alert you've handled or judged a false positive so it stops showing as open.",
    inputSchema: {
      type: "object",
      properties: { alertId: { type: "string", description: "alert id from get_diagnostics openAlerts" } },
      required: ["alertId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const alertId = requireStr(args, "alertId");
      await ackAlertAction(alertId);
      return { alertId, status: "acked", note: "Alert acknowledged — it no longer shows as open in get_diagnostics." };
    },
  },
  // ── Playbook writes (get_playbook was read-only) ────────────────────────────
  {
    name: "add_playbook_entry",
    description:
      "Add a standing DIRECTIVE to a channel's playbook — a durable rule the agents honour on every future production (get_playbook reads them; this writes one). Operator-authored entries are adopted immediately. scope: hook | pacing | structure | visual | topic | title. Use to codify a learning ('open on the strongest visual', 'keep episodes 41-59 min') so it persists across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        directive: { type: "string", description: "the standing rule, <=300 chars" },
        scope: { type: "string", enum: ["hook", "pacing", "structure", "visual", "topic", "title"], description: "which axis it governs (default structure)" },
      },
      required: ["channelId", "directive"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const directive = requireStr(args, "directive");
      const scope = str(args, "scope") ?? "structure";
      const { db } = await getAppContext();
      const [ch] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId));
      if (!ch) throw new Error("Channel not found");
      const fd = new FormData();
      fd.set("channelId", channelId);
      fd.set("directive", directive);
      fd.set("scope", scope);
      await addPlaybookEntryAction(fd);
      await logDecision(db, channelId, `Added playbook directive via MCP`, { scope, directive: directive.slice(0, 120) });
      return { channelId, scope, note: "Playbook directive added (adopted). It now steers every future production; read it back with get_playbook." };
    },
  },
  {
    name: "adopt_playbook_entry",
    description:
      "Promote a TRIAL playbook directive to adopted (from get_playbook's trial entries) — make an agent-proposed, on-probation rule permanent. entryId comes from get_playbook.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" }, entryId: { type: "string" } },
      required: ["channelId", "entryId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const entryId = requireStr(args, "entryId");
      const { db } = await getAppContext();
      await adoptPlaybookEntryAction(channelId, entryId);
      await logDecision(db, channelId, `Adopted playbook directive via MCP`, { entryId });
      return { channelId, entryId, status: "adopted", note: "Directive promoted to adopted — it now applies to every production." };
    },
  },
  {
    name: "retire_playbook_entry",
    description:
      "Retire a playbook directive so it no longer steers productions (from get_playbook). Use to remove a rule that's no longer wanted or that a retro superseded. entryId comes from get_playbook.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" }, entryId: { type: "string" } },
      required: ["channelId", "entryId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const entryId = requireStr(args, "entryId");
      const { db } = await getAppContext();
      await retirePlaybookEntryAction(channelId, entryId);
      await logDecision(db, channelId, `Retired playbook directive via MCP`, { entryId });
      return { channelId, entryId, status: "retired", note: "Directive retired — it no longer steers productions." };
    },
  },
  // ── Series / episode editorial + in-gate script edit (2026-07-28 batch A) ────
  // update_series/set_episode_status flip status; these are the heavier editorial
  // operations the cockpit Plan tab exposes. Episode/series ids come from list_series.
  {
    name: "revise_series",
    description:
      "Re-plan a story arc from natural-language instructions (the cockpit 'Revise arc') — heavier than update_series (which just renames/reorders/flips status): this re-runs the series planner LLM to rework episodes per your steer. seriesId from list_series. Returns the revised title + episode count.",
    inputSchema: {
      type: "object",
      properties: {
        seriesId: { type: "string" },
        instructions: { type: "string", description: "what to change about the arc (e.g. 'merge episodes 3-4, add a finale on X')" },
      },
      required: ["seriesId", "instructions"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const seriesId = requireStr(args, "seriesId");
      const instructions = requireStr(args, "instructions");
      const { db } = await getAppContext();
      const [s] = await db.select({ channelId: series.channelId }).from(series).where(eq(series.id, seriesId));
      if (!s) throw new Error("Series not found");
      const res = await reviseSeriesAction(seriesId, instructions);
      if (res.error) throw new Error(res.error);
      await logDecision(db, s.channelId, `Revised series via MCP`, { seriesId, instructions: instructions.slice(0, 120) });
      return { seriesId, title: res.title, episodeCount: res.episodeCount, note: "Arc re-planned. Read it back with list_series." };
    },
  },
  {
    name: "cut_episode",
    description:
      "Cut (remove) a planned episode from a story arc (the cockpit Cut). episodeId from list_series. Optional notes record why. Use restore_episode_research to bring it back, or replace_episode to swap in a fresh one.",
    inputSchema: {
      type: "object",
      properties: {
        episodeId: { type: "string" },
        notes: { type: "string", description: "optional reason" },
      },
      required: ["episodeId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const episodeId = requireStr(args, "episodeId");
      const notes = str(args, "notes");
      const { db } = await getAppContext();
      const [ep] = await db.select({ channelId: episodes.channelId }).from(episodes).where(eq(episodes.id, episodeId));
      if (!ep) throw new Error("Episode not found");
      const res = await cutEpisodeAction(episodeId, notes);
      if (res.error) throw new Error(res.error);
      await logDecision(db, ep.channelId, `Cut episode via MCP`, { episodeId, ...(notes ? { notes } : {}) });
      return { episodeId, status: "cut", note: "Episode cut from the arc. restore_episode_research brings it back; replace_episode swaps in a new one." };
    },
  },
  {
    name: "replace_episode",
    description:
      "Replace a planned episode with a fresh LLM-generated one that fills the same slot in the arc (the cockpit Replace) — use when an episode's angle isn't working. episodeId from list_series. Optional steer guides the replacement. Returns the replacement title.",
    inputSchema: {
      type: "object",
      properties: {
        episodeId: { type: "string" },
        steer: { type: "string", description: "optional direction for the replacement" },
      },
      required: ["episodeId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const episodeId = requireStr(args, "episodeId");
      const steer = str(args, "steer");
      const { db } = await getAppContext();
      const [ep] = await db.select({ channelId: episodes.channelId }).from(episodes).where(eq(episodes.id, episodeId));
      if (!ep) throw new Error("Episode not found");
      const res = await replaceEpisodeAction(episodeId, steer);
      if (res.error) throw new Error(res.error);
      await logDecision(db, ep.channelId, `Replaced episode via MCP`, { episodeId, ...(steer ? { steer: steer.slice(0, 120) } : {}) });
      return { episodeId, replacementTitle: res.replacementTitle, note: "Episode replaced. Read the arc with list_series." };
    },
  },
  {
    name: "regreenlight_episode",
    description:
      "Re-greenlight an episode from scratch (the cockpit Re-greenlight) — mints a fresh production for an episode whose prior production was abandoned/failed. episodeId from list_series (the episode must already have been handed to the idea pool).",
    inputSchema: {
      type: "object",
      properties: { episodeId: { type: "string" } },
      required: ["episodeId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const episodeId = requireStr(args, "episodeId");
      const { db } = await getAppContext();
      const [ep] = await db.select({ channelId: episodes.channelId }).from(episodes).where(eq(episodes.id, episodeId));
      if (!ep) throw new Error("Episode not found");
      const res = await regreenlightEpisodeAction(episodeId);
      if (res.error) throw new Error(res.error);
      await logDecision(db, ep.channelId, `Re-greenlit episode via MCP`, { episodeId });
      return { episodeId, note: "Re-greenlit — a fresh production started for this episode. Track it via list_productions." };
    },
  },
  {
    name: "restore_episode_research",
    description:
      "Restore a CUT episode back into the arc's research/planning (the cockpit Restore) — the inverse of cut_episode. episodeId from list_series.",
    inputSchema: {
      type: "object",
      properties: { episodeId: { type: "string" } },
      required: ["episodeId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const episodeId = requireStr(args, "episodeId");
      const { db } = await getAppContext();
      const [ep] = await db.select({ channelId: episodes.channelId }).from(episodes).where(eq(episodes.id, episodeId));
      if (!ep) throw new Error("Episode not found");
      const res = await restoreEpisodeResearchAction(episodeId);
      if (res.error) throw new Error(res.error);
      await logDecision(db, ep.channelId, `Restored cut episode via MCP`, { episodeId });
      return { episodeId, note: "Episode restored to the arc." };
    },
  },
  {
    name: "run_editorial_plan",
    description:
      "Kick the editorial planner for a channel (the cockpit Plan tab 'Run planner') — the agent that researches the niche and proposes story arcs / episodes. Use to refresh the plan. Runs on the worker; read the result with list_series shortly after.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" } },
      required: ["channelId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const { db } = await getAppContext();
      const [ch] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId));
      if (!ch) throw new Error("Channel not found");
      await runEditorialPlanAction(channelId);
      await logDecision(db, channelId, `Ran editorial planner via MCP`, { channelId });
      return { channelId, note: "Editorial planner kicked off — proposed arcs/episodes land shortly. Read list_series to see them." };
    },
  },
  {
    name: "edit_script_beats",
    description:
      "Edit the spoken NARRATION text of a production's beats at the SCRIPT gate (the cockpit script editor) — pass `texts`, one string per beat in order, replacing each beat's narration and rebuilding the voiceover/render. The production must be at the script_review gate (this is an in-gate edit, distinct from author_script which writes a whole new production). Use to fix wording before the voiceover is cut.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        texts: { type: "array", items: { type: "string" }, description: "new spoken text per beat, in order (length should match the beat count)" },
      },
      required: ["productionId", "texts"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const texts = Array.isArray(args.texts) ? args.texts.filter((t): t is string => typeof t === "string") : [];
      if (!texts.length) throw new Error("Pass `texts`: one narration string per beat, in order.");
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      const res = await saveScriptBeatsAction(productionId, texts);
      if (res.error) throw new Error(res.error);
      await logDecision(db, prod.channelId, `Edited script beats via MCP`, { productionId, beatCount: texts.length });
      return { productionId, beatCount: texts.length, note: "Beat narration updated at the script gate; the voiceover/render will rebuild. Approve the script gate in the cockpit when ready." };
    },
  },
  // ── Thumbnail candidates, style, audio, intel (2026-07-28 batch B) ───────────
  {
    name: "list_thumbnails",
    description:
      "List a production's thumbnail CANDIDATES with their ids — so you can pick one for set_video_thumbnail or refine one with refine_thumbnail (the ids weren't readable over MCP before). Each: id, url (served from /api/media), predictedCtr (may be null), selected (the applied one), sourced (true = a real archival photo from #74), attribution.",
    inputSchema: {
      type: "object",
      properties: { productionId: { type: "string" } },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const { db } = await getAppContext();
      const [prod] = await db.select({ id: productions.id }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      const rows = await db.select().from(thumbnails).where(eq(thumbnails.productionId, productionId)).orderBy(desc(thumbnails.predictedCtr), desc(thumbnails.createdAt));
      return {
        productionId,
        count: rows.length,
        thumbnails: rows.map((t) => {
          const meta = (t.meta ?? {}) as Record<string, unknown>;
          return {
            id: t.id,
            url: `/api/media/${t.storageKey}`,
            predictedCtr: t.predictedCtr,
            selected: t.selected,
            sourced: meta.sourced === true,
            prompt: typeof meta.prompt === "string" ? meta.prompt : null,
            engine: typeof meta.engine === "string" ? meta.engine : typeof meta.source === "string" ? meta.source : null,
            ...(typeof meta.attribution === "string" ? { attribution: meta.attribution } : {}),
            createdAt: t.createdAt,
          };
        }),
      };
    },
  },
  {
    name: "refine_thumbnail",
    description:
      "Refine an EXISTING thumbnail candidate with change instructions (the cockpit thumbnail-studio Tweak) — edits the chosen candidate ('make the type bigger', 'warmer sky', 'move the plane left') rather than rerolling from scratch. thumbnailId from list_thumbnails. Optionally cast a characterId (from list_characters). Adds the refined result as a new candidate; the gate stays open. Cost appends.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        thumbnailId: { type: "string", description: "candidate id from list_thumbnails" },
        changes: { type: "string", description: "the edit to apply, in plain language" },
        characterId: { type: "string", description: "optional: cast a recurring character (from list_characters)" },
      },
      required: ["productionId", "thumbnailId", "changes"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const thumbnailId = requireStr(args, "thumbnailId");
      const changes = requireStr(args, "changes");
      const characterId = str(args, "characterId");
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      const res = await refineThumbnailAction(productionId, thumbnailId, { changes, ...(characterId ? { characterId } : {}) });
      if (res.error) throw new Error(res.error);
      await logDecision(db, prod.channelId, `Refined thumbnail via MCP`, { productionId, thumbnailId, changes: changes.slice(0, 120) });
      return { productionId, added: res.added ?? 0, ...(res.warning ? { warning: res.warning } : {}), note: "Refined candidate added — see list_thumbnails; the gate stays open. Apply with set_video_thumbnail (post-gate) or pick it at the gate." };
    },
  },
  {
    name: "promote_test_scene",
    description:
      "Adopt a style test scene as the channel's active visual STYLE (the cockpit 'Promote') — locks the look you validated with generate_test_scene/refine_test_scene into the channel so every future production renders in it. sceneId from list_test_scenes.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" }, sceneId: { type: "string" } },
      required: ["channelId", "sceneId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const sceneId = requireStr(args, "sceneId");
      const { db } = await getAppContext();
      const [ch] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId));
      if (!ch) throw new Error("Channel not found");
      await promoteTestSceneAction(channelId, sceneId);
      await logDecision(db, channelId, `Promoted test scene to channel style via MCP`, { sceneId });
      return { channelId, sceneId, note: "Test scene promoted — its look is now the channel's active style and steers every future render." };
    },
  },
  {
    name: "set_audio_levels",
    description:
      "Set a production's audio MIX — voiceVolume and musicVolume (linear gain, 0-1.5 for voice / 0-1 for music) — and re-render with the new levels (the cockpit Audio panel). Use when the music sits too loud under the narration or the voice is thin. Overrides the channel's default ducking for THIS video.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        voiceVolume: { type: "number", description: "voiceover gain, 0-1.5 (1 = full)" },
        musicVolume: { type: "number", description: "music-bed gain, 0-1 (0 = no bed)" },
      },
      required: ["productionId", "voiceVolume", "musicVolume"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const voiceVolume = typeof args.voiceVolume === "number" ? args.voiceVolume : NaN;
      const musicVolume = typeof args.musicVolume === "number" ? args.musicVolume : NaN;
      if (!Number.isFinite(voiceVolume) || !Number.isFinite(musicVolume)) throw new Error("voiceVolume and musicVolume must be numbers.");
      const { db } = await getAppContext();
      const [prod] = await db.select({ channelId: productions.channelId }).from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      const res = await setAudioLevelsAction(productionId, voiceVolume, musicVolume);
      if (res.error) throw new Error(res.error);
      await logDecision(db, prod.channelId, `Set audio levels via MCP`, { productionId, voiceVolume, musicVolume });
      return { productionId, voiceVolume, musicVolume, note: "Audio levels set; the video re-renders with the new mix." };
    },
  },
  {
    name: "set_intel_cadence",
    description:
      "Set how often the market-intel scan runs for a channel — daily | weekly | off (the cockpit Niche Intel cadence). 'off' pauses competitor/trend scanning for the channel.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        cadence: { type: "string", enum: ["daily", "weekly", "off"] },
      },
      required: ["channelId", "cadence"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const cadence = requireStr(args, "cadence");
      if (!["daily", "weekly", "off"].includes(cadence)) throw new Error("cadence must be daily, weekly, or off.");
      const { db } = await getAppContext();
      const [ch] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId));
      if (!ch) throw new Error("Channel not found");
      await setIntelCadenceAction(channelId, cadence);
      await logDecision(db, channelId, `Set intel cadence via MCP`, { cadence });
      return { channelId, cadence, note: `Market-intel scan cadence set to ${cadence}.` };
    },
  },
  {
    name: "add_competitor",
    description:
      "Track a competitor channel for a channel's market intel (the cockpit Niche Intel 'Add') — future scans watch it for breakout patterns. Pass a name and optionally the channel url. Feeds get_intel.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        name: { type: "string", description: "the competitor channel's name" },
        url: { type: "string", description: "optional: the competitor's YouTube channel URL" },
      },
      required: ["channelId", "name"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = requireStr(args, "channelId");
      const name = requireStr(args, "name");
      const url = str(args, "url");
      const { db } = await getAppContext();
      const [ch] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId));
      if (!ch) throw new Error("Channel not found");
      const fd = new FormData();
      fd.set("name", name);
      if (url) fd.set("url", url);
      await addCompetitorAction(channelId, fd);
      await logDecision(db, channelId, `Added competitor via MCP`, { name, ...(url ? { url } : {}) });
      return { channelId, name, note: `Now tracking "${name}" — future intel scans watch it. Read get_intel for what surfaces.` };
    },
  },
  {
    name: "set_opportunity_status",
    description:
      "Shortlist or dismiss a market OPPORTUNITY (the cockpit ideas-page opportunity actions) — curate the intel feed so shortlisted opportunities lead, dismissed ones stop resurfacing. opportunityId from get_intel (opportunities[].id).",
    inputSchema: {
      type: "object",
      properties: {
        opportunityId: { type: "string" },
        status: { type: "string", enum: ["shortlisted", "dismissed"] },
      },
      required: ["opportunityId", "status"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const opportunityId = requireStr(args, "opportunityId");
      const status = requireStr(args, "status");
      if (status !== "shortlisted" && status !== "dismissed") throw new Error("status must be shortlisted or dismissed.");
      const { db } = await getAppContext();
      const [opp] = await db.select({ id: marketOpportunities.id }).from(marketOpportunities).where(eq(marketOpportunities.id, opportunityId));
      if (!opp) throw new Error("Opportunity not found — get its id from get_intel.");
      await setOpportunityStatusAction(opportunityId, status);
      return { opportunityId, status, note: `Opportunity ${status} (market opportunities are cross-niche, not channel-scoped).` };
    },
  },
];

/** Local alias for the DNA patch shape set_channel_config accepts. */
type SetChannelConfigDna = {
  tone?: string;
  audiencePersona?: string;
  hookStyles?: string[];
  forbiddenTopics?: string[];
  ctaTemplate?: string;
  voiceId?: string;
  targetLengthSec?: number;
  cadencePerWeek?: number;
  titleTemplates?: { name: string; pattern: string; example?: string }[];
  searchTerms?: string[];
  lengthPolicy?: Partial<import("@ytauto/db").LengthPolicy>;
  imageStyle?: string;
};

export const MCP_TOOLS_BY_NAME: Map<string, McpTool> = new Map(MCP_TOOLS.map((t) => [t.name, t]));

/**
 * Tools that only READ — no DB writes, no LLM spend, no external mutation. We
 * advertise these with `annotations.readOnlyHint: true` in tools/list so the
 * Claude app can surface them without a per-call approval prompt (ticket
 * 01KY25NFHJ… / #29: get_agent_prompts returned "No approval received" because
 * EVERY tool looked mutating without the hint). Anything that writes, spends on
 * an LLM, or hits an external write path is deliberately excluded so it still
 * requires an explicit operator approval. (reconcile_publications is NOT here — it
 * gained a fix:true WRITE mode in ticket 01KY4VVP…, so it must gate on approval.)
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "list_channels",
  "get_channel_state",
  "get_channel_config",
  "get_channel_branding",
  "get_channel_strategy",
  "get_intel",
  "get_playbook",
  "get_eval_results",
  "list_ideas",
  "list_series",
  "list_productions",
  "get_production",
  "get_production_shots",
  "get_production_shot",
  "list_gates",
  "get_gate",
  "get_production_costs",
  "get_channel_costs",
  "get_video_analytics",
  "get_channel_analytics",
  "get_agent_prompts",
  "get_deferred_work",
  "get_guide",
  "get_job",
  "get_diagnostics",
  "list_issues",
  "get_music",
  "search_free_music",
  "list_thumbnails",
]);
