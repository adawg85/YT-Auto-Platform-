/**
 * Guide↔registry audit (ticket 01KY25NFHJ… / #29, extended for 01KYDT3A… / #59).
 *
 * #29's lesson (forward direction): a tool referenced in the operating guide but
 * NOT present in the MCP registry is invisible drift — Claude-in-chat reads about a
 * tool it can never call.
 *
 * #59's lesson (REVERSE direction): the opposite drift is just as bad and used to
 * pass silently — a tool that IS registered but is NOT mentioned in the guide.
 * Three tickets' worth of new tools (update_series/set_episode_status/
 * set_idea_status) shipped registered-but-unguided, so Claude-in-chat, reading the
 * create-only planning section, never learned they existed. This audit now checks
 * BOTH directions, so a new tool must land in the guide (or be explicitly
 * allowlisted) or the drift surfaces on get_guide.
 *
 * Called from the `get_guide` tool, which surfaces a `warnings` field over MCP when
 * either direction has drift, so it can never silently ship.
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

/**
 * Registered tools that legitimately need NO narrative in the operating guide —
 * pure diagnostics, or a tool with a documented sibling that covers the same
 * ground. ADD here WITH A REASON when you ship a tool the guide shouldn't carry;
 * otherwise a newly-registered tool must appear in MCP_GUIDE or the reverse audit
 * flags it. This list is the deliberate-omission record, not a dumping ground.
 */
const GUIDE_OPTIONAL_TOOLS = new Set<string>([
  "get_agent_prompts", // diagnostic (prompt dashboard); not part of the operate-the-platform flow
  "get_eval_results", // eval-harness diagnostic
  "run_market_scan", // intel-gathering; the guide covers reading intel via get_intel
  "seed_idea", // write_idea is the documented canonical idea-add path; seed_idea is its sibling
]);

/**
 * The Anthropic tool-name contract: `^[a-zA-Z0-9_-]{1,128}$`, applied to the
 * name AFTER an MCP client prefixes the server namespace
 * (`mcp__YT_Auto_MCP__`, 18 chars). We cap the bare name well below 128 so any
 * client's prefix has room.
 */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_BARE_TOOL_NAME = 64;

/**
 * #124's lesson, and the most expensive failure mode this registry has: a tool
 * `name` is an IDENTIFIER, never a place for prose. Two tools shipped with
 * release notes pasted into the name field (`force_forward #78: REFUSED on a
 * precondition halt…`), which pushed them past 128 characters. The Anthropic API
 * rejects the WHOLE tools array on one bad entry — `400 tools.N.custom.name` —
 * so every chat call in any session with this connector attached failed
 * outright, including calls to unrelated tools. The blast radius is the entire
 * MCP surface, so this is reported as a `warnings` entry on get_guide and as a
 * hard non-zero exit in scripts/audit-mcp-guide.mjs.
 */
export function invalidToolNames(names: Iterable<string> = MCP_TOOLS_BY_NAME.keys()): string[] {
  return [...names]
    .filter((n) => !TOOL_NAME_RE.test(n) || n.length > MAX_BARE_TOOL_NAME)
    .sort();
}

export type GuideAuditResult = {
  ok: boolean;
  /** guide tokens that resolve to no registered tool and aren't allowlisted */
  missing: string[];
  /** registered tools NOT mentioned anywhere in the guide (and not allowlisted) */
  undocumented: string[];
  /** registered names the Anthropic tools array would reject outright (#124) */
  invalidNames: string[];
  /** count of distinct tool tokens the guide references */
  referenced: number;
};

/** Extract the distinct verb-prefixed tool tokens referenced in the guide text. */
export function guideToolTokens(guide: string = MCP_GUIDE): string[] {
  const re = new RegExp(`\\b((?:${TOOL_VERB_PREFIXES.join("|")})_[a-z_]+)\\b`, "g");
  const matches = [...guide.matchAll(re)].map((m) => m[1]).filter((t): t is string => Boolean(t));
  return [...new Set(matches)].sort();
}

/**
 * Registered tools that the guide never mentions (#59 reverse drift) — a tool
 * Claude-in-chat can call but was never told about. Excludes the deliberate
 * omissions in GUIDE_OPTIONAL_TOOLS. Matches on the exact tool name as a word so a
 * name that's a prefix of another (get_channel vs get_channel_config) can't mask it.
 */
export function undocumentedTools(guide: string = MCP_GUIDE): string[] {
  // #129: the ACTIONS section names EVERY state-changing tool by construction, so
  // counting it as "documented" would make this audit vacuous — every tool would
  // pass while the narrative sections that actually teach the flow stayed silent
  // about it. #59's question is "does the guide TEACH this tool?", so ask it of
  // the narrative only. (The actions table has its own coverage audit —
  // auditActionCoverage — which asks the opposite question and must NOT be
  // satisfied by narrative prose.)
  const narrative = stripActionsSection(guide);
  return [...MCP_TOOLS_BY_NAME.keys()]
    .filter((name) => !GUIDE_OPTIONAL_TOOLS.has(name))
    // Escaped: a MALFORMED name (#124) can carry regex metacharacters, which
    // would otherwise throw here or silently match the wrong thing — turning the
    // audit that should report the bad name into a casualty of it.
    .filter((name) => !new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(narrative))
    .sort();
}

/**
 * The guide MINUS the generated `## Action consequences` section — everything up
 * to that heading, plus everything from the next `## ` heading on. Used by the
 * #59 reverse audit so a tool that appears ONLY in the generated table still
 * counts as undocumented narrative-wise.
 */
export function stripActionsSection(guide: string): string {
  const start = guide.indexOf("\n## Action consequences");
  if (start === -1) return guide;
  const rest = guide.slice(start + 1);
  const nextHeading = rest.search(/\n## (?!#)/);
  return guide.slice(0, start) + (nextHeading === -1 ? "" : rest.slice(nextHeading));
}

/** Audit the registry: name validity (#124) + guide drift in BOTH directions (#29 + #59). */
export function auditGuideToolReferences(guide: string = MCP_GUIDE): GuideAuditResult {
  const tokens = guideToolTokens(guide);
  const missing = tokens.filter((t) => !MCP_TOOLS_BY_NAME.has(t) && !NON_TOOL_ALLOWLIST.has(t));
  const undocumented = undocumentedTools(guide);
  const invalid = invalidToolNames();
  return {
    ok: missing.length === 0 && undocumented.length === 0 && invalid.length === 0,
    missing,
    undocumented,
    invalidNames: invalid,
    referenced: tokens.length,
  };
}
