/**
 * #77: the published DESCRIPTION's compliance furniture — the AI-content
 * disclosure and the image/music licence credits — as pure functions, so the
 * publish pipeline and the post-publish metadata editor assemble the SAME
 * blocks. Extracted from the worker's publish-preflight (which now calls
 * these): before this, editing a live description had no way to preserve the
 * credits, and dropping a CC-BY credit is a licence breach, not a formatting
 * nit.
 */

export type AssetCreditMeta = {
  entity?: string;
  source?: string;
  license?: string;
  attribution?: string;
} | null;

/** Credit every licensed reference image/clip, deduped by source page. */
export function imageCreditLines(metas: AssetCreditMeta[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of metas) {
    if (!m?.license || !m.source || seen.has(m.source)) continue;
    seen.add(m.source);
    const who = m.attribution ? `${m.attribution}, ` : "";
    lines.push(`• ${m.entity ? `${m.entity} — ` : ""}${who}${m.license}: ${m.source}`);
  }
  return lines;
}

export type MusicCreditRow = {
  name?: string | null;
  attribution?: string | null;
  license?: string | null;
  licenseUrl?: string | null;
  /** #110 Content ID follow-up: the rights holder's REQUIRED credit string —
   * when set it is emitted verbatim, in preference to everything else */
  requiredCredit?: string | null;
} | null;

/**
 * #110: the selected track's credit line — empty when nothing is required.
 *
 * Follow-up fix (the "Unraveling" defect): an audio-library track's stored
 * `attribution` is already the COMPLETE T.A.S.L. line — title, creator, source,
 * licence and deed URL in one string. The old builder prefixed the name and
 * appended the licence AGAIN around it, printing the title and licence twice
 * with a stray `).,` in between — which reads as broken to a viewer AND to the
 * rights administrator deciding a Content ID claim release. A self-contained
 * attribution is now emitted verbatim; composition only happens for legacy rows
 * whose attribution is just "Creator (page)". A rights-holder-required credit
 * format wins over both.
 */
export function musicCreditLines(row: MusicCreditRow): string[] {
  const required = row?.requiredCredit?.trim();
  if (required) return [`• ${required}`];
  if (!row?.license || !row.attribution) return [];
  const attribution = row.attribution.trim();
  // Self-contained line (audioAttributionLine output, or anything that already
  // names its own licence) → verbatim, never rebuilt alongside.
  if (/licensed under/i.test(attribution) || attribution.toLowerCase().includes(row.license.trim().toLowerCase())) {
    return [`• ${attribution}`];
  }
  return [
    `• ${row.name ? `"${row.name}" — ` : ""}${attribution}, ${row.license}${row.licenseUrl ? ` (${row.licenseUrl})` : ""}`,
  ];
}

/** YouTube's description hard limit is 5000 chars; we stop at 4900. */
export const DESCRIPTION_MAX_CHARS = 4900;

/**
 * Assemble the final published description: body, then (auto copy only) the
 * CTA + funnel block, then the AI disclosure, then the credit blocks. The
 * disclosure and credits are NON-OPTIONAL — any path that writes a description
 * to YouTube goes through here so they can't be edited away.
 */
export function assemblePublishDescription(opts: {
  body: string;
  /** true when the operator authored the body (owns its own CTA) */
  authored: boolean;
  ctaLine?: string;
  funnelLines?: string[];
  imageCredits: string[];
  musicCredits: string[];
}): string {
  return [
    opts.body,
    ...(opts.authored ? [] : ["", opts.ctaLine ?? "", ...(opts.funnelLines ?? [])]),
    "",
    "This video contains AI-generated content.",
    ...(opts.imageCredits.length ? ["", "Image credits:", ...opts.imageCredits] : []),
    ...(opts.musicCredits.length ? ["", "Music:", ...opts.musicCredits] : []),
  ]
    .join("\n")
    .slice(0, DESCRIPTION_MAX_CHARS);
}
