import { eq } from "drizzle-orm";
import { generateObject } from "ai";
import { channelDna, channels, ideas, scores, ulid } from "@ytauto/db";
import {
  channelPerformanceSummary,
  DEFAULT_SCORING_WEIGHTS,
  patternGrounding,
  patternsToPromptLines,
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
  const [channel] = await ctx.db
    .select({ niche: channels.niche })
    .from(channels)
    .where(eq(channels.id, idea.channelId));
  // pattern priors (build #4): an idea matching a hot, fresh market pattern
  // should score higher on demand/trend — evidence-linked, not a free boost
  const ground = channel
    ? await patternGrounding(ctx.db, { niche: channel.niche, format: "shorts" })
    : { hooks: [], structures: [], topics: [] };
  const priors = [...ground.topics, ...ground.hooks];

  const prompt = [
    `IDEA TITLE: ${idea.title}`,
    `IDEA ANGLE: ${idea.angle}`,
    `CHANNEL NICHE FIT CONTEXT: tone=${dna?.tone ?? "n/a"}; audience=${dna?.audiencePersona ?? "n/a"}`,
    `FORBIDDEN TOPICS: ${(dna?.forbiddenTopics ?? []).join(", ") || "none"}`,
    priors.length
      ? `HOT MARKET PATTERNS (reward demand/trend fit only where the idea genuinely matches):\n${patternsToPromptLines(priors).join("\n")}`
      : "",
    `RECENT CHANNEL PERFORMANCE: ${perf.summaryText}`,
  ]
    .filter(Boolean)
    .join("\n");

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

  // the schema no longer hard-bounds scores (real models overshoot and would
  // otherwise crash generateObject) — clamp to 0–10 so the weighted total is sane
  const clamp = (n: number) => Math.max(0, Math.min(10, n));
  const clamped = Object.fromEntries(
    Object.entries(rubric).map(([k, v]) => [k, { ...v, score: clamp(v.score) }]),
  ) as typeof rubric;

  const total = weightedTotal(clamped, DEFAULT_SCORING_WEIGHTS);
  const row = {
    id: ulid(),
    ideaId,
    rubric: clamped,
    weightedTotal: total,
    modelUsed: ctx.llm.modelId("agentic"),
  };
  await ctx.db.insert(scores).values(row);
  await ctx.db.update(ideas).set({ status: "scored" }).where(eq(ideas.id, ideaId));
  return row;
}
