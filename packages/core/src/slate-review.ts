/**
 * Slate reviewer (ticket 01KY2BJ9…): a BATCH check that runs on proposed ideas/
 * titles BEFORE they enter a channel's backlog — the cheapest gate in the whole
 * pipeline, one stage earlier than review_beat_map. Two failure classes it exists
 * to catch, both invisible to every per-video check:
 *   - a title/angle that violates a channel's OWN forbiddenTopics (an author
 *     rationalising against a constraint they wrote 30 min earlier), and
 *   - intra-slate repetition (five episodes of the same shape) that only surfaces
 *     weeks later as the fifth one halts.
 *
 * This module is the DETERMINISTIC core (structural clustering, duplicate
 * detection, keyword position, overclaim-verb scan) — the semantic forbiddenTopics
 * BLOCK and title-family conformance need an LLM and live in the agent layer, on
 * top of this. Mirrors beat-map.ts: pure, unit-testable, block/advise split.
 */

import { z } from "zod";

/** Same finding shape as the beat-map reviewer, so the tool returns one contract. */
export type SlateFinding = { rule: string; evidence: string };
export type SlateVerdict = "pass" | "advise" | "block";

/**
 * The semantic (LLM) layer's output: per-idea findings the deterministic checks
 * can't make — a forbiddenTopics violation phrased differently from the rule
 * ("Enoch's Calendar Has 364 Days" vs "mechanics of the luminaries"), an
 * overclaim that contradicts a stored rule, title-family drift, substance overlap.
 * severity "block" is reserved for constraint violations (forbiddenTopics /
 * overclaim-vs-rule); craft judgements are "advise".
 */
export const slateSemanticFindingSchema = z.object({
  index: z.number().int().describe("0-based index into the submitted slate"),
  severity: z.enum(["block", "advise"]),
  rule: z
    .string()
    .describe("short slug: forbidden_topic | overclaim_vs_rule | title_family_drift | substance_overlap"),
  evidence: z.string().describe("one sentence: what is wrong and which stored rule it hits"),
});
export const slateSemanticSchema = z.object({
  findings: z.array(slateSemanticFindingSchema),
});
export type SlateSemanticFinding = z.infer<typeof slateSemanticFindingSchema>;
export type SlateSemanticResult = z.infer<typeof slateSemanticSchema>;

export type SlateIdea = {
  title: string;
  /** one-line angle */
  angle?: string;
  /** optional intended arc/series, for context only */
  arc?: string;
};

