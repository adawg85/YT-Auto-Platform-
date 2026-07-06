# Session status / handoff

Working notes for picking the project back up on another machine. Living doc —
update the top block each session.

- **Last updated:** 2026-07-06
- **Branch:** `claude/session-recap-p3q2qt` (pushed to `origin`)
- **Repo:** `github.com/adawg85/YT-Auto-Platform-`
- **Health:** `pnpm typecheck` (13/13) and `pnpm test` (77) green as of the
  Build #3 warm-up scheduler commit.
- **Tree:** clean, everything committed + pushed.

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
your laptop can do it).

---

## Get running on a fresh machine

```bash
# prereqs: Node >= 22, pnpm 10, Docker (for local Postgres/Inngest)
git clone <repo> && cd YT-Auto-Platform-
git checkout claude/session-recap-p3q2qt
pnpm install
cp .env.example .env          # then edit (see below)

pnpm typecheck                # 13/13 expected
pnpm test                     # 67 expected

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

1. **Smoke-test the research backends on the laptop** (above) — the one true
   open item from Build #4 (parked; needs network).
2. **Verify the warm-up auto-scheduling on first deploy** — Build #3's policy +
   Schedule-tab UI are done and verified (unit tests + live cockpit render), but
   the production pipeline's auto-tier warm-up path (`warmup-schedule` step) is
   typechecked, not yet run through Inngest end-to-end. Publish on a T2/T3
   channel and confirm the release lands on the next Shorts evening daypart.
3. `youtube` breakout channels have no subscriber-growth (not in search
   results) — accrue it from our own snapshots over time.
4. **Build #3 remainder** — long-form ramp ships with the long-form capability
   (encoded, Shorts-only today). Core redesign + warm-up scheduler are done.
5. Builds #1 (UGC/affiliate) and #2 (owned-product marketing) still stubs.

See `BACKLOG.md` for full build specs and per-build status.

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
