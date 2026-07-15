import { generateObject } from "ai";
import { builtImagePromptSchema, type BuiltImagePrompts } from "@ytauto/core";
import { temperatureFor } from "@ytauto/providers";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "./run-agent";

export type ShotForPrompt = {
  text: string;
  /** the scriptwriter's draft visual idea (scene intent, kept as input) */
  imagePrompt: string;
  referenceEntity?: string | null;
  /** the writer's visual ASK for the section (2026-07-12) — the visual TREATMENT
   * (setting/framing/era/mood); the narration drives the literal subject */
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
     * into shots whose scene calls for them, by canonical description. The
     * "main"-role character is the channel's default on-screen presenter;
     * castMode "always" = a mascot that must appear in every shot. */
    characters?: { name: string; description: string; role?: string; castMode?: string }[];
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
    "- THE NARRATION DRIVES THE SUBJECT (2026-07-15 operator: a shot narrated about MUSEUMS " +
    "protecting documents rendered a WELDER — the brief leaked onto the wrong shot). The image " +
    "MUST depict the actual literal subject/action THIS shot's NARRATION is about: narration " +
    "about welding → welding; narration about museums protecting old documents → a museum / " +
    "archived documents. The VISUAL BRIEF describes the BEAT's headline visual, and a beat often " +
    "spans several sentences — so the brief may belong to a DIFFERENT sentence than this shot. " +
    "When the brief's subject and this shot's narration disagree, DEPICT THE NARRATION'S SUBJECT " +
    "and take only STYLE/setting/mood from the brief; NEVER render the brief's subject on a shot " +
    "whose narration has moved on to something else. Still: NEVER copy narration wording verbatim " +
    "and NEVER depict figurative language ('the workhorse of the fleet' must not produce a horse; " +
    "'a shot in the dark' is not a gun). Only literal, physical, era-plausible scene elements go " +
    "in the prompt. Because consecutive shots carry DIFFERENT narration slices, their images must " +
    "show DIFFERENT moments — never repeat one scene across a beat's shots.\n" +
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
    "- NO TWO ADJACENT SHOTS MAY LOOK ALIKE (2026-07-15 operator: consecutive " +
    "per-sentence frames came out nearly identical). Treat the shots as a moving " +
    "SEQUENCE: each frame must clearly differ from the one before it in composition, " +
    "shot scale (wide/medium/close-up/insert) AND angle. When several sentences " +
    "circle the SAME subject, deliberately change the view — cut in to a detail, pull " +
    "wide, switch to a reverse angle, feature a different element of the same scene, or " +
    "advance the action a beat — so no two frames read as the same picture twice.\n" +
    "- Build ONE 'Style: … Mood: …' suffix and end EVERY prompt with that exact same suffix; it " +
    "is the set's consistency anchor. When a CHANNEL VISUAL STYLE block is present it is the ONLY " +
    "style authority — build the suffix from IT (plus ART DIRECTION), include its style suffix " +
    "wording VERBATIM, and ignore any other style wording. Only without that block do you build " +
    "the suffix from the IMAGE STYLE line.\n" +
    "- The ART DIRECTION is the operator's standing instruction: honour it in every prompt.\n" +
    "- RECURRING CHARACTERS (when listed): the channel keeps named characters visually identical " +
    "across every video. IMPORTANT (2026-07-15 operator: the character was taking over the frame) " +
    "— the SCENE the narration describes always LEADS the prompt; the character is a PARTICIPANT " +
    "present WITHIN that scene, never its subject. Lead with the shot's action/subject, then place " +
    "the character in it (e.g. 'A welder joins two steel beams in a shower of sparks — <Name>, " +
    "<one short identity phrase>, works the torch'). Do NOT open with the character's full " +
    "description and do NOT build the scene around them. A character marked (every scene) is a " +
    "MASCOT — present in EVERY shot, but still inside the scene, not as a portrait. A character " +
    "marked (main) is the on-screen presenter — include them in shots that depict a person, " +
    "presenter, hands or a demonstration. When a character is present, set that shot's " +
    "\"character\" field to the EXACT name (that drives their reference sheet downstream, which is " +
    "what holds their exact look — so you need only a short identity phrase, not the whole " +
    "description). Establishing shots, diagrams, objects and pure archival moments stay " +
    "character-free with \"character\": null — but if a person appears, it should be the cast " +
    "character, never an anonymous generic figure.";

  const known = new Set((input.characters ?? []).map((c) => c.name));
  const header = [
    `NICHE: ${input.niche}`,
    `ORIENTATION: ${input.orientation === "portrait" ? "vertical 9:16" : "widescreen 16:9"}`,
    // the distilled style REPLACES the wizard-era free text (2026-07-15
    // operator report: the stale imageStyle diluted the bedded-down look)
    input.styleBlock ? "" : `IMAGE STYLE: ${input.imageStyle}`,
    input.artDirection ? `ART DIRECTION (operator): ${input.artDirection}` : "",
    input.styleBlock ?? "",
    input.characters?.length
      ? `RECURRING CHARACTERS:\n${input.characters
          .map((c) => {
            const tag =
              c.castMode === "always"
                ? " (every scene)"
                : ["25", "50", "75"].includes(c.castMode ?? "")
                  ? " (recurring)"
                  : (c.role ?? "main") === "main"
                    ? " (main)"
                    : ` (${c.role})`;
            return `- ${c.name}${tag}: ${c.description}`;
          })
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const shotLine = (s: ShotForPrompt, n: number) =>
    `${n}. NARRATION (drives this shot's subject): "${s.text}"` +
    (s.referenceEntity ? ` | REFERENCE ENTITY: ${s.referenceEntity}` : "") +
    (s.visualBrief ? ` | VISUAL BRIEF (treatment): ${s.visualBrief}` : ` | SCENE IDEA: ${s.imagePrompt}`);

  // Batch (2026-07-15): one all-shots call reverted the WHOLE video to raw beat
  // briefs whenever the model returned the wrong count. Small batches return the
  // right count far more reliably and tailor each shot better; a batch that still
  // mismatches degrades ONLY its own shots. Output length always == input length.
  const BATCH = 8;
  const results: BuiltShotPrompt[] = [];
  for (let start = 0; start < input.shots.length; start += BATCH) {
    const batch = input.shots.slice(start, start + BATCH);
    const draftBatch = draftPrompts.slice(start, start + BATCH);
    const userPrompt = [header, "SHOTS:", ...batch.map((s, j) => shotLine(s, j + 1))].join("\n");
    let out: BuiltImagePrompts | null = null;
    try {
      out = await runAgent(
        "image_prompt_builder",
        "agentic",
        ctx,
        `build ${batch.length} image prompts`,
        async (model, modelId) => {
          const res = await generateObject({
            model,
            schema: builtImagePromptSchema,
            experimental_repairText: repairDoubleEncodedJson,
            temperature: temperatureFor(modelId, "editor"),
            system,
            prompt: userPrompt,
          });
          return { object: res.object, usage: res.usage };
        },
      );
    } catch {
      out = null; // this batch falls back to its drafts; the rest still run
    }
    if (!out || out.prompts.length !== batch.length) {
      results.push(...draftBatch);
      continue;
    }
    for (const p of out.prompts) {
      results.push({
        prompt: p.prompt,
        // only names the channel actually has — hallucinated casts are dropped
        character: p.character && known.has(p.character) ? p.character : null,
      });
    }
  }
  return results;
}
