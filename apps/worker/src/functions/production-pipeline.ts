import { eq, and, ne, desc, isNotNull, inArray, notInArray } from "drizzle-orm";
import { ulid } from "ulid";
import {
  assets,
  channelCharters,
  channelDna,
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
  type ScriptBeat,
  type WordTimestamp,
} from "@ytauto/db";
import { sql, gte } from "drizzle-orm";
import {
  channelStateSummary,
  channelWarmupState,
  checkExternalSimilarity,
  checkVariation,
  deliveryVoiceSettings,
  inngest,
  minFactsToScript,
  nextQuotaReset,
  planShots,
  preferGeneratedImagery,
  resolveProductionProfile,
  patternsToPromptLines,
  planWarmupRelease,
  quotaWindowStart,
  retrieveMemory,
  topPatternsForNiche,
  youtubeDailyQuota,
  YOUTUBE_UPLOAD_QUOTA_UNITS,
  type ImageFit,
  type ScriptOutput,
} from "@ytauto/core";
import { costRecords } from "@ytauto/db";
import { RENDER_COST_PER_HOUR } from "@ytauto/providers";
import {
  draftScript,
  judgeSimilarity,
  pickHookTemplate,
  runReviewBoard,
  scoreImageFit,
  scoreThumbnailCandidate,
  IMAGE_FIT_MIN,
  type AgentCtx,
} from "@ytauto/agents";
import { thumbnails } from "@ytauto/db";
import { getContext } from "../context";
import { buildShortProps } from "../props";
import { renderShort } from "../render";

const MAX_REVISIONS = 3;
const GATE_TIMEOUT = "7d";

type ProductionStatus = (typeof productions.$inferSelect)["status"];

async function setStatus(productionId: string, status: ProductionStatus, failureReason?: string) {
  const { db } = await getContext();
  await db
    .update(productions)
    .set({ status, ...(failureReason ? { failureReason } : {}) })
    .where(eq(productions.id, productionId));
}

/**
 * The durable production pipeline (spec §5.2): greenlit idea → script →
 * script_review gate → voiceover → visuals → variation check → render →
 * final gate → publish (private). Steps are memoized; replays are safe
 * because storage keys are deterministic and DB writes upsert.
 */
