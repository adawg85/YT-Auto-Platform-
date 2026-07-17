import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
  assets,
  channelDna,
  channels,
  productions,
  scriptDrafts,
  type ScriptBeat,
  type WordTimestamp,
} from "@ytauto/db";
import {
  planShots,
  planShotsFromDirection,
  resolveProductionProfile,
  shotPlanOptions,
  videoEngineFor,
  type Shot,
} from "@ytauto/core";
import { writeMotionPrompt, type AgentCtx } from "@ytauto/agents";
import type { getContext } from "./context";
import { normalizeClipBuffer } from "./footage";

type Ctx = Awaited<ReturnType<typeof getContext>>;

export const MAX_CLIP_SEC = () => Number(process.env.VIDEO_MAX_CLIP_SEC ?? "10");

/** The pipeline's motion-prompt template — the operator's brief (when given)
 * takes the scene slot so both paths speak the same language to the vendor. */
export function motionPromptFor(scene: string): string {
  return (
    `Cinematic live-action motion: ${scene}. ` +
    "Subtle camera movement, natural believable motion, no on-screen text."
  );
}

/**
 * Generate ONE i2v beat clip and upsert it as the production's `video_clip`
 * asset at the shot's idx (extracted 2026-07-14 from the pipeline's
 * generate-ai-clips step so the operator's "Animate this shot" reuses the
 * exact same path). Animates the shot's own image when it has one (style +
 * character consistency; SVG mocks can't seed a real i2v call), normalizes
 * to the beat length, and never overwrites on failure. Returns the stored
 * key, or null when the clip was skipped (no usable output).
 */
