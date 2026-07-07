import { generateObject } from "ai";
import {
  charterProposalSchema,
  identityProposalsSchema,
  type CharterProposal,
  type IdentityProposals,
} from "@ytauto/core";
import { runAgent, type AgentCtx } from "../run-agent";

/**
 * Charter co-creation (build #5 wizard, frontier tier): niche + operator
 * intent → a draft charter (mission, objectives, source strategy,
 * verification bar) plus ChannelDNA defaults the operator edits before create.
 * Pure: the wizard action persists the result.
 */
export async function proposeCharter(
  ctx: AgentCtx,
  input: {
    niche: string;
    intent: string;
    /** "short" | "long" | "both" — shapes cadence/length expectations */
    format?: string;
    /** "standard" | "deep" — deep raises the corroboration bar */
    researchDepth?: string;
    /** default true: keep the charter advertiser-friendly */
    monetisationSafe?: boolean;
  },
): Promise<CharterProposal> {
  const format = input.format ?? "short";
  const formatLabel =
    format === "long"
      ? "long-form (multi-minute) YouTube videos"
      : format === "both"
        ? "both YouTube Shorts and long-form videos"
        : "YouTube Shorts";
  const deep = (input.researchDepth ?? "deep") === "deep";
  const monetisationSafe = input.monetisationSafe ?? true;
  const prompt = [
    `NICHE: ${input.niche}`,
    `INTENT: ${input.intent}`,
    `FORMAT: ${formatLabel}`,
    `RESEARCH DEPTH: ${
      deep
        ? "deep — prefer >=3 independent authoritative sources and run present-the-debate mode on contested claims"
        : "standard — >=2 independent sources is acceptable"
    }`,
    monetisationSafe
      ? "The charter MUST stay advertiser-friendly / monetisation-safe."
      : "Monetisation-safety is a soft preference, not a hard constraint.",
    `Design the charter for a faceless, evergreen channel producing ${formatLabel} in this niche.`,
  ].join("\n\n");
  return runAgent("charter_proposal", "frontier", ctx, `propose charter for ${input.niche}`, async (model) => {
    const res = await generateObject({
      model,
      schema: charterProposalSchema,
      system:
        "TASK:charter — You design channel charters for autonomous faceless YouTube channels. " +
        "The charter must be evergreen, corroboratable from authoritative sources, and monetisation-safe. " +
        "Verification bar: established facts need >=2 independent sources; contested history runs present-the-debate mode.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}

/**
 * AI-proposed channel identity (name + @handle + text-only avatar concept).
 * The operator picks/edits one and applies it BY HAND when creating the
 * YouTube channel — title/handle/avatar are not settable via API (BACKLOG #5).
 */
export async function proposeIdentity(
  ctx: AgentCtx,
  input: {
    niche: string;
    mission: string;
    /** free-text steer for a re-roll, e.g. "punchier", "avoid puns" */
    instructions?: string;
    /** names already shown — return three fresh, distinct options */
    avoid?: string[];
  },
): Promise<IdentityProposals> {
  const prompt = [
    `NICHE: ${input.niche}`,
    `MISSION: ${input.mission}`,
    input.instructions ? `OPERATOR STEER: ${input.instructions}` : "",
    input.avoid?.length
      ? `ALREADY SHOWN (do NOT repeat or lightly reword these): ${input.avoid.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return runAgent("identity_proposal", "frontier", ctx, `propose identity for ${input.niche}`, async (model) => {
    const res = await generateObject({
      model,
      schema: identityProposalsSchema,
      system:
        "TASK:identity — Propose exactly 3 channel identity options (display name, @handle, text-only " +
        "avatar/banner concept). Names must be memorable, niche-evocative, and not infringe existing brands. " +
        "When an ALREADY SHOWN list is given, every option must be genuinely different from it.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}
