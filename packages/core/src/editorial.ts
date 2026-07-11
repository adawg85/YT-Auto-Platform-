import { z } from "zod";

/**
 * Editorial engine agent I/O (build #5). Same contract style as beats.ts:
 * every schema is what one agent produces via generateObject, so the mock LLM
 * can return schema-valid JSON deterministically.
 */

/**
 * Facts-gate default (build #18): an episode needs at least this many distinct
 * verified/attributed facts before it may be scripted — "no full scripts on 1
 * fact." Per-channel `verificationBar.minFactsToScript` overrides it; this is
 * the fallback for charters written before the field existed.
 */
export const DEFAULT_MIN_FACTS_TO_SCRIPT = 3;

/** Resolve the per-channel facts-gate bar, falling back to the default. */
export function minFactsToScript(bar: { minFactsToScript?: number } | null | undefined): number {
  const n = bar?.minFactsToScript;
  return typeof n === "number" && n >= 1 ? Math.floor(n) : DEFAULT_MIN_FACTS_TO_SCRIPT;
}

// ── Factuality tolerance (BACKLOG #21.3) ──────────────────────────────────

/**
 * Per-channel factuality mode: how hard the verification machinery gates.
 * - strict: science/finance/news — unsupported claims cut, thin episodes cut.
 * - balanced: history/mystery — plausible-but-uncorroborated material becomes
 *   CONJECTURE (tellable when framed as legend/debate/unknown), not cut.
 * - entertainment: fun channels — research feeds color; nothing is cut for
 *   lack of corroboration and the facts gate does not apply. Platform-safety
 *   and forbidden-topic checks are orthogonal and always run.
 */
export const factualityModeEnum = z.enum(["strict", "balanced", "entertainment"]);
export type FactualityMode = z.infer<typeof factualityModeEnum>;

export type VerificationBarLike = {
  establishedMinSources?: number;
  factualityMode?: FactualityMode | string | null;
} | null | undefined;

/**
 * Resolve a channel's factuality mode. Explicit setting wins; legacy charters
 * without one map deep-rigor bars (≥2 sources) to strict and everything else
 * to balanced (the migration default — see BACKLOG #21.3).
 */
export function resolveFactualityMode(bar: VerificationBarLike): FactualityMode {
  const m = bar?.factualityMode;
  if (m === "strict" || m === "balanced" || m === "entertainment") return m;
  return (bar?.establishedMinSources ?? 1) >= 2 ? "strict" : "balanced";
}

/** Does the "min facts before scripting" episode gate apply in this mode? */
export function factsGateApplies(mode: FactualityMode): boolean {
  return mode !== "entertainment";
}

/** Which claim dispositions count toward the facts gate in this mode. */
export function countsTowardFactsGate(
  status: "verified" | "attributed" | "conjecture" | "cut" | "unverified",
  mode: FactualityMode,
): boolean {
  if (status === "verified" || status === "attributed") return true;
  return status === "conjecture" && mode !== "strict";
}

// ── Charter + identity (channel setup wizard) ────────────────────────────

