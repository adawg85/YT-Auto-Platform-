import { generateObject } from "ai";
import {
  BOARD_SEVERITY,
  boardCheckSchema,
  boardQualitySchema,
  boardVerdict,
  type BoardCheckerResult,
} from "@ytauto/core";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "./run-agent";

export type ReviewBoardInput = {
  idea: { title: string; angle: string };
  script: { hookText: string; fullText: string };
  dna?: {
    tone?: string | null;
    forbiddenTopics?: string[] | null;
  } | null;
  charter?: {
    mission: string;
    objectives: string[];
  } | null;
  /** the factuality gate's surviving claims — the only facts the script may assert */
  verifiedFacts: { id: string; tier: string; text: string }[];
  /** BACKLOG #21.3: conjecture claims (tellable only with hedged framing) */
  conjecture?: { id: string; text: string }[];
  /** BACKLOG #21.3: how hard the compliance checker polices facts */
  factualityMode?: "strict" | "balanced" | "entertainment";
  /** pattern-store grounding lines for the quality/retention checker */
  patternLines: string[];
};

export type ReviewBoardOutput = {
  results: BoardCheckerResult[];
  blocked: boolean;
  reason: string | null;
};

const SCRIPT_BLOCK = (input: ReviewBoardInput) =>
  [
    `IDEA TITLE: ${input.idea.title}`,
    `IDEA ANGLE: ${input.idea.angle}`,
    `HOOK: ${input.script.hookText}`,
    `SCRIPT: ${input.script.fullText}`,
  ].join("\n");

/**
 * The multi-checker pre-publish review board (build #5.2). Runs after the
 * variation check, before render. Each checker is an independent agent call
 * (each writes its own agent_actions evidence row via runAgent); the verdict
 * fold is pure. Hard-fail → the pipeline holds the production, same as the
 * factuality/variation gates.
 */
export async function runReviewBoard(
  ctx: AgentCtx,
  input: ReviewBoardInput,
): Promise<ReviewBoardOutput> {
  const results: BoardCheckerResult[] = [];

  // 1) compliance — forbidden topics + claims-match-sources (mode-aware #21.3)
  const forbidden = input.dna?.forbiddenTopics ?? [];
  const mode = input.factualityMode ?? "strict";
  const factsRule =
    mode === "entertainment"
      ? "This is an entertainment-first channel: do NOT police unsupported claims; fail a factual " +
        "issue only for a checkable real-world claim stated as fact that is likely false or " +
        "misleading and would be taken literally. "
      : mode === "balanced"
        ? "Fail a factual issue only when a claim is asserted AS ESTABLISHED FACT and is neither " +
          "backed by the VERIFIED FACTS list nor hedged; material framed as legend/debate/unknown " +
          "(including the CONJECTURE list) passes with that framing. "
        : "Fail if the script asserts specific factual claims that are not backed by the VERIFIED " +
          "FACTS list (paraphrase is fine; new facts are not). ";
  const compliance = await runAgent(
    "board_compliance",
    "agentic",
    ctx,
    `review board: compliance check for "${input.idea.title}"`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: boardCheckSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:board-compliance — You are the compliance checker on a pre-publish review board. " +
          "Fail if the script touches a forbidden topic. " +
          factsRule +
          "AI disclosure is enforced in code — do not fail for it.",
        prompt: [
          SCRIPT_BLOCK(input),
          `FORBIDDEN TOPICS: ${forbidden.length ? forbidden.join("; ") : "(none)"}`,
          input.verifiedFacts.length
            ? `VERIFIED FACTS:\n${input.verifiedFacts.map((f) => `- [${f.tier}] ${f.text}`).join("\n")}`
            : "VERIFIED FACTS: (no factuality gate ran for this production)",
          input.conjecture?.length
            ? `CONJECTURE (allowed only with hedged framing):\n${input.conjecture.map((c) => `- ${c.text}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      return { object: res.object, usage: res.usage };
    },
  );
  results.push({ checker: "compliance", severity: BOARD_SEVERITY.compliance, ...compliance });

  // 2) charter/brand alignment — only meaningful when a charter exists
  const charterInput = input.charter;
  if (charterInput) {
    const alignment = await runAgent(
      "board_alignment",
      "agentic",
      ctx,
      `review board: charter alignment for "${input.idea.title}"`,
      async (model) => {
        const res = await generateObject({
          model,
          schema: boardCheckSchema,
          experimental_repairText: repairDoubleEncodedJson,
          system:
            "TASK:board-alignment — You are the brand-alignment checker on a pre-publish review board. " +
            "Fail if the script is off-mission for the channel charter or clashes with the channel tone.",
          prompt: [
            SCRIPT_BLOCK(input),
            `MISSION: ${charterInput.mission}`,
            `OBJECTIVES: ${charterInput.objectives.join("; ")}`,
            `TONE: ${input.dna?.tone ?? "(unspecified)"}`,
          ].join("\n\n"),
        });
        return { object: res.object, usage: res.usage };
      },
    );
    results.push({ checker: "alignment", severity: BOARD_SEVERITY.alignment, ...alignment });
  }

  // 3) platform safety — monetisation-safe, no medical/financial advice,
  // nothing graphic; independent of the channel's own forbidden list
  const safety = await runAgent(
    "board_safety",
    "agentic",
    ctx,
    `review board: platform safety for "${input.idea.title}"`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: boardCheckSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:board-safety — You are the platform-safety checker on a pre-publish review board. " +
          "Fail if the script risks YouTube monetisation or policy strikes: graphic violence or " +
          "gore, self-harm, medical or financial advice, harassment, or content sexualising or " +
          "endangering minors.",
        prompt: SCRIPT_BLOCK(input),
      });
      return { object: res.object, usage: res.usage };
    },
  );
  results.push({ checker: "safety", severity: BOARD_SEVERITY.safety, ...safety });

  // 4) quality / retention prediction — advisory; grounded in the pattern store
  const quality = await runAgent(
    "board_quality",
    "agentic",
    ctx,
    `review board: retention prediction for "${input.idea.title}"`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: boardQualitySchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:board-quality — You are the quality checker on a pre-publish review board. " +
          "Predict average % viewed for this Shorts script against what is currently working " +
          "in the niche (the PATTERNS block). Pass when the hook and structure track proven " +
          "patterns; fail (advisory) when they don't.",
        prompt: [
          SCRIPT_BLOCK(input),
          input.patternLines.length
            ? `PATTERNS (market shape — what's working in this niche now; the channel's own playbook evidence outranks these when they conflict):\n${input.patternLines.join("\n")}`
            : "PATTERNS: (no pattern data yet)",
        ].join("\n\n"),
      });
      return { object: res.object, usage: res.usage };
    },
  );
  results.push({
    checker: "quality",
    severity: BOARD_SEVERITY.quality,
    pass: quality.pass,
    reason: quality.reason,
    issues: [`predicted retention ${quality.predictedRetention.toFixed(0)}%`],
  });

  return { results, ...boardVerdict(results) };
}
