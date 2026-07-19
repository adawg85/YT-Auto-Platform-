"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, like } from "drizzle-orm";
import { ulid } from "ulid";
import { assets, channelCharacters, channelDecisions, channelDna, channels, ideas, productionMusic, productions, publications, reviewGates, scriptDrafts, styleTestScenes, thumbnails, visualStyleRefs, visualStyles, type Db } from "@ytauto/db";
import {
  buildThumbnailPrompts,
  imageEngineFor,
  imageEnginePreference,
  inngest,
  markPublicationLive,
  markScheduleCancelled,
  musicBriefFor,
  resolveConditioning,
  resolveProductionProfile,
  styleBlockForImagePrompts,
  styleRefKeyForIndex,
} from "@ytauto/core";
import { buildImagePrompts, generateIdeas as ideationAgent, nameMusicTrack, scoreIdea as scoringAgent, scoreImageFit, scoreThumbnailFromPrompt, writeMotionPrompt } from "@ytauto/agents";
import { getAppContext, operatorName } from "@/lib/context";
import { referenceUrlFor } from "@/lib/reference-url";
import { composeThumbnailPrompt, composeThumbnailRefinePrompt } from "./productions/[id]/thumbnail-compose";
import { MAX_CLIP_SEC, deriveShotPlan } from "@/lib/shot-plan";

/**
 * Land 3 media reuse: copy a source production's assets (+ thumbnails) onto a
 * new production, keeping the same storage keys so the pipeline's skip-if-present
 * steps reuse them instead of regenerating. Only what still exists is copied —
 * so the halt keep/discard choices decide what gets reused.
 */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
async function copyProductionMedia(tx: DbOrTx, sourceId: string, newId: string) {
  const srcAssets = await tx.select().from(assets).where(eq(assets.productionId, sourceId));
  if (srcAssets.length) {
    await tx.insert(assets).values(
      srcAssets.map((a) => ({
        id: ulid(),
        productionId: newId,
        kind: a.kind,
        idx: a.idx,
        storageKey: a.storageKey,
        mimeType: a.mimeType,
        durationSec: a.durationSec,
        meta: a.meta,
      })),
    );
  }
  const srcThumbs = await tx.select().from(thumbnails).where(eq(thumbnails.productionId, sourceId));
  if (srcThumbs.length) {
    await tx.insert(thumbnails).values(
      srcThumbs.map((t) => ({
        id: ulid(),
        productionId: newId,
        storageKey: t.storageKey,
        selected: t.selected,
        predictedCtr: t.predictedCtr,
      })),
    );
  }
  // Music (2026-07-19): copy the picked track too — without this a corrected
  // copy / resume rendered SILENT (the render found no production_music row and
  // dropped the bed) even though the source's cut had music.
  const srcMusic = await tx.select().from(productionMusic).where(eq(productionMusic.productionId, sourceId));
  if (srcMusic.length) {
    await tx.insert(productionMusic).values(
      srcMusic.map((m) => ({
        id: ulid(),
        productionId: newId,
        storageKey: m.storageKey,
        mimeType: m.mimeType,
        name: m.name,
        durationSec: m.durationSec,
        mood: m.mood,
        prompt: m.prompt,
        engine: m.engine,
        selected: m.selected,
      })),
    );
  }
}

export async function generateIdeasAction(channelId: string) {
  const { db, providers, costSink } = await getAppContext();
  await ideationAgent({ db, llm: providers.llm, costSink, channelId }, providers.research);
  revalidatePath("/ideas");
}

/** Form wrapper: generate ideas for the channel picked in the toolbar select. */
export async function generateIdeasFormAction(formData: FormData) {
  const channelId = String(formData.get("channelId") ?? "");
  if (!channelId) throw new Error("Pick a channel first");
  await generateIdeasAction(channelId);
  // scoring never needs a button press: the worker scores the fresh batch
  await inngest.send({ name: "ideas/autoscore.requested", data: { channelId } });
}

export async function scoreIdeaAction(ideaId: string) {
  const { db, providers, costSink } = await getAppContext();
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId));
  if (!idea) throw new Error("Idea not found");
  await scoringAgent({ db, llm: providers.llm, costSink, channelId: idea.channelId, ideaId }, ideaId);
  revalidatePath("/ideas");
  revalidatePath(`/channels/${idea.channelId}`); // #19: also the Plan tab
}

/** Greenlight: create the production and kick off the durable pipeline. */
export async function greenlightAction(ideaId: string) {
  const { db } = await getAppContext();
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId));
  if (!idea) throw new Error("Idea not found");

  const productionId = ulid();
  await db.insert(productions).values({
    id: productionId,
    ideaId,
    channelId: idea.channelId,
    status: "greenlit",
  });
  await db.update(ideas).set({ status: "greenlit" }).where(eq(ideas.id, ideaId));
  await inngest.send({ name: "production/greenlit", data: { productionId, attempt: "0" } });
  revalidatePath("/ideas");
  revalidatePath("/gates");
  revalidatePath(`/channels/${idea.channelId}`); // #19: also the Plan tab
}

/** Artifact groups the operator can keep or discard when halting a production. */
export type HaltDiscard = "script" | "voiceover" | "images" | "render" | "thumbnails";

/**
 * Halt a production from ANY stage and return its idea to the greenlightable
 * pool (idea → `scored`), preserving the production as a `halted` draft. The
 * operator chooses which produced artifacts to discard; kept ones stay attached
 * for a future resume. Cancels any in-flight pipeline run via `production/halt`
 * (the pipeline's `cancelOn`). Never deletes the production row — a mid-flight
 * hard delete would make child-insert steps throw and retry-storm.
 */
export async function haltProductionAction(productionId: string, discard: HaltDiscard[] = []) {
  const { db } = await getAppContext();
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) throw new Error("Production not found");

  const drop = new Set(discard);
  await db.transaction(async (tx) => {
    if (drop.has("script")) {
      await tx.delete(scriptDrafts).where(eq(scriptDrafts.productionId, productionId));
    }
    if (drop.has("voiceover")) {
      await tx
        .delete(assets)
        .where(and(eq(assets.productionId, productionId), eq(assets.kind, "voiceover")));
    }
    if (drop.has("images")) {
      await tx.delete(assets).where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")));
    }
    if (drop.has("render")) {
      await tx.delete(assets).where(and(eq(assets.productionId, productionId), eq(assets.kind, "render")));
    }
    if (drop.has("thumbnails")) {
      await tx.delete(thumbnails).where(eq(thumbnails.productionId, productionId));
    }
    // any gate still waiting is abandoned — expire it so it drops out of Review
    await tx
      .update(reviewGates)
      .set({ status: "expired" })
      .where(and(eq(reviewGates.productionId, productionId), eq(reviewGates.status, "pending")));
    await tx
      .update(productions)
      .set({ status: "halted", currentGateId: null, inngestRunId: null, failureReason: null })
      .where(eq(productions.id, productionId));
    // hand the idea back to the greenlightable pool (pre-greenlight = "scored")
    await tx.update(ideas).set({ status: "scored" }).where(eq(ideas.id, production.ideaId));
  });

  // stop the durable run if one is live (no-op if it already finished/died)
  await inngest.send({ name: "production/halt", data: { productionId } });

  revalidatePath(`/productions/${productionId}`);
  revalidatePath("/ideas");
  revalidatePath("/gates");
}

/**
 * Resume a halted production (BACKLOG #15 Land 2): reuse its kept script on a
 * fresh production and regenerate media. The pipeline detects the pre-seeded
 * script draft and skips drafting + the script gate. Media (voiceover/images/
 * render) is generated new under the new id, so no cross-id storage-key reuse.
 */
export async function resumeProductionAction(haltedProductionId: string) {
  const { db } = await getAppContext();
  const [halted] = await db.select().from(productions).where(eq(productions.id, haltedProductionId));
  if (!halted) throw new Error("Production not found");
  // A production halted EARLY (e.g. around planning, before the script gate) has
  // no draft. That's fine — reinstate it as a fresh production from the idea,
  // reusing whatever media survived the halt. A later halt (script exists) reuses
  // the script and skips drafting + the script gate.
  const [draft] = await db
    .select()
    .from(scriptDrafts)
    .where(eq(scriptDrafts.productionId, haltedProductionId))
    .orderBy(desc(scriptDrafts.version))
    .limit(1);

  const newId = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(productions).values({
      id: newId,
      ideaId: halted.ideaId,
      channelId: halted.channelId,
      status: "greenlit",
      // reuse the fingerprint so the anti-clone check sees the same substance
      substanceFingerprint: halted.substanceFingerprint,
    });
    // pre-seed the reused script as v1 — the pipeline picks this up and skips
    // drafting + the script gate. Skipped when there was no script (fresh draft).
    if (draft) {
      await tx.insert(scriptDrafts).values({
        id: ulid(),
        productionId: newId,
        version: 1,
        hookTemplateId: draft.hookTemplateId,
        hookText: draft.hookText,
        beats: draft.beats,
        fullText: draft.fullText,
        wordCount: draft.wordCount,
        // carry the Visual Director's SHOT CUT (2026-07-19): without it the copy
        // re-ran the director, got a slightly different cut, and the copied
        // stills no longer aligned — so it regenerated them (a pile of Sonnet
        // calls) instead of reusing all N and going straight to the visuals gate.
        directedSequence: draft.directedSequence,
      });
    }
    // Land 3: reuse whatever media survived the halt keep/discard.
    await copyProductionMedia(tx, haltedProductionId, newId);
    await tx.update(ideas).set({ status: "greenlit" }).where(eq(ideas.id, halted.ideaId));
  });
  await inngest.send({ name: "production/greenlit", data: { productionId: newId, attempt: "0" } });
  revalidatePath("/ideas");
  redirect(`/productions/${newId}`);
}

/**
 * "Make a corrected copy" of an ALREADY-PUBLISHED video (2026-07-19 operator:
 * a published Krypton short shipped with a stray real clip and there was no way
 * back in — a published production is intentionally locked). YouTube cannot
 * replace a live video's file, so the fix ships as a NEW upload: this mints a
 * fresh production from the same script + a copy of every shot/clip, so the
 * operator re-animates the bad shot, re-renders, and publishes anew.
 *
 * `deleteOld` (opt-in, default off) records intent to remove the superseded
 * original's live YouTube video once the corrected copy goes live — handled by
 * the worker's supersede-cleanup on `production/published`, NOT here (nothing is
 * deleted until the replacement is actually out).
 */
