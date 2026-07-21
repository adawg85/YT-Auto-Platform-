/**
 * BACKLOG #36 — MCP direct-authoring server functions.
 *
 * These let an external LLM (Claude via the MCP connector) author content
 * DIRECTLY — scripts, story arcs, ideas, and channel options — so the platform
 * executes it WITHOUT re-running its own ideation/planning/scripting LLMs.
 *
 * They are plain server-side functions (not "use server" form actions) — the
 * MCP route calls them directly. Every mutation logs a `channel_decisions` row
 * (actor operator, detail.via = mcp), matching the cockpit's audit trail.
 *
 * The authoring path reuses the pipeline's existing seeded-draft rails: a
 * production created with a pre-seeded `scriptDrafts` row skips the drafting
 * LLM; a pre-set `productionProfile` skips the profile-proposal LLM; and the new
 * `externalScript` flag skips the human script gate (Claude wrote it) while the
 * variation/anti-clone check and review board STILL run.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  channelCharters,
  channelDecisions,
  channelDna,
  channels,
  episodes,
  ideas,
  productions,
  scriptDrafts,
  series,
  ulid,
  type ProductionProfile,
  type ScriptBeat,
} from "@ytauto/db";
import {
  beatType,
  inngest,
  productionProfileSchema,
  resolveProductionProfile,
} from "@ytauto/core";
import { getAppContext } from "@/lib/context";

const SPEAKING_WPS = 2.5; // matches the scriptwriter's pace estimate

function wordCountOf(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

async function logDecision(
  db: Awaited<ReturnType<typeof getAppContext>>["db"],
  channelId: string,
  summary: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(channelDecisions).values({
    id: ulid(),
    channelId,
    kind: "operator_steer",
    actor: "operator",
    summary,
    detail: { ...detail, via: "mcp" },
  });
}

/** Validate + normalise a partial ProductionProfile from an external caller. */
function normaliseProfile(input: unknown): Partial<ProductionProfile> | null {
  if (input == null) return null;
  const parsed = productionProfileSchema.partial().safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid productionProfile: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data as Partial<ProductionProfile>;
}

export type AuthoredBeat = {
  type: "hook" | "stat" | "insight" | "cta";
  text: string;
  imagePrompt?: string;
  referenceEntity?: string | null;
  visualBrief?: string | null;
  heroShot?: boolean;
};

export type AuthorProductionInput = {
  channelId: string;
  /** author against an existing idea, OR provide ideaTitle+ideaAngle to mint one */
  ideaId?: string;
  ideaTitle?: string;
  ideaAngle?: string;
  hookText: string;
  beats: AuthoredBeat[];
  /** normalised "topic | hook | fact…" string; auto-derived when omitted */
  substanceFingerprint?: string;
  /** per-video Production Profile (skips the profile-proposal LLM + its gate) */
  productionProfile?: Partial<ProductionProfile>;
};

/**
 * Author a full video script directly and run it through the pipeline. The
 * drafting LLM, factuality proof, grounding, profile-proposal LLM, and the human
 * script gate are all skipped; voiceover → images → render → publish proceed as
 * normal, and the variation check + review board still run.
 */
