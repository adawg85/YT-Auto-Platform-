/**
 * Variation check (compliance §8.1): near-duplicate *substance* is blocked
 * before a production may reach `ready`. v1 approach: Jaccard similarity over
 * 3-word shingles of normalized substance fingerprints — pure TS,
 * deterministic, works identically with mock and real LLMs.
 */

export function normalizeFingerprint(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9| ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shingles(s: string, size = 3): Set<string> {
  const words = normalizeFingerprint(s).replace(/\|/g, " ").split(" ").filter(Boolean);
  const out = new Set<string>();
  if (words.length < size) {
    if (words.length > 0) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i <= words.length - size; i++) {
    out.add(words.slice(i, i + size).join(" "));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const s of a) if (b.has(s)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export const SIMILARITY_HARD_FAIL = 0.6;
export const SIMILARITY_BORDERLINE = 0.35;

export type VariationCheckResult = {
  verdict: "pass" | "borderline" | "fail";
  maxSimilarity: number;
  /** fingerprint of the closest prior production, if any */
  closest?: { productionId: string; similarity: number };
};

export function checkVariation(
  fingerprint: string,
  priors: { productionId: string; fingerprint: string }[],
): VariationCheckResult {
  const target = shingles(fingerprint);
  let max = 0;
  let closest: VariationCheckResult["closest"];
  for (const prior of priors) {
    const sim = jaccard(target, shingles(prior.fingerprint));
    if (sim > max) {
      max = sim;
      closest = { productionId: prior.productionId, similarity: sim };
    }
  }
  const verdict =
    max > SIMILARITY_HARD_FAIL ? "fail" : max >= SIMILARITY_BORDERLINE ? "borderline" : "pass";
  return { verdict, maxSimilarity: max, closest };
}

export type ExternalSimilarityResult = {
  verdict: "pass" | "borderline" | "fail";
  maxSimilarity: number;
  /** the scouted external video our text most resembles, if any */
  closest?: { externalId: string; title: string; similarity: number };
};

/**
 * Anti-clone check (build #4 compliance): compare a generated script's text
 * against ingested competitor transcripts. Pattern learning informs hook shape
 * and beat structure, never verbatim substance — so if a draft's shingles
 * overlap a scouted transcript past the hard-fail line, the same on_hold +
 * evidence-row mechanism as the intra-channel variation check applies.
 *
 * Longer bodies (full transcripts) make Jaccard over the whole set pessimistic,
 * so we compare against the shingle set of the external text directly.
 */
export function checkExternalSimilarity(
  text: string,
  externals: { externalId: string; title: string; transcript: string | null }[],
): ExternalSimilarityResult {
  const target = shingles(text);
  let max = 0;
  let closest: ExternalSimilarityResult["closest"];
  for (const ext of externals) {
    if (!ext.transcript) continue;
    const sim = jaccard(target, shingles(ext.transcript));
    if (sim > max) {
      max = sim;
      closest = { externalId: ext.externalId, title: ext.title, similarity: sim };
    }
  }
  const verdict =
    max > SIMILARITY_HARD_FAIL ? "fail" : max >= SIMILARITY_BORDERLINE ? "borderline" : "pass";
  return { verdict, maxSimilarity: max, closest };
}
