import { generateObject } from "ai";
import {
  claimExtractionSchema,
  claimVerificationSchema,
  episodeBriefSchema,
  sourceDiscoverySchema,
  type ClaimExtraction,
  type ClaimVerification,
  type EpisodeBrief,
  type SourceDiscovery,
} from "@ytauto/core";
import type { SourceStrategy } from "@ytauto/db";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "../run-agent";

/** Propose authoritative sources for one episode topic (agentic tier). */
export async function discoverSources(
  ctx: AgentCtx,
  input: { topic: string; angle: string; strategy: SourceStrategy },
): Promise<SourceDiscovery> {
  const prompt = [
    `TOPIC: ${input.topic}`,
    `ANGLE: ${input.angle}`,
    `PREFERRED SOURCE KINDS: ${input.strategy.preferredKinds.join(", ")}`,
    `AUTHORITATIVE DOMAINS: ${input.strategy.authoritativeDomains.join(", ") || "none specified"}`,
    `AVOID DOMAINS: ${input.strategy.avoidDomains.join(", ") || "none"}`,
  ].join("\n");
  return runAgent("source_discovery", "agentic", ctx, `discover sources for ${input.topic}`, async (model) => {
    const res = await generateObject({
      model,
      schema: sourceDiscoverySchema,
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:source-discovery — Propose the most authoritative fetchable sources for researching this topic. " +
        "Prefer the channel's authoritative domains; never propose avoided domains.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}

/** Extract atomic, checkable claims from fetched evidence (agentic tier). */
export async function extractClaims(
  ctx: AgentCtx,
  input: { topic: string; evidence: string[] },
): Promise<ClaimExtraction> {
  const prompt = [
    `TOPIC: ${input.topic}`,
    ...input.evidence.map((e, i) => `EVIDENCE ${i + 1}: ${e}`),
  ].join("\n\n");
  return runAgent("claim_extraction", "agentic", ctx, `extract claims for ${input.topic}`, async (model) => {
    const res = await generateObject({
      model,
      schema: claimExtractionSchema,
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:claims — Extract atomic, independently checkable factual claims from the evidence. " +
        "Tier each: established (settled fact), emerging (recent/unreplicated — will be attributed, " +
        "not asserted), contested (actively debated — present-the-debate mode).",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}

/** Does ONE evidence passage support ONE claim? (agentic tier, called per candidate) */
export async function verifyClaim(
  ctx: AgentCtx,
  input: { claim: string; evidence: string },
): Promise<ClaimVerification> {
  const prompt = [`CLAIM: ${input.claim}`, `EVIDENCE: ${input.evidence}`].join("\n");
  return runAgent("claim_verification", "agentic", ctx, `verify: ${input.claim.slice(0, 80)}`, async (model) => {
    const res = await generateObject({
      model,
      schema: claimVerificationSchema,
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:verify — Decide strictly whether the evidence passage supports the claim. " +
        "Paraphrase counts; missing or contradicting substance does not. Quote the supporting passage.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}

/** Verified claims → the episode brief the scriptwriter is grounded in (frontier). */
export async function writeEpisodeBrief(
  ctx: AgentCtx,
  input: {
    topic: string;
    angle: string;
    claims: { id: string; tier: string; text: string }[];
  },
): Promise<EpisodeBrief> {
  const prompt = [
    `TOPIC: ${input.topic}`,
    `ANGLE: ${input.angle}`,
    ...input.claims.map((c) => `CLAIM ${c.id} [${c.tier}]: ${c.text}`),
  ].join("\n");
  return runAgent("episode_brief", "frontier", ctx, `brief for ${input.topic}`, async (model) => {
    const res = await generateObject({
      model,
      schema: episodeBriefSchema,
      experimental_repairText: repairDoubleEncodedJson,
      system:
        "TASK:brief — Turn the claims into an episode brief. Every factual outline point " +
        "must cite its claim id. Attributed claims are framed as reported/claimed, never asserted. " +
        "Claims tagged [conjecture] are uncorroborated: frame them as legend/debate/unknown " +
        "('the story goes', 'no one knows') — the mystery is a feature, lean into it, never assert it.",
      prompt,
    });
    return { object: res.object, usage: res.usage };
  });
}
