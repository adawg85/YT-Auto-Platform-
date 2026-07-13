import { z } from "zod";

/**
 * Learning loop policy (#21.5/#21.6) — pure functions, no DB. The retro agent
 * DECIDES from evidence; these gates decide WHICH evidence counts and WHEN
 * decisions are allowed, in code — a hot day-one video can never trigger a
 * playbook change because the retro's input query excludes unmatured videos.
 */

// ── #21.6 performance windows ───────────────────────────────────────────────

export type MaturitySignal = "retention" | "views";

/**
 * Days a video must age before its data counts toward decisions. Retention
 * shape stabilises earlier than view counts; long-form compounds slower.
 * Analytics keep ingesting from day one — the gate is on USING the data.
 */
export function maturityWindowDays(format: "short" | "long", signal: MaturitySignal): number {
  if (format === "long") return signal === "retention" ? 21 : 42;
  return signal === "retention" ? 14 : 28;
}

export function isVideoMatured(
  publishedAt: Date | string,
  format: "short" | "long",
  signal: MaturitySignal,
  now: Date = new Date(),
): boolean {
  const published = new Date(publishedAt).getTime();
  return now.getTime() - published >= maturityWindowDays(format, signal) * 86_400_000;
}

// ── #21.6 channel maturity phases ───────────────────────────────────────────

export type MaturityPhase = "warming" | "establishing" | "established";

export const MATURITY_PHASES: MaturityPhase[] = ["warming", "establishing", "established"];

/** warming until ≥12 matured videos AND ≥8 weeks since first publish;
 * established at ≥25 matured; operator override always wins. */
export function computeChannelMaturity(input: {
  firstPublishedAt: Date | string | null;
  maturedCount: number;
  override?: string | null;
  now?: Date;
}): MaturityPhase {
  const { override } = input;
  if (override && (MATURITY_PHASES as string[]).includes(override)) return override as MaturityPhase;
  const now = input.now ?? new Date();
  if (!input.firstPublishedAt) return "warming";
  const ageWeeks =
    (now.getTime() - new Date(input.firstPublishedAt).getTime()) / (7 * 86_400_000);
  if (input.maturedCount >= 25) return "established";
  if (input.maturedCount >= 12 && ageWeeks >= 8) return "establishing";
  return "warming";
}

/** Retro cadence per phase. Warming still RUNS retro but observe-only —
 * candidate observations are logged so nothing is lost, nothing is adopted. */
export function retroDue(
  phase: MaturityPhase,
  lastRetroAt: Date | string | null,
  now: Date = new Date(),
): { due: boolean; observeOnly: boolean } {
  const observeOnly = phase === "warming";
  const cadenceDays = phase === "established" ? 14 : 28;
  if (!lastRetroAt) return { due: true, observeOnly };
  const elapsed = now.getTime() - new Date(lastRetroAt).getTime();
  return { due: elapsed >= cadenceDays * 86_400_000, observeOnly };
}

// ── #21.5 playbook ──────────────────────────────────────────────────────────

/** Honesty guard: an adoption needs the same signal across at least this many
 * matured videos — enforced in code against the retro output, never trusted
 * from the model. */
export const MIN_ADOPTION_EVIDENCE = 3;
/** Adopted entries injected into prompts, capped by confidence. */
export const PLAYBOOK_PROMPT_CAP = 6;
/** Bounds per retro run so one noisy batch can't rewrite the channel. */
export const MAX_ADOPTIONS_PER_RETRO = 2;
export const MAX_EXPERIMENT_CANDIDATES_PER_RETRO = 2;
export const MAX_QUEUED_EXPERIMENTS = 5;

export type PlaybookEntryForPrompt = {
  scope: string;
  directive: string;
  why: string;
  confidence: number;
};

/**
 * The CHANNEL PLAYBOOK prompt block (#21.5): the channel's own adopted,
 * evidence-backed directives with the WHY attached, so the writer applies
 * them with intent. Precedence is stated explicitly (influence hierarchy):
 * facts > own evidence > market patterns.
 */
export function playbookPromptBlock(entries: PlaybookEntryForPrompt[]): string | null {
  if (entries.length === 0) return null;
  const top = [...entries]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, PLAYBOOK_PROMPT_CAP);
  return [
    "CHANNEL PLAYBOOK (learned from THIS channel's own published results — apply these",
    "deliberately; they outrank market patterns, but never override the verified facts):",
    ...top.map((e) => `- [${e.scope}] ${e.directive} — why: ${e.why}`),
  ].join("\n");
}

// ── retro agent output (#21.5) ──────────────────────────────────────────────

export const retroProposalSchema = z.object({
  adoptions: z
    .array(
      z.object({
        directive: z
          .string()
          .describe("one standing directive, imperative and concrete (e.g. 'open cold — no greeting, no channel intro')"),
        scope: z
          .enum(["hook", "pacing", "structure", "visual", "topic", "title"])
          .describe("which part of production this steers"),
        why: z.string().describe("the evidence-backed reason, one sentence"),
        evidenceVideoIds: z
          .array(z.string())
          .describe("publication ids (from the input list) showing this signal — at least 3 or the adoption is rejected"),
        confidence: z.number().describe("0-1: how strongly the evidence supports this"),
      }),
    )
    .describe("standing directives the evidence supports adopting (empty when nothing repeats)"),
  retirements: z
    .array(
      z.object({
        playbookId: z.string().describe("id of the existing playbook entry to retire"),
        why: z.string().describe("why its evidence has decayed or reversed"),
      }),
    )
    .describe("existing entries whose evidence no longer holds"),
  experimentCandidates: z
    .array(
      z.object({
        variable: z.string().describe("the ONE variable to test, e.g. 'hook_style'"),
        hypothesis: z.string(),
        baseline: z.string().describe("current setting being measured against"),
        variant: z.string(),
        directive: z.string().describe("the prompt line injected while the experiment runs"),
        priority: z.number().describe("1 = run next; larger = later"),
      }),
    )
    .describe("bigger swings that deserve a controlled experiment rather than a standing rule"),
  observations: z
    .string()
    .describe("2-3 sentences: what the data is starting to show (logged even when nothing is actionable)"),
});
export type RetroProposal = z.infer<typeof retroProposalSchema>;

/**
 * Code-side validation of the retro output (honesty guards): evidence ids
 * must come from the matured input set, ≥ MIN_ADOPTION_EVIDENCE per adoption,
 * bounded counts, clamped confidence.
 */
export function validateRetroProposal(
  proposal: RetroProposal,
  maturedPublicationIds: Set<string>,
  existingPlaybookIds: Set<string>,
): RetroProposal {
  const adoptions = proposal.adoptions
    .map((a) => ({
      ...a,
      evidenceVideoIds: [...new Set(a.evidenceVideoIds)].filter((id) =>
        maturedPublicationIds.has(id),
      ),
      confidence: Math.max(0, Math.min(1, a.confidence)),
    }))
    .filter((a) => a.evidenceVideoIds.length >= MIN_ADOPTION_EVIDENCE)
    .slice(0, MAX_ADOPTIONS_PER_RETRO);
  const retirements = proposal.retirements.filter((r) => existingPlaybookIds.has(r.playbookId));
  const experimentCandidates = proposal.experimentCandidates.slice(
    0,
    MAX_EXPERIMENT_CANDIDATES_PER_RETRO,
  );
  return { ...proposal, adoptions, retirements, experimentCandidates };
}
