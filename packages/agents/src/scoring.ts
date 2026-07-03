import { eq } from "drizzle-orm";
import { generateObject } from "ai";
import { channelDna, ideas, scores, ulid } from "@ytauto/db";
import {
  channelPerformanceSummary,
  DEFAULT_SCORING_WEIGHTS,
  rubricSchema,
  weightedTotal,
} from "@ytauto/core";
import { runAgent, type AgentCtx } from "./run-agent";

/**
 * Scoring agent (agentic tier): 7-axis weighted rubric → rankable backlog.
 * Weights live in code/config, not in the model.
 */
export async function scoreIdea(ctx: AgentCtx, ideaId: string) {
  const [idea] = await ctx.db.select().from(ideas).where(eq(ideas.id, ideaId));
  if (!idea) throw new Error(`Idea not found: ${ideaId}`);
  const [dna] = await ctx.db
    .select()
    .from(channelDna)
    .where(eq(channelDna.channelId, idea.channelId));

  // analytics → strategy feedback loop (spec §5.4)
  const perf = await channelPerformanceSummary(ctx.db, idea.channelId);

  const prompt = [
    `IDEA TITLE: ${idea.title}`,
    `IDEA ANGLE: ${idea.angle}`,
    `CHANNEL NICHE FIT CONTEXT: tone=${dna?.tone ?? "n/a"}; audience=${dna?.audiencePersona ?? "n/a"}`,
    `FORBIDDEN TOPICS: ${(dna?.forbiddenTopics ?? []).join(", ") || "none"}`,
    `RECENT CHANNEL PERFORMANCE: ${perf.summaryText}`,
  ].join("\n");

  const rubric = await runAgent(
    "scoring",
    "agentic",
    { ...ctx, ideaId },
    `score idea: ${idea.title}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: rubricSchema,
        system:
          "TASK:scoring — Score this Shorts video idea 0-10 on each axis with a one-sentence rationale. saturation/complianceRisk are inverted: higher = better (less saturated / safer).",
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );

  const total = weightedTotal(rubric, DEFAULT_SCORING_WEIGHTS);
  const row = {
    id: ulid(),
    ideaId,
    rubric,
    weightedTotal: total,
    modelUsed: ctx.llm.modelId("agentic"),
  };
  await ctx.db.insert(scores).values(row);
  await ctx.db.update(ideas).set({ status: "scored" }).where(eq(ideas.id, ideaId));
  return row;
}