export const charterProposalSchema = z.object({
  mission: z.string().describe("One-paragraph mission: what this channel is and for whom"),
  objectives: z
    .array(z.string())
    .min(1)
    .describe(
      "Concrete objectives (aim for 2–5), e.g. 'reach 1k subs via Shorts discovery in 6 months'",
    ),
  archetype: z.enum(["evergreen_series", "monitor_digest", "reactive"]),
  sourceStrategy: z.object({
    preferredKinds: z.array(z.enum(["rss", "web", "youtube"])).min(1),
    authoritativeDomains: z
      .array(z.string())
      .describe("domains the verifier should treat as authoritative for this niche"),
    avoidDomains: z.array(z.string()),
  }),
  verificationBar: z.object({
    establishedMinSources: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe(
        "independent sources required before an established fact may be asserted — default 1; use 2 only for deep-rigor/contested niches (higher bars cut most facts)",
      ),
    presentDebateMode: z
      .boolean()
      .describe("contested claims: state mainstream + attribute alternatives, never assert"),
    minFactsToScript: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(DEFAULT_MIN_FACTS_TO_SCRIPT)
      .describe(
        "minimum distinct verified/attributed facts before an episode may be scripted — no full scripts on 1 fact; use a higher bar for long-form (~3 for Shorts, 6+ for long-form)",
      ),
    factualityMode: factualityModeEnum
      .optional()
      .describe(
        "how hard verification gates for THIS channel: strict (science/finance/news — cut what can't be corroborated), balanced (history/mystery — uncorroborated material survives as conjecture and must be framed as legend/debate/unknown), entertainment (fun channels — facts inspire, nothing is cut for lack of corroboration). Pick what fits the channel's intent.",
      ),
  }),
  factualityRationale: z
    .string()
    .optional()
    .describe("one line: why the chosen factualityMode fits this channel's niche and intent"),
  personaArchetype: z
    .enum(["documentary_narrator", "enthusiast_expert", "contrarian_analyst", "storyteller", "playful_explainer"])
    .optional()
    .describe(
      "the writing-persona archetype that would WORK for this channel: documentary_narrator (measured awe), enthusiast_expert (obsessed friend), contrarian_analyst (challenges received wisdom), storyteller (scenes, stakes, mystery), playful_explainer (fun-first)",
    ),
  personaRationale: z
    .string()
    .optional()
    .describe("one line: why this persona archetype fits this channel"),
  /** ChannelDNA defaults the wizard pre-fills (operator can edit before create) */
  dnaDefaults: z.object({
    tone: z.string(),
    audiencePersona: z.string(),
    hookStyles: z.array(z.string()).min(1).describe("reusable hook styles (aim for 2–4)"),
    forbiddenTopics: z.array(z.string()),
    imageStyle: z.string(),
    ctaTemplate: z.string(),
  }),
});
export type CharterProposal = z.infer<typeof charterProposalSchema>;

export const identityProposalsSchema = z.object({
  options: z
    .array(
      z.object({
        name: z.string().describe("channel display name"),
        handle: z.string().describe("@handle, lowercase, hyphenated, no spaces"),
        avatarConcept: z
          .string()
          .describe("text-only avatar/banner concept the operator can brief a designer or generator with"),
      }),
    )
    .min(1)
    .max(6)
    .describe("propose exactly 3 identity options"),
});
export type IdentityProposals = z.infer<typeof identityProposalsSchema>;

// ── Series planning ───────────────────────────────────────────────────────

export const seriesPlanSchema = z.object({
  title: z.string().describe("series title, e.g. 'Machines That Changed Flight'"),
  description: z.string().describe("what this arc covers and why now"),
  episodes: z
    .array(
      z.object({
        title: z.string(),
        angle: z.string().describe("one-sentence editorial angle for this episode"),
      }),
    )
    .min(6)
    .max(16)
    .describe("ordered episode topics; MUST exclude anything already covered"),
});
export type SeriesPlan = z.infer<typeof seriesPlanSchema>;

/**
 * Gap-fill replacement episode (BACKLOG #23.1): when an episode is cut in
 * research or its production fails, the planner proposes ONE replacement for
 * the vacated slot — same arc, materially distinct from every excluded title.
 */
export const replacementEpisodeSchema = z.object({
  title: z.string().describe("replacement episode title — materially distinct from all excluded titles"),
  angle: z.string().describe("one-sentence editorial angle for the replacement episode"),
});
export type ReplacementEpisode = z.infer<typeof replacementEpisodeSchema>;

/** Domain scout (wizard sources helper): authoritative reference domains for a niche. */
export const domainScoutSchema = z.object({
  domains: z
    .array(
      z.object({
        domain: z.string().describe("bare domain, e.g. archives.example.org — no scheme, no path"),
        why: z.string().describe("one line: why this domain is authoritative for the niche"),
      }),
    )
    .max(8),
});
export type DomainScout = z.infer<typeof domainScoutSchema>;

export const sourceDiscoverySchema = z.object({
  sources: z
    .array(
      z.object({
        kind: z.enum(["rss", "web", "youtube"]),
        name: z.string(),
        /** web/rss: the URL to fetch; youtube: leave empty */
        url: z.string().default(""),
        /** youtube: the search query; web/rss: leave empty */
        query: z.string().default(""),
      }),
    )
    .min(1)
    .max(5)
    .describe("authoritative sources for this episode topic"),
});
export type SourceDiscovery = z.infer<typeof sourceDiscoverySchema>;

// ── Claims + verification (tiered accuracy) ──────────────────────────────

