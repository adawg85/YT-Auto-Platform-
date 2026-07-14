import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { channelDecisions, productions } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getContext } from "../context";
import {
  MAX_CLIP_SEC,
  deriveProductionShots,
  generateShotVideoClip,
  motionPromptFor,
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
  },
  { event: "production/clip.requested" },
  async ({ event, step }) => {
    const { productionId, idx, prompt } = event.data;

    const result = await step.run("generate-clip", async () => {
      const { db, providers } = await getContext();
      const derived = await deriveProductionShots(db, productionId);
      if (!derived) return { error: "production has no voiceover/draft yet — shots can't be timed" };
      const shot = derived.shots[idx];
      if (!shot) return { error: `shot ${idx + 1} not found (production has ${derived.shots.length})` };
      const beatLen = shot.endSec - shot.startSec;
      if (beatLen > MAX_CLIP_SEC() + 0.5) {
        return { error: `shot ${idx + 1} runs ${Math.round(beatLen)}s — over the ${MAX_CLIP_SEC()}s clip cap` };
      }
      const scene = prompt?.trim() || shot.visualBrief || shot.imagePrompt || shot.text;
      const clip = await generateShotVideoClip(
        { db, providers },
        {
          productionId,
          channelId: derived.channelId,
          idx,
          prompt: motionPromptFor(scene),
          aspect: derived.aspect,
          beatLenSec: beatLen,
          engine: derived.engine,
          operator: true,
        },
      );
      if (!clip) return { error: "vendor returned no usable clip" };
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
          detail: { productionId, idx, error: result.error },
          actor: "agent",
        });
      });
      return { outcome: "failed", reason: result.error };
    }
    return { outcome: "generated", storageKey: result.storageKey };
  },
);
