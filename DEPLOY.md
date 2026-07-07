# Deploying: Vercel (cockpit) + Render (worker + Postgres)

The cockpit is a normal Next.js app and runs great on Vercel. The worker
canNOT run on Vercel — Remotion renders (headless Chromium, minutes of CPU)
and long-lived Inngest steps need a real server — so it runs on Render as a
Docker service. Two managed services glue the halves together:

| Piece | Where | Why |
|---|---|---|
| Cockpit (Next.js) | **Vercel** (or Render, optional block in render.yaml) | UI + server actions |
| Worker (pipeline + renders) | **Render** Docker web service, ≥2GB RAM | Chromium renders, durable steps |
| Postgres | **Render Postgres** (or Neon) | shared DB |
| Durable orchestration | **Inngest Cloud** (free tier) | replaces the local `inngest dev` server |
| Object storage | **Cloudflare R2** or DO Spaces (S3-compatible) | Vercel and Render share no disk |

Everything still runs with zero provider keys (mock adapters) — deploying
first and adding OpenRouter/ElevenLabs/fal/YouTube keys later on `/account`
is a completely valid path.

## 0. One-time preparation

1. **Generate shared secrets** (used by BOTH apps):
   ```bash
   openssl rand -hex 32   # SECRETS_ENCRYPTION_KEY — cockpit and worker MUST share it
   ```
2. **Inngest Cloud** (inngest.com → free account → create app):
   copy the **Event Key** and **Signing Key**.
3. **Bucket**: create an R2 (or Spaces/S3) bucket, e.g. `ytauto`, plus an
   access key pair. Note the S3 endpoint URL.

## 1. Render (worker + Postgres) — via Blueprint

1. Render dashboard → **New → Blueprint** → point at this repo. Render reads
   `render.yaml` and provisions `ytauto-db` (Postgres 16) and
   `ytauto-worker` (Docker, `apps/worker/Dockerfile`, health check
   `/healthz`, migrations run automatically via `preDeployCommand`).
2. Fill the prompted env vars:
   - `SECRETS_ENCRYPTION_KEY` — from step 0.1
   - `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — from step 0.2
   - `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — from step 0.3
     (`S3_REGION` stays `auto` for R2)
   - Do **not** set `INNGEST_DEV` or `INNGEST_BASE_URL` — absence of both
     means the Inngest SDK talks to Inngest Cloud.
3. After the first deploy, register the worker with Inngest Cloud:
   Inngest dashboard → your app → **Sync** → URL
   `https://<ytauto-worker>.onrender.com/api/inngest`.
   The three functions (production-pipeline, analytics-ingest, trend-scan)
   appear; crons start firing on Inngest's schedule.

If you prefer everything on Render, keep the optional `ytauto-cockpit`
block in `render.yaml` and skip the Vercel section (env vars are the same
as below, plus `OPERATOR_USER`/`OPERATOR_PASS`).

## 2. Vercel (cockpit)

1. Vercel → **Add New Project** → import this repo.
2. **Root Directory: `apps/cockpit`** (enable "Include source files outside
   of the Root Directory" — default on for monorepos). Vercel detects the
   pnpm workspace and Next.js automatically; `apps/cockpit/vercel.json`
   pins the build/install commands.
3. Environment variables:

   | Var | Value |
   |---|---|
   | `DATABASE_URL` | Render Postgres **External** connection string, with `?sslmode=require` appended |
   | `OPERATOR_USER` / `OPERATOR_PASS` | cockpit basic-auth login |
   | `SECRETS_ENCRYPTION_KEY` | **same value as the worker** |
   | `INNGEST_EVENT_KEY` | from Inngest Cloud (cockpit only sends events) |
   | `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | same bucket as the worker |

4. Deploy. Log in with basic auth, open `/account`, and confirm the
   "Active adapters" card shows mocks (or real, once you add keys).

## 3. Post-deploy wiring

- **YouTube OAuth redirect**: in the GCP console add
  `https://<your-cockpit-domain>/api/oauth/youtube/callback` as an
  authorized redirect URI before using "Connect YouTube".
- **Smoke test**: Ideas → Score → Greenlight → approve the script gate →
  wait for the render (watch the run in the Inngest Cloud dashboard) →
  approve the final gate → a mock publication appears with full costs.
- **Cron cadence**: analytics ingest every 6h and trend scan daily run via
  Inngest Cloud once the worker is synced.

## Gotchas

- **Pin `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`** (droplet `.env`). Without it,
  every `docker compose up -d --build` regenerates Next's Server Actions key, so
  already-open cockpit tabs fail with `UnrecognizedActionError: Server Action …
  was not found on the server` after each deploy. Generate once
  (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
  and add it to `.env`; compose passes it as a build arg **and** at runtime
  (both are required — the key is baked into the client bundle at build time).
- The two apps **must share** `SECRETS_ENCRYPTION_KEY` and the same
  `DATABASE_URL` database, or keys saved in the cockpit can't be read by
  the worker.
- Vercel serverless functions cap execution time — that's fine, because
  everything long-running (TTS, image gen, render, publish) happens on the
  worker; cockpit actions just write rows and send events.
- Render free/starter Postgres pauses on the free tier — use at least
  `basic-256mb` (as in the blueprint) for cron-driven workloads.
- The worker image bakes Chromium at build time (`remotion browser ensure`);
  first build takes several minutes.
- Renders happen on the worker's CPU: a ~35s short takes ~1 minute on a
  2GB/1CPU instance. Scale the plan, not the code, if queueing hurts.

## Build #5 pgvector migration (droplet / docker-compose.prod.yml)

Build #5's semantic memory needs the `vector` extension, so the Postgres image
changed from `postgres:16-alpine` to `pgvector/pgvector:pg16`. Same Postgres 16,
**but alpine (musl) → Debian (glibc) changes libc collations** — text indexes
built under the old image can be silently wrong under the new one. The existing
volume must NOT be reused as-is. Data is small, so dump → fresh volume → restore:

```bash
ssh -i ~/.ssh/id_rsa root@<droplet>
cd /opt/ytauto   # wherever the repo lives

# 1. dump while the old image is still running
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U ytauto -d ytauto --no-owner > /root/ytauto-pre-build5.sql

# 2. stop the stack, remove ONLY the postgres volume
docker compose -f docker-compose.prod.yml down
docker volume rm ytauto_pgdata   # check name with: docker volume ls

# 3. pull the new code (with the pgvector image) and start postgres alone
git pull
docker compose -f docker-compose.prod.yml up -d postgres
# wait for healthy: docker compose -f docker-compose.prod.yml ps

# 4. restore, then bring up the rest (the migrate one-shot applies 0006+0007)
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U ytauto -d ytauto < /root/ytauto-pre-build5.sql
docker compose -f docker-compose.prod.yml up -d --build

# 5. verify
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U ytauto -d ytauto -c "SELECT extname FROM pg_extension WHERE extname='vector';"
```

If the restore is skipped (fresh start), the migrate one-shot + `db:seed`
recreate a working empty state. Keep `/root/ytauto-pre-build5.sql` until the
new stack is verified.
