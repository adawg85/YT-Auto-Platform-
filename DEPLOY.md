# Deploy — everything on Render (cockpit + worker + Postgres)

The whole app runs on **Render**: the cockpit (Next.js) and the worker (pipeline
+ Remotion renders) as two web services, plus Render Managed Postgres. Two
external pieces glue it together — both free-tier friendly:

| Piece | Where | Why |
|---|---|---|
| Cockpit (Next.js) | **Render** web service | UI + server actions |
| Worker (pipeline + renders) | **Render** web service (Docker, higher CPU) | Chromium renders, durable steps |
| Postgres | **Render** Managed Postgres 16 | shared DB (pgvector) |
| Orchestration | **Inngest Cloud** (free) | replaces the self-hosted `inngest` server |
| Media (renders/images) | **Cloudflare R2** | S3-compatible object store; services share no disk |

> **Why R2/Inngest Cloud at all?** On Render the cockpit and worker are separate
> machines with no shared filesystem, so media must live in object storage (R2),
> and the Inngest server must be reachable by both (Inngest Cloud). Everything
> else is the same code — no rewrites.

The `render.yaml` Blueprint in this repo provisions all three Render pieces.

---

## Step 0 — Gather 4 things (10 min)

1. **Two random secrets** (run twice, keep both):
   ```bash
   openssl rand -hex 32       # SECRETS_ENCRYPTION_KEY  (worker + cockpit MUST share)
   openssl rand -base64 32    # NEXT_SERVER_ACTIONS_ENCRYPTION_KEY  (cockpit; keep STABLE across deploys)
   ```
2. **Cloudflare R2** — bucket + API token:
   - Bucket: already created (`ytauto`). Note its **S3 API endpoint** (R2 → the
     bucket → *Settings*): `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
   - Token: R2 → **Manage R2 API Tokens → Create API Token** → *Object Read &
     Write*, scoped to the `ytauto` bucket. Copy the **Access Key ID** and
     **Secret Access Key** (shown once).
3. **Inngest Cloud** — inngest.com → free account → create an app/environment →
   copy the **Event Key** and **Signing Key**.

That's every value the Blueprint will ask for.

---

## Step 1 — Deploy the Blueprint

1. Render dashboard → **New → Blueprint** → connect this GitHub repo. Render
   reads `render.yaml` and creates `ytauto-db` (Postgres 16), `ytauto-worker`
   (Docker), and `ytauto-cockpit` (Docker). Migrations run automatically on the
   worker via `preDeployCommand`.
2. When prompted, fill the `sync: false` env vars:

   | Var | Value | On |
   |---|---|---|
   | `SECRETS_ENCRYPTION_KEY` | secret #1 from Step 0 | worker + cockpit (**same value**) |
   | `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | secret #2 from Step 0 | cockpit |
   | `INNGEST_EVENT_KEY` | from Inngest | worker + cockpit |
   | `INNGEST_SIGNING_KEY` | from Inngest | worker only |
   | `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | worker + cockpit |
   | `S3_BUCKET` | `ytauto` | worker + cockpit |
   | `S3_ACCESS_KEY_ID` | R2 token key id | worker + cockpit |
   | `S3_SECRET_ACCESS_KEY` | R2 token secret | worker + cockpit |
   | `OPERATOR_USER` / `OPERATOR_PASS` | your cockpit login | cockpit |
   | `PUBLIC_BASE_URL` | the cockpit's Render URL (set after first deploy) | cockpit |

   `S3_REGION` is pinned to `auto` in the Blueprint (correct for R2). Do **not**
   set `INNGEST_DEV`, `INNGEST_BASE_URL`, or `INNGEST_SERVE_HOST` — their absence
   is what tells the SDK to use Inngest Cloud.
3. Let it build. The worker image bakes Chromium (`remotion browser ensure`), so
   the **first build takes several minutes**.
4. After the first deploy, copy the cockpit's URL (e.g.
   `https://ytauto-cockpit.onrender.com`) into its **`PUBLIC_BASE_URL`** env var
   and redeploy the cockpit (needed for YouTube OAuth).

---

## Step 2 — Sync the worker with Inngest Cloud

Inngest dashboard → your app → **Sync new app** → URL
`https://<ytauto-worker>.onrender.com/api/inngest`. The pipeline functions and
crons appear; crons start firing on Inngest's schedule.

---

## Step 3 — Migrate your data from the droplet

The Blueprint's `preDeployCommand` already ran the schema migrations, so you only
restore the **data**. On the droplet, dump; then restore into Render Postgres
(use the **External** connection string from the Render Postgres page).

```bash
# on the droplet — dump data only (schema already applied on Render)
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U ytauto -d ytauto --data-only --no-owner \
  --disable-triggers > ytauto-data.sql

# from anywhere with psql — restore into Render Postgres
psql "postgres://…render-external-url…?sslmode=require" < ytauto-data.sql
```

If the current data is mostly sandbox/test, you can skip this and re-create the
channel with the wizard instead — the schema is already there.

---

## Step 4 — Point YouTube OAuth at the new domain

In **Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0
client (Web application) → Authorized redirect URIs**, add **exactly**:

```
https://<ytauto-cockpit>.onrender.com/api/oauth/youtube/callback
```

(no trailing slash; scheme + host must match). The channel **Settings & DNA**
tab shows the exact URI to paste. This must equal `PUBLIC_BASE_URL` from Step 1.

---

## Step 5 — Smoke test

1. Log in (basic auth), open **/account**, confirm the provider keys you want
   (or leave mocks). `SECRETS_ENCRYPTION_KEY` must match on both services or the
   worker can't read keys the cockpit saved.
2. A channel's **Plan** tab → **Score → Greenlight** an episode → approve the
   script gate → watch the run in the Inngest Cloud dashboard → the render lands,
   approve the final gate → a publication appears on the **Schedule** calendar.
3. Decommission the droplet once you've verified renders + media (R2) + publish.

---

## Notes / gotchas

- **CPU = render speed.** Renders are CPU-bound. The worker is on `pro`
  (2 CPU/4GB) in the Blueprint; bump to `pro plus` (4 CPU) for faster renders or
  drop to `standard` to save cost — it's a plan change, not a code change.
- **Keep `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` stable.** If it changes between
  deploys, already-open cockpit tabs fail with `Server Action … was not found`.
- **Both services need the same `S3_*` and `SECRETS_ENCRYPTION_KEY`**, or media
  and saved keys won't be shared.
- **R2 stays private.** The cockpit streams media through its own `/api/media`
  route, so no public bucket URL / custom domain is needed.
- Obsolete after this migration: `docker-compose.prod.yml`, `deploy/`, Caddy —
  they were the droplet's single-box setup.
