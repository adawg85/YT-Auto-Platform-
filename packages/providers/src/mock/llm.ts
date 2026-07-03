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

function hookPick(user: string) {
  const ids = [...user.matchAll(/TEMPLATE id=(\S+)/g)].map((m) => m[1]!);
  const title = grab(/IDEA TITLE:\s*(.+)/, user) || "idea";
  const pick = ids.length ? ids[fnv1a(title) % ids.length]! : "unknown";
  return { templateId: pick, reason: `Mock pick: deterministic fit of "${title.slice(0, 40)}" to ${pick}.` };
}

function hookIngest(user: string) {
  const sources = [...user.matchAll(/OUTLIER:\s*(.+)/g)].map((m) => m[1]!.trim()).slice(0, 2);
  const archetypes = ["curiosity_gap", "pattern_interrupt", "stakes_first", "contrarian"] as const;
  return {
    templates: (sources.length ? sources : ["unknown outlier"]).map((src) => ({
      name: `Abstracted: ${src.slice(0, 40)}`,
      archetype: archetypes[fnv1a(src) % archetypes.length]!,
      first2s: `Open with the ${archetypes[fnv1a(src) % archetypes.length]!.replace("_", " ")} pattern observed in the source`,
      beatPlan: ["hook: abstracted opening", "stat: proof beat", "insight: mechanism beat", "cta: loop"],
      payoffPlacement: "payoff at ~65% of runtime",
      loopOrCta: "loop back to the hook claim",
      sourceRef: src,
    })),
  };
}

function trend(user: string) {
  const niche = grab(/NICHE:\s*(.+)/, user) || "general";
  const outliers = [...user.matchAll(/OUTLIER:\s*(.+?)\s*\(/g)].map((m) => m[1]!).slice(0, 2);
  return {
    suggestions: outliers.map((o, i) => ({
      title: `${niche}: the ${o.split(" ").slice(-2).join(" ")} angle everyone is copying`,
      angle: `Fast-lane replication of the rising "${o}" format with original ${niche} substance.`,
      trendRef: o,
      fitReason: `Mock DNA match #${i + 1}: format fits the channel's niche and tone.`,
    })),
  };
}

function thumbnailScore(user: string) {
  const candidate = grab(/CANDIDATE:\s*(.+)/, user) || "candidate";
  const ctr = Math.round((2 + detRand(candidate, "thumbctr") * 8) * 100) / 100;
  return {
    predictedCtr: ctr,
    critique: `Mock CTR model: ${ctr}% — contrast and focal clarity scored deterministically.`,
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
  if (system.includes("TASK:hook-pick")) return hookPick(user);
  if (system.includes("TASK:hook-ingest")) return hookIngest(user);
  if (system.includes("TASK:trend")) return trend(user);
  if (system.includes("TASK:thumbnail-score")) return thumbnailScore(user);
  return { note: "mock-llm fallback", echo: user.slice(0, 200) };
}

/**
 * Deterministic tool-calling for TASK:control so the conversational
 * assistant is demo-able with zero keys: a few phrase patterns map to tool
 * calls; a real LLM handles the full breadth.
 */
const CONTROL_PATTERNS: { re: RegExp; toolName: string; input: (m: RegExpMatchArray) => object }[] = [
  { re: /ingest|refresh analytics|pull stats/i, toolName: "run_analytics_ingest", input: () => ({}) },
  { re: /open alerts|show alerts|any alerts/i, toolName: "list_alerts", input: () => ({}) },
  { re: /pending|gates|to review/i, toolName: "list_pending_gates", input: () => ({}) },
  { re: /performance|how is|doing/i, toolName: "channel_performance", input: () => ({}) },
  { re: /scan.*trend|trend.*scan|fast lane/i, toolName: "run_trend_scan", input: () => ({}) },
  { re: /generate ideas/i, toolName: "generate_ideas", input: () => ({}) },
  { re: /channels/i, toolName: "list_channels", input: () => ({}) },
];

function controlTurn(prompt: unknown):
  | { kind: "tool"; toolName: string; input: object }
  | { kind: "text"; text: string } {
  const msgs = prompt as { role: string; content: unknown }[];
  const hasToolResult = msgs.some((m) => m.role === "tool");
  if (hasToolResult) {
    // second step: summarize the tool result deterministically
    const last = msgs[msgs.length - 1];
    const text = JSON.stringify(last?.content).slice(0, 400);
    return {
      kind: "text",
      text: `Done. Tool result (truncated): ${text}`,
    };
  }
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const userText =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : ((lastUser?.content as { type: string; text?: string }[]) ?? [])
          .map((p) => p.text ?? "")
          .join(" ");
  for (const p of CONTROL_PATTERNS) {
    const m = userText.match(p.re);
    if (m) return { kind: "tool", toolName: p.toolName, input: p.input(m) };
  }
  return {
    kind: "text",
    text:
      "Mock assistant: I route phrases like 'show alerts', 'pending gates', 'run analytics ingest', " +
      "'scan trends', 'generate ideas', 'channel performance', 'list channels' to platform tools. " +
      "Add an OpenRouter key for full natural-language control.",
  };
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
        const inputTokens = Math.ceil((system.length + user.length) / 4);

        if (system.includes("TASK:control")) {
          const turn = controlTurn(options.prompt);
          if (turn.kind === "tool") {
            return {
              content: [
                {
                  type: "tool-call" as const,
                  toolCallId: `mock-call-${fnv1a(user)}`,
                  toolName: turn.toolName,
                  input: JSON.stringify(turn.input),
                },
              ],
              finishReason: "tool-calls" as const,
              usage: { inputTokens, outputTokens: 20, totalTokens: inputTokens + 20 },
              warnings: [],
            };
          }
          return {
            content: [{ type: "text" as const, text: turn.text }],
            finishReason: "stop" as const,
            usage: { inputTokens, outputTokens: 60, totalTokens: inputTokens + 60 },
            warnings: [],
          };
        }

        const obj = route(system, user);
        const text = JSON.stringify(obj);
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
