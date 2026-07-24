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
    /** refine mode (2026-07-14): the existing canonical look being revised */
    currentDescription?: string | null;
    /** refine mode: the operator's change request to apply to the look */
    comments?: string | null;
  },
): Promise<CharacterSheet> {
  const prompt = [
    `CHARACTER NAME: ${input.name}`,
    `BRIEF: ${input.brief}`,
    `CHANNEL IMAGE STYLE: ${input.imageStyle}`,
    input.styleBlock ?? "",
    ...(input.currentDescription
      ? [
          `CURRENT LOOK (revise this): ${input.currentDescription}`,
          `OPERATOR COMMENTS (apply exactly; keep every unmentioned detail VERBATIM): ${input.comments ?? ""}`,
        ]
      : []),
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
        "clothing and accessories, colour palette. Concrete physical IDENTITY descriptors ONLY — " +
        "who this person IS, not how or where they are pictured. " +
        "HARD EXCLUSIONS — never write any of these; the channel's visual style supplies the look " +
        "and each scene supplies the framing, so baking them in would lock the character into one " +
        "shot and fight the channel style: NO render medium or register (do not say photographic, " +
        "photoreal, realistic, cinematic, painterly, oil painting, illustration, animation, render, " +
        "artwork, or 'not an X'); NO pose or bearing (standing, facing forward, arms at sides, " +
        "neutral expression); NO camera or crop (portrait, full-body, head-to-toe, close-up); NO " +
        "background, setting, lighting, or scale (studio backdrop, seamless grey, plain floor, " +
        "even lighting, reference plate/sheet). Describe the person as they simply are, so any " +
        "scene can place them at any size, pose, and setting in the channel's own style. " +
        "No name, no personality, no backstory. Keep it under 80 words so it fits at the front of " +
        "every prompt. When a CURRENT LOOK and OPERATOR COMMENTS are provided, this is a REVISION: " +
        "apply the comments to the current look and keep every detail the operator did not mention " +
        "word-for-word — identical wording is the consistency anchor. If the current look or brief " +
        "contains any excluded medium/pose/framing/background language, DROP it in your output.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}
