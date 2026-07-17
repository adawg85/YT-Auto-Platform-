import { eq, and, asc, ne, desc, isNotNull, inArray, notInArray } from "drizzle-orm";
import { ulid } from "ulid";
import {
  assets,
  channelCharacters,
  channelCharters,
  channelDna,
  channelPlaybook,
  channels,
  citations,
  claims,
  episodes,
  experiments,
  externalVideos,
  ideas,
  productions,
  publications,
  reviewGates,
  scriptDrafts,
  agentActions,
  visualStyles,
  visualStyleRefs,
  type ProductionProfile,
  type ScriptBeat,
  type WordTimestamp,
} from "@ytauto/db";
import { sql, gte } from "drizzle-orm";
import {
  buildThumbnailPrompts,
  channelStateSummary,
  channelWarmupState,
  playbookPromptBlock,
  resolveConditioning,
  styleBlockForImagePrompts,
  styleRefKeyForIndex,
  checkExternalSimilarity,
  checkVariation,
  deliveryVoiceSettings,
  factsGateApplies,
  inngest,
  minFactsToScript,
  resolveFactualityMode,
  nextQuotaReset,
  paceToSpeed,
  planShots,
  planShotsFromDirection,
  shotPlanOptions,
  targetPctForCast,
  selectForcedCharacterShots,
  mentionsName,
  archivalImagePolicy,
  applyProfileTweaks,
  imageEngineForRole,
  imageEnginePreference,
  planMotion,
  resolveProductionProfile,
  MUSIC_VOLUMES,
  musicBriefFor,
  videoEngineFor,
  patternsToPromptLines,
  planWarmupRelease,
  quotaWindowStart,
  retrieveMemory,
  topPatternsForNiche,
  youtubeDailyQuota,
  YOUTUBE_UPLOAD_QUOTA_UNITS,
  type FactualityProof,
  type ImageFit,
  type ScriptOutput,
} from "@ytauto/core";
import { costRecords } from "@ytauto/db";
import { RENDER_COST_PER_HOUR } from "@ytauto/providers";
import {
  buildImagePrompts,
  directVisualSequence,
  draftScript,
  ensureActivePersona,
  factualityRewriteNote,
  humanizeScript,
  judgeSimilarity,
  pickHookTemplate,
  proposeProfileTweaks,
  proveScriptFactuality,
  repairScriptFactuality,
  runReviewBoard,
  scoreImageFit,
  scoreThumbnailCandidate,
  scoreThumbnailFromPrompt,
  type AgentCtx,
} from "@ytauto/agents";
import { thumbnails, productionMusic } from "@ytauto/db";
import { getContext } from "../context";
import { assembleOperatorVoiceover } from "../voiceover";
import { getLambdaConfig, renderShortOnLambda } from "../render-lambda";
import { buildShortProps } from "../props";
import { sourceHeroClip, sourcePexelsClip, type FootageClip } from "../footage";
import { generateShotVideoClip, MAX_CLIP_SEC } from "../clip-generation";
import { renderShort } from "../render";

const MAX_REVISIONS = 3;
/** Factuality proof (#20): surgical repair passes allowed before the script
 * holds (proof → repair → proof → repair → proof → hold). */
const MAX_FACT_REWRITES = 2;
const GATE_TIMEOUT = "7d";
/** #35.3 pre-gate: candidates the vision scorer pans below this predicted-CTR
 * regenerate once with a bolder brief before the operator ever sees them. */
const THUMB_REGEN_CTR_FLOOR = 4;

type ProductionStatus = (typeof productions.$inferSelect)["status"];

async function setStatus(productionId: string, status: ProductionStatus, failureReason?: string) {
  const { db } = await getContext();
  await db
    .update(productions)
    .set({ status, ...(failureReason ? { failureReason } : {}) })
    .where(eq(productions.id, productionId));
}

/**
 * The durable production pipeline (spec §5.2): greenlit idea → script (with
 * factuality proof) → script_review gate → voiceover → visuals → variation
 * check → render → final gate → upload. Scheduled releases upload immediately
 * with YouTube-native `status.publishAt` (#20) — YouTube flips them public at
 * the slot and the publish-finalize cron does the go-live bookkeeping; nothing
 * sleeps holding a video. Steps are memoized; replays are safe because storage
 * keys are deterministic and DB writes upsert.
 */
