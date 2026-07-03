/**
 * Deterministic mock LLM for the AI SDK. Agents embed a `TASK:<name>` marker
 * in their system prompt; the mock routes on it and produces schema-valid
 * output derived from the prompt content, so the whole pipeline (including
 * the variation check) behaves realistically with zero API keys.
 */
import type { LanguageModelV2, LanguageModelV2CallOptions } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import type { LLMProvider, LLMTier } from "../types";
import { llmPrice } from "../pricing";
import { detPick, detRand, fnv1a } from "./hash";

const MOCK_MODEL_IDS: Record<LLMTier, string> = {
  cheap: "google/gemini-2.5-flash-lite",
  agentic: "anthropic/claude-sonnet-4.5",
  frontier: "anthropic/claude-opus-4.5",
};

type PromptText = { system: string; user: string };

function extractPrompt(prompt: unknown): PromptText {
  // LanguageModelV2 prompt: array of {role, content:[{type:'text',text}...]}
  let system = "";
  let user = "";
  for (const msg of prompt as { role: string; content: unknown }[]) {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : (msg.content as { type: string; text?: string }[])
            .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
            .join(" ");
    if (msg.role === "system") system += text + "\n";
    else if (msg.role === "user") user += text + "\n";
  }
  return { system, user };
}

function grab(re: RegExp, s: string): string {
  return re.exec(s)?.[1]?.trim() ?? "";
}

// ── Canned generators (must satisfy the zod schemas in @ytauto/core) ─────

const IDEA_PATTERNS = [
  ["Why %s is not what you think", "The counterintuitive mechanism behind %s."],
  ["The hidden cost of %s nobody measures", "%s has a second-order effect that flips the story."],
  ["%s: the 60-second version", "The one number that explains %s."],
  ["What %s reveals about your daily routine", "%s shows up in an everyday place you'd never expect."],
  ["The %s mistake almost everyone makes", "A common assumption about %s is measurably wrong."],
] as const;

function ideation(user: string) {
  const niche = grab(/NICHE:\s*(.+)/, user) || "everyday science";
  const keywords = grab(/KEYWORDS:\s*(.+)/, user);
  const seeds = (keywords || niche)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ideas = [];
  for (let i = 0; i < 5; i++) {
    const seed = seeds[i % seeds.length] ?? niche;
    const [titlePat, anglePat] = IDEA_PATTERNS[(fnv1a(seed + i) % IDEA_PATTERNS.length)]!;
    ideas.push({
      title: titlePat.replace("%s", seed),
      angle: anglePat.replace("%s", seed),
    });
  }
  return { ideas };
}

function scoring(user: string) {
  const title = grab(/IDEA TITLE:\s*(.+)/, user) || user.slice(0, 80);
  const axis = (name: string, base: number) => {
    const score = Math.round((base + detRand(title, name) * (9.5 - base)) * 10) / 10;
    return { score, rationale: `Deterministic mock assessment of "${name}" for: ${title.slice(0, 60)}` };
  };
  return {
    demand: axis("demand", 4),
    saturation: axis("saturation", 3),
    ghostNiche: axis("ghostNiche", 3),
    rpmPotential: axis("rpmPotential", 3),
    feasibilityCost: axis("feasibilityCost", 6),
    complianceRisk: axis("complianceRisk", 7),
    dnaFit: axis("dnaFit", 5),
  };
}

function script(user: string) {
  const title = grab(/IDEA TITLE:\s*(.+)/, user) || "a surprising fact";
  const angle = grab(/IDEA ANGLE:\s*(.+)/, user) || "there is more to it than you think";
  const style = grab(/IMAGE STYLE:\s*(.+)/, user) || "clean flat illustration";
  const cta = grab(/CTA:\s*(.+)/, user) || "Follow for more.";
  const revisionNote = grab(/REVISION NOTES:\s*(.+)/, user);
  const topic = title.replace(/[?.!]/g, "");

  const hookStyle = detPick(["question", "stakes", "contrarian"], title, revisionNote);
  const hookText =
    hookStyle === "question"
      ? `Ever wondered ${topic.toLowerCase()}? The real answer is stranger.`
      : hookStyle === "stakes"
        ? `Get this wrong and ${topic.toLowerCase()} will keep fooling you.`
        : `Everything you've heard about this is backwards: ${topic.toLowerCase()}.`;

  const statPct = 40 + (fnv1a(title) % 55);
  const beats = [
    { type: "hook" as const, text: hookText, imagePrompt: `${style}, dramatic close-up representing ${topic}` },
    {
      type: "stat" as const,
      text: `Here's the surprising part: in tests, about ${statPct} percent of people get this completely wrong.`,
      imagePrompt: `${style}, bold statistic graphic showing ${statPct}%`,
    },
    {
      type: "insight" as const,
      text: `${angle} That's the mechanism doing the real work here.`,
      imagePrompt: `${style}, diagram illustrating the mechanism behind ${topic}`,
    },
    {
      type: "insight" as const,
      text: `Once you see it, you'll notice it everywhere — ${topic.toLowerCase()} is just the most visible case.`,
      imagePrompt: `${style}, everyday scene where ${topic} appears`,
    },
    { type: "cta" as const, text: cta, imagePrompt: `${style}, channel outro card, bold text` },
  ];

  const fullText = beats.map((b) => b.text).join(" ");
  const facts = [`${statPct} percent get it wrong`, angle.toLowerCase(), `mechanism of ${topic.toLowerCase()}`];
  return {
    hookText,
    beats,
    fullText,
    substanceFingerprint: `${topic.toLowerCase()} | ${hookText.toLowerCase()} | ${facts.join(" | ")}`,
  };
}

function similarityJudge(user: string) {
  const sim = Number(grab(/JACCARD SIMILARITY:\s*([\d.]+)/, user) || "0");
  const similar = sim >= 0.5;
  return {
    similar,
    reason: similar
      ? `Mock judge: shingle similarity ${sim} indicates substantially overlapping substance.`
      : `Mock judge: shingle similarity ${sim} — overlapping phrasing but materially different substance.`,
  };
}

function route(system: string, user: string): unknown {
  if (system.includes("TASK:ideation")) return ideation(user);
  if (system.includes("TASK:scoring")) return scoring(user);
  if (system.includes("TASK:script")) return script(user);
  if (system.includes("TASK:similarity")) return similarityJudge(user);
  return { note: "mock-llm fallback", echo: user.slice(0, 200) };
}

export function createMockLLMProvider(): LLMProvider {
  function makeModel(tier: LLMTier): LanguageModel {
    const model: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "mock",
      modelId: `mock:${MOCK_MODEL_IDS[tier]}`,
      supportedUrls: {},
      async doGenerate(options: LanguageModelV2CallOptions) {
        const { system, user } = extractPrompt(options.prompt);
        const obj = route(system, user);
        const text = JSON.stringify(obj);
        const inputTokens = Math.ceil((system.length + user.length) / 4);
        const outputTokens = Math.ceil(text.length / 4);
        return {
          content: [{ type: "text" as const, text }],
          finishReason: "stop" as const,
          usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
          warnings: [],
        };
      },
      async doStream() {
        throw new Error("mock LLM does not implement streaming (use generate calls)");
      },
    };
    return model;
  }

  return {
    name: "mock-llm",
    model: makeModel,
    modelId: (tier) => MOCK_MODEL_IDS[tier],
    price: (tier) => llmPrice(MOCK_MODEL_IDS[tier]),
  };
}
