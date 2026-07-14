import { generateObject } from "ai";
import { characterSheetSchema, type CharacterSheet } from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "./run-agent";

/**
 * Character sheet writer (2026-07-14 operator ask): turn the operator's brief
 * ("a warm 40s physics teacher") into ONE canonical appearance paragraph that
 * is injected VERBATIM into image prompts whenever the character appears —
 * identical wording every time is what keeps the character consistent across
 * videos. The reference image is generated separately from this description.
 */
export async function generateCharacterSheet(
  ctx: AgentCtx,
  input: {
    name: string;
    brief: string;
    imageStyle: string;
    /** the channel's ACTIVE distilled visual style block, when one exists */
    styleBlock?: string | null;
  },
): Promise<CharacterSheet> {
  const prompt = [
    `CHARACTER NAME: ${input.name}`,
    `BRIEF: ${input.brief}`,
    `CHANNEL IMAGE STYLE: ${input.imageStyle}`,
    input.styleBlock ?? "",
    "Write the canonical appearance paragraph.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return runAgent("character_sheet", "agentic", ctx, `character sheet for ${input.name}`, async (model) => {
    const res = await generateObject({
      model,
      schema: characterSheetSchema,
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:character-sheet — You define a recurring visual character for a YouTube channel. " +
        "From the operator's brief, write ONE compact canonical-appearance paragraph an image " +
        "model can repeat exactly: age range, build, hair, skin tone, facial features, signature " +
        "clothing and accessories, colour palette. Concrete physical descriptors only — no name, " +
        "no personality, no backstory, no scene or pose. Keep it under 80 words so it fits at the " +
        "front of every prompt.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}
