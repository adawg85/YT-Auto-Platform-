import { eq } from "drizzle-orm";
import { generateObject } from "ai";
import { channels, type channelDna, type ideas } from "@ytauto/db";
import {
  patternGrounding,
  patternsToPromptLines,
  scriptOutputSchema,
  type ScriptOutput,
} from "@ytauto/core";
import { runAgent, type AgentCtx } from "./run-agent";

// Structural subsets (no Date fields) so callers can pass rows that have
// round-tripped through JSON, e.g. Inngest step outputs.
type Idea = Pick<typeof ideas.$inferSelect, "id" | "channelId" | "title" | "angle">;
type Dna = Pick<
  typeof channelDna.$inferSelect,
  "tone" | "audiencePersona" | "hookStyles" | "visualStyle" | "voiceId" | "ctaTemplate" | "targetLengthSec"
>;

/**
 * Scriptwriter agent (frontier tier): drafts original substance onto the
 * proven hook→stat→insight→cta skeleton. Format is templated; substance must
 * be materially varied — the substanceFingerprint it returns feeds the
 * variation check.
 */
export type HookTemplateInput = {
  name: string;
  archetype: string;
  skeleton: { first2s: string; beatPlan: string[]; payoffPlacement: string; loopOrCta: string };
};

export async function draftScript(
  ctx: AgentCtx,
  idea: Idea,
  dna: Dna | undefined,
  opts: {
    revisionNotes?: string;
    targetLengthSec?: number;
    hookTemplate?: HookTemplateInput;
  } = {},
): Promise<ScriptOutput> {
  const targetLen = opts.targetLengthSec ?? dna?.targetLengthSec ?? 40;
  const wordBudget = Math.round(targetLen * 2.5); // ≈ speaking pace

  // Shared pattern store grounding (build #4): the hook shapes + beat structures
  // proven in this niche right now, own + external. Shape only — the writer
  // still produces original substance (enforced by the variation check).
  const [channel] = await ctx.db
    .select({ niche: channels.niche })
    .from(channels)
    .where(eq(channels.id, idea.channelId));
  const ground = channel
    ? await patternGrounding(ctx.db, { niche: channel.niche, format: "shorts", perKind: 3 })
    : { hooks: [], structures: [], topics: [] };

  const prompt = [
    `IDEA TITLE: ${idea.title}`,
    `IDEA ANGLE: ${idea.angle}`,
    `TONE: ${dna?.tone ?? "punchy, curious, plain language"}`,
    `AUDIENCE: ${dna?.audiencePersona ?? "general short-form viewers"}`,
    `HOOK STYLES TO PREFER: ${(dna?.hookStyles ?? []).join(", ") || "curiosity_gap"}`,
    ground.hooks.length
      ? `HOOK PATTERNS WORKING IN THIS NICHE (shape only — write ORIGINAL substance):\n${patternsToPromptLines(ground.hooks).join("\n")}`
      : "",
    ground.structures.length
      ? `PROVEN BEAT STRUCTURES IN THIS NICHE:\n${patternsToPromptLines(ground.structures).join("\n")}`
      : "",
    opts.hookTemplate
      ? [
          `STRUCTURE SKELETON (${opts.hookTemplate.name} / ${opts.hookTemplate.archetype}):`,
          `  first 2s: ${opts.hookTemplate.skeleton.first2s}`,
          `  beats: ${opts.hookTemplate.skeleton.beatPlan.join(" → ")}`,
          `  payoff: ${opts.hookTemplate.skeleton.payoffPlacement}`,
          `  close: ${opts.hookTemplate.skeleton.loopOrCta}`,
        ].join("\n")
      : "",
    `IMAGE STYLE: ${dna?.visualStyle?.imageStyle ?? "clean flat illustration, high contrast"}`,
    `CTA: ${dna?.ctaTemplate ?? "Follow for more."}`,
    `TARGET LENGTH: ~${targetLen}s (~${wordBudget} words total)`,
    opts.revisionNotes ? `REVISION NOTES: ${opts.revisionNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return runAgent(
    "scriptwriter",
    "frontier",
    ctx,
    `draft script v-next for: ${idea.title}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: scriptOutputSchema,
        system:
          "TASK:script — Write a faceless YouTube Short narration on the hook→stat→insight→cta skeleton. " +
          "The structure is templated but the SUBSTANCE must be original and specific: concrete facts, numbers, mechanisms — never generic filler. " +
          "The hook is spoken in the first 1-2 seconds and must create an open loop. " +
          "Each beat gets an imagePrompt in the given IMAGE STYLE. " +
          "substanceFingerprint must be 'topic | hook claim | fact1 | fact2 | fact3' — lowercase, terse.",
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