export async function correctPublishedProductionAction(
  publishedProductionId: string,
  deleteOld: boolean = false,
) {
  const { db } = await getAppContext();
  const [orig] = await db.select().from(productions).where(eq(productions.id, publishedProductionId));
  if (!orig) throw new Error("Production not found");
  if (!["published", "scheduled"].includes(orig.status)) {
    throw new Error(
      `Production is ${orig.status} — "Make a corrected copy" is for a published/scheduled video. Use Retry-from-stage or Resume for one still in production.`,
    );
  }
  const [draft] = await db
    .select()
    .from(scriptDrafts)
    .where(eq(scriptDrafts.productionId, publishedProductionId))
    .orderBy(desc(scriptDrafts.version))
    .limit(1);

  const newId = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(productions).values({
      id: newId,
      ideaId: orig.ideaId,
      channelId: orig.channelId,
      status: "greenlit",
      substanceFingerprint: orig.substanceFingerprint,
      // Carry the approved video's per-video settings so the corrected copy is
      // a faithful re-cut AND doesn't re-spend (2026-07-19): keeping the
      // productionProfile skips the propose-profile-tweaks LLM step, and the
      // audio-mix dials + voice source stay as approved.
      productionProfile: orig.productionProfile,
      voiceSource: orig.voiceSource,
      voiceVolume: orig.voiceVolume,
      musicVolume: orig.musicVolume,
      personaId: orig.personaId,
      personaVersion: orig.personaVersion,
      styleId: orig.styleId,
      styleVersion: orig.styleVersion,
      // provenance + (opt-in) auto-remove the old live upload once this is live
      supersedesProductionId: publishedProductionId,
      supersedeDeleteOld: deleteOld,
    });
    if (draft) {
      await tx.insert(scriptDrafts).values({
        id: ulid(),
        productionId: newId,
        version: 1,
        hookTemplateId: draft.hookTemplateId,
        hookText: draft.hookText,
        beats: draft.beats,
        fullText: draft.fullText,
        wordCount: draft.wordCount,
        // carry the Visual Director's SHOT CUT (2026-07-19): without it the copy
        // re-ran the director, got a slightly different cut, and the copied
        // stills no longer aligned — so it regenerated them (a pile of Sonnet
        // calls) instead of reusing all N and going straight to the visuals gate.
        directedSequence: draft.directedSequence,
      });
    }
    await copyProductionMedia(tx, publishedProductionId, newId);
    await tx.update(ideas).set({ status: "greenlit" }).where(eq(ideas.id, orig.ideaId));
  });
  await inngest.send({ name: "production/greenlit", data: { productionId: newId, attempt: "0" } });
  revalidatePath(`/productions/${publishedProductionId}`);
  redirect(`/productions/${newId}`);
}

/**
 * #27 voice source: TTS (channel voice) vs operator-recorded takes. Only
 * meaningful before the voiceover exists — the pipeline reads it right
 * before the synth step and pends the recording gate when "operator".
 */
export async function setVoiceSourceAction(productionId: string, source: "tts" | "operator") {
  if (source !== "tts" && source !== "operator") throw new Error(`Bad voice source: ${source}`);
  const { db } = await getAppContext();
  await db.update(productions).set({ voiceSource: source }).where(eq(productions.id, productionId));
  revalidatePath(`/productions/${productionId}`);
}

/**
 * Manual audio-mix dials (2026-07-19 operator): per-video linear gain for the
 * two render audio layers — voiceover (0–1.5, default 1.0) and the music bed
 * (0–1, default = the Production Profile "music" axis level). Stored on the
 * production; the render honours them (music override wins over the axis, voice
 * over full-scale), and a change re-renders (the reuse-guard compares levels).
 */
export async function setAudioLevelsAction(
  productionId: string,
  voiceVolume: number,
  musicVolume: number,
): Promise<{ error?: string }> {
  const clamp = (v: number, max: number) =>
    Math.round(Math.max(0, Math.min(max, Number.isFinite(v) ? v : 0)) * 100) / 100;
  const { db } = await getAppContext();
  await db
    .update(productions)
    .set({ voiceVolume: clamp(voiceVolume, 1.5), musicVolume: clamp(musicVolume, 1) })
    .where(eq(productions.id, productionId));
  revalidatePath(`/productions/${productionId}`);
  return {};
}

/**
 * Force-forward a blocked production (BACKLOG #16, semantics fixed per #20):
 * an operator override that waives the soft safety gates (variation + review
 * board) and resumes THE SAME production from where it stopped. No new
 * production is minted and nothing is copied — the existing script, voiceover,
 * images, render and thumbnails stay attached and the pipeline's
 * skip-if-present steps reuse them; only genuinely missing assets are
 * generated. The re-fire carries a fresh `attempt` nonce so Inngest's
 * idempotency (productionId+attempt) lets the run start. Each bypass is
 * recorded as an `operator_override` evidence row for the compliance trail.
 */
export async function forceForwardAction(blockedProductionId: string) {
  const { db } = await getAppContext();
  const [blocked] = await db.select().from(productions).where(eq(productions.id, blockedProductionId));
  if (!blocked) throw new Error("Production not found");
  if (!["on_hold", "failed", "rejected"].includes(blocked.status)) {
    throw new Error(`Production is ${blocked.status} — force-forward only applies to blocked productions`);
  }
  const [draft] = await db
    .select()
    .from(scriptDrafts)
    .where(eq(scriptDrafts.productionId, blockedProductionId))
    .orderBy(desc(scriptDrafts.version))
    .limit(1);
  if (!draft) throw new Error("No script yet — fix the blocking claims or greenlight the idea fresh.");

  await db.transaction(async (tx) => {
    // any stale pending gate is abandoned by the new run
    await tx
      .update(reviewGates)
      .set({ status: "expired" })
      .where(and(eq(reviewGates.productionId, blockedProductionId), eq(reviewGates.status, "pending")));
    await tx
      .update(productions)
      .set({
        status: "greenlit",
        bypassChecks: true,
        failureReason: null,
        currentGateId: null,
        inngestRunId: null,
      })
      .where(eq(productions.id, blockedProductionId));
    await tx.update(ideas).set({ status: "greenlit" }).where(eq(ideas.id, blocked.ideaId));
  });
  await inngest.send({
    name: "production/greenlit",
    data: { productionId: blockedProductionId, attempt: ulid() },
  });
  revalidatePath("/ideas");
  revalidatePath(`/productions/${blockedProductionId}`);
}

/** Stages the operator can retry a stopped production from (BACKLOG #25). */
export type RetryStage = "script" | "visuals" | "render" | "publish";

/**
 * Per-step retry (BACKLOG #25): re-run a failed/on-hold production FROM a
 * stage by deleting that stage's artifacts and re-firing production/greenlit
 * with a fresh attempt nonce — the pipeline's skip-if-present short-circuits
 * reuse everything upstream and regenerate exactly what was wiped.
 *
 * Only DB rows are deleted, never R2 objects (storage is cheap; the janitor
 * owns object cleanup, and a kept row elsewhere may still reference the key).
 * Downstream artifacts of the wiped stage are wiped too — a new script needs
 * a new voiceover/images/render, new images need a new render — otherwise the
 * kept render would short-circuit and the retry would change nothing.
 * Returns { error } instead of throwing (prod server actions redact throws).
 */
export async function retryFromStageAction(
  productionId: string,
  stage: RetryStage,
): Promise<{ error?: string }> {
  const { db } = await getAppContext();
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  // thumbnail_review included (2026-07-12): after swapping images at the
  // final gate, "Retry from render" rebuilds the video with the new set —
  // the pending gate is expired below and a fresh one pends after the render.
  // visuals_review included (2026-07-15): "Regenerate all beat visuals" rebuilds
  // the set from the active style guide + characters right at the visuals gate.
  if (!["failed", "on_hold", "thumbnail_review", "visuals_review"].includes(production.status)) {
    return { error: `Production is ${production.status} — per-stage retry applies to failed/on-hold/review productions` };
  }

  await db.transaction(async (tx) => {
    if (stage === "script") {
      await tx.delete(scriptDrafts).where(eq(scriptDrafts.productionId, productionId));
      // video_clip included (2026-07-16): a clip animates a specific still — if
      // the image is regenerated the old clip is STALE (it moves the deleted
      // image), so it must be dropped and re-made from the fresh still.
      await tx
        .delete(assets)
        .where(
          and(
            eq(assets.productionId, productionId),
            inArray(assets.kind, ["voiceover", "image", "video_clip", "render"]),
          ),
        );
    } else if (stage === "visuals") {
      await tx
        .delete(assets)
        .where(
          and(eq(assets.productionId, productionId), inArray(assets.kind, ["image", "video_clip", "render"])),
        );
    } else if (stage === "render") {
      await tx.delete(assets).where(and(eq(assets.productionId, productionId), eq(assets.kind, "render")));
    }
    // stage "publish": nothing wiped — the publish steps re-run, and the
    // upload idempotency guard adopts any already-uploaded video.
    await tx
      .update(reviewGates)
      .set({ status: "expired" })
      .where(and(eq(reviewGates.productionId, productionId), eq(reviewGates.status, "pending")));
    // Show the stepper at the stage being retried, not back at the start
    // (2026-07-19 operator: "Retry from render kicks us back to scripting"). The
    // pipeline reuses everything upstream and only re-does this stage, so the
    // status should reflect that — a render retry reads as "Assembling", not
    // "Script". The reused steps no longer drag it backward.
    const retryStatus =
      stage === "render" ? "assembling" : stage === "publish" ? "ready" : stage === "visuals" ? "producing_assets" : "greenlit";
    await tx
      .update(productions)
      .set({ status: retryStatus, failureReason: null, currentGateId: null, inngestRunId: null })
      .where(eq(productions.id, productionId));
    await tx.update(ideas).set({ status: "greenlit" }).where(eq(ideas.id, production.ideaId));
  });

  // fresh nonce EVERY click (Inngest idempotency is productionId+attempt) —
  // ulid, not Date.now, per the Inngest determinism rules used elsewhere.
  await inngest.send({
    name: "production/greenlit",
    data: { productionId, attempt: `retry-${stage}-${ulid()}` },
  });
  revalidatePath(`/productions/${productionId}`);
  revalidatePath("/gates");
  return {};
}

/**
 * The single gate-resume path: record the human decision (compliance
 * evidence log) and emit the event the pipeline is waiting on.
 * `scheduledFor` (final gate only) delays the publish until that time.
 */
