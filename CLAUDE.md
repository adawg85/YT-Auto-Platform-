# CLAUDE.md — working rules for this repo

## Git workflow (non-negotiable)

**`main` is the single source of truth and the deployed branch.** Production
runs on **Render** (`yt-auto-platform.onrender.com` — cockpit + worker, prod DB
is Render Postgres); Render rebuilds both services on every push to `main`, and
the worker's `preDeploy` applies DB migrations. The old DigitalOcean droplet
(`deploy/webhook-receiver.py`) is legacy — not yet decommissioned, but its
database/secrets are stale; never treat it as prod. Work that stays on a side
branch never reaches the live site.

Before touching ANY code:

1. **Fetch everything and sync with main first.** Session clones are often
   stale snapshots that are missing branches (including `main` itself):

   ```
   git fetch origin "+refs/heads/*:refs/remotes/origin/*"
   git log --oneline -5 origin/main   # confirm you can see main's real head
   ```

2. **Base all work on `origin/main`**, or merge `origin/main` into your
   working branch before changing anything. Never redesign or rewrite files
   from an old base — parallel sessions land features on `main` continuously
   (charter wizard, editorial engine, market intel all arrived this way).

3. **Check for parallel `claude/*` branches** before large refactors of
   shared files (`globals.css`, `app-shell.tsx`, `icons.tsx`, page files):
   `git branch -r` — if another branch touches the same files, reconcile
   rather than overwrite.

4. **Finish every piece of work by getting it onto `main`** — merge the
   working branch into `main` and push (or open a PR when review is wanted).
   A task is not done while its commits sit only on a side branch. If you
   cannot push `main`, say so explicitly in the final summary so the operator
   knows the live site is not updated.

## Docs to keep in sync (non-negotiable)

Whenever you update the handoff or backlog, update the Claude/MCP guide in the
**same commit** — these three move together, never one without the others:

- `HANDOFF.md` — the running session-to-session state.
- `BACKLOG.md` — the prioritized work list.
- **The MCP/Claude operating guide**, which lives in TWO mirrored places that
  MUST match: `docs/MCP-CLAUDE-GUIDE.md` (the human/source doc) and
  `apps/cockpit/src/lib/mcp/guide.ts` (`MCP_GUIDE`, served to Claude-in-chat by
  the `get_guide` MCP tool). Change one → change the other, or Claude in chat
  will operate on stale instructions.

If a change alters what Claude-in-chat can do or how the pipeline behaves
(new tool, new capability, changed sourcing/gating, new channel knob), the
guide update is part of that change — not a follow-up.

## Tickets — the triage loop (how most work arrives)

The operator drives the platform from Claude-in-chat over the MCP connector and
files problems with `report_issue`. Each ticket is **mirrored to a GitHub issue on
this repo, labelled `mcp-ticket`** (+ a severity label `error`/`warn`), linked back
by a `ytauto-ticket:<ULID>` marker. That issue list IS the live work queue — check
it, don't wait to be told.

**Find the work:** list OPEN issues labelled `mcp-ticket` (newest first) via the
GitHub MCP tools. Triage by severity (`error` before `warn`) and by dependency
(a fix others build on goes first). Read the whole ticket — the operator writes
detailed evidence, hypotheses, and often the exact fix they want.

**The discipline (non-negotiable — learned the hard way in ticket `01KY22PV…`):**

1. **Ground the fix in the actual code before writing a line.** The ticket's
   hypothesis is a lead, not a fact — read the real path (Explore agent for
   anything non-trivial) and confirm the cause. Several tickets' hypotheses were
   right; some were subtly wrong.
2. **Meet the quality bar** (see below): typecheck + prod build + tests pass, and
   keep the guide/HANDOFF/BACKLOG in sync in the same commit.
3. **Land it on `main`** (this repo deploys from `main`).
4. **Post a `Resolution` comment on the issue** — what shipped, the commit SHA, and
   concrete steps for the operator to verify. New tools/return-fields need a
   **connector reconnect** to appear; migrations need the worker `preDeploy` — say so.
