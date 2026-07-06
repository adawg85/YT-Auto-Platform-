import type { SourceConnector, SourceItem, SourceItemKind } from "../types";
import { fnv1a } from "./hash";

/**
 * Deterministic mock truth-sources (build #5). Designed so the tiered-accuracy
 * verification path is exercisable with zero keys:
 *
 * - The SAME key facts about a topic appear on BOTH mock domains, so an
 *   "established" claim finds >= 2 independent (distinct-domain) corroborations
 *   and gets VERIFIED.
 * - One fact (the "retired in ..." fact) appears ONLY on the first domain, so
 *   an established claim about it has 1 domain and gets CUT.
 * - One "recent study" sentence is worded as emerging, so the claim extractor
 *   tiers it emerging and it ends up ATTRIBUTED.
 *
 * A URL containing "broken" throws — exercising the source error-tracking path.
 */
export const MOCK_SOURCE_DOMAINS = [
  "mock-archive.example",
  "mock-reference.example",
] as const;

/** topic slug from a mock URL path, e.g. /concorde → "concorde" */
function topicFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const slug = path.split("/").filter(Boolean).pop() ?? "general";
    return slug.replace(/-/g, " ").toLowerCase();
  } catch {
    return "general";
  }
}

function det(topic: string, salt: string, min: number, span: number): number {
  return min + (fnv1a(topic + "|" + salt) % span);
}

/** The corroborated facts every mock domain agrees on for a topic. */
export function mockSharedFacts(topic: string): string[] {
  const year = det(topic, "year", 1930, 65);
  const count = det(topic, "count", 20, 480);
  const speed = det(topic, "speed", 400, 2100);
  return [
    `The ${topic} entered service in ${year}.`,
    `Only ${count} units of the ${topic} were ever produced.`,
    `The ${topic} set a record of ${speed} kilometers per hour.`,
  ];
}

/** Appears only on MOCK_SOURCE_DOMAINS[0] — the deliberately-uncorroborated fact. */
export function mockSingleDomainFact(topic: string): string {
  return `The ${topic} was retired in ${det(topic, "retired", 1960, 60)}.`;
}

/** Worded as unsettled so the extractor tiers it "emerging". */
export function mockEmergingFact(topic: string): string {
  return `A recent study claims the ${topic} influenced later designs far more than previously thought.`;
}

function articleBody(topic: string, domain: string): string {
  const facts = mockSharedFacts(topic);
  const parts = [
    `An overview of the ${topic}, compiled by ${domain} from primary records.`,
    ...facts,
    `Contemporary accounts describe the ${topic} as a turning point for its field.`,
  ];
  if (domain === MOCK_SOURCE_DOMAINS[0]) {
    parts.push(mockSingleDomainFact(topic));
    parts.push(mockEmergingFact(topic));
  }
  return parts.join(" ");
}

function itemId(prefix: string, seed: string): string {
  return `${prefix}-${(fnv1a(seed) % 9_000_000) + 1_000_000}`;
}

const FIXED_PUBLISHED_AT = "2026-06-15T00:00:00.000Z";

function makeConnector(kind: SourceItemKind): SourceConnector {
  return {
    kind,
    async fetchItems(config, opts): Promise<SourceItem[]> {
      const url = typeof config.url === "string" ? config.url : "";
      const query = opts?.query ?? (typeof config.query === "string" ? config.query : "");
      if (url.includes("broken")) throw new Error(`mock ${kind} fetch failed: ${url}`);

      if (kind === "youtube") {
        const topic = (query || "general").toLowerCase();
        const facts = mockSharedFacts(topic);
        return [0, 1].map((i) => {
          const id = itemId("yt", topic + i);
          return {
            externalId: id,
            url: `https://youtube.com/watch?v=${id}`,
            title: `${topic} — documentary part ${i + 1}`,
            content: `${topic} documentary. ${facts[i % facts.length]} Archival footage and interviews.`,
            publishedAt: FIXED_PUBLISHED_AT,
          };
        });
      }

      const topic = url ? topicFromUrl(url) : (query || "general").toLowerCase();
      const domain = url ? new URL(url).hostname : MOCK_SOURCE_DOMAINS[0];
      if (kind === "rss") {
        return [0, 1].map((i) => ({
          externalId: itemId("rss", domain + topic + i),
          url: `https://${domain}/${topic.replace(/ /g, "-")}/entry-${i + 1}`,
          title: `${topic} — feed entry ${i + 1}`,
          content: articleBody(topic, domain),
          publishedAt: FIXED_PUBLISHED_AT,
        }));
      }
      return [
        {
          externalId: itemId("web", domain + topic),
          url: url || `https://${domain}/${topic.replace(/ /g, "-")}`,
          title: `${topic} — ${domain}`,
          content: articleBody(topic, domain),
          publishedAt: FIXED_PUBLISHED_AT,
        },
      ];
    },
  };
}

export function createMockSourceConnectors(): Record<SourceItemKind, SourceConnector> {
  return {
    rss: makeConnector("rss"),
    web: makeConnector("web"),
    youtube: makeConnector("youtube"),
  };
}