export const productionPipeline = inngest.createFunction(
  {
    id: "production-pipeline",
    // productionId+attempt: duplicate greenlight clicks (attempt "0") still
    // dedupe, while force-forward re-fires the SAME production with a fresh
    // nonce (also unblocks the "failed run can't be re-fired" dead-end, #18).
    idempotency: 'event.data.productionId + "-" + event.data.attempt',
    concurrency: { key: "event.data.productionId", limit: 1 },
    retries: 3,
    // operator halt: stop the in-flight run at the next step boundary
    cancelOn: [{ event: "production/halt", match: "data.productionId" }],
    // hard failure (retries exhausted): mark the row `failed` so it stops
    // looking like it's hanging on its last stage, and surface it for recovery.
    onFailure: async ({ error, event, step }) => {
      const data = event.data as {
        productionId?: string;
        event?: { data?: { productionId?: string } };
      };
      const productionId = data.productionId ?? data.event?.data?.productionId;
      if (!productionId) return;
      const failed = await step.run("mark-production-failed", async () => {
        const { db } = await getContext();
        const [prod] = await db.select().from(productions).where(eq(productions.id, productionId));
        // don't clobber an operator-terminal state or an already-published run
        if (!prod || ["halted", "rejected", "published"].includes(prod.status)) return null;
        await db
          .update(productions)
          .set({ status: "failed", failureReason: (error?.message ?? "Pipeline failed").slice(0, 500) })
          .where(eq(productions.id, productionId));
        await db
          .update(reviewGates)
          .set({ status: "expired" })
          .where(and(eq(reviewGates.productionId, productionId), eq(reviewGates.status, "pending")));
        return { ideaId: prod.ideaId, channelId: prod.channelId };
      });

      // #23.1 gap-fill: if the failed production traces back to a series
      // episode, its tentative slot was vacated — ask the planner to replace it.
      if (failed) {
        const gapfill = await step.run("find-series-episode", async () => {
          const { db } = await getContext();
          const [episode] = await db
            .select({ id: episodes.id, seriesId: episodes.seriesId, channelId: episodes.channelId })
            .from(episodes)
            .where(eq(episodes.ideaId, failed.ideaId));
          return episode ?? null;
        });
        if (gapfill) {
          await step.sendEvent("gapfill-failed", {
            name: "editorial/gapfill.requested",
            data: { channelId: gapfill.channelId, seriesId: gapfill.seriesId, episodeId: gapfill.id },
          });
        }
      }
    },
  },
  { event: "production/greenlit" },
  async ({ event, step, runId }) => {
    const { productionId } = event.data;

    // 1) load context (small JSON only — storage keys, never buffers)
    const ctx = await step.run("load-context", async () => {
      const { db } = await getContext();
      const [production] = await db
        .select()
        .from(productions)
        .where(eq(productions.id, productionId));
      if (!production) throw new Error(`Production not found: ${productionId}`);
      const [idea] = await db.select().from(ideas).where(eq(ideas.id, production.ideaId));
      if (!idea) throw new Error(`Idea not found: ${production.ideaId}`);
      const [channel] = await db
        .select()
        .from(channels)
        .where(eq(channels.id, production.channelId));
      const [dna] = await db
        .select()
        .from(channelDna)
        .where(eq(channelDna.channelId, production.channelId));
      // Stale failure text (#25, found live): a resumed/re-fired run left the
      // OLD failure_reason displayed while it worked. A run (re)starting for a
      // failed/on_hold production clears it here — the first thing the run does.
      const restarting = ["failed", "on_hold"].includes(production.status);
      await db
        .update(productions)
        .set({ inngestRunId: runId, ...(restarting ? { failureReason: null } : {}) })
        .where(eq(productions.id, productionId));
      // build #5.2: while a one-variable experiment is active, its directive
      // steers the scriptwriter and the production is tagged for attribution
      const [experiment] = await db
        .select({ id: experiments.id, directive: experiments.directive })
        .from(experiments)
        .where(
          and(
            eq(experiments.channelId, production.channelId),
            eq(experiments.status, "active"),
          ),
        );
      // Resume (BACKLOG #15 Land 2): a production that already has a script
      // draft at pipeline start was seeded by the resume action — reuse that
      // script verbatim (skip drafting + the script gate) and regenerate media.
      const [seededDraft] = await db
        .select()
        .from(scriptDrafts)
        .where(eq(scriptDrafts.productionId, productionId))
        .orderBy(desc(scriptDrafts.version))
        .limit(1);
      const resumedScript = seededDraft
        ? {
            hookText: seededDraft.hookText,
            beats: seededDraft.beats as ScriptBeat[],
            fullText: seededDraft.fullText,
            substanceFingerprint: production.substanceFingerprint ?? "",
            // carried so the resumed draft can be RE-PRESENTED at the script
            // gate (editable) instead of skipping it — keeps its original hook
            hookTemplateId: seededDraft.hookTemplateId,
          }
        : null;
      // BACKLOG #21.3: the channel's factuality mode (charter-set, legacy-safe
      // resolver) steers the writer, proof, and compliance checker.
      const [charterRow] = await db
        .select({ verificationBar: channelCharters.verificationBar })
        .from(channelCharters)
        .where(eq(channelCharters.channelId, production.channelId));
      const factualityMode = resolveFactualityMode(charterRow?.verificationBar ?? null);
      // BACKLOG #21.1: the channel's ACTIVE writing persona (auto-seeded for
      // legacy channels). Doc rides the ctx JSON; provenance lands with the draft.
      const persona = await ensureActivePersona(db, production.channelId, {
        niche: channel?.niche ?? "general knowledge",
      });
      // #35.1: the channel's ACTIVE visual style — doc flows into every image
      // + thumbnail prompt; enabled ref keys drive image conditioning. Small
      // JSON only (the step-state rule); provenance stamped here since the
      // style is fixed for the whole run.
      let style: {
        id: string;
        version: number;
        doc: (typeof visualStyles.$inferSelect)["doc"];
        refKeys: string[];
      } | null = null;
      if (dna?.activeStyleId) {
        const [styleRow] = await db
          .select()
          .from(visualStyles)
          .where(eq(visualStyles.id, dna.activeStyleId));
        if (styleRow && styleRow.status === "active") {
          const refs = await db
            .select({ id: visualStyleRefs.id, storageKey: visualStyleRefs.storageKey, enabled: visualStyleRefs.enabled })
            .from(visualStyleRefs)
            .where(eq(visualStyleRefs.channelId, production.channelId));
          const byId = new Map(refs.filter((r) => r.enabled).map((r) => [r.id, r.storageKey]));
          const refKeys = (styleRow.doc.refIds ?? [])
            .map((id) => byId.get(id))
            .filter((k): k is string => Boolean(k));
          style = { id: styleRow.id, version: styleRow.version, doc: styleRow.doc, refKeys };
          await db
            .update(productions)
            .set({ styleId: styleRow.id, styleVersion: styleRow.version })
            .where(eq(productions.id, productionId));
        }
      }
      // 2026-07-14 recurring characters: enabled characters ride the ctx so
      // the prompt builder can cast them and shots condition on their sheets.
      const charRows = await db
        .select({
          id: channelCharacters.id,
          name: channelCharacters.name,
          description: channelCharacters.description,
          imageKey: channelCharacters.imageKey,
          // role (main = the channel's default presenter) drives casting
          role: channelCharacters.role,
          // castMode: "always" mascots ride every generated shot (2026-07-15);
          // "smart" casts ~castTarget% of shots by importance (2026-07-16)
          castMode: channelCharacters.castMode,
          castTarget: channelCharacters.castTarget,
        })
        .from(channelCharacters)
        .where(
          and(
            eq(channelCharacters.channelId, production.channelId),
            eq(channelCharacters.enabled, true),
          ),
        );
      return {
        idea,
        dna,
        characters: charRows,
        channelName: channel?.name ?? "unknown",
        niche: channel?.niche ?? "general knowledge",
        contentFormat: channel?.contentFormat ?? "short",
        autonomyTier: channel?.autonomyTier ?? 0,
        experiment: experiment ?? null,
        resumedScript,
        bypassChecks: production.bypassChecks ?? false,
        factualityMode,
        persona,
        style,
      };
    });

    // Autonomy tiers (spec §10): T0 manual / T1 assisted gate script + final;
    // T2 supervised / T3 exception-only skip gates and auto-publish (private).
    // The variation check still holds flagged items regardless of tier.
    const gated = ctx.autonomyTier <= 1;
    // Land 2: when resuming with a reused script, skip drafting, factuality,
    // grounding and the script gate — the script is fixed, only media re-runs.
    const resumedScript = ctx.resumedScript;
    // Force-forward (#16): operator override — the soft safety gates (variation +
    // review board) pass instead of blocking, logged as an override decision.
    const bypassChecks = ctx.bypassChecks;
    // Format-aware media (#16): long-form renders landscape 16:9 with landscape
    // beat images; shorts stay portrait 9:16. Was hardcoded 9:16 everywhere.
    const isLong = ctx.contentFormat === "long" || (ctx.dna?.targetLengthSec ?? 0) > 90;
    const orientation: "portrait" | "landscape" = isLong ? "landscape" : "portrait";
    const beatAspect: "9:16" | "16:9" = isLong ? "16:9" : "9:16";
    // Production Profile (#18): the per-channel control plane. The channel
    // profile is the DEFAULT; after script approval the per-video profile
    // stage (2026-07-12) may override `profile` with AI-proposed/operator-
    // approved tweaks — every voice/visual step below reads the final value.
    const channelProfile = resolveProductionProfile(ctx.dna?.productionProfile ?? null, {
      contentFormat: ctx.contentFormat,
    });
    let profile = channelProfile;
    const logOverride = (stage: string, reason: string | null) =>
      step.run(`override-${stage}`, async () => {
        const { db } = await getContext();
        await db.insert(agentActions).values({
          id: ulid(),
          agentName: "operator_override",
          channelId: ctx.idea.channelId,
          ideaId: ctx.idea.id,
          productionId,
          inputSummary: `operator force-forward: bypassed ${stage} block`,
          output: { stage, bypassedReason: reason },
        });
      });

    const agentCtx = async (): Promise<AgentCtx> => {
      const { db, providers, costSink } = await getContext();
      return {
        db,
        llm: providers.llm,
        costSink,
        channelId: ctx.idea.channelId,
        ideaId: ctx.idea.id,
        productionId,
      };
    };

    // 1.5) factuality gate (build #5): editorial-engine productions may only
    // script verified/attributed claims. Channels without a charter (or ideas
    // without an episode) skip — pre-#5 behavior is untouched. Same triad as
    // the variation check: check → agent_actions evidence row → on_hold.
    const factuality = resumedScript
      ? {
          skipped: true as const,
          blocked: false,
          facts: [] as { id: string; tier: string; text: string }[],
          conjecture: [] as { id: string; tier: string; text: string }[],
          citations: [] as {
            claimId: string;
            text: string;
            tier: string;
            sources: { url: string; title: string; domain: string }[];
          }[],
        }
      : await step.run("factuality-gate", async () => {
      const { db } = await getContext();
      const [episode] = await db.select().from(episodes).where(eq(episodes.ideaId, ctx.idea.id));
      const [charter] = await db
        .select()
        .from(channelCharters)
        .where(eq(channelCharters.channelId, ctx.idea.channelId));
      const noFacts = [] as { id: string; tier: string; text: string }[];
      const noCitations = [] as {
        claimId: string;
        text: string;
        tier: string;
        sources: { url: string; title: string; domain: string }[];
      }[];
      if (!episode || !charter) {
        return {
          skipped: true as const,
          blocked: false,
          facts: noFacts,
          conjecture: noFacts,
          citations: noCitations,
        };
      }

      const claimRows = await db.select().from(claims).where(eq(claims.episodeId, episode.id));
      const unfinished = claimRows.filter((c) => c.status === "unverified");
      const usable = claimRows.filter((c) => c.status === "verified" || c.status === "attributed");
      // #21.3: conjecture claims are tellable (framed) outside strict mode —
      // they count toward the gate but are never expected to carry citations.
      const mode = resolveFactualityMode(charter.verificationBar);
      const conjectureRows = mode === "strict" ? [] : claimRows.filter((c) => c.status === "conjecture");
      const citationRows = usable.length
        ? await db
            .select()
            .from(citations)
            .where(inArray(citations.claimId, usable.map((c) => c.id)))
        : [];
      const uncited = usable.filter(
        (c) => !citationRows.some((cit) => cit.claimId === c.id),
      );

      // Facts-gate (build #18, mode-aware since #21.3): "no full scripts on 1
      // fact" — except entertainment channels, where the gate does not apply.
      const minFacts = minFactsToScript(charter.verificationBar);
      const tellable = usable.length + conjectureRows.length;
      const gateApplies = factsGateApplies(mode);
      const belowBar = gateApplies && tellable < minFacts;

      // Leftover UNVERIFIED claims (halted / force-accepted / crashed research)
      // must not hold a production whose tellable bar is already met — they are
      // simply unusable, same as cut (2026-07-13 incident: a video held on "9
      // claims never finished verification" while dozens HAD verified). They
      // only block while the bar is genuinely unmet, i.e. verification could
      // still change the outcome. Ignored leftovers land in the evidence row.
      const blocked =
        (gateApplies && tellable === 0) || belowBar || uncited.length > 0;
      const reason = blocked
        ? gateApplies && tellable === 0
          ? unfinished.length > 0
            ? `verification incomplete: ${unfinished.length} claim(s) pending, none tellable yet`
            : "no claim survived verification — will not script ungrounded"
          : belowBar
            ? `only ${tellable} tellable fact(s) (${usable.length} verified/attributed, ${conjectureRows.length} conjecture) — need ≥${minFacts} to script${unfinished.length ? `; ${unfinished.length} still unverified` : ""}`
            : `${uncited.length} usable claim(s) lack citations`
        : null;

      // evidence row for the compliance log (mirrors the variation check)
      await db.insert(agentActions).values({
        id: ulid(),
        agentName: "factuality_check",
        channelId: ctx.idea.channelId,
        ideaId: ctx.idea.id,
        productionId,
        inputSummary: `factuality gate over ${claimRows.length} claims (episode ${episode.id})`,
        output: {
          claims: claimRows.map((c) => ({
            id: c.id,
            text: c.text,
            tier: c.tier,
            status: c.status,
            citationCount: citationRows.filter((cit) => cit.claimId === c.id).length,
          })),
          usableCount: usable.length,
          conjectureCount: conjectureRows.length,
          // unverified leftovers ignored because the bar was met (audit trail)
          ignoredUnverified: blocked ? 0 : unfinished.length,
          factualityMode: mode,
          minFactsToScript: minFacts,
          blocked,
          reason,
        },
      });

      if (blocked) {
        await setStatus(productionId, "on_hold", `factuality gate: ${reason}`);
        return {
          skipped: false as const,
          blocked: true,
          facts: noFacts,
          conjecture: noFacts,
          citations: noCitations,
        };
      }
      return {
        skipped: false as const,
        blocked: false,
        facts: usable.map((c) => ({ id: c.id, tier: c.tier as string, text: c.text })),
        conjecture: conjectureRows.map((c) => ({ id: c.id, tier: c.tier as string, text: c.text })),
        citations: usable.map((c) => ({
          claimId: c.id,
          text: c.text,
          tier: c.tier,
          sources: citationRows
            .filter((cit) => cit.claimId === c.id)
            .map((cit) => ({ url: cit.url, title: cit.title, domain: cit.domain })),
        })),
      };
    });
    if (factuality.blocked) {
      return { outcome: "on_hold", reason: "factuality gate failed" };
    }

    // build #5 memory grounding: the channel "state of the world" + top-k
    // retrieved evidence for this topic (charter'd channels only)
    const grounding = resumedScript
      ? null
      : await step.run("memory-grounding", async () => {
      if (factuality.skipped) return null;
      const { db, providers } = await getContext();
      const state = await channelStateSummary(db, ctx.idea.channelId);
      const [episode] = await db.select().from(episodes).where(eq(episodes.ideaId, ctx.idea.id));
      const hits = episode
        ? await retrieveMemory(db, providers.embeddings, {
            channelId: ctx.idea.channelId,
            episodeId: episode.id,
            query: `${ctx.idea.title} ${ctx.idea.angle}`,
            k: 5,
          })
        : [];
      const lines = [
        state ?? "",
        ...hits.map((h) => `EVIDENCE (${h.sourceUrl ?? h.kind}): ${h.content.slice(0, 300)}`),
      ].filter(Boolean);
      return lines.length ? lines.join("\n").slice(0, 4000) : null;
    });

    // #21.5: the channel's own adopted playbook directives (with the WHY) —
    // injected into every draft; outranks market patterns, never the facts.
    const playbookBlock = await step.run("playbook", async () => {
      const { db } = await getContext();
      const rows = await db
        .select()
        .from(channelPlaybook)
        .where(
          and(
            eq(channelPlaybook.channelId, ctx.idea.channelId),
            eq(channelPlaybook.status, "adopted"),
          ),
        );
      return playbookPromptBlock(rows);
    });

    // 2-3) script draft → human review gate, with a bounded revision loop.
    // Resume/push-back: v1 REUSES the kept script but still goes through the
    // gate (editable), so the operator can approve as-is or revise.
    let script: ScriptOutput | undefined = undefined;
    let approvedVersion = 0;
    let revisionNotes = "";
    for (let version = 1; version <= MAX_REVISIONS + 1; version++) {
      // Resume/push-back (2026-07-15 operator ask): when the halt kept a script,
      // RE-PRESENT it at the script gate as v1 so the operator can suggest edits,
      // instead of silently skipping the gate. v1 reuses the kept draft verbatim
      // (no drafting / humanize / proof — it was already written & proofed before
      // the halt); a Revise redraws normally on v2+. Non-resumed runs draft fresh.
      const reuseSeed = version === 1 && !!resumedScript;
      let out: ScriptOutput;
      let templateId: string | null;
      let proof: FactualityProof | null = null;
      let proofAttempts = 0;
      if (reuseSeed) {
        out = resumedScript!;
        templateId = resumedScript!.hookTemplateId ?? null;
      } else {
      // Scripting-loop incident fix (FIX 1): every LLM phase below is its OWN
      // memoized Inngest step. The previous shape ran the entire draft →
      // humanize → proof → rewrite loop inside ONE step.run — on long-form it
      // exceeded the step window, the step was retried, and ALL completed
      // frontier work re-executed from scratch. Step ids carry the loop
      // indices so replays memoize deterministically; NO step below makes more
      // than one frontier-model call.
      const drafted = await step.run(`draft-v${version}-c0`, async () => {
        await setStatus(productionId, "scripting");
        // hook/structure library: scorer picks the skeleton per topic (§5.5)
        const template = await pickHookTemplate(await agentCtx(), ctx.idea);
        // ONE frontier draft (its bounded internal length-expand attempts stay
        // inside — ≤2 extra calls, comfortably within the step window).
        const raw = await draftScript(await agentCtx(), ctx.idea, ctx.dna ?? undefined, {
          hookTemplate: template,
          verifiedFacts: factuality.facts.length ? factuality.facts : undefined,
          conjecture: factuality.conjecture.length ? factuality.conjecture : undefined,
          factualityMode: ctx.factualityMode,
          persona: ctx.persona.doc,
          groundingContext: grounding ?? undefined,
          experimentDirective: ctx.experiment?.directive,
          playbook: playbookBlock ?? undefined,
          revisionNotes: revisionNotes || undefined,
        });
        return { templateId: template.id, raw };
      });
      templateId = drafted.templateId;

      // Draft → humanize (#21, audit §4.2): every draft goes through the
      // editor pass before it is proofed, gated, or spent on — the persona's
      // voice, with AI tells stripped. Fail-safes inside keep the draft on a
      // structure mismatch, so this pass can only improve the script.
      out = await step.run(`humanize-v${version}-c0`, async () =>
        humanizeScript(await agentCtx(), {
          script: drafted.raw,
          persona: ctx.persona.doc,
          factualityMode: ctx.factualityMode,
          kind: isLong ? "long-form video" : "Short",
        }),
      );

      // Factuality proof (#20): on a fact-constrained channel the script must
      // prove every claim against the verified facts BEFORE it can gate or
      // spend on assets — assembly must never be the first place an
      // unsupported claim is caught. Bounded proof → repair loop; a draft
      // still failing after the repairs holds the production here, at the
      // cost of LLM calls instead of a voiceover + image bill.
      // Incident FIX 2: a failed proof triggers a SURGICAL repair of only the
      // flagged sentences — the old full redraft invented new narrative glue
      // and with it NEW unsupported claims (observed 14→10→5 whack-a-mole).
      // After a repair, ONLY the proof re-runs (no humanize, no length loop).
      if (factuality.facts.length) {
        for (let fix = 0; fix <= MAX_FACT_REWRITES; fix++) {
          proofAttempts = fix + 1;
          const current = out;
          proof = await step.run(`proof-v${version}-c${fix}`, async () =>
            proveScriptFactuality(await agentCtx(), {
              hookText: current.hookText,
              fullText: current.fullText,
              verifiedFacts: factuality.facts,
              conjecture: factuality.conjecture,
              factualityMode: ctx.factualityMode,
            }),
          );
          if (proof.pass || fix === MAX_FACT_REWRITES) break;
          const flagged = proof.unsupportedClaims;
          out = await step.run(`repair-v${version}-c${fix}-r${fix + 1}`, async () =>
            repairScriptFactuality(await agentCtx(), {
              script: current,
              unsupportedClaims: flagged,
              verifiedFacts: factuality.facts,
              conjecture: factuality.conjecture,
              factualityMode: ctx.factualityMode,
              persona: ctx.persona.doc,
            }),
          );
        }
      }

      // #21.2.3 pay-on-failure escalation: the proof→repair loop exhausted its
      // rewrites on the standard chain. If the operator configured
      // LLM_MODEL_ESCALATION (/account Models tab), redo the draft ONCE on the
      // escalation model — draft → humanize → single proof, no repair loop —
      // before holding. An unset slot aliases frontier (modelId equality), so
      // the extra spend is strictly opt-in; runAgent records the retry under
      // tier "escalation" in agent_actions/cost_records.
      if (proof && !proof.pass && factuality.facts.length) {
        const failedProof = proof;
        const escalatedRaw = await step.run(`draft-v${version}-esc`, async () => {
          const actx = await agentCtx();
          if (actx.llm.modelId("escalation") === actx.llm.modelId("frontier")) return null;
          const template = await pickHookTemplate(actx, ctx.idea);
          return draftScript(actx, ctx.idea, ctx.dna ?? undefined, {
            hookTemplate: template,
            verifiedFacts: factuality.facts,
            conjecture: factuality.conjecture.length ? factuality.conjecture : undefined,
            factualityMode: ctx.factualityMode,
            persona: ctx.persona.doc,
            groundingContext: grounding ?? undefined,
            experimentDirective: ctx.experiment?.directive,
            playbook: playbookBlock ?? undefined,
            revisionNotes: factualityRewriteNote(failedProof),
            tier: "escalation",
          });
        });
        if (escalatedRaw) {
          const escOut: ScriptOutput = await step.run(`humanize-v${version}-esc`, async () =>
            humanizeScript(await agentCtx(), {
              script: escalatedRaw,
              persona: ctx.persona.doc,
              factualityMode: ctx.factualityMode,
              kind: isLong ? "long-form video" : "Short",
            }),
          );
          const escProof: FactualityProof = await step.run(`proof-v${version}-esc`, async () =>
            proveScriptFactuality(await agentCtx(), {
              hookText: escOut.hookText,
              fullText: escOut.fullText,
              verifiedFacts: factuality.facts,
              conjecture: factuality.conjecture,
              factualityMode: ctx.factualityMode,
            }),
          );
          proofAttempts += 1;
          if (escProof.pass) {
            out = escOut;
            proof = escProof;
          }
        }
      }
      } // end !reuseSeed (draft → humanize → proof)

      const persisted = await step.run(`persist-draft-v${version}`, async () => {
        const { db } = await getContext();
        // evidence row — the same check → evidence → on_hold triad as the
        // factuality gate and variation check
        if (factuality.facts.length && proof) {
          await db.insert(agentActions).values({
            id: ulid(),
            agentName: "factuality_proof",
            channelId: ctx.idea.channelId,
            ideaId: ctx.idea.id,
            productionId,
            inputSummary: `script factuality proof v${version}: ${proofAttempts} audit(s) over ${factuality.facts.length} verified facts`,
            output: {
              pass: proof.pass,
              attempts: proofAttempts,
              unsupportedClaims: proof.unsupportedClaims,
            },
          });
        }
        // reuseSeed: the resumed draft is ALREADY stored as v1 (unique on
        // productionId+version), so a fresh insert would no-op and leave the
        // gate pointing at a phantom id — reuse the existing row's id instead.
        let draftId = ulid();
        if (reuseSeed) {
          const [existing] = await db
            .select({ id: scriptDrafts.id })
            .from(scriptDrafts)
            .where(and(eq(scriptDrafts.productionId, productionId), eq(scriptDrafts.version, version)))
            .limit(1);
          if (existing) draftId = existing.id;
        }
        await db
          .insert(scriptDrafts)
          .values({
            id: draftId,
            productionId,
            version,
            hookTemplateId: templateId,
            hookText: out.hookText,
            beats: out.beats,
            fullText: out.fullText,
            wordCount: out.fullText.split(/\s+/).filter(Boolean).length,
          })
          .onConflictDoNothing();
        await db
          .update(productions)
          .set({
            substanceFingerprint: out.substanceFingerprint,
            revisionCount: version - 1,
            experimentId: ctx.experiment?.id ?? null,
            // #21.1 provenance: which persona version wrote this script
            personaId: ctx.persona.id,
            personaVersion: ctx.persona.version,
          })
          .where(eq(productions.id, productionId));
        return { draftId };
      });

      if (proof && !proof.pass) {
        const failed = proof;
        await step.run(`hold-v${version}`, () =>
          setStatus(
            productionId,
            "on_hold",
            `script factuality proof: ${failed.unsupportedClaims.length} unsupported claim(s) after ${proofAttempts} audits — ${failed.unsupportedClaims[0]?.claim ?? ""}`.slice(0, 500),
          ),
        );
        return { outcome: "on_hold", reason: "script factuality proof failed" };
      }

      let gateId: string | null = null;
      if (gated) {
        gateId = await step.run(`gate-v${version}`, async () => {
          const { db } = await getContext();
          const id = ulid();
          await db.insert(reviewGates).values({
            id,
            productionId,
            kind: "script_review",
            payloadSnapshot: {
              scriptDraftId: persisted.draftId,
              version,
              hookText: out.hookText,
              fullText: out.fullText,
              // build #5: what each fact rests on, for the human reviewer
              ...(factuality.citations.length ? { citations: factuality.citations } : {}),
              // #20: the reviewer sees the proof already ran in scripting
              ...(factuality.facts.length
                ? { factualityProof: { pass: true, attempts: proofAttempts } }
                : {}),
            },
          });
          await db
            .update(productions)
            .set({ status: "script_review", currentGateId: id })
            .where(eq(productions.id, productionId));
          return id;
        });
      }

      // T2/T3: no human gate — the draft is accepted as-is
      if (!gateId) {
        script = out;
        approvedVersion = version;
        break;
      }

      // resume comes from the cockpit's decideGate action; match on gateId so
      // revision loops can never consume a stale approval
      const decision = await step.waitForEvent(`await-script-gate-v${version}`, {
        event: "production/gate.decided",
        if: `async.data.gateId == "${gateId}"`,
        timeout: GATE_TIMEOUT,
      });

      if (decision === null) {
        await step.run(`script-gate-timeout-v${version}`, () =>
          setStatus(productionId, "on_hold", "script_review gate timed out"),
        );
        return { outcome: "on_hold", reason: "script gate timeout" };
      }
      if (decision.data.decision === "rejected") {
        await step.run(`script-rejected-v${version}`, () =>
          setStatus(productionId, "rejected", "script rejected at review"),
        );
        return { outcome: "rejected" };
      }
      if (decision.data.decision === "revise") {
        if (version > MAX_REVISIONS) {
          await step.run("revisions-exhausted", () =>
            setStatus(productionId, "on_hold", `revision limit (${MAX_REVISIONS}) reached`),
          );
          return { outcome: "on_hold", reason: "revision limit reached" };
        }
        revisionNotes = decision.data.notes;
        continue;
      }
      script = out;
      approvedVersion = version;
      break;
    }
    if (!script) {
      await step.run("no-approved-script", () =>
        setStatus(productionId, "on_hold", "no script approved"),
      );
      return { outcome: "on_hold", reason: "no approved script" };
    }

    // 3.5) Per-video Production Profile (2026-07-12 operator ask): the channel
    // profile is the default, but THIS script may want different treatment —
    // decided HERE, before any voice/visual money is spent. An AI pass reads
    // the approved script and proposes tweaks on the low-cost axes; T0/T1
    // review them at a profile_review gate (accept, edit any axis, or keep
    // channel defaults), T2/T3 auto-apply. The chosen profile persists on the
    // production row — a re-fired run reuses it and never re-gates.
    const profileStage = await step.run("propose-profile-tweaks", async () => {
      const { db } = await getContext();
      const [row] = await db
        .select({ pp: productions.productionProfile })
        .from(productions)
        .where(eq(productions.id, productionId));
      if (row?.pp) return { existing: row.pp, proposed: null as ProductionProfile | null, tweaks: null };
      try {
        const tweaks = await proposeProfileTweaks(await agentCtx(), {
          scriptHook: script!.hookText,
          scriptText: script!.fullText,
          niche: ctx.niche,
          contentFormat: ctx.contentFormat,
          channelProfile,
        });
        const proposed = applyProfileTweaks(channelProfile, tweaks);
        await db.insert(agentActions).values({
          id: ulid(),
          agentName: "profile_tweaker",
          channelId: ctx.idea.channelId,
          ideaId: ctx.idea.id,
          productionId,
          inputSummary: tweaks.accept
            ? "per-video profile: channel defaults accepted"
            : `per-video profile: proposed ${tweaks.changes.map((c) => `${c.axis}→${c.to}`).join(", ")}`,
          output: { tweaks, proposed },
        });
        return { existing: null, proposed, tweaks };
      } catch (err) {
        console.error(`[pipeline] ${productionId}: profile tweak proposal failed — keeping channel defaults:`, err);
        return { existing: null, proposed: null as ProductionProfile | null, tweaks: null };
      }
    });

    if (profileStage.existing) {
      // re-fired run: the per-video profile was already decided — final
      profile = resolveProductionProfile(profileStage.existing, { contentFormat: ctx.contentFormat });
    } else if (gated) {
      const profileGateId = await step.run("create-profile-gate", async () => {
        const { db } = await getContext();
        const gateId = ulid();
        await db.insert(reviewGates).values({
          id: gateId,
          productionId,
          kind: "profile_review",
          payloadSnapshot: {
            channelProfile,
            proposed: profileStage.proposed ?? channelProfile,
            tweaks: profileStage.tweaks,
          },
        });
        await db
          .update(productions)
          .set({ status: "profile_review", currentGateId: gateId })
          .where(eq(productions.id, productionId));
        return gateId;
      });
      const profileDecision = await step.waitForEvent("await-profile-gate", {
        event: "production/gate.decided",
        if: `async.data.gateId == "${profileGateId}"`,
        timeout: GATE_TIMEOUT,
      });
      if (profileDecision === null) {
        await step.run("profile-gate-timeout", () =>
          setStatus(productionId, "on_hold", "profile_review gate timed out"),
        );
        return { outcome: "on_hold", reason: "profile gate timeout" };
      }
      // rejected = "keep the channel defaults" (the video still produces);
      // approved = the operator's edited profile, falling back to the proposal
      if (profileDecision.data.decision === "approved") {
        const edited = profileDecision.data.editedProfile as Partial<ProductionProfile> | undefined;
        // MERGE the gate's edited axes OVER the full channel profile (2026-07-16):
        // the gate UI only exposes a subset of axes, so using `edited` alone
        // silently reset every field it doesn't include — visualDirector (#37),
        // the per-role image/video engines, image density, clip budget — back to
        // defaults. Layering channel → AI proposal → operator edits preserves them.
        profile = resolveProductionProfile(
          { ...channelProfile, ...(profileStage.proposed ?? {}), ...(edited ?? {}) },
          { contentFormat: ctx.contentFormat },
        );
      }
    } else if (profileStage.proposed) {
      // T2/T3: auto-apply the AI proposal
      profile = profileStage.proposed;
    }
    if (!profileStage.existing) {
      await step.run("persist-video-profile", async () => {
        const { db } = await getContext();
        await db
          .update(productions)
          .set({ productionProfile: profile })
          .where(eq(productions.id, productionId));
      });
    }

    // #27 operator-recorded voiceover: when the operator chose to record,
    // pend the recording-booth gate BEFORE any TTS spend. The gate panel is
    // the per-beat recorder; approve = takes done (beats without a take are
    // TTS-filled — hybrid for free); reject = fall back to full TTS. A
    // resumed run with a voiceover asset already attached skips the gate.
    let useOperatorTakes = await step.run("check-voice-source", async () => {
      const { db } = await getContext();
      const [prod] = await db
        .select({ voiceSource: productions.voiceSource })
        .from(productions)
        .where(eq(productions.id, productionId));
      if ((prod?.voiceSource ?? "tts") !== "operator") return false;
      const [existing] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "voiceover"), eq(assets.idx, 0)));
      return !existing;
    });
    if (useOperatorTakes) {
      const recordingGateId = await step.run("create-recording-gate", async () => {
        const { db } = await getContext();
        const gateId = ulid();
        await db.insert(reviewGates).values({
          id: gateId,
          productionId,
          kind: "voiceover_recording",
          payloadSnapshot: { beatCount: (script.beats as ScriptBeat[]).length },
        });
        await db
          .update(productions)
          .set({ status: "voiceover_recording", currentGateId: gateId })
          .where(eq(productions.id, productionId));
        return gateId;
      });
      const recordingDecision = await step.waitForEvent("await-recording-gate", {
        event: "production/gate.decided",
        if: `async.data.gateId == "${recordingGateId}"`,
        timeout: GATE_TIMEOUT,
      });
      if (recordingDecision === null) {
        await step.run("recording-gate-timeout", () =>
          setStatus(productionId, "on_hold", "voiceover recording gate timed out"),
        );
        return { outcome: "on_hold", reason: "voiceover recording gate timeout" };
      }
      if (recordingDecision.data.decision !== "approved") {
        // operator opted back out — full TTS, recorded takes stay archived
        useOperatorTakes = false;
        await step.run("recording-gate-fallback", async () => {
          const { db } = await getContext();
          await db
            .update(productions)
            .set({ voiceSource: "tts" })
            .where(eq(productions.id, productionId));
        });
      }
    }

    // 4) voiceover with word-level timestamps
    const voiceover = await step.run("synthesize-voiceover", async () => {
      const { db, providers, costSink, env } = await getContext();
      await setStatus(productionId, "producing_assets");
      // reuse (Land 3): a resumed/force-forwarded production carries copied
      // assets — reuse the voiceover instead of re-synthesizing.
      const [kept] = await db
        .select()
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "voiceover"), eq(assets.idx, 0)));
      if (kept) {
        return {
          storageKey: kept.storageKey,
          mimeType: kept.mimeType,
          durationSec: kept.durationSec ?? 0,
        };
      }
      const voiceSettings = {
        ...deliveryVoiceSettings(profile.delivery),
        speed: paceToSpeed(ctx.persona.doc.pace),
      };
      // #27: assemble recorded takes (+ per-beat TTS fill) into ONE voiceover
      // asset — downstream (shots/captions/render) is untouched.
      const res = useOperatorTakes
        ? await (async () => {
            const takes = await db
              .select()
              .from(assets)
              .where(and(eq(assets.productionId, productionId), eq(assets.kind, "voiceover_take")));
            const takeByBeat = new Map(takes.map((t) => [t.idx, t.storageKey]));
            const assembled = await assembleOperatorVoiceover({
              store: providers.store,
              voice: providers.voice,
              costSink,
              env,
              productionId,
              channelId: ctx.idea.channelId,
              voiceId: ctx.dna?.voiceId ?? "default",
              voiceSettings,
              beats: (script.beats as ScriptBeat[]).map((b, i) => ({
                beatIdx: i,
                text: b.text,
                takeKey: takeByBeat.get(i),
              })),
            });
            return { ...assembled, sources: assembled.sources };
          })()
        : await providers.voice.synthesize({
            text: script.fullText,
            voiceId: ctx.dna?.voiceId ?? "default",
            channelId: ctx.idea.channelId,
            productionId,
            // Production Profile "delivery" axis → TTS expression (real provider
            // maps it to voice_settings; the mock ignores it). Persona `pace`
            // (#26) merges in as the speed multiplier — natural = 1.0 (no change).
            voiceSettings,
          });
      const voMeta = {
        words: res.words,
        // #27 provenance: which beats spoke in the operator's voice
        ...("sources" in res ? { sources: res.sources, source: "operator" } : {}),
      };
      await db
        .insert(assets)
        .values({
          id: ulid(),
          productionId,
          kind: "voiceover",
          idx: 0,
          storageKey: res.storageKey,
          mimeType: res.mimeType,
          durationSec: res.durationSec,
          meta: voMeta,
        })
        .onConflictDoUpdate({
          target: [assets.productionId, assets.kind, assets.idx],
          set: {
            storageKey: res.storageKey,
            mimeType: res.mimeType,
            durationSec: res.durationSec,
            meta: voMeta,
          },
        });
      // words stay in the asset row only — see the read below.
      return { storageKey: res.storageKey, mimeType: res.mimeType, durationSec: res.durationSec };
    });

    // Word timestamps are deliberately NOT part of the step's return value: a
    // long-form voiceover carries thousands of them (~100KB+), and anything a
    // step returns rides in EVERY subsequent request/response between Inngest
    // and the worker — the prime suspect in the intermittent "Invalid
    // signature" failures on big runs. A plain (non-step) read re-runs on each
    // incremental invocation, which is one cheap indexed query; step state
    // stays small.
    const voiceoverWords = await (async () => {
      const { db } = await getContext();
      const [row] = await db
        .select({ meta: assets.meta })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "voiceover"), eq(assets.idx, 0)));
      return ((row?.meta as { words?: WordTimestamp[] } | null)?.words ?? []) as WordTimestamp[];
    })();

    // 5) shots (#4): sub-divide each beat into shots cut on the spoken rhythm
    // (Production Profile "rhythm" axis), so a fresh image lands every few
    // seconds instead of one still per whole beat. One image step per shot.
    const beats = script.beats as ScriptBeat[];
    // shared options (2026-07-12 long-form fewer/longer stills; 2026-07-15 cap
    // shot length to the clip cap when the video animates so every shot moves)
    const spo = shotPlanOptions(profile, { isLong, durationSec: voiceover.durationSec, maxClipSec: MAX_CLIP_SEC() });
    let shots = planShots(beats, voiceoverWords, spo);
    // #37 Phase 2: when the director cut the shots, IT owns character casting
    // (it placed the character deliberately) — the smart-% pass is bypassed.
    let directorActive = false;
    // Visual Director (#37, opt-in): a frontier agent re-cuts the shots on
    // MEANING and picks each shot's medium (still/clip/real) from the channel's
    // allowed palette. Persisted on the draft so the Animate button + cockpit
    // estimate cut identically; a malformed pass keeps the mechanical cut above.
    if (profile.visualDirector) {
      const directedSeq = await step.run("direct-visuals", async () => {
        const { db } = await getContext();
        const seq = await directVisualSequence(await agentCtx(), {
          beats: beats.map((b) => ({
            type: b.type,
            text: b.text,
            visualBrief: b.visualBrief,
            referenceEntity: b.referenceEntity,
            heroShot: b.heroShot,
          })),
          durationSec: voiceover.durationSec,
          niche: ctx.niche,
          orientation,
          styleBlock: ctx.style ? styleBlockForImagePrompts(ctx.style.doc) : null,
          characters: ctx.characters
            .filter((c) => c.castMode !== "off")
            .map((c) => ({ name: c.name, description: c.description })),
          visualMode: profile.visualMode,
          motion: profile.motion,
          maxAiClips: profile.maxAiClips ?? Number(process.env.VIDEO_MAX_AI_CLIPS ?? "12"),
          targetShotCount: shots.length, // the mechanical count is the cadence target
        });
        if (seq) {
          const [latest] = await db
            .select({ id: scriptDrafts.id })
            .from(scriptDrafts)
            .where(eq(scriptDrafts.productionId, productionId))
            .orderBy(desc(scriptDrafts.version))
            .limit(1);
          if (latest) await db.update(scriptDrafts).set({ directedSequence: seq.shots }).where(eq(scriptDrafts.id, latest.id));
        }
        return seq?.shots ?? null;
      });
      if (directedSeq) {
        const directed = planShotsFromDirection(beats, voiceoverWords, directedSeq, {
          durationSec: voiceover.durationSec,
          maxShotSec: spo.maxShotSec,
        });
        if (directed) {
          shots = directed;
          directorActive = true;
        }
      }
    }
    // Image-prompt builder (#21, audit §4.4): one pass turns the scriptwriter's
    // scene ideas into proper FLUX prompts — subject-first, explicit lighting,
    // positive-only phrasing, one shared Style/Mood suffix across the set —
    // and finally wires the operator's Production Profile artDirection in.
    // Fail-safe: any trouble falls back to the draft prompts unchanged.
    const builtPrompts = await step.run("build-image-prompts", async () =>
      buildImagePrompts(await agentCtx(), {
        shots: shots.map((s) => ({
          text: s.text,
          imagePrompt: s.imagePrompt,
          referenceEntity: s.referenceEntity,
          visualBrief: s.visualBrief,
          // Visual Director intent (#37) grounds the articulation when present
          shotScale: s.shotScale,
          angle: s.angle,
          intent: s.intent,
          motif: s.motif,
        })),
        imageStyle: ctx.dna?.visualStyle?.imageStyle ?? "clean flat illustration, high contrast",
        artDirection: profile.artDirection ?? null,
        // #35.1: the channel's distilled visual style rides every prompt
        styleBlock: ctx.style ? styleBlockForImagePrompts(ctx.style.doc) : null,
        orientation,
        niche: ctx.niche,
        // 2026-07-14 recurring characters: the agent casts them per scene;
        // role tells it which one is the default on-screen presenter, castMode
        // whether it's a mascot (always) or should never appear (off) (2026-07-15)
        characters: ctx.characters
          .filter((c) => c.castMode !== "off")
          .map((c) => ({ name: c.name, description: c.description, role: c.role, castMode: c.castMode })),
      }),
    );
    // Duplicate-reals fix (2026-07-12): shots sharing a referenceEntity must
    // not all pick the same top candidate (the Wikipedia lead image won every
    // time → the same photo on consecutive shots). Precompute each shot's
    // occurrence index for its entity BEFORE the parallel fan-out —
    // deterministic, no shared state across the concurrent steps — and rotate
    // the candidate list by that offset inside the step.
    // Smart character casting (2026-07-16): decide the mascot's shots ONCE,
    // across the whole shot list, by importance — hero/named/opener beats first,
    // diagram/text establishing frames last — instead of a blind index stride.
    // The un-cast shots then fall through to the cheap bulk engine below (their
    // `castCharacter` is null → the bulk-role engine, qwen by default), which is where the
    // credit saving comes from. Deterministic so Inngest replays reproduce it.
    const mascot =
      ctx.characters.find(
        (c) => c.role === "main" && c.castMode !== "off" && c.castMode !== "auto",
      ) ?? ctx.characters.find((c) => c.castMode !== "off" && c.castMode !== "auto") ?? null;
    const forcedCharacterShots = (() => {
      // #37 Phase 2: the director already placed the character per shot — skip
      // the smart-% pass entirely so casting isn't double-decided.
      if (directorActive) return new Set<number>();
      if (!mascot) return new Set<number>();
      const pct = targetPctForCast(mascot.castMode, mascot.castTarget);
      if (pct == null) return new Set<number>();
      return selectForcedCharacterShots(
        shots.map((s, i) => ({
          heroShot: s.heroShot,
          type: s.type,
          text: s.text,
          prompt: builtPrompts[i]?.prompt ?? s.imagePrompt,
          builderCharacter: builtPrompts[i]?.character ?? null,
        })),
        mascot.name,
        pct,
      );
    })();

    const entitySeen = new Map<string, number>();
    const entityOccurrence = shots.map((s) => {
      if (!s.referenceEntity) return 0;
      const n = entitySeen.get(s.referenceEntity) ?? 0;
      entitySeen.set(s.referenceEntity, n + 1);
      return n;
    });
    const imageResults = await Promise.all(
      shots.map((shot, i) =>
        step.run(`generate-image-shot-${i}`, async () => {
          const { db, providers } = await getContext();
          // reuse (Land 3): a shot image already stored for THIS production is a
          // same-production replay — reuse it directly. An image COPIED from a
          // prior run (its key holds a DIFFERENT production id) is only reused if
          // it still FITS this shot (checked below, once the prompt is built) —
          // otherwise it's regenerated, so a revised script after a resume never
          // keeps unrelated old archival photos (2026-07-15 operator report).
          const [kept] = await db
            .select()
            .from(assets)
            .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image"), eq(assets.idx, i)));
          const keptIsOwn = !!kept && kept.storageKey.startsWith(`productions/${productionId}/`);
          if (keptIsOwn) return { storageKey: kept!.storageKey, mimeType: kept!.mimeType };
          // subject-accurate imagery (#7) under the archival-strength dial
          // (2026-07-12 operator ask: 8 real / 74 AI on a historical video —
          // the old flow tried at most ONE candidate per shot against a fixed
          // fit bar). The policy scales candidates fetched + the accept bar,
          // and at strong/max topic-searches even when a named entity failed.
          // visualMode still rules: AI-image/AI-video channels never source.
          let res: { storageKey: string; mimeType: string; engine?: string };
          let meta: Record<string, unknown>;
          const policy = archivalImagePolicy(profile);
          let finalPrompt = builtPrompts[i]?.prompt ?? shot.imagePrompt;
          // 2026-07-14 recurring characters: the prompt builder cast one into
          // this shot — condition the generation on its reference sheet so the
          // face/outfit stay consistent (nano edits natively; flux i2i).
          // 2026-07-15: honour cast_mode — the builder's pick is dropped if that
          // character is "off"; a mascot is forced into a deterministic share of
          // shots (25/50/75/always) even when the builder cast nobody.
          const castName = builtPrompts[i]?.character ?? null;
          const builderCastRaw = castName
            ? (ctx.characters.find((c) => c.name === castName && c.castMode !== "off") ?? null)
            : null;
          // 2026-07-17 (operator: hero look-alikes were rendering on unrelated,
          // non-character shots). Under cast_mode "auto" — builder discretion,
          // the DEFAULT — only HONOUR the builder's cast when the shot is
          // genuinely ABOUT the character: a hero beat, or narration/brief that
          // names them. Every other shot (incidental person, hands, crowd,
          // demonstration, historical figure) stays character-free and renders
          // in the general channel style, so no look-alike is spawned. Explicit
          // modes (smart/25/50/75/always) opted INTO presence, so their cast +
          // the forced-share planner still govern unchanged.
          const genuineCharacterShot =
            shot.heroShot === true ||
            (castName ? mentionsName(castName, shot.text, builtPrompts[i]?.prompt, shot.visualBrief) : false);
          const builderCast =
            builderCastRaw && builderCastRaw.castMode === "auto" && !genuineCharacterShot
              ? null
              : builderCastRaw;
          // the mascot is forced only into the shots the smart planner picked
          // (computed once above); everything else falls through to qwen.
          const forcedCharacter = mascot && forcedCharacterShots.has(i) ? mascot : null;
          // #37 Phase 2: when the director is active it OWNS casting — this shot
          // gets exactly the character the director placed on it (or none),
          // respecting a character set to "off". Otherwise the smart-%/builder
          // path above decides.
          const directorCast =
            directorActive && shot.character
              ? (ctx.characters.find((c) => c.name === shot.character && c.castMode !== "off") ?? null)
              : null;
          const castCharacter = directorActive ? directorCast : (builderCast ?? forcedCharacter);
          // Character present, scene-led (2026-07-15 operator: the character was
          // taking over the frame). The reference sheet below is the real identity
          // anchor (0.55, nano), so the SCENE leads the prompt and the character is
          // named as a PARTICIPANT with a short cue — not prepended verbatim as the
          // dominant subject. Only added when the builder didn't already name them.
          if (castCharacter) {
            const name = castCharacter.name;
            if (!finalPrompt.toLowerCase().includes(name.toLowerCase())) {
              const idCue = castCharacter.description.trim().slice(0, 90);
              finalPrompt = `${finalPrompt} — ${name} (${idCue}) is present in the scene, on-model, integrated naturally into the action rather than posed in the foreground.`;
            }
          }
          // copied-from-a-prior-run image: reuse ONLY if it still matches this
          // shot's content; a mismatch (revised script → different shot) is
          // regenerated instead of showing an unrelated old photo.
          if (kept) {
            try {
              const bytes = await providers.store.getBuffer(kept.storageKey);
              const keptFit = await scoreImageFit(await agentCtx(), {
                image: bytes,
                mimeType: kept.mimeType,
                shotText: shot.text,
                imagePrompt: finalPrompt,
                entity: shot.referenceEntity ?? "",
              });
              if (keptFit.fits && keptFit.score >= policy.fitMin) {
                return { storageKey: kept.storageKey, mimeType: kept.mimeType };
              }
            } catch {
              // scoring failed — fall through and regenerate rather than risk a stale frame
            }
          }
          type RefImage = {
            storageKey: string;
            mimeType: string;
            sourceUrl: string;
            license: string;
            attribution: string;
          };
          let ref: RefImage | null = null;
          let fit: ImageFit | null = null;
          // Relevance gate (#4 cut 2): score each candidate's pixels; accept
          // the first at/above the policy bar. A scoring error fails safe:
          // keep the candidate (pre-scoring behaviour).
          const firstFitting = async (
            cands: RefImage[],
            entity: string,
          ): Promise<{ cand: RefImage; fit: ImageFit | null } | null> => {
            for (const cand of cands) {
              try {
                const bytes = await providers.store.getBuffer(cand.storageKey);
                const score = await scoreImageFit(await agentCtx(), {
                  image: bytes,
                  mimeType: cand.mimeType,
                  shotText: shot.text,
                  imagePrompt: finalPrompt,
                  entity,
                });
                if (score.fits && score.score >= policy.fitMin) return { cand, fit: score };
              } catch {
                return { cand, fit: null };
              }
            }
            return null;
          };
          if (policy.attemptSourcing && shot.referenceEntity) {
            const occ = entityOccurrence[i]!;
            const cands =
              (policy.candidates > 1 || occ > 0) && providers.reference.findEntityImages
                ? await providers.reference.findEntityImages({
                    entity: shot.referenceEntity,
                    channelId: ctx.idea.channelId,
                    productionId,
                    idx: i,
                    // later occurrences fetch a deeper pool so rotation has
                    // fresh candidates to land on
                    limit: Math.min(8, policy.candidates + occ),
                    // shot-specific search context → different photo pools
                    // for different shots of the same subject
                    hint: shot.visualBrief ?? shot.text.slice(0, 60),
                  })
                : [
                    await providers.reference.findEntityImage({
                      entity: shot.referenceEntity,
                      channelId: ctx.idea.channelId,
                      productionId,
                      idx: i,
                    }),
                  ].filter((c): c is RefImage => c !== null);
            // rotate by occurrence: the k-th shot of an entity starts at the
            // k-th candidate instead of re-picking the same lead image
            const start = cands.length ? occ % cands.length : 0;
            const rotated = [...cands.slice(start), ...cands.slice(0, start)];
            const hit = await firstFitting(rotated, shot.referenceEntity);
            if (hit) {
              ref = hit.cand;
              fit = hit.fit;
            }
          }
          // Topic-keyword archival fallback (#24): shots with no named entity
          // — and, at strong/max, shots whose entity search found nothing —
          // relevance-search the archive over the shot's own sentence.
          let topicSourced = false;
          if (
            !ref &&
            policy.topicFallback &&
            (!shot.referenceEntity || policy.topicSecondPass) &&
            (providers.reference.findTopicImage || providers.reference.findTopicImages)
          ) {
            const cands =
              policy.candidates > 1 && providers.reference.findTopicImages
                ? await providers.reference.findTopicImages({
                    keywords: shot.text,
                    channelId: ctx.idea.channelId,
                    productionId,
                    idx: i,
                    limit: policy.candidates,
                  })
                : providers.reference.findTopicImage
                  ? [
                      await providers.reference.findTopicImage({
                        keywords: shot.text,
                        channelId: ctx.idea.channelId,
                        productionId,
                        idx: i,
                      }),
                    ].filter((c): c is RefImage => c !== null)
                  : [];
            const picked = await firstFitting(cands, shot.text.slice(0, 120));
            if (picked) {
              ref = picked.cand;
              fit = picked.fit;
              topicSourced = true;
            }
          }
          if (ref) {
            res = { storageKey: ref.storageKey, mimeType: ref.mimeType };
            meta = {
              ...(shot.referenceEntity ? { entity: shot.referenceEntity } : {}),
              ...(topicSourced ? { topic: shot.text.slice(0, 200) } : {}),
              source: ref.sourceUrl,
              license: ref.license,
              attribution: ref.attribution,
              ...(fit ? { fitScore: fit.score } : {}),
              // 2026-07-14: the shot's narration rides the asset so the swap
              // dialog can show "what this frame covers" (idx = SHOT index,
              // which sub-divides script beats — beat text won't align)
              narration: shot.text.slice(0, 280),
            };
          } else {
            // hero tier (2026-07-12): the story's pivotal shots render on the
            // premium image model for accuracy. 2026-07-15: a cast character
            // ALSO forces hero/nano — identity needs the compositional editor
            // (nano composes a new scene from the reference; qwen-image-edit
            // just edits the sheet and drops the aspect), matching the "perfect"
            // Style-tab test-scene path the operator confirmed.
            const quality = shot.heroShot || castCharacter ? ("hero" as const) : undefined;
            // per-ROLE engine (2026-07-16): character / hero / bulk each route to
            // their own channel setting (character + hero default to Nano —
            // identity needs its compositional editor — but the operator can
            // override per role now).
            const imageRole = castCharacter ? "character" : shot.heroShot ? "hero" : "bulk";
            const engine = imageEngineForRole(profile, imageRole);
            // on failure, degrade down the Style-tab engines only (never a
            // hardcoded qwen the operator didn't pick) — e.g. hero nano 429 →
            // the channel's seedream bulk, not qwen.
            const fallbackEngines = imageEnginePreference(profile, imageRole);
            // #35.1 style conditioning: reference-IMAGE conditioning only works
            // on nano (it composes in-style); on qwen the edit model mangles a
            // style ref, so we DROP the ref there and rely on the distilled
            // styleBlock TEXT already in the prompt. Cast shots use their
            // character sheet in the single reference slot instead.
            const styleCond = ctx.style ? resolveConditioning(ctx.style.doc) : null;
            const conditionThis =
              !castCharacter &&
              engine === "nano-banana" &&
              !!styleCond &&
              (styleCond.scope === "all_generated" ||
                (styleCond.scope === "thumbs_hero" && !!shot.heroShot)) &&
              !!providers.store.presignGet &&
              ctx.style!.refKeys.length > 0;
            const styleRefKey = conditionThis
              ? styleRefKeyForIndex(ctx.style!.refKeys, i)
              : undefined;
            const styleArgs = styleRefKey
              ? {
                  referenceImageUrl: await providers.store.presignGet!(styleRefKey, 900),
                  referenceStrength: styleCond!.strength,
                }
              : {};
            // character reference beats style reference for the cast shots —
            // one reference slot per generation, and identity wins over look
            const characterArgs =
              castCharacter && providers.store.presignGet
                ? {
                    referenceImageUrl: await providers.store.presignGet(castCharacter.imageKey, 900),
                    referenceStrength: 0.55,
                  }
                : {};
            res = await providers.media.generateImage({
              prompt: finalPrompt,
              aspect: beatAspect,
              channelId: ctx.idea.channelId,
              productionId,
              idx: i,
              quality,
              engine,
              fallbackEngines,
              ...styleArgs,
              ...characterArgs,
            });
            // (2026-07-16) The FLUX-specific text-junk regeneration was removed
            // with fal — the direct engines (Nano/Qwen/Seedream) render text far
            // better, so a per-image vision recheck isn't worth the cost.
            meta = {
              prompt: finalPrompt,
              draftPrompt: shot.imagePrompt,
              narration: shot.text.slice(0, 280),
              ...(quality === "hero" ? { hero: true } : {}),
              // what we ASKED for vs what actually served it — so a silent
              // fallback (engine failed/keyless → degraded) is visible at the
              // visuals gate, not buried in worker logs (2026-07-16 operator)
              engineRequested: engine,
              ...(res.engine ? { engineServed: res.engine } : {}),
              ...(castCharacter ? { character: castCharacter.name, characterId: castCharacter.id } : {}),
              ...(styleRefKey ? { styleRef: styleRefKey } : {}),
              ...(fit ? { rejectedReference: fit.reason, rejectedScore: fit.score } : {}),
              // #37 Phase 2: the director's plan for this shot, surfaced in the storyboard
              ...(shot.shotScale ? { shotScale: shot.shotScale } : {}),
              ...(shot.medium ? { medium: shot.medium } : {}),
              ...(shot.intent ? { directorIntent: shot.intent } : {}),
            };
          }
          await db
            .insert(assets)
            .values({
              id: ulid(),
              productionId,
              kind: "image",
              idx: i,
              storageKey: res.storageKey,
              mimeType: res.mimeType,
              meta,
            })
            .onConflictDoUpdate({
              target: [assets.productionId, assets.kind, assets.idx],
              set: { storageKey: res.storageKey, mimeType: res.mimeType, meta },
            });
          return res;
        }),
      ),
    );

    // 5.6) automatic duplicate sweep (2026-07-12 operator: "auto mode must
    // not pump out rubbish") — the cockpit's Auto-fix button, in-pipeline for
    // EVERY tier: a real image whose source photo already appears earlier in
    // the production is re-sourced from the deep hinted pool (used sources
    // excluded, vision fit gate) BEFORE the render ever sees it. Returns the
    // final storage key per shot — the render must use these, not the
    // memoized per-shot results.
    const finalImageKeys = await step.run("dedupe-real-images", async () => {
      const { db, providers } = await getContext();
      const rows = await db
        .select()
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")))
        .orderBy(asc(assets.idx));
      const keyByIdx = new Map(rows.map((r) => [r.idx, r.storageKey]));
      let duplicates = 0;
      let replaced = 0;
      if (providers.reference.findEntityImages) {
        const used = new Set<string>();
        for (const a of rows) {
          const m = (a.meta ?? {}) as Record<string, unknown>;
          const src = typeof m.source === "string" ? m.source : null;
          if (!src) continue;
          if (!used.has(src)) {
            used.add(src);
            continue;
          }
          duplicates++;
          const shot = shots[a.idx];
          const entity =
            (typeof m.entity === "string" && m.entity) || shot?.referenceEntity || null;
          if (!entity) continue;
          const cands = await providers.reference.findEntityImages({
            entity,
            channelId: ctx.idea.channelId,
            productionId,
            // keys land at (600+idx)*100+n — clear of shot refs (idx*100),
            // thumbnails (100+) and operator-swap blocks (100k+)
            idx: 600 + a.idx,
            limit: 8,
            hint: shot?.visualBrief ?? shot?.text.slice(0, 60),
          });
          let picked: (typeof cands)[number] | null = null;
          let pickedFit: number | null = null;
          for (const cand of cands) {
            if (used.has(cand.sourceUrl)) continue;
            try {
              const bytes = await providers.store.getBuffer(cand.storageKey);
              const f = await scoreImageFit(await agentCtx(), {
                image: bytes,
                mimeType: cand.mimeType,
                shotText: shot?.text ?? entity,
                imagePrompt: entity,
                entity,
              });
              if (f.fits && f.score >= 4) {
                picked = cand;
                pickedFit = f.score;
                break;
              }
            } catch {
              picked = cand; // fail-safe: scorer trouble never blocks the sweep
              break;
            }
          }
          if (!picked) continue; // archive dry for this subject — keep the dupe
          used.add(picked.sourceUrl);
          await db
            .update(assets)
            .set({
              storageKey: picked.storageKey,
              mimeType: picked.mimeType,
              meta: {
                entity,
                source: picked.sourceUrl,
                license: picked.license,
                attribution: picked.attribution,
                ...(pickedFit != null ? { fitScore: pickedFit } : {}),
                autoDedupe: true,
              },
            })
            .where(eq(assets.id, a.id));
          keyByIdx.set(a.idx, picked.storageKey);
          replaced++;
        }
        if (duplicates > 0) {
          await db.insert(agentActions).values({
            id: ulid(),
            agentName: "visual_dedupe",
            channelId: ctx.idea.channelId,
            ideaId: ctx.idea.id,
            productionId,
            inputSummary: `auto duplicate sweep: ${replaced}/${duplicates} repeated real images re-sourced`,
            output: { duplicates, replaced },
          });
        }
      }
      return shots.map((_, i) => keyByIdx.get(i) ?? imageResults[i]!.storageKey);
    });

    // 5.65) MOTION (BACKLOG #26 + #6, 2026-07-14): planMotion gives the
    // Profile's motion axis its real semantics — "partial" moves hero beats,
    // "ai_video" animates everything eligible. Real-imagery channels source
    // clips (archival → Pexels) with AI image-to-video as fallback; AI-imagery
    // channels animate their beat images directly (i2v keeps the style/
    // character look). Clips are video_clip assets idx-aligned with images;
    // the visuals gate shows them; the render prefers them; every miss or
    // failure silently keeps the still. Watch the first motion render.
    const motionPlan = planMotion(shots, profile, {
      maxClipSec: Number(process.env.VIDEO_MAX_CLIP_SEC ?? "10"),
      // per-video clip budget (2026-07-16 cost knob): the channel profile's
      // maxAiClips overrides the env default when set
      maxAiClips: profile.maxAiClips ?? Number(process.env.VIDEO_MAX_AI_CLIPS ?? "12"),
    });
    const footageKeys: (string | null)[] = await step.run("source-hero-footage", async () => {
      const keys: (string | null)[] = shots.map(() => null);
      const { db, providers, env } = await getContext();
      const existing = await db
        .select({ idx: assets.idx, storageKey: assets.storageKey })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip")));
      for (const e of existing) keys[e.idx] = e.storageKey; // reuse on re-fire
      for (const entry of motionPlan) {
        if (entry.mode !== "stock" || keys[entry.idx]) continue;
        const i = entry.idx;
        const shot = shots[i]!;
        try {
          let clip: FootageClip | null = null;
          if (shot.referenceEntity) {
            clip = await sourceHeroClip(providers.store, {
              entity: shot.referenceEntity,
              hint: shot.visualBrief ?? shot.text.slice(0, 60),
              aspect: beatAspect,
              durationSec: shot.endSec - shot.startSec,
              productionId,
              idx: i,
            });
          }
          if (!clip && env.PEXELS_API_KEY) {
            clip = await sourcePexelsClip(providers.store, {
              query: shot.referenceEntity ?? shot.visualBrief ?? shot.text.slice(0, 60),
              aspect: beatAspect,
              durationSec: shot.endSec - shot.startSec,
              productionId,
              idx: i,
              apiKey: env.PEXELS_API_KEY,
            });
          }
          if (!clip) continue;
          const meta = {
            source: clip.sourceUrl,
            license: clip.license,
            attribution: clip.attribution,
            ...(shot.referenceEntity ? { entity: shot.referenceEntity } : {}),
          };
          await db
            .insert(assets)
            .values({
              id: ulid(),
              productionId,
              kind: "video_clip",
              idx: i,
              storageKey: clip.storageKey,
              mimeType: clip.mimeType,
              meta,
            })
            .onConflictDoUpdate({
              target: [assets.productionId, assets.kind, assets.idx],
              // meta included (2026-07-14 fix): re-sourcing used to keep the
              // OLD clip's license/attribution on the new file
              set: { storageKey: clip.storageKey, mimeType: clip.mimeType, meta },
            });
          keys[i] = clip.storageKey;
        } catch (err) {
          console.error(`[pipeline] ${productionId}: stock footage shot ${i} failed — keeping still:`, err);
        }
      }
      return keys;
    });

    // 5.66) AI beat clips (2026-07-14, faceless tier): image-to-video over the
    // beat's generated still — Wan (DashScope) / Minimax per the channel's
    // videoEngine. Covers ai_i2v plan entries plus stock misses that carry the
    // fallback flag. Skips any idx that already has a clip (idempotent, never
    // overwrites a sourced clip). Generated clips carry NO license field, so
    // the credits builder correctly ignores them. Sequential on purpose —
    // vendor rate limits; the per-video cap bounds wall-clock.
    await step.run("generate-ai-clips", async () => {
      const wanted = motionPlan.filter(
        (e) => e.mode === "ai_i2v" || (e.mode === "stock" && e.aiFallback && !footageKeys[e.idx]),
      );
      if (wanted.length === 0) return { generated: 0 };
      const { db, providers } = await getContext();
      const existing = await db
        .select({ idx: assets.idx })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip")));
      const have = new Set(existing.map((e) => e.idx));
      // character-aware clip routing (2026-07-16): a clip whose still cast the
      // recurring character animates on the character engine (e.g. Seedance for
      // identity) when the profile sets one; filler clips stay on videoEngine.
      // The image asset's meta.characterId is the source of truth (written when
      // the shot was cast) — no need to recompute the cast plan here.
      const charIdx = new Set<number>();
      if (profile.characterVideoEngine) {
        const imgRows = await db
          .select({ idx: assets.idx, meta: assets.meta })
          .from(assets)
          .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")));
        for (const r of imgRows) {
          if ((r.meta as { characterId?: string } | null)?.characterId) charIdx.add(r.idx);
        }
      }
      let generated = 0;
      for (const entry of wanted) {
        const i = entry.idx;
        if (have.has(i)) continue;
        const shot = shots[i]!;
        try {
          // shared with the operator's "Animate this shot" (clip-generation.ts):
          // animates the beat's own image, normalizes to the beat length, upserts
          const result = await generateShotVideoClip(
            { db, providers },
            {
              productionId,
              channelId: ctx.idea.channelId,
              idx: i,
              // an agent writes the i2v prompt from the actual frame + context
              motion: {
                scene: shot.visualBrief ?? shot.imagePrompt ?? shot.text,
                shotText: shot.text,
                visualBrief: shot.visualBrief,
              },
              agentCtx: await agentCtx(),
              aspect: beatAspect,
              beatLenSec: shot.endSec - shot.startSec,
              engine: videoEngineFor(profile, { character: charIdx.has(i), hero: !!shot.heroShot }),
            },
          );
          if (result) generated++; // render re-reads live video_clip rows — no key threading needed
        } catch (err) {
          console.error(`[pipeline] ${productionId}: AI clip shot ${i} failed — keeping still:`, err);
        }
      }
      return { generated };
    });

    // 5.7) VISUALS REVIEW gate (2026-07-12 operator: "why render first, then
    // review the inputs and re-render?") — on gated channels the operator
    // reviews/swaps the image set BEFORE the render exists: every polish is
    // free instead of costing a re-render. The render step re-reads the
    // asset rows after this gate, so any swap made while it pends is what
    // actually renders. T2/T3 skip straight to render as before.
    if (gated) {
      const visualsGateId = await step.run("create-visuals-gate", async () => {
        const { db } = await getContext();
        const gateId = ulid();
        await db.insert(reviewGates).values({
          id: gateId,
          productionId,
          kind: "visuals_review",
          payloadSnapshot: { shotCount: shots.length },
        });
        await db
          .update(productions)
          .set({ status: "visuals_review", currentGateId: gateId })
          .where(eq(productions.id, productionId));
        return gateId;
      });
      const visualsDecision = await step.waitForEvent("await-visuals-gate", {
        event: "production/gate.decided",
        if: `async.data.gateId == "${visualsGateId}"`,
        timeout: GATE_TIMEOUT,
      });
      if (visualsDecision === null) {
        await step.run("visuals-gate-timeout", () =>
          setStatus(productionId, "on_hold", "visuals_review gate timed out"),
        );
        return { outcome: "on_hold", reason: "visuals gate timeout" };
      }
      if (visualsDecision.data.decision === "rejected") {
        await step.run("visuals-rejected", () =>
          setStatus(productionId, "on_hold", "visuals rejected at review — swap or regenerate, then retry from render"),
        );
        return { outcome: "on_hold", reason: "visuals rejected" };
      }
    }

    // 6) variation check — compliance gate before anything can reach `ready`
    const variation = await step.run("variation-check", async () => {
      const { db } = await getContext();
      const priors = await db
        .select({
          productionId: productions.id,
          fingerprint: productions.substanceFingerprint,
        })
        .from(productions)
        .where(
          and(
            eq(productions.channelId, ctx.idea.channelId),
            ne(productions.id, productionId),
            // abandoned drafts (rejected/halted/failed/on_hold) aren't published
            // content, so they must not trip the anti-clone check — a resumed or
            // force-forwarded production reuses its parent's fingerprint and
            // would otherwise self-match.
            notInArray(productions.status, ["rejected", "halted", "failed", "on_hold"]),
            isNotNull(productions.substanceFingerprint),
          ),
        )
        .orderBy(desc(productions.createdAt))
        .limit(20);

      const result = checkVariation(
        script.substanceFingerprint,
        priors.map((p) => ({ productionId: p.productionId, fingerprint: p.fingerprint! })),
      );

      let blocked = result.verdict === "fail";
      let reason = `jaccard=${result.maxSimilarity.toFixed(3)}`;
      if (result.verdict === "borderline" && result.closest) {
        const [prior] = await db
          .select({ fp: productions.substanceFingerprint })
          .from(productions)
          .where(eq(productions.id, result.closest.productionId));
        const judged = await judgeSimilarity(
          await agentCtx(),
          script.substanceFingerprint,
          prior?.fp ?? "",
          result.maxSimilarity,
        );
        blocked = judged.similar;
        reason += `; judge: ${judged.reason}`;
      }

      // anti-clone (build #4): also compare the full narration against scouted
      // competitor transcripts for this niche. Pattern learning informs shape,
      // never verbatim substance — a hard overlap is the same hard-fail as the
      // intra-channel check.
      const [channelRow] = await db
        .select({ niche: channels.niche })
        .from(channels)
        .where(eq(channels.id, ctx.idea.channelId));
      const externals = channelRow
        ? await db
            .select({
              externalId: externalVideos.externalId,
              title: externalVideos.title,
              transcript: externalVideos.transcript,
            })
            .from(externalVideos)
            .where(
              and(
                eq(externalVideos.niche, channelRow.niche),
                isNotNull(externalVideos.transcript),
              ),
            )
            .limit(50)
        : [];
      const external = checkExternalSimilarity(script.fullText, externals);
      if (external.verdict === "fail") {
        blocked = true;
        reason += `; external-clone jaccard=${external.maxSimilarity.toFixed(3)}${external.closest ? ` vs "${external.closest.title}"` : ""}`;
      }

      // evidence row for the compliance log
      await db.insert(agentActions).values({
        id: ulid(),
        agentName: "variation_check",
        channelId: ctx.idea.channelId,
        productionId,
        inputSummary: `variation check vs ${priors.length} recent productions + ${externals.length} external videos`,
        output: { ...result, external, blocked, reason },
      });
      return { blocked, reason, maxSimilarity: result.maxSimilarity };
    });

    if (variation.blocked && !bypassChecks) {
      await step.run("variation-blocked", () =>
        setStatus(
          productionId,
          "on_hold",
          `variation check failed: substance too similar (${variation.reason})`,
        ),
      );
      return { outcome: "on_hold", reason: "variation check failed" };
    }
    if (variation.blocked && bypassChecks) await logOverride("variation", variation.reason);

    // 6b) multi-checker review board (build #5.2) — because T2+ channels have
    // no per-video human gate, compliance / charter-alignment / platform-safety
    // checkers must pass before anything is rendered or published; quality is
    // advisory. Charter'd channels only (legacy channels keep pre-#5 behavior).
    // Same triad as factuality: check → agent_actions evidence row → on_hold.
    const board = await step.run("review-board", async () => {
      const { db } = await getContext();
      const [charter] = await db
        .select()
        .from(channelCharters)
        .where(eq(channelCharters.channelId, ctx.idea.channelId));
      if (!charter) {
        return { skipped: true as const, blocked: false, reason: null as string | null };
      }
      const [channelRow] = await db
        .select({ niche: channels.niche })
        .from(channels)
        .where(eq(channels.id, ctx.idea.channelId));
      const patternRows = channelRow
        ? await topPatternsForNiche(db, { niche: channelRow.niche, limit: 5 })
        : [];
      const res = await runReviewBoard(await agentCtx(), {
        idea: { title: ctx.idea.title, angle: ctx.idea.angle },
        script: { hookText: script.hookText, fullText: script.fullText },
        dna: ctx.dna
          ? { tone: ctx.dna.tone, forbiddenTopics: ctx.dna.forbiddenTopics }
          : null,
        charter: { mission: charter.mission, objectives: charter.objectives ?? [] },
        verifiedFacts: factuality.facts,
        conjecture: factuality.conjecture,
        factualityMode: ctx.factualityMode,
        patternLines: patternsToPromptLines(patternRows),
      });
      // summary evidence row — each checker already wrote its own via runAgent
      await db.insert(agentActions).values({
        id: ulid(),
        agentName: "review_board",
        channelId: ctx.idea.channelId,
        ideaId: ctx.idea.id,
        productionId,
        inputSummary: `pre-publish review board over script v${approvedVersion} (${res.results.length} checkers)`,
        output: { results: res.results, blocked: res.blocked, reason: res.reason },
      });
      if (res.blocked && !bypassChecks) {
        await setStatus(productionId, "on_hold", `review board: ${res.reason}`);
      }
      return { skipped: false as const, blocked: res.blocked, reason: res.reason };
    });
    if (board.blocked && !bypassChecks) {
      return { outcome: "on_hold", reason: "review board failed" };
    }
    if (board.blocked && bypassChecks) await logOverride("review-board", board.reason);

    // 6b) background-music bed (Production Profile "music" axis). Off → no bed;
    // subtle/standard → one instrumental track sized to the voiceover, ducked
    // under the narration by the render. Its own step so a render retry reuses
    // the (real, non-deterministic) track instead of re-billing for it.
    const music = await step.run("generate-music", async () => {
      const { db, providers } = await getContext();
      // The operator picks a track in the cockpit Music panel (production_music
      // rows). An explicit selection wins; else the newest candidate.
      const rows = await db
        .select()
        .from(productionMusic)
        .where(eq(productionMusic.productionId, productionId))
        .orderBy(desc(productionMusic.createdAt));
      let selected = rows.find((r) => r.selected) ?? null;
      if (!selected && rows.length) {
        selected = rows[0]!;
        await db.update(productionMusic).set({ selected: true }).where(eq(productionMusic.id, selected.id));
      }
      // Axis level when on. If the operator EXPLICITLY picked/generated a track
      // but left the Music axis "off" (the default), still play it at the
      // standard level — selecting a track is intent, and silently dropping it
      // is exactly the "render had no music" surprise (2026-07-17 operator).
      const axisOn = profile.music !== "off";
      const volume = axisOn ? (MUSIC_VOLUMES[profile.music] ?? 0) : MUSIC_VOLUMES.standard;
      if (selected) return { musicKey: selected.storageKey, musicVolume: volume };
      // No track yet: only auto-generate a bed when the axis actually asks for music.
      if (!axisOn || volume <= 0) return null;
      const prompt = musicBriefFor(profile.musicMood, {
        title: ctx.idea?.title,
        tone: ctx.dna?.tone,
      });
      const bed = await providers.music.generateBed({
        durationSec: voiceover.durationSec,
        prompt,
        channelId: ctx.idea.channelId,
        productionId,
        storageKeyBase: `productions/${productionId}/music`,
      });
      await db.insert(productionMusic).values({
        id: ulid(),
        productionId,
        storageKey: bed.storageKey,
        mimeType: bed.mimeType,
        durationSec: bed.durationSec,
        mood: profile.musicMood ?? null,
        prompt,
        engine: providers.music.name,
        selected: true,
      });
      return { musicKey: bed.storageKey, musicVolume: volume };
    });

    // 7) assemble + render
    const render = await step.run("render", async () => {
      const { db, providers, costSink, env } = await getContext();
      await setStatus(productionId, "assembling");
      // reuse (Land 3): a copied render skips the (expensive) re-render.
      const [keptRender] = await db
        .select()
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "render"), eq(assets.idx, 0)));
      if (keptRender) return { storageKey: keptRender.storageKey, renderSec: 0 };
      // CURRENT asset rows, not memoized keys (2026-07-12): swaps made while
      // the visuals gate pended — or by any operator action pre-render —
      // must be what actually renders.
      const liveRows = await db
        .select({ idx: assets.idx, storageKey: assets.storageKey })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")));
      const liveKeyByIdx = new Map(liveRows.map((r) => [r.idx, r.storageKey]));
      // carry-forward (2026-07-16): a shot whose image was REMOVED by the
      // operator has no key — hold the previous frame over its time instead of
      // breaking the render. Head shots without an image use the first real one.
      const rawImageKeys = shots.map((_, i) => liveKeyByIdx.get(i) ?? finalImageKeys[i] ?? null);
      const firstImage = rawImageKeys.find((k): k is string => !!k) ?? null;
      let carryImage: string | null = null;
      const renderImageKeys = rawImageKeys.map((k) => {
        if (k) carryImage = k;
        return (k ?? carryImage ?? firstImage)!;
      });
      // #26: current footage rows (a swap or gate-time change may have moved
      // them) — the render prefers a clip over the still where one exists
      const liveClips = await db
        .select({ idx: assets.idx, storageKey: assets.storageKey })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip")));
      const clipByIdx = new Map(liveClips.map((r) => [r.idx, r.storageKey]));
      const renderVideoKeys = shots.map((_, i) => clipByIdx.get(i) ?? footageKeys[i] ?? null);
      const props = buildShortProps({
        shots,
        imageSrcs: renderImageKeys,
        videoSrcs: renderVideoKeys,
        words: voiceoverWords,
        audioSrc: voiceover.storageKey,
        musicSrc: music?.musicKey,
        musicVolume: music?.musicVolume,
        durationSec: voiceover.durationSec,
        orientation,
        brand: {
          primaryColor: ctx.dna?.visualStyle?.primaryColor ?? "#38bdf8",
          font: ctx.dna?.visualStyle?.font ?? "Inter",
        },
        captions: profile.captions,
      });
      const renderInput = {
        productionId,
        props,
        imageKeys: renderImageKeys,
        videoKeys: renderVideoKeys,
        audioKey: voiceover.storageKey,
        musicKey: music?.musicKey,
      };
      // BACKLOG #18: Remotion Lambda when configured (all five REMOTION_*
      // secrets + the R2 store), else the local CPU render. Config-level
      // fallback: clear REMOTION_LAMBDA_FUNCTION_NAME on /account.
      const lambdaCfg = getLambdaConfig(env);
      const res = lambdaCfg
        ? await renderShortOnLambda(providers.store, renderInput, lambdaCfg)
        : { costUsd: null as number | null, ...(await renderShort(providers.store, renderInput)) };
      // record what this render actually baked in, so the cockpit can flag a
      // stale cut (clips/music added since) and prompt a re-render (2026-07-17).
      const renderMeta = {
        clipIdxs: renderVideoKeys.map((k, i) => (k ? i : -1)).filter((i) => i >= 0),
        musicKey: music?.musicKey ?? null,
      };
      await db
        .insert(assets)
        .values({
          id: ulid(),
          productionId,
          kind: "render",
          idx: 0,
          storageKey: res.storageKey,
          mimeType: "video/mp4",
          durationSec: voiceover.durationSec,
          meta: renderMeta,
        })
        .onConflictDoUpdate({
          target: [assets.productionId, assets.kind, assets.idx],
          set: { storageKey: res.storageKey, durationSec: voiceover.durationSec, meta: renderMeta },
        });
      await costSink.record({
        category: "render",
        provider: lambdaCfg ? "remotion-lambda" : "remotion",
        units: { renderSec: Math.round(res.renderSec) },
        costUsd: res.costUsd ?? (res.renderSec / 3600) * RENDER_COST_PER_HOUR,
        channelId: ctx.idea.channelId,
        productionId,
      });
      return res;
    });

    // 7b) thumbnail engine (§5.5): candidates against the channel's
    // thumbnail spec, scored for predicted CTR; operator picks at the gate
    const thumbCandidates = await step.run("generate-thumbnails", async () => {
      const { db, providers } = await getContext();
      // reuse (Land 3) + dedupe: if thumbnails already exist for this production
      // (copied on resume, or a replay), use them instead of generating more.
      const existingThumbs = await db.select().from(thumbnails).where(eq(thumbnails.productionId, productionId));
      if (existingThumbs.length) {
        return existingThumbs.map((t) => ({ id: t.id, storageKey: t.storageKey, predictedCtr: t.predictedCtr }));
      }
      const spec = ctx.dna?.thumbnailSpec;
      const style = ctx.dna?.visualStyle?.imageStyle ?? "clean flat illustration, high contrast";
      // #35.3: ground on the freshest deconstructed WINNING thumbnails for
      // this niche (intel scan writes them; empty until the first scan runs)
      // intel rows are stored format "shorts" today; thumbnail click
      // mechanics transfer across formats, so query the store as-is
      const thumbPatterns = await topPatternsForNiche(db, {
        niche: ctx.niche,
        format: "shorts",
        kind: "thumbnail",
        limit: 3,
      }).catch(() => []);
      // best-practice prompt builder (single dominant subject, rule of thirds,
      // contrast, depth, feed-size legibility, text only when the spec demands
      // it) — pure, in core; adds a pattern-led 3rd candidate when grounded
      const prompts = buildThumbnailPrompts({
        title: ctx.idea.title,
        angle: ctx.idea.angle,
        style,
        spec,
        isLong,
        patterns: thumbPatterns.map((p) => ({
          label: p.label,
          detail: p.detail as Record<string, string> | null,
        })),
        // #35.1: the channel's distilled style — palette/typography defaults +
        // promptSuffix on every concept
        styleDoc: ctx.style?.doc ?? null,
      });
      const patternLabels = thumbPatterns.map((p) => p.label);
      const scoreOne = async (storageKey: string, mimeType: string, prompt: string) => {
        // v2: vision scoring over the actual pixels, judged at feed size;
        // any failure (store read, vision model) falls back to the v1
        // prompt-text scorer so the pipeline never blocks on scoring.
        try {
          const bytes = await providers.store.getBuffer(storageKey);
          return await scoreThumbnailCandidate(await agentCtx(), {
            image: bytes,
            mimeType,
            title: ctx.idea.title,
          });
        } catch (err) {
          console.error(`[pipeline] vision thumbnail scoring failed for ${productionId} — falling back to prompt-text scoring:`, err);
          return scoreThumbnailFromPrompt(await agentCtx(), prompt);
        }
      };
      // #35.1 style conditioning: every scope except "off" conditions
      // thumbnails; refs rotate across candidates so they don't clone one
      // reference. Degrades to prompts-only without presignGet or refs.
      const thumbCond = ctx.style ? resolveConditioning(ctx.style.doc) : null;
      const conditionThumbs =
        !!thumbCond &&
        thumbCond.scope !== "off" &&
        !!providers.store.presignGet &&
        ctx.style!.refKeys.length > 0;
      const out = [];
      for (let i = 0; i < prompts.length; i++) {
        const styleRefKey = conditionThumbs
          ? styleRefKeyForIndex(ctx.style!.refKeys, i)
          : undefined;
        const styleArgs = styleRefKey
          ? {
              referenceImageUrl: await providers.store.presignGet!(styleRefKey, 900),
              referenceStrength: thumbCond!.strength,
            }
          : {};
        let img = await providers.media.generateImage({
          prompt: prompts[i]!,
          aspect: beatAspect,
          channelId: ctx.idea.channelId,
          productionId,
          idx: 100 + i, // offset: beat images own 0..N
          // thumbnails are the video's highest-leverage frames (CTR) and only
          // 2-4 per video — always worth the hero model when configured
          quality: "hero",
          engine: imageEngineForRole(profile, "thumbnail"),
          fallbackEngines: imageEnginePreference(profile, "thumbnail"),
          ...styleArgs,
        });
        let score = await scoreOne(img.storageKey, img.mimeType, prompts[i]!);
        // #35.3 pre-gate: a candidate the scorer pans regenerates ONCE with a
        // bolder brief before the operator ever sees it; keep the better take.
        let regenerated = false;
        if (score.predictedCtr < THUMB_REGEN_CTR_FLOOR) {
          const bolder =
            `${prompts[i]!} Bolder and simpler: one exaggerated dominant subject, ` +
            `harder light, stronger color pop, even less background detail.`;
          const retry = await providers.media.generateImage({
            prompt: bolder,
            aspect: beatAspect,
            channelId: ctx.idea.channelId,
            productionId,
            idx: 110 + i, // regen offset — never collides with 100+i
            quality: "hero",
            engine: imageEngineForRole(profile, "thumbnail"),
            fallbackEngines: imageEnginePreference(profile, "thumbnail"),
            ...styleArgs,
          });
          const retryScore = await scoreOne(retry.storageKey, retry.mimeType, bolder);
          if (retryScore.predictedCtr > score.predictedCtr) {
            img = retry;
            score = retryScore;
            regenerated = true;
          }
        }
        const id = ulid();
        await db.insert(thumbnails).values({
          id,
          productionId,
          storageKey: img.storageKey,
          predictedCtr: score.predictedCtr,
          meta: {
            prompt: prompts[i],
            patterns: patternLabels,
            regenerated,
            ...(styleRefKey ? { styleRef: styleRefKey, styleId: ctx.style!.id, styleVersion: ctx.style!.version } : {}),
          },
        });
        out.push({ id, storageKey: img.storageKey, predictedCtr: score.predictedCtr });
      }
      return out;
    });

    // 8) final review gate — operator watches the rendered short
    // (skipped on T2/T3; those publish automatically and T2 releases later)
    let scheduledFor: string | undefined;
    if (gated) {
      const finalGateId = await step.run("create-final-gate", async () => {
        const { db } = await getContext();
        const gateId = ulid();
        await db.insert(reviewGates).values({
          id: gateId,
          productionId,
          kind: "thumbnail_review",
          payloadSnapshot: {
            renderKey: render.storageKey,
            scriptVersion: approvedVersion,
            durationSec: voiceover.durationSec,
            thumbnailCandidates: thumbCandidates,
          },
        });
        await db
          .update(productions)
          .set({ status: "thumbnail_review", currentGateId: gateId })
          .where(eq(productions.id, productionId));
        return gateId;
      });

      const finalDecision = await step.waitForEvent("await-final-gate", {
        event: "production/gate.decided",
        if: `async.data.gateId == "${finalGateId}"`,
        timeout: GATE_TIMEOUT,
      });

      if (finalDecision === null) {
        await step.run("final-gate-timeout", () =>
          setStatus(productionId, "on_hold", "final gate timed out"),
        );
        return { outcome: "on_hold", reason: "final gate timeout" };
      }
      if (finalDecision.data.decision !== "approved") {
        await step.run("final-gate-not-approved", () =>
          setStatus(productionId, "rejected", `final gate: ${finalDecision.data.decision}`),
        );
        return { outcome: "rejected" };
      }
      scheduledFor = finalDecision.data.scheduledFor;
    }

    await step.run("mark-ready", () => setStatus(productionId, "ready"));

    // 8a) warm-up throttle (build #3 + #8): a still-ramping channel releases on
    // the format's warm-up cadence + daypart instead of posting like an
    // established one (a spam signal). This now applies to GATED channels too
    // (#8): when the operator approves without picking a date, the video is
    // auto-slotted onto the ramp so the plan reaches the schedule/calendar
    // instead of publishing immediately. An operator-supplied date wins;
    // graduated channels fall through to immediate publish (no slot).
    const warmupFormat: "shorts" | "long" = isLong ? "long" : "shorts";
    if (!scheduledFor) {
      // #23.1 lock-in: an approved series episode already holds a TENTATIVE
      // slot projected at series approval — prefer it (when still in the
      // future) so the tentative date becomes the locked schedule instead of
      // inventing a new one. Falls through to the warm-up slotting otherwise.
      const tentativeSlot = await step.run("tentative-lock-in", async () => {
        const { db } = await getContext();
        const [episode] = await db
          .select({ tentativeFor: episodes.tentativeFor })
          .from(episodes)
          .where(eq(episodes.ideaId, ctx.idea.id));
        if (!episode?.tentativeFor) return null;
        const at = new Date(episode.tentativeFor);
        return at.getTime() > Date.now() ? at.toISOString() : null;
      });
      const warmupSlot =
        tentativeSlot ??
        (await step.run("warmup-schedule", async () => {
          const { db } = await getContext();
          const state = await channelWarmupState(db, ctx.idea.channelId, new Date(), warmupFormat);
          if (!state || state.graduated) return null;
          const plan = planWarmupRelease({
            format: warmupFormat,
            launchedAt: state.launchedAt,
            now: new Date(),
            releasedThisWeek: state.releasedThisWeek,
          });
          return plan.scheduledFor.toISOString();
        }));
      scheduledFor = warmupSlot ?? undefined;
    }

    // 8b) scheduled release time (operator's pick, or the warm-up slot above).
    // #8: create the `publications` row NOW with the future scheduledFor (no
    // video yet) so the schedule is queryable + shows on the calendar.
    // #20 (YouTube-native scheduling): the pipeline no longer sleeps until the
    // slot — the publish step below uploads IMMEDIATELY with status.publishAt,
    // and YouTube flips the video public at the slot itself. No sleeping run =
    // no cancel/duplicate-upload class of bugs, and reschedule is one
    // videos.update call instead of run surgery.
    if (scheduledFor && new Date(scheduledFor).getTime() > Date.now()) {
      await step.run("mark-scheduled", async () => {
        const { db, providers } = await getContext();
        await setStatus(productionId, "scheduled");
        const [existing] = await db
          .select({ id: publications.id })
          .from(publications)
          .where(eq(publications.productionId, productionId))
          .limit(1);
        if (!existing) {
          await db.insert(publications).values({
            id: ulid(),
            productionId,
            provider: providers.publish.name,
            privacyStatus: "private",
            aiDisclosure: true,
            scheduledFor: new Date(scheduledFor),
          });
        } else {
          await db
            .update(publications)
            .set({ scheduledFor: new Date(scheduledFor) })
            .where(eq(publications.id, existing.id));
        }
      });
    }

    // 8c) YouTube quota gate — an upload costs ~1,600 of 10,000 units/day.
    // Only enforced against the real API (mock quota is not scarce).
    for (let attempt = 0; attempt < 5; attempt++) {
      const quota = await step.run(`check-quota-${attempt}`, async () => {
        const { db, providers } = await getContext();
        if (providers.publish.name !== "youtube") return { ok: true, resetAt: "" };
        const [row] = await db
          .select({
            used: sql<number>`coalesce(sum((${costRecords.units}->>'quotaUnits')::int), 0)`,
          })
          .from(costRecords)
          .where(
            and(
              eq(costRecords.category, "publish"),
              eq(costRecords.provider, "youtube"),
              gte(costRecords.createdAt, quotaWindowStart()),
            ),
          );
        const used = Number(row?.used ?? 0);
        const ok = used + YOUTUBE_UPLOAD_QUOTA_UNITS <= youtubeDailyQuota();
        if (!ok) await setStatus(productionId, "scheduled", "waiting for YouTube quota reset");
        return { ok, resetAt: nextQuotaReset().toISOString(), used };
      });
      if (quota.ok) break;
      if (attempt === 4) {
        await step.run("quota-exhausted", () =>
          setStatus(productionId, "on_hold", "YouTube quota exhausted across multiple windows"),
        );
        return { outcome: "on_hold", reason: "quota exhausted" };
      }
      await step.sleepUntil(`quota-wait-${attempt}`, new Date(quota.resetAt));
    }

    // 9) upload with AI disclosure. Scheduled releases go up NOW as private +
    // status.publishAt (#20) — YouTube publishes them at the slot; unscheduled
    // uploads stay private until the operator's Release click, as before. The
    // publish-finalize cron flips the DB rows live when the slot passes.
    //
    // Duplicate-upload incident (2026-07-11): the old single "publish" step
    // did upload + thumbnail + DB bookkeeping in one step.run. A ~10-min video
    // uploaded successfully but the step timed out before the video id was
    // recorded, so Inngest's 3 retries re-ran the WHOLE step — four copies on
    // YouTube, and the publications row never got provider_video_id. The flow
    // is now: preflight (idempotency guard + metadata) → upload (ONLY the
    // upload call) → record the id in its own step immediately → thumbnail →
    // finalize statuses. A retry of any later step never re-uploads, and a
    // retry of the upload step itself adopts the orphan via findRecentUpload.

    // 9a) preflight: build the metadata and DETECT an already-uploaded video —
    // (i) the publications row already carries provider_video_id (a previous
    // attempt recorded it), or (ii) the provider can see a just-uploaded video
    // with this exact title (the orphan of an upload-then-timeout attempt).
    const preflight = await step.run("publish-preflight", async () => {
      const { db, providers } = await getContext();
      const publishAt =
        scheduledFor && new Date(scheduledFor).getTime() > Date.now()
          ? new Date(scheduledFor).toISOString()
          : undefined;
      const title = ctx.idea.title.slice(0, 100);
      // Image attribution (#7): CC-BY requires crediting the author wherever the
      // image is used, so credit every licensed reference image in the
      // description. Generated images (meta.prompt, no licence) need no credit.
      // #26: credit licensed STILLS and FOOTAGE alike; the source URL carries
      // the archive, so no hardcoded "via Wikimedia" (footage is NASA/IA).
      const licensedAssets = await db
        .select({ meta: assets.meta })
        .from(assets)
        .where(
          and(
            eq(assets.productionId, productionId),
            inArray(assets.kind, ["image", "video_clip"]),
          ),
        );
      const seenCredits = new Set<string>();
      const creditLines: string[] = [];
      for (const a of licensedAssets) {
        const m = a.meta as { entity?: string; source?: string; license?: string; attribution?: string } | null;
        if (!m?.license || !m.source || seenCredits.has(m.source)) continue;
        seenCredits.add(m.source);
        const who = m.attribution ? `${m.attribution}, ` : "";
        creditLines.push(`• ${m.entity ? `${m.entity} — ` : ""}${who}${m.license}: ${m.source}`);
      }
      // funnel (#6): a derived Short one-way links to its long-form master
      let funnelLine: string[] = [];
      const [prodRow] = await db
        .select({ masterProductionId: productions.masterProductionId })
        .from(productions)
        .where(eq(productions.id, productionId));
      if (prodRow?.masterProductionId) {
        const [masterPub] = await db
          .select({ url: publications.url })
          .from(publications)
          .where(eq(publications.productionId, prodRow.masterProductionId));
        if (masterPub?.url) funnelLine = ["", `▶ Watch the full video: ${masterPub.url}`];
      }
      // Unfilled-template guard (2026-07-12: "[sprint theme]" went out in a
      // live description) — a CTA still carrying [bracket] placeholders is
      // template junk, not copy; drop it and flag rather than publish it.
      const rawCta = ctx.dna?.ctaTemplate ?? "";
      const ctaLine = /\[[^\]\n]{1,60}\]/.test(rawCta) ? "" : rawCta;
      if (rawCta && !ctaLine) {
        console.error(
          `[pipeline] ${productionId}: channel ctaTemplate contains an unfilled placeholder — omitted from the description. Fix it in Settings & DNA: ${rawCta.slice(0, 120)}`,
        );
      }
      const description = [
        ctx.idea.angle,
        "",
        ctaLine,
        ...funnelLine,
        "",
        "This video contains AI-generated content.",
        ...(creditLines.length ? ["", "Image credits:", ...creditLines] : []),
      ]
        .join("\n")
        .slice(0, 4900); // YouTube description hard limit is 5000 chars

      // (i) a previous attempt already recorded the id — but TRUST, THEN
      // VERIFY (2026-07-12 shell-video incident: the recorded id pointed at a
      // YouTube record with metadata and no media, so the scheduled release
      // could never fire and nothing alerted). Reuse the id only when the
      // provider confirms processed media behind it.
      const [existingPub] = await db
        .select({
          providerVideoId: publications.providerVideoId,
          url: publications.url,
          publishedAt: publications.publishedAt,
        })
        .from(publications)
        .where(eq(publications.productionId, productionId))
        .limit(1);
      if (existingPub?.providerVideoId) {
        const remote = await providers.publish.videoStatus({
          channelId: ctx.idea.channelId,
          providerVideoId: existingPub.providerVideoId,
        });
        const reuse = {
          publishAt,
          title,
          description,
          videoId: existingPub.providerVideoId,
          url: existingPub.url,
          adopted: false,
        };
        // provider can't answer (mock mode / read error): keep the old
        // behavior — never risk a duplicate upload on a blind retry
        if (remote.state === "unknown") return reuse;
        if (remote.state === "found") {
          if (remote.durationSec != null) return reuse;
          // shell: metadata exists but YouTube never got the media — a fresh
          // upload is the only way this video can ever go live. The dead
          // record stays on the channel for the operator to delete.
          await db.insert(agentActions).values({
            id: ulid(),
            agentName: "publish_shell_detected",
            channelId: ctx.idea.channelId,
            ideaId: ctx.idea.id,
            productionId,
            inputSummary: `recorded video ${existingPub.providerVideoId} has no media on the provider (uploadStatus=${remote.uploadStatus ?? "?"}) — re-uploading; DELETE the dead record in Studio`,
            output: { providerVideoId: existingPub.providerVideoId, uploadStatus: remote.uploadStatus },
          });
          console.error(
            `[pipeline] ${productionId}: video ${existingPub.providerVideoId} is a medialess shell — re-uploading fresh`,
          );
        } else if (remote.state === "missing") {
          if (existingPub.publishedAt) {
            // deleted AFTER going live — deliberate takedown; re-uploading is
            // a spam signal (BACKLOG #10) and needs an explicit operator reset
            throw new Error(
              `Video ${existingPub.providerVideoId} was published and has since been deleted on the provider — refusing to re-upload (BACKLOG #10). Clear the publication row to override.`,
            );
          }
          // deleted before ever going live (e.g. operator removed a broken
          // upload): a fresh upload is the intended recovery path
          await db.insert(agentActions).values({
            id: ulid(),
            agentName: "publish_reupload_after_delete",
            channelId: ctx.idea.channelId,
            ideaId: ctx.idea.id,
            productionId,
            inputSummary: `recorded video ${existingPub.providerVideoId} no longer exists on the provider and was never live — uploading fresh`,
            output: { previousProviderVideoId: existingPub.providerVideoId },
          });
          console.log(
            `[pipeline] ${productionId}: recorded video ${existingPub.providerVideoId} is gone (never live) — uploading fresh`,
          );
        }
      }
      // (ii) orphan adoption: an upload that succeeded but whose id was lost
      if (providers.publish.findRecentUpload) {
        const orphan = await providers.publish.findRecentUpload({
          channelId: ctx.idea.channelId,
          title,
          withinMinutes: 120,
        });
        if (orphan) {
          await db.insert(agentActions).values({
            id: ulid(),
            agentName: "publish_adopt_orphan",
            channelId: ctx.idea.channelId,
            ideaId: ctx.idea.id,
            productionId,
            inputSummary: `adopted already-uploaded video ${orphan} (exact title match within 120 min) instead of re-uploading`,
            output: { providerVideoId: orphan, title },
          });
          console.log(
            `[pipeline] ${productionId}: adopting orphan upload ${orphan} (title match) — skipping duplicate upload`,
          );
          return { publishAt, title, description, videoId: orphan, url: null, adopted: true };
        }
      }
      return { publishAt, title, description, videoId: null, url: null, adopted: false };
    });

    // 9b) THE UPLOAD — its own step containing ONLY the upload call, so a
    // timeout retries into the preflight-guarded path above (the next attempt
    // adopts the orphan) and never replays any bookkeeping.
    const uploaded: { providerVideoId: string; url: string | null } = preflight.videoId
      ? { providerVideoId: preflight.videoId, url: preflight.url }
      : await step.run("upload-video", async () => {
          const { providers } = await getContext();
          const res = await providers.publish.upload({
            channelId: ctx.idea.channelId,
            productionId,
            videoStorageKey: render.storageKey,
            title: preflight.title,
            description: preflight.description,
            tags: ctx.idea.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 10),
            privacy: "private",
            publishAt: preflight.publishAt,
            selfDeclaredAiContent: true,
            madeForKids: false,
          });
          return { providerVideoId: res.providerVideoId, url: res.url as string | null };
        });

    // 9c) record provider_video_id IMMEDIATELY, in its own step — the write
    // whose absence caused the duplicate uploads. Nothing else happens here;
    // a retry of this step is an idempotent upsert.
    const publicationId = await step.run("record-provider-video-id", async () => {
      const { db, providers } = await getContext();
      const url =
        uploaded.url ??
        (providers.publish.name === "youtube"
          ? `https://www.youtube.com/watch?v=${uploaded.providerVideoId}`
          : null);
      const [row] = await db
        .select({ id: publications.id })
        .from(publications)
        .where(eq(publications.productionId, productionId))
        .limit(1);
      if (row) {
        await db
          .update(publications)
          .set({
            provider: providers.publish.name,
            providerVideoId: uploaded.providerVideoId,
            ...(url ? { url } : {}),
          })
          .where(eq(publications.id, row.id));
        return row.id;
      }
      const id = ulid();
      await db.insert(publications).values({
        id,
        productionId,
        provider: providers.publish.name,
        providerVideoId: uploaded.providerVideoId,
        url,
        privacyStatus: "private",
        aiDisclosure: true,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      });
      return id;
    });

    // 9c.5) verify the provider actually HAS the media (shell-video guard,
    // 2026-07-12 incident). Duration appears as soon as YouTube has ingested
    // the bytes; a record that never shows one is an upload that silently
    // lost its body and would sit at "Processing will begin shortly" forever.
    // Failing here makes the run visibly fail (and a later re-fire hits the
    // preflight shell check, which re-uploads fresh).
    await step.run("verify-upload-media", async () => {
      const { providers } = await getContext();
      const deadline = Date.now() + 3 * 60_000;
      for (;;) {
        const remote = await providers.publish.videoStatus({
          channelId: ctx.idea.channelId,
          providerVideoId: uploaded.providerVideoId,
        });
        // mock mode / read error — nothing to verify against
        if (remote.state === "unknown") return { verified: false as const };
        if (remote.state === "missing") {
          throw new Error(
            `Uploaded video ${uploaded.providerVideoId} vanished from the provider before verification`,
          );
        }
        if (remote.uploadStatus === "failed" || remote.uploadStatus === "rejected") {
          throw new Error(
            `Provider reports uploadStatus=${remote.uploadStatus} for ${uploaded.providerVideoId} — the upload did not take`,
          );
        }
        if (remote.durationSec != null) return { verified: true as const, durationSec: remote.durationSec };
        if (Date.now() > deadline) {
          throw new Error(
            `Video ${uploaded.providerVideoId} still has no media 3 min after upload (processingStatus=${remote.processingStatus ?? "?"}) — treating as a failed upload`,
          );
        }
        await new Promise((r) => setTimeout(r, 15_000));
      }
    });

    // 9d) thumbnail: operator's pick, else the best-scoring candidate (T2/T3)
    await step.run("set-video-thumbnail", async () => {
      const { db, providers } = await getContext();
      const candidates = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.productionId, productionId));
      const chosen =
        candidates.find((t) => t.selected) ??
        [...candidates].sort((a, b) => (b.predictedCtr ?? 0) - (a.predictedCtr ?? 0))[0];
      if (!chosen) return;
      if (!chosen.selected) {
        await db.update(thumbnails).set({ selected: true }).where(eq(thumbnails.id, chosen.id));
      }
      const baseMeta = { ...(chosen.meta ?? {}) } as Record<string, unknown>;
      try {
        await providers.publish.setThumbnail({
          channelId: ctx.idea.channelId,
          productionId,
          providerVideoId: uploaded.providerVideoId,
          imageStorageKey: chosen.storageKey,
        });
        // success — clear any stale failure marker so the UI stops warning
        if (baseMeta.applyError) {
          delete baseMeta.applyError;
          await db.update(thumbnails).set({ meta: baseMeta }).where(eq(thumbnails.id, chosen.id));
        }
      } catch (err) {
        // custom thumbnails need a verified YouTube account — don't fail the
        // publish, but DON'T swallow it silently either (2026-07-15 operator
        // report: "published but it used a plain frame, not my thumbnail").
        // Persist the reason so the production page can flag it + offer retry.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[pipeline] setThumbnail failed for ${productionId}:`, err);
        await db
          .update(thumbnails)
          .set({ meta: { ...baseMeta, applyError: reason } })
          .where(eq(thumbnails.id, chosen.id));
      }
    });

    // 9e) finalize statuses. #8: the row created at schedule time keeps its
    // scheduledFor. #20: a natively-scheduled upload stays privacyStatus
    // "scheduled" with publishedAt null — the publish-finalize cron flips it
    // live at the slot.
    const publication = await step.run("finalize-publication", async () => {
      const { db } = await getContext();
      const liveNow = !preflight.publishAt;
      await db
        .update(publications)
        .set({
          privacyStatus: liveNow ? "private" : "scheduled",
          publishedAt: liveNow ? new Date() : null,
        })
        .where(eq(publications.id, publicationId));
      await db
        .update(productions)
        .set({ status: liveNow ? "published" : "scheduled", currentGateId: null })
        .where(eq(productions.id, productionId));
      const [row] = await db
        .select({ url: publications.url })
        .from(publications)
        .where(eq(publications.id, publicationId));
      return { publicationId, url: row?.url ?? null, scheduled: !liveNow };
    });

    // Scheduled uploads are done here: YouTube flips them public at the slot,
    // and publish-finalize handles the go-live bookkeeping + post-publish
    // events. Immediate (unscheduled) uploads keep the original behaviour.
    if (publication.scheduled) {
      return { outcome: "scheduled", url: publication.url };
    }

    await step.sendEvent("emit-published", {
      name: "production/published",
      data: { productionId, publicationId: publication.publicationId },
    });

    // Long→Shorts (#6): if this is an ORIGINAL master (not itself a derived
    // Short) whose channel feeds a linked Shorts channel, derive Shorts from it.
    const shouldDerive = await step.run("check-derive-shorts", async () => {
      const { db } = await getContext();
      const [prod] = await db
        .select({ master: productions.masterProductionId, channelId: productions.channelId })
        .from(productions)
        .where(eq(productions.id, productionId));
      if (!prod || prod.master) return false;
      const [linked] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.derivedFromChannelId, prod.channelId), eq(channels.status, "active")));
      return !!linked;
    });
    if (shouldDerive) {
      await step.sendEvent("emit-derive-shorts", {
        name: "editorial/derive-shorts.requested",
        data: { masterProductionId: productionId },
      });
    }

    return { outcome: "published", url: publication.url };
  },
);
