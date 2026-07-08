# Handoff — 2026-07-08

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
