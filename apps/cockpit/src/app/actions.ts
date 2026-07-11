"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { assets, ideas, productions, publications, reviewGates, scriptDrafts, thumbnails, type Db } from "@ytauto/db";
import { inngest, markPublicationLive, markScheduleCancelled } from "@ytauto/core";
import { generateIdeas as ideationAgent, scoreIdea as scoringAgent } from "@ytauto/agents";
import { getAppContext, operatorName } from "@/lib/context";

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
) {
  const { db } = await getAppContext();
  const [gate] = await db.select().from(reviewGates).where(eq(reviewGates.id, gateId));
  if (!gate) throw new Error("Gate not found");
  if (gate.status !== "pending") throw new Error(`Gate already ${gate.status}`);

  if (selectedThumbnailId) {
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
