import { desc, eq } from "drizzle-orm";
import { generateObject } from "ai";
import { channelDna, channels, ideas, ulid } from "@ytauto/db";
import { channelPerformanceSummary, ideationOutputSchema } from "@ytauto/core";
import type { ResearchProvider } from "@ytauto/providers";
import { runAgent, type AgentCtx } from "./run-agent";

/**
 * Ideation agent (cheap tier): channel DNA + research feed + recent ideas →
 * 5-10 new idea rows with editorial angles.
 */
export async function generateIdeas(ctx: AgentCtx, research: ResearchProvider) {
  const [channel] = await ctx.db.select().from(channels).where(eq(channels.id, ctx.channelId));
  if (!channel) throw new Error(`Channel not found: ${ctx.channelId}`);
  const [dna] = await ctx.db
    .select()
    .from(channelDna)
    .where(eq(channelDna.channelId, ctx.channelId));

  const [outliers, keywords, recent, perf] = await Promise.all([
    research.outliers(channel.niche),
    research.keywords(channel.niche),
    ctx.db
      .select({ title: ideas.title })
      .from(ideas)
      .where(eq(ideas.channelId, ctx.channelId))
      .orderBy(desc(ideas.createdAt))
      .limit(30),
    channelPerformanceSummary(ctx.db, ctx.channelId),
  ]);

  const prompt = [
    `NICHE: ${channel.niche}`,
    `TONE: ${dna?.tone ?? "punchy, curious"}`,
    `AUDIENCE: ${dna?.audiencePersona ?? "general"}`,
    `FORBIDDEN TOPICS: ${(dna?.forbiddenTopics ?? []).join(", ") || "none"}`,
    `KEYWORDS: ${keywords.map((k) => k.keyword).join(", ")}`,
    `OUTLIER FORMATS IN NICHE:\n${outliers.map((o) => `- ${o.title} (${o.views} views, x${o.outlierFactor})`).join("\n")}`,
    `EXISTING IDEAS (do not duplicate):\n${recent.map((r) => `- ${r.title}`).join("\n") || "- none"}`,
    `RECENT CHANNEL PERFORMANCE (lean toward what works): ${perf.summaryText}`,
  ].join("\n\n");

  const out = await runAgent(
    "ideation",
    "cheap",
    ctx,
    `generate ideas for ${channel.name}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: ideationOutputSchema,
        system:
          "TASK:ideation — You generate faceless-YouTube-Shorts video ideas. Every idea must be materially distinct from existing ideas and from each other; never near-duplicates. Respect forbidden topics strictly.",
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );

  const rows = out.ideas.map((i) => ({
    id: ulid(),
    channelId: ctx.channelId,
    title: i.title,
    angle: i.angle,
    sourceType: "agent" as const,
  }));
  if (rows.length) await ctx.db.insert(ideas).values(rows);
  return rows;
}
