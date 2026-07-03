import { generateObject } from "ai";
import type { channelDna, ideas } from "@ytauto/db";
import { scriptOutputSchema, type ScriptOutput } from "@ytauto/core";
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
export async function draftScript(
  ctx: AgentCtx,
  idea: Idea,
  dna: Dna | undefined,
  opts: { revisionNotes?: string; targetLengthSec?: number } = {},
): Promise<ScriptOutput> {
  const targetLen = opts.targetLengthSec ?? dna?.targetLengthSec ?? 40;
  const wordBudget = Math.round(targetLen * 2.5); // ≈ speaking pace

  const prompt = [
    `IDEA TITLE: ${idea.title}`,
    `IDEA ANGLE: ${idea.angle}`,
    `TONE: ${dna?.tone ?? "punchy, curious, plain language"}`,
    `AUDIENCE: ${dna?.audiencePersona ?? "general short-form viewers"}`,
    `HOOK STYLES TO PREFER: ${(dna?.hookStyles ?? []).join(", ") || "curiosity_gap"}`,
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
