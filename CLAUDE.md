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
