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
      .describe("independent sources required before an established fact may be asserted"),
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
  }),
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
 * The tiered-accuracy decision (BACKLOG #5), pure so it's unit-testable:
 * established facts need >= bar.establishedMinSources INDEPENDENT (distinct
 * domain) corroborations or they're cut; emerging/contested claims need >= 1
 * source and are attributed ("reported/claimed"), never asserted.
 */
export function decideClaimStatus(
  tier: ClaimTierValue,
  distinctSupportingDomains: number,
  bar: { establishedMinSources: number },
): "verified" | "attributed" | "cut" {
  if (tier === "established") {
    return distinctSupportingDomains >= Math.max(1, bar.establishedMinSources)
      ? "verified"
      : "cut";
  }
  return distinctSupportingDomains >= 1 ? "attributed" : "cut";
}

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
