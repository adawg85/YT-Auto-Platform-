import { generateObject } from "ai";
import {
  profileTweaksSchema,
  AI_TWEAKABLE_AXES,
  type ProfileTweaks,
} from "@ytauto/core";
import type { ProductionProfile } from "@ytauto/db";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "./run-agent";

/**
 * Per-video Production Profile tweaks (2026-07-12 operator ask). The channel
 * profile is a channel-wide default; THIS script may call for something
 * different — a dogfight story wants dramatic delivery, a WWII topic with
 * deep public-domain coverage wants the archival push turned up. This pass
 * reads the APPROVED script and either accepts the defaults or proposes
 * minimal tweaks, before any voice/visual money is spent. T0/T1 channels
 * review the proposal at a profile_review gate; T2/T3 auto-apply.
 *
 * Only the low-cost axes are proposable (rhythm, captions, music, delivery,
 * archivalStrength) — visualMode/motion carry cost cliffs and stay
 * operator-only. Callers treat a thrown error as "accept the defaults".
 */
export async function proposeProfileTweaks(
  ctx: AgentCtx,
  input: {
    scriptHook: string;
    scriptText: string;
    niche: string;
    contentFormat: string;
    channelProfile: ProductionProfile;
  },
): Promise<ProfileTweaks> {
  return runAgent(
    "profile_tweaker",
    "cheap",
    ctx,
    `per-video profile tweaks (${input.contentFormat})`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: profileTweaksSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          `TASK:profile-tweaks — You are the production director deciding how THIS video should be produced, given the channel's default production settings and this video's approved script. Accept the defaults unless the script clearly benefits from a change. You may only adjust: ${AI_TWEAKABLE_AXES.join(", ")}. Valid values — rhythm: sentence|section|pause · captions: on|off · music: off|subtle|standard · delivery: measured|warm|energetic|dramatic · archivalStrength: off|light|balanced|strong|max (how hard each shot hunts REAL archival photos before falling back to AI generation — push it up for historical/documentary subjects with rich public-domain coverage, down for abstract or contemporary topics with none). Propose AT MOST a few changes, each with a one-sentence why grounded in the script. If the defaults fit, set accept=true with an empty changes list.`,
        prompt: [
          `NICHE: ${input.niche}`,
          `FORMAT: ${input.contentFormat}`,
          `CHANNEL DEFAULTS: ${JSON.stringify({
            rhythm: input.channelProfile.rhythm,
            captions: input.channelProfile.captions ? "on" : "off",
            music: input.channelProfile.music,
            delivery: input.channelProfile.delivery,
            archivalStrength: input.channelProfile.archivalStrength ?? "balanced",
          })}`,
          "",
          `HOOK: ${input.scriptHook}`,
          "",
          "SCRIPT:",
          input.scriptText.slice(0, 6000),
        ].join("\n"),
      });
      return { object: res.object, usage: res.usage };
    },
  );
}
