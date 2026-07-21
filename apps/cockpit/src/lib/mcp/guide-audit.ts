/**
 * Guide↔registry audit (ticket 01KY25NFHJ… / #29).
 *
 * #29's real lesson: a tool referenced in the operating guide but NOT present in
 * the MCP registry is invisible drift — Claude-in-chat reads about a tool it can
 * never call. Rather than fix one instance, this compares EVERY verb-prefixed
 * tool token in MCP_GUIDE against the actual registry and reports the gap. It is
 * called from two places:
 *   - the `get_guide` tool (surfaces a `warnings` field over MCP if drift exists)
 *   - scripts/audit-mcp-guide.mjs (a CI-runnable gate that exits non-zero)
 * so drift can never silently ship.
 */
import { MCP_GUIDE } from "./guide";
import { MCP_TOOLS_BY_NAME } from "./tools";

/**
 * Verb prefixes that begin a real tool name in this codebase. Kept explicit (not
 * "any snake_case") so prose like `on_hold` or `real_footage` isn't mistaken for
 * a tool reference.
 */
const TOOL_VERB_PREFIXES = [
  "get",
  "set",
  "list",
  "create",
  "author",
  "propose",
  "write",
  "report",
  "resolve",
  "run",
  "seed",
  "reconcile",
  "review",
] as const;

/**
 * Tokens that LOOK like tool references but are intentionally not registered
 * tools (documented cockpit-only actions, or renamed/removed tools we still
 * mention in prose). Add here — with a reason — rather than weakening the regex.
 */
const NON_TOOL_ALLOWLIST = new Set<string>([
  // Gate approval is a deliberately human, cockpit-only action (never an MCP
  // tool); the guide references the concept, not a callable tool.
  "decide_gate",
]);

export type GuideAuditResult = {
  ok: boolean;
  /** guide tokens that resolve to no registered tool and aren't allowlisted */
  missing: string[];
  /** count of distinct tool tokens the guide references */
  referenced: number;
};

/** Extract the distinct verb-prefixed tool tokens referenced in the guide text. */
export function guideToolTokens(guide: string = MCP_GUIDE): string[] {
  const re = new RegExp(`\\b((?:${TOOL_VERB_PREFIXES.join("|")})_[a-z_]+)\\b`, "g");
  const matches = [...guide.matchAll(re)].map((m) => m[1]).filter((t): t is string => Boolean(t));
  return [...new Set(matches)].sort();
}

/** Compare guide tool references against the live registry. */
export function auditGuideToolReferences(guide: string = MCP_GUIDE): GuideAuditResult {
  const tokens = guideToolTokens(guide);
  const missing = tokens.filter((t) => !MCP_TOOLS_BY_NAME.has(t) && !NON_TOOL_ALLOWLIST.has(t));
  return { ok: missing.length === 0, missing, referenced: tokens.length };
}