export const claimTierEnum = z.enum(["established", "emerging", "contested"]);
export type ClaimTierValue = z.infer<typeof claimTierEnum>;

export const claimExtractionSchema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().describe("one atomic, checkable factual claim"),
        tier: claimTierEnum.describe(
          "established = settled fact; emerging = just-announced/unreplicated; contested = actively debated",
        ),
      }),
    )
    .min(1)
    .max(20),
});
export type ClaimExtraction = z.infer<typeof claimExtractionSchema>;

export const claimVerificationSchema = z.object({
  supported: z.boolean().describe("does this evidence passage actually support the claim?"),
  snippet: z
    .string()
    .describe("the exact passage that supports it (empty string if unsupported)"),
  reason: z.string(),
});
export type ClaimVerification = z.infer<typeof claimVerificationSchema>;

/**
 * The tiered-accuracy decision (BACKLOG #5, mode-aware since #21.3), pure so
 * it's unit-testable. Strict keeps the original binary behavior. Balanced adds
 * the CONJECTURE disposition: emerging/contested material with no surviving
 * corroboration is tellable when FRAMED as legend/debate/unknown rather than
 * cut ("conjecture is content" — unknowns are retention gold), and an
 * established claim one source short degrades to attributed instead of dying.
 * Entertainment never cuts for lack of corroboration.
 */
export function decideClaimStatus(
  tier: ClaimTierValue,
  distinctSupportingDomains: number,
  bar: { establishedMinSources: number; factualityMode?: FactualityMode | string | null },
): "verified" | "attributed" | "conjecture" | "cut" {
  const mode = resolveFactualityMode(bar);
  const verifiedBar = Math.max(1, bar.establishedMinSources);
  if (tier === "established") {
    if (distinctSupportingDomains >= verifiedBar) return "verified";
    if (mode === "strict") return "cut";
    if (distinctSupportingDomains >= 1) return "attributed";
    // an "established" claim NO source supports is an extraction artifact in
    // balanced mode; entertainment keeps it as conjecture (color, framed)
    return mode === "entertainment" ? "conjecture" : "cut";
  }
  if (distinctSupportingDomains >= 1) return "attributed";
  return mode === "strict" ? "cut" : "conjecture";
}

// ── Script factuality proof (BACKLOG #20) ─────────────────────────────────

/**
 * The scripting-stage factuality auditor's output: every specific factual
 * claim in the draft that the VERIFIED FACTS list does not support. Runs
 * inside the scripting stage with a bounded proof → rewrite loop, so a script
 * never leaves scripting asserting unsupported claims — assembly (the review
 * board) is no longer the first place one is caught, after the asset spend.
 */
export const factualityProofSchema = z.object({
  pass: z
    .boolean()
    .describe("true only when every specific factual claim is supported by the verified facts"),
  unsupportedClaims: z
    .array(
      z.object({
        claim: z.string().describe("the unsupported claim, quoted or closely paraphrased"),
        why: z.string().describe("why the verified facts do not support it"),
      }),
    )
    .describe("empty when pass is true"),
});
export type FactualityProof = z.infer<typeof factualityProofSchema>;

// ── Episode brief ─────────────────────────────────────────────────────────

export const episodeBriefSchema = z.object({
  summary: z.string().describe("2-3 sentence editorial summary of the episode"),
  hookAngle: z.string().describe("the strongest hook angle the verified facts support"),
  outline: z
    .array(
      z.object({
        point: z.string().describe("one beat-level point the script should make"),
        claimId: z
          .string()
          .default("")
          .describe("id of the verified claim this point rests on (empty if framing-only)"),
      }),
    )
    .min(3)
    .max(10),
});
export type EpisodeBrief = z.infer<typeof episodeBriefSchema>;

// ── Post-publish memory ───────────────────────────────────────────────────

export const coverageSummarySchema = z.object({
  summary: z
    .string()
    .describe("2-3 sentences: what we said and how it was framed (for continuity/dedup)"),
});
export type CoverageSummary = z.infer<typeof coverageSummarySchema>;

/** Which research chunks are clearly general (promote to channel scope). Conservative. */
export const memoryPromotionSchema = z.object({
  promoteIndexes: z
    .array(z.number().int().min(0))
    .describe("indexes of chunks that are clearly channel-general, NOT episode-specific"),
});
export type MemoryPromotion = z.infer<typeof memoryPromotionSchema>;
