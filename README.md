# YT Auto Platform

Single-operator platform for running a portfolio of faceless YouTube Shorts
channels: agents ideate, score, script, and produce; **you** approve at a small
number of logged review gates; every video's generation cost is tracked from
day one.

```
Channel → Idea → (Scored) → Production → Assets → Publication → Analytics
                                  ↑________ feedback loop ________|
```

**Status: Phases 0–4 complete** — the full vertical slice works end to end
*with zero API keys* (deterministic mock providers), and flips to real
providers by saving keys on the Account page. Publishing operations are in:
per-channel YouTube OAuth (encrypted token storage), autonomy tiers T0–T3,
quota-aware and operator-scheduled publishing, and release-to-public. The
monitoring loop is closed: analytics snapshots every 6 hours (mock or
YouTube Analytics API), performance fed back into ideation/scoring prompts,
a per-channel length-tuning hint, and an alerting rail (low retention,
underperformance vs channel median). Phase 5 (thumbnail engine, hook
library, trend fast lane, conversational control, batch review) is next —
see BACKLOG.md for further builds beyond the spec.

## How it works

1. **Ideas** — generate with the ideation agent (channel DNA + research feed)
   or add manually. Score them on a 7-axis weighted rubric (demand,
   saturation, ghost-niche, RPM, feasibility, compliance risk, DNA fit).
2. **Greenlight** an idea → creates a Production and starts a durable Inngest
   workflow.
3. The pipeline drafts a script onto a hook→stat→insight→cta skeleton, then
   **pauses at the script review gate**. You approve / revise (with notes,
   fed back to the writer, max 3 rounds) / reject in the cockpit.
4. On approval: TTS voiceover with word-level timestamps → one generated
   image per beat → **variation check** → Remotion renders a 1080×1920 short
   with word-synced captions → **pauses at the final review gate**.
5. On approval: uploads **as private** to YouTube with the synthetic-media
   disclosure flag set, and writes the complete per-video cost record.

### Compliance by construction (spec §8)

- **Materially-varied substance**: every script carries a substance
  fingerprint; before a production can proceed past assets it is compared
  (Jaccard over 3-word shingles) against the channel's last 20 productions.
  Near-duplicates are blocked `on_hold` with an evidence row; borderline
  cases escalate to an LLM judge.
- **Editorial evidence log**: every gate decision records who decided, the
  decision, notes, and a snapshot of exactly what was reviewed.
- **AI disclosure**: `publications.ai_disclosure` is NOT NULL default true and
  the YouTube adapter sets `containsSyntheticMedia` on upload.
- **No reused-content clipping**: no such pathway exists in the codebase.

## Monorepo layout

| Path | What it is |
|---|---|
| `apps/cockpit` | Next.js operator UI + BFF (gate queue, ideas, productions, costs) |
| `apps/worker` | Inngest durable functions + Remotion rendering + asset serving |
| `packages/db` | Drizzle schema (the §4 data model), migrations, seed |
| `packages/core` | Domain schemas (zod), typed Inngest events, variation check, cost sink, scoring weights |
| `packages/providers` | Provider interfaces + **real and mock adapters** + object stores |
| `packages/agents` | Ideation / scoring / scriptwriter / similarity-judge agents (Vercel AI SDK) |
| `packages/video` | Remotion `Short` composition (1080×1920@30, Ken Burns beats, synced captions) |

## Quickstart (dev, zero API keys)

Prereqs: Node 22, pnpm 10, Docker (or a local Postgres 16).

```bash
pnpm install
docker compose up -d postgres inngest    # or point DATABASE_URL at your own PG
cp .env.example .env                     # defaults are fine for dev
pnpm db:migrate && pnpm db:seed
pnpm dev                                 # cockpit :3000, worker :3010, inngest UI :8288
```

Open http://localhost:3000 (basic auth from `OPERATOR_USER`/`OPERATOR_PASS`),
go to **Ideas → Score → Greenlight**, approve the script gate, wait for the
render, approve the final gate — you get a "published" (mock) private video
with a full cost breakdown. Watch every step in the Inngest UI at
http://localhost:8288.

End-to-end UI acceptance test (Playwright drives the cockpit):

```bash
node scripts/acceptance.mjs "Why airplane windows are round"
```

With no Docker, run Postgres yourself and skip MinIO entirely — the app uses
a local-filesystem object store when `S3_*` vars are unset. The Inngest dev
server can run via `npx inngest-cli dev -u http://localhost:3010/api/inngest`.

## Flipping providers from mock → real

