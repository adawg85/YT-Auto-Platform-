# Resume the Render migration — operator checklist (2026-07-10)

The migration is ~80% done (see `HANDOFF.md` "Render migration state" and
`BACKLOG.md` #19). Cockpit + worker + Postgres are green on Render from `main`,
Inngest Cloud is synced (12 fns), R2 bucket `ytauto` exists, migrations are
applied. What's left is five steps — all dashboard clicks except step 2, which
is now a tested one-shot script. Do them in order; total ≈ 20 min.

## 1. Flip the worker to Docker (renders fail until this is done)

The current `ytauto-worker` is a NATIVE Node service — no Chromium, so any
video render will fail. Two ways to fix; **(a) is cleaner**:

- **(a) Recreate from the Blueprint** — Render dashboard → New → Blueprint →
  point at this repo (`render.yaml` already defines the worker as
  `runtime: docker`, `dockerfilePath: ./apps/worker/Dockerfile`, context `.`,
  health `/healthz`, plan `pro`). Delete the old native worker after the new
  one is green, then copy its env vars over first (step 4 list).
- **(b) Manual** — New → Web Service → this repo → Runtime **Docker**,
  Dockerfile path `./apps/worker/Dockerfile`, Docker build context `.`,
  branch `main`, health check `/healthz`, plan `pro` (2 CPU; renders are
  CPU-bound). No start command needed — the image's CMD handles it.

Then **re-sync Inngest Cloud** to the new worker URL (Inngest dashboard →
app → sync → `https://<new-worker>.onrender.com/api/inngest`) and confirm
12 functions register.

## 2. Migrate the secret keys — `scripts/rekey-secrets.mjs` (tested)

Run **locally on the machine that has the local `.env` + local DB** (the
laptop that ran the local stack). It decrypts every row of the local
`secrets` table with the local key and re-encrypts into the Render DB under
the Render key. Nothing is printed in plaintext.

```bash
# from the repo root (source DB/key default from the local .env)
TARGET_DATABASE_URL='<Render "External Database URL" for ytauto-db>' \
TARGET_SECRETS_ENCRYPTION_KEY='<SECRETS_ENCRYPTION_KEY value set on the Render services>' \
node scripts/rekey-secrets.mjs --dry-run   # inspect the list first
# then re-run without --dry-run
```

- The External Database URL is on the Render dashboard → ytauto-db →
  Connect → External.
- `TARGET_SECRETS_ENCRYPTION_KEY` must be the exact value both Render
  services carry (the generated `9ebdad236a…` one) — the script verifies
  every row round-trips before reporting ✓.
- Per-channel YouTube tokens are skipped by default (channel ids don't exist
  in the fresh DB); `--include-channel-tokens` copies them if ever needed.
- Fallback if anything fails: re-enter the 8 keys on `/account`
  (ANTHROPIC / ELEVENLABS / FAL / OPENAI / TAVILY + 3 `LLM_MODEL_*`).

## 3. `PUBLIC_BASE_URL` + YouTube OAuth

- Cockpit service → Environment → `PUBLIC_BASE_URL` =
  `https://<cockpit>.onrender.com` (no trailing slash).
- Google Cloud Console → the OAuth client → Authorized redirect URIs → add
  `https://<cockpit>.onrender.com/api/oauth/youtube/callback`.
  (The cockpit Settings tab has a helper showing the exact string.)

## 4. Confirm R2 `S3_*` env on BOTH services

Needs an R2 API token: Cloudflare → R2 → Manage R2 API Tokens → create
(Object Read & Write, bucket `ytauto`). Then on **both** cockpit and worker:

| var | value |
|---|---|
| `S3_ENDPOINT` | `https://2f3618b63e3f27f022f58490e344d7fe.r2.cloudflarestorage.com` |
| `S3_REGION` | `auto` |
| `S3_BUCKET` | `ytauto` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | from the R2 token |

## 5. Smoke test, then decommission

1. Fresh channel via the wizard → charter → plan.
2. Score + greenlight one episode from the Plan tab.
3. Watch the production run end-to-end — the render is the real test of the
   Docker worker (step 1).
4. Publish (mock or private real), confirm media serves from R2.
5. Decommission the droplet + DigitalOcean resources. Keep the local stack
   as the sandbox (`docs/LOCAL.md`).
