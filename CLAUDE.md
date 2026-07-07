# CLAUDE.md — working rules for this repo

## Git workflow (non-negotiable)

**`main` is the single source of truth and the deployed branch.** The droplet
auto-redeploys on every push to `main` (see `deploy/webhook-receiver.py`).
Work that stays on a side branch never reaches the live site.

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
