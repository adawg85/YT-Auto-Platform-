/**
 * Canonical registry of every runAgent call site (#21 routing, 2026-07-13).
 * The three tiers stay the DEFAULT routing; the operator can pin any single
 * agent to any model via the LLM_AGENT_MODELS JSON secret (per-agent
 * overrides panel on /account Models) — e.g. Opus for the scriptwriter only,
 * GPT/Gemini for checkers, without paying frontier prices everywhere.
 *
 * Keep this list in sync with `runAgent("<name>", "<tier>", …)` call sites in
 * packages/agents — an unlisted agent still works (it just can't be pinned
 * from the UI; the router applies overrides by name regardless).
 */
export type AgentTier = "cheap" | "agentic" | "frontier";

export type AgentInfo = {
  /** the exact name passed to runAgent (agent_actions.agent_name) */
  name: string;
  /** default tier the call site uses */
  tier: AgentTier;
  label: string;
};

export const AGENT_REGISTRY: AgentInfo[] = [
  // ── frontier: the expensive, quality-critical drafting ──
  { name: "scriptwriter", tier: "frontier", label: "Scriptwriter — per-video narration drafts" },
  { name: "episode_brief", tier: "frontier", label: "Episode brief writer (research → brief)" },
  { name: "series_planner", tier: "frontier", label: "Series arc planner" },
  { name: "gapfill_planner", tier: "frontier", label: "Gap-fill replacement episodes" },
  { name: "charter_proposal", tier: "frontier", label: "Charter drafter (channel wizard)" },
  { name: "identity_proposal", tier: "frontier", label: "Identity proposals (channel wizard)" },
  { name: "persona_generator", tier: "frontier", label: "Persona generator" },
  // ── agentic: checkers, analysis, editorial reasoning ──
  { name: "humanize_editor", tier: "agentic", label: "Humanize/editor pass (every draft)" },
  { name: "factuality_proof", tier: "agentic", label: "Script factuality auditor" },
  { name: "script_repair", tier: "agentic", label: "Surgical factuality repair" },
  { name: "scoring", tier: "agentic", label: "Idea scoring rubric" },
  { name: "board_compliance", tier: "agentic", label: "Review board — compliance" },
  { name: "board_alignment", tier: "agentic", label: "Review board — charter alignment" },
  { name: "board_safety", tier: "agentic", label: "Review board — platform safety" },
  { name: "board_quality", tier: "agentic", label: "Review board — quality (advisory)" },
  { name: "claim_extraction", tier: "agentic", label: "Research — claim extraction" },
  { name: "claim_verification", tier: "agentic", label: "Research — claim verification" },
  { name: "source_discovery", tier: "agentic", label: "Research — source discovery" },
  { name: "domain_scout", tier: "agentic", label: "Research — authoritative-domain scout" },
  { name: "hook_analysis", tier: "agentic", label: "Post-publish hook analysis" },
  { name: "script_analysis", tier: "agentic", label: "Post-publish script analysis" },
  { name: "hook_ingest", tier: "agentic", label: "Hook pattern ingestion" },
  { name: "wizard_assistant", tier: "agentic", label: "Wizard co-pilot" },
  { name: "briefing_compose", tier: "agentic", label: "Operator briefing composer" },
  { name: "experiment_conclude", tier: "agentic", label: "Experiment outcome narrator" },
  { name: "opportunity_scout", tier: "agentic", label: "Market opportunity scout" },
  { name: "eval_judge", tier: "agentic", label: "Eval harness judge (fixed instrument)" },
  { name: "channel_retro", tier: "agentic", label: "Learning loop — channel retro (#21.5)" },
  // ── cheap: bulk, low-stakes calls ──
  { name: "ideation", tier: "cheap", label: "Idea generation" },
  { name: "trend_scanner", tier: "cheap", label: "Trend scanner" },
  { name: "hook_picker", tier: "cheap", label: "Hook template picker" },
  { name: "variation_judge", tier: "cheap", label: "Anti-clone variation judge" },
  { name: "thumbnail_scorer", tier: "cheap", label: "Thumbnail scorer (vision)" },
  { name: "thumbnail_deconstructor", tier: "cheap", label: "Winning-thumbnail deconstruction (vision, #35.3)" },
  { name: "image_fit_scorer", tier: "cheap", label: "Reference-image fit scorer (vision)" },
  { name: "generated_image_checker", tier: "cheap", label: "Generated-image checker (vision)" },
  { name: "image_prompt_builder", tier: "cheap", label: "Image prompt builder" },
  { name: "profile_tweaker", tier: "cheap", label: "Per-video profile tweaks" },
  { name: "coverage_summary", tier: "cheap", label: "Post-publish coverage summary" },
  { name: "memory_scope", tier: "cheap", label: "Memory scope classifier" },
  { name: "meta_hook", tier: "cheap", label: "Market intel — hook extraction" },
  { name: "meta_script", tier: "cheap", label: "Market intel — structure extraction" },
  { name: "meta_topics", tier: "cheap", label: "Market intel — topic clustering" },
];

/** Parse the LLM_AGENT_MODELS JSON secret (tolerant: bad JSON → no overrides). */
export function parseAgentModelOverrides(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, v]) => typeof v === "string" && (v as string).trim().length > 0,
      ),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}
