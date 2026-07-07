# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Reach for the right tool

Before doing a task by hand, **consider whether an available MCP server, skill, or agent does it better** — and prefer it when one fits. Check the tool/skill/agent lists surfaced in the session rather than defaulting to raw Bash + Edit.

- **MCP servers** — use them for anything they specialize in instead of reimplementing:
  - `context7` — fetch current library/framework/SDK docs before answering API/config/version questions (even for well-known libraries). Prefer this over web search for library docs.
  - `serena` — semantic code navigation and editing (find/reference symbols, targeted edits) on non-trivial code changes.
  - `git-mcp-server` — structured git operations when scripting or when richer output than plain `git` helps.
  - `claude-in-chrome` / `playwright` / `puppeteer` — browser automation, screenshots, console/network inspection.
  - `VidIQ`, `Gamma`, `Gmail`, `Notion`, etc. — use the domain MCP when the task is in its domain rather than hand-rolling API calls.
  - Not sure one exists? Use `mcp-compass` to discover a suitable MCP server.

- **Skills** (`/skill-name` or the Skill tool) — invoke the matching skill *before* starting the work it covers, e.g. `deep-research`, `dataviz`, `code-review`, `verify`, `run`, `security-review`, `update-config`. This is a blocking requirement when a skill clearly matches.
  - **UI/UX design** — this repo bundles the [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) skill pack (MIT) in `.claude/skills/`: `ui-ux-pro-max` (styles, color palettes, font pairings, UX guidelines, chart types across React/Next/Vue/Svelte/SwiftUI/RN/Flutter/Tailwind/shadcn), plus `design`, `design-system`, `ui-styling`, `brand`, `banner-design`, `slides`. Reach for these whenever building, reviewing, or improving any UI/UX.

- **Agents** (Agent tool) — delegate to a specialized subagent when it fits:
  - `Explore` / `general-purpose` — broad multi-file searches where you only need the conclusion.
  - `Plan` — design an implementation strategy for a non-trivial task.
  - Domain specialists (`backend-architect`, `ai-engineer`, `debugger`, `test-automator`, `security-auditor`, etc.) for focused expert work.
  - Launch independent agents in parallel (one message, multiple tool calls) when work is separable.

When unsure whether to use a tool vs. do it directly: if the task is multi-step, spans many files, is in a specialized domain, or a dedicated tool clearly exists — use the tool.

## Project docs

- `STATUS.md` — current build/deploy state and handoff notes.
- `BACKLOG.md` — planned builds and priorities.
- `DEPLOY.md` — deployment runbook.
- `README.md` — architecture and setup.

## Conventions

- After committing, push to remote without asking.
- Windows host: primary shell is PowerShell; the Bash tool is available for POSIX scripts.
