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
import { and, desc, eq, inArray } from "drizzle-orm";
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
  type ChannelStrategy,
  type Db,
  type LengthPolicy,
  type ProductionProfile,
  type ScriptBeat,
  type VerificationBar,
} from "@ytauto/db";
import {
  beatType,
  inngest,
  guidanceBudgetWarnings,
  productionProfileSchema,
  projectShotPlan,
  publishedVideoForIdea,
  resolveImageStyle,
  resolveLengthPolicy,
  mergeProductionProfile,
  resolveProductionProfile,
  minSecondsPerShotOverrideWarning,
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
  // Tolerate a JSON-STRING productionProfile (ticket 01KY98YR…): some MCP clients
  // serialise the object argument to a string, which used to fail with a confusing
  // root-level "Expected object, received string". Parse it before validating.
  let value: unknown = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(
        "Invalid productionProfile — it must be an OBJECT of profile axes (e.g. { artDirection: \"…\", notes: \"…\" }), but a plain string was received. If your client encodes arguments as JSON, pass productionProfile as a real object, not a JSON string.",
      );
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Invalid productionProfile — it must be an OBJECT of profile axes (e.g. { artDirection: "…" }), received ${Array.isArray(value) ? "an array" : typeof value}.`,
    );
  }
  const parsed = productionProfileSchema.partial().safeParse(value);
  if (!parsed.success) {
    // Name the offending field and, for a length cap, both numbers (actual vs
    // limit) — productionProfile is a free-form object with per-field caps, so a
    // bare "String must contain at most 800" forced the caller to bisect
    // (ticket 01KY6F1X…).
    const details = parsed.error.issues.map((i) => {
      const field = i.path.length ? `productionProfile.${i.path.join(".")}` : "productionProfile";
      if (i.code === "too_big" && i.type === "string" && typeof i.maximum === "number") {
        const val = valueAtPath(value, i.path);
        const len = typeof val === "string" ? val.length : undefined;
        return `${field}: ${len != null ? `${len.toLocaleString()} characters exceeds the ` : "exceeds the "}${i.maximum.toLocaleString()}-character limit`;
      }
      // #79: unknown keys are rejected (not silently dropped). Name them, and for
      // captionStyle list the accepted fields so the operator can self-correct.
      if (i.code === "unrecognized_keys") {
        const bad = i.keys.map((k) => `'${k}'`).join(", ");
        const accepted = field.endsWith("captionStyle")
          ? " — accepted: position, casing, typeface, weight, maxLines, outline, color, activeColor, outlineColor, outlineWidth, shadow, scrim, emphasisColor, emphasisPhrases"
          : "";
        return `${field}: unknown key(s) ${bad}${accepted}`;
      }
      return `${field}: ${i.message}`;
    });
    throw new Error(`Invalid productionProfile — ${details.join("; ")}`);
  }
  return parsed.data as Partial<ProductionProfile>;
}

/**
 * #86: resolve an `ideaId` that MAY actually be a series-EPISODE id. review_beat_map
 * and author_script both take an `ideaId` but validated it differently — review
 * accepted an episode id (it only uses it as an opaque comparison key) while author
 * rejected it against the `ideas` table. This is the single read-only resolver both
 * now share:
 *  - the id is a real idea → `{ kind: "idea", ideaId: id }`
 *  - the id is a series episode → `{ kind: "episode", ideaId: episode.ideaId (may be
 *    null if not yet queued), episode }`
 *  - neither → `{ kind: "unknown", ideaId: null }`
 * It never writes (no minting) — the caller decides what to do with an episode that
 * has no backing idea yet.
 */
export type IdeaRef = {
  kind: "idea" | "episode" | "unknown";
  /** the canonical backing idea id (null for an episode not yet queued to one) */
  ideaId: string | null;
  episode?: typeof episodes.$inferSelect;
};
export async function resolveIdeaRef(db: Db, id: string): Promise<IdeaRef> {
  const [idea] = await db.select({ id: ideas.id }).from(ideas).where(eq(ideas.id, id)).limit(1);
  if (idea) return { kind: "idea", ideaId: id };
  const [ep] = await db.select().from(episodes).where(eq(episodes.id, id)).limit(1);
  if (ep) return { kind: "episode", ideaId: ep.ideaId ?? null, episode: ep };
  return { kind: "unknown", ideaId: null };
}

export type AuthoredBeat = {
  type: "hook" | "stat" | "insight" | "cta";
  text: string;
  imagePrompt?: string;
  /** #69 (append): ordered list of per-shot GENERATED prompts, consumed across
   * the shots this beat is cut into — supply N distinct prompts for one beat that
   * fans into N generated shots without adding beats (the generative twin of
   * referenceEntities; shot i → imagePrompts[i], else imagePrompt). */
  imagePrompts?: (string | null)[];
  referenceEntity?: string | null;
  /** #69: ordered list of real subjects, consumed across the shots this beat is
   * cut into — supply N distinct briefs for one beat without adding beats. */
  referenceEntities?: (string | null)[];
  visualBrief?: string | null;
  heroShot?: boolean;
  /** #72: render this beat as a typeset quote card instead of an image. */
  quoteCard?: { text: string; attribution?: string | null };
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
  /** #80: the resolved profile this production will actually generate against —
   * so a caller can assert engines/motion/voice instead of inferring them. */
  resolvedProfile: {
    motion: ProductionProfile["motion"];
    imageEngine: ProductionProfile["imageEngine"];
    heroImageEngine: ProductionProfile["heroImageEngine"];
    characterImageEngine: ProductionProfile["characterImageEngine"];
    thumbnailImageEngine: ProductionProfile["thumbnailImageEngine"];
    voiceModel: ProductionProfile["voiceModel"];
    music: ProductionProfile["music"];
    captions: ProductionProfile["captions"];
    archivalStrength: ProductionProfile["archivalStrength"];
    visualDirector: ProductionProfile["visualDirector"];
    /** #93: the channel house image style that WILL be applied to authored
     * imagePrompts (subject stays verbatim, this rides as the render register) —
     * null when unset. Auditable before spend so a "NOT photographic" style
     * isn't silently dropped from the shots. */
    imageStyle: string | null;
  };
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
    let [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId));
    if (!idea) {
      // #86: the caller may have passed a series-EPISODE id (which review_beat_map
      // accepts). Resolve it to the episode's backing idea; if the episode isn't yet
      // queued to one, mint that idea and link it — so the authored production ties to
      // the arc episode and post-publish reconciliation (which matches by ideaId)
      // marks the episode published.
      const [ep] = await db.select().from(episodes).where(eq(episodes.id, ideaId));
      if (!ep) {
        throw new Error(
          "ideaId not found — pass a backlog idea id from list_ideas, or a series episode id from list_series.",
        );
      }
      if (ep.channelId !== input.channelId) throw new Error("that series episode belongs to another channel");
      if (ep.status === "cut") throw new Error("that series episode was cut — restore or replace it before authoring against it.");
      if (ep.ideaId) {
        [idea] = await db.select().from(ideas).where(eq(ideas.id, ep.ideaId));
        if (idea) ideaId = ep.ideaId;
      }
      if (!idea) {
        const mintedId = ulid();
        await db.insert(ideas).values({
          id: mintedId,
          channelId: input.channelId,
          title: ep.title.slice(0, 120),
          angle: (ep.angle || ep.title).trim().slice(0, 120) || ep.title.slice(0, 120),
          sourceType: "editorial", // derived from the series editorial plan, like episode-research's handoff
          researchRefs: [{ via: "mcp", authored: true, fromEpisode: ep.id }],
          status: "greenlit",
        });
        await db.update(episodes).set({ ideaId: mintedId, status: "queued" }).where(eq(episodes.id, ep.id));
        ideaId = mintedId;
        [idea] = await db.select().from(ideas).where(eq(ideas.id, mintedId));
      }
    }
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
      // #69 (append): keep the ordered per-shot GENERATED prompt list (trimmed;
      // blanks → null so a gap falls back to the single imagePrompt at render).
      ...(Array.isArray(b.imagePrompts) && b.imagePrompts.length
        ? {
            imagePrompts: b.imagePrompts.map((p) =>
              typeof p === "string" && p.trim() ? p.trim() : null,
            ),
          }
        : {}),
      referenceEntity: b.referenceEntity?.trim() || null,
      // #69: keep the ordered per-shot brief list (trimmed; blanks → null so a
      // gap in the list falls back to the single referenceEntity at render).
      ...(Array.isArray(b.referenceEntities) && b.referenceEntities.length
        ? {
            referenceEntities: b.referenceEntities.map((e) =>
              typeof e === "string" && e.trim() ? e.trim() : null,
            ),
          }
        : {}),
      visualBrief: b.visualBrief?.trim() || null,
      heroShot: b.heroShot ?? false,
      // #72: a quote-card beat renders typeset text on a plain ground.
      ...(b.quoteCard && typeof b.quoteCard.text === "string" && b.quoteCard.text.trim()
        ? { quoteCard: { text: b.quoteCard.text.trim(), attribution: b.quoteCard.attribution?.trim() || null } }
        : {}),
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
  // Always set the production profile. A set profile makes the pipeline SKIP the
  // profile-proposal LLM and its review gate (no redundant LLM on an authored run).
  //
  // #80: PARTIAL-MERGE the caller's per-video override OVER the channel's stored
  // profile — never replace it wholesale. Sending one axis (e.g. minSecondsPerShot)
  // used to reset every other axis (motion, all four image engines, voiceModel, …)
  // to platform defaults silently, wasting a whole video. This mirrors
  // set_channel_config's spread-over-stored partial-write semantics. Resolving the
  // merged result pins a complete profile (behaviour-preserving for the no-override
  // case, which already stored a fully-resolved profile).
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, input.channelId));
  const override = normaliseProfile(input.productionProfile);
  const profile = mergeProductionProfile(dna?.productionProfile, override, {
    contentFormat: channel.contentFormat,
  });

  const productionId = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(productions).values({
      id: productionId,
      ideaId,
      channelId: input.channelId,
      status: "greenlit",
      substanceFingerprint: fingerprint,
      externalScript: true, // skip the human script gate; checks still run
      // P6: name the three intentions explicitly rather than leaving them
      // implied by the flag above. author_script owns all three — the script,
      // the imagePrompts (when >=20 chars) and the motionPrompts are the
      // caller's — so a later copy carries a struct that cannot be half-lost.
      scriptAuthored: true,
      promptsAuthored: true,
      motionAuthored: true,
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
  // `profile` is already the fully-resolved merged profile (mergeProductionProfile
  // above), i.e. exactly what the pipeline will resolve from the stored value, so
  // the projection tracks the real cut.
  const resolved = profile;
  const isLong = channel.contentFormat === "long" || (dna?.targetLengthSec ?? 0) > 90;
  const shotPlan = projectShotPlan(beats, resolved, {
    isLong,
    targetLengthSec: dna?.targetLengthSec ?? undefined,
  });
  // #93: the ticket asked for a shotPlan note whenever authored prompts are in
  // play, because 126 authored prompts silently bypassing the channel style was
  // invisible in this response. State what WILL happen to them — the register is
  // applied now, so a note that read "style is being bypassed" would be a lie,
  // but "nothing said anything at all" was the reported defect.
  const authoredCount = beats.filter((b) => (b.imagePrompt?.trim().length ?? 0) >= 20).length;
  if (authoredCount > 0) {
    const houseStyle = resolveImageStyle(dna?.visualStyle?.imageStyle ?? null);
    shotPlan.notes.push(
      houseStyle
        ? `${authoredCount} beat(s) carry an authored imagePrompt — used VERBATIM for subject/composition, with the channel's house imageStyle appended as a render register (see resolvedProfile.imageStyle). Bake a one-off look into the prompt itself to override it for a shot.`
        : `${authoredCount} beat(s) carry an authored imagePrompt — used VERBATIM. This channel has NO house imageStyle set, so nothing steers the render register; set dna.imageStyle (set_channel_config) if the shots must share a look.`,
    );
  }
  // #80: report the RESOLVED profile the production will actually generate against,
  // so a caller can assert engines/motion/voice instead of inferring them from a
  // note about motion prompts. shotPlan never mentioned engines, so an engine reset
  // was invisible in the MCP response.
  const resolvedProfile = {
    motion: resolved.motion,
    imageEngine: resolved.imageEngine,
    heroImageEngine: resolved.heroImageEngine,
    characterImageEngine: resolved.characterImageEngine,
    thumbnailImageEngine: resolved.thumbnailImageEngine,
    voiceModel: resolved.voiceModel,
    music: resolved.music,
    captions: resolved.captions,
    archivalStrength: resolved.archivalStrength,
    visualDirector: resolved.visualDirector,
    // #93: echo the house style so a caller can confirm authored prompts keep the
    // channel's render register (it's appended as a Style suffix at generation
    // when no distilled Style-tab style is active; the distilled style, when set,
    // rides as reference-image conditioning and wins).
    imageStyle: dna?.visualStyle?.imageStyle?.trim() || null,
  };
  return { productionId, ideaId, wordCount, beatCount: beats.length, shotPlan, resolvedProfile };
}

