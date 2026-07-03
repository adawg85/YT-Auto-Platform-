"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { ideas, productions, reviewGates } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { generateIdeas as ideationAgent, scoreIdea as scoringAgent } from "@ytauto/agents";
import { getAppContext, operatorName } from "@/lib/context";

export async function generateIdeasAction(channelId: string) {
  const { db, providers, costSink } = getAppContext();
  await ideationAgent({ db, llm: providers.llm, costSink, channelId }, providers.research);
  revalidatePath("/ideas");
}

export async function scoreIdeaAction(ideaId: string) {
  const { db, providers, costSink } = getAppContext();
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId));
  if (!idea) throw new Error("Idea not found");
  await scoringAgent({ db, llm: providers.llm, costSink, channelId: idea.channelId, ideaId }, ideaId);
  revalidatePath("/ideas");
}

/** Greenlight: create the production and kick off the durable pipeline. */
export async function greenlightAction(ideaId: string) {
  const { db } = getAppContext();
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

/**
 * The single gate-resume path: record the human decision (compliance
 * evidence log) and emit the event the pipeline is waiting on.
 */
export async function decideGateAction(gateId: string, decision: "approved" | "rejected" | "revise", notes: string) {
  const { db } = getAppContext();
  const [gate] = await db.select().from(reviewGates).where(eq(reviewGates.id, gateId));
  if (!gate) throw new Error("Gate not found");
  if (gate.status !== "pending") throw new Error(`Gate already ${gate.status}`);

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
    data: { productionId: gate.productionId, gateId, kind: gate.kind, decision, notes },
  });
  revalidatePath("/gates");
  revalidatePath(`/productions/${gate.productionId}`);
}

/** Escape hatch: re-emit the event for a decided gate whose run missed it. */
export async function reemitGateAction(gateId: string) {
  const { db } = getAppContext();
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
