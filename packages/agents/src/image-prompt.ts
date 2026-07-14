import { generateObject } from "ai";
import { builtImagePromptSchema, type BuiltImagePrompts } from "@ytauto/core";
import { temperatureFor } from "@ytauto/providers";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "./run-agent";

export type ShotForPrompt = {
  text: string;
  /** the scriptwriter's draft visual idea (scene intent, kept as input) */
  imagePrompt: string;
  referenceEntity?: string | null;
  /** the writer's visual ASK for the section (2026-07-12) — when present it
   * is the brief; the narration is relevance context only */
  visualBrief?: string | null;
};

/**
 * Per-shot image-prompt builder (BACKLOG #21, audit §4.4). The scriptwriter's
 * imagePrompt is a scene IDEA; this pass turns each one into a proper FLUX
 * prompt per the verified BFL/fal guidance: subject-first natural prose, an
 * explicit lighting clause in every prompt (the biggest quality lever),
 * camera/film-stock descriptors for archival realism, positive-only phrasing
 * (FLUX has no negative prompts — naming the unwanted thing makes it appear),
 * and one shared "Style/Mood" suffix so the whole video's set reads as one
 * system. This is also where the operator's Production Profile artDirection
 * finally reaches the image model.
 *
 * Fail-safe: a count mismatch falls back to the draft prompts unchanged.
 */
export type BuiltShotPrompt = {
  prompt: string;
  /** 2026-07-14 recurring characters: the character this shot depicts, if any */
  character: string | null;
};

