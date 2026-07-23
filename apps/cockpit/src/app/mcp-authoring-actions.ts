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
  type LengthPolicy,
  type ProductionProfile,
  type ScriptBeat,
  type VerificationBar,
} from "@ytauto/db";
import {
  beatType,
  inngest,
  productionProfileSchema,
  projectShotPlan,
  publishedVideoForIdea,
  resolveLengthPolicy,
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

/** Read the value at a zod issue path from the original input (for error detail). */
function valueAtPath(input: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>(
    (acc, k) => (acc && typeof acc === "object" ? (acc as Record<string | number, unknown>)[k] : undefined),
    input,
  );
}

/** Validate + normalise a partial ProductionProfile from an external caller. */
function normaliseProfile(input: unknown): Partial<ProductionProfile> | null {
  if (input == null) return null;
  const parsed = productionProfileSchema.partial().safeParse(input);
  if (!parsed.success) {
    // Name the offending field and, for a length cap, both numbers (actual vs
    // limit) — productionProfile is a free-form object with per-field caps, so a
    // bare "String must contain at most 800" forced the caller to bisect
    // (ticket 01KY6F1X…).
    const details = parsed.error.issues.map((i) => {
      const field = i.path.length ? `productionProfile.${i.path.join(".")}` : "productionProfile";
      if (i.code === "too_big" && i.type === "string" && typeof i.maximum === "number") {
        const val = valueAtPath(input, i.path);
        const len = typeof val === "string" ? val.length : undefined;
        return `${field}: ${len != null ? `${len.toLocaleString()} characters exceeds the ` : "exceeds the "}${i.maximum.toLocaleString()}-character limit`;
      }
      return `${field}: ${i.message}`;
    });
    throw new Error(`Invalid productionProfile — ${details.join("; ")}`);
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
  /** i2v motion prompt used verbatim if this beat animates (skips the vision LLM) */
  motionPrompt?: string | null;
  /** mark this beat to MOVE under ai_video (prioritised for a clip), even without a motionPrompt */
  animates?: boolean;
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
  /** §3.4/§3.5 authored packaging (override the auto title/description/tags;
   * thumbnailPrompt is used verbatim). Credits are still appended to a description. */
  title?: string;
  description?: string;
  tags?: string[];
  thumbnailPrompt?: string;
};

/** Build the authoredMetadata jsonb from loose fields, or null if all empty. */
function buildAuthoredMetadata(input: {
  title?: string;
  description?: string;
  tags?: string[];
  thumbnailPrompt?: string;
}): { title?: string; description?: string; tags?: string[]; thumbnailPrompt?: string } | null {
  const m: { title?: string; description?: string; tags?: string[]; thumbnailPrompt?: string } = {};
  if (input.title?.trim()) m.title = input.title.trim().slice(0, 100);
  if (input.description?.trim()) m.description = input.description.trim().slice(0, 4900);
  if (Array.isArray(input.tags) && input.tags.length) m.tags = input.tags.filter((t) => typeof t === "string" && t.trim()).slice(0, 30);
  if (input.thumbnailPrompt?.trim()) m.thumbnailPrompt = input.thumbnailPrompt.trim();
  return Object.keys(m).length ? m : null;
}

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
  shotPlan: ReturnType<typeof projectShotPlan>;
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
    // Remediation §2.1: don't author a second video for an already-published idea.
    const dupe = await publishedVideoForIdea(db, ideaId);
    if (dupe) {
      throw new Error(
        `This idea already has a published video (${dupe.providerVideoId}). Make a corrected copy to re-cut it instead of authoring a duplicate.`,
      );
    }
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
      motionPrompt: b.motionPrompt?.trim() || null,
      ...(b.animates ? { animates: true } : {}),
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
      ...(buildAuthoredMetadata(input) ? { authoredMetadata: buildAuthoredMetadata(input) } : {}),
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

  // #28: project the shot + motion plan up front (deterministic, LLM-free) so
  // the author sees how many shots this WILL cut and how many will move BEFORE
  // the generation spend — the numbers were previously only visible at the gate.
  // Resolved against the same profile the pipeline will resolve from the stored
  // value, so the projection tracks the real cut.
  const resolved = resolveProductionProfile(profile, { contentFormat: channel.contentFormat });
  const isLong = channel.contentFormat === "long" || (dna?.targetLengthSec ?? 0) > 90;
  const shotPlan = projectShotPlan(beats, resolved, {
    isLong,
    targetLengthSec: dna?.targetLengthSec ?? undefined,
  });
  return { productionId, ideaId, wordCount, beatCount: beats.length, shotPlan };
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
    /** ticket 01KY2BJ9…: named title families so review_slate can flag drift */
    titleTemplates?: { name: string; pattern: string; example?: string }[];
    /** ticket 01KY3B8N…: the terms the audience actually searches (review_slate keyword check) */
    searchTerms?: string[];
    /** ticket 01KY61RC… (#39): content-driven runtime band (partial-merged over resolved defaults) */
    lengthPolicy?: Partial<LengthPolicy>;
  };
  productionProfile?: Partial<ProductionProfile>;
  charter?: {
    mission?: string;
    objectives?: string[];
    // ticket 01KY294Y…: verificationBar was returned by get_channel_config +
    // propose_channel but unpatchable, so charter drift on the most
    // compliance-relevant field (establishedMinSources) was unfixable over MCP.
    verificationBar?: {
      establishedMinSources?: number;
      presentDebateMode?: boolean;
      minFactsToScript?: number;
      factualityMode?: "strict" | "balanced" | "entertainment";
    };
  };
};