export async function decideGateAction(
  gateId: string,
  decision: "approved" | "rejected" | "revise",
  notes: string,
  scheduledFor?: string,
  selectedThumbnailId?: string,
  /** profile_review gates (2026-07-12): the operator's per-video profile —
   * the AI proposal as-is or with any axis edited. Validated worker-side. */
  editedProfile?: Record<string, unknown>,
) {
  const { db } = await getAppContext();
  const [gate] = await db.select().from(reviewGates).where(eq(reviewGates.id, gateId));
  if (!gate) throw new Error("Gate not found");
  if (gate.status !== "pending") throw new Error(`Gate already ${gate.status}`);

  // Stale-render guard (2026-07-12 incident: operator swapped images, then
  // accidentally approved — the OLD render would have published, and the
  // swapped-out images' credits were already gone from the asset rows).
  // Approving the final gate is blocked while any image postdates the render.
  if (gate.kind === "thumbnail_review" && decision === "approved") {
    const [renderAsset] = await db
      .select({ createdAt: assets.createdAt })
      .from(assets)
      .where(and(eq(assets.productionId, gate.productionId), eq(assets.kind, "render"), eq(assets.idx, 0)));
    if (renderAsset) {
      // video_clip included (2026-07-14): the render prefers a same-idx clip
      // over the still, so a clip animated AFTER the render is just as stale
      const imageRows = await db
        .select({ updatedAt: assets.updatedAt })
        .from(assets)
        .where(and(eq(assets.productionId, gate.productionId), inArray(assets.kind, ["image", "video_clip"])));
      const stale = imageRows.some(
        (r) => new Date(r.updatedAt).getTime() > new Date(renderAsset.createdAt).getTime() + 1000,
      );
      if (stale) {
        throw new Error(
          "Images were changed AFTER this render — the video would publish without your swaps (and with wrong credits). Use 'Retry from render' to rebuild first (~2 min), then approve the fresh cut.",
        );
      }
    }
  }

  // defense in depth (2026-07-12): only the FINAL gate may move the
  // thumbnail selection — a stray selectedThumbnailId from any other gate
  // kind must never overwrite the operator's pick
  if (selectedThumbnailId && gate.kind === "thumbnail_review") {
    await db
      .update(thumbnails)
      .set({ selected: false })
      .where(eq(thumbnails.productionId, gate.productionId));
    await db
      .update(thumbnails)
      .set({ selected: true })
      .where(eq(thumbnails.id, selectedThumbnailId));
  }

  await db
    .update(reviewGates)
    .set({
      status: "decided",
      decision,
      notes: notes || null,
      decidedBy: operatorName(),
      decidedAt: new Date(),
    })
    .where(eq(reviewGates.id, gateId));

  await inngest.send({
    name: "production/gate.decided",
    data: {
      productionId: gate.productionId,
      gateId,
      kind: gate.kind,
      decision,
      notes,
      ...(scheduledFor ? { scheduledFor: new Date(scheduledFor).toISOString() } : {}),
      ...(selectedThumbnailId ? { selectedThumbnailId } : {}),
      ...(editedProfile ? { editedProfile } : {}),
    },
  });
  revalidatePath("/gates");
  revalidatePath(`/productions/${gate.productionId}`);
}

/**
 * Directly edit the script at the review gate (2026-07-19 operator: "I should
 * be able to edit each segment myself, not only ask the LLM"). Rewrites each
 * beat's spoken text on the live draft — other beat fields (imagePrompt,
 * referenceEntity, visualBrief, type) are preserved, so visuals stay aligned.
 * `fullText`/`wordCount`/`hookText`/`estSec` are recomputed from the edits, and
 * the pipeline re-reads this draft on approval so the changes actually ship.
 * Only while a script_review gate is pending.
 */
export async function saveScriptBeatsAction(
  productionId: string,
  texts: string[],
): Promise<{ error?: string }> {
  const { db } = await getAppContext();
  const [gate] = await db
    .select({ id: reviewGates.id })
    .from(reviewGates)
    .where(
      and(
        eq(reviewGates.productionId, productionId),
        eq(reviewGates.kind, "script_review"),
        eq(reviewGates.status, "pending"),
      ),
    )
    .limit(1);
  if (!gate) return { error: "The script can only be edited while it's in review." };
  const [draft] = await db
    .select()
    .from(scriptDrafts)
    .where(eq(scriptDrafts.productionId, productionId))
    .orderBy(desc(scriptDrafts.version))
    .limit(1);
  if (!draft) return { error: "No script draft to edit." };

  const SPEAKING_WPS = 2.5;
  const oldBeats = draft.beats ?? [];
  if (texts.length !== oldBeats.length) return { error: "Segment count mismatch — reload and try again." };
  const beats = oldBeats.map((b, i) => {
    const text = (texts[i] ?? b.text).trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    return { ...b, text, estSec: Math.max(1, Math.round((words / SPEAKING_WPS) * 10) / 10) };
  });
  if (beats.some((b) => !b.text)) return { error: "A segment is empty — every segment needs text." };
  const fullText = beats.map((b) => b.text).join("\n\n");
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;
  const hookText = beats.find((b) => b.type === "hook")?.text ?? draft.hookText;

  const textChanged = fullText !== draft.fullText;
  await db
    .update(scriptDrafts)
    .set({ beats, fullText, wordCount, hookText })
    .where(eq(scriptDrafts.id, draft.id));
  // A script edit changes the spoken words, so the voiceover + render must
  // rebuild (audio + timing). The STILLS are kept — a reword that keeps the same
  // number of shots still lines up (each image maps to its shot, only the timing
  // shifts), so a small tweak doesn't redraw everything (2026-07-19 operator: a
  // 2-syllable tweak shouldn't recreate all the visuals). The pipeline re-aligns
  // the visuals only if the shot COUNT actually changed (see production-pipeline
  // "align-visuals"); otherwise use "Retry from visuals" to force a redraw.
  if (textChanged) {
    await db
      .delete(assets)
      .where(and(eq(assets.productionId, productionId), inArray(assets.kind, ["voiceover", "render"])));
  }
  revalidatePath(`/productions/${productionId}`);
  return {};
}

/**
 * Retire a video from the Videos list (2026-07-19 operator): archive it —
 * terminal `retired` status, hidden from the active/published lists — WITHOUT
 * touching YouTube. Works on any state (a draft attempt or a live video the
 * operator no longer wants surfaced here). The record is kept for the audit.
 */
export async function retireProductionAction(productionId: string): Promise<{ error?: string }> {
  const { db } = await getAppContext();
  const [p] = await db.select({ channelId: productions.channelId }).from(productions).where(eq(productions.id, productionId));
  if (!p) return { error: "Production not found" };
  await db.update(productions).set({ status: "retired", currentGateId: null }).where(eq(productions.id, productionId));
  revalidatePath(`/channels/${p.channelId}`);
  revalidatePath(`/productions/${productionId}`);
  return {};
}

/**
 * Delete a video: remove the live upload from YouTube (when there is one) AND
 * retire the production (2026-07-19 operator, opted for "remove from YouTube +
 * archive"). Destructive + outward-facing — the caller confirms first. The
 * deletion is idempotent (an already-gone video resolves), and the publication
 * row is kept (status `retired` hides it) so the audit trail survives.
 */
export async function deleteVideoAction(productionId: string): Promise<{ error?: string }> {
  const { db, providers } = await getAppContext();
  const [p] = await db.select({ channelId: productions.channelId }).from(productions).where(eq(productions.id, productionId));
  if (!p) return { error: "Production not found" };
  const [pub] = await db
    .select({ id: publications.id, providerVideoId: publications.providerVideoId })
    .from(publications)
    .where(eq(publications.productionId, productionId))
    .limit(1);
  if (pub?.providerVideoId) {
    try {
      await providers.publish.deleteVideo({ channelId: p.channelId, providerVideoId: pub.providerVideoId });
    } catch (e) {
      return { error: `Couldn't delete on YouTube: ${e instanceof Error ? e.message : String(e)}` };
    }
    await db
      .update(publications)
      .set({ privacyStatus: "private", url: null })
      .where(eq(publications.id, pub.id));
  }
  await db.update(productions).set({ status: "retired", currentGateId: null }).where(eq(productions.id, productionId));
  revalidatePath(`/channels/${p.channelId}`);
  revalidatePath(`/productions/${productionId}`);
  return {};
}

/**
 * "Release" / publish-now click: flip an uploaded video public immediately.
 * Works for legacy private uploads AND natively-scheduled videos (#20) — for
 * the latter it circumvents the schedule (overrides the pending publishAt).
 * Returns { error } instead of throwing so the UI can show the real message
 * (prod server actions redact thrown errors to a digest).
 */
export async function releasePublicationAction(publicationId: string): Promise<{ error?: string }> {
  const { db, providers } = await getAppContext();
  const [pub] = await db.select().from(publications).where(eq(publications.id, publicationId));
  if (!pub) return { error: "Publication not found" };
  if (pub.privacyStatus === "public") return { error: "Already public" };
  if (!pub.providerVideoId) {
    return {
      error:
        "Not uploaded yet — this row was scheduled by the old sleep-based pipeline and uploads at its slot. New scheduled videos upload immediately and can be released early.",
    };
  }
  const [production] = await db
    .select()
    .from(productions)
    .where(eq(productions.id, pub.productionId));
  if (!production) return { error: "Production not found" };

  await providers.publish.release({
    channelId: production.channelId,
    providerVideoId: pub.providerVideoId,
  });
  // A scheduled video going live early still needs its go-live bookkeeping +
  // post-publish events; a legacy private upload already emitted them at
  // upload time (publishedAt was set then).
  await markPublicationLive(db, {
    publicationId,
    productionId: pub.productionId,
    publishedAt: new Date(),
    emitEvents: !pub.publishedAt,
  });
  revalidateSchedulePaths(pub.productionId, production.channelId);
  return {};
}

/** The pages that render the schedule (production page + both calendars). */
function revalidateSchedulePaths(productionId: string, channelId: string) {
  revalidatePath(`/productions/${productionId}`);
  revalidatePath(`/channels/${channelId}`);
  revalidatePath("/");
}

// ── Operator visual controls (2026-07-12): thumbnails + per-image swap ────

/**
 * Regenerate thumbnail candidates on demand: the operator's own prompt (or
 * the built defaults when empty) on the standard or premium image model.
 * New candidates append to the existing set at the final gate.
 */
