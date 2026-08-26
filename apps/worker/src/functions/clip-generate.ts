import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { channelDecisions, productions, shotJobs } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getContext } from "../context";
import {
  MAX_CLIP_SEC,
  deriveProductionShots,
  generateShotVideoClip,
} from "../clip-generation";

/**
 * Operator "Animate this shot" (2026-07-14): image→video for ONE shot of a
 * production, requested from the swap dialog. Runs here because the vendors
 * poll for minutes — the cockpit action just fires the event and returns.
 * Everything is re-derived from the DB (shot timing, aspect, engine); the
 * event carries only WHICH shot and the optional operator motion brief.
 * Idempotent on the event's dedupe key (double clicks collapse; a new image
 * or a new brief gets a fresh key). Failures land in the channel decision
 * ledger — the operator sees why nothing appeared.
 */
export const clipGenerate = inngest.createFunction(
  {
    id: "production-clip-generate",
    retries: 1,
    idempotency: "event.data.dedupe",
    // one at a time per production: the render reads these rows, and vendor
    // rate limits bite when several shots animate at once
    concurrency: { key: "event.data.productionId", limit: 1 },
    // operator Cancel (2026-07-17): a clip.cancel event for the same shot stops
    // this run — whether it's still queued behind others or already in flight.
    cancelOn: [
      {
        event: "production/clip.cancel",
        if: "event.data.productionId == async.data.productionId && event.data.idx == async.data.idx",
      },
    ],
    // Hard run failure (retries exhausted — a worker redeploy/OOM mid-poll, an
    // Inngest transport error): the in-function catch never ran, so without this
    // the ledger stays empty and the cockpit poller reports "Animating…" forever
    // (2026-08-09 operator: animated many shots, only a couple saved, no errors
    // anywhere). Write the SAME ledger row the soft-failure path writes — the
    // poller matches on the summary prefix + detail.reqToken, so the row flips
    // that animate to "failed" with the reason.
    onFailure: async ({ error, event, step }) => {
      const data = event.data as {
        productionId?: string;
        idx?: number;
        dedupe?: string;
        jobId?: string;
        event?: { data?: { productionId?: string; idx?: number; dedupe?: string; jobId?: string } };
      };
      const productionId = data.productionId ?? data.event?.data?.productionId;
      const idx = data.idx ?? data.event?.data?.idx;
      const reqToken = data.dedupe ?? data.event?.data?.dedupe;
      const jobId = data.jobId ?? data.event?.data?.jobId;
      if (!productionId || typeof idx !== "number") return;
      await step.run("record-run-failure", async () => {
        const { db } = await getContext();
        if (jobId) {
          await db
            .update(shotJobs)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: (error?.message ?? "run died before completing").slice(0, 500),
            })
            .where(eq(shotJobs.id, jobId));
        }
        const [production] = await db
          .select({ channelId: productions.channelId })
          .from(productions)
          .where(eq(productions.id, productionId));
        if (!production) return;
        const reason = `run died before completing (worker restart/redeploy or transport error): ${(error?.message ?? "unknown").slice(0, 200)} — re-run Animate on this shot`;
        await db.insert(channelDecisions).values({
          id: ulid(),
          channelId: production.channelId,
          kind: "retro_observation",
          summary: `Animate shot ${idx + 1} failed: ${reason.slice(0, 160)}`,
          detail: { productionId, idx, error: reason, reqToken },
          actor: "agent",
        });
      });
    },
  },
  { event: "production/clip.requested" },
  async ({ event, step }) => {
    const { productionId, idx, prompt, engine: engineOverride, dedupe: reqToken, jobId } = event.data;
    /** Move the durable queue row along — the cockpit reads it to show a truthful
     * "queued / animating" that survives leaving the page (2026-08-26). Never
     * throws: a bookkeeping miss must not fail a clip that generated fine. */
    const markJob = async (status: string, extra: Record<string, unknown> = {}) => {
      if (!jobId) return;
      try {
        const { db } = await getContext();
        await db.update(shotJobs).set({ status, ...extra }).where(eq(shotJobs.id, jobId));
      } catch {
        /* the clip's own outcome is what matters */
      }
    };
    await step.run("mark-running", async () => {
      await markJob("running", { startedAt: new Date() });
      return null;
    });
    const VIDEO_ENGINES = ["wan", "minimax", "seedance", "seedance-pro", "kling"] as const;
    const pickedEngine = (VIDEO_ENGINES as readonly string[]).includes(engineOverride ?? "")
      ? (engineOverride as (typeof VIDEO_ENGINES)[number])
      : undefined;

    const result = await step.run("generate-clip", async () => {
      // The WHOLE body is guarded: a throw anywhere (context/DB setup, shot
      // derivation, vendor, store, ffmpeg) must become a recorded failure, not
      // an unhandled step error — the old guard started only at the vendor
      // call, so a setup throw burned the retry and left the ledger empty
      // while the operator's poller waited forever (2026-08-09).
      try {
        const { db, providers, costSink } = await getContext();
        const derived = await deriveProductionShots(db, productionId);
        if (!derived) return { error: "production has no voiceover/draft yet — shots can't be timed" };
        const shot = derived.shots[idx];
        if (!shot) return { error: `shot ${idx + 1} not found (production has ${derived.shots.length})` };
        const beatLen = shot.endSec - shot.startSec;
        if (beatLen > MAX_CLIP_SEC() + 0.5) {
          return { error: `shot ${idx + 1} runs ${Math.round(beatLen)}s — over the ${MAX_CLIP_SEC()}s clip cap` };
        }
        const clip = await generateShotVideoClip(
          { db, providers },
          {
            productionId,
            channelId: derived.channelId,
            idx,
            // an agent writes the i2v prompt from the frame; the operator's typed
            // note (if any) is honoured as a directive on top of it
            motion: {
              scene: shot.visualBrief || shot.imagePrompt || shot.text,
              shotText: shot.text,
              visualBrief: shot.visualBrief,
              operatorNote: prompt?.trim() || null,
            },
            agentCtx: { db, llm: providers.llm, costSink, channelId: derived.channelId, productionId },
            aspect: derived.aspect,
            beatLenSec: beatLen,
            // operator's Animate-dropdown pick wins over the channel profile engine
            engine: pickedEngine ?? derived.engine,
            operator: true,
            reqToken,
          },
        );
        if (!clip) return { error: "vendor returned no usable clip (check a video-engine key is set — see /api/diag/clips)" };
        return { storageKey: clip.storageKey, channelId: derived.channelId };
      } catch (err) {
        return { error: `clip generation errored: ${err instanceof Error ? err.message : String(err)}` };
      }
    });

    if ("error" in result) {
      await step.run("record-failure", async () => {
        const { db } = await getContext();
        await markJob("failed", { finishedAt: new Date(), error: result.error.slice(0, 500) });
        const [production] = await db
          .select({ channelId: productions.channelId })
          .from(productions)
          .where(eq(productions.id, productionId));
        if (!production) return;
        await db.insert(channelDecisions).values({
          id: ulid(),
          channelId: production.channelId,
          kind: "retro_observation",
          summary: `Animate shot ${idx + 1} failed: ${result.error.slice(0, 160)}`,
          detail: { productionId, idx, error: result.error, reqToken },
          actor: "agent",
        });
      });
      return { outcome: "failed", reason: result.error };
    }
    await step.run("mark-done", async () => {
      await markJob("done", { finishedAt: new Date() });
      return null;
    });
    return { outcome: "generated", storageKey: result.storageKey };
  },
);