5. **Leave the issue OPEN for the operator to verify live and close it themselves.**
   Do NOT self-close. A board that auto-closes reads "all done" while the work is
   unverified — the exact trust failure ticket `01KY22PV…` was about. `resolve_issue`
   gained an `open` status to reopen a wrongly-closed one.
6. **Record shipped-pending-verification / deferred work** in `get_deferred_work`
   (`packages/core/src/deferred-work.ts`) so a fix whose EFFECT is gated on the next
   analytics ingest / a live check isn't misread as failed.
7. **Anything that changes live production behaviour ships default-off / opt-in**,
   to be enabled with the operator present — never flip it unattended.

**Standing caveat to state in every resolution:** there is no live YouTube API and
no prod DB from the sandbox, so fixes are typecheck/build/unit-test-verified only;
the operator does the live verification (after a connector reconnect, and after any
migration deploys).

## Environment gotchas

- **Postgres needs the `pgvector` extension** (migration
  `0006_pgvector-extension.sql`). Use the `pgvector/pgvector:pg16` image, or
  install `postgresql-16-pgvector` and `CREATE EXTENSION vector;` on a plain
  Postgres. Without it, `pnpm db:migrate` fails (and drizzle-kit swallows the
  error — check table count if migration "succeeds" suspiciously fast).
- Full mock mode: every provider falls back to a deterministic mock with no
  API keys; `PROVIDERS_FORCE_MOCK=1` forces mocks even when keys exist.
- Dev quickstart: Postgres up → `pnpm install` → `pnpm db:migrate` →
  `pnpm db:seed` → `pnpm dev` (cockpit on :3000). Basic auth is disabled
  until `OPERATOR_USER`/`OPERATOR_PASS` are set.
- **Run local like prod (real providers, no drift): `docs/LOCAL.md`** — the
  single source of truth. Code is aligned via git; config/DB/store are
  per-environment (local DB + store are a separate sandbox, by design). A single
  `ANTHROPIC_API_KEY` on `/account` covers all LLM tiers.

## Quality bar before pushing

- `pnpm --filter @ytauto/cockpit typecheck` and a production build
  (`pnpm --filter @ytauto/cockpit build`) must pass.
- UI changes: verify against the running app (screenshots), in light and
  dark themes, at desktop and 390px mobile widths.
- UI conventions live in `UI-REVIEW.md`: one `.btn` button system, no raw
  enum values or ISO timestamps in the UI (use `lib/format.ts` labels), no
  emoji/ASCII glyphs as icons (use `components/icons.tsx` — lucide-react).
- Reusable UI primitives live in `apps/cockpit/src/components/ui/*` (Button,
  Card/Panel, Badge, StatTile, DataTable, Field, EmptyState, Skeleton,
  Segmented, Dialog) — thin wrappers over the `.btn`/`.chip`/`.panel`/`.kpi`
  classes above. There is a living reference at the `/design-system` route.

## Reach for the right tool

Before doing a task by hand, consider whether an available MCP, skill, or agent
does it better — and prefer it when one fits.

- **MCP servers**: `context7` (current library/API docs — prefer over web search),
  `serena` (semantic code navigation/edits), `git-mcp-server`, `playwright`/
  `puppeteer`/`claude-in-chrome` (browser automation + screenshots), and domain
  servers (`VidIQ`, `Gamma`, `Gmail`, `Notion`). Use `mcp-compass` to discover one.
- **Skills** (`/skill-name`): invoke the matching skill before the work it covers —
  `deep-research`, `dataviz`, `code-review`, `verify`, `run`, `security-review`.
  For any UI/UX work, this repo bundles the MIT `ui-ux-pro-max` skill pack (plus
  `design`, `design-system`, `ui-styling`, `brand`, `banner-design`, `slides`) in
  `.claude/skills/` — reach for it when building, reviewing, or refreshing UI.
- **Agents** (Agent tool): `Explore`/`general-purpose` for broad searches, `Plan`
  for strategy, domain specialists for focused work; run independent agents in
  parallel.