export async function regenerateThumbnailsAction(
  productionId: string,
  opts: { prompt?: string; model: "standard" | "hero" },
): Promise<{ error?: string; added?: number }> {
  const { db, providers, costSink } = await getAppContext();
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, production.ideaId));
  const [channel] = await db.select().from(channels).where(eq(channels.id, production.channelId));
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  if (!idea || !channel) return { error: "Idea or channel not found" };
  const isLong = channel.contentFormat === "long";

  const operatorPrompt = opts.prompt?.trim();
  const prompts: string[] = operatorPrompt
    ? [operatorPrompt, `${operatorPrompt} — alternative composition, different angle and framing`]
    : [
        ...buildThumbnailPrompts({
          title: idea.title,
          angle: idea.angle,
          style: dna?.visualStyle?.imageStyle ?? "clean flat illustration, high contrast",
          spec: dna?.thumbnailSpec ?? null,
          isLong,
        }),
      ];

  let added = 0;
  try {
    for (const prompt of prompts) {
      const img = await providers.media.generateImage({
        prompt,
        aspect: isLong ? "16:9" : "9:16",
        channelId: production.channelId,
        productionId,
        storageKeyBase: `productions/${productionId}/thumb-op-${ulid().toLowerCase()}`,
        quality: opts.model === "hero" ? "hero" : undefined,
        // fal retired (2026-07-14): route per the channel profile
        engine: imageEngineFor(
          resolveProductionProfile(dna?.productionProfile ?? null),
          opts.model === "hero" ? "hero" : "standard",
        ),
        // on failure, degrade down the Style-tab engines only (not a hardcoded qwen)
        fallbackEngines: imageEnginePreference(
          resolveProductionProfile(dna?.productionProfile ?? null),
          "thumbnail",
        ),
      });
      let ctr: number | null = null;
      try {
        const score = await scoreThumbnailFromPrompt(
          { db, llm: providers.llm, costSink, channelId: production.channelId, productionId },
          prompt,
        );
        ctr = score.predictedCtr;
      } catch {
        // scoring is advisory — an unscored candidate still shows up
      }
      await db.insert(thumbnails).values({
        id: ulid(),
        productionId,
        storageKey: img.storageKey,
        predictedCtr: ctr,
      });
      added++;
    }
  } catch (err) {
    if (added === 0) {
      return { error: `Generation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  revalidatePath(`/productions/${productionId}`);
  return { added };
}

/** Load the channel's active distilled style block (guarded like the pipeline). */
/**
 * The channel's ACTIVE distilled style, resolved the same way the pipeline does
 * (production-pipeline.ts §2): the prompt block, the example-image ref keys that
 * drive image-to-image conditioning (doc.refIds → enabled visualStyleRefs), and
 * the conditioning scope/strength. Studio Generate uses this to condition on the
 * channel look by default — matching the auto-generated thumbnails.
 */
/**
 * Hero image work requests nano-banana (Gemini). If the result was served by a
 * DIFFERENT engine, Gemini failed and the factory silently degraded (e.g. out
 * of prepaid credits) — the operator MUST know, else an off-model image reads
 * as a "prompt/model bug" (2026-07-15 incident). Returns a warning or null.
 */
function engineFallbackWarning(engine: string | undefined): string | null {
  if (!engine || engine === "gemini") return null;
  return `Served by ${engine}, not Nano Banana — Gemini was unavailable (often depleted API credits/billing). Character & style fidelity will be off until Gemini is restored; check /api/diag/media.`;
}

/** best-effort MIME from a storage key's extension (stores don't persist one). */
function mimeFromKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "svg" ? "image/svg+xml" : "image/png";
}

type ActiveStyle = {
  block: string | null;
  refKeys: string[];
  conditioning: ReturnType<typeof resolveConditioning>;
  styleId: string | null;
};
async function activeStyleFor(db: Db, channelId: string): Promise<ActiveStyle> {
  const empty: ActiveStyle = { block: null, refKeys: [], conditioning: resolveConditioning(null), styleId: null };
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  if (!dna?.activeStyleId) return empty;
  const [style] = await db.select().from(visualStyles).where(eq(visualStyles.id, dna.activeStyleId));
  if (!style || style.status !== "active") return empty;
  const refs = await db
    .select({ id: visualStyleRefs.id, storageKey: visualStyleRefs.storageKey, enabled: visualStyleRefs.enabled })
    .from(visualStyleRefs)
    .where(eq(visualStyleRefs.channelId, channelId));
  const byId = new Map(refs.filter((r) => r.enabled).map((r) => [r.id, r.storageKey]));
  const refKeys = (style.doc.refIds ?? []).map((id) => byId.get(id)).filter((k): k is string => Boolean(k));
  return { block: styleBlockForImagePrompts(style.doc), refKeys, conditioning: resolveConditioning(style.doc), styleId: style.id };
}

/**
 * Thumbnail studio (2026-07-15): generate one candidate from a chosen
 * best-practice FORMAT + optional title text + a character/scene reference,
 * composed by the same pure function the dialog previews. Hero engine
 * (nano-banana); a cast character rides its sheet in the reference slot.
 */
export async function generateThumbnailStudioAction(
  productionId: string,
  opts: {
    format: string;
    includeTitle?: boolean;
    titleText?: string;
    characterId?: string;
    sceneId?: string;
    extra?: string;
  },
): Promise<{ error?: string; added?: number; warning?: string }> {
  const { db, providers, costSink } = await getAppContext();
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, production.ideaId));
  const [channel] = await db.select().from(channels).where(eq(channels.id, production.channelId));
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  if (!idea || !channel) return { error: "Idea or channel not found" };
  const isLong = channel.contentFormat === "long";

  // the channel's active distilled style — its example images condition the
  // thumbnail by default (matching the auto-generated ones), and its block
  // rides the prompt text
  const style = await activeStyleFor(db, production.channelId);
  const styleConditions = style.conditioning.scope !== "off" && style.refKeys.length > 0;
  // deterministic ref rotation (no Math.random): rotate by how many thumbnails
  // already exist for this production, so successive Generates vary the ref
  const existing = await db.select({ id: thumbnails.id }).from(thumbnails).where(eq(thumbnails.productionId, productionId));
  const styleRefKey = styleConditions ? styleRefKeyForIndex(style.refKeys, existing.length) : undefined;
  const styleRefUrl = styleRefKey
    ? await referenceUrlFor(providers.store, styleRefKey, mimeFromKey(styleRefKey)).catch(() => null)
    : null;

  // one primary reference slot; a style ref conditions by default and, when a
  // character takes the primary slot for identity, rides as an EXTRA (palette)
  let character: { name: string; description: string } | null = null;
  let referenceImageUrl: string | undefined;
  let referenceStrength: number | undefined;
  let sceneRef = false;
  let refLabel: string | null = null;
  let servedStyleRef: string | null = null;
  if (opts.characterId) {
    const [row] = await db
      .select()
      .from(channelCharacters)
      .where(and(eq(channelCharacters.id, opts.characterId), eq(channelCharacters.channelId, production.channelId)));
    if (!row) return { error: "Character not found on this channel" };
    character = { name: row.name, description: row.description };
    // a missing/unfetchable sheet must not kill generation — the canonical
    // description still anchors identity in the prompt
    const ref = await referenceUrlFor(providers.store, row.imageKey, row.mimeType).catch(() => null);
    if (ref) referenceImageUrl = ref;
    refLabel = `character:${row.name}`;
    // the character sheet is the SOLE reference image — mirrors the Style
    // section's proven injection. Do NOT attach a style example as a second
    // image: those examples are 3D-rendered scenes and nano-banana blends
    // toward them, dragging the character off-model (operator-reported "3D
    // background"). The channel look rides as TEXT via style.block instead.
  } else if (opts.sceneId) {
    const [scene] = await db
      .select()
      .from(styleTestScenes)
      .where(and(eq(styleTestScenes.id, opts.sceneId), eq(styleTestScenes.channelId, production.channelId)));
    if (!scene) return { error: "Style scene not found on this channel" };
    const ref = await referenceUrlFor(providers.store, scene.imageKey, scene.mimeType).catch(() => null);
    if (ref) referenceImageUrl = ref;
    sceneRef = true;
    refLabel = "scene";
  } else if (styleRefUrl) {
    // default: condition on the distilled style's example image (palette/look),
    // exactly like the pipeline's auto thumbnails
    referenceImageUrl = styleRefUrl;
    referenceStrength = style.conditioning.strength;
    sceneRef = true; // adds the "reference is palette/mood/style only" clause
    refLabel = "style";
    servedStyleRef = styleRefKey ?? null;
  }

  const prompt = composeThumbnailPrompt({
    title: idea.title,
    angle: idea.angle,
    isLong,
    format: opts.format,
    includeTitle: opts.includeTitle ?? true,
    titleText: opts.titleText ?? null,
    character,
    sceneRef,
    styleBlock: style.block,
    imageStyle: dna?.visualStyle?.imageStyle ?? null,
    extra: opts.extra ?? null,
  });

  try {
    const img = await providers.media.generateImage({
      prompt,
      aspect: isLong ? "16:9" : "9:16",
      channelId: production.channelId,
      productionId,
      storageKeyBase: `productions/${productionId}/thumb-studio-${ulid().toLowerCase()}`,
      quality: "hero",
      engine: "nano-banana", // thumbnails are hero-tier; nano composes references
      // if nano fails, degrade to the channel's Style-tab engines (not qwen)
      fallbackEngines: imageEnginePreference(
        resolveProductionProfile(dna?.productionProfile ?? null),
        "thumbnail",
      ),
      ...(referenceImageUrl ? { referenceImageUrl } : {}),
      ...(referenceStrength !== undefined ? { referenceStrength } : {}),
    });
    let ctr: number | null = null;
    try {
      const score = await scoreThumbnailFromPrompt(
        { db, llm: providers.llm, costSink, channelId: production.channelId, productionId },
        prompt,
      );
      ctr = score.predictedCtr;
    } catch {
      // advisory
    }
    await db.insert(thumbnails).values({
      id: ulid(),
      productionId,
      storageKey: img.storageKey,
      predictedCtr: ctr,
      meta: {
        prompt,
        format: opts.format,
        ...(refLabel ? { reference: refLabel } : {}),
        ...(servedStyleRef ? { styleRef: servedStyleRef, styleId: style.styleId } : {}),
      },
    });
    revalidatePath(`/productions/${productionId}`);
    return { added: 1, ...(engineFallbackWarning(img.engine) ? { warning: engineFallbackWarning(img.engine)! } : {}) };
  } catch (err) {
    return { error: `Generation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Refine a chosen thumbnail (2026-07-15): edit the existing candidate with
 * small changes — the current thumbnail is the primary reference, an optional
 * character rides as a second reference. Adds a NEW candidate so the operator
 * compares rather than losing the original.
 */
export async function refineThumbnailAction(
  productionId: string,
  thumbnailId: string,
  opts: { changes: string; characterId?: string },
): Promise<{ error?: string; added?: number; warning?: string }> {
  const changes = opts.changes?.trim();
  if (!changes) return { error: "Describe what to change first" };
  const { db, providers, costSink } = await getAppContext();
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  const [thumb] = await db
    .select()
    .from(thumbnails)
    .where(and(eq(thumbnails.id, thumbnailId), eq(thumbnails.productionId, productionId)));
  if (!thumb) return { error: "Thumbnail not found" };
  const [channel] = await db.select().from(channels).where(eq(channels.id, production.channelId));
  const isLong = channel?.contentFormat === "long";

  // thumbnails don't store a mime — infer from the key extension
  const ext = thumb.storageKey.split(".").pop()?.toLowerCase() ?? "";
  const thumbMime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  const primaryRef = await referenceUrlFor(providers.store, thumb.storageKey, thumbMime).catch(() => null);
  if (!primaryRef) return { error: "This thumbnail can't be used as an edit reference here" };

  let character: { name: string; description: string } | null = null;
  const extraRefs: string[] = [];
  if (opts.characterId) {
    const [row] = await db
      .select()
      .from(channelCharacters)
      .where(and(eq(channelCharacters.id, opts.characterId), eq(channelCharacters.channelId, production.channelId)));
    if (row) {
      character = { name: row.name, description: row.description };
      const ref = await referenceUrlFor(providers.store, row.imageKey, row.mimeType).catch(() => null);
      if (ref) extraRefs.push(ref);
    }
  }

  const prompt = composeThumbnailRefinePrompt(changes, character);
  try {
    const img = await providers.media.generateImage({
      prompt,
      aspect: isLong ? "16:9" : "9:16",
      channelId: production.channelId,
      productionId,
      storageKeyBase: `productions/${productionId}/thumb-refine-${ulid().toLowerCase()}`,
      quality: "hero",
      engine: "nano-banana",
      referenceImageUrl: primaryRef,
      ...(extraRefs.length ? { extraReferenceImageUrls: extraRefs } : {}),
    });
    let ctr: number | null = null;
    try {
      const score = await scoreThumbnailFromPrompt(
        { db, llm: providers.llm, costSink, channelId: production.channelId, productionId },
        prompt,
      );
      ctr = score.predictedCtr;
    } catch {
      // advisory
    }
    await db.insert(thumbnails).values({
      id: ulid(),
      productionId,
      storageKey: img.storageKey,
      predictedCtr: ctr,
      meta: { prompt, refinedFrom: thumbnailId },
    });
    revalidatePath(`/productions/${productionId}`);
    return { added: 1, ...(engineFallbackWarning(img.engine) ? { warning: engineFallbackWarning(img.engine)! } : {}) };
  } catch (err) {
    return { error: `Refine failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Re-derive ONE shot's generation prompt from its OWN narration (2026-07-15).
 * The stored prompt can be a beat brief that leaked onto the wrong shot (a
 * museums-narration frame that reads "welder"); on a plain Regenerate we rebuild
 * the prompt from this shot's narration slice with NO conflicting beat brief, so
 * the new image matches what's being said. Character is left to the caller's
 * character branch. Returns null on any trouble (caller falls back to stored).
 */
async function rederivePromptFromNarration(
  db: Db,
  llm: Awaited<ReturnType<typeof getAppContext>>["providers"]["llm"],
  costSink: Awaited<ReturnType<typeof getAppContext>>["costSink"],
  production: typeof productions.$inferSelect,
  channel: typeof channels.$inferSelect,
  idx: number,
  isLong: boolean,
): Promise<string | null> {
  const plan = await deriveShotPlan(db, production.id);
  const shot = plan?.shots[idx];
  if (!shot) return null;
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  const style = await activeStyleFor(db, production.channelId);
  const artDirection = resolveProductionProfile(production.productionProfile ?? dna?.productionProfile ?? null, {
    contentFormat: channel.contentFormat,
  }).artDirection;
  const built = await buildImagePrompts(
    { db, llm, costSink, channelId: production.channelId, productionId: production.id },
    {
      // narration is the ONLY driver — no beat brief to leak the wrong subject
      shots: [{ text: shot.text, imagePrompt: shot.text, referenceEntity: shot.referenceEntity, visualBrief: null }],
      imageStyle: dna?.visualStyle?.imageStyle ?? "clean flat illustration, high contrast",
      artDirection: artDirection ?? null,
      orientation: isLong ? "landscape" : "portrait",
      niche: channel.niche,
      styleBlock: style.block,
    },
  );
  return built[0]?.prompt ?? null;
}

/**
 * Regenerate ONE shot's generation prompt via the prompt-scripting agent, using
 * the DIRECTOR'S full instructions for the shot (visual brief, framing, intent,
 * motif, reference entity, casting) — the same rich input the pipeline feeds
 * buildImagePrompts. 2026-07-16 operator: when a shot's auto prompt came out
 * thin (its build batch failed), push THIS one shot through the agent again from
 * the edit pane. The new prompt is returned for review — it isn't stored until
 * the operator Regenerates the image with it.
 */
export async function regenerateShotPromptAction(
  productionId: string,
  assetId: string,
  opts: { persist?: boolean } = {},
): Promise<{ prompt?: string; error?: string }> {
  const { db, providers, costSink } = await getAppContext();
  const [asset] = await db
    .select({ idx: assets.idx, meta: assets.meta })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.productionId, productionId), eq(assets.kind, "image")));
  if (!asset) return { error: "Image not found" };
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  const [channel] = await db.select().from(channels).where(eq(channels.id, production.channelId));
  if (!channel) return { error: "Channel not found" };
  const plan = await deriveShotPlan(db, productionId);
  const shot = plan?.shots[asset.idx];
  if (!shot) return { error: "This shot isn't in the current plan — regenerate the image set first" };

  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  const style = await activeStyleFor(db, production.channelId);
  const profile = resolveProductionProfile(production.productionProfile ?? dna?.productionProfile ?? null, {
    contentFormat: channel.contentFormat,
  });
  const isLong = channel.contentFormat === "long";
  const chars = await db
    .select()
    .from(channelCharacters)
    .where(eq(channelCharacters.channelId, production.channelId));
  try {
    const built = await buildImagePrompts(
      { db, llm: providers.llm, costSink, channelId: production.channelId, productionId },
      {
        // the DIRECTOR'S full instruction set for this shot — same fields the
        // pipeline passes, so the retry matches the "great" prompts it wrote
        shots: [
          {
            text: shot.text,
            imagePrompt: shot.imagePrompt,
            referenceEntity: shot.referenceEntity,
            visualBrief: shot.visualBrief,
            shotScale: shot.shotScale,
            angle: shot.angle,
            intent: shot.intent,
            motif: shot.motif,
          },
        ],
        imageStyle: dna?.visualStyle?.imageStyle ?? "clean flat illustration, high contrast",
        artDirection: profile.artDirection ?? null,
        orientation: isLong ? "landscape" : "portrait",
        niche: channel.niche,
        styleBlock: style.block,
        characters: chars
          .filter((c) => c.castMode !== "off")
          .map((c) => ({ name: c.name, description: c.description, role: c.role, castMode: c.castMode })),
        // one operator-triggered call — worth the frontier model for reliability
        tier: "frontier",
      },
    );
    const prompt = built[0]?.prompt;
    if (!prompt) return { error: "The prompt agent returned nothing — try again" };
    // buildImagePrompts falls back to the raw brief when the model call failed;
    // that draft has NO Style/Mood suffix. Detecting it lets us tell the operator
    // "it didn't elaborate, retry" instead of silently showing a thin prompt.
    const draft = shot.visualBrief ?? shot.imagePrompt;
    if (prompt.trim() === (draft ?? "").trim()) {
      return { error: "The prompt agent couldn't elaborate this shot just now — try Regenerate prompt again." };
    }
    // inline "Prompt" button persists so the next image Regenerate uses it and
    // the storyboard reflects it; the dialog omits persist (just fills the box).
    if (opts.persist) {
      const m = (asset.meta ?? {}) as Record<string, unknown>;
      await db.update(assets).set({ meta: { ...m, prompt } }).where(eq(assets.id, assetId));
      revalidatePath(`/productions/${productionId}`);
    }
    return { prompt };
  } catch (err) {
    return { error: `Prompt generation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Persist an operator's inline-edited generation prompt onto the shot (the
 * editable prompt under the narration in the storyboard). No revalidate — the
 * grid already shows the edit locally; forcing a refresh on every blur would
 * reload the page mid-edit. The next regenerate/refresh reads it from the DB.
 */
export async function saveShotPromptAction(
  productionId: string,
  assetId: string,
  prompt: string,
): Promise<{ error?: string; ok?: boolean }> {
  const { db } = await getAppContext();
  const [asset] = await db
    .select({ meta: assets.meta })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.productionId, productionId), eq(assets.kind, "image")));
  if (!asset) return { error: "Image not found" };
  const m = (asset.meta ?? {}) as Record<string, unknown>;
  await db.update(assets).set({ meta: { ...m, prompt: prompt.trim() } }).where(eq(assets.id, assetId));
  return { ok: true };
}

/**
 * A generation prompt is "thin" when it never got elaborated — a properly built
 * prompt always carries the "Style: … Mood: …" consistency suffix, whereas a
 * fallback draft (the raw scene brief) has neither token. (2026-07-16)
 */
function isThinPrompt(p: string | null | undefined): boolean {
  if (!p || !p.trim()) return true;
  return !/style\s*:/i.test(p) && !/mood\s*:/i.test(p);
}

/**
 * Batch-fill every GENERATED shot whose prompt never got filled out (fell back
 * to a thin brief). Re-runs the prompt-scripting agent with each shot's director
 * instructions and writes the elaborated prompt back onto the asset — so the
 * storyboard + swap dialog show it and the next Regenerate uses it. Prompts
 * only: images are left as-is (regenerate the affected shots, or Regenerate all
 * beat visuals, to redraw them). Archival (real) images are skipped.
 */
export async function fillThinPromptsAction(
  productionId: string,
): Promise<{ filled?: number; thin?: number; error?: string }> {
  const { db, providers, costSink } = await getAppContext();
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  const [channel] = await db.select().from(channels).where(eq(channels.id, production.channelId));
  if (!channel) return { error: "Channel not found" };
  const plan = await deriveShotPlan(db, productionId);
  if (!plan) return { error: "No shot plan yet — add a voiceover first" };

  const imgs = await db
    .select()
    .from(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")));
  const thin = imgs.filter((a) => {
    const m = (a.meta ?? {}) as Record<string, unknown>;
    if (typeof m.source === "string" && m.source) return false; // archival — no prompt
    return isThinPrompt(typeof m.prompt === "string" ? m.prompt : null);
  });
  if (thin.length === 0) return { filled: 0, thin: 0 };

  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  const style = await activeStyleFor(db, production.channelId);
  const profile = resolveProductionProfile(production.productionProfile ?? dna?.productionProfile ?? null, {
    contentFormat: channel.contentFormat,
  });
  const isLong = channel.contentFormat === "long";
  const chars = await db
    .select()
    .from(channelCharacters)
    .where(eq(channelCharacters.channelId, production.channelId));

  try {
    // one batched pass over all thin shots (buildImagePrompts batches 8 + split-retries)
    const built = await buildImagePrompts(
      { db, llm: providers.llm, costSink, channelId: production.channelId, productionId },
      {
        shots: thin.map((a) => {
          const shot = plan.shots[a.idx];
          return {
            text: shot?.text ?? "",
            imagePrompt: shot?.imagePrompt ?? "",
            referenceEntity: shot?.referenceEntity ?? null,
            visualBrief: shot?.visualBrief ?? null,
            shotScale: shot?.shotScale ?? null,
            angle: shot?.angle ?? null,
            intent: shot?.intent ?? null,
            motif: shot?.motif ?? null,
          };
        }),
        imageStyle: dna?.visualStyle?.imageStyle ?? "clean flat illustration, high contrast",
        artDirection: profile.artDirection ?? null,
        orientation: isLong ? "landscape" : "portrait",
        niche: channel.niche,
        styleBlock: style.block,
        characters: chars
          .filter((c) => c.castMode !== "off")
          .map((c) => ({ name: c.name, description: c.description, role: c.role, castMode: c.castMode })),
      },
    );

    let filled = 0;
    for (let i = 0; i < thin.length; i++) {
      const newPrompt = built[i]?.prompt;
      const shot = plan.shots[thin[i]!.idx];
      const draft = (shot?.visualBrief ?? shot?.imagePrompt ?? "").trim();
      // only persist a genuine elaboration (skip any that still fell back)
      if (!newPrompt || isThinPrompt(newPrompt) || newPrompt.trim() === draft) continue;
      const m = (thin[i]!.meta ?? {}) as Record<string, unknown>;
      await db.update(assets).set({ meta: { ...m, prompt: newPrompt } }).where(eq(assets.id, thin[i]!.id));
      filled++;
    }
    revalidatePath(`/productions/${productionId}`);
    return { filled, thin: thin.length };
  } catch (err) {
    return { error: `Prompt generation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Swap ONE shot image in place (2026-07-12 operator ask): find a different
 * real archival photo (skipping every source already used in this
 * production), or regenerate on the standard/premium model with an optional
 * operator prompt. The asset row is updated in place — after swapping, use
 * "Retry from render" to rebuild the video with the new set.
 */
export async function swapShotImageAction(
  productionId: string,
  assetId: string,
  mode: "real" | "standard" | "hero",
  opts: {
    prompt?: string;
    /** regenerate USING the current image as a reference (nano /edit, flux
     * /image-to-image) — keeps the composition, reworks the content */
    useReference?: boolean;
    /** 2026-07-14: cast a channel character — its canonical description leads
     * the prompt and its reference sheet takes the reference slot (identity
     * wins; mutually exclusive with useReference) */
    characterId?: string;
    /** 2026-07-16: operator's explicit model pick from the Regenerate dropdown
     * (nano-banana | qwen | seedream). Overrides the profile-derived engine;
     * nano-banana implies hero quality. Ignored for mode "real". */
    engine?: "nano-banana" | "qwen" | "seedream";
  } = {},
): Promise<{ error?: string; clipRemoved?: boolean; storageKey?: string }> {
  const { prompt, useReference, characterId } = opts;
  const { db, providers, costSink } = await getAppContext();
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.productionId, productionId), eq(assets.kind, "image")));
  if (!asset) return { error: "Image not found" };
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  const [channel] = production
    ? await db.select().from(channels).where(eq(channels.id, production.channelId))
    : [];
  if (!production || !channel) return { error: "Production or channel not found" };
  const isLong = channel.contentFormat === "long";
  const meta = (asset.meta ?? {}) as Record<string, unknown>;
  let newStorageKey: string | undefined; // returned so the client updates the thumbnail without a refresh

  if (mode === "real") {
    const query =
      (typeof meta.entity === "string" && meta.entity) ||
      (typeof meta.topic === "string" && meta.topic) ||
      (typeof meta.draftPrompt === "string" && meta.draftPrompt) ||
      null;
    if (!query) return { error: "This shot has no subject to search the archives for — regenerate instead" };
    if (!providers.reference.findEntityImages) {
      return { error: "The configured reference provider can't list candidates" };
    }
    const siblings = await db
      .select({ meta: assets.meta })
      .from(assets)
      .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")));
    const used = new Set(
      siblings
        .map((s) => (s.meta as Record<string, unknown> | null)?.source)
        .filter((x): x is string => typeof x === "string"),
    );
    // random idx block: candidate files must never collide with the
    // pipeline's ref-{idx*100+n} keys OR a previous swap's (re-swapping the
    // same shot would otherwise overwrite the currently-chosen file)
    const swapIdx = 100_000 + Math.floor(Math.random() * 800_000);
    const hint =
      (typeof meta.prompt === "string" && meta.prompt) ||
      (typeof meta.draftPrompt === "string" && meta.draftPrompt) ||
      undefined;
    const cands = await providers.reference.findEntityImages({
      entity: query.slice(0, 120),
      channelId: production.channelId,
      productionId,
      idx: swapIdx,
      limit: 16,
      ...(hint ? { hint: hint.slice(0, 60) } : {}),
    });
    const fresh = cands.find((c) => !used.has(c.sourceUrl));
    if (!fresh) {
      return { error: "No unused archival photo found for this subject — try a regenerate instead" };
    }
    await db
      .update(assets)
      .set({
        storageKey: fresh.storageKey,
        mimeType: fresh.mimeType,
        meta: {
          ...(typeof meta.entity === "string" ? { entity: meta.entity } : {}),
          // narration belongs to the SHOT, not the image — survives every swap
          ...(typeof meta.narration === "string" ? { narration: meta.narration } : {}),
          source: fresh.sourceUrl,
          license: fresh.license,
          attribution: fresh.attribution,
          operatorSwap: "real",
        },
      })
      .where(eq(assets.id, assetId));
    newStorageKey = fresh.storageKey;
  } else {
    // Prompt priority (2026-07-15): an operator-typed prompt wins; else RE-DERIVE
    // from THIS shot's narration (the stored meta.prompt may be a beat brief that
    // leaked onto the wrong shot — welding on a museums frame); the stored prompt
    // is only the last resort.
    let genPrompt: string | null = prompt?.trim() || null;
    if (!genPrompt) {
      genPrompt = await rederivePromptFromNarration(
        db,
        providers.llm,
        costSink,
        production,
        channel,
        asset.idx,
        isLong,
      ).catch(() => null);
    }
    if (!genPrompt) {
      genPrompt =
        (typeof meta.prompt === "string" && meta.prompt) ||
        (typeof meta.draftPrompt === "string" && meta.draftPrompt) ||
        null;
    }
    let finalPrompt = genPrompt;
    let referenceImageUrl: string | undefined;
    let referenceStrength: number | undefined;
    let castCharacter: { id: string; name: string } | null = null;
    if (characterId) {
      // 2026-07-14: character casting — canonical description leads the
      // prompt, reference sheet takes the reference slot (identity wins),
      // exactly the pipeline's conditioning.
      const [character] = await db
        .select()
        .from(channelCharacters)
        .where(and(eq(channelCharacters.id, characterId), eq(channelCharacters.channelId, production.channelId)));
      if (!character) return { error: "Character not found on this channel" };
      finalPrompt = genPrompt ? `${character.description} — ${genPrompt}` : null;
      if (!finalPrompt) return { error: "No prompt available — type one to regenerate this image" };
      // Reference-sheet conditioning is best-effort: a missing/broken character
      // image key (or a store without presign) must NOT throw the whole action —
      // that surfaced as a silent "nothing happened" on the inline Image button
      // (2026-07-17). Degrade to the text description leading the prompt.
      if (providers.store.presignGet && !character.mimeType.includes("svg")) {
        try {
          referenceImageUrl = await providers.store.presignGet(character.imageKey, 900);
          referenceStrength = 0.55;
        } catch (err) {
          console.warn(
            `[swap] character "${character.name}" reference sheet could not be presigned (${character.imageKey}) — regenerating on the description only:`,
            err,
          );
        }
      }
      castCharacter = { id: character.id, name: character.name };
    } else if (useReference) {
      if (!providers.store.presignGet) {
        return { error: "Reference mode needs the S3/R2 store (presigned URLs) — not available here" };
      }
      // short-lived URL: the vendor fetches it once during the generation call
      referenceImageUrl = await providers.store.presignGet(asset.storageKey, 900);
    }
    if (!finalPrompt) return { error: "No prompt available — type one to regenerate this image" };
    let img: { storageKey: string; mimeType: string };
    try {
      const [swapDna] = await db
        .select()
        .from(channelDna)
        .where(eq(channelDna.channelId, production.channelId));
      img = await providers.media.generateImage({
        prompt: finalPrompt,
        aspect: isLong ? "16:9" : "9:16",
        channelId: production.channelId,
        productionId,
        storageKeyBase: `productions/${productionId}/swap-${asset.idx}-${ulid().toLowerCase()}`,
        // operator's dropdown pick wins; nano-banana implies hero quality.
        // Otherwise fall back to the profile-derived engine + mode quality.
        quality: opts.engine
          ? opts.engine === "nano-banana"
            ? "hero"
            : undefined
          : mode === "hero"
            ? "hero"
            : undefined,
        // fal retired (2026-07-14): route per the channel profile
        engine:
          opts.engine ??
          imageEngineFor(
            resolveProductionProfile(swapDna?.productionProfile ?? null),
            mode === "hero" ? "hero" : "standard",
          ),
        // on failure, degrade down the Style-tab engines only (not a hardcoded qwen)
        fallbackEngines: imageEnginePreference(
          resolveProductionProfile(swapDna?.productionProfile ?? null),
          castCharacter ? "character" : mode === "hero" ? "hero" : "bulk",
        ),
        ...(referenceImageUrl ? { referenceImageUrl } : {}),
        ...(referenceStrength != null ? { referenceStrength } : {}),
      });
    } catch (err) {
      return { error: `Generation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Derivative credit (licence compliance): regenerating WITH a licensed
    // real photo as reference produces a derivative — its source/licence/
    // attribution stay on the asset so the description credits it. PD/CC0
    // sources need no carry-over.
    const isLicensedSource =
      useReference &&
      typeof meta.source === "string" &&
      typeof meta.license === "string" &&
      /cc[- ]?by/i.test(meta.license);
    await db
      .update(assets)
      .set({
        storageKey: img.storageKey,
        mimeType: img.mimeType,
        meta: {
          prompt: finalPrompt,
          // carry-forward fix (2026-07-14): regenerates used to strip these,
          // losing the builder draft and subject for later swaps
          ...(typeof meta.draftPrompt === "string" ? { draftPrompt: meta.draftPrompt } : {}),
          ...(typeof meta.entity === "string" ? { entity: meta.entity } : {}),
          ...(typeof meta.narration === "string" ? { narration: meta.narration } : {}),
          ...(castCharacter ? { character: castCharacter.name, characterId: castCharacter.id } : {}),
          ...(mode === "hero" ? { hero: true } : {}),
          operatorSwap: mode,
          ...(isLicensedSource
            ? {
                source: meta.source,
                license: `${meta.license} (derivative)`,
                attribution: typeof meta.attribution === "string" ? meta.attribution : "",
                derived: true,
              }
            : {}),
        },
      })
      .where(eq(assets.id, assetId));
    newStorageKey = img.storageKey;
  }
  // 2026-07-14 (operator decision): a video clip derives from its shot's
  // image, and the render prefers the clip — a clip left behind after a swap
  // would silently override the new image. Delete it; the shot falls back to
  // the still until the operator hits Animate again.
  const staleClip = await db
    .delete(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip"), eq(assets.idx, asset.idx)))
    .returning({ id: assets.id });
  revalidatePath(`/productions/${productionId}`);
  return {
    ...(staleClip.length ? { clipRemoved: true } : {}),
    ...(newStorageKey ? { storageKey: newStorageKey } : {}),
  };
}

/**
 * "Animate this shot" (2026-07-14 operator ask): queue an image→video clip
 * for ONE shot from the swap dialog. The vendors poll for minutes, so this
 * only validates + fires the worker event (style-distill pattern) and
 * returns instantly — the clip appears in the visuals section when done and
 * the render will prefer it over the still.
 */
export async function generateShotClipAction(
  productionId: string,
  assetId: string,
  opts: { prompt?: string; engine?: string } = {},
): Promise<{ queued?: boolean; reqToken?: string; durationSec?: number; error?: string }> {
  const { db } = await getAppContext();
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.productionId, productionId), eq(assets.kind, "image")));
  if (!asset) return { error: "Image not found" };
  const plan = await deriveShotPlan(db, productionId);
  if (!plan) return { error: "This production has no voiceover yet — shots can't be timed for a clip" };
  const shot = plan.shots[asset.idx];
  if (!shot) return { error: "This shot isn't in the current shot plan — regenerate the image set first" };
  const beatLen = shot.endSec - shot.startSec;
  if (beatLen > MAX_CLIP_SEC() + 0.5) {
    return {
      error: `This shot runs ~${Math.round(beatLen)}s — over the ${MAX_CLIP_SEC()}s clip cap, it would freeze mid-beat. Longer shots keep their Ken Burns still.`,
    };
  }
  const prompt = opts.prompt?.trim() || undefined;
  const engine = opts.engine?.trim() || undefined;
  // 2026-07-17: EACH explicit Animate click must run — the old dedupe keyed on
  // (image updatedAt + engine + prompt), so re-clicking the SAME shot with the
  // same image/engine was silently dropped by Inngest idempotency ("ran it
  // several times, nothing changed"). The cockpit already blocks double-fires
  // (the button disables while queued/animating), so a unique key per click is
  // safe and makes retries actually retry.
  // `dedupe` doubles as the unique REQUEST TOKEN: the worker stamps it on the
  // clip's meta (and on any failure ledger row), so the poller confirms THIS
  // animate finished by an exact token match — no timestamp/clock guessing
  // (2026-07-17: fixed both stuck "Animating…" and false "done").
  const dedupe = `${productionId}:${asset.idx}:${engine ?? ""}:${Date.now()}`;
  await inngest.send({
    name: "production/clip.requested",
    data: { productionId, idx: asset.idx, ...(prompt ? { prompt } : {}), ...(engine ? { engine } : {}), dedupe },
  });
  return {
    queued: true,
    reqToken: dedupe,
    durationSec: Math.round(Math.min(beatLen + 0.4, MAX_CLIP_SEC())),
  };
}

/**
 * Cancel an in-flight / queued "Animate this shot" run (2026-07-17 operator:
 * a Cancel button to stop a generation on purpose). Sends the cancel event the
 * clip-generate function listens for (cancelOn productionId+idx) — Inngest stops
 * the matching run whether it's still queued behind others or already animating.
 */
export async function cancelClipAction(productionId: string, idx: number): Promise<{ error?: string }> {
  await inngest.send({ name: "production/clip.cancel", data: { productionId, idx } });
  return {};
}

/**
 * Suggest a motion prompt for a shot (2026-07-17 operator: "generate an
 * animation prompt based on the image prompt … needs some direction"). Looks at
 * the actual generated frame plus its image prompt/narration and writes ONE
 * vendor-ready i2v prompt — what should move, plus a gentle camera move. The
 * operator's optional `direction` steers it (passed as the motion note). Drop
 * the result into the Animate box, tweak, then animate. Same agent the pipeline
 * uses server-side, so the suggestion matches what a real animate would do.
 */
export async function suggestMotionPromptAction(
  productionId: string,
  assetId: string,
  direction?: string,
): Promise<{ prompt?: string; error?: string }> {
  const { db, providers, costSink } = await getAppContext();
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.productionId, productionId), eq(assets.kind, "image")));
  if (!asset) return { error: "Image not found" };
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  const meta = (asset.meta ?? {}) as Record<string, unknown>;
  const imagePrompt =
    (typeof meta.prompt === "string" && meta.prompt) ||
    (typeof meta.draftPrompt === "string" && meta.draftPrompt) ||
    null;
  const narration = typeof meta.narration === "string" ? meta.narration : "";
  const character = typeof meta.character === "string" ? meta.character : null;
  let bytes: Buffer;
  try {
    bytes = await providers.store.getBuffer(asset.storageKey);
  } catch {
    return { error: "Couldn't load this shot's image to base the motion on" };
  }
  try {
    const mp = await writeMotionPrompt(
      { db, llm: providers.llm, costSink, channelId: production.channelId, productionId },
      {
        image: bytes,
        mimeType: asset.mimeType,
        // the image prompt / narration give the agent the story the motion serves
        shotText: narration || imagePrompt || "this frame",
        visualBrief: imagePrompt,
        character,
        operatorNote: direction?.trim() || null,
      },
    );
    return { prompt: mp.prompt };
  } catch (err) {
    return { error: `Couldn't write a motion prompt: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Poll the outcome of an "Animate this shot" request (2026-07-17 operator: the
 * button needs a real in-progress / done / failed signal — clips generate async
 * in the worker over minutes). Given the shot idx and the queue time, returns:
 *  - "done"    a video_clip (re)landed after queuedAt (its updatedAt is bumped)
 *  - "failed"  the worker logged an "Animate shot N failed: …" ledger entry
 *  - "pending" neither yet — still in flight
 * A 20s grace absorbs cockpit↔worker clock skew; clips take minutes, so a stale
 * clip/failure from before this request is never mistaken for a fresh one.
 */
export async function clipStatusAction(
  productionId: string,
  idx: number,
  reqToken: string,
): Promise<{ status: "pending" | "done" | "failed"; error?: string; clipKey?: string }> {
  const { db } = await getAppContext();
  if (!reqToken) return { status: "pending" }; // no token → nothing to match (never false-done)
  // DONE only when the stored clip carries THIS request's token — so a landed
  // clip is never missed (no clock math) and a pre-existing/old clip is never
  // mistaken for this one.
  const [clip] = await db
    .select({ storageKey: assets.storageKey, meta: assets.meta })
    .from(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip"), eq(assets.idx, idx)));
  if (clip && (clip.meta as { reqToken?: string } | null)?.reqToken === reqToken) {
    return { status: "done", clipKey: clip.storageKey };
  }
  // FAILED only when a failure ledger row carries this request's token.
  const failures = await db
    .select({ detail: channelDecisions.detail })
    .from(channelDecisions)
    .where(like(channelDecisions.summary, `Animate shot ${idx + 1} failed:%`))
    .orderBy(desc(channelDecisions.createdAt))
    .limit(30);
  const failure = failures.find((f) => (f.detail as { reqToken?: string } | null)?.reqToken === reqToken);
  if (failure) {
    return { status: "failed", error: (failure.detail as { error?: string } | null)?.error ?? "clip generation failed" };
  }
  return { status: "pending" };
}

// ── Background music: generate candidates, listen, pick one ─────────────────

/** The voiceover length a music bed is sized to (falls back to the render, then 60s). */
async function productionAudioDuration(db: Db, productionId: string): Promise<number> {
  const [vo] = await db
    .select({ durationSec: assets.durationSec })
    .from(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "voiceover"), eq(assets.idx, 0)));
  if (vo?.durationSec) return vo.durationSec;
  const [rendered] = await db
    .select({ durationSec: assets.durationSec })
    .from(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "render"), eq(assets.idx, 0)));
  return rendered?.durationSec ?? 60;
}

/**
 * Generate ONE background-music candidate for a production (2026-07-17 operator:
 * choose music + listen to options). The operator types a mood (or uses the
 * channel default), generates a bed, plays it, and repeats to build a shortlist;
 * `selectMusicAction` marks the one the render uses. The first candidate
 * auto-selects so a bed is always in place.
 */
export async function generateMusicCandidateAction(
  productionId: string,
  mood?: string,
): Promise<{ error?: string; id?: string }> {
  const { db, providers, costSink } = await getAppContext();
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, production.channelId));
  const [idea] = await db.select({ title: ideas.title }).from(ideas).where(eq(ideas.id, production.ideaId));
  const profile = resolveProductionProfile(production.productionProfile ?? dna?.productionProfile ?? null);
  const chosenMood = mood?.trim() || profile.musicMood || null;
  const prompt = musicBriefFor(chosenMood, { title: idea?.title, tone: dna?.tone });
  const durationSec = await productionAudioDuration(db, productionId);
  let bed: { storageKey: string; mimeType: string; durationSec: number };
  try {
    bed = await providers.music.generateBed({
      durationSec,
      prompt,
      channelId: production.channelId,
      productionId,
      storageKeyBase: `productions/${productionId}/music-cand-${ulid().toLowerCase()}`,
    });
  } catch (err) {
    return { error: `Music generation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const existing = await db
    .select({ id: productionMusic.id })
    .from(productionMusic)
    .where(eq(productionMusic.productionId, productionId));
  // AI-name the track for the cross-video library dropdown (2026-07-19). Never
  // block generation on it — fall back to the mood label if naming trips.
  let name: string | null = null;
  try {
    name = await nameMusicTrack(
      { db, llm: providers.llm, costSink, channelId: production.channelId, productionId },
      { mood: chosenMood, prompt },
    );
  } catch {
    name = chosenMood ? chosenMood.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  }
  const id = ulid();
  await db.insert(productionMusic).values({
    id,
    productionId,
    storageKey: bed.storageKey,
    mimeType: bed.mimeType,
    name,
    durationSec: bed.durationSec,
    mood: chosenMood,
    prompt,
    engine: providers.music.name,
    selected: existing.length === 0, // first candidate is the one the render uses
  });
  revalidatePath(`/productions/${productionId}`);
  return { id };
}

/**
 * Cross-video music library (2026-07-19 operator: reuse a generated track on any
 * video). Copies a previously generated track (from ANY production — the library
 * is global) into THIS production as a selected candidate, referencing the same
 * stored audio. Idempotent: if this production already has that track, just
 * select it.
 */
export async function useLibraryTrackAction(
  productionId: string,
  storageKey: string,
): Promise<{ error?: string }> {
  const { db } = await getAppContext();
  const [src] = await db
    .select()
    .from(productionMusic)
    .where(eq(productionMusic.storageKey, storageKey))
    .orderBy(desc(productionMusic.createdAt))
    .limit(1);
  if (!src) return { error: "That track is no longer in the library." };
  // already on this production? just select it.
  const [mine] = await db
    .select({ id: productionMusic.id })
    .from(productionMusic)
    .where(and(eq(productionMusic.productionId, productionId), eq(productionMusic.storageKey, storageKey)))
    .limit(1);
  await db.update(productionMusic).set({ selected: false }).where(eq(productionMusic.productionId, productionId));
  if (mine) {
    await db.update(productionMusic).set({ selected: true }).where(eq(productionMusic.id, mine.id));
  } else {
    await db.insert(productionMusic).values({
      id: ulid(),
      productionId,
      storageKey: src.storageKey,
      mimeType: src.mimeType,
      name: src.name,
      durationSec: src.durationSec,
      mood: src.mood,
      prompt: src.prompt,
      engine: src.engine,
      selected: true,
    });
  }
  revalidatePath(`/productions/${productionId}`);
  return {};
}

/** Mark ONE candidate as the track the render uses (clears the others). */
export async function selectMusicAction(productionId: string, id: string): Promise<{ error?: string }> {
  const { db } = await getAppContext();
  const [row] = await db
    .select({ id: productionMusic.id })
    .from(productionMusic)
    .where(and(eq(productionMusic.id, id), eq(productionMusic.productionId, productionId)));
  if (!row) return { error: "Track not found" };
  await db.update(productionMusic).set({ selected: false }).where(eq(productionMusic.productionId, productionId));
  await db.update(productionMusic).set({ selected: true }).where(eq(productionMusic.id, id));
  revalidatePath(`/productions/${productionId}`);
  return {};
}

/** Delete a candidate. If it was the selected one, the render auto-generates a
 * fresh bed (or the operator picks another) — no track is left dangling. */
export async function deleteMusicCandidateAction(productionId: string, id: string): Promise<{ error?: string }> {
  const { db } = await getAppContext();
  await db.delete(productionMusic).where(and(eq(productionMusic.id, id), eq(productionMusic.productionId, productionId)));
  revalidatePath(`/productions/${productionId}`);
  return {};
}

/**
 * Remove a shot's image (2026-07-16 operator ask): delete the image — and any
 * clip generated from it — for this shot. The render carry-forwards, so the
 * PREVIOUS frame simply holds over this shot's time; the narration audio is
 * unchanged. Use "Retry from render" to rebuild the video without this image.
 */
export async function removeShotImageAction(
  productionId: string,
  assetId: string,
): Promise<{ removed?: boolean; error?: string }> {
  const { db } = await getAppContext();
  const [asset] = await db
    .select({ id: assets.id, idx: assets.idx })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.productionId, productionId), eq(assets.kind, "image")));
  if (!asset) return { error: "Image not found — it may already be removed." };
  await db.delete(assets).where(eq(assets.id, asset.id));
  // drop any generated clip for the same shot — it showed the removed image
  await db
    .delete(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip"), eq(assets.idx, asset.idx)));
  revalidatePath(`/productions/${productionId}`);
  return { removed: true };
}