export async function generateShotVideoClip(
  deps: Pick<Ctx, "db" | "providers">,
  opts: {
    productionId: string;
    channelId: string;
    idx: number;
    /** what to animate — an agent (when agentCtx given) writes the vendor prompt
     * from the image + this context; else the template runs off `scene` */
    motion: {
      scene: string;
      shotText?: string;
      visualBrief?: string | null;
      character?: string | null;
      operatorNote?: string | null;
    };
    /** vision agent context — omit to fall back to the fixed motion template */
    agentCtx?: AgentCtx;
    aspect: "9:16" | "16:9";
    beatLenSec: number;
    engine: "wan" | "minimax" | "seedance" | "kling";
    /** operator-triggered (Animate button) vs pipeline motion plan */
    operator?: boolean;
  },
): Promise<{ storageKey: string } | null> {
  const { db, providers } = deps;
  const { productionId, idx } = opts;
  const [imgAsset] = await db
    .select({ storageKey: assets.storageKey, mimeType: assets.mimeType })
    .from(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image"), eq(assets.idx, idx)));
  let imageArgs: { imageUrl?: string; imageDataUrl?: string } = {};
  let imageBytes: Buffer | null = null;
  if (imgAsset && !imgAsset.mimeType.includes("svg")) {
    // fetch bytes when the motion agent needs them, or to build the data URL
    const needBytes = !!opts.agentCtx || !providers.store.presignGet;
    const buf = needBytes ? await providers.store.getBuffer(imgAsset.storageKey) : null;
    imageBytes = buf;
    if (providers.store.presignGet) {
      // long TTL — vendor tasks take minutes, not the 900s image refs use
      imageArgs = { imageUrl: await providers.store.presignGet(imgAsset.storageKey, 3600) };
    } else {
      imageArgs = { imageDataUrl: `data:${imgAsset.mimeType};base64,${buf!.toString("base64")}` };
    }
  }
  // an agent tailors the motion to THIS frame when possible; the fixed template
  // is the fail-safe (animation must never fail because the writer had trouble)
  let prompt = motionPromptFor(opts.motion.scene);
  if (opts.agentCtx && imageBytes && imgAsset) {
    try {
      const mp = await writeMotionPrompt(opts.agentCtx, {
        image: imageBytes,
        mimeType: imgAsset.mimeType,
        shotText: opts.motion.shotText ?? opts.motion.scene,
        visualBrief: opts.motion.visualBrief,
        character: opts.motion.character,
        operatorNote: opts.motion.operatorNote,
      });
      if (mp.prompt.trim()) prompt = mp.prompt.trim();
    } catch {
      // keep the template
    }
  }
  const raw = await providers.video.generateClip({
    prompt,
    ...imageArgs,
    durationSec: Math.min(opts.beatLenSec + 0.4, MAX_CLIP_SEC()),
    aspect: opts.aspect,
    engine: opts.engine,
    channelId: opts.channelId,
    productionId,
    idx,
  });
  const rawBuf = await providers.store.getBuffer(raw.storageKey);
  const clip = await normalizeClipBuffer(rawBuf, {
    aspect: opts.aspect,
    clipSec: Math.min(opts.beatLenSec + 0.4, raw.durationSec),
    introSkipSec: 0,
  });
  if (!clip) return null;
  const storageKey = `productions/${productionId}/clip-${idx}.mp4`;
  await providers.store.put(storageKey, clip, "video/mp4");
  const meta = {
    generated: true,
    engine: raw.engine,
    model: raw.model,
    prompt: prompt.slice(0, 200),
    ...(opts.operator ? { operator: true } : {}),
  };
  await db
    .insert(assets)
    .values({ id: ulid(), productionId, kind: "video_clip", idx, storageKey, mimeType: "video/mp4", meta })
    .onConflictDoUpdate({
      target: [assets.productionId, assets.kind, assets.idx],
      // bump updatedAt so a re-animate is detectable (the storageKey is a
      // deterministic clip-<idx>.mp4, so the cockpit's Animate poller keys off
      // this timestamp to know the clip actually (re)landed).
      set: { storageKey, mimeType: "video/mp4", meta, updatedAt: new Date() },
    });
  return { storageKey };
}

/**
 * Re-derive a finished production's shot plan from its stored rows — the same
 * deterministic inputs the pipeline used (latest draft beats + voiceover word
 * timings + the persisted per-video profile), so an after-the-fact clip lands
 * on exactly the beat the render will cut. Null when the production hasn't
 * produced a voiceover yet (no timings → no shot boundaries).
 */
export async function deriveProductionShots(
  db: Ctx["db"],
  productionId: string,
): Promise<{
  shots: Shot[];
  aspect: "9:16" | "16:9";
  channelId: string;
  engine: "wan" | "minimax" | "seedance" | "kling";
} | null> {
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return null;
  const [channel] = await db.select().from(channels).where(eq(channels.id, production.channelId));
  if (!channel) return null;
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  const [draft] = await db
    .select()
    .from(scriptDrafts)
    .where(eq(scriptDrafts.productionId, productionId))
    .orderBy(desc(scriptDrafts.version))
    .limit(1);
  const [voiceover] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "voiceover"), eq(assets.idx, 0)));
  if (!draft || !voiceover || voiceover.durationSec == null) return null;
  const words = ((voiceover.meta as { words?: WordTimestamp[] } | null)?.words ?? []) as WordTimestamp[];
  const profile = resolveProductionProfile(production.productionProfile ?? dna?.productionProfile ?? null, {
    contentFormat: channel.contentFormat,
  });
  const isLong = channel.contentFormat === "long" || (dna?.targetLengthSec ?? 0) > 90;
  const spo = shotPlanOptions(profile, { isLong, durationSec: voiceover.durationSec, maxClipSec: MAX_CLIP_SEC() });
  let shots = planShots(draft.beats as ScriptBeat[], words, spo);
  // Visual Director (#37): if this draft was directed, cut it the SAME way the
  // render did (persisted sequence) so clip-<idx> lands on the right beat.
  const directedSeq = draft.directedSequence;
  if (profile.visualDirector && directedSeq?.length) {
    const directed = planShotsFromDirection(draft.beats as ScriptBeat[], words, directedSeq, {
      durationSec: voiceover.durationSec,
      maxShotSec: spo.maxShotSec,
    });
    if (directed) shots = directed;
  }
  return {
    shots,
    aspect: isLong ? "16:9" : "9:16",
    channelId: production.channelId,
    engine: videoEngineFor(profile),
  };
}