export async function buildImagePrompts(
  ctx: AgentCtx,
  input: {
    shots: ShotForPrompt[];
    imageStyle: string;
    artDirection?: string | null;
    orientation: "portrait" | "landscape";
    niche: string;
    /** #35.1: the channel's ACTIVE distilled visual style (styleBlockForImagePrompts output) */
    styleBlock?: string | null;
    /** 2026-07-14: the channel's recurring characters — the agent casts them
     * into shots whose scene calls for them, by canonical description */
    characters?: { name: string; description: string }[];
  },
): Promise<BuiltShotPrompt[]> {
  // fail-safe fallback: the writer's visual brief (clean scene, no narration)
  // beats the raw scene idea when the builder pass is unavailable
  const draftPrompts: BuiltShotPrompt[] = input.shots.map((s) => ({
    prompt: s.visualBrief ?? s.imagePrompt,
    character: null,
  }));

  const system =
    "TASK:image-prompt — You write generation prompts for the FLUX image model, one per shot of a " +
    "faceless YouTube video. Follow these rules exactly:\n" +
    "- Natural-language prose, not keyword soup. 2-4 RICHLY DESCRIPTIVE sentences plus the " +
    "suffix — enough concrete detail that two different people would imagine the same frame.\n" +
    "- TAILOR EVERY PROMPT TO ITS OWN SHOT (2026-07-14 operator review: prompts read " +
    "generic): anchor on the most concrete visual specifics named in THIS shot's brief/" +
    "narration — the exact object, machine, number, place, era, weather, material. A viewer " +
    "pausing on this frame should see THIS sentence's story moment, not a generic scene that " +
    "could sit under any shot of the video.\n" +
    "- THE VISUAL BRIEF IS THE ASK (2026-07-12): when a shot carries a VISUAL BRIEF, execute that " +
    "scene. The NARRATION tells you what moment of the story the shot covers — use it to pick " +
    "WHICH concrete detail of the brief to feature ('the fuel gauge read empty' → feature the " +
    "gauge), but NEVER copy narration wording into the prompt and NEVER depict its figurative " +
    "language ('the workhorse of the fleet' must not produce a horse; 'a shot in the dark' is " +
    "not a gun). Only literal, physical, era-plausible scene elements go in the prompt.\n" +
    "- SUBJECT FIRST: open with the concrete subject (FLUX weighs early words most). When a shot " +
    "names a REFERENCE ENTITY, depict that exact subject accurately.\n" +
    "- Then action/setting, then composition and camera framing, then an EXPLICIT LIGHTING clause " +
    "in every prompt (golden hour, overcast diffuse, harsh noon, tungsten hangar lights…).\n" +
    "- For photoreal/archival looks, name the camera era or film stock ('35mm Kodak film photograph, " +
    "natural grain', '1950s press photograph') instead of saying 'professional photo'.\n" +
    "- POSITIVE PHRASING ONLY. Never write 'no text', 'without watermark', 'not blurry' — naming " +
    "the unwanted thing makes the model draw it. Describe what fills the space instead ('clean " +
    "unmarked metal skin', 'empty sky behind').\n" +
    "- TEXT IS BANNED unless the shot explicitly NEEDS rendered text: never write poster, sign, " +
    "label, diagram, chart, document, newspaper, headline, or ANY word implying printed/readable " +
    "surfaces — FLUX renders garbled junk text from them. Describe text-free surfaces positively " +
    "('clean unmarked metal skin', 'plain weathered concrete', 'empty sky'). When text IS needed, " +
    "put the exact wording in quotation marks, 1-3 words maximum.\n" +
    "- Vary composition across shots (wide/medium/close, angles) so consecutive frames cut well.\n" +
    "- Build ONE 'Style: … Mood: …' suffix from the IMAGE STYLE, ART DIRECTION and (when present) " +
    "the CHANNEL VISUAL STYLE — its style suffix is bedded down, include its wording VERBATIM in " +
    "yours — and end EVERY prompt with that exact same suffix; it is the set's consistency anchor.\n" +
    "- The ART DIRECTION is the operator's standing instruction: honour it in every prompt.\n" +
    "- RECURRING CHARACTERS (when listed): the channel keeps named characters visually identical " +
    "across every video. When a shot's brief/narration naturally features the channel's " +
    "host/presenter/teacher — direct address, demonstrations, classroom or studio scenes — open " +
    "that prompt with the character's canonical description WORD-FOR-WORD (identical wording is " +
    "the consistency anchor) and set that shot's \"character\" field to the character's exact " +
    "name. NEVER force a character into shots that don't need them — establishing shots, " +
    "diagrams, objects, archival moments stay character-free with \"character\": null.";

  const prompt = [
    `NICHE: ${input.niche}`,
    `ORIENTATION: ${input.orientation === "portrait" ? "vertical 9:16" : "widescreen 16:9"}`,
    `IMAGE STYLE: ${input.imageStyle}`,
    input.artDirection ? `ART DIRECTION (operator): ${input.artDirection}` : "",
    input.styleBlock ?? "",
    input.characters?.length
      ? `RECURRING CHARACTERS:\n${input.characters
          .map((c) => `- ${c.name}: ${c.description}`)
          .join("\n")}`
      : "",
    "SHOTS:",
    ...input.shots.map(
      (s, i) =>
        `${i + 1}. NARRATION (context only): "${s.text}"` +
        (s.referenceEntity ? ` | REFERENCE ENTITY: ${s.referenceEntity}` : "") +
        (s.visualBrief ? ` | VISUAL BRIEF: ${s.visualBrief}` : ` | SCENE IDEA: ${s.imagePrompt}`),
    ),
  ]
    .filter(Boolean)
    .join("\n");

  let out: BuiltImagePrompts;
  try {
    out = await runAgent(
      "image_prompt_builder",
      "agentic",
      ctx,
      `build ${input.shots.length} image prompts`,
      async (model, modelId) => {
        const res = await generateObject({
          model,
          schema: builtImagePromptSchema,
          experimental_repairText: repairDoubleEncodedJson,
          temperature: temperatureFor(modelId, "editor"),
          system,
          prompt,
        });
        return { object: res.object, usage: res.usage };
      },
    );
  } catch {
    return draftPrompts; // fail-safe: builder trouble never blocks the render
  }
  if (out.prompts.length !== input.shots.length) return draftPrompts;
  const known = new Set((input.characters ?? []).map((c) => c.name));
  return out.prompts.map((p) => ({
    prompt: p.prompt,
    // only names the channel actually has — hallucinated casts are dropped
    character: p.character && known.has(p.character) ? p.character : null,
  }));
}