export type TitleTemplate = {
  name: string;
  /** a description of the format, e.g. "claim about the text, then a withheld payoff" */
  pattern: string;
  example?: string;
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Assertive verbs that overclaim certainty — flagged for a contested-matter check. */
export const OVERCLAIM_PATTERNS: RegExp[] = [
  /\bprov(e|es|ed|en)\b/i,
  /\bconfirm(s|ed)?\b/i,
  /\bdebunk(s|ed)?\b/i,
  /\bdisprov(e|es|ed|en)\b/i,
  /\breveals? the truth\b/i,
  /\bexposes? the (truth|real)\b/i,
  /\bsettl(e|es|ed) the (debate|question)\b/i,
  /\bthe real reason\b/i,
  /\bdefinitiv(e|ely)\b/i,
];

const DISCOVERY_VERB = /\b(found|discovered|unearthed|dug up|uncovered|excavated|recovered|surfaced)\b/i;
const PAYOFF_TAIL = /(chang(e|es|ed) everything|rewrites?|will change|you won.?t believe|changes history|nobody expected)/i;

/**
 * A coarse structural fingerprint of a TITLE, so repeated shapes cluster even on
 * different subjects. Not the title's words — its SHAPE: how it opens, whether it
 * carries a discovery verb, and whether it ends on a withheld payoff.
 */
export function titleShape(title: string): string {
  const t = title.trim();
  const opensQuoted = /^["“']/.test(t);
  // opens on a claim about "the <thing>" vs a named subject/number
  const opensThe = /^(the|a|an)\b/i.test(t);
  const opensEntity = /^[A-Z][a-z]+/.test(t) && !opensThe;
  const opensNumber = /^\d/.test(t);
  const disc = DISCOVERY_VERB.test(t);
  const payoff = PAYOFF_TAIL.test(t);
  const open = opensQuoted ? "quote" : opensNumber ? "num" : opensThe ? "the" : opensEntity ? "entity" : "other";
  return `${open}|disc:${disc ? 1 : 0}|payoff:${payoff ? 1 : 0}`;
}

/**
 * Group the slate by title shape and flag any shape that appears too often — the
 * "manuscript found at location, changes everything ×5" failure. Threshold: a
 * shape used by > max(3, 20% of the slate) beats.
 */
export function structuralClusters(slate: SlateIdea[]): { shape: string; indices: number[] }[] {
  const byShape = new Map<string, number[]>();
  slate.forEach((idea, i) => {
    const s = titleShape(idea.title);
    const arr = byShape.get(s);
    if (arr) arr.push(i);
    else byShape.set(s, [i]);
  });
  const threshold = Math.max(3, Math.ceil(slate.length * 0.2));
  return [...byShape.entries()]
    .filter(([, idx]) => idx.length >= threshold)
    .map(([shape, indices]) => ({ shape, indices }));
}

/** Jaccard over normalized word sets — used for near-duplicate detection. */
export function titleSimilarity(a: string, b: string): number {
  const wa = new Set(norm(a).split(" ").filter(Boolean));
  const wb = new Set(norm(b).split(" ").filter(Boolean));
  if (wa.size === 0 && wb.size === 0) return 1;
  const inter = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : inter / union;
}

const DUP_THRESHOLD = 0.7;

/**
 * Whether one of the channel's SEARCH TERMS appears in the title, and roughly
 * where (front-loaded is best for search). ticket 01KY3B8N…: this takes the
 * operator's real search terms ("Book of Enoch", "Qumran"), NOT the niche
 * description string — matching the niche phrase fired on 26/27 titles and
 * carried no signal. A term can be multi-word ("book of enoch"); it matches if
 * the whole phrase appears, and is front-loaded if it starts within the first
 * ~4 words.
 */
export function keywordPosition(title: string, searchTerms: string[]): { present: boolean; frontLoaded: boolean } {
  const t = ` ${norm(title)} `;
  let best = -1;
  for (const term of searchTerms) {
    const phrase = norm(term);
    if (!phrase) continue;
    const at = t.indexOf(` ${phrase} `);
    if (at >= 0) {
      // words before the match = number of spaces in the prefix
      const wordsBefore = t.slice(0, at + 1).split(" ").filter(Boolean).length;
      if (best < 0 || wordsBefore < best) best = wordsBefore;
    }
  }
  return { present: best >= 0, frontLoaded: best >= 0 && best <= 3 };
}

/**
 * Run the deterministic slate checks. BLOCK on exact/near duplicates (against the
 * slate itself and any provided existing titles); ADVISE on structural clustering,
 * keyword position and overclaim verbs. Semantic forbiddenTopics + title-family
 * checks are added by the agent layer.
 */
export function reviewSlateDeterministic(
  slate: SlateIdea[],
  opts: {
    /** existing backlog + published titles to dedupe against */
    existingTitles?: string[];
    /** the channel's real audience search terms (from DNA searchTerms); unset → skip keyword checks */
    searchTerms?: string[];
    /** true when the channel declares titleTemplates — suppress cross-slate shape
     * clustering (conforming to a declared family is NOT the templating smell;
     * intra-family interchangeability is, and the agent layer flags that). */
    titleTemplatesDeclared?: boolean;
  } = {},
): { blockingFindings: SlateFinding[]; advisoryFindings: SlateFinding[] } {
  const blocking: SlateFinding[] = [];
  const advisory: SlateFinding[] = [];

  // BLOCK — duplicates within the slate.
  for (let i = 0; i < slate.length; i++) {
    for (let j = i + 1; j < slate.length; j++) {
      const sim = titleSimilarity(slate[i]!.title, slate[j]!.title);
      if (sim >= DUP_THRESHOLD) {
        blocking.push({
          rule: "intra_slate_duplicate",
          evidence: `Titles ${i} and ${j} are ${Math.round(sim * 100)}% similar ("${slate[i]!.title}" / "${slate[j]!.title}") — near-duplicate, cut one.`,
        });
      }
    }
  }
  // BLOCK — duplicates against the existing backlog / published titles.
  for (const existing of opts.existingTitles ?? []) {
    for (let i = 0; i < slate.length; i++) {
      const sim = titleSimilarity(slate[i]!.title, existing);
      if (sim >= DUP_THRESHOLD) {
        blocking.push({
          rule: "backlog_duplicate",
          evidence: `Title ${i} ("${slate[i]!.title}") is ${Math.round(sim * 100)}% similar to an existing idea ("${existing}") — already covered.`,
        });
      }
    }
  }

  // ADVISE — intra-slate structural clustering. Suppressed when the channel
  // declares titleTemplates: conforming to a declared family is expected, not the
  // templating smell (the agent flags intra-family interchangeability instead).
  if (!opts.titleTemplatesDeclared) {
    for (const cluster of structuralClusters(slate)) {
      advisory.push({
        rule: "structural_clustering",
        evidence: `${cluster.indices.length} titles share one shape (ideas ${cluster.indices.join(", ")}) — vary the title structure, or declare titleTemplates so families aren't flagged as templating.`,
      });
    }
  }

  // ADVISE — keyword position (only when the channel's search terms are set).
  if (opts.searchTerms && opts.searchTerms.length) {
    const buried: number[] = [];
    const missing: number[] = [];
    slate.forEach((idea, i) => {
      const kp = keywordPosition(idea.title, opts.searchTerms!);
      if (!kp.present) missing.push(i);
      else if (!kp.frontLoaded) buried.push(i);
    });
    if (missing.length) {
      advisory.push({
        rule: "keyword_missing",
        evidence: `Titles ${missing.join(", ")} don't contain the channel's niche term — they'll be hard to find in search.`,
      });
    }
    if (buried.length) {
      advisory.push({
        rule: "keyword_buried",
        evidence: `Titles ${buried.join(", ")} open on a person/event with the niche term buried later — front-load it for search.`,
      });
    }
  }

  // ADVISE — overclaim verbs (whether they CONTRADICT a stored rule is the agent's call).
  const overclaims: number[] = [];
  slate.forEach((idea, i) => {
    if (OVERCLAIM_PATTERNS.some((re) => re.test(idea.title))) overclaims.push(i);
  });
  if (overclaims.length) {
    advisory.push({
      rule: "overclaim_verb",
      evidence: `Titles ${overclaims.join(", ")} use an assertive certainty verb (proved/confirmed/reveals the truth). If the matter is contested under this channel's rules, soften it — the semantic check will BLOCK a hard contradiction.`,
    });
  }

  return { blockingFindings: blocking, advisoryFindings: advisory };
}

export function slateVerdict(r: { blockingFindings: unknown[]; advisoryFindings: unknown[] }): SlateVerdict {
  if (r.blockingFindings.length > 0) return "block";
  if (r.advisoryFindings.length > 0) return "advise";
  return "pass";
}