/**
 * The stored value of the multi-entry DNA fields, echoed back after a write so a
 * silent transformation would be visible without a separate get_channel_config
 * read (ticket 01KY6D8F… requested this — the corrupting path turned out to be a
 * cockpit form, not this one, but echoing makes any future regression obvious).
 */
type StoredDnaEcho = {
  hookStyles?: string[];
  forbiddenTopics?: string[];
  titleTemplates?: { name: string; pattern: string; example?: string }[];
  searchTerms?: string[];
};

/** Set channel options directly (no wizard/planner LLM). Only provided fields change. */
export async function setChannelConfig(
  input: SetChannelConfigInput,
): Promise<{ ok: true; changed: string[]; stored?: StoredDnaEcho }> {
  const { db } = await getAppContext();
  const [channel] = await db.select().from(channels).where(eq(channels.id, input.channelId));
  if (!channel) throw new Error("Channel not found");
  const changed: string[] = [];
  let stored: StoredDnaEcho | undefined;

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
    if (Array.isArray(d.titleTemplates)) {
      patch.titleTemplates = d.titleTemplates
        .filter((t): t is { name: string; pattern: string; example?: string } => Boolean(t && typeof t.name === "string" && typeof t.pattern === "string"))
        .slice(0, 12)
        .map((t) => ({ name: t.name.slice(0, 80), pattern: t.pattern.slice(0, 500), ...(t.example ? { example: String(t.example).slice(0, 300) } : {}) }));
      changed.push("titleTemplates");
    }
    if (Array.isArray(d.searchTerms)) {
      patch.searchTerms = d.searchTerms
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim().slice(0, 120))
        .slice(0, 30);
      changed.push("searchTerms");
    }
    if (d.lengthPolicy && typeof d.lengthPolicy === "object") {
      // partial-merge over the stored (or default) policy, then normalise —
      // floorSec stays the hard bound, ceiling/bands/principle keep sane values.
      patch.lengthPolicy = resolveLengthPolicy({ ...(dna.lengthPolicy ?? {}), ...d.lengthPolicy });
      changed.push("lengthPolicy");
    }
    if (input.productionProfile) {
      // merge over the stored profile so a partial patch doesn't wipe axes
      const merged = { ...(dna.productionProfile ?? {}), ...normaliseProfile(input.productionProfile) };
      patch.productionProfile = merged;
      changed.push("productionProfile");
    }
    if (Object.keys(patch).length) {
      await db.update(channelDna).set(patch).where(eq(channelDna.channelId, input.channelId));
      // Re-read and echo the stored multi-entry arrays so a silent transformation
      // (a comma-split regression like the persona-form bug) is visible in the
      // response without a separate get_channel_config read.
      const [saved] = await db.select().from(channelDna).where(eq(channelDna.channelId, input.channelId));
      if (saved) {
        stored = {};
        if (d.hookStyles !== undefined) stored.hookStyles = saved.hookStyles ?? [];
        if (d.forbiddenTopics !== undefined) stored.forbiddenTopics = saved.forbiddenTopics ?? [];
        if (Array.isArray(d.titleTemplates)) stored.titleTemplates = saved.titleTemplates ?? [];
        if (Array.isArray(d.searchTerms)) stored.searchTerms = saved.searchTerms ?? [];
      }
    }
  }

  if (input.charter) {
    const [charter] = await db.select().from(channelCharters).where(eq(channelCharters.channelId, input.channelId));
    if (charter) {
      const patch: Record<string, unknown> = {};
      if (input.charter.mission !== undefined) { patch.mission = input.charter.mission; changed.push("mission"); }
      if (input.charter.objectives !== undefined) { patch.objectives = input.charter.objectives.slice(0, 12); changed.push("objectives"); }
      const vb = input.charter.verificationBar;
      if (vb) {
        // merge over the stored bar so a partial patch keeps the other fields
        const current = (charter.verificationBar ?? {}) as VerificationBar;
        const nextBar: VerificationBar = { ...current };
        if (typeof vb.establishedMinSources === "number") {
          nextBar.establishedMinSources = Math.min(5, Math.max(1, Math.round(vb.establishedMinSources)));
        }
        if (typeof vb.presentDebateMode === "boolean") nextBar.presentDebateMode = vb.presentDebateMode;
        if (typeof vb.minFactsToScript === "number") {
          nextBar.minFactsToScript = Math.min(20, Math.max(1, Math.round(vb.minFactsToScript)));
        }
        if (vb.factualityMode && ["strict", "balanced", "entertainment"].includes(vb.factualityMode)) {
          nextBar.factualityMode = vb.factualityMode;
        }
        patch.verificationBar = nextBar;
        changed.push("verificationBar");
      }
      if (Object.keys(patch).length) {
        await db.update(channelCharters).set(patch).where(eq(channelCharters.channelId, input.channelId));
      }
    }
  }

  if (changed.length) {
    await logDecision(db, input.channelId, `Channel options set via Claude (MCP): ${changed.join(", ")}`, { changed });
  }
  return { ok: true, changed, ...(stored ? { stored } : {}) };
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

