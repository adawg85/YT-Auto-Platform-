#!/usr/bin/env node
/**
 * CI gate for the MCP registry (#29, extended by #124). Parses the two source
 * files without a build step — reads the MCP_GUIDE text and the registered tool
 * names straight from source — and exits non-zero if either:
 *   1. a tool name violates the Anthropic tool-name contract (#124), or
 *   2. the guide references a tool that isn't registered (#29).
 * Mirrors assertValidToolNames()/auditGuideToolReferences() in src/lib/mcp/guide-audit.ts.
 *
 * Run: node apps/cockpit/scripts/audit-mcp-guide.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mcpDir = join(here, "..", "src", "lib", "mcp");

const guide = readFileSync(join(mcpDir, "guide.ts"), "utf8");
const tools = readFileSync(join(mcpDir, "tools.ts"), "utf8");
const actions = readFileSync(join(mcpDir, "actions.ts"), "utf8");
const doc = readFileSync(join(here, "..", "..", "..", "docs", "MCP-CLAUDE-GUIDE.md"), "utf8");

/**
 * Every `name:` at tool-registration indent, WITHOUT pre-filtering on shape —
 * ticket #124's lesson. The old pattern here was /"([a-z_]+)"/, so a name with
 * prose pasted into it (`force_forward #78: REFUSED on a precondition halt…`)
 * did not match and was silently dropped from `registered` instead of being
 * reported. Capture first, validate second.
 */
const declaredNames = [...tools.matchAll(/^ {4}name: "((?:[^"\\]|\\.)*)",$/gm)].map((m) => m[1]);

/**
 * The Anthropic tool-name contract: `^[a-zA-Z0-9_-]{1,128}$`. An MCP client
 * prefixes the server namespace (`mcp__YT_Auto_MCP__`, 18 chars here) before
 * sending it, and the limit applies to the PREFIXED name — so the bare name is
 * capped well under 128 to leave any client's prefix room.
 *
 * This is a HARD gate, not a style nit: one over-long or illegally-charactered
 * name makes the Anthropic API reject the ENTIRE tools array with
 * `400 tools.N.custom.name`, which kills every single call in any chat session
 * with this connector attached — not just calls to the offending tool. #124
 * shipped two such names and took the whole MCP surface down with them.
 */
const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_BARE_NAME = 64;

const invalidNames = declaredNames
  .map((name) => {
    if (!NAME_RE.test(name)) return { name, why: "illegal characters (allowed: A-Z a-z 0-9 _ -)" };
    if (name.length > MAX_BARE_NAME) return { name, why: `${name.length} chars, max ${MAX_BARE_NAME}` };
    return null;
  })
  .filter(Boolean);

if (invalidNames.length) {
  console.error(`✗ ${invalidNames.length} MCP tool name(s) violate the Anthropic tool-name contract:`);
  for (const { name, why } of invalidNames) {
    console.error(`    - ${why}\n      ${JSON.stringify(name.slice(0, 100))}${name.length > 100 ? "…" : ""}`);
  }
  console.error(
    "\nThis breaks EVERY API call in a session with this connector, not just this tool.\n" +
      "Fix: the name is an identifier only — move any prose into `description`.",
  );
  process.exit(1);
}

const registered = new Set(declaredNames);

const VERB_PREFIXES = [
  "get", "set", "list", "create", "author", "propose",
  "write", "report", "resolve", "run", "seed", "reconcile", "review",
];
// Keep in sync with NON_TOOL_ALLOWLIST in guide-audit.ts.
const ALLOWLIST = new Set(["decide_gate"]);

const re = new RegExp(`\\b((?:${VERB_PREFIXES.join("|")})_[a-z_]+)\\b`, "g");
const tokens = [...new Set([...guide.matchAll(re)].map((m) => m[1]))].sort();
const missing = tokens.filter((t) => !registered.has(t) && !ALLOWLIST.has(t));

if (missing.length) {
  console.error(`✗ MCP guide references ${missing.length} unregistered tool(s):`);
  for (const m of missing) console.error(`    - ${m}`);
  console.error("Fix: register the tool, correct the guide, or add to the allowlist (with a reason).");
  process.exit(1);
}

