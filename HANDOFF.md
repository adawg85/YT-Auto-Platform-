# Handoff — 2026-07-10 — Live status system shipped + Render migration prep; PICK UP ON THE LAPTOP

Cloud session (remote container). Two features shipped and **merged to `main`**
(`2dc6258` — Render auto-deploys from `main`, so both are rolling out now). The
Render migration itself is still the open item — the operator is moving to the
laptop specifically to finish it, because the cloud session hit two hard walls
(below).

## Shipped to `main` (typecheck + build + full test suite green)
- **Live status system (task #21)** (`2dc6258`) — the operator's #1 UX ask, done:
  `lib/status.ts` maps every production status → working / waiting-on-you /
  scheduled / live / halted; `StatusBadge` (components/ui) renders it identically
  everywhere (pulsing dot while working); a per-production **pipeline stepper** on
  the production page (Script → Voiceover → Visuals → Assemble → Final review →
  Publish; spinner on active, amber at gates, red stage + failure reason when
  stopped — artifact-aware for stopped runs); a **system-status strip** ("N in
  production · N scheduled · N need you · N failed") in the global topbar (polls
  new `/api/status/summary` every 15s) and on the Overview. Live advancement
  rides the existing `/api/live` SSE → router.refresh() (BACKLOG #17). Verified
  with screenshots on a seeded local stack: light+dark, desktop+390px, all five
  status kinds.
- **Render migration tooling** (`419d530`) — `scripts/rekey-secrets.mjs` (secrets
  table migration between DBs: decrypt with source key → re-encrypt with target
  key → upsert → round-trip verify; `--dry-run`; channel tokens skipped by
  default; **tested E2E against the real crypto** incl. the wrong-key path) +
  **`docs/RENDER-RESUME.md`** — the 5-step operator checklist to finish the
  migration. That doc is the migration runbook; below is only what changed since.

## Render migration — state after this session (START HERE ON THE LAPTOP)
Nothing on Render itself changed this session. Two blockers stopped remote work:
1. **The cloud container has no Render access** — the Render MCP from 2026-07-09
   lives in the LAPTOP's `~/.claude.json` (still needs a Claude restart + `/mcp`
   auth once, if not already done). The operator then created a **Render API key**
   and pasted it into the cloud session, but the session's **egress network policy
   blocks `api.render.com`** (proxy 403, org policy — not routable-around).
   → On the laptop, none of this applies: use the Render MCP (or the API key)
   directly. **The API key was shared in a chat session — rotate it after the
   migration.**
2. **The secrets re-key must run on the laptop anyway** — the encrypted keys are
   in the laptop's local Postgres and decrypt only with the local `.env` key.

**Laptop order of operations** (details in `docs/RENDER-RESUME.md`):
1. Flip the worker to **Docker** (or recreate from the Blueprint) + re-sync
   Inngest (12 fns). This is THE gap — native worker cannot render (no Chromium).
2. Run `scripts/rekey-secrets.mjs` (`--dry-run` first) with the Render External
   DB URL + the Render `SECRETS_ENCRYPTION_KEY`.
3. `PUBLIC_BASE_URL` on the cockpit + register the YouTube OAuth redirect in
   Google Cloud Console (Settings tab shows the exact string).
4. R2 `S3_*` env on both services (needs an R2 API token: Object Read & Write on
   bucket `ytauto`).
5. Smoke test (wizard → greenlight → render → publish) → decommission droplet.
   The new status stepper/strip (#21) is the progress instrument for this run —
   it's live on `main`.

## Next feature queue (unchanged, BACKLOG #19)
- IA cleanup: production-timing under Profile; dedupe Settings & DNA vs Profile.
- Warm-up ramp redesign (compact toggles + editable numbers + post-warm-up
  steady videos/month).
- Schedule calendar visual polish; then AI plan & auto-scheduling.

---

# Handoff — 2026-07-09 — Production Profile, engagement fixes, Schedule calendar, + Render migration (in flight)

Huge session. Shipped a stack of pipeline/engagement/UX features to `main`, then
started migrating the whole platform **off the DigitalOcean droplet onto Render**
(the operator wanted faster frontend iteration + a smoother app). The migration is
**~80% done and paused mid-flight** — read "Render migration state" below before
touching anything, and pick it up from the remaining checklist.

## Shipped to `main` today (all typecheck+build+tests green; most runtime-verified live)
- **Facts-gate** (`a027239`) — per-channel `verificationBar.minFactsToScript` (default 3);
  blocks scripting below the bar at the episode-research brief (cut) + the production-
  pipeline factuality gate (on_hold). "No full scripts on 1 fact."
- **Production Profile** (`e44143d`) — per-channel **Profile tab**: tile-picker control
  dashboard (visual style · motion · rhythm · captions · music · persona voice+delivery)
  + live 9:16/16:9 preview + free-text art-direction/notes. `channel_dna.production_profile`
  jsonb (migration 0016) + `resolveProductionProfile()` defaults. Operator-approved as a
  clickable artifact prototype before porting.
- **Profile axes wired into the pipeline:** captions (`4c2d80a`, gate the always-on
  karaoke overlay), visualMode + delivery (`5748b12` — ai-images force generation;
  delivery→ElevenLabs voice_settings), rhythm via **planShots** (`a622e69` — sub-divide
  beats into rhythm-cut shots, one image each → fixes "boring stills"), and **image
  relevance scoring** (`ba68620` — a vision model rejects a wrong sourced photo → generate
  instead; verified live: Spitfire 9 KEEP / banana 0 REJECT). **#4 complete.** Still
  needing their own features: motion AI-video (#6 Higgsfield), music (#5).
- **Schedule bridge + Plan & Schedule calendar** (`b836d75`, #8) — root cause: a
  `publications` row was only written at UPLOAD time, so the schedule was invisible + no
  calendar possible. Now the row is created at SCHEDULE time (nullable video cols,
  migration 0017); gated T1 channels auto-slot onto the warm-up ramp; new `ScheduleCalendar`
  on the channel Schedule tab (+ plan→publish funnel) and the Overview.
- **Inline Plan-tab actions** (`a9d7d50`) — score + greenlight an episode from the Plan
  tab (no trip to Ideas); live production-status chip inline; **auto-score** editorial ideas
  at handoff. Diagnosis: manual scoring always worked; there was just no auto-scoring and
  editorial ideas skipped `scored`.
- **Perf** (`dc8b924`) — instant loading skeletons (channel page + Overview), parallelized
  the channel page's ~11-query waterfall into one `Promise.all`, + FK indexes (migration
  0018). The cockpit was slow because force-dynamic pages blocked on a serial SSR waterfall
  with no loading state.
- **Bug fixes** (`0da4e42`) — voice picker falls back to premade voices when the ElevenLabs
  key lacks `voices_read` (dropdown was showing a raw text box); resume a halted production
  even with no script draft (early halts); a Settings-tab helper showing the exact YouTube
  OAuth redirect URI to whitelist.
- **Deploy** (`75e4c2f`, `dc8b924`) — all-on-Render `render.yaml` blueprint + rewritten
  `DEPLOY.md` runbook (R2 + Inngest Cloud + migrate/fresh).

## Render migration state (IN FLIGHT — resume here)
Operator is moving the whole app to **Render** (retiring the droplet + DigitalOcean).
Decisions locked: **Cloudflare R2** for media · **Inngest Cloud** · **start FRESH** (no data
migration). Also changed the **GitHub default branch → `main`** (was a stale feature branch,
which caused Render to deploy an old build).

**✅ Done:**
- Cockpit + worker + Postgres all **green on Render**, deployed from `main`.
- Inngest Cloud synced — **12 functions** registered (worker on current code).
- R2 bucket `ytauto` created (endpoint `https://2f3618b63e3f27f022f58490e344d7fe.r2.cloudflarestorage.com`).
- Migrations applied on Render Postgres.
- Render MCP added to `~/.claude.json` (HTTP, user scope) — **needs a Claude restart + `/mcp`
  auth (render)** to activate; once live, next session can drive Render directly.

**⏳ Remaining (next session):**
1. **Worker is NATIVE, not Docker** → **video renders WILL FAIL** (no Chromium). This is the
   one real gap. Flip the worker to a **Docker** web service (Dockerfile `apps/worker/Dockerfile`,
   context `.`, branch main, health `/healthz`, higher-CPU plan) + re-sync Inngest.
   *(Cockpit + worker were created as NATIVE Node services, not from the Blueprint — that's why
   both needed Start Commands set: cockpit `pnpm --filter @ytauto/cockpit start`, worker
   `pnpm --filter @ytauto/worker start`. The Docker blueprint avoids all that.)*
2. **Migrate the secret keys** — ✅ script SHIPPED 2026-07-10: `scripts/rekey-secrets.mjs`
   (tested E2E against the real crypto: decrypt-local → re-encrypt-target → round-trip verify;
   `--dry-run` supported; channel tokens skipped by default). Run it LOCALLY with
   `TARGET_DATABASE_URL` (Render External URL) + `TARGET_SECRETS_ENCRYPTION_KEY` — see
   **`docs/RENDER-RESUME.md`** (the full 5-step operator checklist for this whole section).
   Fallback: re-enter on `/account`.
3. **`PUBLIC_BASE_URL`** on the cockpit = its Render URL, + register
   `https://<cockpit>.onrender.com/api/oauth/youtube/callback` in Google Cloud Console (the
   Settings-tab helper shows the exact string).
4. Confirm `S3_*` (R2) env set on **both** services (needs the R2 API token — Access Key ID +
   Secret from R2 → Manage R2 API Tokens).
5. Smoke test: fresh channel via wizard → Score/Greenlight from Plan → render (needs the Docker
   worker) → publish. Then decommission the droplet.

## Still-open feature requests (operator, today — after the migration)
- ~~**Live status system** (task #21)~~ — ✅ SHIPPED 2026-07-10. One status language
  everywhere: `StatusBadge` (lib/status.ts maps every production status → working /
  waiting-on-you / scheduled / live / halted; pulsing dot while working), a per-production
  **pipeline stepper** on the production page (Script → Voiceover → Visuals → Assemble →
  Final review → Publish; spinner on the active stage, red stage + reason when halted;
  advances live via the existing /api/live SSE refresh), a **system-status strip**
  ("N in production · N scheduled · N need you · N failed") in the global topbar (polls
  /api/status/summary every 15s) and on the Overview, and StatusBadge swapped in across
  the channel In-production/Videos tables. Verified with screenshots: light+dark, desktop
  +390px, all five status kinds.
- **IA cleanup:** move production-timing (warm-up ramp) UNDER Profile; strip anything the
  Profile tab covers OUT of Settings & DNA (dedupe).
- **Warm-up ramp redesign:** it hogs space — compact to toggles + editable numbers on the
  right that lock the cycle, PLUS a post-warm-up steady setting (videos/month, hand-editable);
  the on-page AI should be able to tweak it (chat or auto from analysis loops).
- **Schedule calendar** visual polish (to Profile-tab quality).
- **AI plan & auto-scheduling:** on-page AI chat about the plan + an "AI review & schedule"
  button that reads the series/targets/channel state and slots all planned videos onto the
  calendar (produced or not), a cadence review, and at-risk flags ("publishes in <1d, nothing
  ready").
- Deferred perf: `b) per-tab lazy loading` (lower priority once on Render).

---

# Handoff — 2026-07-08 (evening) — first watchable long-form, Tavily research, Plan-tab rework

Same day, evening session. Docker/Postgres back up; ran the **full local stack**
(worker + cockpit) with **real providers** against the local sandbox DB/store, and
drove a real aviation long-form (**Hangar Histories**) end-to-end to the **first
watchable, operator-approved video** (as a test). Detailed capture in **BACKLOG #18**.

**Prod state:** `main` @ `7f194f7` (Tavily connector) — pushed; droplet auto-deploys.
This session's commits: `d710dfb` OpenAI schemaCompat · `d7e7ecb` Stop/Restart+cap3 ·
`a303715` Plan-tab rework · `f01dc25`/`3a92791` Tavily/Exa/Sonar key slots · `7f194f7`
Tavily connector. (STORE_DIR + Adam voice + v3→v2 model are **local `.env`/DB** changes,
not committed — see the local-config note.)

## Shipped this session (see BACKLOG #18 for detail)
- **Tavily research connector** — one search → clean multi-domain sources → the existing
  extract/verify. **Verified live:** 7+ distinct domains (vs old single NTRS); a claim
  corroborated across 4–5 domains; ~$0.016/search. Legacy scrape stays as fallback.
- **Plan-tab rework** — pipeline explainer, plain-English statuses, compact Research-health
  strip (collapsible cut-facts), click-an-episode → facts popup.
- **Stop/Restart research + 3-concurrent-per-channel cap.**
- **OpenAI/GPT-5 structured-output fix** (schema sanitizer).
- **STORE_DIR media-serving fix** — worker/cockpit were reading different `./data/store`
  dirs → cockpit 404'd all media; moved to repo-root `data/store` + absolute STORE_DIR.
- **Adam voice** (channel + global fallback); **first long-form video rendered E2E**
  (Adam `multilingual_v2`, 7:51, 303 MB) to the final gate — approved.

## Critical findings from the run
- **v3 can't do long-form** — `eleven_v3` caps at 5000 chars; scripts run ~6700 → 400
  `text_too_long`. Fell back to `multilingual_v2`. v3 needs text-chunking.
- **Long-form render is slow** — ~28 min for 8-min/14k-frame on CPU `swangle` @ conc 2.
- **Render fragility** — Remotion loads beat images over `http://localhost:3010/store`;
  a stale/zombie worker (tsx-watch `EADDRINUSE` churn) served the wrong store path → 404
  → render failed. Read bytes from the ObjectStore directly instead.
- **Failed force-forward dead-ends** — pipeline idempotency keyed on productionId; a
  failed run can't be re-fired (had to mint a fresh production).
- **Auto-publish/auto-schedule still UNPROVEN** — reached the final gate, nothing has
  been uploaded/scheduled/published to YouTube E2E yet.

## Local-config note (not in git — re-apply on a fresh clone/machine)
- `.env`: `STORE_DIR=<repo>/data/store` (absolute), `ELEVENLABS_VOICE_ID=pNInz6obpgDQGcFmaJgB`
  (Adam), `ELEVENLABS_MODEL_ID=eleven_multilingual_v2`.
- DB: `channel_dna.voice_id` = Adam for Hangar Histories; Tavily key stored under
  `TAVILY_API_KEY` on `/account` (moved off the mislabeled `S3_ENDPOINT` slot).

## Suggested sequence (next up) — operator's list + this session's findings
1. ~~**Facts-gate + constrain the writer**~~ — ✅ SHIPPED 2026-07-09 (`a027239`,
   BACKLOG #18). Per-channel `verificationBar.minFactsToScript` (default 3) blocks
   scripting below the bar at both the episode-research brief (cut) and the
   production-pipeline factuality gate (on_hold). Writer-constraint was already in
   place. Not yet exercised E2E through Inngest — verify on the next real run.
2. ~~**Production Profile scaffold (control plane)**~~ — ✅ SHIPPED 2026-07-09 (`e44143d`,
   BACKLOG #18). Per-channel **Profile tab**: tile-picker dashboard (visual style · motion ·
   rhythm · captions · music · persona voice+delivery) + live 9:16/16:9 preview + free-text
   art-direction/notes. `channel_dna.production_profile` jsonb (migration 0016) +
   `resolveProductionProfile()` defaults; VoicePicker wired into Persona. Each axis is a
   seam (tagged live/soon). Runtime-verified live on the local stack (tab render light+dark,
   16:9 long-form preview, save round-trip persisted to `production_profile`). **Axes now
   wired into the pipeline:** captions (`4c2d80a`), visualMode + delivery (`5748b12`). Still
   read-but-waiting on unbuilt features: motion AI-video (#6), music (#5), rhythm cutting (#4).
3. ~~**Captions on Shorts**~~ — ✅ SHIPPED 2026-07-09 (`4c2d80a`). The karaoke overlay
   already existed but was always-on; now gated on `productionProfile.captions` (default
   ON Shorts / OFF long-form) — the first wired Profile axis. Verified via unit test +
   Remotion still (burns in when on, nothing when off).
4. **Image density + rhythm cuts** — ✅ cut 1 SHIPPED 2026-07-09 (`a622e69`). `planShots`
   sub-divides beats into shots cut on the spoken rhythm (sentence/pause from word
   timestamps), one image per shot → the frame keeps moving; lights up the Profile rhythm
   axis. Fixes the "boring stills" note. **Cut 2 also SHIPPED (`ba68620`):** image relevance
   SCORING — a vision model scores whether a sourced Wikimedia image fits the shot; poor fit
   → generate instead (verified live: Spitfire 9 KEEP / banana 0 REJECT). **#4 complete.**
5. **Background music** — optional ducked music bed (per-channel toggle).
6. **Higgsfield AI video (partial first)** — motion on key beats; gated by the Profile.
7. **Long-form render speed** — concurrency bump / GPU / cloud render; also move the
   render to read from the store directly (removes the :3010/store failure mode).
8. **Schedule bridge + Calendar UI** — ✅ SHIPPED 2026-07-09 (`b836d75`). The schedule was
   invisible (no `publications` row until upload time); now the row is created at schedule
   time (nullable video cols, migration 0017), gated channels auto-slot onto the ramp, and
   there's a **Plan & Schedule calendar** on the channel Schedule tab (+ plan→publish funnel)
   and a cross-channel Overview Schedule tab. Verified live. **Remaining:** the full
   worker-driven approve→scheduled→published (mock) run, and real-YouTube publish (needs the
   test channel connected).
9. **Expand-images lightbox** on the production review page (quick).
- **Deferred:** v3 chunking; Exa/Sonar connectors; STORE_DIR default hardening +
  failed-run retry + dev kill-port story; optional render compression (CRF/h265).

---

# Handoff — 2026-07-08 (morning) — first live walkthrough

First end-to-end live walkthrough of **channel creation → production pipeline**
on prod (`app.commongroundsocial.com.au`). Focus was validating the flow and
fixing whatever blocked it. Docker/Postgres was down on the dev machine all
session, so everything was built against static gates (typecheck/build/tests)
and validated by the operator on the live droplet.

## Shipped today (all merged to `main` + deployed)

**Wizard / setup UX**
- Pre-filled step-1 fields (format, research depth, cadence, length, autonomy,
  monetisation-safe), Back-nav + clickable step chips, persistent co-pilot dock,
  "Generate 3 more" identities, channel avatar generation, **draft autosave**
  (localStorage — survives refresh/crash), review-step **preset objectives**
  (tick + counters) and **tone quick-pick chips**.
- Tabbed **/account** — Models tab (per-tier vendor+model picker) + API keys tab.
- **Channel deletion** — Danger-zone button on Settings & DNA with a Dialog
  confirm (transactional child cleanup).

**Bug fixes (in order found)**
- **Qwen json_object** — DashScope needs the word "json" in the prompt; added an
  `ensureJsonWord` middleware (`packages/providers/src/real/llm.ts`).
- **Strict schema bounds vs real models** — relaxed hard `.min/.max/.length` to
  describe-hints (+ clamp) on charter/identity/rubric/script-beats/thumbnail.
  This bug class recurred all day (see Learnings).
- **Score button crash** — rubric `score.min(0).max(10)`; relaxed + clamp.
- **"Server Action not found" after every deploy** — pinned
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (Dockerfile build arg + compose +
  `.env`).
- **YouTube "redirect_uri_mismatch"** — behind Caddy, Next resolved
  `req.nextUrl.origin` to `https://localhost:3000`; pinned the OAuth redirect to
  `PUBLIC_BASE_URL` in both start/callback routes.
- **Voiceover 404 stall** — channel `voiceId` was the placeholder `"default"`;
  ElevenLabs provider now resolves it to `ELEVENLABS_VOICE_ID` (else the Rachel
  premade).

Default LLM tiers were set to **qwen-max** (frontier+agentic via OpenRouter),
then the operator moved everything to **Anthropic** on /account for reliability
(see Learnings). Cheap tier = Gemini Flash.

## Key learnings (why the bugs happened)

1. **Structured-output reliability.** Qwen/DashScope only supports
   `response_format: json_object` (no strict `json_schema`), so on complex nested
   schemas its JSON often fails local zod validation → `generateObject` retries →
   **tokens burned, production silently stuck**. Anthropic/Gemini do native
   strict structured output and are reliable. Complex-schema tiers (frontier =
   scripts/charters) should stay on json_schema-capable models, or the
   json_object path needs a repair/reprompt step. (BACKLOG #15)
2. **Strict zod bounds are landmines.** The mock always returns in-bounds output,
   so `.min/.max/.length` bugs were invisible until real models (which overshoot)
   ran. Fix pattern: relax to `.describe()` hints + clamp in code. **More schemas
   likely still have this — a full audit is worth doing.**
3. **Failed agent calls burn untracked spend.** `runAgent` records a cost line
   only *after* success, so failed retries consume provider tokens with no cost
   record (Qwen dashboard showed usage the cockpit never logged). (BACKLOG #15)
4. **No retry/reset for stuck productions.** A failed step leaves a production in
   limbo; we reset via raw SQL (`ideas.status='scored'` + delete stuck
   `productions`). Need a UI Retry action. (BACKLOG #15)
5. **Every code deploy is disruptive.** A push rebuilds → new server-actions key
   (now pinned) + worker restart (interrupts in-flight productions) + client RSC
   prefetch failures until a hard refresh. **Docs-only pushes are safe** —
   `BACKLOG.md`/`.env.example` aren't in the cockpit build context, so they don't
   rebuild it. Prefer docs pushes during a live session.
6. **Console noise ≠ app bugs.** Wallet extensions (`evmAsk.js`, `inpage.js`,
   `contentscript.js`, "message channel closed") and post-deploy `_rsc` prefetch
   failures are harmless. Only traces through the app's own hashed bundle or an
   `app.commongroundsocial.com.au/...` request are real.

## Operator `.env` steps (verify these are done on the droplet)

Add to the droplet `.env`, then `docker compose -f docker-compose.prod.yml up -d --build`:
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=` (openssl rand -base64 32) — stops the
  server-action errors + tab breaks on redeploy.
- `PUBLIC_BASE_URL=https://commongroundsocial.com.au` — makes YouTube Connect work.
- `ELEVENLABS_VOICE_ID=bfGb7JTLUnZebZRiFYyq` — the operator's "Adam – Distinct,
  Deep, and engaging" voice; the global default until per-channel voice ships.

## Current pipeline state

- One charter'd channel; frontier/agentic tiers = Anthropic; ElevenLabs + fal
  connected (real assets); YouTube **not** connected yet (publish is mock).
- Dead productions to recover: ~3 stuck at `scripting` (Qwen-era validation
  failures) and 1 stuck at `producing_assets` (the voiceover 404). **Now
  recoverable from the UI** — open each production and hit **"Halt & return to
  ideas"** (keep or discard its artifacts); the golden idea returns to the pool
  as `scored`, ready to re-greenlight fresh. No more raw SQL. (BACKLOG #15
  Land 1, shipped 2026-07-08 — needs the redeploy that carries migration 0011.)

## Start here tomorrow

1. **Confirm the `.env` redeploy ran** (voice + the two keys). Sanity-check:
   `docker compose -f docker-compose.prod.yml exec -T worker sh -c 'echo $ELEVENLABS_VOICE_ID'`.
2. **Greenlight ONE fresh idea** and walk it end-to-end: Script gate → voiceover
   (Adam voice) → images → render → **Review → Final cuts** (pick thumbnail) →
   mock publish. This is the outstanding "validate the flow" goal.
3. **Connect YouTube** (now that `PUBLIC_BASE_URL` is set) and test a real
   private publish + Release.
4. Then pick a UX batch — all design-skill-led, and get **Docker up locally** so
   the redesign can be screenshotted (it couldn't be all session):
   - **BACKLOG #14** — wizard step-1 redesign (janky grid/spacing, format-dependent
     length, release schedule, side-drawer co-pilot), cross-channel **Production
     Flow** view, per-row status/failure surfacing, tabbed Review with aggregate
     approvals, Schedule + Calendar, embedded assistant, per-channel voice pick.
   - **BACKLOG #15** — length-aware scriptwriter (scripts come out far under the
     target length; critical for long-form), Retry-production action, untracked
     failure spend, Qwen structured-output hardening, and a **full strict-schema
     audit** (learning #2).

## Reference
- Backlog: `BACKLOG.md` §14 (UX overhaul) + §15 (pipeline quality).
- Today's commits: `3fec8bd` … `a7ea12e` on `main`.
