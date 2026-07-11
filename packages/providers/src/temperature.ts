/**
 * Per-task sampling policy (BACKLOG #21 / prompt audit §4.5). Creative
 * generation wants diversity; judges want consistency. Applied per call site
 * via `temperatureFor(modelId, kind)` so vendor quirks stay in one place.
 */
export type PromptKind = "creative" | "editor" | "judge";

const KIND_TEMP: Record<PromptKind, number> = {
  /** script drafts, ideation, identity/persona proposals */
  creative: 0.9,
  /** humanize/rewrite passes — diverse but anchored to the draft */
  editor: 0.7,
  /** verification, compliance, scoring, similarity, image fit */
  judge: 0.2,
};

/**
 * Temperature for this model + task kind, or undefined to use the provider
 * default. OpenAI reasoning-family models (gpt-5*, o-series) reject
 * non-default temperatures — omit rather than 400 the whole agent call.
 */
export function temperatureFor(modelId: string, kind: PromptKind): number | undefined {
  if (/(^|[:/])(gpt-5|o\d)/i.test(modelId)) return undefined;
  return KIND_TEMP[kind];
}
