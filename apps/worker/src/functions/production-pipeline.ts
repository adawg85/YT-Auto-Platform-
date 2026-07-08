import { eq, and, ne, desc, isNotNull, inArray } from "drizzle-orm";
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
  inngest,
  nextQuotaReset,
  patternsToPromptLines,
  planWarmupRelease,
  quotaWindowStart,
  retrieveMemory,
  topPatternsForNiche,
  youtubeDailyQuota,
  YOUTUBE_UPLOAD_QUOTA_UNITS,
  type ScriptOutput,
} from "@ytauto/core";
import { costRecords } from "@ytauto/db";
import { RENDER_COST_PER_HOUR } from "@ytauto/providers";
import {
  draftScript,
  judgeSimilarity,
  pickHookTemplate,
  runReviewBoard,
  scoreThumbnailCandidate,
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
      return {
        idea,
        dna,
        channelName: channel?.name ?? "unknown",
        autonomyTier: channel?.autonomyTier ?? 0,
        experiment: experiment ?? null,
      };
    });

    // Autonomy tiers (spec §10): T0 manual / T1 assisted gate script + final;
    // T2 supervised / T3 exception-only skip gates and auto-publish (private).
    // The variation check still holds flagged items regardless of tier.
    const gated = ctx.autonomyTier <= 1;

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
    const factuality = await step.run("factuality-gate", async () => {
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

      const blocked = unfinished.length > 0 || usable.length === 0 || uncited.length > 0;
      const reason = blocked
        ? unfinished.length > 0
          ? `${unfinished.length} claim(s) never finished verification`
          : usable.length === 0
            ? "no claim survived verification — will not script ungrounded"
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
    const grounding = await step.run("memory-grounding", async () => {
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

    // 2-3) script draft → human review gate, with a bounded revision loop
    let script: ScriptOutput | undefined;
    let approvedVersion = 0;
    let revisionNotes = "";
    for (let version = 1; version <= MAX_REVISIONS + 1; version++) {
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
      const res = await providers.voice.synthesize({
        text: script.fullText,
        voiceId: ctx.dna?.voiceId ?? "default",
        channelId: ctx.idea.channelId,
        productionId,
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

    // 5) one step per beat image — parallel, per-beat memoization on retry
    const beats = script.beats as ScriptBeat[];
    const imageResults = await Promise.all(
      beats.map((beat, i) =>
        step.run(`generate-image-beat-${i}`, async () => {
          const { db, providers } = await getContext();
          const res = await providers.media.generateImage({
            prompt: beat.imagePrompt,
            aspect: "9:16",
            channelId: ctx.idea.channelId,
            productionId,
            idx: i,
          });
          await db
            .insert(assets)
            .values({
              id: ulid(),
              productionId,
              kind: "image",
              idx: i,
              storageKey: res.storageKey,
              mimeType: res.mimeType,
              meta: { prompt: beat.imagePrompt },
            })
            .onConflictDoUpdate({
              target: [assets.productionId, assets.kind, assets.idx],
              set: { storageKey: res.storageKey, mimeType: res.mimeType },
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
            ne(productions.status, "rejected"),
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

    if (variation.blocked) {
      await step.run("variation-blocked", () =>
        setStatus(
          productionId,
          "on_hold",
          `variation check failed: substance too similar (${variation.reason})`,
        ),
      );
      return { outcome: "on_hold", reason: "variation check failed" };
    }

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
      if (res.blocked) {
        await setStatus(productionId, "on_hold", `review board: ${res.reason}`);
      }
      return { skipped: false as const, blocked: res.blocked, reason: res.reason };
    });
    if (board.blocked) {
      return { outcome: "on_hold", reason: "review board failed" };
    }

    // 7) assemble + render
    const render = await step.run("render", async () => {
      const { db, providers, costSink } = await getContext();
      await setStatus(productionId, "assembling");
      const props = buildShortProps({
        beats,
        words: voiceover.words as WordTimestamp[],
        imageSrcs: imageResults.map((r) => r.storageKey),
        audioSrc: voiceover.storageKey,
        durationSec: voiceover.durationSec,
        brand: {
          primaryColor: ctx.dna?.visualStyle?.primaryColor ?? "#38bdf8",
          font: ctx.dna?.visualStyle?.font ?? "Inter",
        },
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
      const spec = ctx.dna?.thumbnailSpec;
      const style = ctx.dna?.visualStyle?.imageStyle ?? "clean flat illustration, high contrast";
      const prompts = [
        `YouTube Shorts thumbnail, ${style}: ${ctx.idea.title}. ${spec ? `Focal object: ${spec.focalObject}. Text style: ${spec.textStyle}, max ${spec.maxWords} words. ${spec.colorContrast}.` : "Single bold focal object, high contrast, max 4 words of text."}`,
        `YouTube Shorts thumbnail, ${style}, alternative concept: ${ctx.idea.angle}. ${spec ? `${spec.negativeSpace}.` : "Generous negative space, curiosity-driven composition."}`,
      ];
      const out = [];
      for (let i = 0; i < prompts.length; i++) {
        const img = await providers.media.generateImage({
          prompt: prompts[i]!,
          aspect: "9:16",
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

    // 8a) warm-up throttle (backlog build #3): on auto tiers (T2/T3) that would
    // otherwise publish immediately, a still-ramping channel releases on the
    // format's warm-up cadence + daypart instead of posting like an established
    // one (a spam signal). Gated channels rely on the operator's explicit
    // scheduling; graduated channels publish at full cadence (no delay).
    if (!gated && !scheduledFor) {
      const warmupSlot = await step.run("warmup-schedule", async () => {
        const { db } = await getContext();
        const state = await channelWarmupState(db, ctx.idea.channelId, new Date(), "shorts");
        if (!state || state.graduated) return null;
        const plan = planWarmupRelease({
          format: "shorts",
          launchedAt: state.launchedAt,
          now: new Date(),
          releasedThisWeek: state.releasedThisWeek,
        });
        return plan.scheduledFor.toISOString();
      });
      scheduledFor = warmupSlot ?? undefined;
    }

    // 8b) scheduled release time (operator's pick, or the warm-up slot above)
    if (scheduledFor && new Date(scheduledFor).getTime() > Date.now()) {
      await step.run("mark-scheduled", () => setStatus(productionId, "scheduled"));
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
      const description = [
        ctx.idea.angle,
        "",
        ctx.dna?.ctaTemplate ?? "",
        "",
        "This video contains AI-generated content.",
      ].join("\n");
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

      const publicationId = ulid();
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

    return { outcome: "published", url: publication.url };
  },
);
