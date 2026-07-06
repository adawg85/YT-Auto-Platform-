# Session status / handoff

Working notes for picking the project back up on another machine. Living doc —
update the top block each session.

## ▶ PICK UP HERE (handoff 2026-07-06, switching models/new chat)

Everything through Build #4 is shipped, verified, and **now live in production**.
The next task is **Build #5 — the editorial engine** (full spec in `BACKLOG.md`
#5). The user paused deliberately *before* starting #5, so **begin the new chat by
scoping #5 with the user** (charter model first) — do not start coding blind.

Done this session: (1) fixed the prod outage (Caddy `COCKPIT_DOMAIN` was the raw
IP — now the bare domain, Let's Encrypt cert issued); (2) SSH to the droplet now
works from the user's desktop (`ssh -i ~/.ssh/id_rsa root@170.64.224.67`);
(3) verified Build #4 `youtube` discovery (works) + warm-up scheduling (works) —
external transcripts are blocked (BACKLOG #4); (4) **deployed Build #4 to the
droplet** — prod is on `main`@`c596576`, migration 0005 applied, `/market` live
(HTTP 200). Site: https://app.commongroundsocial.com.au (Basic Auth `ahan85`).
Local dev infra (Postgres/Inngest/MinIO) may still be up in Docker from verifying.

- **Last updated:** 2026-07-06 (verification session on networked desktop)
- **Branch:** `main` @ `f155f8f` (Build #4 merged)
- **Repo:** `github.com/adawg85/YT-Auto-Platform-`
- **Health:** `pnpm typecheck` (13/13) and `pnpm test` (77) green as of the
  Build #3 warm-up scheduler commit.
- **Tree:** clean.

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