export const productionPipeline = inngest.createFunction(
  {
    id: "production-pipeline",
    idempotency: "event.data.productionId",
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
      await step.run("mark-production-failed", async () => {
        const { db } = await getContext();
        const [prod] = await db.select().from(productions).where(eq(productions.id, productionId));
        // don't clobber an operator-terminal state or an already-published run
        if (!prod || ["halted", "rejected", "published"].includes(prod.status)) return;
        await db
          .update(productions)
          .set({ status: "failed", failureReason: (error?.message ?? "Pipeline failed").slice(0, 500) })
          .where(eq(productions.id, productionId));
        await db
          .update(reviewGates)
          .set({ status: "expired" })
          .where(and(eq(reviewGates.productionId, productionId), eq(reviewGates.status, "pending")));
      });
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
      await db
        .update(productions)
        .set({ inngestRunId: runId })
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
          }
        : null;
      return {
        idea,
        dna,
        channelName: channel?.name ?? "unknown",
        contentFormat: channel?.contentFormat ?? "short",
        autonomyTier: channel?.autonomyTier ?? 0,
        experiment: experiment ?? null,
        resumedScript,
        bypassChecks: production.bypassChecks ?? false,
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
    // Production Profile (#18): the per-channel control plane, resolved once so
    // the render/media steps read the operator's tool choices. First wired axis:
    // captions (burned-in word-by-word) — default ON for Shorts, OFF for long-form.
    const profile = resolveProductionProfile(ctx.dna?.productionProfile ?? null, {
      contentFormat: ctx.contentFormat,
    });
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
        return { skipped: true as const, blocked: false, facts: noFacts, citations: noCitations };
      }

      const claimRows = await db.select().from(claims).where(eq(claims.episodeId, episode.id));
      const unfinished = claimRows.filter((c) => c.status === "unverified");
      const usable = claimRows.filter((c) => c.status === "verified" || c.status === "attributed");
      const citationRows = usable.length
        ? await db
            .select()
            .from(citations)
            .where(inArray(citations.claimId, usable.map((c) => c.id)))
        : [];
      const uncited = usable.filter(
        (c) => !citationRows.some((cit) => cit.claimId === c.id),
      );

      // Facts-gate (build #18): "no full scripts on 1 fact". An episode must
      // carry at least the per-channel minimum of distinct verified/attributed
      // facts before we spend a 28-min render on it.
      const minFacts = minFactsToScript(charter.verificationBar);
      const belowBar = usable.length < minFacts;

      const blocked =
        unfinished.length > 0 || usable.length === 0 || belowBar || uncited.length > 0;
      const reason = blocked
        ? unfinished.length > 0
          ? `${unfinished.length} claim(s) never finished verification`
          : usable.length === 0
            ? "no claim survived verification — will not script ungrounded"
            : belowBar
              ? `only ${usable.length} verified/attributed fact(s) — need ≥${minFacts} to script`
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
          minFactsToScript: minFacts,
          blocked,
          reason,
        },
      });

      if (blocked) {
        await setStatus(productionId, "on_hold", `factuality gate: ${reason}`);
        return { skipped: false as const, blocked: true, facts: noFacts, citations: noCitations };
      }
      return {
        skipped: false as const,
        blocked: false,
        facts: usable.map((c) => ({ id: c.id, tier: c.tier as string, text: c.text })),
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

    // 2-3) script draft → human review gate, with a bounded revision loop.
    // Resume: the reused script is taken as-is (no drafting, no gate).
    let script: ScriptOutput | undefined = resumedScript ?? undefined;
    let approvedVersion = resumedScript ? 1 : 0;
    let revisionNotes = "";
    for (let version = 1; !resumedScript && version <= MAX_REVISIONS + 1; version++) {
      const drafted = await step.run(`draft-script-v${version}`, async () => {
        const { db } = await getContext();
        await setStatus(productionId, "scripting");
        // hook/structure library: scorer picks the skeleton per topic (§5.5)
        const template = await pickHookTemplate(await agentCtx(), ctx.idea);
        const out = await draftScript(await agentCtx(), ctx.idea, ctx.dna ?? undefined, {
          revisionNotes: revisionNotes || undefined,
          hookTemplate: template,
          verifiedFacts: factuality.facts.length ? factuality.facts : undefined,
          groundingContext: grounding ?? undefined,
          experimentDirective: ctx.experiment?.directive,
        });
        const draftId = ulid();
        await db
          .insert(scriptDrafts)
          .values({
            id: draftId,
            productionId,
            version,
            hookTemplateId: template.id,
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
          })
          .where(eq(productions.id, productionId));

        if (!gated) return { script: out, gateId: null };

        const gateId = ulid();
        await db.insert(reviewGates).values({
          id: gateId,
          productionId,
          kind: "script_review",
          payloadSnapshot: {
            scriptDraftId: draftId,
            version,
            hookText: out.hookText,
            fullText: out.fullText,
            // build #5: what each fact rests on, for the human reviewer
            ...(factuality.citations.length ? { citations: factuality.citations } : {}),
          },
        });
        await db
          .update(productions)
          .set({ status: "script_review", currentGateId: gateId })
          .where(eq(productions.id, productionId));
        return { script: out, gateId };
      });

      // T2/T3: no human gate — the draft is accepted as-is
      if (!drafted.gateId) {
        script = drafted.script;
        approvedVersion = version;
        break;
      }

      // resume comes from the cockpit's decideGate action; match on gateId so
      // revision loops can never consume a stale approval
      const decision = await step.waitForEvent(`await-script-gate-v${version}`, {
        event: "production/gate.decided",
        if: `async.data.gateId == "${drafted.gateId}"`,
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
      script = drafted.script;
      approvedVersion = version;
      break;
    }
    if (!script) {
      await step.run("no-approved-script", () =>
        setStatus(productionId, "on_hold", "no script approved"),
      );
      return { outcome: "on_hold", reason: "no approved script" };
    }

    // 4) voiceover with word-level timestamps
    const voiceover = await step.run("synthesize-voiceover", async () => {
      const { db, providers } = await getContext();
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
          words: ((kept.meta as { words?: WordTimestamp[] } | null)?.words ?? []) as WordTimestamp[],
        };
      }
      const res = await providers.voice.synthesize({
        text: script.fullText,
        voiceId: ctx.dna?.voiceId ?? "default",
        channelId: ctx.idea.channelId,
        productionId,
        // Production Profile "delivery" axis → TTS expression (real provider
        // maps it to voice_settings; the mock ignores it).
        voiceSettings: deliveryVoiceSettings(profile.delivery),
      });
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
          meta: { words: res.words },
        })
        .onConflictDoUpdate({
          target: [assets.productionId, assets.kind, assets.idx],
          set: {
            storageKey: res.storageKey,
            mimeType: res.mimeType,
            durationSec: res.durationSec,
            meta: { words: res.words },
          },
        });
      return res;
    });

    // 5) shots (#4): sub-divide each beat into shots cut on the spoken rhythm
    // (Production Profile "rhythm" axis), so a fresh image lands every few
    // seconds instead of one still per whole beat. One image step per shot.
    const beats = script.beats as ScriptBeat[];
    const shots = planShots(beats, voiceover.words as WordTimestamp[], {
      rhythm: profile.rhythm,
      durationSec: voiceover.durationSec,
    });
    const imageResults = await Promise.all(
      shots.map((shot, i) =>
        step.run(`generate-image-shot-${i}`, async () => {
          const { db, providers } = await getContext();
          // reuse (Land 3): use the copied shot image if present.
          const [kept] = await db
            .select()
            .from(assets)
            .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image"), eq(assets.idx, i)));
          if (kept) return { storageKey: kept.storageKey, mimeType: kept.mimeType };
          // subject-accurate imagery (#7): if the shot names a specific real
          // subject, source a real licensed photo; fall back to generated.
          // Production Profile "visualMode" axis: an AI-image/AI-video channel
          // skips the real-photo lookup and always generates; real_footage /
          // mixed / simple keep the reference-first behaviour.
          let res: { storageKey: string; mimeType: string };
          let meta: Record<string, unknown>;
          let ref =
            shot.referenceEntity && !preferGeneratedImagery(profile.visualMode)
              ? await providers.reference.findEntityImage({
                  entity: shot.referenceEntity,
                  channelId: ctx.idea.channelId,
                  productionId,
                  idx: i,
                })
              : null;
          // Relevance gate (#4 cut 2): a real photo that doesn't actually depict
          // the shot's subject is worse than a generated one. Score the pixels;
          // a poor fit → generate instead. A scoring error (e.g. a non-vision
          // model) fails safe: keep the reference (pre-scoring behaviour).
          let fit: ImageFit | null = null;
          if (ref) {
            try {
              const bytes = await providers.store.getBuffer(ref.storageKey);
              fit = await scoreImageFit(await agentCtx(), {
                image: bytes,
                mimeType: ref.mimeType,
                shotText: shot.text,
                imagePrompt: shot.imagePrompt,
                entity: shot.referenceEntity!,
              });
              if (!fit.fits || fit.score < IMAGE_FIT_MIN) ref = null;
            } catch {
              fit = null;
            }
          }
          if (ref) {
            res = { storageKey: ref.storageKey, mimeType: ref.mimeType };
            meta = {
              entity: shot.referenceEntity,
              source: ref.sourceUrl,
              license: ref.license,
              attribution: ref.attribution,
              ...(fit ? { fitScore: fit.score } : {}),
            };
          } else {
            res = await providers.media.generateImage({
              prompt: shot.imagePrompt,
              aspect: beatAspect,
              channelId: ctx.idea.channelId,
              productionId,
              idx: i,
            });
            meta = {
              prompt: shot.imagePrompt,
              ...(fit ? { rejectedReference: fit.reason, rejectedScore: fit.score } : {}),
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

    // 7) assemble + render
    const render = await step.run("render", async () => {
      const { db, providers, costSink } = await getContext();
      await setStatus(productionId, "assembling");
      // reuse (Land 3): a copied render skips the (expensive) re-render.
      const [keptRender] = await db
        .select()
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "render"), eq(assets.idx, 0)));
      if (keptRender) return { storageKey: keptRender.storageKey, renderSec: 0 };
      const props = buildShortProps({
        shots,
        imageSrcs: imageResults.map((r) => r.storageKey),
        words: voiceover.words as WordTimestamp[],
        audioSrc: voiceover.storageKey,
        durationSec: voiceover.durationSec,
        orientation,
        brand: {
          primaryColor: ctx.dna?.visualStyle?.primaryColor ?? "#38bdf8",
          font: ctx.dna?.visualStyle?.font ?? "Inter",
        },
        captions: profile.captions,
      });
      const res = await renderShort(providers.store, {
        productionId,
        props,
        imageKeys: imageResults.map((r) => r.storageKey),
        audioKey: voiceover.storageKey,
      });
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
        })
        .onConflictDoUpdate({
          target: [assets.productionId, assets.kind, assets.idx],
          set: { storageKey: res.storageKey, durationSec: voiceover.durationSec },
        });
      await costSink.record({
        category: "render",
        provider: "remotion",
        units: { renderSec: Math.round(res.renderSec) },
        costUsd: (res.renderSec / 3600) * RENDER_COST_PER_HOUR,
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
      const thumbLabel = isLong ? "YouTube thumbnail (16:9 landscape)" : "YouTube Shorts thumbnail (9:16)";
      const prompts = [
        `${thumbLabel}, ${style}: ${ctx.idea.title}. ${spec ? `Focal object: ${spec.focalObject}. Text style: ${spec.textStyle}, max ${spec.maxWords} words. ${spec.colorContrast}.` : "Single bold focal object, high contrast, max 4 words of text."}`,
        `${thumbLabel}, ${style}, alternative concept: ${ctx.idea.angle}. ${spec ? `${spec.negativeSpace}.` : "Generous negative space, curiosity-driven composition."}`,
      ];
      const out = [];
      for (let i = 0; i < prompts.length; i++) {
        const img = await providers.media.generateImage({
          prompt: prompts[i]!,
          aspect: beatAspect,
          channelId: ctx.idea.channelId,
          productionId,
          idx: 100 + i, // offset: beat images own 0..N
        });
        const score = await scoreThumbnailCandidate(await agentCtx(), prompts[i]!);
        const id = ulid();
        await db.insert(thumbnails).values({
          id,
          productionId,
          storageKey: img.storageKey,
          predictedCtr: score.predictedCtr,
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
      const warmupSlot = await step.run("warmup-schedule", async () => {
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
      });
      scheduledFor = warmupSlot ?? undefined;
    }

    // 8b) scheduled release time (operator's pick, or the warm-up slot above).
    // #8: create the `publications` row NOW with the future scheduledFor (no
    // video yet) so the schedule is queryable + shows on the calendar; the
    // publish step below fills in the video/url and publishedAt when it goes
    // live. Without this the schedule was invisible until the moment of upload.
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
      await step.sleepUntil("wait-for-schedule", new Date(scheduledFor));
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

    // 9) publish as PRIVATE with AI disclosure
    const publication = await step.run("publish", async () => {
      const { db, providers } = await getContext();
      // Image attribution (#7): CC-BY requires crediting the author wherever the
      // image is used, so credit every licensed reference image in the
      // description. Generated images (meta.prompt, no licence) need no credit.
      const imageAssets = await db
        .select({ meta: assets.meta })
        .from(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")));
      const seenCredits = new Set<string>();
      const creditLines: string[] = [];
      for (const a of imageAssets) {
        const m = a.meta as { entity?: string; source?: string; license?: string; attribution?: string } | null;
        if (!m?.license || !m.source || seenCredits.has(m.source)) continue;
        seenCredits.add(m.source);
        const who = m.attribution ? `${m.attribution}, ` : "";
        creditLines.push(`• ${m.entity ? `${m.entity} — ` : ""}${who}${m.license}, via Wikimedia Commons: ${m.source}`);
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
      const description = [
        ctx.idea.angle,
        "",
        ctx.dna?.ctaTemplate ?? "",
        ...funnelLine,
        "",
        "This video contains AI-generated content.",
        ...(creditLines.length ? ["", "Image credits:", ...creditLines] : []),
      ]
        .join("\n")
        .slice(0, 4900); // YouTube description hard limit is 5000 chars
      const res = await providers.publish.upload({
        channelId: ctx.idea.channelId,
        productionId,
        videoStorageKey: render.storageKey,
        title: ctx.idea.title.slice(0, 100),
        description,
        tags: ctx.idea.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 10),
        privacy: "private",
        selfDeclaredAiContent: true,
        madeForKids: false,
      });
      // thumbnail: operator's pick, else the best-scoring candidate (T2/T3)
      const candidates = await db
        .select()
        .from(thumbnails)
        .where(eq(thumbnails.productionId, productionId));
      const chosen =
        candidates.find((t) => t.selected) ??
        [...candidates].sort((a, b) => (b.predictedCtr ?? 0) - (a.predictedCtr ?? 0))[0];
      if (chosen) {
        if (!chosen.selected) {
          await db.update(thumbnails).set({ selected: true }).where(eq(thumbnails.id, chosen.id));
        }
        try {
          await providers.publish.setThumbnail({
            channelId: ctx.idea.channelId,
            productionId,
            providerVideoId: res.providerVideoId,
            imageStorageKey: chosen.storageKey,
          });
        } catch (err) {
          // custom thumbnails need a verified YouTube account — don't fail the publish
          console.error(`[pipeline] setThumbnail failed for ${productionId}:`, err);
        }
      }

      // #8: fill in the row created at schedule time (keeping its scheduledFor);
      // if there was no scheduled row (immediate publish), insert one now.
      const [scheduledRow] = await db
        .select({ id: publications.id })
        .from(publications)
        .where(eq(publications.productionId, productionId))
        .limit(1);
      let publicationId: string;
      if (scheduledRow) {
        publicationId = scheduledRow.id;
        await db
          .update(publications)
          .set({
            provider: providers.publish.name,
            providerVideoId: res.providerVideoId,
            url: res.url,
            privacyStatus: "private",
            publishedAt: new Date(),
          })
          .where(eq(publications.id, publicationId));
      } else {
        publicationId = ulid();
        await db.insert(publications).values({
          id: publicationId,
          productionId,
          provider: providers.publish.name,
          providerVideoId: res.providerVideoId,
          url: res.url,
          privacyStatus: "private",
          aiDisclosure: true,
          publishedAt: new Date(),
          scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
        });
      }
      await db
        .update(productions)
        .set({ status: "published", currentGateId: null })
        .where(eq(productions.id, productionId));
      return { publicationId, url: res.url };
    });

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