/**
 * One-click duplicate sweep (2026-07-12 operator ask): find every real image
 * whose source photo is used more than once in the production, and re-source
 * each duplicate (beyond the first use) from the archives — skipping every
 * source already used, vision-checking each candidate against the shot's
 * subject. Sequential so the used-set stays consistent; unresolved shots are
 * reported for manual swap/regeneration.
 */
export async function dedupeRealImagesAction(
  productionId: string,
): Promise<{ error?: string; duplicates?: number; replaced?: number; unresolved?: number }> {
  const { db, providers, costSink } = await getAppContext();
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  if (!providers.reference.findEntityImages) {
    return { error: "The configured reference provider can't list candidates" };
  }
  const imageAssets = await db
    .select()
    .from(assets)
    .where(and(eq(assets.productionId, productionId), eq(assets.kind, "image")))
    .orderBy(asc(assets.idx));

  const used = new Set<string>();
  const dupes: typeof imageAssets = [];
  for (const a of imageAssets) {
    const src = (a.meta as Record<string, unknown> | null)?.source;
    if (typeof src !== "string") continue;
    if (used.has(src)) dupes.push(a);
    else used.add(src);
  }
  if (dupes.length === 0) return { duplicates: 0, replaced: 0, unresolved: 0 };

  let replaced = 0;
  for (const a of dupes) {
    const meta = (a.meta ?? {}) as Record<string, unknown>;
    const entity =
      (typeof meta.entity === "string" && meta.entity) ||
      (typeof meta.topic === "string" && meta.topic) ||
      null;
    if (!entity) continue;
    const cands = await providers.reference.findEntityImages({
      entity: entity.slice(0, 120),
      channelId: production.channelId,
      productionId,
      idx: 100_000 + Math.floor(Math.random() * 800_000),
      limit: 16,
      ...(typeof meta.draftPrompt === "string" ? { hint: meta.draftPrompt.slice(0, 60) } : {}),
    });
    let picked: (typeof cands)[number] | null = null;
    let pickedFit: number | null = null;
    for (const cand of cands) {
      if (used.has(cand.sourceUrl)) continue;
      try {
        const bytes = await providers.store.getBuffer(cand.storageKey);
        const fit = await scoreImageFit(
          { db, llm: providers.llm, costSink, channelId: production.channelId, productionId },
          {
            image: bytes,
            mimeType: cand.mimeType,
            shotText: entity,
            imagePrompt: entity,
            entity,
          },
        );
        if (fit.fits && fit.score >= 4) {
          picked = cand;
          pickedFit = fit.score;
          break;
        }
      } catch {
        picked = cand; // fail-safe: scoring trouble never blocks the sweep
        break;
      }
    }
    if (!picked) continue;
    used.add(picked.sourceUrl);
    await db
      .update(assets)
      .set({
        storageKey: picked.storageKey,
        mimeType: picked.mimeType,
        meta: {
          entity,
          ...(typeof meta.narration === "string" ? { narration: meta.narration } : {}),
          source: picked.sourceUrl,
          license: picked.license,
          attribution: picked.attribution,
          ...(pickedFit != null ? { fitScore: pickedFit } : {}),
          operatorSwap: "dedupe",
        },
      })
      .where(eq(assets.id, a.id));
    // same rule as the manual swap: a clip made from the replaced image is
    // stale and would win over the new still at render time — drop it
    await db
      .delete(assets)
      .where(and(eq(assets.productionId, productionId), eq(assets.kind, "video_clip"), eq(assets.idx, a.idx)));
    replaced++;
  }
  revalidatePath(`/productions/${productionId}`);
  return { duplicates: dupes.length, replaced, unresolved: dupes.length - replaced };
}