Save provider keys on the cockpit's **Account** page (`/account`) — they are
encrypted at rest with AES-256-GCM under `SECRETS_ENCRYPTION_KEY` (generate
one with `openssl rand -hex 32`), only the last 4 characters are ever shown
again, and both apps pick up changes within ~15s without a restart. Keys
saved there take precedence over env vars. Alternatively set the env vars
directly.

Each provider independently switches to its real adapter when its key is
present (`PROVIDERS_FORCE_MOCK=1` overrides back to mocks):

| Provider | Env vars | Real adapter |
|---|---|---|
| LLM (tiered routing) | `OPENROUTER_API_KEY` (+ `LLM_MODEL_CHEAP/AGENTIC/FRONTIER`) | OpenRouter (OpenAI-compatible API) |
| Voice/TTS | `ELEVENLABS_API_KEY` | ElevenLabs with word timestamps |
| Media | `FAL_KEY` (+ `FAL_IMAGE_MODEL`) | fal.ai image generation |
| Publish | `YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN` | YouTube Data API v3 resumable upload (always private in v1) |
| Storage | `S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY` | DO Spaces / MinIO / S3 |
| Research | — | mock fixtures in v1; VidIQ-style adapter slots behind `ResearchProvider` |

Costs are recorded either way — mocks use the same price tables, so projected
unit economics are visible before you spend a cent.

### YouTube OAuth (one-time, per test channel)

Create a GCP project → enable YouTube Data API v3 → OAuth consent (external,
test users: you) → OAuth client (Desktop) → run an OAuth flow requesting
`https://www.googleapis.com/auth/youtube.upload` offline → put the refresh
token in `YOUTUBE_REFRESH_TOKEN`. Note: unverified API projects force uploads
to private — which is exactly what the vertical slice wants anyway. An upload
costs ~1,600 of the 10,000/day quota units (tracked in `cost_records`).

## Deploy (DigitalOcean droplet)

```bash
cp .env.example .env   # set OPERATOR_*, provider keys, INNGEST_EVENT_KEY,
                       # INNGEST_SIGNING_KEY, COCKPIT_DOMAIN, POSTGRES_PASSWORD
docker compose -f docker-compose.prod.yml up -d --build
```

Caddy terminates TLS for the cockpit; Postgres, Inngest, and the worker stay
on the internal network. Give the droplet ≥4GB RAM — a 35s short renders in
roughly a minute of CPU time.

## Development notes

- **Durable pipeline**: `apps/worker/src/functions/production-pipeline.ts`.
  Human gates are `step.waitForEvent` on `production/gate.decided`, matched on
  **gateId** (not productionId) so revision loops can't consume stale
  approvals. Steps pass storage keys, never buffers.
- **Idempotency**: assets upsert on `(productionId, kind, idx)` with
  deterministic storage keys, so step retries overwrite instead of
  duplicating. Cost records are append-only and can rarely double-count on a
  retry-after-success — known v1 limitation.
- **Render assets** are served to the headless render browser over the
  worker's own `/store/*` route (an `http://` page cannot load `file://`
  subresources).
- **Autonomy tiers** (spec §10) are enforced in the pipeline: T0/T1 gate
  script + final review; T2/T3 skip gates and auto-publish (private), with a
  "Release to public" click on the production page (T2's supervised release).
  Variation-check failures hold the item for review regardless of tier.
- **Per-channel YouTube OAuth**: "Connect YouTube" on the channel page runs
  the OAuth flow and stores the refresh token encrypted, scoped to that
  channel; the publish adapter resolves tokens per channel (global env token
  as fallback). Add `…/api/oauth/youtube/callback` as an authorized redirect
  URI on the OAuth client.
- **Quota + scheduling**: uploads check the day's consumed YouTube quota
  (from cost_records) and sleep until the reset when exhausted; the final
  gate accepts an optional "publish no earlier than" time (durable
  `sleepUntil`, status `scheduled`).
- **Monitoring loop**: `analytics-ingest` (Inngest cron `0 */6 * * *`, or the
  "Run analytics ingest now" button on /alerts) snapshots every publication,
  then runs the pure alert rules (`packages/core/src/alert-rules.ts`). One
  open alert per (publication, kind). `channelPerformanceSummary` feeds the
  same data into scoring/ideation prompts and the channel page's suggested
  target length. Real adapter uses YouTube Analytics API v2 (the OAuth
  connect flow requests yt-analytics.readonly).
- Tests: `pnpm test` (provider contract tests, similarity, beat timing,
  crypto, quota windows, alert rules);
  `pnpm turbo build typecheck test` runs the full pipeline.
