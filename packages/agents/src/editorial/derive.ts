import { generateObject } from "ai";
import { shortsDerivationSchema, type ShortsDerivation } from "@ytauto/core";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "../run-agent";

/**
 * Derive vertical Shorts from a long-form master (BACKLOG #6). Picks the
 * strongest self-contained moments from the master's verified script and writes
 * native-vertical Short scripts — reusing the master's facts (no new research),
 * so each derived Short is grounded exactly like its master. Frontier tier.
 */
export async function deriveShorts(
  ctx: AgentCtx,
  master: {
    title: string;
    angle: string;
    fullText: string;
    imageStyle?: string;
    ctaTemplate?: string;
  },
  count = 3,
): Promise<ShortsDerivation> {
  const prompt = [
    `MASTER TITLE: ${master.title}`,
    `MASTER ANGLE: ${master.angle}`,
    `MASTER SCRIPT (the ONLY source of facts — do not invent beyond it):\n${master.fullText}`,
    `IMAGE STYLE: ${master.imageStyle ?? "clean flat illustration, high contrast"}`,
    `Produce up to ${count} distinct Shorts, each spotlighting a DIFFERENT standout moment/fact from the master.`,
  ].join("\n\n");
  return runAgent(
    "shorts_derivation",
    "frontier",
    ctx,
    `derive shorts from ${master.title}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: shortsDerivationSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:derive-shorts — Turn a long-form master into self-contained vertical YouTube Shorts. " +
          "Each Short spotlights ONE standout moment or fact from the master, stands completely alone, and runs ~30-45s " +
          "on the hook→stat/insight→cta skeleton. Use ONLY facts present in the master script — never invent. " +
          "The CTA should nudge viewers to watch the full video. Each beat gets an imagePrompt in the given IMAGE STYLE. " +
          "substanceFingerprint must be 'topic | hook claim | fact1 | fact2 | fact3' — lowercase, terse, and DISTINCT per Short.",
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
