import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { assets, channelDecisions, productions } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getContext } from "../context";
import { deriveProductionShots } from "../clip-generation";
import { normalizeClipBuffer } from "../footage";

/**
 * #112: ingest OPERATOR-RECORDED footage as one shot's clip — the real-person
 * counterpart to "Animate this shot". The cockpit/MCP stores the raw upload and
 * fires this; the trim/scale runs here because ffmpeg lives on the worker. The
 * file is normalized to the shot's own window (aspect + length; NO i2v clip cap
 * — real footage has no vendor generation limit, so it can cover a long static
 * hold), then upserted as the shot's `video_clip` with `operatorFootage: true` —
 * NEVER `generated` and NEVER `source`/`license`, so it classifies as
 * operator_clip on the disclosure surface rather than inflating the synthetic
 * count or masquerading as licensed archival. The render prefers a clip at a
 * shot's idx automatically, and the kept-render guard sees the new idx and
 * invalidates a stale render. Failures land in the channel decision ledger, same
 * as Animate.
 */
export const operatorClipIngest = inngest.createFunction(
  {
    id: "production-operator-clip",
    retries: 1,
    idempotency: "event.data.dedupe",
    concurrency: { key: "event.data.productionId", limit: 1 },
  },
  { event: "production/operator-clip.requested" },
  async ({ event, step }) => {
    const { productionId, idx, rawKey, dedupe: reqToken } = event.data;

    const result = await step.run("normalize-and-attach", async () => {
      const { db, providers } = await getContext();
      const derived = await deriveProductionShots(db, productionId);
      if (!derived) return { error: "production has no voiceover/draft yet — shots can't be timed" };
      const shot = derived.shots[idx];
      if (!shot) return { error: `shot ${idx + 1} not found (production has ${derived.shots.length})` };
      const beatLen = shot.endSec - shot.startSec;
      let raw: Buffer;
      try {
        raw = await providers.store.getBuffer(rawKey);
      } catch (err) {
        return { error: `couldn't read the uploaded file (${rawKey}): ${err instanceof Error ? err.message : String(err)}` };
      }
      let clip: Buffer | null;
      try {
        clip = await normalizeClipBuffer(raw, {
          aspect: derived.aspect,
          clipSec: beatLen + 0.4,
          introSkipSec: 0,
        });
      } catch (err) {
        return { error: `footage normalize errored: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!clip) {
        return { error: "the file couldn't be read as video (ffmpeg produced no usable output) — send mp4/mov/webm" };
      }
      const storageKey = `productions/${productionId}/clip-${idx}.mp4`;
      await providers.store.put(storageKey, clip, "video/mp4");
      const meta = {
        // #112: the discriminator — real footage of a real person. No
        // `generated`, no `source`/`license`: those keys mean i2v and licensed
        // archival respectively, and both classifications would be false here.
        operatorFootage: true,
        rawKey,
        reqToken,
      };
      await db
        .insert(assets)
        .values({ id: ulid(), productionId, kind: "video_clip", idx, storageKey, mimeType: "video/mp4", meta })
        .onConflictDoUpdate({
          target: [assets.productionId, assets.kind, assets.idx],
          set: { storageKey, mimeType: "video/mp4", meta, updatedAt: new Date() },
        });
      return { storageKey, channelId: derived.channelId };
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
          summary: `Operator footage for shot ${idx + 1} failed: ${result.error.slice(0, 160)}`,
          detail: { productionId, idx, error: result.error, reqToken, rawKey },
          actor: "agent",
        });
      });
      return { outcome: "failed", reason: result.error };
    }
    return { outcome: "attached", storageKey: result.storageKey };
  },
);