export async function authorProduction(input: AuthorProductionInput): Promise<{
  productionId: string;
  ideaId: string;
  wordCount: number;
  beatCount: number;
}> {
  const { db } = await getAppContext();
  const [channel] = await db.select().from(channels).where(eq(channels.id, input.channelId));
  if (!channel) throw new Error("Channel not found");
  if (!input.hookText?.trim()) throw new Error("hookText is required");
  if (!Array.isArray(input.beats) || input.beats.length === 0) {
    throw new Error("At least one beat is required");
  }

  // resolve or mint the idea this production is for
  let ideaId = input.ideaId?.trim() || "";
  let ideaTitle = input.ideaTitle?.trim() || "";
  if (ideaId) {
    const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId));
    if (!idea) throw new Error("ideaId not found");
    if (idea.channelId !== input.channelId) throw new Error("idea belongs to another channel");
    ideaTitle = idea.title;
  } else {
    if (!ideaTitle) throw new Error("Provide ideaId, or ideaTitle + ideaAngle to create one");
    ideaId = ulid();
    await db.insert(ideas).values({
      id: ideaId,
      channelId: input.channelId,
      title: ideaTitle.slice(0, 120),
      angle: (input.ideaAngle ?? "").trim() || ideaTitle.slice(0, 120),
      sourceType: "manual",
      researchRefs: [{ via: "mcp", authored: true }],
      status: "greenlit",
    });
  }

  // build the ScriptBeat[] the pipeline consumes. imagePrompt may be thin — the
  // image-prompt builder elaborates it (image generation is expected to run).
  const beats: ScriptBeat[] = input.beats.map((b) => {
    const parsedType = beatType.safeParse(b.type);
    if (!parsedType.success) throw new Error(`Invalid beat type: ${String(b.type)}`);
    if (!b.text?.trim()) throw new Error("Every beat needs text");
    return {
      type: parsedType.data,
      text: b.text.trim(),
      imagePrompt: (b.imagePrompt ?? b.visualBrief ?? b.referenceEntity ?? "").trim(),
      referenceEntity: b.referenceEntity?.trim() || null,
      visualBrief: b.visualBrief?.trim() || null,
      heroShot: b.heroShot ?? false,
      estSec: Math.max(1, Math.round(wordCountOf(b.text) / SPEAKING_WPS)),
    };
  });

  const fullText = beats.map((b) => b.text).join(" ");
  const wordCount = wordCountOf(fullText);
  const fingerprint =
    input.substanceFingerprint?.trim() ||
    [ideaTitle, input.hookText, ...beats.slice(0, 5).map((b) => b.text)]
      .join(" | ")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 500);
  // Always set the production profile — either the caller's per-video override or
  // the channel's resolved profile. A set profile makes the pipeline SKIP the
  // profile-proposal LLM and its review gate (no redundant LLM on an authored run).
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, input.channelId));
  const profile: Partial<ProductionProfile> =
    normaliseProfile(input.productionProfile) ??
    resolveProductionProfile(dna?.productionProfile ?? null, { contentFormat: channel.contentFormat });

  const productionId = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(productions).values({
      id: productionId,
      ideaId,
      channelId: input.channelId,
      status: "greenlit",
      substanceFingerprint: fingerprint,
      externalScript: true, // skip the human script gate; checks still run
      productionProfile: profile,
    });
    await tx.insert(scriptDrafts).values({
      id: ulid(),
      productionId,
      version: 1,
      hookText: input.hookText.trim(),
      beats,
      fullText,
      wordCount,
    });
    await tx.update(ideas).set({ status: "greenlit" }).where(eq(ideas.id, ideaId));
  });

  // verify the seed persisted before firing — a missing draft would make the
  // pipeline re-draft with an LLM (exactly what direct authoring avoids)
  const [seed] = await db
    .select({ id: scriptDrafts.id })
    .from(scriptDrafts)
    .where(eq(scriptDrafts.productionId, productionId));
  if (!seed) throw new Error("Failed to persist the authored script — aborted before running the pipeline");

  await logDecision(db, input.channelId, `Script authored via Claude (MCP): "${ideaTitle.slice(0, 80)}"`, {
    productionId,
    ideaId,
    wordCount,
    beatCount: beats.length,
  });
  await inngest.send({ name: "production/greenlit", data: { productionId, attempt: "0" } });
  return { productionId, ideaId, wordCount, beatCount: beats.length };
}

export type SetChannelConfigInput = {
  channelId: string;
  autonomyTier?: number;
  dna?: {
    tone?: string;
    audiencePersona?: string;
    hookStyles?: string[];
    forbiddenTopics?: string[];
    ctaTemplate?: string;
    voiceId?: string;
    targetLengthSec?: number;
    cadencePerWeek?: number;
  };
  productionProfile?: Partial<ProductionProfile>;
  charter?: { mission?: string; objectives?: string[] };
};

/** Set channel options directly (no wizard/planner LLM). Only provided fields change. */
export async function setChannelConfig(input: SetChannelConfigInput): Promise<{ ok: true; changed: string[] }> {
  const { db } = await getAppContext();
  const [channel] = await db.select().from(channels).where(eq(channels.id, input.channelId));
  if (!channel) throw new Error("Channel not found");
  const changed: string[] = [];

  if (typeof input.autonomyTier === "number") {
    const tier = Math.min(Math.max(Math.round(input.autonomyTier), 0), 3);
    await db.update(channels).set({ autonomyTier: tier }).where(eq(channels.id, input.channelId));
    changed.push(`autonomyTier=${tier}`);
  }

  if (input.dna || input.productionProfile) {
    const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, input.channelId));
    if (!dna) throw new Error("Channel has no DNA row");
    const patch: Record<string, unknown> = {};
    const d = input.dna ?? {};
    if (d.tone !== undefined) { patch.tone = d.tone; changed.push("tone"); }
    if (d.audiencePersona !== undefined) { patch.audiencePersona = d.audiencePersona; changed.push("audiencePersona"); }
    if (d.hookStyles !== undefined) { patch.hookStyles = d.hookStyles; changed.push("hookStyles"); }
    if (d.forbiddenTopics !== undefined) { patch.forbiddenTopics = d.forbiddenTopics; changed.push("forbiddenTopics"); }
    if (d.ctaTemplate !== undefined) { patch.ctaTemplate = d.ctaTemplate; changed.push("ctaTemplate"); }
    if (d.voiceId !== undefined) { patch.voiceId = d.voiceId; changed.push("voiceId"); }
    if (typeof d.targetLengthSec === "number") { patch.targetLengthSec = Math.max(10, Math.round(d.targetLengthSec)); changed.push("targetLengthSec"); }
    if (typeof d.cadencePerWeek === "number") { patch.cadencePerWeek = Math.max(1, Math.round(d.cadencePerWeek)); changed.push("cadencePerWeek"); }
    if (input.productionProfile) {
      // merge over the stored profile so a partial patch doesn't wipe axes
      const merged = { ...(dna.productionProfile ?? {}), ...normaliseProfile(input.productionProfile) };
      patch.productionProfile = merged;
      changed.push("productionProfile");
    }
    if (Object.keys(patch).length) {
      await db.update(channelDna).set(patch).where(eq(channelDna.channelId, input.channelId));
    }
  }

  if (input.charter) {
    const [charter] = await db.select().from(channelCharters).where(eq(channelCharters.channelId, input.channelId));
    if (charter) {
      const patch: Record<string, unknown> = {};
      if (input.charter.mission !== undefined) { patch.mission = input.charter.mission; changed.push("mission"); }
      if (input.charter.objectives !== undefined) { patch.objectives = input.charter.objectives.slice(0, 12); changed.push("objectives"); }
      if (Object.keys(patch).length) {
        await db.update(channelCharters).set(patch).where(eq(channelCharters.channelId, input.channelId));
      }
    }
  }

  if (changed.length) {
    await logDecision(db, input.channelId, `Channel options set via Claude (MCP): ${changed.join(", ")}`, { changed });
  }
  return { ok: true, changed };
}