/**
 * #129 — the ACTION CONSEQUENCES gate. An agent is told to state what a call
 * discards, bills and how to undo it BEFORE making it; that is only possible if
 * every state-changing tool has a row. A mutating tool with no row is therefore
 * not a documentation gap, it is a tool whose blast radius nobody can state —
 * so it fails the build, exactly like an unregistered tool reference.
 *
 * Mirrors auditActionCoverage() in src/lib/mcp/actions.ts (which serves the same
 * check over MCP as a get_guide warning); parsed from source so no build is needed.
 */
const readOnly = new Set(
  [...(tools.split("export const READ_ONLY_TOOLS")[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
);
const documentedActions = new Set([...actions.matchAll(/^ {4}tool: "([a-z_]+)",$/gm)].map((m) => m[1]));
const declaredNonMutating = new Set(
  [...(actions.split("NON_MUTATING_UNLISTED: Record<string, string> = {")[1] ?? "").split("};")[0].matchAll(/^ {2}([a-z_]+):/gm)].map(
    (m) => m[1],
  ),
);
const mutating = declaredNames.filter((n) => !readOnly.has(n));
const undocumentedActions = mutating.filter(
  (n) => !documentedActions.has(n) && !declaredNonMutating.has(n),
);
const staleActions = [...documentedActions, ...declaredNonMutating].filter((n) => !registered.has(n));

if (undocumentedActions.length || staleActions.length) {
  if (undocumentedActions.length) {
    console.error(`✗ ${undocumentedActions.length} state-changing tool(s) have no row in the actions section:`);
    for (const t of undocumentedActions) console.error(`    - ${t}`);
    console.error(
      "Fix: add an ACTION_CONSEQUENCES entry (discards / keeps / bills / reversible / preview) in\n" +
        "src/lib/mcp/actions.ts — or, if it writes nothing, declare it in NON_MUTATING_UNLISTED with a reason.",
    );
  }
  if (staleActions.length) {
    console.error(`✗ the actions section documents ${staleActions.length} tool(s) that are not registered:`);
    for (const t of staleActions) console.error(`    - ${t}`);
    console.error("Fix: a rename left the table behind — update src/lib/mcp/actions.ts.");
  }
  process.exit(1);
}

/**
 * The section must actually reach the served guide, must keep the pre-flight
 * rule and the four named traps (each has a real production behind it), and must
 * be cross-referenced from the two sections read immediately before the
 * highest-cost mistakes.
 */
const sectionChecks = [
  [guide.includes("${ACTIONS_SECTION}"), "guide.ts does not embed ${ACTIONS_SECTION} — get_guide would serve no actions section"],
  [
    actions.includes("## Action consequences — what each call discards, bills, and how to undo it"),
    "the actions section heading is missing (get_guide(section:'actions') resolves by that heading)",
  ],
  [
    actions.includes("Before any state-changing call, be able to state three things"),
    "the pre-flight rule is missing from the actions section — it is the behaviour change the section exists to produce",
  ],
  [actions.includes("KEEPS the reopened stage's own output"), "trap 1 (reopen vs clean) is missing"],
  [actions.includes("`visualsStale`"), "trap 2 (visualsChanged is not visualsStale) is missing"],
  [actions.includes("resumes PAST a compliance block"), "trap 3 (continue_production, #128) is missing"],
  [actions.includes("placeholder SVG"), "trap 4 (empty imagePrompt, #122) is missing"],
  [actions.includes("01KZZNV2P3WSRZVQY1XN8TVBJP") && actions.includes("A$6.27"), "the measured cost evidence is missing"],
  [
    (guide.match(/get_guide\(section:'actions'\)/g) ?? []).length >= 3,
    "the voiceover / shots / recovery sections must each cross-reference get_guide(section:'actions')",
  ],
  [
    doc.includes("## Action consequences"),
    "docs/MCP-CLAUDE-GUIDE.md is missing the Action consequences section — the two guide mirrors must match",
  ],
];
const failed = sectionChecks.filter(([ok]) => !ok).map(([, why]) => why);
if (failed.length) {
  console.error(`✗ ${failed.length} actions-section check(s) failed:`);
  for (const why of failed) console.error(`    - ${why}`);
  process.exit(1);
}

console.log(
  `✓ MCP guide↔registry in sync — ${tokens.length} tool references, ${registered.size} registered tools, ` +
    `all ${declaredNames.length} names valid for the Anthropic tools array.\n` +
    `✓ action consequences documented for all ${mutating.length - declaredNonMutating.size} state-changing tools ` +
    `(${documentedActions.size} rows, ${declaredNonMutating.size} declared non-mutating).`,
);
