# Remotion Lambda renders (BACKLOG #18)

Renders fan out across AWS Lambdas: **~2–4 min for 8-min long-form** (was ~28 min on the
Render worker), **under a minute for Shorts** (was ~16 min). Pay-per-render-second
(~$0.01–0.03/Short, ~$0.15–0.35/long-form), zero idle. Final `final.mp4` is written by
the Lambda **directly to the R2 bucket** — same storage key as the local render, so the
rest of the pipeline is unchanged.

## One-time AWS setup (operator, ~30 min)

1. **Account**: create/choose an AWS account (billing enabled). Region: **ap-southeast-2**.
2. **IAM role**: AWS console → IAM → Roles → Create role → "Lambda" use case →
   skip permission attach → name it `remotion-lambda-role` → after creating, attach an
   inline policy with the JSON from:
   `pnpm --filter @ytauto/worker exec npx remotion lambda policies role`
3. **IAM user**: IAM → Users → Create `remotion-user` (no console access) → inline
   policy JSON from:
   `pnpm --filter @ytauto/worker exec npx remotion lambda policies user`
   → Security credentials → Create access key (CLI) → save the key pair.
4. **Quota (do this day one — approval takes hours-to-days)**: Service Quotas →
   AWS Lambda → *Concurrent executions* → request **1000**. New accounts often start
   at **10**: Shorts fit, long-form (~150 concurrent) does not until this lands.
5. Sanity check: `npx remotion lambda policies validate` (with the REMOTION_AWS_* env set).

## Deploy the function + site

```
REMOTION_AWS_ACCESS_KEY_ID=…  REMOTION_AWS_SECRET_ACCESS_KEY=…  REMOTION_AWS_REGION=ap-southeast-2 \
pnpm --filter @ytauto/worker exec tsx scripts/remotion-lambda-deploy.ts
```

Prints `REMOTION_LAMBDA_FUNCTION_NAME` and `REMOTION_SERVE_URL`.

**When to rerun**: any `packages/video` change → redeploys the site (same serve URL);
any `@remotion/*` version bump → function AND site (all `@remotion/*` packages are
pinned to the exact same version in package.json — keep it that way; the deployed
function is version-coupled and a silent caret bump would orphan it).

## Configure (flip on / off without deploys)

On `/account` → **Cloud render (Remotion Lambda)**, set all five:
`REMOTION_AWS_ACCESS_KEY_ID`, `REMOTION_AWS_SECRET_ACCESS_KEY`, `REMOTION_AWS_REGION`,
`REMOTION_LAMBDA_FUNCTION_NAME`, `REMOTION_SERVE_URL`.

The next render (≤15s config TTL) uses Lambda. **Fallback**: clear
`REMOTION_LAMBDA_FUNCTION_NAME` → next render uses the local CPU path (the worker image
keeps Chromium for exactly this reason). Mock mode always renders locally.

Requires the R2 object store (`S3_*` secrets): assets reach the renderers as presigned
R2 URLs (2h TTL) and the output is written back to R2 via `s3OutputProvider`.

## Debugging

- The render step logs `renderId`, the Remotion bucket, and a **CloudWatch logs link**
  as soon as the render starts.
- `npx remotion lambda renders ls` / `… renders get <renderId>` (with REMOTION_AWS_* set).
- Fatal Lambda errors fail the Inngest step with the Lambda error detail; Inngest
  retries re-render from scratch (~$0.02–0.35 duplicate cost — accepted).
- Until the concurrency quota lift lands, set `REMOTION_MAX_CONCURRENCY=8` on the
  worker: chunk size is derived per video so ANY length (long-form included) fits the
  quota (~6-9 min for 8-min long-form at cap 8). Clear it once the 1000 quota is
  approved — Remotion then auto-fans to ~150 lambdas (2-4 min). `REMOTION_FRAMES_PER_LAMBDA`
  remains as an explicit override.

## Cost

Recorded per render from Remotion's own accrued-cost estimate
(`progress.costs.accruedSoFar`) under provider **`remotion-lambda`** — check /costs.
Local renders keep the flat `RENDER_COST_PER_HOUR` attribution under `remotion`.

License note: Remotion Lambda is free for individuals and companies ≤3 people; larger
companies need a paid company license.

## Later cleanup (after weeks of clean Lambda runs)

Downsize the Render worker plan (renders no longer need pro), drop
`NODE_OPTIONS=--max-old-space-size=3072`, and slim the Dockerfile's Chromium/font
layers + `remotion browser ensure` (they exist only for the local fallback).

## Keeping the site bundle fresh (2026-07-18 incident — READ THIS)

The Lambda **site bundle** (`sites/ytauto`, a fixed `REMOTION_SERVE_URL`) is
deployed SEPARATELY from the worker and does NOT refresh on a normal push. In
July 2026 it silently drifted 7 days stale — it predated clip compositing
(07-12) and the music bed (07-16) — so every Lambda render was a silent,
clip-less slideshow while the worker (correctly) stamped `renderMeta` claiming
clips+music were present. Nothing caught it; days were lost force-forwarding and
retrying, which can't help when the bundle itself is old.

Guardrails now in place:

- **Fail-loud guard.** `assertLambdaSiteFresh` (apps/worker/src/render-lambda.ts)
  HEADs the deployed `bundle.js` and the render step refuses to render on a
  bundle older than `COMPOSITION_BUNDLE_MIN_DATE`
  (packages/video/src/version.ts) — it parks the production `on_hold` with a
  redeploy instruction instead of shipping a broken cut.
- **The rule:** whenever you change the composition output (ShortComposition /
  Root / ShortProps — new layers, timing, prop shape), **bump
  `COMPOSITION_BUNDLE_MIN_DATE` AND redeploy the site.** Redeploy with:

      pnpm lambda:deploy   # = tsx apps/worker/scripts/remotion-lambda-deploy.ts

  It overwrites the site in place (serveUrl stays stable — no /account change).
  `index.html` is a static shell whose Last-Modified never changes; the real
  bundle is `sites/ytauto/bundle.js` — check THAT object's Last-Modified to
  confirm a deploy landed.
- If the worker preDeploy is wired to run `lambda:deploy` (needs the
  `REMOTION_AWS_*` creds as Render env vars), the site auto-refreshes on every
  push and the guard becomes a pure backstop.