export type SetChannelConfigInput = {
  channelId: string;
  autonomyTier?: number;
  /** ticket 01KY9ECP… (#51): the channel content format — long | short | both.
   * A top-level `channels` column (not DNA); it is load-bearing, not a label —
   * orientation/aspect (16:9 vs 9:16), the shot planner and the scriptwriter all
   * read it. Per-video orientation is a separate axis (productionProfile.orientation). */
  contentFormat?: "long" | "short" | "both";
  /** ticket 01KY9EDC… (#53): YouTube Made-for-Kids (COPPA) self-designation.
   * true = MFK, false = not MFK, null = undeclared. A top-level `channels` column
   * read by the publish path + authoring CTA + consistencyWarnings. */
  madeForKids?: boolean | null;
  /** ticket 01KYEK… (#68): pause automatic ideation for this channel (the daily
   * trend-scan cron skips it). Manual write_idea/seed_idea + series planning still work. */
  ideationPaused?: boolean;
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
    /** ticket 01KYB5BQ… (#57): the channel's house image style — a plain-language
     * render register ("bold graphic illustration, painted graphic novel, NOT
     * photographic") that steers every generated image (characters + scenes) when
     * no distilled Style-tab style is active. Merged into dna.visualStyle. */
    imageStyle?: string;
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
  lengthPolicy?: LengthPolicy;
  /** the stored house image-style string after trim/cap (ticket #57) */
  imageStyle?: string;
  /** the merged, stored productionProfile (raw jsonb, NOT the read-resolved defaults) */
  productionProfile?: Partial<ProductionProfile>;
};

