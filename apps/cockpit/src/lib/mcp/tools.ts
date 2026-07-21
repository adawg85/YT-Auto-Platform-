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
  publications,
  reviewGates,
  scriptAnalyses,
  scriptDrafts,
  series,
  serviceVersions,
  ulid,
  type ScriptBeat,
  type SourceStrategy,
  type VerificationBar,
} from "@ytauto/db";
import { MCP_GUIDE } from "./guide";
import {
  beatMapFingerprint,
  beatMapVerdict,
  channelPerformanceSummary,
  channelStateSummary,
  classifyPublication,
  findSuspiciousPublications,
  GATE_DEAD_PRODUCTION_STATUSES,
  inngest,
  isReconcileMismatch,
  resolveProductionProfile,
  reviewBeatMapDeterministic,
  videoPerformance,
  type BeatMap,
  type CharterProposal,
} from "@ytauto/core";
import { proposeCharter, AGENT_PROMPTS, complianceRelevantPrompts } from "@ytauto/agents";
import { getAppContext, getMergedEnv } from "@/lib/context";
import { createGithubIssue } from "@/lib/github-issues";
// NOTE: decideGateAction is intentionally NOT imported here — gate approval is a
// human cockpit action and must not be reachable over MCP (remediation §0.1).
import {
  createChannelWithCharterAction,
  type CreateChannelWithCharterInput,
} from "@/app/channels/editorial-actions";
import {
  authorProduction,
  createSeriesDirect,
  setChannelConfig,
  setPublicationMetadata,
  writeIdea,
  type AuthoredBeat,
} from "@/app/mcp-authoring-actions";
import { decideGateAction } from "@/app/actions";

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