/**
 * Apply a thumbnail candidate to the ALREADY-UPLOADED video (2026-07-12:
 * a gate bug published the default candidate over the operator's pick —
 * this is the recovery path, and a general post-publish thumbnail swap).
 */
export async function applyThumbnailAction(
  productionId: string,
  thumbnailId: string,
): Promise<{ error?: string }> {
  const { db, providers } = await getAppContext();
  const [thumb] = await db
    .select()
    .from(thumbnails)
    .where(and(eq(thumbnails.id, thumbnailId), eq(thumbnails.productionId, productionId)));
  if (!thumb) return { error: "Thumbnail not found" };
  const [pub] = await db
    .select()
    .from(publications)
    .where(eq(publications.productionId, productionId))
    .limit(1);
  if (!pub?.providerVideoId) return { error: "No uploaded video to set a thumbnail on yet" };
  const [production] = await db.select().from(productions).where(eq(productions.id, productionId));
  if (!production) return { error: "Production not found" };
  try {
    await providers.publish.setThumbnail({
      channelId: production.channelId,
      productionId,
      providerVideoId: pub.providerVideoId,
      imageStorageKey: thumb.storageKey,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // persist so the page keeps warning even after a refresh, not just this toast
    await db
      .update(thumbnails)
      .set({ meta: { ...(thumb.meta ?? {}), applyError: reason } })
      .where(eq(thumbnails.id, thumbnailId));
    revalidatePath(`/productions/${productionId}`);
    return { error: `YouTube rejected the thumbnail: ${reason}` };
  }
  await db.update(thumbnails).set({ selected: false }).where(eq(thumbnails.productionId, productionId));
  // success clears the failure marker on the now-live thumbnail
  const cleared = { ...(thumb.meta ?? {}) } as Record<string, unknown>;
  delete cleared.applyError;
  await db.update(thumbnails).set({ selected: true, meta: cleared }).where(eq(thumbnails.id, thumbnailId));
  revalidatePath(`/productions/${productionId}`);
  return {};
}

/**
 * Reschedule a natively-scheduled release (#20): one videos.update moving
 * status.publishAt, then sync the platform calendar (source of truth).
 */
export async function reschedulePublicationAction(
  publicationId: string,
  newTimeIso: string,
): Promise<{ error?: string }> {
  const { db, providers } = await getAppContext();
  const [pub] = await db.select().from(publications).where(eq(publications.id, publicationId));
  if (!pub) return { error: "Publication not found" };
  // 2026-07-16: SET or move a schedule on any uploaded video that isn't already
  // public (a private upload — e.g. one halted mid-publish — can now be given a
  // date, not just an already-scheduled one). A public video must be unpublished
  // first. Not-yet-uploaded → schedule at the final gate instead.
  if (!pub.providerVideoId) {
    return { error: "This video hasn't been uploaded yet — set its schedule at the final review gate." };
  }
  if (pub.privacyStatus === "public") {
    return { error: "This video is already public — unpublish it first if you want to schedule it." };
  }
  const when = new Date(newTimeIso);
  if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
    return { error: "Pick a time in the future" };
  }
  const [production] = await db
    .select()
    .from(productions)
    .where(eq(productions.id, pub.productionId));
  if (!production) return { error: "Production not found" };

  // YouTube-native scheduling: videos.update with status.publishAt flips the
  // video to scheduled (stays private until the slot). Reflect that on both
  // rows so the platform stops showing it as private/published.
  await providers.publish.schedule({
    channelId: production.channelId,
    providerVideoId: pub.providerVideoId,
    publishAt: when.toISOString(),
  });
  await db
    .update(publications)
    .set({ privacyStatus: "scheduled", scheduledFor: when, publishedAt: null })
    .where(eq(publications.id, publicationId));
  await db
    .update(productions)
    .set({ status: "scheduled" })
    .where(eq(productions.id, pub.productionId));
  revalidateSchedulePaths(pub.productionId, production.channelId);
  return {};
}

/**
 * Cancel a natively-scheduled release (#20): clears YouTube's pending
 * publishAt (the video stays uploaded + private until an explicit release)
 * and takes the slot off the platform calendar.
 */
export async function cancelScheduledReleaseAction(
  publicationId: string,
): Promise<{ error?: string }> {
  const { db, providers } = await getAppContext();
  const [pub] = await db.select().from(publications).where(eq(publications.id, publicationId));
  if (!pub) return { error: "Publication not found" };
  if (pub.privacyStatus !== "scheduled" || !pub.providerVideoId) {
    return { error: "Only an uploaded, scheduled video can be unscheduled" };
  }
  const [production] = await db
    .select()
    .from(productions)
    .where(eq(productions.id, pub.productionId));
  if (!production) return { error: "Production not found" };

  await providers.publish.schedule({
    channelId: production.channelId,
    providerVideoId: pub.providerVideoId,
    publishAt: null,
  });
  await markScheduleCancelled(db, { publicationId, productionId: pub.productionId });
  revalidateSchedulePaths(pub.productionId, production.channelId);
  return {};
}

/** Trigger the trend fast-lane scan outside its daily cron. */
export async function scanTrendsAction() {
  await inngest.send({ name: "trend/scan.requested", data: {} });
  revalidatePath("/ideas");
}

/** Escape hatch: re-emit the event for a decided gate whose run missed it. */
export async function reemitGateAction(gateId: string) {
  const { db } = await getAppContext();
  const [gate] = await db.select().from(reviewGates).where(eq(reviewGates.id, gateId));
  if (!gate || gate.status !== "decided" || !gate.decision) throw new Error("Gate not re-emittable");
  await inngest.send({
    name: "production/gate.decided",
    data: {
      productionId: gate.productionId,
      gateId,
      kind: gate.kind,
      decision: gate.decision,
      notes: gate.notes ?? "",
    },
  });
}
