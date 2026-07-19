import { generateObject } from "ai";
import { z } from "zod";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "./run-agent";

const nameSchema = z.object({
  name: z
    .string()
    .max(40)
    .describe("2-4 word evocative track name in Title Case, no quotes/emojis/artist names"),
});

/**
 * Name a generated background-music track for the cross-video library
 * (2026-07-19 operator: "the AI should rename the track"). Short, evocative,
 * production-library style (e.g. "Midnight Drift", "Tense Undercurrent") so the
 * reuse dropdown reads like a real music library instead of raw moods. Cheap
 * tier; callers treat a throw as "fall back to the mood label".
 */
export async function nameMusicTrack(
  ctx: AgentCtx,
  input: { mood?: string | null; prompt?: string | null },
): Promise<string> {
  const res = await runAgent("music_namer", "cheap", ctx, "name a music track", async (model) => {
    const r = await generateObject({
      model,
      schema: nameSchema,
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:music-name — Name a background-music track for a video's music library in 2-4 words. " +
        "Evocative and specific to the mood, like a production-music catalogue title (e.g. 'Midnight Drift', " +
        "'Golden Hour Glow', 'Tense Undercurrent', 'Neon Rainfall'). Title Case. No quotes, emojis, hashtags, " +
        "artist names, or the words 'track'/'music'/'bed'.",
      prompt:
        `MOOD: ${input.mood?.trim() || "instrumental background bed"}\n` +
        (input.prompt ? `BRIEF: ${input.prompt.slice(0, 300)}\n` : "") +
        "Give this track a short, memorable name.",
    });
    return { object: r.object, usage: r.usage };
  });
  return res.name.trim();
}
