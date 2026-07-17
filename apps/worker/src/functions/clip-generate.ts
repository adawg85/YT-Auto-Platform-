import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { channelDecisions, productions } from "@ytauto/db";
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
  },
  { event: "production/clip.requested" },
  async ({ event, step }) => {
    const { productionId, idx, prompt, engine: engineOverride, dedupe: reqToken } = event.data;
    const VIDEO_ENGINES = ["wan", "minimax", "seedance", "seedance-pro", "kling"] as const;
    const pickedEngine = (VIDEO_ENGINES as readonly string[]).includes(engineOverride ?? "")
      ? (engineOverride as (typeof VIDEO_ENGINES)[number])
      : undefined;

    const result = await step.run("generate-clip", async () => {
      const { db, providers, costSink } = await getContext();
      const derived = await deriveProductionShots(db, productionId);
      if (!derived) return { error: "production has no voiceover/draft yet — shots can't be timed" };
      const shot = derived.shots[idx];
      if (!shot) return { error: `shot ${idx + 1} not found (production has ${derived.shots.length})` };
      const beatLen = shot.endSec - shot.startSec;
      if (beatLen > MAX_CLIP_SEC() + 0.5) {
        return { error: `shot ${idx + 1} runs ${Math.round(beatLen)}s — over the ${MAX_CLIP_SEC()}s clip cap` };
      }
      // A THROW here (vendor error, store fetch, ffmpeg normalize) must become a
      // recorded failure, not an unhandled step error that leaves the operator's
      // Animate poller waiting forever with nothing in the ledger (2026-07-17).
      let clip: { storageKey: string } | null;
      try {
        clip = await generateShotVideoClip(
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
      } catch (err) {
        return { error: `clip generation errored: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!clip) return { error: "vendor returned no usable clip (check a video-engine key is set — see /api/diag/clips)" };
      return { storageKey: clip.storageKey, channelId: derived.channelId };
    });

    if ("error" in result) {
      await step.run("record-failure", async () => {
        const { db } = await getContext();
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
    return { outcome: "generated", storageKey: result.storageKey };
  },
);
