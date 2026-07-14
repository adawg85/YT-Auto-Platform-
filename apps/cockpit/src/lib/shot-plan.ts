import { and, desc, eq } from "drizzle-orm";
import {
  assets,
  channelDna,
  channels,
  productions,
  scriptDrafts,
  type ScriptBeat,
  type WordTimestamp,
} from "@ytauto/db";
import { planShots, resolveProductionProfile, videoEngineFor, type Shot } from "@ytauto/core";
import type { getAppContext } from "./context";

type Db = Awaited<ReturnType<typeof getAppContext>>["db"];

/** clip cap must agree with the worker (same env, same default) */
export const MAX_CLIP_SEC = () => Number(process.env.VIDEO_MAX_CLIP_SEC ?? "10");
/** $/second for the Animate cost estimate (mirrors providers pricing) */
export const CLIP_PRICE_PER_SEC: Record<"wan" | "minimax", number> = { wan: 0.05, minimax: 0.045 };

/**
 * Re-derive a production's shot plan from its stored rows — the SAME
 * deterministic inputs the pipeline used (latest draft beats + voiceover word
 * timings + persisted per-video profile), so the visuals grid can show each
 * shot's true length and the Animate button gates/estimates correctly. The
 * worker re-derives independently before generating (this side is advisory).
 * Null while the production has no voiceover yet (no timings, no shots).
 */
export async function deriveShotPlan(
  db: Db,
  productionId: string,
): Promise<{ shots: Shot[]; aspect: "9:16" | "16:9"; engine: "wan" | "minimax" } | null> {
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
  const shots = planShots(draft.beats as ScriptBeat[], words, {
    rhythm: profile.rhythm,
    durationSec: voiceover.durationSec,
    ...(isLong ? { minShotSec: 7, maxShotsPerBeat: 3 } : {}),
  });
  return { shots, aspect: isLong ? "16:9" : "9:16", engine: videoEngineFor(profile) };
}