function requireStr(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (!v) throw new Error(`Missing required argument: ${key}`);
  return v;
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
      imageStyle: proposal.dnaDefaults.imageStyle,
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
      "Draft a channel charter for a niche + intent WITHOUT creating anything — returns the AI-proposed mission, objectives, verification bar, persona archetype, and DNA defaults for review. Use this to iterate on a channel concept in chat, then call create_channel to commit it.",
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
      return proposal;
    },
  },
  {
    name: "create_channel",
    description:
      "Create a new channel end-to-end: drafts a charter (unless you pass niche+intent it already used with propose_channel — a fresh charter is drafted here regardless), then provisions the channel + DNA + charter + persona + standing sources, exactly like the setup wizard. YouTube account/channel creation stays a MANUAL operator step (returned as a checklist) — this sets up everything on the platform side.",
    inputSchema: {
      type: "object",
      properties: {
        niche: { type: "string" },
        intent: { type: "string", description: "what the channel is for / its angle" },
        name: { type: "string", description: "channel display name" },
        handle: { type: "string", description: "@handle, e.g. @hangar-histories" },
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
      const proposal = await proposeCharter(
        { db, llm: providers.llm, costSink, channelId: "onboarding" },
        {
          niche,
          intent,
          format,
          researchDepth: str(args, "researchDepth"),
          monetisationSafe: typeof args.monetisationSafe === "boolean" ? args.monetisationSafe : undefined,
        },
      );
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
      });
      return {
        ok: true,
        channelId,
        mission: proposal.mission,
        provisioningChecklist: [
          "Create (or reuse) the pod Google/Brand account with a unique recovery phone/email.",
          `Create the YouTube channel and set the name to "${name}" and handle to "${handle}" by hand (the API can't set these).`,
          "Connect it to the platform via the channel's Settings → YouTube OAuth (youtube.force-ssl scope).",
          "Apply the generated avatar/banner in YouTube Studio; the platform runs upload/thumbnails/metadata/scheduling from here.",
        ],
      };
    },
  },

  // ── Direct authoring (BACKLOG #36): Claude writes content, platform executes ──
  {
    name: "get_channel_config",
    description:
      "Read a channel's full current configuration so you can author against it: DNA (tone, hook styles, forbidden topics, CTA, voice, target length, cadence), the resolved Production Profile (all visual/motion/rhythm/caption/music/engine axes), charter (mission, objectives, verification bar), autonomy tier, and content format. Read this before set_channel_config or author_script.",
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
        channel: { id: channel.id, name: channel.name, niche: channel.niche, contentFormat: channel.contentFormat, autonomyTier: channel.autonomyTier },
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
        consistencyWarnings: charterDnaWarnings(charter?.objectives ?? [], dna?.targetLengthSec ?? 0),
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
    description: "List recent productions (in-flight and done) for a channel, with status. Use to check what author_script / write_idea kicked off.",
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
      return rows.filter((r) => !status || r.status === status);
    },
  },
  {
    name: "get_production",
    description: "Read one production: status, its idea, and a summary of the current script draft (hook, beat count, word count).",
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
      return {
        id: prod.id,
        status: prod.status,
        externalScript: prod.externalScript,
        failureReason: prod.failureReason,
        idea: idea ? { id: idea.id, title: idea.title, angle: idea.angle } : null,
        script: draft ? { version: draft.version, hookText: draft.hookText, beatCount: (draft.beats as unknown[]).length, wordCount: draft.wordCount } : null,
        clipFailures: issues.map((r) => ({ summary: r.summary, at: r.at })),
      };
    },
  },
  {
    name: "author_script",
    description:
      "Author a full video script DIRECTLY and run it through the production pipeline — no platform scripting LLM. Provide the hook and the beats (each: type hook/stat/insight/cta, spoken text, optional imagePrompt/referenceEntity/visualBrief/heroShot). Optionally set a per-video productionProfile (skips the profile-proposal LLM). The human script gate is skipped (you wrote it); the anti-clone check + review board still run, then voiceover → images → render → publish. Provide either ideaId (existing idea) or ideaTitle+ideaAngle to mint one.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        ideaId: { type: "string", description: "author against this existing idea (else provide ideaTitle+ideaAngle)" },
        ideaTitle: { type: "string" },
        ideaAngle: { type: "string" },
        hookText: { type: "string", description: "the spoken first 1-2 seconds" },
        beats: {
          type: "array",
          description: "the script beats in order",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["hook", "stat", "insight", "cta"] },
              text: { type: "string", description: "spoken narration for this beat" },
              imagePrompt: { type: "string", description: "image-generation prompt. Provide a FULL prompt to own it — for an authored production a complete prompt (>=20 chars) is used VERBATIM and the builder LLM is skipped; leave it thin/empty and the platform elaborates one from the beat." },
              referenceEntity: { type: "string", description: "optional: a named real subject to source a real photo of (e.g. 'Supermarine Spitfire')" },
              visualBrief: { type: "string", description: "optional: the concrete visual ask for this beat, never echoing the narration" },
              heroShot: { type: "boolean", description: "true only on the 2-4 pivotal beats (premium image model)" },
              motionPrompt: { type: "string", description: "optional image-to-video motion prompt (subject action + camera move, no on-screen text) — used verbatim if this beat animates, skipping the platform's vision LLM. Only matters when the channel's motion axis animates shots." },
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
      "Set a production's PUBLISHED packaging before the final gate: title, description, tags, and/or thumbnailPrompt. Overrides the auto-generated values (image credits + the AI-disclosure line are still appended to the description; the thumbnail prompt is used verbatim). Locked once the video is published/scheduled — make a corrected copy after that. Packaging is the main discovery lever, so use this to control it.",
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
      "Set channel options DIRECTLY (no wizard/planner LLM). Patch any of: autonomy tier; DNA (tone, audiencePersona, hookStyles, forbiddenTopics, ctaTemplate, voiceId, targetLengthSec, cadencePerWeek); the Production Profile (partial — merged over the stored one); charter mission/objectives. Only provided fields change.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        autonomyTier: { type: "number", description: "0 manual … 3 exception-only" },
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
          },
          additionalProperties: false,
        },
        productionProfile: { type: "object", description: "partial Production Profile axes, merged over the stored profile" },
        charter: {
          type: "object",
          properties: { mission: { type: "string" }, objectives: { type: "array", items: { type: "string" } } },
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
        dna: (args.dna as SetChannelConfigDna) ?? undefined,
        productionProfile: (args.productionProfile as Record<string, unknown>) ?? undefined,
        charter: (args.charter as { mission?: string; objectives?: string[] }) ?? undefined,
      }),
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
      "Inspect one pending gate. For a visuals_review gate it returns each shot's narration + the image (and whether a clip was animated) so you (or the operator) can review the look before approving; the reviewPath is the cockpit page to open. Then decide_gate to approve/reject/revise.",
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
          .select({ idx: assets.idx, key: assets.storageKey })
          .from(assets)
          .where(and(eq(assets.productionId, gate.productionId), eq(assets.kind, "image")));
        const clips = await db
          .select({ idx: assets.idx })
          .from(assets)
          .where(and(eq(assets.productionId, gate.productionId), eq(assets.kind, "video_clip")));
        const clipIdx = new Set(clips.map((c) => c.idx));
        base.shots = imgs
          .sort((a, b) => a.idx - b.idx)
          .map((im) => ({ idx: im.idx, narration: beats[im.idx]?.text ?? null, image: `/api/media/${im.key}`, animated: clipIdx.has(im.idx) }));
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
      return {
        productionId,
        totalUsd: Number(total.toFixed(4)),
        byStage: Object.fromEntries(Object.entries(byStage).map(([k, v]) => [k, Number(v.toFixed(4))])),
        items,
      };
    },
  },
  {
    name: "get_channel_costs",
    description: "Cost rollup for a channel — totals by stage across all its productions (USD) + per-production totals (highest first).",
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
      return {
        channelId,
        totalUsd: Number(total.toFixed(4)),
        byStage,
        perProduction: byProd
          .map((r) => ({ productionId: r.productionId, costUsd: Number(Number(r.total).toFixed(4)) }))
          .sort((a, b) => b.costUsd - a.costUsd),
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
      "Channel-level analytics (ticket 01KY1VEZ…): windowed views, subscribers gained, current subscriber count, watch hours, average retention, and per-video view distribution (median + mean, and how many videos actually have analytics). `sinceDays` sets the window (default 28). Windowed figures come straight from YouTube (not summed snapshots); median/mean come from the latest snapshot per published video. Note: impressions + click-through-rate are NOT exposed by the YouTube Analytics API (Studio-only).",
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

  // ── Help, diagnostics, and the issue bridge (BACKLOG #36) ──────────────────
  {
    name: "get_guide",
    description:
      "Return the platform operating guide — how to use these tools correctly across the end-to-end flow (authoring, the config surface, real-image sourcing, gates, gotchas). Read this first if you're unsure how to drive the platform.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ guide: MCP_GUIDE }),
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
      "Structural pre-check on a BEAT MAP before you write full narration or spend on generation (ticket 01KY1Y9E…). Submit the shape — for each beat its type (hook/stat/insight/cta/rehook), a one-line summary, optional wordBudget/timingSec/heroShot — plus title, hookLine, targetLengthSec. Returns verdict pass/advise/block with specific findings: BLOCKS on word-budget-out-of-band and structural repetition vs this channel's recent maps (the compliance check — templated low-variation structure is what YouTube's inauthentic-content enforcement targets); ADVISES on payoff position, flat runs, and date-arithmetic to verify. A block means don't proceed as-is — revise the shape and re-submit. Each submission is stored so the variation check gets stronger over time. (This is opt-in and advisory to you as the author; it does not by itself halt the pipeline.)",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
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
        })),
      };
      const { db } = await getAppContext();
      const [channel] = await db.select({ id: channels.id, name: channels.name }).from(channels).where(eq(channels.id, channelId)).limit(1);
      if (!channel) throw new Error("Channel not found");
      // Recent maps for the cross-video variation check.
      const recentRows = await db
        .select({ map: beatMaps.map })
        .from(beatMaps)
        .where(eq(beatMaps.channelId, channelId))
        .orderBy(desc(beatMaps.createdAt))
        .limit(30);
      const recentMaps = recentRows.map((r) => r.map as BeatMap);
      const review = reviewBeatMapDeterministic(beatMap, { recentMaps });
      const verdict = beatMapVerdict(review);
      // Store the submission so future checks compare against it.
      await db.insert(beatMaps).values({
        id: ulid(),
        channelId,
        title: beatMap.title,
        map: beatMap,
        fingerprint: beatMapFingerprint(beatMap),
        verdict,
      });
      return {
        channelId,
        verdict,
        blockingFindings: review.blockingFindings,
        advisoryFindings: review.advisoryFindings,
        comparedAgainst: recentMaps.length,
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
    name: "reconcile_publications",
    description:
      "Verify every publication record against the live YouTube video (ticket 01KY1VFP…): flags records whose video is missing, deleted, private, a stuck shell, or has no video id — the cause of published-count drift (platform said 7, YouTube showed 5). Read-only; makes one YouTube read per published video. Optionally scope to one channel.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string", description: "optional: only this channel" } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const channelId = str(args, "channelId");
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
        results.push({
          productionId: r.productionId,
          title: r.title,
          providerVideoId: r.providerVideoId,
          status: r.status,
          verdict,
          note,
          mismatch: isReconcileMismatch(verdict),
        });
      }
      const mismatches = results.filter((r) => r.mismatch);
      return {
        checked: results.length,
        okCount: results.filter((r) => r.verdict === "ok").length,
        mismatchCount: mismatches.length,
        unknownCount: results.filter((r) => r.verdict === "unknown").length,
        mismatches,
        note:
          mismatches.length === 0
            ? "Every publication resolves to a real video (or the provider couldn't be reached)."
            : "Records flagged 'mismatch' do not correspond to a live video — likely stale published rows or uploads that never completed.",
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
    description: "List filed issues/tickets (yours and the operator's). Use to check whether something was already reported or resolved. Each ticket may carry a `resolution` — the developer's answer synced from the linked GitHub issue (body + comments); read it before deciding whether to resolve_issue.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["open", "acknowledged", "closed"], description: "default: open + acknowledged" } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const status = str(args, "status");
      const { db } = await getAppContext();
      const rows = await db
        .select()
        .from(agentTickets)
        .where(status ? eq(agentTickets.status, status as "open" | "acknowledged" | "closed") : or(eq(agentTickets.status, "open"), eq(agentTickets.status, "acknowledged")))
        .orderBy(desc(agentTickets.createdAt))
        .limit(50);
      return rows.map((r) => ({ id: r.id, title: r.title, detail: r.detail, severity: r.severity, status: r.status, channelId: r.channelId, productionId: r.productionId, githubUrl: r.githubUrl, resolution: r.resolution, createdAt: r.createdAt }));
    },
  },
  {
    name: "resolve_issue",
    description: "Mark a ticket acknowledged or closed once it's handled.",
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "string" }, status: { type: "string", enum: ["acknowledged", "closed"] } },
      required: ["ticketId", "status"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const ticketId = requireStr(args, "ticketId");
      const status = requireStr(args, "status");
      if (status !== "acknowledged" && status !== "closed") throw new Error("status must be acknowledged or closed");
      const { db } = await getAppContext();
      await db.update(agentTickets).set({ status }).where(eq(agentTickets.id, ticketId));
      return { ok: true, ticketId, status };
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
};

export const MCP_TOOLS_BY_NAME: Map<string, McpTool> = new Map(MCP_TOOLS.map((t) => [t.name, t]));
