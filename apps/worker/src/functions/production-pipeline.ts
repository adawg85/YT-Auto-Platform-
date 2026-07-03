import { eq, and, ne, desc, isNotNull } from "drizzle-orm";
import { ulid } from "ulid";
import {
  assets,
  channelDna,
  channels,
  ideas,
  productions,
  publications,
  reviewGates,
  scriptDrafts,
  agentActions,
  type ScriptBeat,
  type WordTimestamp,
} from "@ytauto/db";
import {
  checkVariation,
  inngest,
  SIMILARITY_BORDERLINE,
  type ScriptOutput,
} from "@ytauto/core";
import { RENDER_COST_PER_HOUR } from "@ytauto/providers";
import { draftScript, judgeSimilarity, type AgentCtx } from "@ytauto/agents";
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
      return { idea, dna, channelName: channel?.name ?? "unknown" };
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

    // 2-3) script draft → human review gate, with a bounded revision loop
    let script: ScriptOutput | undefined;
    let approvedVersion = 0;
    let revisionNotes = "";
    for (let version = 1; version <= MAX_REVISIONS + 1; version++) {
      const drafted = await step.run(`draft-script-v${version}`, async () => {
        const { db } = await getContext();
        await setStatus(productionId, "scripting");
        const out = await draftScript(await agentCtx(), ctx.idea, ctx.dna ?? undefined, {
          revisionNotes: revisionNotes || undefined,
        });
        const draftId = ulid();
        await db
          .insert(scriptDrafts)
          .values({
            id: draftId,
            productionId,
            version,
            hookText: out.hookText,
            beats: out.beats,
            fullText: out.fullText,
            wordCount: out.fullText.split(/\s+/).filter(Boolean).length,
          })
          .onConflictDoNothing();
        await db
          .update(productions)
          .set({ substanceFingerprint: out.substanceFingerprint, revisionCount: version - 1 })
          .where(eq(productions.id, productionId));

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
          },
        });
        await db
          .update(productions)
          .set({ status: "script_review", currentGateId: gateId })
          .where(eq(productions.id, productionId));
        return { script: out, gateId };
      });

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

      // evidence row for the compliance log
      await db.insert(agentActions).values({
        id: ulid(),
        agentName: "variation_check",
        channelId: ctx.idea.channelId,
        productionId,
        inputSummary: `variation check vs ${priors.length} recent productions`,
        output: { ...result, blocked, reason },
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

    // 8) final review gate — operator watches the rendered short
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

    await step.run("mark-ready", () => setStatus(productionId, "ready"));

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
