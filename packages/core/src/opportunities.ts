import { z } from "zod";

/**
 * Portfolio-level market opportunities (BACKLOG #22): what the global market
 * scan's strategist agent produces from cross-niche signals. Three kinds:
 * - niche: a trending territory where a NEW channel could work
 * - topic: a topic wave (rideable by an existing channel, or channel-worthy)
 * - style: a format/style visibly working that any channel could adopt
 */
export const opportunitiesSchema = z.object({
  opportunities: z
    .array(
      z.object({
        kind: z.enum(["niche", "topic", "style"]),
        label: z
          .string()
          .describe("terse lowercase identity, e.g. 'abandoned engineering' or 'silent pov builds'"),
        summary: z
          .string()
          .describe("1-2 sentences: what's moving, the evidence, and why it matters for the portfolio"),
        suggestedNiche: z
          .string()
          .nullable()
          .optional()
          .describe("kind=niche/topic: wizard-ready channel-niche phrasing"),
        suggestedIntent: z
          .string()
          .nullable()
          .optional()
          .describe("kind=niche: one-line channel intent for the setup wizard"),
        momentum: z.number().describe("0-100 heat, from signal strength"),
      }),
    )
    .max(8),
});
export type OpportunitiesOutput = z.infer<typeof opportunitiesSchema>;
