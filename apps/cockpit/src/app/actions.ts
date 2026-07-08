"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { assets, ideas, productions, publications, reviewGates, scriptDrafts, thumbnails } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { generateIdeas as ideationAgent, scoreIdea as scoringAgent } from "@ytauto/agents";
import { getAppContext, operatorName } from "@/lib/context";

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
}

export async function scoreIdeaAction(ideaId: string) {
  const { db, providers, costSink } = await getAppContext();
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId));
  if (!idea) throw new Error("Idea not found");
  await scoringAgent({ db, llm: providers.llm, costSink, channelId: idea.channelId, ideaId }, ideaId);
  revalidatePath("/ideas");
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
  await inngest.send({ name: "production/greenlit", data: { productionId } });
  revalidatePath("/ideas");
  revalidatePath("/gates");
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

/** T2 "release" click: flip a private upload to public. */
export async function releasePublicationAction(publicationId: string) {
  const { db, providers } = await getAppContext();
  const [pub] = await db.select().from(publications).where(eq(publications.id, publicationId));
  if (!pub) throw new Error("Publication not found");
  if (pub.privacyStatus !== "private") throw new Error(`Already ${pub.privacyStatus}`);
  const [production] = await db
    .select()
    .from(productions)
    .where(eq(productions.id, pub.productionId));
  if (!production) throw new Error("Production not found");

  await providers.publish.release({
    channelId: production.channelId,
    providerVideoId: pub.providerVideoId,
  });
  await db
    .update(publications)
    .set({ privacyStatus: "public" })
    .where(eq(publications.id, publicationId));
  revalidatePath(`/productions/${pub.productionId}`);
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