/** Set channel options directly (no wizard/planner LLM). Only provided fields change. */
export async function setChannelConfig(
  input: SetChannelConfigInput,
): Promise<{ ok: true; changed: string[]; stored?: StoredDnaEcho; warnings?: string[] }> {
  const { db } = await getAppContext();
  const [channel] = await db.select().from(channels).where(eq(channels.id, input.channelId));
  if (!channel) throw new Error("Channel not found");
  const changed: string[] = [];
  // ticket 01KY9E15… (#48): advisory (non-blocking) notes surfaced on write — e.g. a
  // targetLengthSec stored below the channel's own hard lengthPolicy floor. The value
  // is still written as-is (the operator may be mid-migration); the note just makes
  // the inconsistency legible at the moment it's introduced, not only on the next read.
  const warnings: string[] = [];
  let stored: StoredDnaEcho | undefined;

  if (typeof input.autonomyTier === "number") {
    const tier = Math.min(Math.max(Math.round(input.autonomyTier), 0), 3);
    await db.update(channels).set({ autonomyTier: tier }).where(eq(channels.id, input.channelId));
    changed.push(`autonomyTier=${tier}`);
  }

  // #51 (ticket 01KY9ECP…): contentFormat is a top-level channels column, previously
  // unsettable over MCP. long/short/both — load-bearing (orientation/aspect, shot
  // planner, scriptwriter all read it), so a long-only channel can now be moved to
  // "both" from chat. Per-video orientation stays productionProfile.orientation.
  if (input.contentFormat !== undefined) {
    const fmt = input.contentFormat;
    if (!["long", "short", "both"].includes(fmt)) {
      throw new Error(`contentFormat must be one of long | short | both (got ${JSON.stringify(fmt)})`);
    }
    await db.update(channels).set({ contentFormat: fmt }).where(eq(channels.id, input.channelId));
    changed.push(`contentFormat=${fmt}`);
  }

  // #53 (ticket 01KY9EDC…): the Made-for-Kids (COPPA) designation. true/false/null
  // (null clears it back to undeclared). Load-bearing: the publish path sends it as
  // selfDeclaredMadeForKids, and it gates end-card/comment CTAs. When set true, the
  // authoring pipeline should stop writing end-card/comment CTAs (YouTube disables
  // those on MFK content) — consistencyWarnings flags a charter that still commits to them.
  if (input.madeForKids !== undefined) {
    const mfk = input.madeForKids === null ? null : Boolean(input.madeForKids);
    await db.update(channels).set({ madeForKids: mfk }).where(eq(channels.id, input.channelId));
    changed.push(`madeForKids=${mfk === null ? "undeclared" : mfk}`);
  }

  // #68 (ticket 01KYEK…): pause/resume automatic ideation for this channel.
  if (input.ideationPaused !== undefined) {
    const paused = Boolean(input.ideationPaused);
    await db.update(channels).set({ ideationPaused: paused }).where(eq(channels.id, input.channelId));
    changed.push(`ideationPaused=${paused}`);
  }

  if (input.dna || input.productionProfile) {
    const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, input.channelId));
    if (!dna) throw new Error("Channel has no DNA row");
    const patch: Record<string, unknown> = {};
    const d = input.dna ?? {};
    // #89/#93: prose DNA fields used to be silently .slice()'d (titleTemplates
    // pattern at 500, imageStyle at 400) — a truncated compliance rule read as a
    // clean write. Caps are now generous (a full rule with evidence + exceptions
    // fits) AND a truncation that still happens is surfaced as a warning naming
    // the field, the limit and the submitted length, instead of losing text mute.
    const capWarn = (value: string, max: number, label: string): string => {
      if (value.length <= max) return value;
      warnings.push(
        `${label} was ${value.length} chars and was truncated to the ${max}-char limit — shorten it or split the rule so nothing is lost.`,
      );
      return value.slice(0, max);
    };
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
        .map((t, i) => ({
          name: capWarn(t.name, 120, `titleTemplates[${i}].name`),
          pattern: capWarn(t.pattern, 2000, `titleTemplates[${i}].pattern`),
          ...(t.example ? { example: capWarn(String(t.example), 600, `titleTemplates[${i}].example`) } : {}),
        }));
      changed.push("titleTemplates");
    }
    if (Array.isArray(d.searchTerms)) {
      patch.searchTerms = d.searchTerms
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .slice(0, 30)
        .map((t, i) => capWarn(t.trim(), 120, `searchTerms[${i}]`));
      changed.push("searchTerms");
    }
    if (d.lengthPolicy && typeof d.lengthPolicy === "object") {
      // partial-merge over the stored (or default) policy, then normalise —
      // floorSec stays the hard bound, ceiling/bands/principle keep sane values.
      patch.lengthPolicy = resolveLengthPolicy({ ...(dna.lengthPolicy ?? {}), ...d.lengthPolicy });
      changed.push("lengthPolicy");
    }
    // #48: when this write touches the soft anchor or the policy, check the EFFECTIVE
    // result against the hard floor and warn (don't reject) if the anchor lands below
    // it — the same inconsistency get_channel_config.consistencyWarnings flags on read.
    if (d.targetLengthSec !== undefined || d.lengthPolicy) {
      const effTarget =
        typeof patch.targetLengthSec === "number" ? (patch.targetLengthSec as number) : dna.targetLengthSec;
      const effPolicy = (patch.lengthPolicy as LengthPolicy | undefined) ?? resolveLengthPolicy(dna.lengthPolicy ?? null);
      if (effTarget > 0 && effPolicy.floorSec > 0 && effTarget < effPolicy.floorSec) {
        warnings.push(
          `targetLengthSec ${effTarget}s is below lengthPolicy.floorSec ${effPolicy.floorSec}s (the HARD floor) — stored as-is, but an author writing to this anchor forfeits YouTube mid-rolls. Raise targetLengthSec to ≥ ${effPolicy.floorSec}s, or lower floorSec if the floor is wrong.`,
        );
      }
    }
    if (typeof d.imageStyle === "string") {
      // ticket #57: the channel house image-style string. Merge into visualStyle so
      // the other fields (primaryColor/font/tagline) are preserved. This steers every
      // generated image when no distilled Style-tab style is active (that active style,
      // when present, still wins — it's the richer, example-bedded look).
      patch.visualStyle = { ...(dna.visualStyle ?? {}), imageStyle: capWarn(d.imageStyle.trim(), 2000, "dna.imageStyle") };
      changed.push("imageStyle");
    }
    if (input.productionProfile) {
      // merge over the stored profile so a partial patch doesn't wipe axes
      const merged = { ...(dna.productionProfile ?? {}), ...normaliseProfile(input.productionProfile) };
      patch.productionProfile = merged;
      changed.push("productionProfile");
      // #71: the guidance caps were raised to 50k so a full brief fits, but these
      // fields ARE injected into prompts — surface a non-blocking advisory when
      // one is large (esp. artDirection, injected per-shot) so the raise doesn't
      // silently move the failure downstream into degraded generation.
      warnings.push(
        ...guidanceBudgetWarnings({
          notes: typeof merged.notes === "string" ? merged.notes : undefined,
          artDirection: typeof merged.artDirection === "string" ? merged.artDirection : undefined,
          thumbnailTemplate: typeof merged.thumbnailTemplate === "string" ? merged.thumbnailTemplate : undefined,
        }),
      );
      // #69 (append): raising minSecondsPerShot on an animating channel is inert —
      // the i2v clip cap force-cuts moving shots regardless — so warn on the write
      // instead of leaving the operator to discover the shot count didn't budge.
      const floorWarn = minSecondsPerShotOverrideWarning(resolveProductionProfile(merged));
      if (floorWarn) warnings.push(floorWarn);
    }
    if (Object.keys(patch).length) {
      await db.update(channelDna).set(patch).where(eq(channelDna.channelId, input.channelId));
      // Re-read and echo the fields we just wrote (the RAW stored values, not the
      // read-resolved defaults) so a silent transformation is visible without a
      // separate get_channel_config read. Only fields the caller actually touched
      // are echoed, and `stored` is omitted entirely when nothing echoable changed —
      // an empty `stored: {}` read as "nothing was written" (ticket 01KY98YR…).
      const [saved] = await db.select().from(channelDna).where(eq(channelDna.channelId, input.channelId));
      if (saved) {
        const echo: StoredDnaEcho = {};
        if (d.hookStyles !== undefined) echo.hookStyles = saved.hookStyles ?? [];
        if (d.forbiddenTopics !== undefined) echo.forbiddenTopics = saved.forbiddenTopics ?? [];
        if (Array.isArray(d.titleTemplates)) echo.titleTemplates = saved.titleTemplates ?? [];
        if (Array.isArray(d.searchTerms)) echo.searchTerms = saved.searchTerms ?? [];
        if (d.lengthPolicy && saved.lengthPolicy) echo.lengthPolicy = saved.lengthPolicy;
        if (typeof d.imageStyle === "string" && saved.visualStyle) echo.imageStyle = saved.visualStyle.imageStyle;
        if (input.productionProfile && saved.productionProfile) echo.productionProfile = saved.productionProfile;
        if (Object.keys(echo).length) stored = echo;
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
  return { ok: true, changed, ...(stored ? { stored } : {}), ...(warnings.length ? { warnings } : {}) };
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

// ── #59: series & idea mutation (the content-planning surface was write-once) ──

const SERIES_STATUSES = ["proposed", "active", "completed", "archived"] as const;
const EPISODE_STATUSES = [
  "planned",
  "researching",
  "verifying",
  "briefed",
  "queued",
  "produced",
  "published",
  "cut",
] as const;
const IDEA_STATUSES = ["inbox", "scored", "greenlit", "rejected", "archived"] as const;

export type UpdateSeriesInput = {
  channelId: string;
  seriesId: string;
  title?: string;
  description?: string;
  status?: (typeof SERIES_STATUSES)[number];
  /** full reordering — every episode id in the series, exactly once, in the new order */
  episodeOrder?: string[];
};

/**
 * Mutate an existing arc (ticket 01KYDT3A… / #59): rename, re-describe, change
 * status (a `proposed` arc can finally be promoted to `active`), and/or reorder
 * its episodes. Only provided fields change.
 */
export async function updateSeries(input: UpdateSeriesInput): Promise<{ ok: true; changed: string[] }> {
  const { db } = await getAppContext();
  const [row] = await db
    .select()
    .from(series)
    .where(and(eq(series.id, input.seriesId), eq(series.channelId, input.channelId)));
  if (!row) throw new Error("Series not found on this channel");
  const changed: string[] = [];
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) {
    if (!input.title.trim()) throw new Error("title cannot be empty");
    patch.title = input.title.trim();
    changed.push("title");
  }
  if (input.description !== undefined) {
    patch.description = input.description.trim();
    changed.push("description");
  }
  if (input.status !== undefined) {
    if (!SERIES_STATUSES.includes(input.status)) {
      throw new Error(`status must be one of ${SERIES_STATUSES.join(" | ")}`);
    }
    patch.status = input.status;
    changed.push(`status=${input.status}`);
  }
  await db.transaction(async (tx) => {
    if (Object.keys(patch).length) {
      await tx.update(series).set(patch).where(eq(series.id, input.seriesId));
    }
    if (input.episodeOrder && input.episodeOrder.length) {
      const eps = await tx.select({ id: episodes.id }).from(episodes).where(eq(episodes.seriesId, input.seriesId));
      const known = new Set(eps.map((e) => e.id));
      const order = input.episodeOrder;
      if (new Set(order).size !== order.length) throw new Error("episodeOrder contains duplicate ids");
      for (const id of order) {
        if (!known.has(id)) throw new Error(`episode ${id} is not in this series`);
      }
      if (order.length !== known.size) {
        throw new Error(`episodeOrder must list all ${known.size} episode(s) exactly once (got ${order.length})`);
      }
      // Two-phase so the (seriesId, position) unique index never collides mid-move:
      // park every episode at a distinct negative slot, then assign 0..n-1.
      for (const [i, id] of order.entries()) {
        await tx.update(episodes).set({ position: -(i + 1) }).where(eq(episodes.id, id));
      }
      for (const [i, id] of order.entries()) {
        await tx.update(episodes).set({ position: i }).where(eq(episodes.id, id));
      }
      changed.push("episodeOrder");
    }
  });
  if (changed.length) {
    await logDecision(db, input.channelId, `Series updated via Claude (MCP): ${changed.join(", ")}`, {
      seriesId: input.seriesId,
      changed,
    });
  }
  return { ok: true, changed };
}

/**
 * Move ONE episode's status (ticket 01KYDT3A… / #59) — e.g. mark it `cut` to drop
 * it from the arc, or back to `planned`/`queued`. Previously an episode could only
 * advance by authoring a script against it.
 */
export async function setEpisodeStatus(input: {
  channelId: string;
  episodeId: string;
  status: (typeof EPISODE_STATUSES)[number];
}): Promise<{ ok: true; episodeId: string; from: string; status: string }> {
  const { db } = await getAppContext();
  if (!EPISODE_STATUSES.includes(input.status)) {
    throw new Error(`status must be one of ${EPISODE_STATUSES.join(" | ")}`);
  }
  const [ep] = await db
    .select({ id: episodes.id, status: episodes.status })
    .from(episodes)
    .where(and(eq(episodes.id, input.episodeId), eq(episodes.channelId, input.channelId)));
  if (!ep) throw new Error("Episode not found on this channel");
  await db.update(episodes).set({ status: input.status }).where(eq(episodes.id, input.episodeId));
  await logDecision(db, input.channelId, `Episode status set via Claude (MCP): ${ep.status} → ${input.status}`, {
    episodeId: input.episodeId,
    from: ep.status,
    to: input.status,
  });
  return { ok: true, episodeId: input.episodeId, from: ep.status, status: input.status };
}

/**
 * Set the status of one or more ideas (ticket 01KYDT3A… / #59) — the realistic
 * cleanup is archiving/rejecting many duplicate ideas at once, so this takes a
 * batch. Only ideas that belong to the channel are touched; unknown ids come back
 * in `skipped`.
 */
export async function setIdeaStatus(input: {
  channelId: string;
  ideaIds: string[];
  status: (typeof IDEA_STATUSES)[number];
}): Promise<{ ok: true; updated: number; status: string; skipped: string[] }> {
  const { db } = await getAppContext();
  if (!IDEA_STATUSES.includes(input.status)) {
    throw new Error(`status must be one of ${IDEA_STATUSES.join(" | ")}`);
  }
  const ids = [...new Set((input.ideaIds ?? []).filter((s) => typeof s === "string" && s.trim()))];
  if (!ids.length) throw new Error("ideaIds must contain at least one id");
  const rows = await db
    .select({ id: ideas.id })
    .from(ideas)
    .where(and(eq(ideas.channelId, input.channelId), inArray(ideas.id, ids)));
  const known = rows.map((r) => r.id);
  const skipped = ids.filter((id) => !known.includes(id));
  if (known.length) {
    await db
      .update(ideas)
      .set({ status: input.status })
      .where(and(eq(ideas.channelId, input.channelId), inArray(ideas.id, known)));
    await logDecision(db, input.channelId, `Idea status set via Claude (MCP): ${input.status} (${known.length})`, {
      status: input.status,
      count: known.length,
      ...(skipped.length ? { skipped } : {}),
    });
  }
  return { ok: true, updated: known.length, status: input.status, skipped };
}

// ── #61: the channel STRATEGY document — durable, high-capacity, section-scoped,
// and deliberately NOT read by the authoring pipeline (kept separate from the
// creative-instruction fields so a 40k-char strategy never pollutes a script prompt).

const STRATEGY_SECTION_CAP = 100_000;

export async function getChannelStrategy(channelId: string): Promise<{
  channelId: string;
  sections: { name: string; content: string; updatedAt: string; chars: number }[];
  totalChars: number;
  note: string;
}> {
  const { db } = await getAppContext();
  const [channel] = await db.select({ strategy: channels.strategy }).from(channels).where(eq(channels.id, channelId));
  if (!channel) throw new Error("Channel not found");
  const strat = (channel.strategy ?? { sections: {} }) as ChannelStrategy;
  const sections = Object.entries(strat.sections ?? {})
    .map(([name, s]) => ({ name, content: s.content, updatedAt: s.updatedAt, chars: s.content.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const totalChars = sections.reduce((n, s) => n + s.chars, 0);
  return {
    channelId,
    sections,
    totalChars,
    note: "This is the channel's STRATEGY document (taxonomy / decisions / vision). It is NOT read by the authoring pipeline — nothing here reaches a script/image/thumbnail prompt. It exists so a fresh session can learn what the channel is TRYING to do.",
  };
}

/**
 * Write or update one section of a channel's strategy document (ticket 01KYDZKW… /
 * #61). Section-scoped so appending a decision doesn't require rewriting a
 * 40,000-char document; each section is timestamped. Empty content clears a section.
 */
export async function setChannelStrategy(input: {
  channelId: string;
  content: string;
  section?: string;
}): Promise<{ ok: true; section: string; chars: number; totalChars: number; sections: string[] }> {
  const { db } = await getAppContext();
  const [channel] = await db.select({ strategy: channels.strategy }).from(channels).where(eq(channels.id, input.channelId));
  if (!channel) throw new Error("Channel not found");
  const section = ((input.section ?? "main").trim().slice(0, 80) || "main");
  const content = typeof input.content === "string" ? input.content : "";
  if (content.length > STRATEGY_SECTION_CAP) {
    throw new Error(
      `section content is ${content.length} chars; the per-section cap is ${STRATEGY_SECTION_CAP}. Split it across sections (the document as a whole is unbounded).`,
    );
  }
  const strat = (channel.strategy ?? { sections: {} }) as ChannelStrategy;
  const sections = { ...(strat.sections ?? {}) };
  if (!content.trim()) {
    delete sections[section]; // empty content clears the section
  } else {
    sections[section] = { content, updatedAt: new Date().toISOString() };
  }
  await db.update(channels).set({ strategy: { sections } }).where(eq(channels.id, input.channelId));
  const totalChars = Object.values(sections).reduce((n, s) => n + s.content.length, 0);
  await logDecision(
    db,
    input.channelId,
    `Channel strategy ${content.trim() ? "written" : "cleared"} via Claude (MCP): section "${section}" (${content.length} chars)`,
    { section, chars: content.length, cleared: !content.trim() },
  );
  return { ok: true, section, chars: content.length, totalChars, sections: Object.keys(sections).sort() };
}

/**
 * Edit a backlog idea's title/angle (ticket 01KYDZJR… / #60) — the common case is
 * "this idea is nearly right", not "bin it". Only provided fields change.
 */
export async function updateIdea(input: {
  channelId: string;
  ideaId: string;
  title?: string;
  angle?: string;
}): Promise<{ ok: true; changed: string[] }> {
  const { db } = await getAppContext();
  const [row] = await db
    .select({ id: ideas.id })
    .from(ideas)
    .where(and(eq(ideas.id, input.ideaId), eq(ideas.channelId, input.channelId)));
  if (!row) throw new Error("Idea not found on this channel");
  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  if (input.title !== undefined) {
    if (!input.title.trim()) throw new Error("title cannot be empty");
    patch.title = input.title.trim();
    changed.push("title");
  }
  if (input.angle !== undefined) {
    if (!input.angle.trim()) throw new Error("angle cannot be empty");
    patch.angle = input.angle.trim();
    changed.push("angle");
  }
  if (!changed.length) throw new Error("Provide at least one of title, angle.");
  await db.update(ideas).set(patch).where(eq(ideas.id, input.ideaId));
  await logDecision(db, input.channelId, `Idea edited via Claude (MCP): ${changed.join(", ")}`, {
    ideaId: input.ideaId,
    changed,
  });
  return { ok: true, changed };
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
