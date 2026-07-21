#!/usr/bin/env node
/**
 * CI gate for the guide↔registry audit (#29). Parses the two source files
 * without a build step — reads the MCP_GUIDE text and the registered tool names
 * straight from source — and exits non-zero if the guide references a tool that
 * isn't registered. Mirrors auditGuideToolReferences() in src/lib/mcp/guide-audit.ts.
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

const registered = new Set([...tools.matchAll(/^\s+name: "([a-z_]+)",/gm)].map((m) => m[1]));

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

console.log(`✓ MCP guide↔registry in sync — ${tokens.length} tool references, ${registered.size} registered tools.`);
