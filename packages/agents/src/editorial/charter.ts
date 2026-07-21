import { generateObject } from "ai";
import {
  charterProposalSchema,
  identityProposalsSchema,
  type CharterProposal,
  type IdentityProposals,
} from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "../run-agent";

/**
 * The frontier model occasionally emits a charter that misses the tight
 * charterProposalSchema (an out-of-range source count, an off-enum value) —
 * more often under "deep" research depth, which nudges heavier output. ticket
 * 01KY294Y…: a SINGLE such miss hard-failed create_channel with "No object
 * generated: response did not match schema", because generateObject does NOT
 * retry a schema mismatch. Each attempt is an independent draw, so a couple of
 * retries turn a one-off formatting slip into a non-event.
 */
const CHARTER_MAX_ATTEMPTS = 3;
function isSchemaMiss(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /No object generated|did not match (the )?schema|response did not match/i.test(m);
}

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
  // Research-backed target guidance (docs/research/monetization-targets.md) so
  // the drafter proposes aggressive, revenue-optimised objectives — not the
  // conservative "just reach monetisation" default.
  const targetGuidance =
    format === "long"
      ? "TARGETS (long-form): propose ~6,000 subscribers AND ~14,000 watch hours in 12 months (YPP — 1,000 subs + 4,000 public watch hours — by ~month 6). Cadence 4-5 videos/week; length 10-15 min to unlock mid-roll ads (2-3x RPM). Include a 45%+ average-view-retention objective."
      : format === "both"
        ? "TARGETS (hybrid, 3 long + 2 Shorts/week): propose ~10,000 subscribers AND ~20,000 watch hours in 12 months (YPP by ~month 5-6). Shorts drive subscriber growth; long-form drives watch hours + revenue."
        : "TARGETS (Shorts): propose ~12,000 subscribers AND ~10M Shorts views in 12 months (YPP via the 10M-Shorts-views path by ~month 4). Cadence 10-15 Shorts/week. Shorts monetise ~20-30x LESS per view than long-form, so frame Shorts objectives as a growth/subscriber engine and recommend pairing with long-form for revenue.";
  const prompt = [
    `NICHE: ${input.niche}`,
    `INTENT: ${input.intent}`,
    `FORMAT: ${formatLabel}`,
    targetGuidance,
    "Use the TARGETS guidance to shape an AGGRESSIVE, monetisation-optimised STRATEGY (not merely 'reach monetisation'). Niche advertiser CPM is the biggest revenue lever — high-CPM niches (finance, AI, B2B) support more aggressive revenue strategies than low-CPM (entertainment, gaming). But express objectives as qualitative strategy lines — the numeric targets (cadence, subscriber counts, watch hours) are structured settings the operator sets separately.",
    `RESEARCH DEPTH: ${
      deep
        ? "deep — prefer >=2 independent authoritative sources and run present-the-debate mode on contested claims"
        : "standard — >=1 independent authoritative source is acceptable"
    }`,
    monetisationSafe
      ? "The charter MUST stay advertiser-friendly / monetisation-safe."
      : "Monetisation-safety is a soft preference, not a hard constraint.",
    `Design the charter for a faceless, evergreen channel producing ${formatLabel} in this niche.`,
  ].join("\n\n");
  return runAgent("charter_proposal", "frontier", ctx, `propose charter for ${input.niche}`, async (model) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= CHARTER_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await generateObject({
          model,
          schema: charterProposalSchema,
          experimental_repairText: repairDoubleEncodedJson,
          system:
            "TASK:charter — You design channel charters for autonomous faceless YouTube channels. " +
            "The charter must be evergreen, corroboratable from authoritative sources, and monetisation-safe. " +
            "Objectives must be AMBITIOUS and revenue-optimised in spirit (follow the TARGETS guidance), but QUALITATIVE strategy lines only — " +
            "never publishing cadence, subscriber counts, watch-hours, retention or view targets (those are structured settings the operator sets); " +
            "no numbers that duplicate settings. " +
            "Verification bar: established facts need >=1 independent authoritative source by default (2 for deep-rigor niches); contested history runs present-the-debate mode. " +
            "REASON about what WORKS for this specific channel, never default (BACKLOG #21.4): set " +
            "verificationBar.factualityMode (strict for science/finance/news where a wrong fact burns trust; " +
            "balanced for history/mystery niches where framed conjecture and 'no one knows' ARE the content; " +
            "entertainment for fun-first channels) plus factualityRationale, and pick the personaArchetype " +
            "whose voice best fits this niche + intent plus personaRationale — one line each.",
          prompt,
        });
        return { object: res.object, usage: res.usage };
      } catch (e) {
        // Only a schema miss is worth re-drawing; a real API/auth error should
        // surface immediately rather than burn three attempts.
        if (!isSchemaMiss(e) || attempt === CHARTER_MAX_ATTEMPTS) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
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
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:identity — Propose exactly 3 channel identity options (display name, @handle, text-only " +
        "avatar/banner concept). Names must be memorable, niche-evocative, and not infringe existing brands. " +
        "When an ALREADY SHOWN list is given, every option must be genuinely different from it.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}
