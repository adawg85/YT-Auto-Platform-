# Session status / handoff

Working notes for picking the project back up on another machine. Living doc —
update the top block each session.

## ▶ PICK UP HERE (handoff 2026-07-07 — desktop session, design merge)

**Prod state:** `main` @ `ad88fb5` auto-deployed and **verified live**
(`app.commongroundsocial.com.au`; webhook `deploy: SUCCESS`, `ytauto-cockpit-1`
recreated; Postgres healthy). Prod build passed locally before merge.

**What this session did — cockpit design-system, reconciled (PR #11):** this
desktop had done a parallel UI overhaul on a stale `main`; rather than overwrite
the laptop's work, it was **merged as a union**. Kept main's screens + lucide
icons + `.btn` system + features (chat assistant, briefings, multi-vendor router);
layered on the refreshed **indigo accent + slate tokens**, **JetBrains Mono**, the
`components/ui/*` primitives, `RadarChart`, and a `/design-system` reference route.
`typecheck` + prod build pass. Also bundled the MIT `ui-ux-pro-max` skill pack in
`.claude/skills/` + a tooling section in `CLAUDE.md`.
> Lesson (now in `CLAUDE.md`): local `main` here was 33 commits stale — always
> `git fetch` + base UI work on `origin/main` and check for parallel `claude/*`
> branches before touching shared files (`globals.css`, `icons.tsx`, page files).

**PARKED (deprioritised) — dashboard UI/UX look-and-feel:** operator's concern is
NOT the colour/tokens but the overall *look and feel* / composition of the
dashboard. Spec'd as **BACKLOG #13**; pick up later with the `ui-ux-pro-max` skill,
extending the `/design-system` primitives. Minor open sign-off: accent A/B/C
(default A indigo), product name ("YT Auto"), logo — all at `/design-system`.

**Still open from the prior (laptop) handoff below** — the charter-bug fix,
creating the real aviation channel, and pod provisioning were NOT touched this
session; see the demoted block immediately below.

---

## Prior handoff (2026-07-07 end-of-day — laptop session) — operational to-dos still open

**Prod state:** `main` @ `a4cc520` auto-deployed (webhook healthy; migrations
0008 + 0009 applied by the compose one-shot). Everything from today is merged
— builds #5.2, the UI overhaul + polish, the strategy capture (#6 rewrite,
#9–#12), two research reports, the viability foundation, and the **direct
multi-vendor LLM router**. Working branch and `main` are identical; no WIP
anywhere.

**Do these in order on the laptop:**

1. **Kill the charter bug (10 min, likely no SSH needed now).** On
   `/account`: add `ANTHROPIC_API_KEY` (console.anthropic.com; optionally
   `GEMINI_API_KEY`, `ZAI_API_KEY`, `DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`),
   then CLEAR the three LLM tier fields (defaults become Claude-direct
   frontier/agentic + Gemini-direct cheap) or set vendor-prefixed refs
   (`anthropic:claude-opus-4-8`, `glm:glm-4.6`, `kimi:kimi-k2-turbo-preview`…).
   Retry "Draft charter with AI" — requests now go straight to Anthropic's
   API (native structured outputs; the Azure/Bedrock strict-schema lottery is
   out of the path), and the wizard badge now shows the REAL error message in
   prod if anything still fails. Only fall back to the SSH runbook below if
   it does.
2. **Create the real aviation channel** via `/channels/new` (T1). Then Plan
   tab → "Plan / research now" → approve the arc; Briefings tab → "Run
   check-in now" → answer it. This lights up #5/#5.2 end-to-end on prod.
3. **Provision per the pod model** (see `docs/research/accounts-and-offplatform.md`):
   dedicated Google account with unique recovery phone/email, Brand-Account
   channel, per-channel OAuth (Settings tab → Connect YouTube), manual Studio
   pass for handle/social links. Socials are optional branding/funnel — NOT a
   ranking lever.
4. **Belt-and-suspenders e2e** (never run on a real machine):
   `node scripts/build52-test.mjs` with the local stack up (`pnpm db:migrate`
   first — 0008+0009).
5. **Optional cleanups:** archive the duplicate "Everyday Physics" seed
   channel (SQL one-liner in the chat log / or pause it in the UI); check
   GitHub → Settings → Webhooks for a stale duplicate entry (the droplet log
   showed some `rejected: bad signature` deliveries).

**Next build candidates (all specced, pick one):** viability checkpoint
wiring (#10 — foundation shipped, policy dormant); SEO/AEO injection (#11 —
the 12-rule block in `docs/research/video-seo-aeo.md` → scriptwriter
grounding + a metadata step); linked long-form/shorts pairs (#6). Read both
`docs/research/` reports before channel-farm decisions — they overturned two
assumptions (no performance contamination across channels; socials don't
rank).

---

## Superseded runbook (kept for reference): charter drafting failing on prod

**Largely superseded by the multi-vendor router above** — the failing path
(OpenRouter → Azure/Bedrock strict validators) is no longer the default
route, and the wizard now surfaces real error messages. Still useful if step
1 above doesn't fix it:

1. **Confirm the droplet is on the latest main.** `cd /root/ytauto && git log
   -1 --oneline` — must match `origin/main` HEAD (check GitHub). The last
   deployed fix hashes: `83aef7e` (minItems sanitizer) and the follow-up
   merge after it (full keyword sanitizer — minimum/maximum/minLength/etc.).
   If behind: `git pull && docker compose -f docker-compose.prod.yml up -d
   --build`, then hard-refresh the browser.
2. **Reproduce with live logs.** `docker compose -f docker-compose.prod.yml
   logs cockpit -f`, then click "Draft charter with AI". The previous
   failure was `AI_APICallError` HTTP 400 from
   `openrouter.ai/api/v1/chat/completions`: *"For 'array' type, 'minItems'
   values other than 0 or 1 are not supported (got: [2, 5])"* — upstream
   providers named in the error were **Azure** and **Amazon Bedrock**.
   Whatever the NEW error line says is the next lead — the wizard's red
   error badge is useless in prod because **Next.js redacts server-action
   error messages in production** (only a digest reaches the browser); the
   real message is only in the cockpit container log.
3. **Check the model routing on `/account`.** The Azure/Bedrock provider
   names imply the LLM tier models were overridden there (defaults are
   `anthropic/*` + `google/gemini-2.5-flash-lite`, which accept json_schema
   via OpenRouter natively). If `LLM_MODEL_AGENTIC`/`LLM_MODEL_FRONTIER`
   point at models served by Azure/Bedrock, either the sanitizer must fully
   cover their strict mode (two rounds shipped — see below) or switch the
   tiers back to `anthropic/claude-sonnet-5` / `claude-opus-4.8` as a
   controlled test. First just reproduce and read the 400 body, though.
4. **What's already fixed** (both in `packages/providers/src/real/llm.ts`,
   applied via `wrapLanguageModel` middleware so it covers every agent):
   round 1 stripped array `minItems>1`/`maxItems`; round 2 strips
   `minimum`/`maximum`/`exclusiveMin|Max`/`multipleOf` (numbers) and
   `minLength`/`maxLength`/`pattern`/non-datetime `format` (strings), all
   folded into field descriptions. Verified: charter + identity schemas
   sanitize clean; zod still validates responses; 52 provider tests green.
   `sanitizeSchemaForProviders` is exported — extend it there if a new
   keyword shows up in the 400.
5. **Escape hatches while debugging:** the classic form
   (`/channels/new/manual`) creates channels without AI; mock mode
   (`PROVIDERS_FORCE_MOCK=1`) proves the wizard UI path end-to-end (verified
   working in the sandbox this session, all 4 steps).
6. **Improvement while in there (small):** make the charter server action
   return `{ error: string }` instead of throwing, so the wizard badge shows
   the real provider message in production instead of Next's redacted digest.

**Also this session (all on `main`):** full cockpit UI/UX overhaul (design
system, one `.btn` button system, lucide-react icons, Inter, humanized
labels/dates via `lib/format.ts`, designed empty states, hover/depth pass,
per-page 390px mobile pass — audit in `UI-REVIEW.md`); `CLAUDE.md` added with
the **main-first git workflow** (fetch all branches, base on `origin/main`,
nothing is done until it's merged to `main` — this session initially built on
a stale snapshot and the work sat invisible on a side branch; the rule
prevents a repeat); fresh-install gotcha documented: **pgvector extension**
required by migration 0006 (droplet compose already uses
`pgvector/pgvector:pg16`; plain Postgres needs `postgresql-16-pgvector` +
`CREATE EXTENSION vector`). Webhook deploys confirmed healthy end-to-end
(`/var/log/ytauto-webhook.log` — note it logs there, not journald).

---

## LLM routing is now DIRECT multi-vendor (2026-07-07, after the above)

The charter-bug root cause class (OpenRouter upstream lottery: Azure/Bedrock
strict json_schema validators) is retired: the platform now holds direct
vendor keys and routes tiers itself (`createLLMRouter` in
`packages/providers/src/real/llm.ts`). Vendor-prefixed refs
(`anthropic:claude-opus-4-8`, `google:gemini-2.5-flash-lite`, `glm:glm-4.6`,
`qwen:qwen-plus`, `kimi:kimi-k2-turbo-preview`, `openrouter:<slug>`; bare ids
still = OpenRouter). Defaults: Claude direct for frontier+agentic, Gemini
direct for cheap, OpenRouter fallback, mock with zero keys. **Operator setup:
add `ANTHROPIC_API_KEY` (and optionally `GEMINI_API_KEY` / `ZAI_API_KEY` /
`DASHSCOPE_API_KEY` / `MOONSHOT_API_KEY`) on /account, clear or re-prefix the
LLM tier fields, retry "Draft charter with AI".** The wizard now surfaces
REAL provider error messages in prod (actions return {error} instead of
throwing). Sanitizer middleware still wraps every OpenAI-compatible + Gemini
path; Anthropic uses native structured outputs.

## Strategy + research session (2026-07-07, merged alongside the above)

**BACKLOG gained #9–#12** (account & off-platform architecture, the two
impression checkpoints incl. the month-one 20-videos/100k bar + never-delete
rule, SEO/AEO metadata engine, info-gain niches + stack prefs) and the **#6
rewrite** (derived shorts publish on a LINKED companion channel, never the
long-form channel). **Two adversarially-verified research reports live in
`docs/research/` — read both; their verdicts are folded into #9–#12:**
pod accounts (3–10 same-risk Brand-Account channels per Google account), NOT
one-email-per-channel; contamination is violation-based only (never re-upload
a struck channel's content into a sibling); socials demoted to
branding/funnel (not a YT ranking signal; header links are Studio-manual, no
API); AI engines cite long-form not Shorts (94/5.7) so AEO rides on #6
long-form; tags are cargo cult; the 12-rule `RULES FOR EVERY VIDEO` prompt
block is in `docs/research/video-seo-aeo.md`. The **viability guardrail
foundation is SHIPPED** (snapshots `impressions` column via migration 0009,
mock provider + ingest write, dormant policy in `packages/core/src/viability.ts`);
remaining work is wiring the two checkpoints into alerts/briefings/cockpit.
YouTube Analytics impressions availability needs a live-channel probe (real
adapter reports null → policy says "unknown").

## Previous handoff (2026-07-06 late, Build #5.2 MERGED + deploying)

**Build #5.2 — review board + operator briefings + experimentation — is
MERGED to `main`** (`67a134c`, PR #2) and auto-deploying to the droplet via
the push webhook; the compose `migrate` one-shot applies migration **0008**
(channel_briefings, experiments, productions.experiment_id, 3 new decision
kinds — purely additive) before the new code starts. Full scope + file map in
`BACKLOG.md` #5 → "#5.2 shipped". What landed: the multi-checker pre-publish
review board (compliance / charter-alignment / platform-safety hard checkers
+ advisory retention prediction, wired after the variation check with the
on_hold + evidence-row triad), operator briefings on the charter's
`checkinCadence` (daily `operator-briefing` cron, cockpit **Briefings tab**,
responses → `briefing_response` decision rows → planner/writer prompts), and
one-variable experiments (proposed in briefings, operator-approved on T0/T1 /
auto on T2+, scriptwriter directive + production tagging, deterministic
conclusion vs channel baseline).

**Health:** `pnpm typecheck` 13/13, `pnpm test` 115 (61 core + 52 providers +
2 worker) — all green. **Merged ahead of the e2e by operator call** (sandbox
has no Docker; prod has no charter'd channels yet, so nothing exercises the
new paths until the aviation channel exists): run `scripts/build52-test.mjs`
on the desktop as belt-and-suspenders (local stack + `pnpm db:migrate` first).

**Operator to-dos (phone-friendly — no SSH needed):**
1. **Account secrets on `/account`** (encrypted in the DB, override env, take
   effect immediately — no redeploy):
   - **DO Spaces:** `S3_ENDPOINT` (`https://<region>.digitaloceanspaces.com`),
     `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
     New renders/assets write to Spaces from then on (BACKLOG #7 keep-finals).
   - **YouTube:** save `YOUTUBE_CLIENT_ID` + `YOUTUBE_CLIENT_SECRET` on
     /account, then connect each channel via its **Settings tab → Connect
     YouTube** (per-channel refresh token lands encrypted automatically —
     never paste per-channel tokens by hand). Prereq in Google Cloud console:
     add `https://app.commongroundsocial.com.au/api/oauth/youtube/callback`
     as an authorized redirect URI. The global `YOUTUBE_REFRESH_TOKEN` field
     is only the v1 single-token fallback — per-channel OAuth supersedes it.
   - Provider keys as needed: `OPENROUTER_API_KEY` (real LLM),
     `ELEVENLABS_API_KEY` (voice), `FAL_KEY` (media).
   - Env-only knobs (droplet `.env` + redeploy, NOT on /account):
     `RESEARCH_PROVIDER=youtube`, `SOURCE_CONNECTORS=real`, `OPENAI_API_KEY`
     (embeddings), Inngest keys, `SECRETS_ENCRYPTION_KEY` (rotating it
     orphans stored keys — re-enter them on /account after).
2. **Create the REAL aviation channel** via the wizard (`/channels/new`,
   works from a phone) → Briefings tab → "Run check-in now" to see #5.2 live.
   Hand-provision YouTube (wizard's last step checklist) + OAuth when home.
3. Desktop: `node scripts/build52-test.mjs`; sanity-poke wizard + Plan tab on
   prod.
4. Next build candidates: #6 (format modes), #7 (assets + Spaces storage),
   or the vidIQ transcript fix filed on #4.

---

## Previous handoff (2026-07-06, Build #5 shipped locally)

**Build #5 — the editorial engine (core loop) — is BUILT and e2e-verified
locally** (full status in `BACKLOG.md` #5). Scope was agreed with the operator:
core loop this build (charter + wizard → source connectors → tiered
verification → series planner → pgvector memory); review board, briefings and
experimentation are **#5.2**. Per-video human gate stays ON for the starter
channel; briefings will be in-platform.

**e2e proof (scripts/build5-test.mjs, all mocked, passed 2026-07-06):** wizard
created an aviation-history channel with an AI charter + identity ("The
Aviation Files"), the planner proposed a 12-episode arc (operator-approved on
the Plan tab), episode research verified claims tiered (per episode: 3
verified across 2 independent mock domains, 1 attributed, 1 deliberately cut),
the factuality gate passed citations into the script gate UI, the full
pipeline rendered + published, the coverage summary carried into channel-scope
memory (episode dump marked prunable), and the charter-less physics channel
ran the pipeline with the gate skipped (regression). DB invariants checked:
scope tiers, distinct-domain citations, claim statuses.

**✅ DEPLOYED TO PROD (2026-07-06 evening).** The push webhook auto-deployed
`main`@`8a21c5c`: postgres recreated on `pgvector/pgvector:pg16`, migrations
0006+0007 applied, `vector` extension live, all 6 new tables present, site
healthy. The auto-deploy reused the alpine-initialized volume, so the
musl→glibc collation risk was closed by hand with `REINDEX DATABASE ytauto`
(datcollversion was NULL — musl never recorded one — so no refresh needed;
zero mismatch warnings). The full dump/restore playbook in DEPLOY.md was NOT
needed but stays documented; the pre-deploy dump is kept at
`/root/ytauto-pre-build5.sql` on the droplet as rollback — delete it once #5
has run on prod for a while.

**Next session:** (1) sanity-poke the wizard + Plan tab on prod
(https://app.commongroundsocial.com.au/channels/new); (2) create the REAL
aviation channel via the wizard, hand-provision the YouTube channel
(checklist is the wizard's last step), connect OAuth; (3) build #5.2
(review board, in-platform briefings, experimentation).

Gotcha for local dev: turbo v2 strict env strips `.env` vars from `pnpm dev` —
run cockpit (`apps/cockpit: next dev -p 3000`) and worker
(`apps/worker: tsx watch src/index.ts`) directly with the env exported, or
export the vars in your shell first. Local dev infra (pgvector Postgres/
Inngest/MinIO in Docker + both dev servers) may still be running from the e2e.

- **Last updated:** 2026-07-06 (Build #5 build session)
- **Branch:** `main` (Build #5 merged from `build5-editorial-engine`)
- **Repo:** `github.com/adawg85/YT-Auto-Platform-`
- **Health:** `pnpm typecheck` (13/13) and `pnpm test` (93: 48 core + 45
  providers) green; `node scripts/build5-test.mjs` passed.
- **Tree:** clean.
- **Prod:** `main`@`8a21c5c` (Build #5) live on the pgvector image, reindexed.
  Rollback dump: `/root/ytauto-pre-build5.sql` on the droplet.

## Verification results (2026-07-06, networked desktop + live droplet)

Both open runtime items from Builds #3/#4 were exercised for the first time on a
real machine (the cloud sandbox couldn't):

- **✅ `youtube` research backend (discovery) — WORKS live.** Drove the real
  provider against youtube.com for "aviation history": `outliers`,
  `trendingVideos`, `breakoutChannels`, `keywords` all return real, correctly
  parsed + ranked data. `RESEARCH_PROVIDER=youtube` is trustworthy for discovery.
- **🐞 external transcript deep-read — BLOCKED by YouTube (filed on BACKLOG #4).**
  `transcript()` returns null for every video: youtubei.js 17.2.0 (latest)
  `getTranscript()` → HTTP 400; direct `timedtext` → HTTP 200 w/ 0 bytes (YouTube
  now requires a proof-of-origin token). Degrades gracefully (no crash). Interim:
  topic-signal clustering still works; source hook/script patterns from our OWN
  videos (build #3.2) instead of competitors'. Fix later via a POT-token provider
  or vidIQ's `video_transcript`.
- **✅ warm-up scheduling — VERIFIED against real Postgres.** Ran the exact
  pipeline path (`production-pipeline.ts:517-530`: `channelWarmupState` DB read →
  `planWarmupRelease`) on the seeded channel. Case A (week 1, cap 3, 0 released) →
  next Shorts daypart (Thu 18:00Z), throttled not immediate. Case B (cap hit via
  real published rows) → deferred to the next ramp week's daypart. The only seam
  not exercised is the Inngest `step.run` wrapper around that logic (identical to
  every other verified step in the same function) — a full `pnpm dev` pipeline run
  through Remotion render remains optional belt-and-suspenders.

---

## What shipped this session

Build #4 — the meta-analysis engine — landed in two commits:

1. **`dc05d6b` — meta-analysis engine (mock-first).** External scouting into the
   shared pattern store: `external_videos` table (migration 0005), the
   `runMetaAnalysisForNiche` engine (ingest outliers/breakout/trending →
   deep-read transcripts into hook + script-structure patterns → cluster topic
   signals, all `source="external"` in the same `patterns` table our own videos
   write to). Daily `market-scan` Inngest cron + on-demand event. Grounding
   wired into ideation/scoring/scriptwriter (`patternGrounding`,
   freshness-decayed). Anti-clone variation check vs scouted transcripts.
   Cockpit **Market intel** nav page + per-channel "What's working" panel.
   Also fixed a #3.2 gap (analytics-ingest was dropping retention-curve columns).
   Verified end-to-end against a real Postgres.

2. **`8ecc325` — real research backends.** Two `ResearchProvider` implementations
   behind the same interface, selected by `RESEARCH_PROVIDER`:
   - **`youtube`** (MIT, free, keyless) — `youtubei.js`/InnerTube; outlier +
     velocity computed in-house; no keyword volume.
   - **`vidiq`** (premium, `VIDIQ_API_KEY`) — vidIQ's MCP server via
     `@modelcontextprotocol/sdk`; adds keyword volume + breakout scoring.
   - Default stays **mock** (offline/CI safe).

⚠️ **Not yet runtime-verified:** the live research transports were never
exercised — the cloud sandbox blocks `youtube.com` and vidIQ's endpoint. Mappers
are unit-tested (vidIQ against real captured responses) and both adapters
typecheck against the installed SDKs, but **first-deploy smoke-testing on a
networked machine is still required** (that's largely why this handoff exists —
your laptop/desktop can do it).

---

## Product direction captured today (design only — no code; see BACKLOG #5–#8)

Today was a design session — no code shipped; the vision for autonomous,
per-channel content engines is now fully specced in `BACKLOG.md`. Decisions:

- **First channel: Aviation history.** A vidIQ ghost-niche discovery pass picked
  it — low competition, *tiny* channels (2–6k subs) proven to break out to
  70–100k views, deep evergreen catalog (one aircraft per episode),
  monetisation-safe. 5 ranked candidates + data at the top of BACKLOG #5.
- **#5 Editorial engine (the next big build):** per-channel **charter** (mission/
  objectives/archetype/source strategy/verification bar) with AI-proposed channel
  identity; pluggable **source connectors**; **tiered accuracy** (established fact
  ≥2 independent sources, vs emerging = "reported/claimed"; contested history runs
  a **"present-the-debate"** mode — attribute, never assert); a **stateful
  series/plan** that researches the next arc ahead; a **multi-checker AI review
  board** (replaces per-video human review); **configurable weekly/monthly**
  operator check-ins; controlled one-variable experimentation.
- **Per-channel memory:** split **canonical/structured** (Postgres, exact
  queries) from **semantic** (pgvector RAG, `channelId`-scoped, mock-first
  `EmbeddingProvider`) — **pgvector, not a separate vector DB**. **Scope tiers:**
  a video's raw research dump stays **episode-local** (no cross-video bleed);
  only transcript + coverage summary + decisions + explicitly-general research
  carry over into channel memory.
- **#6 Format modes:** shorts-only | long-only | long→derived-shorts, per channel.
- **#7 Assets + storage:** licensed stock images/b-roll + (spicier) source
  footage. **Storage = DigitalOcean Spaces** (already wired via `s3.ts`; we're on
  DO). **Keep every final video permanently** — YouTube can block/remove/
  unpublish, so it is NOT the durable copy; prune only intermediates + the
  re-fetchable source cache.
- **#8 Reactive/topical channels** (tweet/sports/news → fast shorts): **PARKED**
  with ToS/legal notes; revisit after the evergreen engine is proven.
- **Channel provisioning:** the platform **cannot auto-create** YouTube channels
  (no API; title/@handle/avatar are manual). Operator creates + brands by hand,
  connects via per-channel OAuth — a natural creation-time checkpoint.

---

## Get running on a fresh machine

```bash
# prereqs: Node >= 22, pnpm 10, Docker (for local Postgres/Inngest)
git clone <repo> && cd YT-Auto-Platform-
git checkout claude/session-recap-p3q2qt
pnpm install
cp .env.example .env          # then edit (see below)

pnpm typecheck                # 13/13 expected
pnpm test                     # 77 expected

# full local stack (Postgres + Inngest + worker + cockpit):
docker compose up -d          # see docker-compose.yml / DEPLOY.md
pnpm db:migrate               # applies migrations incl. 0005 (external_videos)
pnpm db:seed                  # optional demo data
pnpm dev                      # turbo: cockpit :3000, worker :3010
```

`.env` essentials: `DATABASE_URL`, `SECRETS_ENCRYPTION_KEY`
(`openssl rand -hex 32`), and — new this session — `RESEARCH_PROVIDER`
(see `.env.example` for the full research block).

---

## Verify the new research backends (the main to-do on your laptop)

Both need real network access YouTube/vidIQ, which the cloud env lacked.

**YouTube (MIT) — free, do this first:**
```bash
# in .env:  RESEARCH_PROVIDER=youtube
# bring the stack up, then trigger a scan from the cockpit:
#   Market intel page → "Run market scan"   (or the button on /market)
# expect: Rising angles + Breakout hook patterns + Scouted videos populate.
# E2E script (full stack up): node scripts/build4-test.mjs
```
If `youtubei.js` shapes have drifted, the defensive extractor in
`packages/providers/src/real/youtube-research.ts` degrades to empty rather than
crashing — check `normalizeVideoNode` / the search-filter call first.

**vidIQ (premium) — only if you want keyword volume / turnkey scoring:**
```bash
# in .env:  RESEARCH_PROVIDER=vidiq  VIDIQ_API_KEY=...  (VIDIQ_MCP_URL if it differs)
```
Transport is `packages/providers/src/real/vidiq-mcp.ts`; mapping is
`packages/providers/src/real/research.ts`. Confirm the MCP endpoint/auth against
vidIQ's docs — the default URL is a best guess.

---

## Next steps (pick up here)

**Verification (done 2026-07-06 — see "Verification results" up top):**
1. ~~Smoke-test the research backends~~ — **`youtube` discovery DONE** (works);
   external transcripts blocked (BACKLOG #4). `vidiq` still untested (needs key).
2. ~~Verify warm-up auto-scheduling~~ — **DONE** against real Postgres (both
   in-ramp + cap-defer branches). Optional: a full `pnpm dev` Inngest pipeline run
   through render for the last untested seam (the `step.run` wrapper).

**Next major build — the editorial engine (BACKLOG #5), aviation starter:**
3. Stand up the **channel charter** (incl. AI-proposed name/@handle/avatar for
   aviation) → **source connectors** → **tiered-accuracy verification** →
   **stateful series planner** → **per-channel memory (pgvector + scope tiers)**
   → **multi-checker review board** → **configurable check-ins**. All specced in
   BACKLOG #5. This is the heart; the scheduler (#3) + analytics/pattern store
   (#4) already plug into it.

**Smaller / later:**
4. `youtube` breakout channels lack subscriber-growth — accrue from our own
   snapshots over time.
5. Build #6 (format modes / long→shorts), #7 (assets + Spaces storage/retention),
   #8 (reactive channels, parked). Builds #1/#2 (UGC, owned-product) still stubs.

See `BACKLOG.md` for full build specs and per-build status — items #1–#8.

---

## Map of key files (Build #4)

| Area | Path |
|---|---|
| Pattern store schema | `packages/db/src/schema.ts` (`patterns`, `external_videos`) |
| Engine | `packages/agents/src/meta-analysis.ts` |
| Pattern read/ranking | `packages/core/src/patterns.ts` |
| Shared upsert | `packages/agents/src/pattern-store.ts` |
| Research interface | `packages/providers/src/types.ts` |
| Real backends | `packages/providers/src/real/{research,vidiq-mcp,youtube-research}.ts` |
| Backend selection | `packages/providers/src/factory.ts` (`selectResearchProvider`) |
| Cron | `apps/worker/src/functions/market-scan.ts` |
| Cockpit surface | `apps/cockpit/src/app/market/`, `apps/cockpit/src/lib/market.ts` |
| E2E | `scripts/build4-test.mjs` |
