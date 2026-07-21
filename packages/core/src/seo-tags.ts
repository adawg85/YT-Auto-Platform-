/**
 * Fallback YouTube SEO tags (ticket 01KY1TQTWZ…). The old path was
 * `title.toLowerCase().split(/\s+/)` — naive tokenisation that kept punctuation
 * ("barrier:", "engine:"), lost every multi-word phrase ("sound barrier", "jet
 * engine", "Bell X-1"), and never added channel-level niche terms. This builds
 * real tags: the exact-title phrase, the channel niche, 2- and 3-word phrases
 * from the title, then meaningful single words — punctuation stripped, deduped,
 * and capped at YouTube's 500-character total tag budget.
 *
 * Only used when the author didn't supply tags (author_script /
 * set_publication_metadata authored tags still win).
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "vs", "with", "how", "why",
  "what", "that", "this", "is", "are", "was", "were", "by", "at", "as", "from", "its", "it",
  "their", "behind", "into", "over", "when", "who", "your", "you",
]);

const TOTAL_TAG_BUDGET = 500; // YouTube's combined tag-character limit
const MAX_TAGS = 15;

/** Strip punctuation → letters/numbers/spaces/hyphens only, collapsed. */
function clean(s: string): string {
  return s
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSeoTags(title: string, opts: { niche?: string; extra?: string[] } = {}): string[] {
  const cleanedTitle = clean(title);
  const words = cleanedTitle.split(" ").filter(Boolean);
  const lower = words.map((w) => w.toLowerCase());

  const tags: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (v.length < 2 || seen.has(v)) return;
    seen.add(v);
    tags.push(v);
  };

  // 1) exact-title phrase (strongest match signal) + channel niche
  if (cleanedTitle) add(cleanedTitle);
  if (opts.niche) {
    const n = clean(opts.niche);
    if (n) add(n);
  }

  // 2) 3- then 2-word phrases, skipping ones that start/end on a stopword
  for (const n of [3, 2]) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n);
      if (STOPWORDS.has(gram[0]!.toLowerCase()) || STOPWORDS.has(gram[n - 1]!.toLowerCase())) continue;
      add(gram.join(" "));
    }
  }

  // 3) meaningful single words
  for (const w of lower) {
    if (w.length > 3 && !STOPWORDS.has(w)) add(w);
  }

  // 4) caller-supplied extras (e.g. named entities from the script)
  for (const e of opts.extra ?? []) {
    const c = clean(e);
    if (c) add(c);
  }

  // Cap at YouTube's 500-char total (tags are comma-joined) and a sane count.
  const out: string[] = [];
  let total = 0;
  for (const t of tags) {
    const cost = t.length + 1; // +1 for the joining comma
    if (out.length >= MAX_TAGS || total + cost > TOTAL_TAG_BUDGET) break;
    out.push(t);
    total += cost;
  }
  return out;
}
