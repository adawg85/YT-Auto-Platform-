"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import { assets, channelCharacters, channelDna, channels, ideas, productions, publications, reviewGates, scriptDrafts, thumbnails, type Db } from "@ytauto/db";
import {
  buildThumbnailPrompts,
  imageEngineFor,
  inngest,
  markPublicationLive,
  markScheduleCancelled,
  resolveProductionProfile,
} from "@ytauto/core";
import { generateIdeas as ideationAgent, scoreIdea as scoringAgent, scoreImageFit, scoreThumbnailFromPrompt } from "@ytauto/agents";
import { createHash } from "node:crypto";
import { getAppContext, operatorName } from "@/lib/context";
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
      await tx
        .delete(assets)
        .where(and(eq(assets.productionId, productionId), inArray(assets.kind, ["voiceover", "image", "render"])));
    } else if (stage === "visuals") {
      await tx
        .delete(assets)
        .where(and(eq(assets.productionId, productionId), inArray(assets.kind, ["image", "render"])));
    } else if (stage === "render") {
      await tx.delete(assets).where(and(eq(assets.productionId, productionId), eq(assets.kind, "render")));
    }
    // stage "publish": nothing wiped — the publish steps re-run, and the
    // upload idempotency guard adopts any already-uploaded video.
    await tx
      .update(reviewGates)
      .set({ status: "expired" })
      .where(and(eq(reviewGates.productionId, productionId), eq(reviewGates.status, "pending")));
    await tx
      .update(productions)
      .set({ status: "greenlit", failureReason: null, currentGateId: null, inngestRunId: null })
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
  } = {},
): Promise<{ error?: string; clipRemoved?: boolean }> {
  const { prompt, useReference, characterId } = opts;
  const { db, providers } = await getAppContext();
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
  } else {
    const genPrompt =
      prompt?.trim() ||
      (typeof meta.prompt === "string" && meta.prompt) ||
      (typeof meta.draftPrompt === "string" && meta.draftPrompt) ||
      null;
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
      if (providers.store.presignGet && !character.mimeType.includes("svg")) {
        referenceImageUrl = await providers.store.presignGet(character.imageKey, 900);
        referenceStrength = 0.55;
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
        quality: mode === "hero" ? "hero" : undefined,
        // fal retired (2026-07-14): route per the channel profile
        engine: imageEngineFor(
          resolveProductionProfile(swapDna?.productionProfile ?? null),
          mode === "hero" ? "hero" : "standard",
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
  return { ...(staleClip.length ? { clipRemoved: true } : {}) };
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
  opts: { prompt?: string } = {},
): Promise<{ queued?: boolean; durationSec?: number; error?: string }> {
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
  // double-clicks collapse; a new image (updatedAt) or a new brief runs fresh
  const dedupe = createHash("sha1")
    .update(`${productionId}:${asset.idx}:${new Date(asset.updatedAt).getTime()}:${prompt ?? ""}`)
    .digest("hex");
  await inngest.send({
    name: "production/clip.requested",
    data: { productionId, idx: asset.idx, ...(prompt ? { prompt } : {}), dedupe },
  });
  return { queued: true, durationSec: Math.round(Math.min(beatLen + 0.4, MAX_CLIP_SEC())) };
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
    return { error: `YouTube rejected the thumbnail: ${err instanceof Error ? err.message : String(err)}` };
  }
  await db.update(thumbnails).set({ selected: false }).where(eq(thumbnails.productionId, productionId));
  await db.update(thumbnails).set({ selected: true }).where(eq(thumbnails.id, thumbnailId));
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
  if (pub.privacyStatus !== "scheduled" || !pub.providerVideoId) {
    return { error: "Only an uploaded, scheduled video can be rescheduled" };
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

  await providers.publish.schedule({
    channelId: production.channelId,
    providerVideoId: pub.providerVideoId,
    publishAt: when.toISOString(),
  });
  await db
    .update(publications)
    .set({ scheduledFor: when })
    .where(eq(publications.id, publicationId));
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
