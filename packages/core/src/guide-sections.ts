/**
 * #129: the operating guide is served as ONE document by `get_guide`, which is
 * right for a session-start read and wrong for "remind me what this call
 * discards before I make it". Splitting it into addressable sections lets a
 * caller fetch the part that matters at the moment it matters
 * (`get_guide(section:'actions')`) instead of re-reading 1,400 lines.
 *
 * Pure + unit-tested here, in core, so the splitting/slugging rules are pinned
 * without pulling the cockpit's DB/MCP import chain into a test.
 */

export type GuideSection = {
  /** stable slug used as the `section` argument (e.g. "action-consequences") */
  key: string;
  /** the `## ` heading text, verbatim */
  title: string;
  /** the section body INCLUDING its heading line */
  body: string;
};

/**
 * Slug for a `## ` heading: lowercased, punctuation dropped, spaces to dashes,
 * and everything from the first em-dash/parenthesis onward discarded — guide
 * headings carry long parenthetical provenance ("Shots & motion — how many
 * images… (ticket 01KY25DN…)") that must not end up in the argument a caller
 * has to type. "Action consequences — what each call discards" → "action-consequences".
 */
export function guideSectionKey(title: string): string {
  const head = title.split(/\s+[—–-]{1,2}\s+|\s*\(/u)[0] ?? title;
  return head
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Split a guide markdown document on its `## ` headings. Content before the
 * first `## ` (the document's title + preamble) is returned as the `overview`
 * section, so a caller can fetch the framing without the whole document.
 */
export function guideSections(markdown: string): GuideSection[] {
  const lines = markdown.split("\n");
  const sections: GuideSection[] = [];
  let title = "overview";
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (!body) return;
    sections.push({ key: guideSectionKey(title), title, body });
  };
  for (const line of lines) {
    // `## ` only — `###` is a subheading INSIDE a section and must not split it.
    if (/^## (?!#)/.test(line)) {
      flush();
      title = line.replace(/^##\s+/, "").trim();
      buf = [line];
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

/** The section keys + titles, for the index a bare `get_guide()` returns. */
export function guideSectionIndex(markdown: string): { key: string; title: string }[] {
  return guideSections(markdown).map((s) => ({ key: s.key, title: s.title }));
}

/**
 * Resolve a caller's `section` argument, generously: exact key, case-insensitive,
 * a prefix of a key ("action" → "action-consequences"), or a substring of the
 * heading text ("consequences"). Returns null when nothing matches, so the tool
 * can answer with the index rather than silently serving the wrong section.
 */
export function findGuideSection(markdown: string, requested: string): GuideSection | null {
  const want = requested.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!want) return null;
  const sections = guideSections(markdown);
  // A caller types the word, not the slug — the documented argument is `actions`
  // while the heading reads "Action consequences — …". So also match a WORD of
  // the key, singular/plural-insensitively, before giving up. Ordered
  // most-specific first so an exact key is never beaten by a fuzzy match.
  const stem = want.replace(/s$/, "");
  const wordMatch = (key: string) =>
    key.split("-").some((w) => w === want || w === stem || w.startsWith(want) || w.startsWith(stem));
  return (
    sections.find((s) => s.key === want) ??
    sections.find((s) => s.key.startsWith(want)) ??
    sections.find((s) => s.key.includes(want)) ??
    sections.find((s) => wordMatch(s.key)) ??
    sections.find((s) => s.title.toLowerCase().includes(requested.trim().toLowerCase())) ??
    null
  );
}
