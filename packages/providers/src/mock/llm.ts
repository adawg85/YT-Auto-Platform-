/**
 * Deterministic mock LLM for the AI SDK. Agents embed a `TASK:<name>` marker
 * in their system prompt; the mock routes on it and produces schema-valid
 * output derived from the prompt content, so the whole pipeline (including
 * the variation check) behaves realistically with zero API keys.
 */
import type { LanguageModelV2, LanguageModelV2CallOptions } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { defaultPersonaDoc, PERSONA_ARCHETYPES, type PersonaArchetype } from "@ytauto/core";
import type { LLMProvider, LLMTier } from "../types";
import { llmPrice } from "../pricing";
import { detPick, detRand, fnv1a } from "./hash";

const MOCK_MODEL_IDS: Record<LLMTier, string> = {
  cheap: "google/gemini-2.5-flash-lite",
  agentic: "qwen/qwen-max",
  frontier: "qwen/qwen-max",
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

function imageFit() {
  // Mock vision has no pixels to judge, so it passes references through (score
  // 8 ≥ IMAGE_FIT_MIN) — keeps the reference-image path exercised with zero keys.
  return { fits: true, score: 8, reason: "mock: assumed on-subject (no vision in mock mode)" };
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

const HOOK_ARCHETYPES = ["curiosity_gap", "pattern_interrupt", "stakes_first", "contrarian"] as const;

function hookAnalysis(user: string) {
  const hookLine = grab(/HOOK LINE:\s*(.+)/, user) || "the opening line";
  const hold = Number(grab(/3-SECOND HOLD:\s*(\d+)/, user) || "0");
  const channelAvg = Number(grab(/CHANNEL AVG % VIEWED:\s*(\d+)/, user) || "0");
  const archetype = HOOK_ARCHETYPES[fnv1a(hookLine) % HOOK_ARCHETYPES.length]!;
  const strongHold = hold >= 70;
  const beatsAvg = channelAvg > 0 && hold >= channelAvg;
  const archTag: Record<(typeof HOOK_ARCHETYPES)[number], string> = {
    curiosity_gap: "open-loop",
    pattern_interrupt: "cold-open",
    stakes_first: "high-stakes",
    contrarian: "contrarian-claim",
  };
  const tags = [
    strongHold ? "strong-3s-hold" : "soft-3s-hold",
    archTag[archetype],
    ...(beatsAvg ? ["above-channel-avg"] : []),
  ].slice(0, 5);
  return {
    archetype,
    tags,
    assessment:
      `Mock analysis: a ${archetype.replace("_", " ")} hook that held ${hold || "?"}% through the 3s cliff` +
      `${channelAvg ? ` versus the ${channelAvg}% channel average — ${beatsAvg ? "outperforming" : "trailing"} it` : ""}. ` +
      `The ${archTag[archetype]} technique ${strongHold ? "kept viewers past the swipe-away window" : "leaked some viewers early"}.`,
  };
}

function scriptAnalysis(user: string) {
  const matches = [
    ...user.matchAll(/\d+\.\s*(hook|stat|insight|cta)\s*@\s*[\d.]+-[\d.]+s\s*\(ret\s*(\d+|\?)%?\):\s*(.*)/g),
  ];
  const parsed = matches.map((m) => ({
    type: m[1] as "hook" | "stat" | "insight" | "cta",
    ret: m[2] === "?" ? null : Number(m[2]),
    summary: (m[3] ?? "").trim().slice(0, 120) || `${m[1]} beat`,
  }));
  const beats = (parsed.length ? parsed : [{ type: "hook" as const, ret: 100, summary: "hook beat" }]).map(
    (b) => ({
      type: b.type,
      summary: b.summary,
      working: b.ret == null ? true : b.ret >= 50,
    }),
  );
  // biggest consecutive retention drop → the dip
  let dipBeatIndex: number | null = null;
  let worstDrop = 0;
  for (let i = 1; i < parsed.length; i++) {
    const prev = parsed[i - 1]!.ret;
    const cur = parsed[i]!.ret;
    if (prev != null && cur != null && prev - cur > worstDrop) {
      worstDrop = prev - cur;
      dipBeatIndex = i;
    }
  }
  const weakType = dipBeatIndex != null ? parsed[dipBeatIndex]!.type : "insight";
  return {
    beats,
    strengths:
      "Mock analysis: clean hook→stat→insight→cta spine with a proof beat early; the structure front-loads the payoff.",
    trimSuggestion:
      worstDrop > 0
        ? `Retention drops ~${Math.round(worstDrop)} points into the ${weakType} beat — tighten it or cut a sentence to hold viewers through the dip.`
        : "Retention holds steady; consider extending the strongest insight beat before the CTA.",
    dipBeatIndex,
  };
}

const META_ARCH_TAG: Record<(typeof HOOK_ARCHETYPES)[number], string> = {
  curiosity_gap: "open-loop",
  pattern_interrupt: "cold-open",
  stakes_first: "high-stakes",
  contrarian: "contrarian-claim",
};

/** Meta-analysis hook extraction from a scouted transcript (build #4). */
function metaHook(user: string) {
  const transcript = grab(/TRANSCRIPT:\s*(.+)/, user) || grab(/TITLE:\s*(.+)/, user) || "opening line";
  const opener = transcript.split(/(?<=[.!?])\s/)[0] ?? transcript;
  const archetype = HOOK_ARCHETYPES[fnv1a(opener) % HOOK_ARCHETYPES.length]!;
  const label = META_ARCH_TAG[archetype];
  return {
    archetype,
    label,
    opener: `opens with a ${archetype.replace("_", " ")} pattern`,
    tags: [label, "external-scout", detPick(["strong-open", "fast-cut", "direct-address"], opener, "mt")].slice(0, 5),
  };
}

/** Meta-analysis script-structure extraction from a scouted transcript. */
function metaScript(user: string) {
  const title = grab(/TITLE:\s*(.+)/, user) || "video";
  const seq =
    fnv1a(title) % 2 === 0
      ? (["hook", "stat", "insight", "cta"] as const)
      : (["hook", "insight", "insight", "cta"] as const);
  return {
    beatSequence: [...seq],
    label: seq.join("→"),
    notes:
      "Mock meta-analysis: front-loads the payoff and loops back to the hook claim before the CTA.",
  };
}

/** Meta-analysis topic clustering over a batch of rising titles. */
function topicCluster(user: string) {
  const titles = [...user.matchAll(/^- (.+)$/gm)].map((m) => m[1]!.trim());
  const src = titles.length ? titles.slice(0, 5) : ["a rising angle"];
  return {
    signals: src.map((t) => ({
      label: t.split(" ").slice(0, 6).join(" "),
      angle: `Rising interest in "${t.slice(0, 60)}" — momentum building in the niche.`,
      momentum: 40 + (fnv1a(t) % 60),
    })),
  };
}

// ── Editorial engine (build #5) ──────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function charter(user: string) {
  const niche = grab(/NICHE:\s*(.+)/, user) || "general knowledge";
  const intent = grab(/INTENT:\s*(.+)/, user) || `evergreen ${niche} explainers`;
  return {
    mission: `A faceless, evergreen ${niche} channel: rigorously sourced stories told as tight Shorts, for viewers who want ${intent}.`,
    // Qualitative strategy lines only — publishing cadence / subscriber /
    // watch-hour targets are structured settings the operator sets in the wizard.
    objectives: [
      `Become the most trusted faceless storyteller in the ${niche} niche`,
      "Build a recognisable narrative voice that makes every episode instantly identifiable",
      "Zero factual corrections — every asserted fact is corroborated before it airs",
    ],
    archetype: "evergreen_series" as const,
    sourceStrategy: {
      preferredKinds: ["web" as const, "rss" as const],
      authoritativeDomains: ["mock-archive.example", "mock-reference.example", "wikipedia.org"],
      avoidDomains: ["forums.example"],
    },
    verificationBar: {
      establishedMinSources: 1,
      presentDebateMode: true,
      minFactsToScript: 3,
      factualityMode: /histor|myster|legend|lore/i.test(niche + intent)
        ? ("balanced" as const)
        : /fun|comedy|entertain|meme/i.test(niche + intent)
          ? ("entertainment" as const)
          : ("balanced" as const),
    },
    factualityRationale: `Mock: ${niche} reads as a framed-conjecture-friendly niche — unknowns are content.`,
    personaArchetype: /fun|comedy|entertain|meme/i.test(niche + intent)
      ? ("playful_explainer" as const)
      : ("documentary_narrator" as const),
    personaRationale: `Mock: measured, evidence-first narration fits ${niche}.`,
    dnaDefaults: {
      tone: `authoritative but vivid, documentary-style ${niche} storytelling`,
      audiencePersona: `curious adults who binge ${niche} explainers and documentaries`,
      hookStyles: ["curiosity_gap", "stakes_first", "contrarian"],
      forbiddenTopics: ["health advice", "financial advice", "current politics"],
      imageStyle: `archival-photography-inspired, high-contrast ${niche} illustration`,
      ctaTemplate: "Follow for the next episode.",
    },
  };
}

function identity(user: string) {
  const niche = grab(/NICHE:\s*(.+)/, user) || "general knowledge";
  const core = niche.replace(/\b(history|the)\b/gi, "").trim() || niche;
  const cap = core.replace(/\b\w/g, (c) => c.toUpperCase());
  const names = [`The ${cap} Files`, `${cap} Declassified`, `Lost ${cap} Archive`];
  return {
    options: names.map((name, i) => ({
      name,
      handle: `@${slugify(name)}`,
      avatarConcept: `${detPick(["Minimal line-art emblem", "Vintage archival stamp", "Bold monogram badge"], niche, `av${i}`)} on a ${detPick(["deep navy", "charcoal", "off-white"], niche, `bg${i}`)} field, evoking ${niche}.`,
    })),
  };
}

/** Aviation topic pool for the acceptance channel; generic fallback otherwise. */
const AVIATION_TOPICS = [
  "Concorde",
  "Boeing 707",
  "Supermarine Spitfire",
  "Tupolev Tu-144",
  "SR-71 Blackbird",
  "Lockheed Constellation",
  "Douglas DC-3",
  "A-10 Warthog",
  "De Havilland Comet",
  "Harrier Jump Jet",
  "B-52 Stratofortress",
  "F-14 Tomcat",
  "Hughes H-4 Hercules",
  "Messerschmitt Me 262",
] as const;

function seriesPlan(user: string) {
  const niche = grab(/NICHE:\s*(.+)/, user) || "general knowledge";
  const covered = [...user.matchAll(/^- (.+?) \(/gm)].map((m) => m[1]!.toLowerCase());
  const pool = /aviation|aircraft|plane|flight/i.test(niche)
    ? AVIATION_TOPICS.map(String)
    : Array.from({ length: 14 }, (_, i) => `${niche} case study ${i + 1}`);
  const topics = pool.filter((t) => !covered.some((c) => c.includes(t.toLowerCase()))).slice(0, 12);
  return {
    title: `${niche.replace(/\b\w/g, (c) => c.toUpperCase())}: Machines and Milestones`,
    description: `An ordered ${niche} arc — one story per episode, each built on corroborated records.`,
    episodes: topics.map((topic) => ({
      title: topic,
      angle: `The story of the ${topic}: how it entered service and why it mattered.`,
    })),
  };
}

/** Gap-fill (BACKLOG #23.1): one replacement episode, distinct from all excluded titles. */
function replaceEpisode(user: string) {
  const niche = grab(/NICHE:\s*(.+)/, user) || "general knowledge";
  const excluded = [...user.matchAll(/^- (.+)$/gm)].map((m) => m[1]!.trim().toLowerCase());
  const isExcluded = (t: string) =>
    excluded.some((c) => c.includes(t.toLowerCase()) || t.toLowerCase().includes(c));
  const pool = /aviation|aircraft|plane|flight/i.test(niche)
    ? AVIATION_TOPICS.map(String)
    : Array.from({ length: 30 }, (_, i) => `${niche} replacement study ${i + 1}`);
  const topic = pool.find((t) => !isExcluded(t)) ?? `${niche} replacement study ${excluded.length + 1}`;
  return {
    title: topic,
    angle: `The story of the ${topic}: the overlooked chapter that fills the gap in this arc.`,
  };
}

/** Wizard sources helper: deterministic authoritative-domain proposals. */
function domainScout(user: string) {
  const niche = grab(/NICHE:\s*(.+)/, user) || "general knowledge";
  const existing = (grab(/ALREADY LISTED[^:]*:\s*(.+)/, user) || "").toLowerCase();
  const slug = slugify(niche);
  const candidates = [
    { domain: `archive-${slug}.org`, why: `Mock scout: institutional archive covering ${niche}.` },
    { domain: `museum-${slug}.org`, why: `Mock scout: museum collection with primary records on ${niche}.` },
  ];
  return { domains: candidates.filter((c) => !existing.includes(c.domain)) };
}

function sourceDiscovery(user: string) {
  const topic = grab(/TOPIC:\s*(.+)/, user) || "general";
  const slug = slugify(topic);
  return {
    sources: [
      {
        kind: "web" as const,
        name: `mock-archive: ${topic}`,
        url: `https://mock-archive.example/${slug}`,
        query: "",
      },
      {
        kind: "web" as const,
        name: `mock-reference: ${topic}`,
        url: `https://mock-reference.example/${slug}`,
        query: "",
      },
      { kind: "youtube" as const, name: `youtube: ${topic}`, url: "", query: topic },
    ],
  };
}

/** Sentence markers the mock corpus plants (see mock/sources.ts). */
const CLAIM_MARKERS = ["entered service in", "units of the", "set a record of", "was retired in"];

function claimExtraction(user: string) {
  const sentences = [...new Set(user.split(/(?<=[.!?])\s+/).map((s) => s.trim()))];
  const claims: { text: string; tier: "established" | "emerging" | "contested" }[] = [];
  for (const s of sentences) {
    if (/a recent study claims/i.test(s)) {
      claims.push({ text: s, tier: "emerging" });
    } else if (CLAIM_MARKERS.some((m) => s.toLowerCase().includes(m))) {
      claims.push({ text: s, tier: "established" });
    }
  }
  if (claims.length === 0) {
    const fallback = sentences.filter((s) => s.length > 30).slice(0, 3);
    for (const s of fallback) claims.push({ text: s, tier: "established" });
  }
  return { claims: claims.slice(0, 20) };
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function claimVerify(user: string) {
  const claim = grab(/CLAIM:\s*(.+)/, user);
  const evidence = grab(/EVIDENCE:\s*([\s\S]+)/, user);
  const claimTokens = tokenize(claim);
  const evidenceTokens = new Set(tokenize(evidence));
  const supported =
    claimTokens.length > 0 && claimTokens.every((t) => evidenceTokens.has(t));
  const snippet = supported
    ? (evidence.split(/(?<=[.!?])\s+/).find((s) => {
        const st = new Set(tokenize(s));
        return claimTokens.every((t) => st.has(t));
      }) ?? evidence.slice(0, 200))
    : "";
  return {
    supported,
    snippet: snippet.trim(),
    reason: supported
      ? "Mock verifier: every claim token appears in this evidence passage."
      : "Mock verifier: the evidence does not contain the claim's substance.",
  };
}

function episodeBrief(user: string) {
  const topic = grab(/TOPIC:\s*(.+)/, user) || "the subject";
  const claimLines = [...user.matchAll(/^CLAIM (\S+) \[(\w+)\]:\s*(.+)$/gm)].map((m) => ({
    id: m[1]!,
    tier: m[2]!,
    text: m[3]!.trim(),
  }));
  const outline = claimLines.slice(0, 8).map((c) => ({
    point:
      c.tier === "established"
        ? c.text
        : `Attributed, not asserted: reports claim ${c.text.replace(/^A recent study claims\s*/i, "")}`,
    claimId: c.id,
  }));
  while (outline.length < 3) {
    outline.push({
      point: `Frame ${topic} inside the channel's larger arc and tease the next episode.`,
      claimId: "",
    });
  }
  const first = claimLines[0]?.text ?? `${topic} has a story most people have never heard.`;
  return {
    summary: `A tight retelling of ${topic}, built strictly on ${claimLines.length} verified or attributed claims.`,
    hookAngle: `Open on the most surprising verified fact: ${first}`,
    outline,
  };
}

function coverageSummary(user: string) {
  const topic = grab(/TOPIC:\s*(.+)/, user) || "the subject";
  const transcript = grab(/TRANSCRIPT:\s*([\s\S]+)/, user);
  const firstTwo = transcript.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  return {
    summary: `Covered ${topic} as a verified-facts story. Framing: ${firstTwo.slice(0, 240) || "hook-led retelling with corroborated claims."}`,
  };
}

function memoryPromotion(user: string) {
  const chunks = [...user.matchAll(/^CHUNK (\d+):\s*(.+)$/gm)];
  // conservative: only clearly-general material (the mock corpus marks surveys with "overview")
  const promote = chunks
    .filter((m) => /overview|in general|across the field/i.test(m[2]!))
    .map((m) => Number(m[1]));
  return { promoteIndexes: promote };
}

// ── Review board + check-ins (build #5.2) ────────────────────────────────

/** Deterministic compliance check: fail iff a forbidden topic appears in the script. */
function boardCompliance(user: string) {
  const script = `${grab(/HOOK:\s*(.+)/, user)} ${grab(/SCRIPT:\s*(.+)/, user)}`.toLowerCase();
  const raw = grab(/FORBIDDEN TOPICS:\s*(.+)/, user);
  const topics =
    raw && raw !== "(none)"
      ? raw
          .split(/[;,]/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      : [];
  const hits = topics.filter((t) => script.includes(t));
  return {
    pass: hits.length === 0,
    reason:
      hits.length === 0
        ? "Mock compliance: no forbidden topics touched; asserted facts trace to the verified list."
        : `Mock compliance: script touches forbidden topic(s): ${hits.join(", ")}.`,
    issues: hits.map((t) => `forbidden topic: ${t}`),
  };
}

/**
 * Alignment: a real LLM judges mission fit; the mock can't, so it passes
 * unless the script carries an explicit off-brand marker (which tests plant).
 */
const OFF_BRAND_MARKERS = /(off-brand|off brand|sponsored segment|unrelated to the channel)/i;

function boardAlignment(user: string) {
  const script = `${grab(/IDEA TITLE:\s*(.+)/, user)} ${grab(/HOOK:\s*(.+)/, user)} ${grab(/SCRIPT:\s*(.+)/, user)}`;
  const hit = OFF_BRAND_MARKERS.exec(script)?.[0];
  return {
    pass: !hit,
    reason: hit
      ? `Mock alignment: script drifts off the charter ("${hit}").`
      : "Mock alignment: script fits the charter mission and channel tone.",
    issues: hit ? [`off-brand content: ${hit}`] : [],
  };
}

const SAFETY_FLAGS = /(graphic violence|gore|suicide|self-harm|medical advice|financial advice)/gi;

function boardSafety(user: string) {
  const script = `${grab(/HOOK:\s*(.+)/, user)} ${grab(/SCRIPT:\s*(.+)/, user)}`;
  const hits = [...new Set([...script.matchAll(SAFETY_FLAGS)].map((m) => m[0]!.toLowerCase()))];
  return {
    pass: hits.length === 0,
    reason:
      hits.length === 0
        ? "Mock safety: monetisation-safe; no policy-risk content detected."
        : `Mock safety: policy-risk content detected: ${hits.join(", ")}.`,
    issues: hits.map((h) => `policy risk: ${h}`),
  };
}

function boardQuality(user: string) {
  const script = grab(/SCRIPT:\s*(.+)/, user) || "script";
  const hasPatterns = !user.includes("PATTERNS: (no pattern data yet)");
  const predicted = 45 + (fnv1a(script) % 40) + (hasPatterns ? 5 : 0);
  const pass = predicted >= 55;
  return {
    pass,
    predictedRetention: predicted,
    reason: `Mock quality: predicted ${predicted}% avg viewed ${hasPatterns ? "against niche patterns" : "without pattern priors"} — ${pass ? "tracks" : "trails"} what's working.`,
  };
}

function briefingCompose(user: string) {
  const channel = grab(/CHANNEL:\s*(.+?)\s*\(/, user) || "the channel";
  const published = grab(/PUBLISHED:\s*(.+)/, user) || "no publishing activity";
  const seriesLine = grab(/ACTIVE SERIES:\s*(.+)/, user);
  const noActiveExperiment = /ACTIVE EXPERIMENT:\s*none/.test(user);
  const suggestions: object[] = [
    {
      kind: "steer",
      label: "Keep the current arc on cadence",
      detail: `Mock steer: ${seriesLine && seriesLine !== "none" ? `continue ${seriesLine} without adding a second arc` : "approve the next proposed arc so research stays ahead of production"}.`,
    },
  ];
  if (noActiveExperiment) {
    suggestions.push({
      kind: "experiment",
      label: "Test contrarian-first hooks",
      detail:
        "Mock experiment proposal: the pattern store shows contrarian openers over-performing in this niche.",
      experiment: {
        variable: "hook_style",
        hypothesis: "Contrarian-claim openers will lift avg % viewed by holding the 0-3s window.",
        baseline: "current mixed hook styles",
        variant: "open every script with a contrarian claim",
        directive: "Open the script with a contrarian-claim hook that challenges the common assumption.",
      },
    });
  }
  return {
    whatHappened: `Mock briefing for ${channel}: ${published}.`,
    direction: "Hold the evergreen cadence, keep verification strict, and let the ramp finish before adding volume.",
    question: "Do you agree with the proposed direction and suggestions for the next period?",
    suggestions,
  };
}

function experimentConclude(user: string) {
  const variable = grab(/VARIABLE:\s*(.+)/, user) || "the variable";
  const verdict = grab(/VERDICT:\s*(.+)/, user) || "inconclusive";
  const readout = grab(/READOUT:\s*(.+)/, user);
  return {
    outcome: `Mock conclusion: the ${variable} experiment finished as a ${verdict}${readout ? ` — ${readout}` : ""}. ${
      verdict === "win"
        ? "Adopt the variant as the new channel default."
        : verdict === "loss"
          ? "Revert to the baseline and log the variant as disproven."
          : "Keep the baseline; re-test later with a larger sample."
    }`,
  };
}

/** Persona generator (BACKLOG #21.1): archetype seed specialised deterministically. */
function personaProposal(user: string) {
  const niche = grab(/NICHE:\s*(.+)/, user) || "general knowledge";
  const arch = grab(/ARCHETYPE:\s*(\w+)/, user);
  const archetype: PersonaArchetype = (PERSONA_ARCHETYPES as readonly string[]).includes(arch)
    ? (arch as PersonaArchetype)
    : "documentary_narrator";
  const doc = defaultPersonaDoc(archetype, niche);
  const tweak = grab(/TWEAK NOTES \(apply ONLY this change\):\s*(.+)/, user);
  if (tweak) doc.voiceRules = [...doc.voiceRules, `Tweak under test: ${tweak.slice(0, 120)}`];
  return {
    name: `${niche.replace(/\b\w/g, (c) => c.toUpperCase()).split(" ").slice(0, 2).join(" ")} ${archetype.split("_")[1] ?? "voice"}`,
    doc,
  };
}

/**
 * Humanize pass (BACKLOG #21): deterministic light edit — keeps beat count,
 * applies a recognisable spoken-register tweak so tests can assert the pass ran.
 */
function humanize(user: string) {
  const hook = grab(/HOOK:\s*(.+)/, user) || "the hook";
  const beatLines = [...user.matchAll(/^\d+\.\s*\[\w+\]\s*(.+)$/gm)].map((m) => m[1]!.trim());
  const spoken = (t: string) =>
    t
      .replace(/\bHere's the surprising part:/i, "And get this —")
      .replace(/\bIn fact,/gi, "Actually,")
      .replace(/\s+—\s+/g, ". ");
  return {
    hookText: spoken(hook),
    beats: (beatLines.length ? beatLines : [hook]).map((t) => ({ text: spoken(t) })),
    editNotes: "Mock humanize: broke an em-dash chain, loosened one constructed opener.",
  };
}

/** Image-prompt builder (BACKLOG #21): subject-first + lighting + shared suffix. */
function imagePromptBuild(user: string) {
  const style = grab(/IMAGE STYLE:\s*(.+)/, user) || "clean archival illustration";
  const art = grab(/ART DIRECTION \(operator\):\s*(.+)/, user);
  const suffix = `Style: ${style}${art ? `; ${art}` : ""}. Mood: focused, cinematic.`;
  const shots = [...user.matchAll(/^\d+\.\s*NARRATION:\s*"(.*?)"(?:\s*\|\s*REFERENCE ENTITY:\s*(.+?))?\s*\|\s*SCENE IDEA:\s*(.+)$/gm)];
  const lights = ["soft window light", "overcast diffuse daylight", "warm tungsten hangar light", "low golden-hour sun"];
  return {
    prompts: shots.map((m, i) => {
      const subject = (m[2] ?? m[3] ?? "the scene").trim();
      return {
        prompt: `${subject}, medium shot, ${lights[i % lights.length]}, 35mm film photograph with natural grain. ${suffix}`,
      };
    }),
    styleSuffix: suffix,
  };
}

/**
 * Scripting-stage factuality proof (#20; mock route was MISSING until the
 * first local E2E after that batch — the call fell through to the fallback
 * and schema-failed the whole pipeline). Deterministic: passes unless the
 * script plants the "unsupported-claim" marker (lets tests exercise the
 * proof → rewrite loop).
 */
function factualityProof(user: string) {
  const script = `${grab(/HOOK:\s*(.+)/, user)} ${grab(/SCRIPT:\s*(.+)/, user)}`;
  const planted = /unsupported-claim/i.test(script);
  return {
    pass: !planted,
    unsupportedClaims: planted
      ? [
          {
            claim: "planted unsupported-claim test marker",
            why: "asserts a fact that is not in the VERIFIED FACTS list",
          },
        ]
      : [],
  };
}

/**
 * Surgical factuality repair (scripting-loop incident fix): returns the input
 * beats VERBATIM, except any beat (or the hook) containing the planted
 * "unsupported-claim" marker gets that phrase removed — so the planted-marker
 * e2e story converges through the proof → repair → proof loop with zero keys.
 */
function scriptRepair(user: string) {
  const hook = grab(/HOOK:\s*(.+)/, user) || "the hook";
  const beatLines = [...user.matchAll(/^\d+\.\s*\[\w+\]\s*(.+)$/gm)].map((m) => m[1]!.trim());
  const strip = (t: string) =>
    t
      .replace(/unsupported-claim/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  return {
    hookText: strip(hook),
    beats: (beatLines.length ? beatLines : [hook]).map((t) => ({ text: strip(t) })),
  };
}

/** Portfolio strategist (BACKLOG #22): derive opportunities from the signals in the prompt. */
function opportunities(user: string) {
  const existing = (grab(/EXISTING NICHES[^:]*:\s*(.+)/, user) || "")
    .toLowerCase()
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && s !== "(none)");
  const known = (grab(/KNOWN OPPORTUNITIES[^:]*:\s*(.+)/, user) || "")
    .toLowerCase()
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && s !== "(none)");
  const cats = [...user.matchAll(/^- (.+?)(?: \(momentum (\d+)\))?(?: — e\.g\..*)?$/gm)]
    .map((m) => ({ label: m[1]!.trim().toLowerCase(), momentum: Number(m[2] ?? 60) }))
    .filter((c) => !c.label.includes("[") && !existing.includes(c.label) && !known.includes(c.label));
  const niches = cats.slice(0, 2).map((c) => ({
    kind: "niche" as const,
    label: c.label,
    summary: `Mock scout: "${c.label}" is heating up across the market with no coverage in the portfolio.`,
    suggestedNiche: c.label,
    suggestedIntent: `evergreen ${c.label} stories, one subject per episode`,
    momentum: c.momentum,
  }));
  return {
    opportunities: [
      ...niches,
      {
        kind: "topic" as const,
        label: "sealed and abandoned places",
        summary: "Mock scout: sealed/abandoned-place topics are pulling outlier views across several categories.",
        suggestedNiche: null,
        suggestedIntent: null,
        momentum: 68,
      },
      {
        kind: "style" as const,
        label: "silent pov builds",
        summary: "Mock scout: narration-free POV format is over-performing across niches — adaptable as a b-roll style.",
        suggestedNiche: null,
        suggestedIntent: null,
        momentum: 61,
      },
    ].filter((o) => !known.includes(o.label)),
  };
}

function route(system: string, user: string): unknown {
  if (system.includes("TASK:factuality-proof")) return factualityProof(user);
  // "TASK:script-repair".includes("TASK:script") — repair must route first
  if (system.includes("TASK:script-repair")) return scriptRepair(user);
  if (system.includes("TASK:opportunity")) return opportunities(user);
  if (system.includes("TASK:charter")) return charter(user);
  if (system.includes("TASK:identity")) return identity(user);
  if (system.includes("TASK:series-plan")) return seriesPlan(user);
  if (system.includes("TASK:replace-episode")) return replaceEpisode(user);
  if (system.includes("TASK:domain-scout")) return domainScout(user);
  if (system.includes("TASK:source-discovery")) return sourceDiscovery(user);
  if (system.includes("TASK:claims")) return claimExtraction(user);
  if (system.includes("TASK:verify")) return claimVerify(user);
  if (system.includes("TASK:board-compliance")) return boardCompliance(user);
  if (system.includes("TASK:board-alignment")) return boardAlignment(user);
  if (system.includes("TASK:board-safety")) return boardSafety(user);
  if (system.includes("TASK:board-quality")) return boardQuality(user);
  // "TASK:briefing".includes("TASK:brief") — briefing must route first
  if (system.includes("TASK:briefing")) return briefingCompose(user);
  if (system.includes("TASK:experiment-conclude")) return experimentConclude(user);
  if (system.includes("TASK:brief")) return episodeBrief(user);
  if (system.includes("TASK:coverage")) return coverageSummary(user);
  if (system.includes("TASK:memory-promote")) return memoryPromotion(user);
  if (system.includes("TASK:meta-hook")) return metaHook(user);
  if (system.includes("TASK:meta-script")) return metaScript(user);
  if (system.includes("TASK:topic-cluster")) return topicCluster(user);
  if (system.includes("TASK:ideation")) return ideation(user);
  if (system.includes("TASK:persona")) return personaProposal(user);
  if (system.includes("TASK:humanize")) return humanize(user);
  if (system.includes("TASK:image-prompt")) return imagePromptBuild(user);
  if (system.includes("TASK:scoring")) return scoring(user);
  if (system.includes("TASK:script-analysis")) return scriptAnalysis(user);
  if (system.includes("TASK:hook-analysis")) return hookAnalysis(user);
  if (system.includes("TASK:script")) return script(user);
  if (system.includes("TASK:similarity")) return similarityJudge(user);
  if (system.includes("TASK:hook-pick")) return hookPick(user);
  if (system.includes("TASK:hook-ingest")) return hookIngest(user);
  if (system.includes("TASK:trend")) return trend(user);
  if (system.includes("TASK:thumbnail-score")) return thumbnailScore(user);
  if (system.includes("TASK:image-fit")) return imageFit();
  if (system.includes("TASK:wizard")) return wizardAssistant(user);
  return { note: "mock-llm fallback", echo: user.slice(0, 200) };
}

/**
 * Mock wizard co-pilot: schema-valid {reply, patch} with zero keys. It applies
 * a tiny set of deterministic edits (e.g. "shorter mission") so the assistant
 * dock is demo-able offline; a real model handles the full breadth.
 */
function wizardAssistant(user: string): { reply: string; patch: Record<string, unknown> } {
  const askLine = user.split("OPERATOR:").pop()?.trim() ?? "";
  const patch: Record<string, unknown> = {};
  const ask = askLine.toLowerCase();
  if (/monetis|advertiser|brand.?safe/.test(ask)) patch.monetisationSafe = !/off|disable|no\b/.test(ask);
  if (/deep research|more research|rigor/.test(ask)) patch.researchDepth = "deep";
  if (/long.?form/.test(ask)) patch.format = "long";
  if (/short.?form/.test(ask)) patch.format = "short";
  const reply = Object.keys(patch).length
    ? `Mock co-pilot: applied ${Object.keys(patch).join(", ")}. Add an OpenRouter key for full natural-language edits.`
    : "Mock co-pilot: I can tweak simple fields (format, research depth, monetisation-safety) offline. Add an OpenRouter key for full natural-language edits.";
  return { reply, patch };
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