/**
 * §3.4/§3.5: set a production's published packaging (title/description/tags/
 * thumbnail prompt) before the final gate. Merges over any existing authored
 * metadata. Locked once published/scheduled (use a corrected copy after that).
 */
export async function setPublicationMetadata(input: {
  productionId: string;
  title?: string;
  description?: string;
  tags?: string[];
  thumbnailPrompt?: string;
}): Promise<{ ok: true; authoredMetadata: Record<string, unknown>; thumbnailPrompt?: string }> {
  const { db } = await getAppContext();
  const [prod] = await db.select().from(productions).where(eq(productions.id, input.productionId));
  if (!prod) throw new Error("Production not found");
  if (["published", "scheduled"].includes(prod.status)) {
    throw new Error("This production is already published/scheduled — its metadata is locked. Make a corrected copy to change it.");
  }
  const patch = buildAuthoredMetadata(input);
  if (!patch) throw new Error("Provide at least one of title, description, tags, thumbnailPrompt.");
  const merged = { ...(prod.authoredMetadata ?? {}), ...patch };
  await db.update(productions).set({ authoredMetadata: merged }).where(eq(productions.id, input.productionId));
  await logDecision(db, prod.channelId, "Publication metadata set via Claude (MCP)", {
    productionId: input.productionId,
    fields: Object.keys(patch),
  });
  // Contract clarity (ticket 01KY6F1X…): thumbnails are generated BEFORE the
  // thumbnail_review gate opens, so setting thumbnailPrompt at/after that gate
  // only STORES the string — it does not re-render the image. Say so plainly
  // (a silent no-op on the highest-leverage discovery asset is the worst case)
  // and point at the tool that actually renders it.
  const thumbnailStored = patch.thumbnailPrompt != null && prod.status === "thumbnail_review";
  return {
    ok: true,
    authoredMetadata: merged,
    ...(thumbnailStored
      ? {
          thumbnailPrompt:
            "stored; NOT rendered — this production is already at the thumbnail_review gate, so the thumbnail image was generated earlier. To render this prompt into a new candidate now, call regenerate_thumbnail(productionId, { thumbnailPrompt }); the gate stays open for you to pick.",
        }
      : {}),
  };
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