export type CreateSeriesInput = {
  channelId: string;
  title: string;
  description: string;
  episodes: { title: string; angle: string }[];
  /** default "active" so the arc is live immediately (skip the proposed→approve step) */
  status?: "active" | "proposed";
};

/** Author a story arc + its episodes directly (no editorial-planner LLM). */
export async function createSeriesDirect(input: CreateSeriesInput): Promise<{ seriesId: string; episodeCount: number }> {
  const { db } = await getAppContext();
  const [channel] = await db.select().from(channels).where(eq(channels.id, input.channelId));
  if (!channel) throw new Error("Channel not found");
  if (!input.title?.trim()) throw new Error("Series title is required");
  const eps = (input.episodes ?? []).filter((e) => e.title?.trim());
  if (eps.length === 0) throw new Error("At least one episode is required");

  const seriesId = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(series).values({
      id: seriesId,
      channelId: input.channelId,
      title: input.title.trim(),
      description: (input.description ?? "").trim(),
      status: input.status === "proposed" ? "proposed" : "active",
      plannedEpisodeCount: eps.length,
    });
    await tx.insert(episodes).values(
      eps.map((e, i) => ({
        id: ulid(),
        seriesId,
        channelId: input.channelId,
        position: i,
        title: e.title.trim(),
        angle: (e.angle ?? "").trim() || e.title.trim(),
        status: "planned" as const,
      })),
    );
  });
  await logDecision(db, input.channelId, `Story arc authored via Claude (MCP): "${input.title.slice(0, 80)}" (${eps.length} eps)`, {
    seriesId,
    episodeCount: eps.length,
  });
  return { seriesId, episodeCount: eps.length };
}

export type WriteIdeaInput = { channelId: string; title: string; angle: string; greenlight?: boolean };

/** Write an idea directly (optionally greenlight it into production immediately). */
export async function writeIdea(input: WriteIdeaInput): Promise<{ ideaId: string; greenlit: boolean; productionId?: string }> {
  const { db } = await getAppContext();
  const [channel] = await db.select().from(channels).where(eq(channels.id, input.channelId));
  if (!channel) throw new Error("Channel not found");
  if (!input.title?.trim()) throw new Error("Idea title is required");

  const ideaId = ulid();
  await db.insert(ideas).values({
    id: ideaId,
    channelId: input.channelId,
    title: input.title.trim().slice(0, 120),
    angle: (input.angle ?? "").trim() || input.title.trim().slice(0, 120),
    sourceType: "manual",
    researchRefs: [{ via: "mcp" }],
    status: input.greenlight ? "greenlit" : "inbox",
  });

  let productionId: string | undefined;
  if (input.greenlight) {
    productionId = ulid();
    await db.insert(productions).values({
      id: productionId,
      ideaId,
      channelId: input.channelId,
      status: "greenlit",
    });
    await inngest.send({ name: "production/greenlit", data: { productionId, attempt: "0" } });
  } else {
    await inngest.send({ name: "ideas/autoscore.requested", data: { channelId: input.channelId } });
  }
  await logDecision(db, input.channelId, `Idea authored via Claude (MCP): "${input.title.slice(0, 80)}"${input.greenlight ? " (greenlit)" : ""}`, {
    ideaId,
    greenlit: !!input.greenlight,
  });
  return { ideaId, greenlit: !!input.greenlight, ...(productionId ? { productionId } : {}) };
}
