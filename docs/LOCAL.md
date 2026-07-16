# Running locally like production (no drift)

The **code** is always a replica of prod — local and prod run the same `main`
branch. What differs is the **environment around the code**, and none of it
syncs automatically. This doc is the single source of truth for making a local
instance behave like the deployed one.

## What is shared vs per-environment

| Thing | Local | Prod | Kept aligned by |
|---|---|---|---|
| **Code** | `main` working tree (`next dev`) | `main`, Docker `next build` | **git** — pull before work, push to deploy |
| **Config / secrets** | your `.env` + local `/account` | droplet `.env` + prod `/account` | this doc + `.env.example` |
| **Database** | local Postgres (Docker) | droplet Postgres | **not synced — separate content, by design** |
| **Object store** | local disk `./data/store` | DigitalOcean Spaces | not synced |
| **Run mode** | `next dev` (HMR) | Docker prod build | use `docker-compose.prod.yml` for exact parity |

The local DB and object store are intentionally separate — local is your own
sandbox; it never touches prod content.

## The fast-fix loop (why this exists)

Reproduce a prod issue locally → fix → verify locally → `git push` (auto-deploys
to prod). One push ships it. No waiting on a blind deploy to test a change.

## Local real-mode setup (real providers, not mocks)

1. **Infra + schema**
   ```
   docker compose up -d          # Postgres (pgvector) + Inngest + MinIO
   pnpm install
   pnpm db:migrate               # applies all migrations
   pnpm db:seed                  # optional demo data
   ```
2. **`.env`** — copy `.env.example`, then set:
   - `SECRETS_ENCRYPTION_KEY` (`openssl rand -hex 32`) — enables `/account` key storage
   - `OPERATOR_USER` / `OPERATOR_PASS` — the cockpit basic-auth login
   - **Real-mode flags:** `RESEARCH_PROVIDER=youtube` and `SOURCE_CONNECTORS=real`
   - Leave `PROVIDERS_FORCE_MOCK` unset. Do **not** set `LLM_MODEL_*` (optional).
3. **Start the app** (env loaded so the processes see `.env`):
   ```
   set -a && . ./.env && set +a           # bash/git-bash; loads .env into the shell
   pnpm --filter @ytauto/worker dev        # :3010 — runs the Inngest pipeline
   pnpm --filter @ytauto/cockpit dev       # :3000 — the cockpit UI
   ```
   (Run each in its own shell/background. `turbo dev` strips `.env`, so start the
   two apps directly with the env exported — that's what the `set -a` line does.)
4. **Provider keys** — log in at http://localhost:3000, open **/account**, and add:
   - `ANTHROPIC_API_KEY` — **covers all three LLM tiers on its own** (the router
     degrades to any key you hold; no per-tier pinning needed)
   - `ELEVENLABS_API_KEY` — real voices + voice picker
   - `GEMINI_API_KEY` — Nano Banana hero/character images (+ Veo later)
   - `DASHSCOPE_API_KEY` — Qwen-Image + Wan video (Alibaba, bulk)
   - `ARK_API_KEY` — ByteDance Seedream image + Seedance video (BytePlus, optional)
   Keys are encrypted in the **local** DB. **Restart the worker + cockpit** after
   adding them — each process caches its providers, so a restart flips them to
   real at once.

That's it — local now runs like prod. Reference images (Wikimedia) are keyless
and work automatically once a real LLM is naming subjects.

## Gotchas that used to cause "it works differently locally"

- **A tier with no key used to 401.** Fixed: one held key covers all tiers. If
  you *do* pin `LLM_MODEL_*`, point every tier at a vendor whose key you have.
- **Adding keys on `/account` needs a worker/cockpit restart** to take effect
  (per-process provider cache).
- **Basic auth** blocks the Inngest sync of the *cockpit* app (harmless — the
  cockpit serves no functions; only the worker does). The worker syncs fine.
- **Render** (Remotion) needs a headless browser; if a production sticks at
  `assembling`, that's the likely cause locally.

## Exact-build parity (optional)

To run the *deployed artifact* locally (production Docker build, not the dev
server), use `docker-compose.prod.yml` — catches dev-vs-prod behaviour
differences. See `DEPLOY.md`.
