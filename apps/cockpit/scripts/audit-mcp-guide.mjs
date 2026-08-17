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

console.log(
  `✓ MCP guide↔registry in sync — ${tokens.length} tool references, ${registered.size} registered tools, ` +
    `all ${declaredNames.length} names valid for the Anthropic tools array.`,
);
