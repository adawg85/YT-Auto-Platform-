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
import { auditGuideToolReferences } from "./guide-audit";
import {
  beatMapFingerprint,
  beatMapVerdict,
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
  projectShotPlan,
  resolveProductionProfile,
  reviewBeatMapDeterministic,
  selectComparisonMaps,
  reviewSlateDeterministic,
  slateVerdict,
  regenShotMode,
  imageSourceKind,
  duplicateRiskGroups,
  outstandingDuplicateShotCount,
  fragmentedHookStyleWarnings,
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
  createSeriesDirect,
  setChannelConfig,
  setPublicationMetadata,
  writeIdea,
  type AuthoredBeat,
} from "@/app/mcp-authoring-actions";
import { decideGateAction, swapShotImageAction, regenerateThumbnailsAction } from "@/app/actions";

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
              titleTemplates: dna.titleTemplates ?? null,
              searchTerms: dna.searchTerms ?? null,
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
        ],
      };
    },
  },
  {
    name: "get_channel_branding",
    description:
      "Read a channel's branding assets — avatar + banner (ticket 01KY2A8H…). Returns each asset's URL (served from /api/media) or null if not generated, plus whether it's set. NOTE: branding is generated in the cockpit (channel Settings → Branding), NOT by the MCP create_channel path, so a freshly MCP-created channel reads both as unset until you generate them there. Applying to YouTube stays a manual operator step.",
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
    description:
      "Read one production: status, its idea, a summary of the current script draft (hook, beat count, word count), a `shotPlan` projection (projectedShots, projectedMovingShots, unusedMotionPromptBeats — why 'I supplied 9 motion prompts and got 1 clip'), and `clipFailures` (clips that failed or produced no usable output and fell back to a still).",
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
      return {
        id: prod.id,
        status: prod.status,
        externalScript: prod.externalScript,
        failureReason: prod.failureReason,
        idea: idea ? { id: idea.id, title: idea.title, angle: idea.angle } : null,
        script: draft ? { version: draft.version, hookText: draft.hookText, beatCount: (draft.beats as unknown[]).length, wordCount: draft.wordCount } : null,
        shotPlan,
        clipFailures: issues.map((r) => ({ summary: r.summary, at: r.at })),
      };
    },
  },
  {
    name: "get_production_shots",
    description:
      "List a production's SHOTS individually (ticket 01KY5W4T… / #30 item 6) — one entry per rendered image, so you can inspect the visuals gate over MCP and find a specific bad/duplicate shot to fix with regenerate_shot. Each: idx (the shot's image index — NOT the beat index; one beat can fan into up to 4 shots), narration (the spoken line the shot covers), source ('sourced' = a real photo/clip, 'generated' = model image), entity (the referenceEntity sourced), imagePrompt, engineRequested/engineServed (the image model asked-for vs used), heroShot, animated (has a motion clip), and imageUrl. Also returns outstandingDuplicateShots + duplicateRiskGroups (ticket 01KY6DCD…): shots sharing a referenceEntity with another shot — a duplicate-image risk to fix with regenerate_shot BEFORE approving the visuals gate, since the per-shot fix window closes the moment the production advances past visuals_review.",
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
      const imgs = await db
        .select({ id: assets.id, idx: assets.idx, key: assets.storageKey, meta: assets.meta })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")))
        .orderBy(assets.idx);
      const clipRows = await db
        .select({ idx: assets.idx })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip")));
      const animatedIdx = new Set(clipRows.map((c) => c.idx));
      const shots = imgs.map((im) => {
        const m = (im.meta ?? {}) as Record<string, unknown>;
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
          imageUrl: `/api/media/${im.key}`,
        };
      });
      // Duplicate-image RISK (ticket 01KY6DCD…): shots sharing a referenceEntity
      // with another shot draw the same source pool. Surface it so the operator
      // sees how many suspect shots remain BEFORE approving the visuals gate —
      // after approval regenerate_shot is gone and the fix window has closed.
      const dupGroups = duplicateRiskGroups(shots.map((s) => ({ idx: s.idx, entity: s.entity })));
      const outstandingDuplicateShots = outstandingDuplicateShotCount(dupGroups);
      return {
        productionId,
        status: prod.status,
        shotCount: shots.length,
        atVisualsGate: prod.status === "visuals_review",
        outstandingDuplicateShots,
        duplicateRiskGroups: dupGroups,
        shots,
        note:
          prod.status === "visuals_review"
            ? `At the visuals gate — fix a specific shot with regenerate_shot(productionId, idx, {...}); it stays for your review.${outstandingDuplicateShots > 0 ? ` ${outstandingDuplicateShots} shot(s) across ${dupGroups.length} entity group(s) still share a referenceEntity (duplicate-image risk) — fix or accept them BEFORE approving the gate, as regenerate_shot is unavailable once the production advances.` : ""}`
            : `regenerate_shot only runs while the production is at the visuals gate (status visuals_review); this production is ${prod.status}, so the per-shot fix window has closed.${outstandingDuplicateShots > 0 ? ` ${outstandingDuplicateShots} shot(s) still share a referenceEntity — reopening the visuals gate for these is an operator action in the cockpit (a corrected copy re-bills the whole production).` : ""}`,
      };
    },
  },
  {
    name: "regenerate_shot",
    description:
      "Fix ONE shot at the visuals gate WITHOUT re-running the whole production or re-billing the other shots (ticket 01KY5W4T…) — the same action as the per-shot Regenerate/Re-source buttons in the cockpit. The production MUST be at the visuals gate (status visuals_review). Modes (inferred from what you pass): referenceEntity → RE-SOURCE a real photo (of that subject; dedupes against images already used); imagePrompt and/or imageEngine → REGENERATE the still (verbatim prompt, chosen model qwen/seedream/nano-banana); nothing → regenerate the still with its existing prompt/engine (to reroll a bad generation). The shot's cost appends to the production's costs. The visuals gate stays OPEN for your review — regenerating NEVER auto-approves. For a published video, make a corrected copy instead.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        shotIndex: { type: "number", description: "the shot's image idx (from get_production_shots), not the beat index" },
        imagePrompt: { type: "string", description: "regenerate the still from this prompt (used verbatim)" },
        referenceEntity: { type: "string", description: "re-source a real photo of this subject instead of generating" },
        imageEngine: { type: "string", enum: ["qwen", "seedream", "nano-banana"], description: "image model for a regenerated still" },
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
      const opts: { prompt?: string; engine?: "qwen" | "seedream" | "nano-banana" } = {};
      if (mode === "real") {
        // point the shot's entity at the requested subject; the re-source reads it from meta
        const meta = { ...((img.meta ?? {}) as Record<string, unknown>), entity: referenceEntity };
        await db.update(assets).set({ meta }).where(eq(assets.id, img.id));
      } else {
        if (imagePrompt) opts.prompt = imagePrompt;
        if (imageEngine) opts.engine = imageEngine;
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
        note: "Shot regenerated; the visuals gate is still OPEN — review it in the cockpit and approve when satisfied (regenerating never auto-approves). The cost was appended to this production.",
      };
    },
  },
  {
    name: "regenerate_thumbnail",
    description:
      "Render a NEW thumbnail candidate from an authored prompt at the FINAL gate, WITHOUT re-running the production (ticket 01KY6F1X…) — the MCP twin of the cockpit's thumbnail Regenerate button, and the counterpart to regenerate_shot for the thumbnail. The production MUST be at the final gate (status thumbnail_review) — that's the stage the thumbnail decision is made. Pass thumbnailPrompt (used VERBATIM; two variants are rendered — your prompt and an alternative-composition twin) and optionally imageEngine (qwen/seedream/nano-banana; default follows the channel's thumbnailImageEngine) and quality ('hero' for the premium model). Omit thumbnailPrompt to re-roll from the channel's thumbnail template/spec. The candidates are ADDED to the gate for you to pick; the thumbnail_review gate stays OPEN — this NEVER auto-approves or publishes. Cost appends to the production. NOTE: set_publication_metadata only STORES thumbnailPrompt (it does not render); use THIS to actually generate the image.",
    inputSchema: {
      type: "object",
      properties: {
        productionId: { type: "string" },
        thumbnailPrompt: { type: "string", description: "thumbnail image prompt, used verbatim (two variants rendered). Omit to re-roll from the channel's thumbnail template/spec." },
        imageEngine: { type: "string", enum: ["qwen", "seedream", "nano-banana"], description: "image model; default follows the channel's thumbnailImageEngine profile axis" },
        quality: { type: "string", enum: ["standard", "hero"], description: "'hero' uses the premium image model/quality; default standard" },
      },
      required: ["productionId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const productionId = requireStr(args, "productionId");
      const thumbnailPrompt = str(args, "thumbnailPrompt");
      const imageEngine = str(args, "imageEngine") as "qwen" | "seedream" | "nano-banana" | undefined;
      const quality = str(args, "quality") === "hero" ? "hero" : "standard";

      const { db } = await getAppContext();
      const [prod] = await db.select().from(productions).where(eq(productions.id, productionId));
      if (!prod) throw new Error("Production not found");
      // Scoped to the FINAL gate: the pending thumbnail_review gate stays open
      // (never auto-approved), so there's no mid-flight pipeline resume and human
      // sign-off on the published thumbnail stays mandatory. Mirrors regenerate_shot.
      if (prod.status !== "thumbnail_review") {
        throw new Error(
          `regenerate_thumbnail only runs at the final gate (status thumbnail_review); this production is ${prod.status}. Thumbnails are generated for that gate — for a published video make a corrected copy; at an earlier stage let the pipeline reach thumbnail_review first.`,
        );
      }

      const result = await regenerateThumbnailsAction(productionId, {
        ...(thumbnailPrompt ? { prompt: thumbnailPrompt } : {}),
        model: quality,
        ...(imageEngine ? { engine: imageEngine } : {}),
      });
      if (result.error) throw new Error(result.error);
      await logDecision(db, prod.channelId, `Regenerated thumbnail via MCP`, {
        productionId,
        added: result.added ?? 0,
        ...(thumbnailPrompt ? { authoredPrompt: true } : {}),
        ...(imageEngine ? { imageEngine } : {}),
        quality,
      });
      return {
        productionId,
        added: result.added ?? 0,
        note: "New thumbnail candidate(s) added; the final (thumbnail_review) gate is still OPEN — review the options in the cockpit and approve the one you want (regenerating never auto-approves or publishes). The cost was appended to this production.",
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
              type: { type: "string", enum: ["hook", "stat", "insight", "cta", "rehook"], description: "rehook = a mid-video beat that re-grabs attention; use it to break a long exposition run (matches review_beat_map's flat-run check)." },
              text: { type: "string", description: "spoken narration for this beat" },
              imagePrompt: { type: "string", description: "image-generation prompt. Provide a FULL prompt to own it — for an authored production a complete prompt (>=20 chars) is used VERBATIM and the builder LLM is skipped; leave it thin/empty and the platform elaborates one from the beat." },
              referenceEntity: { type: "string", description: "optional: a named real subject to source a real photo of (e.g. 'Supermarine Spitfire')" },
              visualBrief: { type: "string", description: "optional: the concrete visual ask for this beat, never echoing the narration" },
              heroShot: { type: "boolean", description: "true only on the 2-4 pivotal beats (premium image model)" },
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
      "Set channel options DIRECTLY (no wizard/planner LLM). Patch any of: autonomy tier; DNA (tone, audiencePersona, hookStyles, forbiddenTopics, ctaTemplate, voiceId, targetLengthSec, cadencePerWeek, titleTemplates — named title families for review_slate's drift check); the Production Profile (partial — merged over the stored one); charter mission/objectives/verificationBar (verificationBar is partial-merged — patch establishedMinSources/presentDebateMode/minFactsToScript/factualityMode to fix charter drift on the compliance bar). Only provided fields change. Array fields (hookStyles/forbiddenTopics/…) are stored VERBATIM — commas inside an entry are kept, so a multi-clause hook style is one entry. The response echoes `stored` with the written array fields so you can confirm the value without a separate get_channel_config.",
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
      "Inspect one pending gate. For a visuals_review gate it returns each shot's narration + the image (and whether a clip was animated) so you (or the operator) can review the look before approving, PLUS outstandingDuplicateShots + duplicateRiskGroups (shots sharing a referenceEntity — duplicate-image risk to fix with regenerate_shot before approval, since that window closes on approval); the reviewPath is the cockpit page to open. Then decide_gate to approve/reject/revise.",
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
          .select({ idx: assets.idx })
          .from(assets)
          .where(and(eq(assets.productionId, gate.productionId), eq(assets.kind, "video_clip")));
        const clipIdx = new Set(clips.map((c) => c.idx));
        base.shots = imgs
          .sort((a, b) => a.idx - b.idx)
          .map((im) => ({ idx: im.idx, narration: beats[im.idx]?.text ?? null, image: `/api/media/${im.key}`, animated: clipIdx.has(im.idx) }));
        // Duplicate-image risk (ticket 01KY6DCD…): flag how many shots still share
        // a referenceEntity BEFORE approval, so the operator knows what's unfixed —
        // regenerate_shot is gone the moment this gate is approved.
        const dupGroups = duplicateRiskGroups(
          imgs.map((im) => {
            const m = (im.meta ?? {}) as Record<string, unknown>;
            return { idx: im.idx, entity: typeof m.entity === "string" ? m.entity : null };
          }),
        );
        base.outstandingDuplicateShots = outstandingDuplicateShotCount(dupGroups);
        base.duplicateRiskGroups = dupGroups;
        if (dupGroups.length > 0) {
          base.duplicateRiskNote = `${outstandingDuplicateShotCount(dupGroups)} shot(s) across ${dupGroups.length} entity group(s) share a referenceEntity (duplicate-image risk). Fix them with regenerate_shot, or accept the risk, BEFORE approving — the per-shot fix window closes on approval.`;
        }
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
      // Self-audit: if the guide names a tool that isn't registered (drift),
      // surface it so Claude-in-chat never chases a phantom tool (#29).
      const audit = auditGuideToolReferences();
      return audit.ok
        ? { guide: MCP_GUIDE }
        : {
            guide: MCP_GUIDE,
            warnings: [
              `Guide references ${audit.missing.length} tool(s) not in the MCP registry: ${audit.missing.join(", ")}. These are documented but not callable — report_issue so the guide/registry are reconciled.`,
            ],
          };
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
      "Structural pre-check on a BEAT MAP before you write full narration or spend on generation (ticket 01KY1Y9E…). Submit the shape — for each beat its type (hook/stat/insight/cta/rehook), a one-line summary, optional wordBudget/timingSec/heroShot — plus title, hookLine, targetLengthSec. Returns verdict pass/advise/block with specific findings: BLOCKS on word-budget-out-of-band and structural repetition vs this channel's recent maps (the compliance check — templated low-variation structure is what YouTube's inauthentic-content enforcement targets); ADVISES on payoff position, flat runs, and date-arithmetic to verify. A block means don't proceed as-is — revise the shape and re-submit. Each submission is stored so the variation check gets stronger over time. When iterating, PASS `ideaId`: revisions sharing an ideaId are excluded from the structural-repetition comparison, so re-submitting a revised map is never blocked as a near-duplicate of the draft it supersedes — only genuine cross-EPISODE similarity blocks (the corpus keeps just the latest map per other episode). Also returns a `shotEstimate`: roughly how many shots this length WILL cut (so you supply enough distinct briefs) and how many will MOVE under the channel's motion axis — flags when more beats are marked animates than will actually animate. (This is opt-in and advisory to you as the author; it does not by itself halt the pipeline.)",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        ideaId: {
          type: "string",
          description:
            "The idea/episode this map is a draft of. PASS IT when iterating — revisions sharing an ideaId are excluded from the structural-repetition comparison, so re-submitting a revised map doesn't trip the block against the draft it supersedes. Cross-episode comparison stays strict. Omit only for a truly standalone one-off check.",
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
      const ideaId = str(args, "ideaId") || null;
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
        })),
      };
      const { db } = await getAppContext();
      const [channel] = await db
        .select({ id: channels.id, name: channels.name, contentFormat: channels.contentFormat })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);
      if (!channel) throw new Error("Channel not found");
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
      const verdict = beatMapVerdict(review);
      // #28: coarse shot + motion estimate from the map's shape, so the author
      // can match brief count to slot count and see how many shots will move
      // BEFORE writing narration. Resolved against the channel's motion axis.
      const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
      const resolvedProfile = resolveProductionProfile(dna?.productionProfile ?? null, {
        contentFormat: channel.contentFormat,
      });
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
        blockingFindings: review.blockingFindings,
        advisoryFindings: review.advisoryFindings,
        comparedAgainst: recentMaps.length,
        comparedScope: ideaId
          ? "distinct OTHER episodes on this channel (this episode's own prior drafts excluded)"
          : "distinct episodes on this channel (no ideaId supplied — pass ideaId when iterating so your own prior drafts are excluded)",
        shotEstimate,
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
      "Review a BATCH of proposed ideas/titles against a channel's OWN rules BEFORE they enter the backlog (ticket 01KY2BJ9…) — the cheapest gate in the pipeline, one stage earlier than review_beat_map. Submit channelId + ideas[] (title, one-line angle, optional arc). BLOCKS on: a title/angle that violates the channel's forbiddenTopics (semantic match — an LLM catches 'Enoch's Calendar Has 364 Days' as 'mechanics of the luminaries'), an overclaim that contradicts a stored rule, and near-duplicates of the slate itself or the existing backlog/published titles. ADVISES on: intra-slate structural clustering (five titles of the same shape), keyword position, title-family drift (needs titleTemplates set on DNA), and substance overlap. Returns verdict pass/advise/block with {rule, evidence} findings. Run it before write_idea/create_series; a block means revise the batch. Opt-in and advisory to you as the author — it does not by itself gate write_idea.",
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
      const backlog = await db.select({ title: ideas.title }).from(ideas).where(eq(ideas.channelId, channelId)).limit(500);
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

      // Deterministic checks (clustering, duplicates, keyword position, overclaim verbs).
      const det = reviewSlateDeterministic(slate, {
        existingTitles,
        searchTerms,
        titleTemplatesDeclared: Boolean(titleTemplates?.length),
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
      "Verify every publication record against the live YouTube video (ticket 01KY1VFP…): flags records whose video is missing, deleted, private, a stuck shell, or has no video id — the cause of published-count drift (platform said 7, YouTube showed 5). Makes one YouTube read per published video. Optionally scope to one channel. Pass fix:true to CLEAN confirmed phantoms — records whose id resolves to no live video (missing/shell/no-id) are demoted from 'published' to 'published_unverified' so counts/averages are correct and they stop blocking re-publishing; history (the id) is preserved. fix NEVER touches 'unknown' (provider unreachable — the mock always returns unknown) or a merely-private live video.",
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
        results.push({
          publicationId: r.publicationId,
          productionId: r.productionId,
          title: r.title,
          providerVideoId: r.providerVideoId,
          status: r.status,
          verdict,
          note,
          mismatch: isReconcileMismatch(verdict),
          // only a CURRENTLY-published record that's a confirmed phantom gets cleaned
          phantom: isConfirmedPhantom(verdict) && r.status === "published",
        });
      }
      const mismatches = results.filter((r) => r.mismatch);

      // fix mode: demote confirmed phantoms to published_unverified (WRITE). Never
      // deletes — the id is kept for history; publishedAt is cleared so the record
      // stops counting as a live video and stops blocking re-publishing.
      const cleaned: { productionId: string; title: string; providerVideoId: string | null }[] = [];
      if (fix) {
        for (const r of results.filter((x) => x.phantom)) {
          await db.update(productions).set({ status: "published_unverified" }).where(eq(productions.id, r.productionId));
          await db.update(publications).set({ publishedAt: null }).where(eq(publications.id, r.publicationId));
          cleaned.push({ productionId: r.productionId, title: r.title, providerVideoId: r.providerVideoId });
        }
      }

      const phantomCount = results.filter((r) => r.phantom).length;
      return {
        checked: results.length,
        okCount: results.filter((r) => r.verdict === "ok").length,
        mismatchCount: mismatches.length,
        unknownCount: results.filter((r) => r.verdict === "unknown").length,
        phantomCount,
        mismatches: mismatches.map(({ phantom, publicationId, ...m }) => ({ ...m, phantom })),
        ...(fix
          ? { cleaned, cleanedCount: cleaned.length }
          : phantomCount > 0
            ? { fixHint: `Re-run with fix:true to demote ${phantomCount} confirmed-phantom record(s) to published_unverified.` }
            : {}),
        note:
          mismatches.length === 0
            ? "Every publication resolves to a real video (or the provider couldn't be reached)."
            : fix
              ? `Demoted ${cleaned.length} confirmed-phantom record(s) to published_unverified (id kept for history). 'unknown'/private records were left untouched.`
              : "Records flagged 'mismatch' do not correspond to a live video — likely stale published rows or uploads that never completed. Re-run with fix:true to clean the confirmed phantoms.",
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
  "get_intel",
  "get_playbook",
  "get_eval_results",
  "list_ideas",
  "list_series",
  "list_productions",
  "get_production",
  "get_production_shots",
  "list_gates",
  "get_gate",
  "get_production_costs",
  "get_channel_costs",
  "get_video_analytics",
  "get_channel_analytics",
  "get_agent_prompts",
  "get_deferred_work",
  "get_guide",
  "get_diagnostics",
  "list_issues",
]);
