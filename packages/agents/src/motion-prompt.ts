import { generateObject } from "ai";
import { motionPromptSchema, type MotionPrompt } from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "./run-agent";

/**
 * Motion-prompt writer (2026-07-15 operator ask). The i2v vendors animate a
 * still into a short clip; a fixed template ("subtle camera movement…") ignores
 * what is actually IN the frame, so clips barely move or move wrongly. This
 * vision agent looks at the real image being animated plus the shot's narration
 * and writes ONE tailored vendor prompt: what should move here (subject action +
 * secondary motion) and a gentle camera move, matched to the story moment.
 *
 * Cheap (vision) tier. Callers treat a thrown error as "use the template" —
 * animation must never fail because the prompt writer had trouble.
 */
export async function writeMotionPrompt(
  ctx: AgentCtx,
  input: {
    image: Uint8Array | Buffer;
    mimeType: string;
    /** the narration this shot covers — the moment the motion should serve */
    shotText: string;
    /** the scriptwriter's visual brief for the section, if any */
    visualBrief?: string | null;
    /** the recurring character present in the frame, if any */
    character?: string | null;
    /** operator's optional motion note ("slow push-in on the pendulum") */
    operatorNote?: string | null;
  },
): Promise<MotionPrompt> {
  return runAgent(
    "motion_prompt_writer",
    "cheap",
    ctx,
    "write i2v motion prompt",
    async (model) => {
      const res = await generateObject({
        model,
        schema: motionPromptSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:motion-prompt — You direct a short image-to-video clip. Look at the ATTACHED still and " +
          "write ONE vendor-ready motion prompt that brings THIS exact frame to life without changing what " +
          "it depicts. Rules:\n" +
          "- Describe the PRIMARY motion: what the main subject does (a gentle, believable action that suits " +
          "the frozen pose — never a new scene or a hard cut).\n" +
          "- Add SECONDARY motion actually visible in the image (drifting smoke/steam, flickering sparks or " +
          "flame, rippling water, blowing hair/cloth/foliage, shifting light/shadow, floating particles).\n" +
          "- Add ONE subtle CAMERA move (slow push-in, gentle pan/tilt, slight parallax) — small and cinematic, " +
          "never whip pans or fast zooms.\n" +
          "- Keep it calm and physically plausible; the clip is a few seconds and loops into the video. Match the " +
          "energy of the narration moment.\n" +
          "- POSITIVE phrasing only; NO on-screen text, captions, watermarks or morphing. Do not restate the " +
          "whole scene — just the motion. One or two sentences.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `NARRATION (the moment this frame serves): "${input.shotText}"` +
                  (input.visualBrief ? `\nSCENE BRIEF: ${input.visualBrief}` : "") +
                  (input.character ? `\nCHARACTER IN FRAME: ${input.character} (keep them on-model; animate them naturally)` : "") +
                  (input.operatorNote ? `\nOPERATOR MOTION NOTE (honour this): ${input.operatorNote}` : "") +
                  "\n\nWrite the motion prompt for animating the attached still.",
              },
              { type: "image", image: input.image, mediaType: input.mimeType },
            ],
          },
        ],
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
