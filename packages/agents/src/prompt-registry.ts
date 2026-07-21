/**
 * Agent prompt registry (ticket 01KY1X58…): a read-only index of every LLM the
 * platform runs — what it does, where its prompt lives, which model tier it
 * routes to, and whether it's compliance-relevant. Surfaced in the cockpit
 * (/prompts) and over MCP (get_agent_prompts) so an operator or Claude-in-chat
 * can see the agent surface for diagnosis and for auditing the
 * compliance-relevant agents without reading the code.
 *
 * MVP scope (per the ticket): READ-ONLY visibility. Full prompt-text viewing,
 * version history, diff-against-default and editing require centralising the
 * inline `system:` prompts out of each agent — a cross-agent refactor best done
 * with the operator present. This registry is hand-kept metadata (no drift risk:
 * it describes, it doesn't copy the prompt text) and points at the source file.
 */

export type AgentPromptInfo = {
  /** stable key */
  key: string;
  /** human name */
  name: string;
  /** what the agent does + the gist of its instruction */
  purpose: string;
  /** source file (relative to packages/agents/src) where the prompt lives */
  file: string;
  /** routing hint: which model tier this typically runs on */
  tier: "flagship" | "mid" | "cheap" | "vision" | "varies";
  /**
   * True for agents that are part of what protects the channels under YouTube's
   * inauthentic-content enforcement — their prompts should be auditable.
   */
  complianceRelevant: boolean;
  /**
   * True when the authored path (author_script with verbatim prompts) bypasses
   * this agent on most productions — lower editing priority.
   */
  bypassedWhenAuthored: boolean;
};

export const AGENT_PROMPTS: AgentPromptInfo[] = [
  { key: "scriptwriter", name: "Script writer", purpose: "Drafts the hook + beats from an idea, DNA and research.", file: "scriptwriter.ts", tier: "flagship", complianceRelevant: true, bypassedWhenAuthored: true },
  { key: "script-repair", name: "Script repair", purpose: "Fixes a drafted script that failed a check (length, banned topic, etc.).", file: "script-repair.ts", tier: "mid", complianceRelevant: false, bypassedWhenAuthored: true },
  { key: "profile-tweaks", name: "Production-profile proposer", purpose: "Proposes per-video profile overrides from the script.", file: "profile-tweaks.ts", tier: "mid", complianceRelevant: false, bypassedWhenAuthored: true },
  { key: "image-prompt", name: "Image-prompt builder", purpose: "Turns a beat into a subject-first image prompt.", file: "image-prompt.ts", tier: "mid", complianceRelevant: false, bypassedWhenAuthored: true },
  { key: "motion-prompt", name: "Motion/i2v prompt builder", purpose: "Writes the image-to-video motion prompt for an animated beat.", file: "motion-prompt.ts", tier: "mid", complianceRelevant: false, bypassedWhenAuthored: true },
  { key: "image-score", name: "Image fit scorer (vision)", purpose: "Vision-scores a sourced/generated image for fit to the beat.", file: "image-score.ts", tier: "vision", complianceRelevant: false, bypassedWhenAuthored: false },
  { key: "visual-director", name: "Visual director", purpose: "Cuts the script into shots on meaning and picks each shot's medium.", file: "visual-director.ts", tier: "flagship", complianceRelevant: false, bypassedWhenAuthored: false },
  { key: "review-board", name: "Review board", purpose: "Editorial/safety review of a production before it proceeds.", file: "review-board.ts", tier: "flagship", complianceRelevant: true, bypassedWhenAuthored: false },
  { key: "similarity-judge", name: "Anti-clone / variation check", purpose: "Judges whether a script is too similar to prior videos (substance axis).", file: "similarity-judge.ts", tier: "mid", complianceRelevant: true, bypassedWhenAuthored: false },
  { key: "factuality-proof", name: "Fact verification", purpose: "Verifies/attributes factual claims against retrieved sources.", file: "factuality-proof.ts", tier: "flagship", complianceRelevant: true, bypassedWhenAuthored: false },
  { key: "ideation", name: "Idea generation / editorial planner", purpose: "Generates channel ideas; the source of the reported near-duplicate slop.", file: "ideation.ts", tier: "flagship", complianceRelevant: false, bypassedWhenAuthored: false },
  { key: "scoring", name: "Idea scorer", purpose: "Scores an idea's viability/fit for greenlighting.", file: "scoring.ts", tier: "mid", complianceRelevant: false, bypassedWhenAuthored: false },
  { key: "thumbnail", name: "Thumbnail concept generator", purpose: "Writes the thumbnail concept/prompt.", file: "thumbnail.ts", tier: "mid", complianceRelevant: false, bypassedWhenAuthored: true },
  { key: "hooks", name: "Hook writer/analyzer", purpose: "Hook generation + archetype classification.", file: "hooks.ts", tier: "mid", complianceRelevant: false, bypassedWhenAuthored: true },
  { key: "humanize", name: "Persona humanizer", purpose: "Rewrites narration in the channel persona's voice.", file: "humanize.ts", tier: "mid", complianceRelevant: false, bypassedWhenAuthored: false },
  { key: "analysis", name: "Post-publish analysis", purpose: "Analyses a published video's hook/script vs its retention.", file: "analysis.ts", tier: "mid", complianceRelevant: false, bypassedWhenAuthored: false },
  { key: "character", name: "Character caster", purpose: "Designs/introduces a recurring character for the channel.", file: "character.ts", tier: "flagship", complianceRelevant: false, bypassedWhenAuthored: false },
  { key: "persona", name: "Persona designer", purpose: "Builds the channel's narrator persona.", file: "persona.ts", tier: "flagship", complianceRelevant: false, bypassedWhenAuthored: false },
  { key: "opportunities", name: "Market opportunities", purpose: "Surfaces rising topic opportunities from intel.", file: "opportunities.ts", tier: "mid", complianceRelevant: false, bypassedWhenAuthored: false },
  { key: "editorial-charter", name: "Charter author", purpose: "Drafts a channel charter (mission/objectives).", file: "editorial/charter.ts", tier: "flagship", complianceRelevant: false, bypassedWhenAuthored: false },
  { key: "editorial-research", name: "Editorial research", purpose: "Research/briefing for episode planning.", file: "editorial/research.ts", tier: "flagship", complianceRelevant: false, bypassedWhenAuthored: false },
  { key: "editorial-planner", name: "Editorial planner", purpose: "Plans a series/arc of episodes.", file: "editorial/planner.ts", tier: "flagship", complianceRelevant: false, bypassedWhenAuthored: false },
];

/** Compliance-relevant agents only — the audit subset the ticket cares most about. */
export function complianceRelevantPrompts(): AgentPromptInfo[] {
  return AGENT_PROMPTS.filter((a) => a.complianceRelevant);
}
