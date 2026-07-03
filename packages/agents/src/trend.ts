import { and, eq } from "drizzle-orm";
import { generateObject } from "ai";
import { channelDna, channels, ideas, ulid } from "@ytauto/db";
import { trendSuggestionsSchema } from "@ytauto/core";
import type { ResearchProvider } from "@ytauto/providers";
import { runAgent, type AgentCtx } from "./run-agent";

/**
 * Trend-replication fast lane (spec §5.5): detect rising formats/topics,
 * match against ChannelDNA, and fast-track fitting variants. Enforces the
 * format-vs-substance rule in the prompt; the variation check still guards
 * the output downstream.
 */
export async function scanTrendsForChannel(ctx: AgentCtx, research: ResearchProvider) {
  const [channel] = await ctx.db.select().from(channels).where(eq(channels.id, ctx.channelId));
  if (!channel) throw new Error(`Channel not found: ${ctx.channelId}`);
  const [dna] = await ctx.db
    .select()
    .from(channelDna)
    .where(eq(channelDna.channelId, ctx.channelId));

  const outliers = await research.outliers(channel.niche);
  const rising = outliers.filter((o) => o.outlierFactor >= 5);
  if (rising.length === 0) return [];

  const prompt = [
    `NICHE: ${channel.niche}`,
    `TONE: ${dna?.tone ?? "n/a"}`,
    `FORBIDDEN TOPICS: ${(dna?.forbiddenTopics ?? []).join(", ") || "none"}`,
    ...rising.map((o) => `OUTLIER: ${o.title} (${o.views} views, x${o.outlierFactor})`),
  ].join("\n");

  const out = await runAgent(
    "trend_scanner",
    "cheap",
    ctx,
    `trend scan for ${channel.name}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: trendSuggestionsSchema,
        system:
          "TASK:trend — These formats/topics are rising right now. Propose at most 3 fast-lane video ideas that replicate the rising FORMAT with materially original substance for this channel. Skip anything touching forbidden topics. Empty list is a valid answer.",
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );

  const created = [];
  for (const s of out.suggestions) {
    const [dupe] = await ctx.db
      .select({ id: ideas.id })
      .from(ideas)
      .where(and(eq(ideas.channelId, ctx.channelId), eq(ideas.title, s.title)));
    if (dupe) continue;
    const row = {
      id: ulid(),
      channelId: ctx.channelId,
      title: s.title,
      angle: s.angle,
      sourceType: "research" as const,
      researchRefs: [{ trendRef: s.trendRef, fitReason: s.fitReason }],
      fastTrack: true,
    };
    await ctx.db.insert(ideas).values(row);
    created.push(row);
  }
  return created;
}
