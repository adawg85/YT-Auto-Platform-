# Backlog

Future builds, in spec-brief style. Each reuses the existing spine
(Channel → Idea → Score → Production → Assets → Publication → Analytics),
the provider-interface pattern (real + mock adapters), the review-gate
compliance model, and per-video cost accounting. New capability lands as new
providers + ChannelDNA extensions, not as parallel pipelines.

---

## SHIPPED 2026-07-21 (session 4) — ticket sync + orphaned-gate fix + alert thresholds

- **GitHub ticket sync**: `report_issue` mirrors to a GitHub issue + names exactly
  what to configure; two-way close via signed webhook (`0053` github_number col).
  **Owed:** operator sets `GITHUB_ISSUE_TOKEN` on /account; `resolve_issue` both
  tickets from an MCP session once verified live.
- **Orphaned gates**: trigger + sweep (`0054`) + read-filter so no gate outlives
  its production; regression test per gate kind.
- **Alert thresholds**: underperformance gated behind ≥10 videos + median ≥50 +
  age ≥24h; stale criticals self-heal on next ingest.
- **Follow-ups:** revisit alert thresholds as the channels mature; consider a
  DB-integration harness (still no Postgres in CI) to test the trigger + the
  cancel/self-heal write paths live.

---

## SHIPPED 2026-07-21 (session 4b) — ticket backlog cleared (autonomous run)

Worked the full open mcp-ticket backlog. All closed on GitHub (auto-closes the
platform tickets). Shipped:
- **#16 tags** — real SEO keyword builder (phrases + niche + 500-char cap).
- **#20 notes cap** — notes/artDirection raised to 6000 (+ fixed a resolve trim
  that clamped to 800 regardless).
- **#17 analytics (Phase 1)** — retention curve + watch/engagement/traffic
  reports (fail-soft), get_channel_analytics, dataState/coverage. `0056`.
- **#18 reconciliation** — classifyPublication + reconcile_publications tool +
  findSuspiciousPublications in get_diagnostics.
- **#22/#23 beat-map reviewer + loop controls** — runReviewLoop (reusable) +
  deterministic beat-map checks + review_beat_map tool. `0057`. OPT-IN.
- **#19 prompt dashboard** — read-only AGENT_PROMPTS registry + get_agent_prompts
  + /prompts page.
- **#24 image dedup** — repeated-referenceEntity advisory in the beat-map reviewer
  (the cheapest layer, per the ticket).

**Deferred remainders (need operator present / live verify):**
- #17 Phase 2: get_portfolio_analytics + cost-per-1k-views join; scheduled tiered
  refresh with per-metric fetchedAt. Impressions/CTR = Reporting API (Studio-only
  in Analytics API).
- #22/#23: the cross-model LLM advisory layer + the flag-gated pipeline pre-author
  gate that HARD-blocks (left off so it can't halt live productions unsupervised).
- #19: full prompt-text viewing + version history + editing (needs prompts
  centralised out of each agent's inline system: string).
- #24: perceptual-hash near-dup detection + cross-production dedup + exhaustion
  diagnostics in the sourcing hot path (risky; needs live verify).

---

## SHIPPED 2026-07-21 (session 3) — stock rate governor + per-channel music bed

- **Global stock rate governor + 24h cache** (`0051`): per-provider token bucket in
  Postgres shared across all channels; empty bucket skips the source. Keeps free
  stock APIs (Unsplash 50/hr app-wide etc.) under their limits. Env caps.
- **Per-channel music bed** (`0052`, `channel_music`): 6-8 reusable tracks the
  render alternates (LRU). Free CC audio via **Openverse** (`MusicLibraryProvider`).
  Music panel: bed + Openverse search + global escape hatch.
- **Follow-ups owed:** live E2E of the token-bucket UPDATE + bed rotation; consider
  a channel-Style-tab bed manager (today the bed is built from the production Music
  panel); optionally auto-seed a new channel's bed from Openverse on first video.

---

## 37. Visual Director agent — full spec at `docs/DIRECTOR-SPEC.md` (operator, 2026-07-16)

**Status: ✅ Phase 1 + 2 SHIPPED (2026-07-16), verified live against prod DB.**
A director agent reads the whole script, cuts it into shots **on meaning** (not
sentence boundaries), is **medium-aware** (stills/all-video/mixed, AI vs real
footage), and writes a coherent visual sequence → time-cut → per-shot
articulation to the image model. Opt-in per channel (`visualDirector`), with the
mechanical `planShots` cut as fallback. Director owns cadence (Rhythm/density
become a target). Shipped alongside: **per-role engine routing** (image:
bulk/hero/character/thumbnail; video: filler/character/hero) and **smart-%
character casting**. A profile-gate merge bug that dropped the advanced fields
(director + per-role engines) from the per-production snapshot was fixed.
- **Follow-ups / owed real-run checks:** confirm the director gets style input on
  a fresh run (it does — earlier off-brand images traced to the image-prompt
  builder rate-limiting under 2 concurrent productions, not the director);
  #21.5-style learning loop from render results is still open.
- **BytePlus engines (updated 2026-07-17):** Seedream image + Seedance video are
  DIRECT on ModelArk with **two separate keys** (`SEEDREAM_API_KEY`,
  `SEEDANCE_API_KEY`, each falling back to `ARK_API_KEY`). Adapter shapes verified
  against the live API. **STILL OWED (operator, account-side):** on prod
  `SEEDANCE_API_KEY`/`SEEDREAM_API_KEY` are unset — Seedance is running on the
  shared `ARK_API_KEY` whose account has NOT activated the Seedance **video**
  model, so Animate→Seedance produces no clip. Set a dedicated `SEEDANCE_API_KEY`
  (model activated + Safe Experience Mode raised), confirm on `/api/diag/clips`.
  **Wan (DashScope) is the working video engine meanwhile.**
- **Gemini nano-banana-pro CONFIRMED LIVE (2026-07-17):** `/api/diag/media`
  `heroTest ok:true` on `gemini-3-pro-image` — the prepaid-credits 429 is
  resolved; hero/character/thumbnail images render on the real hero model. The
  earlier off-model + "yellow hair" issues were amplified by that fallback and by
  a style-block "yellow headlines" leak (fixed `60dc10d`).
- **Prompt quality:** `buildImagePrompts` now split-retries per shot and the
  manual per-shot "Regenerate prompt" runs on the frontier tier; a "Fill thin
  prompts" button batch-fixes any shot left on a thin brief.
- **Read `docs/DIRECTOR-SPEC.md` before extending.**

---

## 38. Corrected-copy re-cut flow + manual visuals-gate editing + operator visibility (operator, 2026-07-19/20)

**Status: ✅ SHIPPED (2026-07-19/20), prod head `803f7f8`. Migrations `0041`–`0045`.**
Everything an operator needs to re-cut and republish an already-published video
without re-running (or re-paying for) the whole pipeline, plus the tools to fix a
storyboard by hand. Grew out of the published **Krypton** short that shipped a
wrong shot with no way back in.

### Shipped
- **"Make a corrected copy" of a published/scheduled video** (`Fix a few things`
  vs `Rebuild the visuals`) → new production that publishes as a fresh upload,
  carrying script + all media. Marked by `supersedesProductionId` →
  `ctx.isCorrectedCopy`, which **skips every re-planning/spend stage**: script
  gate, script drafting, per-video profile proposal + `profile_review` gate,
  Visual Director, `align-visuals-to-shots` (no realign/drop of copied media),
  variation check, review board. Never copies the stale `render`. Verifies the
  supersedes link persisted before firing (fails loud otherwise). A clean copy
  runs at **A$0.00 / no Sonnet** and lands at the visuals gate. See HANDOFF for
  the full skip-checklist.
- **Deploy-version badge** (`service_versions`, worker stamps on boot, cockpit
  `BuildBadge`) — makes Render deploy-limbo (worker on old code) visible.
- **Manual visuals-gate editing:** move an image (+its clip) to another shot
  (`reassignShotImageAction`); "use the still instead" drop-a-clip
  (`removeShotClipAction`); duplicate-shot flag (repeated narration OR image
  file) on the card.
- **Delete / Retire videos** + a ⋯ row menu on the Videos tab (delete removes the
  live YouTube upload, 404-idempotent).
- **Global music library** (deduped dropdown, AI-named tracks), **prompt caching**
  middleware, **costs in AUD at each day's ECB spot rate** (`fx_rates`), **direct
  per-segment script editing** at the gate, **per-video audio levels**.

### Owed / follow-ups
- **Systematic fix for image↔shot drift (the Krypton 47-stills/45-shots quirk):**
  the render is shot-plan-driven (`shots.map((_,i)=>image[i])`), and the plan is
  re-derived each run from `directedSequence`+voiceover. When an old video's image
  count ≠ its derived shot count, images drift/drop and tail narration repeats.
  **Persist a production's shot plan when first computed and reuse it verbatim on a
  corrected copy** (reuse-mode) so images can never drift or drop. Bigger change
  (new column + persist at render + reuse in pipeline/`deriveShotPlan`/copy).
- **Trim the temporary "Pipeline diagnostics" + FLOW block** on the production page
  once the copy flow has several clean real runs.
- Optional: split the duplicate flag into two distinct chips ("same narration" vs
  "same image file") if the combined flag is ambiguous in practice.
- Optional: a "nudge ◀/▶" or range-shift on the move control if a multi-shot
  off-by-one cascade proves fiddly with single swaps.

---

## 1. UGC product flow (affiliate / dropship content engine)

**Goal:** run channels whose videos are UGC-style product content — find
products with rising demand, source them, and produce shorts that sell them.

### New capabilities

- **Trending-product discovery.** `TrendingProductProvider` interface:
  rising products from TikTok Shop / Amazon movers-and-shakers /
  AliExpress order velocity (wrap an existing data provider; don't scrape
  from scratch). Feeds the Idea table with `sourceType: 'product'` and a
  product payload (name, category, price band, trend velocity, images).
- **Sourcing / manufacturer lookup.** `SupplierDirectoryProvider` interface:
  given a product, find Chinese manufacturers/suppliers (Alibaba / 1688
  style: MOQ, unit price, lead time, supplier rating). Output attached to
  the idea as sourcing context; operator contacts suppliers outside the
  platform in v1 (no automated outreach).
- **Product economics in scoring.** Extend the scoring rubric with margin
  axes: unit economics (price − COGS − fulfilment), commission rate if
  affiliate, expected RPM/GMV per 1k views. Weights per channel as today.
- **UGC production preset.** New ChannelDNA archetype `ugc_product`:
  hook library tuned to product content (problem → demo → outcome),
  visual style favouring product b-roll (MediaProvider prompt templates
  take product images as reference where the model supports it), CTA =
  affiliate link / "link in bio".
- **Link + disclosure handling.** Publication descriptions get the
  affiliate/product link block; **FTC affiliate disclosure is mandatory
  and enforced in code** exactly like the AI-disclosure flag (a
  publication with `sourceType: 'product'` cannot publish without it).

### Notes

- Product ideas expire fast — reuse the trend-fast-lane design (lighter
  gate: hook approval + one-click release).
- Mock adapters ship first: deterministic trending-product fixtures and a
  fake supplier directory, so the whole flow runs with zero keys.
- Compliance: review-gate evidence log extends to product claims (no
  medical/financial claims; forbidden-topics list per channel applies).

---

## 2. Owned-product marketing channels

**Goal:** the same automation, pointed at products/services the operator
builds — every video is top-of-funnel for an owned property, with tracked
links and conversion feedback instead of RPM.

### New capabilities

- **Product catalog.** New entity `Product` (owned): name, positioning,
  website URL, landing pages, key features/benefits, proof points,
  screenshots/asset library, brand voice overrides. A channel (or a
  campaign within a channel) binds to one or more products.
- **Marketing ChannelDNA archetype.** Ideation draws from the product's
  positioning + audience pains (not niche research feeds alone); hook
  library tuned to problem/solution, demo, founder-story, objection
  formats; scripts must reference real product capabilities (writer agent
  gets the catalog as grounding — no invented features, enforced at the
  script gate checklist).
- **Tracked links everywhere.** CTA + description links are generated with
  UTM parameters per video (`utm_source=youtube&utm_campaign=<production>`),
  plus optional per-video short links. Link blocks templated in
  ChannelDNA; pinned-comment link support when the comments API is wired.
- **Conversion feedback loop.** `ConversionProvider` interface (GA4 /
  Plausible / PostHog style): sessions and conversions per UTM →
  joined to AnalyticsSnapshot so the scorer optimises for
  *conversions per 1k views*, not RPM. Alerting rail gains
  "high views, zero clicks" and "landing page 404" checks.
- **Asset reuse.** MediaProvider accepts the product's real screenshots /
  brand assets as inputs for beat visuals where licensing allows,
  falling back to generated imagery.

### Notes

- This is mostly configuration + two new providers on the existing spine;
  the production pipeline is unchanged except link injection at the
  metadata step and grounding context at the script step.
- Compliance shift: synthetic-media disclosure still applies; add a
  "claims must match the catalog" check to the variation-check stage.

---

## 3. Cockpit redesign — portfolio + per-channel dashboards, left nav, sections

**Goal:** the v1 cockpit is a flat set of top-nav pages (Gates, Ideas,
Channels, Costs, Alerts, Account, Assistant) — a functional first pass. The
target is a proper operator control centre: a consolidated portfolio view,
drill-down per-channel dashboards, a left-hand nav, and top-level sections
for the different business lines (automated YouTube channels, Marketing,
UGC).

**Status:** ✅ largely shipped. The IA port is done — left sidebar nav, the
portfolio dashboard with page tabs (Overview · Analytics · Costs · Review),
per-channel dashboards with the chip row + tabs (Analytics · In production ·
Videos · Schedule · Costs · Settings & DNA), the channel switcher, and the
video drill-down (build #3.2) all landed. The **per-format warm-up scheduler**
is now built too: a pure policy in `packages/core/src/warmup.ts` (ramp weeks,
per-format weekly caps, daypart slotting, `planWarmupRelease`) + the
`channelWarmupState` read helper; the Schedule tab renders the live ramp
(current week, this-week progress vs cap, upcoming releases); and the production
pipeline throttles auto-tier (T2/T3) releases onto the ramp + Shorts daypart
instead of publishing immediately. Design direction was locked via a clickable
HTML prototype (light-first, blue accent `#2867e5`, both themes).

Remaining: long-form ramp ships live with the long-form capability (encoded,
Shorts-only today); the pipeline warm-up path is unit-tested + typechecked but
not yet run end-to-end through Inngest (verify on first deploy). The IA/section
detail below is retained as the reference spec.

### Information architecture (tabs *inside* the page, not in the nav)

The global left nav stays deliberately thin. The dense navigation lives in
**page-level tab strips that run across the top of the content area** (not the
sidebar, not a global top nav). This is the key structural decision: you don't
navigate to a global "Costs" page — costs are a tab on the portfolio dashboard
(aggregate) and a tab inside each channel (that channel only).

- **Left-hand sidebar nav** (replace the current top nav). Sections:
  - **Overview** — portfolio dashboard (default landing page)
  - **Channels** — list → click into a per-channel dashboard
  - **Review** — the gate queue + alerts, unified (the daily-work surface)
  - **Marketing** — placeholder section (→ build #2, owned-product channels)
  - **UGC** — placeholder section (→ build #1, product/affiliate content)
  - **Assistant**, **Account & keys** — utility, pinned to the bottom
  - Note: **no global Costs nav item** — costs live as tabs (aggregate on the
    portfolio dashboard, per-channel inside each channel).

- **Portfolio dashboard (Overview / landing) — page tabs across the top:**
  **Overview · Analytics · Costs · Review.** One consolidated view across all
  automated YouTube channels: aggregate KPIs (views 30d, avg retention,
  published 7d, spend vs. est. revenue, needs-review count), a views+spend
  trend chart, a roll-up of the gate queue / alerts ("needs your attention"),
  and per-channel summary cards (status, tier, sparkline, cost/wk). The
  aggregate Costs and Analytics tabs answer "how is the whole portfolio doing /
  what am I spending across everything" without leaving this screen.

- **Channel switcher.** Channels open from the list, but every channel page
  carries a **"Switch channel" dropdown/pop-up** in its header so you can jump
  between channels without going back to the list.

- **Per-channel dashboard — key-metric chip row at top, then page tabs:**
  **Analytics · In production · Videos · Schedule · Costs · Settings & DNA.**
  Header shows channel identity + a chip row (YouTube-connected, tier, views
  30d, retention, published/wk, $/video).
  - *Analytics* — Shorts-native metrics (swipe-away %, avg % viewed, returning-
    viewer %, subs), a **retention curve** (0–3s hook zone highlighted, ~55%
    floor line), views/subs trend, and an **AI "What's working"** panel that
    calls out which hook styles are over/under-performing on this channel.
  - *In production* — what's in flight and at which pipeline stage.
  - *Videos* — the published catalogue; each row drills into a video page.
  - *Schedule* — warm-up ramp (see below) + upcoming scheduled uploads.
  - *Costs* — this channel's unit economics only.
  - *Settings & DNA* — the ChannelDNA editor.

- **Video drill-down.** From the channel's Videos/Analytics, click into a
  single video: per-video performance (views, swipe-away, % viewed, subs
  gained), an audience-retention curve, and two AI-analysis panels the
  operator can read —
  - **Hook analysis:** the actual hook line, how it held through the 3s cliff
    vs. the channel average, and tags (strong 3s hold / open loop / contrarian
    claim / …).
  - **Script analysis:** beat-by-beat structure (hook → stat → insight → cta)
    with timing, what's working, and a concrete trim/tighten suggestion tied to
    the dip in the retention curve.

### Channel warm-up scheduling (new feature — needs the scheduler)

New YouTube channels get throttled if they post like an established one, so a
new channel ramps posting cadence over ~6 weeks instead of going straight to
full volume. This needs an **automated scheduling** capability (the Schedule
tab + a scheduler behind it).

**Format-aware — Shorts and long-form warm up differently and must run as
separate schedules** (posting both at once, or on the same clock, hurts both):

| | Shorts | Long-form |
|---|---|---|
| Warm-up cadence | ~3/wk → 5/wk → **5–7/wk** (up to 1/day) | ~1/wk → **2–3/wk** (often 1 per 2–4 wks at full quality) |
| Best window | evenings ~6–9pm; Fri/Sat/Thu | mornings ~8–11am; Sun/Tue/Mon |
| Role in ramp | discovery — Shorts feed pushes zero-sub channels to non-subs | depth, loyalty, revenue, conversion |
| Caveat | Shorts-acquired subs watch long-form poorly — don't over-index early | slower to compound |

- **Warm-up ramp is per-format.** The v1 platform is Shorts-only, so the
  Shorts ramp ships first (Week 1 ≈ 3/wk → Weeks 5–6 = full 5–7/wk); the
  long-form ramp is a distinct policy (slower, morning window) that lands with
  the long-form capability. Note (per the #6 design decision): both formats
  never run on ONE channel — a long-form channel and its linked shorts
  companion each run their own single-format ramp.
- **Front-load the backlog** so the ramp always has ready videos to draw from.
- **Never delete + re-upload** a video to "retry" it — that's a spam signal;
  enforce/warn in the scheduler.
- Trust signals worth surfacing/checking: phone-verified account, consistent
  cadence (12-month consistency beats burst-and-rest), no sudden volume spikes.
- Requires the Phase-3 scheduled-publishing rail (already present) plus a
  per-channel, **per-format** warm-up policy that caps how many uploads the
  scheduler releases per week per format during the ramp, and picks the right
  daypart per format.

---

## 4. Meta-analysis engine — competitive intelligence + pattern learning

**Status:** shipped (mock-first). The engine ingests external content
(`ResearchProvider.outliers` + `breakoutChannels` + `trendingVideos`) into the
`external_videos` store, deep-reads the highest-signal transcripts into
`hook` + `script_structure` patterns (`source="external"`) and clusters the
batch into `topic_signal` patterns — all folded into the SAME shared `patterns`
table build #3.2 writes our own results to. A daily `market-scan` Inngest cron
(+ on-demand `market/scan.requested`) runs it per active-channel niche.
Grounding is wired through ideation, scoring and the scriptwriter
(`patternGrounding` / `topPatternsForNiche`, freshness-decayed). The variation
check gained an anti-clone pass against scouted transcripts
(`checkExternalSimilarity`). Cockpit: a **Market intel** nav section
(rising angles + breakout hook patterns + top structures + scouted videos, with
"borrow this pattern → seed an idea") and the per-channel Analytics
"What's working" panel now render the store's slice. Runs fully mocked by default; two real
`ResearchProvider` backends now sit behind the same interface, selected by
`RESEARCH_PROVIDER`:
- **`youtube`** (MIT, free, keyless) — youtubei.js/InnerTube for search, trending
  and transcripts; outlier-vs-median and views/hour velocity are computed
  in-house. No keyword search volume (YouTube doesn't expose it). Recommended.
- **`vidiq`** (premium; `VIDIQ_API_KEY`) — speaks vidIQ's MCP server; adds
  keyword search volume + ready-made breakout/outlier scoring.
Both keep the mock as the zero-config default. E2E: `scripts/build4-test.mjs`.

**✅ `youtube` backend smoke-tested on a networked machine (2026-07-06)** — the
discovery layer works against live YouTube: `outliers`, `trendingVideos`,
`breakoutChannels`, and `keywords` all return real, correctly-parsed data (drove
the "aviation history" niche end-to-end). The mappers and in-house
outlier/velocity math check out against real responses. `vidiq` is still
unverified (needs the paid key).

**🐞 KNOWN GAP — external transcript deep-read is blocked by YouTube (backlog):**
`ResearchProvider.transcript` returns null for every video on the `youtube`
backend. Root cause (verified): YouTube now gates caption retrieval behind a
proof-of-origin token — youtubei.js 17.2.0 (the latest) `getTranscript()` returns
HTTP 400, and the direct `timedtext` base_url returns HTTP 200 with 0 bytes, even
for videos that clearly have caption tracks. The code degrades gracefully (null,
no crash), so nothing breaks; the meta-analysis engine's **topic-signal
clustering still works** (titles/metadata), but **hook-pattern and
script-structure extraction from *external* videos produces nothing**.
- **Interim decision:** ship `youtube` for discovery + topic signals; source
  hook/script patterns from our **own** published videos (build #3.2, captions we
  control) instead of competitors'.
- **To investigate later:** restore external transcripts via a POT-token provider
  (bgutils/potoken bolted onto youtubei.js), or test whether vidIQ's
  `video_transcript` tool bypasses the block (needs `VIDIQ_API_KEY`).

Other follow-ups (not blocking): `youtube` breakout channels lack
subscriber-growth (not in search results) — accrue it from our own snapshots
over time; a dedicated own-vs-market comparison view is not built yet.

**Goal:** the per-video AI hook/script analysis (build #3) analyses *our own*
videos after they publish. That's necessary but inward-looking. We also need an
outward-facing **meta-analysis engine** that continuously pulls down and
analyses *external* content — what niches are heating up, which hooks are
breaking out, which script structures over-perform — and feeds those learnings
back into ideation, scoring, and scriptwriting. Own-video analysis tells us what
worked *for us*; the meta engine tells us what's working *in the market* before
we commit spend.

This is not a parallel pipeline — it's an intelligence layer that produces a
shared **pattern store** which both the external scout and our own post-publish
analysis write into, and which the existing agents read from.

### Data source (already connected)

The VidIQ MCP tools are effectively the ingestion API for this — no scraping:
`outliers` (over-performing videos vs a channel baseline), `breakout_channels`
(fast-rising channels in a niche), `trending_videos` / `trend_categories`,
`keyword_research` (niche demand vs competition), `similar_channels` /
`list_competitors`, `video_transcript` (pull a top performer's actual script),
`score_title` / `score_thumbnail`. Wrap these behind the existing
`ResearchProvider` interface (extended) + a mock adapter so the flow runs with
zero keys.

### Pipeline (its own Inngest cron function per niche/channel)

1. **Ingest.** On a schedule, per channel niche: pull outliers + breakout +
   trending. Store as `external_videos` (competitor content) with a stats
   snapshot (views, views/hr, outlier multiple, engagement, format:
   shorts|long, niche, capturedAt).
2. **Analyse** (the "meta-analysis" agents — same analysis agent family as the
   own-video hook/script analysis, pointed at external transcripts):
   - **Hook extraction** — isolate the opening line / first 3s, classify the
     pattern (curiosity-gap, contrarian-claim, stat-led, open-loop, …), tag
     niche + format + the performance it drove.
   - **Script-structure extraction** — segment beat structure + timing from the
     transcript (hook → context → payoff → loop), tag which structures
     over-performed.
   - **Topic/niche clustering** — roll outliers up into "what angles are heating
     up in this niche right now."
3. **Write to the pattern store** (the unified knowledge base):
   - `hook_patterns`, `script_structures`, `topic_signals` — each with `niche`,
     `format`, `source` (own | external), `sampleRefs`, a rolling
     `performanceScore`, and `lastSeen` (freshness decays).
   - Crucially, **build #3's own-video analysis writes into the same store**, so
     external scouting and our own results merge into one "what's working" view
     and the score self-corrects as our videos publish. This is the "plug in
     when new scripts are performed" wiring.

### Wiring through (how it changes what the existing agents do)

- **Ideation agent** ← `topic_signals` + breakout niches → biases idea
  generation toward rising angles (extends the Phase-5 trend fast lane).
- **Scoring rubric** ← pattern priors → an idea/hook matching a hot, fresh
  pattern scores higher on the trend/demand axis (evidence-linked).
- **Scriptwriter grounding** ← the top `hook_patterns` + `script_structures`
  for that niche+format become few-shot grounding: "here are hook shapes and
  beat structures proven to work in this niche right now" — patterns, not
  verbatim content.
- **Hook library (Phase 5)** ← merges external hook patterns, tagged by source
  + freshness, so the library is market-aware not just self-referential.
- **Feedback loop** ← Phase-4 analytics + build-#3 per-video analysis update the
  same `performanceScore`, closing the loop between "what we predicted would
  work" and "what actually did."

### Cockpit surface

A **Market Intel / "What's working"** area (portfolio-level tab or its own nav
section): trending niches, breakout hook patterns with example videos, top
external scripts by structure, and a **"borrow this pattern → seed an idea"**
action. The per-channel Analytics "What's working" panel (already prototyped)
renders this store's channel-scoped slice.

### Compliance (non-negotiable, reuses existing guards)

- This is **pattern learning, not copying.** Patterns inform hook shape and beat
  structure; they never carry verbatim text into our scripts.
- **Extend the variation check** (Jaccard over shingles, already in
  `packages/core/src/similarity.ts`) to also compare generated scripts against
  ingested `external_videos`, so we can't accidentally clone a competitor — same
  hard-fail → `on_hold` + evidence-row mechanism as the intra-channel check.
- Format tags matter: a Shorts hook pattern is not evidence for a long-form
  script and vice-versa; keep patterns segregated by `format`.

### Notes

- Reuses the spine: new capability = one extended provider + one cron pipeline +
  a pattern store + agent grounding, not a new app.
- Mock-first: deterministic outlier/transcript fixtures so the whole
  meta-analysis loop runs with zero keys, same as every other provider.

### Notes

- Data is already there — analytics snapshots, cost records, gate queue,
  performance rollups all exist; this is primarily a UI/IA rebuild over the
  existing server actions and queries. New backend work is limited to the
  warm-up scheduling policy and the per-video AI hook/script analysis (an
  analysis agent over the transcript + retention snapshot).
- Marketing and UGC start as visible-but-empty placeholder sections so the
  nav reflects the full vision; they fill in as builds #1 and #2 land.
- Prototype: `scratchpad/cockpit-redesign.html` (react-before-porting; the
  operator reviews on mobile, so the design is validated as a clickable
  artifact before touching the real app).

---

## 5. Editorial engine — per-channel charter + research → verify → plan → queue

**Status: ✅ core loop shipped (build #5, 2026-07-06).** What landed:

- **Charter** (`channel_charters`, 1:1 with channels — a channel WITHOUT a
  charter is a legacy/manual channel and the engine + factuality gate skip it):
  mission, objectives, archetype (`evergreen_series` acted on; others are
  seams), format policy (#6 seam), source strategy, verification bar,
  check-in cadence (stored for #5.2). Created via a **4-step setup wizard** at
  `/channels/new` (niche+intent → AI charter draft → 3 AI identity proposals
  (name/@handle/text avatar concept) → editable review → create + the manual
  YouTube-provisioning checklist). The classic flat form moved to
  `/channels/new/manual`.
- **Source connectors** (`SourceConnector` provider category, mock + real):
  `rss` (fast-xml-parser), `web` (robots.txt-aware single-page fetch),
  `youtube` (delegates to the build-#4 ResearchProvider). Real is explicit
  opt-in via `SOURCE_CONNECTORS=real` (rss/web are keyless). Per-channel
  `channel_sources` rows carry config + **error tracking** (lastError/errorCount).
- **Tiered verification**: `claims` + `citations` tables; established facts need
  ≥N **independent (distinct-domain)** corroborations (per-channel
  `verificationBar`, default 2) or they're **cut**; emerging/contested get ≥1
  citation and are **attributed** ("reported/claimed"), never asserted
  (`decideClaimStatus` in `packages/core/src/editorial.ts`).
- **Stateful planner**: `series` + `episodes` tables (episodes double as the
  coverage ledger — dedup is exact SQL, never similarity). `editorial-plan`
  Inngest cron (05:00, before market/trend scans) plans arcs (auto-active on
  T2+, `proposed` → operator approval on the Plan tab for T0/T1), does
  **research-ahead** when an arc runs down, and fans out
  `editorial/episode.research.requested`.
- **Episode research chain** (`episode-research`): discover sources → fetch
  (errors tracked, never fatal) → chunk+embed into **episode-scoped** memory →
  extract claims → verify per distinct domain → **brief** (`episodes.brief`,
  every outline point cites a claim id) → idea handoff (`sourceType:
  'editorial'`; auto-greenlit on T2+, inbox on T0/T1). Zero surviving claims →
  episode **cut** + decision row.
- **Per-channel memory**: pgvector `memory_chunks` (1536-dim, HNSW cosine;
  Docker image is now `pgvector/pgvector:pg16` — see DEPLOY.md for the prod
  volume migration). **Scope tiers** enforced in `retrieveMemory`: episode N
  retrieves channel carry-over + its OWN dump only. Post-publish
  (`editorial-postpublish`): transcript + coverage summary carry over to
  channel scope; the raw dump is marked prunable. `EmbeddingProvider` = OpenAI
  text-embedding-3-small (`OPENAI_API_KEY`) or a deterministic bag-of-words
  mock with real cosine behavior. Canonical memory = `channel_decisions`
  (curated ledger) + charter + coverage ledger, distilled by
  `channelStateSummary` into the always-injected prompt block.
- **Factuality gate** in the production pipeline (before scripting): blocks →
  `on_hold` + `agent_actions` evidence row (`factuality_check`, the
  variation-check triad); passes → the scriptwriter gets a "VERIFIED FACTS
  (cite only these)" block + memory grounding, and the script_review gate's
  `payloadSnapshot` carries the **citations** the human reviewer sees in the
  gates UI.
- **Cockpit**: per-channel **Plan tab** (charter card, series arcs with
  approve/reject, per-episode claim counts ✓/~/✗, coverage ledger, "Plan /
  research now"), citations at the script gate.
- E2E: `scripts/build5-test.mjs` (wizard → plan → research → verified claims →
  pipeline with citations → publish → coverage carry-over + a charter-less
  physics-channel regression proving the gate skips cleanly).

**#5.2: ✅ shipped (2026-07-06).** All three deferred pieces landed on the
existing rails (migration 0008):

- **Multi-checker pre-publish review board** (`packages/agents/src/review-board.ts`,
  pipeline step `review-board` after the variation check, charter'd channels
  only): compliance (forbidden topics + claims-match-sources), charter/brand
  alignment, and platform-safety are **hard** checkers; quality/retention-
  prediction (pattern-store-grounded) is **advisory**. Any hard-fail →
  `on_hold` + per-checker `agent_actions` evidence rows + a `review_board`
  summary row — the same triad as factuality/variation.
- **Operator briefings** (`channel_briefings`, `operator-briefing` cron 07:00 +
  `editorial/briefing.requested` event): honours the charter's
  `checkinCadence` (weekly/monthly); composes "what happened / direction /
  suggestions / do you agree?" from exact SQL facts (publishing, retention,
  gates/alerts, spend, plan state, patterns). Cockpit **Briefings tab** with
  agree/disagree per suggestion + free-text steer; the response lands as a
  `briefing_response` decision row so it feeds planner/writer prompts via
  `channelStateSummary`.
- **Controlled experimentation** (`experiments`, one ACTIVE per channel via
  partial unique index): briefings propose at most ONE single-variable test —
  operator-approved on T0/T1, auto-activated on T2+. While active, the
  directive is injected into the scriptwriter prompt and productions are
  tagged `experimentId`; at `targetSampleSize` published videos the cron
  concludes it **deterministically** vs the channel baseline
  (`evaluateExperimentOutcome`: retention first, views fallback, ±10% band —
  the LLM only narrates) → `experiment_concluded` decision row.

E2E: `scripts/build52-test.mjs` (briefing round-trip, one-variable-at-a-time,
board holds a forbidden-topic production, clean production passes to the
final gate).

**Goal:** the platform is good at *making a video once handed an idea*. This is
the missing layer *above* the production pipeline: a per-channel, **stateful
editorial engine** that decides what the channel is, where it gets its truth,
what it should say over the next months, and in what order — running
continuously, with the operator as editor-in-chief. **Start evergreen** (a real
ghost niche with deep content potential — history/science/archaeology: clean
source story, monetisation-safe); reactive/topical channels are build #8.

### Ghost-niche candidates (data-backed, 2026-07-06)

Discovery pass via vidIQ (keyword demand vs competition + breakout proof that
*small* channels win). Ranked by ghost-niche quality for a faceless, evergreen,
monetisation-safe, corroboratable channel. Numbers are the seed keyword's est.
monthly search / competition (0-100, lower=better) / opportunity (0-100).

1. **Aviation history** ⭐ recommended — 39k/mo · comp 39 · opp 65. Best
   small-channel breakout proof: *Aviation Explained* (2.3k subs) → 104k views;
   *Every Warplane Explained* (5.9k) → 68k. Bottomless episode catalog (one per
   aircraft — Tu-144, Boeing 707, Constellation, A-10…, most sub-terms comp <30).
   Clean, corroboratable (aviation records), strong archival/stock footage.
   Sub-lane: air-disaster breakdowns (Air France 447 ~75k/mo) — higher
   engagement but more sensitive (real deaths).
2. **Deep sea / ocean mysteries** — 75k/mo · comp 38 · opp 68 (highest demand +
   depth: "ocean mysteries" 80k/mo, "deep ocean" 169k/mo, "ocean documentary"
   160k/mo). Visually spectacular. Caveats: more big-brand presence (HISTORY,
   Discovery) so small-channel wins less proven; pseudoscience adjacency
   (Ancient Aliens) — must stay science-grounded.
3. **Engineering disasters / forensic failures** — 56k/mo · comp 50 · opp 63.
   Proven breakout: *FailMatrix* (6.8k subs) → 1.14M views (forensic analysis).
   Every bridge/dam/structure failure = an episode; corroboratable via
   investigation reports. Aim at the forensic-explainer angle (avoid drift into
   low-quality "fails" compilations).
4. **20th-century / WWII military history** — "WWII" 121k/mo; *Best WW2 Archives*
   (7.4k subs) → 66k. Enormous depth. Caveats: war content carries some
   monetisation sensitivity, and the "cold war" framing bleeds into *current*
   geopolitics/news — keep it strictly historical.
5. **Maritime history / famous shipwrecks** — "shipwreck" 40k/mo · comp 39;
   deep catalog of named wrecks (Lusitania 33k/mo, Empress of Ireland 12k).
   Lowest competition, but the bare term pulls mixed content — needs a tight
   "famous shipwrecks explained" angle.

**→ LAUNCH TARGET: Aviation history (starter channel).** Operator locked it as
the first channel; it seeds the first charter when the editorial engine is built.

**Alternative / contested history — wanted future channel.** High demand and the
operator leans into it (Göbekli Tepe genuinely pushed the monumental-architecture
timeline back ~6k years, vindicating "the standard story was incomplete"). The
accuracy model doesn't ban this — it runs it in a **"present-the-debate" mode**:
state the mainstream position, attribute the alternative hypothesis to who argues
it, show the evidence each side cites, and never assert a contested claim as
settled fact. That framing keeps it corroboratable + monetisation-safe while
still challenging the narrative. Filed as a candidate once the engine is proven.

### New capabilities / entities

- **Channel charter** (extends ChannelDNA): mission, objectives, audience,
  **content archetype** (evergreen-series | monitor/digest | reactive→#8),
  **format policy** (see #6), **source strategy**, **verification bar**, cadence
  targets. Created **interactively at channel setup** — the operator co-creates
  the idea + initial roadmap. Ghost-niche discovery can be an AI-assisted step
  (reuses the existing `ghostNiche` scoring axis). The AI also **proposes the
  channel identity** — name + `@handle` options + avatar/banner concepts — for
  the operator to pick at setup.
- **Source connectors** — a new provider category (real + mock, same pattern as
  research/media): RSS/news, YouTube, science/preprint feeds, web-scrape
  (robots.txt/ToS-aware, **error-tracked** — scrapers are brittle), social. Plus
  a **discovery step**: the agent proposes authoritative sources for a topic.
  Asset/video ingestion is detailed in #7.
- **Verification / accuracy layer — TIERED by claim type.** Established fact
  (history: "how this plane was used in WWII") requires **≥2 independent
  corroborating sources or it's cut**. Emerging/unverified (a just-announced
  study) is **framed as reported/claimed** with attribution + hedged language,
  never asserted as settled. Store provenance/citations per claim; a
  **factuality gate before scripting** (same on_hold + evidence-row mechanism as
  the variation check).
- **Stateful content plan / Series / Episode** entities: ordered arcs (e.g. a
  12-part Egypt series) deployed over time; the planner **researches the NEXT
  arc as the current one runs down** (research-ahead). Feeds the build #3
  scheduler (which plans the calendar) and production scripts ahead.
- **Per-channel memory (RAG) — split by type, do NOT vector everything.**
  (a) *Canonical/structured memory* — charter, decisions log (charter changes,
  greenlights/rejections, operator steers, experiment outcomes + rationale),
  episode/series ledger, performance — lives as first-class Postgres rows for
  **exact** queries ("have we covered the Concorde?" is a lookup, never a
  similarity search that could hallucinate). (b) *Semantic memory* — ingested
  source docs, transcripts, past scripts, briefing notes — lives in a
  **pgvector** table scoped by `channelId` for retrieval-augmented ideation/
  scripting/verification. Use **pgvector, not a separate vector DB**: one source
  of truth, per-channel isolation is a `channelId` filter, no sync, open-source
  (the schema already flags the pgvector migration path). Add an
  **`EmbeddingProvider`** (real + deterministic mock, keyless in dev/CI). RAG
  doubles as the **accuracy/citation backbone** — scripts grounded in retrieved,
  cited evidence, not the model's parametric memory. **Compact** with a rolling
  per-channel "state of the world" summary that's always injected (charter +
  distilled decisions/coverage) plus top-k retrieval for specifics, so context
  stays dense. Builds on what exists: `agent_actions` (raw decision/audit log),
  the build #4 pattern store (cross-channel "what works"), and
  `substanceFingerprint` + the variation check (crude "have we covered this").
- **Memory scope tiers — episode-local vs channel carry-over (prevents
  cross-video contamination).** Raw research dumps used to script one episode are
  **episode-scoped**: they script + verify + cite *that* video and are **excluded
  from channel-wide retrieval** (the Spitfire data dump must not bleed into a
  Concorde script); they can be archived/pruned after publish. What **carries
  over** into channel memory is lean — the **transcript + a coverage summary**
  (what we said + how it was framed, for continuity/callbacks/dedup), decisions,
  the coverage ledger, and only research explicitly classified as
  **holistic/general**. Default new research to episode scope; a classification
  step promotes to channel scope only when clearly general (conservative by
  default). Retrieval for episode N = channel carry-over + episode N's own dump,
  never another episode's dump.
- **Multi-checker pre-publish validation ("AI review board").** Because mature
  channels have **no per-video human gate**, a stack of AI checkers must pass
  before publish: factuality/citations, anti-clone/variation (exists),
  compliance (forbidden topics, AI disclosure, claims-match-sources),
  charter/brand alignment, quality/retention-prediction (pattern store),
  platform-safety. Any hard-fail → `on_hold` + evidence row.
- **Autonomy + configurable check-in.** Operator is present at **charter
  creation + the initial roadmap**, then on a **configurable cadence** (weekly
  default, monthly for mature channels — a per-channel dial extending the
  autonomy tiers). **No per-video approval.** A scheduled per-channel
  **briefing** ("what happened / direction / suggestions / do you agree?") over
  Slack/email/in-platform captures steer and feeds the plan.
- **Controlled experimentation.** Changes are **small and one-variable-at-a-time**
  (hook style, thumbnail, structure) so performance deltas are attributable — an
  experiment layer on top of the build #4 pattern store; never wholesale rewrites.

### Notes

- Reuses the spine: charter is ChannelDNA++, connectors are providers, the
  plan/series are new entities, the feedback loop is build #4 + attribution — not
  a parallel pipeline.
- This is the heart; the scheduler (done), production, and analytics all plug
  into it. Likely the next build after the vision settles.
- **Channel provisioning is a manual, one-time human step — the platform cannot
  auto-create channels.** There is no API to create a Google account or a YouTube
  channel (ToS, CAPTCHA, phone verification). Also not settable via the YouTube
  Data API: channel **title**, **@handle**, **avatar**. So the flow is: AI
  proposes identity/branding → operator creates the Google account + YouTube
  channel and applies the name/handle/avatar by hand → connects it to the
  platform via the existing per-channel OAuth (`real/publish.ts`). After that the
  platform runs everything (upload, thumbnails, metadata, scheduling). API *can*
  set channel description/keywords, banner, and watermark once connected. This
  manual step doubles as a natural operator checkpoint at channel creation.

## 6. Format modes — long-form masters feeding a LINKED shorts channel

**Goal:** channels differ in format, and it's per-channel policy — not global.

**⚠️ Design decision (operator, 2026-07-07): derived shorts NEVER publish on
the long-form channel.** Mixing formats on one channel hurts both — Shorts and
long-form are recommended by different algorithmic surfaces to different
audiences, and Shorts-acquired subscribers watch long-form poorly (see the
warm-up table in #3), polluting the long-form channel's audience signals.
Instead, the platform links **channel pairs**: a long-form channel produces
masters, and a separate, dedicated shorts channel is fed the derived clips.

- **Format policy per channel:** `shorts_only` | `long_only` |
  `long_plus_shorts` (v1 platform is shorts-only). The stored
  `long_plus_shorts` enum value is REINTERPRETED under this decision: it means
  "this long-form channel derives shorts **for its linked shorts channel**" —
  it never means both formats publish on one channel.
- **Channel linking.** New nullable `channels.feedsFromChannelId` (or a
  `channel_links` table if pairs ever need metadata): the shorts channel
  points at the long-form channel that feeds it. Both are full first-class
  channels — own YouTube identity + OAuth, own warm-up ramp (per-format
  dayparts from #3), own analytics/briefings/costs, own DNA (hook styles tuned
  for Shorts). The wizard grows a "create the linked shorts companion" step
  when a long-form channel is created (identity proposals for the companion
  included; provisioning stays manual per channel, as always).
- **Derivation pipeline — LITERAL CLIPPING SHIPPED (2026-07-08).** Operator wants
  literal cuts, not AI rewrites. On a master's publish, if its channel feeds a
  linked Shorts channel (`channels.derived_from_channel_id`),
  `editorial/derive-shorts` fires → **ffmpeg** (bundled `ffmpeg-static`) cuts the
  master render into **vertical 9:16 clips of ≤60s** (blurred-pad bg so nothing
  is cropped), each stamped **"Part N"** (`apps/worker/src/clip.ts`) → each clip
  is stored + created as a `scheduled` production on the Shorts channel with
  `master_production_id` provenance (migration 0015) → a durable `publish-clip`
  fn `sleepUntil`s each clip's **staggered** time (first +24h, then paced by the
  Shorts channel's cadence) then uploads + releases it, description one-way
  links to the master. **Note:** the earlier semantic-rewrite version was
  removed. **Remaining:** clip-selection scored vs the pattern store (which
  windows are best, not just sequential); a "Shorts of \<parent\>" chip; the
  wizard "create the linked companion" step; and a full cross-channel e2e
  (produce master → publish → auto-clip → scheduled Shorts). Original spec:
  Master render on the long-form channel →
  highlight detection (a ~14-min video → up to ~15 candidate clips) → clip
  selection scored against the pattern store (clip choice is itself a
  retention/hook problem) → vertical crop/reframe + captions → each selected
  clip becomes a normal production **on the linked shorts channel** with
  `masterProductionId` provenance, flowing through the standard gates, warm-up
  scheduler, and review board of THAT channel.
- **Cross-channel funnel, one-way.** Shorts descriptions/pinned comments link
  to the full video on the long-form channel (tracked links per build #2 when
  it lands). The long-form channel never links back to the shorts channel —
  the funnel runs discovery → depth only.
- **Analytics stay segregated** (already true: everything is per-channel).
  The interesting new metric is funnel conversion: shorts views → long-form
  views/subs via the tracked links.
- OSS reference: MIT/Unlicense long-form→shorts tooling exists (Whisper +
  highlight detection + vertical crop).

---

## 7. Real asset ingestion — stock + source footage

**Goal:** stop relying only on *generated* imagery; pull in **real** assets,
which matters most for factual/historical channels (real plane footage,
archaeological sites).

- **StockAssetProvider(s)** alongside the generative MediaProvider: real **stock
  images AND stock/b-roll video** from licensed libraries as beat visuals;
  generated imagery is the fallback. Slots into the existing MediaProvider seam +
  an asset-selection step in the pipeline.
  - **✅ FREE STOCK LIBRARIES SHIPPED 2026-07-21 (`8048ea1`, with #36).** Photos —
    Pexels/Pixabay/Unsplash added as candidate producers in `real/reference-images.ts`
    (mapped to `WikimediaCandidate` → same pick/vision-fit/auto-credit pipeline;
    `isReusableLicence` extended for the named stock licences; keys threaded via the
    factory; top-up when the archival pool is thin, direct on topic shots). Video —
    `sourcePixabayClip`+`sourceCoverrClip` in `footage.ts` wired into the
    `source-hero-footage` fallback chain (Pexels→Pixabay→Coverr, Pexels video already
    existed). Keys: `PEXELS_API_KEY`/`PIXABAY_API_KEY`/`UNSPLASH_ACCESS_KEY`/
    `COVERR_API_KEY` (free). Mixkit/Videvo skipped (no clean API / per-asset licensing).
- **Subject-accurate (entity-grounded) visuals — HIGH for history/factual
  channels. First cut SHIPPED (2026-07-08).** Scriptwriter emits an optional
  `referenceEntity` per beat; a `ReferenceImageProvider` (Wikimedia) resolves it
  via Wikipedia REST → the subject's lead image, reads the Commons licence,
  accepts only PD/CC, downloads into our ObjectStore, and stores
  source/licence/attribution in `assets.meta`; generative imagery is the
  fallback. Keyless (runs unless `PROVIDERS_FORCE_MOCK`); fails safe to null.
  Runtime-verified live (Spitfire → CC BY-SA 2.0 photo; Concorde → CC BY-SA 3.0).
  **Licences: SAFE-ONLY (updated 2026-07-08)** — accepts only PD/CC0/plain
  CC-BY; -SA/-NC/-ND and unknown licences fall back to generative
  (`isReusableLicence` + tests; verified: Spitfire CC-BY-SA rejected, Wright
  Flyer PD used). Fewer images qualify now — that's the safe tradeoff.
  **Attribution SHIPPED (2026-07-08):** the publish step appends an "Image
  credits" section (entity · author · licence · source, deduped, capped to
  YouTube's 5000-char limit) to the video description for every licensed
  reference image; the production page also lists the credits for pre-publish
  review. CC-BY compliance closed. **Coverage: Commons search SHIPPED
  (2026-07-08)** — the single Wikipedia lead image is usually CC-BY-SA for modern
  subjects (hit rate was ~1/5), so it now falls back to a Commons file SEARCH and
  picks the first safe-licensed raster photo (≥500px, skips SVG/logos),
  downloading a scaled `iiurlwidth=1600` thumbnail (0.2–1.6 MB, not the 4.8 MB
  original). Verified live: 7/7 aircraft got a real safe photo (Spitfire CC BY
  4.0, most others PD/CC0). Optional upgrade left: Wikidata **P18** for even more
  precise entity→image resolution. Original finding below.
  When a beat names a *specific*
  real-world subject (e.g. "the Supermarine Spitfire", a named battle, a person,
  a place), the visual must show **that actual subject**, not a random or AI
  imagined image — otherwise a history channel loses credibility. Pipeline
  change: an **entity-extraction step** over each beat/script (the named
  aircraft/person/place/event), then a **reference-image/footage lookup keyed to
  that entity** from authoritative sources (Wikimedia Commons — CC/PD and rich
  for aircraft/history; official archives; the channel's own licensed library)
  BEFORE falling back to generative imagery. Store the chosen source + licence
  per asset (`assets.meta`) for attribution/compliance. Tie the entity to the
  verified claims (§5 factuality) so the picture matches the fact being stated.
  Generative imagery stays the fallback for beats with no concrete real subject
  (concepts, transitions). This is the visual analogue of the factuality gate:
  right subject, not just a plausible-looking image.
  - **Sourcing = Wikimedia APIs, NOT scraping.** (a) **Wikidata** resolves the
    entity → Q-id → property **P18** for the canonical image of that exact
    subject; (b) **MediaWiki Action API** (`commons.wikimedia.org/w/api.php`,
    `generator=search` ns 6 → `prop=imageinfo&iiprop=url|extmetadata|mime|size`)
    returns the file URL + license/author/credit in `extmetadata`; (c)
    **Wikipedia REST** (`/api/rest_v1/page/summary/<title>`) for the article
    lead image. **Download bytes into our ObjectStore** (request a scaled
    `iiurlwidth`), never hotlink; persist `sourceUrl` + `license` + `attribution`
    in `assets.meta` (CC-BY needs credit; PD is cleanest). **Required:** a
    descriptive `User-Agent` w/ contact (Wikimedia 403s without it) + polite
    rate limiting. Shape: a `ReferenceImageProvider.findEntityImage(entity,
    {aspect, license})` ahead of the generative fallback in the asset step.
- **Source-video ingestion/scraping** is distinct and legally spicier than
  licensed stock — a separate connector with explicit ToS/licensing/rights
  handling + error tracking. Prefer licensed / Creative-Commons / official
  sources first.
- **Storage + retention (video never touches Postgres).** Bytes already live in
  the `ObjectStore` (`store/fs.ts` local dev, `store/s3.ts` S3-compatible prod);
  Postgres only holds `storageKey` pointers + metadata (the `assets` table).
  **Storage decision: DigitalOcean Spaces** (S3-compatible, already wired via
  `s3.ts`, and we're already on DO — one vendor, built-in CDN, cheap: ~$5/mo for
  250 GB + 1 TB egress).
- **Retention policy — KEEP every final video permanently.** YouTube is NOT a
  durable copy: it can block, age-restrict, unpublish, or terminate videos/
  channels. So every final render we produce is **archived permanently** in
  Spaces as re-upload/re-purpose insurance. Only the *rest* is pruned via
  lifecycle rules: intermediate assets (voiceover, beat images) after render;
  downloaded source/stock clips as a **re-fetchable cache** (prune after publish
  + grace). If the finals archive ever balloons, a cold-archive tier (e.g.
  Backblaze B2 ~$0.006/GB) is the cost-optimisation fallback — but default is
  keep-all-finals on Spaces. Track storage cost in the existing cost-records
  system.

---

## 8. Reactive / topical channels (event-driven, mostly shorts) — PARKED

**Goal:** channels that react to the world in near-real-time — a tweet drops, a
match ends, a headline breaks → a 60s short within hours. The opposite of #5's
planned evergreen cadence.

- **Event-triggered, low-latency:** the platform *listens* (webhooks/polling on
  X/social, news, sports feeds) rather than running a daily cron; a source event
  triggers a fast-lane production.
- **Format:** mostly shorts (reuses #6 shorts-only).
- **Why parked (risk):** X has no cheap API and scraping it violates ToS + breaks
  constantly; Trump-tweets / political content carry copyright + YouTube-
  monetisation exposure; Australian politics is topical but same caveats. Prefer
  official APIs / RSS; treat scraping as a tracked fallback. **Revisit once the
  evergreen editorial engine (#5) is proven.**

---

## 9. Account & off-platform architecture (operator decisions, 2026-07-07)

**Goal:** channels are provisioned for algorithmic trust, not just convenience.
YouTube evaluates more than the channel: the owning account and the channel's
off-platform footprint both carry signal.

- **✅ RESEARCH VERDICT (2026-07-07, `docs/research/accounts-and-offplatform.md`):
  contamination is real but VIOLATION-based, not performance-based.** 3 active
  copyright strikes on one channel put every channel under the Google account
  at termination risk, and dodging a restriction via a sibling channel is
  circumvention (since July 2025 enforced across accounts linked by recovery
  email/phone, device, IP). But NO credible source documents poor
  performance/CTR on one channel suppressing siblings — the performance-
  contamination hypothesis is unsupported.
- **Architecture: POD MODEL, not one-email-per-channel.** 3–10 same-risk-tier
  faceless channels per dedicated Google account (Brand Accounts — one
  account supports up to 100 channels); anything legally/policy-spicier
  (compilations, reaction, political) isolated on its own account. Mass
  account farming is the HIGHEST-risk option (Google links accounts via
  recovery email/phone, device fingerprint, IP). Each pod account gets a
  unique recovery phone/email.
- **Off-platform presence: DEMOTED from ranking lever to branding/funnel.**
  Social links appear nowhere in YouTube's published recommendation signals
  (clicks, watchtime, surveys, shares, likes/dislikes) — recommendations
  dominate traffic and are engagement-driven. Keep the FB/IG/Pinterest/X
  accounts as optional branding + cross-posting distribution surfaces (their
  own audiences), not as a YT trust hack. CTR/AVD problems point at
  thumbnails/hooks, not missing social links.
- **API reality check:** channel-header social links CANNOT be set via the
  Data API (manual YouTube Studio step). Automation CAN set title,
  description, keywords, country, trailer, and banner art
  (`channelBanners.insert` → `channels.update`, read-modify-write only), and
  each channel needs its own OAuth consent (no single-auth path for
  non-partners) — which the platform already does.
- **Wizard provisioning checklist (amended):** pod Google account (unique
  recovery phone/email) → Brand-Account channel under the pod (≤10, risk-
  segregated) → per-channel OAuth → API-set branding text/banner → manual
  Studio pass (handles, social links, verification). Social account creation
  optional per channel, valued for cross-posting reach not YT ranking.
- **Hard rule from the research: NEVER re-upload or cross-post content from a
  struck/terminated channel into a sibling** — that is circumvention and can
  take down the whole account (or all linked accounts).
- **Future build:** cross-post shorts to the socials (FB Reels / IG Reels /
  Pinterest Idea Pins / X video) — content exists, distribution is nearly free
  and feeds the off-platform signal loop.
- **Diagnostic rule:** healthy impressions with poor CTR/AVD → suspect
  thumbnails/hooks first, AND check the off-platform/linking signals — a
  channel with zero footprint may be getting shown but not trusted.

---

## 10. Growth guardrails — two impression checkpoints + never-delete

**Goal:** a channel must earn its keep, but on a fair clock; and the account it
lives on is part of what's being judged.

- **Checkpoint 1 — month-one launch bar:** first month of posting should
  produce **20 published videos** and **≥100k impressions**. **Amended by the
  #9 research verdict:** a performance miss does NOT burn the account
  (contamination is violation-based only), so the default flag action is
  channel-level — iterate (hooks/thumbnails/niche) or shut down. **Re-home on
  a fresh account only when the account itself is compromised** (strikes on a
  sibling, circumvention exposure) — and never by re-uploading the struck
  channel's content. 20/month is consistent with the #3 Shorts warm-up ramp's
  output; this is a floor on execution, not a cap change.
- **Checkpoint 2 — steady-state viability:** after warm-up graduation plus a
  **3-month grace**, a monthly review checks **impressions over the trailing
  28 days ≥ 100k**. Consistent misses flag the channel for **shutdown
  review**. Give it time first — that's what the grace period is.
- **Both checkpoints flag; a human decides.** Surfaced as a `viability` alert
  + a line in the operator briefing (#5.2). Actions: give time / shut down
  (pause or archive) / re-home on a fresh email. Nothing automatic.
- **Build status: foundation SHIPPED (2026-07-07)** — snapshots `impressions`
  column (migration 0009), mock analytics emits deterministic impressions,
  ingest stores them, and `packages/core/src/viability.ts` carries the policy
  (graduation + grace + bar assessment; dormant until wired). Remaining:
  checkpoint evaluation in the ingest/briefing rails (viability alert +
  briefing line + cockpit chip) with the amended checkpoint-1 semantics.
  Note: thumbnail-impressions availability in the Analytics API v2 must be
  probed on a live channel — the real adapter reports null until verified
  (policy returns "unknown" rather than passing/failing on null).
- **UPDATE 2026-07-13: real view counts now flow** (`b325797`). The analytics
  adapter only queried the YouTube **Analytics reporting API** (v2/reports),
  which lags ~2-3 days and returns empty rows for new videos → 0 views on the
  dashboard despite real Studio views (confirmed via prod raw `{"rows":[]}`).
  It now also fetches **Data API v3** `videos.list?part=statistics` viewCount
  (near-real-time, matches Studio) and prefers it for `views`. VERIFIED on prod
  (fresh ingest wrote real counts 1 & 3, operator-confirmed). STILL NULL until
  the Analytics API matures / a separate report is added: avg-view-% + CTR +
  thumbnail impressions + subs-gained (the "Phase 5" CTR/impressions report).
- **Never delete — absolute rule.** A video is never deleted for performance:
  deletion is a spam signal, the catalog compounds (search/AEO long tail),
  and YouTube is not our durable store anyway (#7 keep-all-finals). Extends
  the existing never-delete-and-reupload scheduler rule.

---

## 11. SEO + AEO metadata engine

**Goal:** every video is optimized both for classic YouTube search (titles,
descriptions, tags) and for **answer engines** — how Gemini, AI Overviews and
assistants pick and cite videos. "How AI will suggest my videos" becomes a
standing ruleset baked into all scripting.

- **✅ RESEARCH DONE (2026-07-07, `docs/research/video-seo-aeo.md`)** — the
  distilled, prompt-injectable **`RULES FOR EVERY VIDEO`** block is in that
  doc (12 rules; inject verbatim). Headline verdicts:
  - **AI engines cite long-form, not Shorts** (94% vs 5.7% of observed AI
    citations; YouTube is the #2 cited domain overall). Shorts win *feed
    discovery*; AEO citability comes from structured long-form → strengthens
    the #6 linked long-form strategy.
  - **Citability is structure, not popularity:** subscriber count ~zero
    correlation (r=-0.03); 41% of cited videos had <1k views. Longest lever:
    metadata-style descriptions (r=0.31) + keyword-bearing chapter timestamps.
    Small new channels CAN be cited — good news for us.
  - **The spoken script IS metadata:** search matches transcript/ASR alongside
    title/description; say the primary keyword + entities in the first 5s.
  - **Tags are cargo cult** (official: minimal role; misspellings only).
    Shorts-feed ranking ignores metadata entirely (chose-to-view, % watched,
    recency — Shorts exposure decays after ~30 days).
  - **Channel-level topical E-A-T is real** for the search surface — one topic
    per channel (already our model).
- **Wiring (build, after research):** the ruleset becomes standing grounding
  for the scriptwriter (same injection mechanism as pattern grounding,
  `packages/core/src/patterns.ts` precedent) + a dedicated **metadata step**
  in the pipeline that generates title/description/tags/chapters against the
  rules (today metadata is assembled naively at publish: title = idea title,
  tags from title words — production-pipeline step 9).
- Transcripts/captions matter for AEO: the platform owns word-level timestamps
  already (voiceover step) — upload captions with publish (caption_track asset
  kind exists in the schema; wiring TBD).

---

## 12. Net-information-gain niches + production stack preferences

**Goal (portfolio strategy):** dedicate some channels to topics with **no
existing video coverage** — e.g. biographies of niche athletes (the
"snowboarder biographies" example). Filling a genuine information gap makes
YT/Google/Gemini validate the channel as a *source*, which earns algorithmic
push and AI citations — compounding with #11.

**Research verdict (2026-07-07, `docs/research/video-seo-aeo.md`):** the
thesis is **not supported as a general ranking bonus** — Google's
"information gain" patent scores follow-up-need in assistant dialogs, not
uniqueness per se, and no evidence shows YouTube pushing videos merely for
covering uncovered topics. BUT the citation data *indirectly* favors the
strategy for AEO: AI engines cite low-popularity videos freely (41% of cited
videos <1k views), so being the only structured source on a topic is a
practical citability edge. Keep the strategy; expect the win via AI
citations + search long-tail, not via a feed-algorithm push.

- **Selection wiring:** extends the existing `ghostNiche` scoring axis
  (`packages/agents/src/scoring.ts` rubric) with an information-gain lens:
  demand exists (search volume) + video-format coverage is absent. The wizard
  and market-intel discovery flows should surface "not covered in video" as a
  first-class niche signal.
- **Verification synergy:** info-gain channels lean hard on the #5 editorial
  engine — being a "source" only works if the tiered-verification bar holds.

**Production stack preferences (operator, 2026-07-07):**
- **Thumbnails:** nano-banana (Gemini image) as the thumbnail-generation
  option — cheap and strong for text/composition. Lands as a MediaProvider
  route/option alongside fal.ai (thumbnail prompts already exist in the
  pipeline, step 7b).
- **Scripting:** Claude — already true, and now DIRECT (2026-07-07): the
  platform holds per-vendor API keys and routes tiers itself instead of
  riding a gateway's upstream lottery. Vendor-prefixed refs
  (`anthropic:claude-opus-4-8`, `google:gemini-2.5-flash-lite`,
  `glm:glm-4.6`, `qwen:qwen-plus`, `kimi:kimi-k2-turbo-preview`); keys +
  tier models all editable on /account; OpenRouter demoted to
  fallback/long-tail. GLM/Qwen/Kimi are first-class options for the cheap +
  agentic tiers where they make sense — A/B them via the experiment rail.
- **Voiceover:** ElevenLabs remains the wired real provider; evaluate cheaper
  alternatives (MiniMax / Fish Audio-class) — candidate list + quality/cost
  comparison is part of ordinary provider work, VoiceProvider interface
  already isolates the swap.

## 13. Dashboard UI/UX look-and-feel pass — largely shipped (2026-07-13 evening)

**UPDATE 2026-07-13 (evening): the Overview dashboard pass landed** (commits
`e246ff7`…`9a426cb`, `b325797`, `55fab32`) from an operator screenshot review,
and **`STYLE-GUIDE.md`** was added as the enforced reference above UI-REVIEW.md +
`/design-system`. Shipped: top bar removed on desktop (mobile-only; status
single-sourced so it never doubles), tab strip no-scroll + **active tab in the
URL** (`?tab=`, fixes the drag-drop bounce), equal-height + top-aligned panels,
Review tab removed, Costs table rebuilt to standard, **numbers off mono → Inter
tabular**, 6-KPI even grid (no orphan), "Needs your attention" capped +
internally scrolling, new widgets (Subs 30d, Est. net 30d, Pipeline health,
Upcoming publishes, sortable Top-videos-by-performance strip with YT thumbnails),
**channel logos** persisted + rendered (migration 0033), and a **Cards/Table
toggle** on the channels section. Remaining look-and-feel: per-channel dashboards
+ the deeper composition pass below; small: channels-Table click-to-sort,
per-channel RPM for the profitability tile.

**Status (original): parked / deprioritised.** The design-system *foundation* shipped
(PR #11, deployed to prod `ad88fb5`): refreshed indigo accent + slate neutrals,
Inter + JetBrains Mono, reusable `components/ui/*` primitives (Button, Card/Panel,
Badge, StatTile, DataTable, Field, EmptyState, Skeleton, Segmented, Dialog),
`RadarChart`, and a living reference at the `/design-system` route. Tokens/colour
are **not** the concern.

**What's still wanted (later):** a deeper pass on the overall *look and feel* of
the dashboard — layout, hierarchy, density, spacing rhythm, and how information is
composed on the page (esp. the Portfolio/Overview and per-channel dashboards). The
current screens read as functional but not yet "clean and polished" at the
composition level. This is a design/UX exercise, not a token tweak.

**When picked up:**
- Use the bundled `ui-ux-pro-max` / `design-system` skills in `.claude/skills/`.
- Anchor on the `/design-system` primitives — extend them rather than adding a
  parallel system (main mandates one `.btn` system; see `CLAUDE.md` / `UI-REVIEW.md`).
- Screens still on main's markup can be migrated onto the primitives incrementally.
- Also open (minor): Phase-0 sign-off — accent A/B/C (default A indigo), product
  name (still "YT Auto"), logo mark. Preview at `/design-system`.

## 14. Channel-setup + operator-cockpit UX overhaul — PARKED (2026-07-08)

From the first live walkthrough of the channel wizard + production flow. The
theme: **aggregate, cross-channel operator views with clear status and
in-context actions** — a real cockpit, not per-channel pages you navigate
between. All UI work here MUST use the bundled `ui-ux-pro-max` design skill
(see `use-design-skills-for-ui` memory) and verify on the live site in
light+dark at desktop + 390px.

**Already shipped (context):** wizard Back-nav + pre-filled step-1 fields,
persistent co-pilot dock, avatar generation, "Generate 3 more" identities,
draft autosave, channel deletion, review-step **preset objectives (tick +
counters)** and **tone quick-pick chips**, Qwen default + tabbed /account Models
page. Bug fixes: qwen json_object, relaxed strict schema bounds
(charter/identity/rubric/script-beats/thumbnail), pinned
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, pinned OAuth redirect to `PUBLIC_BASE_URL`.

**Parked work:**

- **Wizard step-1 redesign** ("Phase E", already approved). Fix janky spacing —
  the field block used `grid-2` without `grid` (no `display:grid`) and mixed
  label-inline vs label-stacked. Rebuild as tidy sections with a real
  `grid grid-2`. **Format-dependent length** (short=seconds≤60/40, long=minutes/8,
  both=both). **Release schedule** headlined by a first-month objective (~20) +
  warm-up weeks + steady/week; persist a `release_plan` jsonb on `channel_dna`
  (migration 0011). Move the co-pilot to a **right-side collapsible drawer**
  (bottom sheet ≤980px). Codify the design-skill rule in `CLAUDE.md`.

- **Cross-channel Production Flow view.** One aggregate view of **every
  production underway across all channels**, grouped by stage, each row with
  live status and a spinner on the active stage. **Greenlight in context** here
  (ideas → productions shouldn't force a separate Ideas page). Surfaces the
  ideas-vs-productions distinction clearly.

- **Per-row progress + failure surfacing. SHIPPED (2026-07-08).** Inngest
  `onFailure` now marks a hard-crashed run `failed` (+ failureReason, expires
  pending gate) once retries are exhausted, so it stops looking like it's
  hanging on its last stage. Overview "Needs attention" + the needsReview KPI
  and the channel "In production" tab now surface failed/on_hold productions
  with crit/warn badges + reason + deep link; in-flight chips get a live
  heartbeat dot. failed/on_hold stay haltable for recovery. **Remaining:** a
  true stall watchdog (a production that stops progressing with no error and no
  active run won't flip to failed — needs a cron comparing updatedAt vs a
  timeout); pre-fix stuck rows must be recovered via Halt.

- **Review = tabbed.** Add an aggregate **"Outstanding approvals"** tab (all
  script/final gates waiting across channels) alongside the production-flow view.

- **Schedule + Calendar.** A Schedule section mirroring the release-plan concept:
  a **Planned** sub-view (warm-up ramp / first-month objective / steady cadence)
  and a **Calendar** sub-tab showing which videos publish on which day/time
  (productions carry a `scheduled` status + publish time). **Consolidated
  cross-channel** calendar view too.

- **Embedded AI assistant** in the production/flow section (like the wizard
  co-pilot) to add videos, greenlight, and make changes in-context — distinct
  from the global `/assistant` (`runControl`), which already exposes greenlight /
  decide-gate / set-autonomy tools by chat.

- **Per-channel voice selection.** During channel setup, suggest ElevenLabs
  voices best suited to the channel (niche/tone/audience) and let the operator
  pick one, which becomes that channel's default `voiceId` (stored on
  `channel_dna`). Today all channels fall back to the global
  `ELEVENLABS_VOICE_ID`; the wizard should offer a curated pick (preview +
  select) instead of the `"default"` placeholder. Voice list via a
  `voices.list` call to the VoiceProvider.

## 15. Pipeline quality fixes — from live validation (2026-07-08)

Found while walking the first real production end-to-end.

- **Length-aware scriptwriter (important). SHIPPED (2026-07-08).** Root cause:
  `draftScript` hardcoded a "YouTube Short" system prompt + `format:"shorts"`
  grounding, so long-form channels got Shorts-length scripts. Now derives short
  vs long-form from `channel.contentFormat` / `targetLengthSec`, writes the
  prompt/grounding/beat-count to match, states an explicit word budget
  (targetLen × 2.5 wps), and **enforces it**: a draft under 85% of budget is
  re-prompted to expand (best-of, up to 2 extra attempts, each recorded via
  `runAgent`). Per-beat `estSec` estimates are computed and surfaced on the
  production page. Render still uses the real voiceover word-timestamps.
  **Caveat:** relies on the channel's `targetLengthSec` (channel_dna) being set
  correctly per format — ties to the format-dependent length work in §14. No
  migration (estSec is an optional field).
- **Retry / reset production action.** **Land 1 SHIPPED (2026-07-08).**
  "Halt & return to ideas" on the production page (any non-terminal stage) +
  `halt_production` assistant tool: resets the idea to `scored`
  (greenlightable), preserves the production as a new `halted` draft, and lets
  the operator keep/discard each produced artifact (script/voiceover/images/
  render/thumbnails). Cooperatively cancels the in-flight Inngest run via a
  `production/halt` `cancelOn` (never hard-deletes the row). Migration 0011 adds
  the `halted` status. **Land 2 (follow-up):** re-greenlight offers *Resume*
  (same production id → pipeline skips stages whose assets were kept) vs *Start
  fresh*. Reuse requires keeping the same production id because asset storage
  keys are `productions/<id>/...`; add skip-if-present guards to the
  voiceover/image/render steps (they already upsert idempotently) and dedupe
  thumbnails (the one non-idempotent stage).
- **Untracked failure spend.** `runAgent` records a cost line only *after* a
  successful call, so failed `generateObject` retries burn real provider tokens
  with no cost record (Qwen dashboard showed usage the cockpit never logged).
  Record attempts/failures too, or at least surface a warning.
- **Qwen structured-output reliability.** Frontier/agentic on Qwen fail complex
  nested schemas (DashScope is `json_object` only, no strict `json_schema`), so
  scripts silently failed validation and looped. Either add a repair/reprompt
  step for `json_object` vendors, or keep complex-schema tiers on
  json_schema-capable models (Anthropic/Gemini/OpenAI). Currently mitigated by
  moving those tiers to Anthropic on `/account`.
- **Resume-on-redo. Land 2 (script reuse) SHIPPED (2026-07-08).** "Resume —
  reuse script" on a halted production spins up a fresh production carrying the
  kept script (+ fingerprint) and regenerates media; the pipeline detects the
  pre-seeded draft and skips drafting/factuality/grounding/script-gate. Also
  fixed the anti-clone check to exclude rejected/halted/failed drafts from its
  priors (a resumed production was self-matching its halted parent).
- **Resume-on-redo. Land 3 (media reuse) SHIPPED (2026-07-08).** Resume +
  force-forward now COPY the source production's assets (voiceover/images/render)
  + thumbnails onto the new production keeping their `productions/<id>/...`
  storage keys, and the pipeline media steps **skip-if-present** (reuse the
  copied asset, never re-call the provider). Since halt already deletes discarded
  artifacts (Land 1), "reuse whatever exists" = the per-asset keep/discard
  behaviour for free: resume reuses what was kept, force-forward reuses
  everything and goes straight to publish. Thumbnail step skips when thumbnails
  exist (dedupe fix). Verified against the local DB (copy + skip lookups); a full
  worker+Inngest re-run still wants a live e2e.

## 16. Second live walkthrough findings (2026-07-08) — real production blockers

Found driving a real aviation long-form production past voiceover + fal.ai
images. These block a *watchable* first video; several are higher priority than
Land 3 (media reuse) which only optimises re-runs.

- **Length-extend can assert ungrounded facts (regression from §15 length-aware
  scriptwriter — HIGH). SHIPPED (2026-07-08).** When verified facts are present
  (factuality-gated channel), the first-draft length instruction AND the expand
  re-prompt now require reaching length by ELABORATING the same verified facts
  (mechanism/stakes/pacing/non-factual description) and forbid any new
  claim/statistic/name/date/event. Ungated channels keep "add depth/examples".
  Re-verification of the final script (option b below) stays covered by the
  existing review board (now escapable via Force-forward). Original finding:
  The expand loop re-prompted the writer to "add depth:
  more concrete examples, mechanisms and context" to hit the word budget. On a
  factuality-gated (charter'd) channel the script may ONLY assert verified/
  attributed claims, but the expand instruction invites *new* substance, so the
  extended draft asserted facts with no backing and got flagged downstream.
  **Fix:** (a) the expand prompt must re-state the verified-facts-only
  constraint and tell the writer to reach length by elaborating/reframing the
  SAME verified facts (pacing, analogy, restating stakes) — never new claims;
  and/or (b) re-run the factuality/claim check over the FINAL expanded script
  before it proceeds, not just the first draft. The factuality gate currently
  runs once, before drafting; the length loop happens after, inside
  `draftScript`, so the expanded text is never re-verified. Consider moving the
  grounded-claims validation to *after* the final script is chosen.

- **Long-form images are portrait, not landscape (HIGH, quick). SHIPPED
  (2026-07-08).** MediaProvider aspect gained `"16:9"`; `ShortProps.orientation`
  drives the Remotion canvas via `calculateMetadata` (portrait 1080×1920 /
  landscape 1920×1080); Captions adapt to the canvas. The pipeline derives
  orientation from `channel.contentFormat`/`targetLengthSec` and applies it to
  beat images, thumbnails (+ prompt label), and the render. Shorts unchanged.
  **Static-verified only** — eyeball a real landscape Remotion render on the
  next live run (couldn't render locally: needs worker + chromium).

- **Wrong voice + no voice management (HIGH — expands §14 per-channel voice).**
  **First cut SHIPPED (2026-07-08):** `VoiceProvider.listVoices()` (ElevenLabs
  `/v1/voices` + a mock library) + a **VoicePicker** on the channel form —
  dropdown of real voices with description + preview, and a "No voice picked"
  warning when a channel is still on the `"default"` placeholder. Saves a real
  id to `channel_dna.voiceId`. So the operator sets the aviation channel to the
  Adam voice and it sticks. **Still to do:** per-video voice override
  (needs a productions.voiceId column), AI-proposed voice in the wizard, and
  wiring the picker into the create wizard (not just settings).
  Original finding — the walkthrough narrated in a woman's voice (ElevenLabs
  Rachel fallback) because `channel_dna.voiceId` was the `"default"` placeholder
  and `voiceId: ctx.dna?.voiceId ?? "default"` resolved to the premade fallback.
  Wanted:
  - A **voice library**: `voices.list` from the VoiceProvider → id + name +
    description + preview, shown in the UI.
  - **One voice set per channel** (stored on `channel_dna.voiceId`, a real id,
    not `"default"`), **overridable per video** (a production-level voice pick).
  - The **AI may propose** a voice change when it thinks another fits better,
    but the operator's channel default wins unless changed — e.g. for aviation
    history the selected Adam voice is the right call.
  - Fix the default resolution so a channel with no explicit pick uses the
    operator's chosen `ELEVENLABS_VOICE_ID`, never silently a woman's premade.

- **No manual override to push a stuck production forward (HIGH). SHIPPED
  (2026-07-08).** "Force forward — override checks" on a blocked
  (on_hold/failed/rejected) production + `force_forward_production` assistant
  tool: re-runs from the reused script with the soft safety gates (variation +
  review board) bypassed and regenerates media through to publish. Each bypass
  writes an `operator_override` evidence row (agent_actions) for the compliance
  trail. Migration 0012 adds `productions.bypass_checks`. Complements Halt
  (§15 Land 1): Halt pulls back, Force-forward pushes through. **Remaining:**
  reuse media on the re-run (Land 3) so it doesn't regenerate already-fine
  assets.

## 17. Setup + charter + plan UX (2026-07-08, real-mode walkthrough feedback)

Operator feedback from creating a channel on the local instance running with
real providers. Extends §14; several items overlap it.

**BATCH SHIPPED (2026-07-08), all verified in the running app:** format→length
auto-flip, **Ideas top-level nav**, **live plan/research updates** (self-poll +
"Researching…" chip), **editable charter targets**, **structured release plan +
research-backed per-format presets** (migration 0013), **monetization research**
(`docs/research/monetization-targets.md`), **charter drafter now proposes
aggressive per-format targets**, **talk-to-agent on the plan** (channel-scoped
chat + get_charter/update_charter_objectives/run_plan_research tools), and
**derive-Shorts-from-long-form at creation** (migration 0014 link + preset).
**Remaining follow-ups:** edit the release plan post-creation (settings) +
structured target sliders (subs/hours model); a "Shorts of <parent>" chip; and
the substantive long→Shorts **cutting/repost pipeline** (the real §6 build).

- **Format sets target length. SHIPPED (2026-07-08).** In the wizard, picking a
  content format now flips `targetLengthSec` to a format default (long/both →
  480s, short → 45s) instead of leaving 40. Operator can still fine-tune.
- **Structured release plan (replace bare "videos per week") — HIGH.** A real
  section: **warm-up length (weeks)**, **# videos during warm-up**, **first-month
  target**, then **steady monthly output** (all editable, adjust as data comes
  in). Persist a `release_plan` jsonb on `channel_dna` (migration). This is the
  §14 release-schedule item, fleshed out.
- **Per-format preset expectations.** Long vs Short each ship with default
  targets / cadence / release-plan that we tune as we learn what performs. Data-
  driven, editable defaults.
- **Derived-shorts channel at creation.** In the wizard, an option to create a
  short-form channel from an existing **long-form** channel's off-cuts (reuse the
  long content, cut + post as shorts on a LINKED companion channel). This is §6 —
  surface it as a creation-time choice.
- **Editable charter targets — HIGH.** After creation the charter objectives are
  **read-only text** on the Plan tab (`page.tsx:267-271`). Make them editable
  (sliders/inputs) and persisted. Consider a **structured** targets model (subs,
  watch-hours, timeframe) instead of only free-form strings, so they can render
  as sliders and drive alerts/guardrails.
- **Why "10k subs / 4000 watch hours / 12 months"? → research better targets.**
  That text is **AI-generated** by the charter drafter (`proposeCharter`,
  `charter.ts`), not hardcoded — the model defaulted conservative (4000h = the
  YouTube Partner Program monetisation threshold). We want **research-backed,
  more aggressive targets tuned for monetary return** (RPM by niche, watch-time
  economics, subs-vs-views, Shorts vs long monetisation, time-to-monetisation),
  fed into the charter drafter's prompt + the per-format presets. → a deep-research
  task.
- **Plan/research live feedback + auto-populate — HIGH.** "Plan / research now"
  fires an async Inngest event then `revalidatePath` **immediately** (before the
  worker produces anything, `editorial-actions.ts:242`), so the operator sees no
  change and must hard-refresh to see results. Add (a) an in-flight
  "researching…" progress state, and (b) auto-refresh/poll (or push) so
  series/episodes/claims populate live. Core of the §14 live-status theme; the
  worker runs in a separate process and can't revalidate the cockpit, so this
  needs client polling or an event/status the page reads.
- **Ideas as top-level nav.** Ideas is currently reached via a link inside
  Review; promote it to a first-class nav item.
- **Talk-to-the-agent on the plan/charter.** Once a plan is populated there's no
  way to converse with the agent to change it. Add an embedded assistant on the
  Plan/charter view (like the wizard co-pilot) to edit plan/charter/objectives
  conversationally. Extends §14 embedded-assistant.

## 18. Third live walkthrough — first watchable long-form + engagement upgrades (2026-07-08 evening)

Found driving a real aviation long-form (Hangar Histories) end-to-end to the
first **watchable, operator-approved** video (as a test). Sourcing, voice, media
serving, and the Plan tab got fixed along the way; the open items are mostly about
**visual engagement** (stills sit too long → boring) and **proving publish/
schedule**. Suggested build order in `HANDOFF.md` (2026-07-08 evening).

**SHIPPED 2026-07-09 (facts-gate, commit `a027239`):**
- **Facts-gate — "no full scripts on 1 fact"** (next-up #1). Per-channel
  `verificationBar.minFactsToScript` (jsonb, optional → no migration; code
  defaults to 3 via `minFactsToScript()`/`DEFAULT_MIN_FACTS_TO_SCRIPT` in
  `@ytauto/core`). Enforced on ONE shared threshold at two points:
  `episode-research` **write-brief** cuts an episode (distinct decision reason)
  when usable verified/attributed claims `< bar` — never mints an idea for an
  under-researched episode; the `production-pipeline` **factuality gate** is the
  `on_hold` backstop for any production regardless of origin (bar recorded in the
  `factuality_check` evidence row). Operator-tunable in the charter **wizard** +
  **Settings & DNA** form (deep research depth pre-fills 4). Writer-constraint
  side was already in place (VERIFIED FACTS prompt block + expand-loop no-new-claims
  rule + review-board compliance checker; attributed facts already flow to both).
  Unit-tested (`minFactsToScript` helper); typecheck + build + full unit suite green.
  **Remaining:** not yet exercised E2E through Inngest on the live stack (verify
  next run that an under-supported episode is cut / a real production holds).

**SHIPPED 2026-07-08 evening (all on `main`):**
- **Tavily research connector** (commit `7f194f7`) — `SearchProvider` +
  `createTavilySearchProvider`; `providers.search` selected when `TAVILY_API_KEY`
  set; `episode-research` gathers evidence via one Tavily advanced search (clean
  text from several independent domains) → the existing extract/verify/corroborate;
  legacy discover-URLs+scrape stays as the fallback. **Verified live:** 7+ distinct
  domains (nasa.gov, faa.gov, historynet, flightlineweekly…) vs the old single
  `ntrs.nasa.gov`; first verified claim corroborated across **4–5 distinct domains**;
  ~$0.016/search. **EXA_API_KEY + PERPLEXITY_API_KEY** slots reserved (Research
  group on `/account`) for those connectors later.
- **Plan-tab rework** (`a303715`) — a top pipeline explainer (Plan → Research →
  Fact-check → Brief → Produce → Publish), **plain-English episode statuses** (no
  raw enums; `episodeStatusLabel`), the red "Verification cost" panel replaced by a
  compact **Research-health** strip (+ collapsible cut-facts with headers), and
  **click an episode → facts popup** (brief + verified/attributed/cut claims with
  source links, via new `loadEpisodeFactsAction`).
- **Stop/Restart research + concurrency cap** (`d7e7ecb`) — Plan-tab Stop/Restart
  buttons; `episode-research` capped to **3 concurrent per channel** (+ per-episode
  1) and cancels on `editorial/research.halt`.
- **OpenAI/GPT-5 structured-output fix** (`d710dfb`) — GPT-5 was 400ing on our zod
  schemas; wrapped the OpenAI model in the schema-sanitizer middleware like the
  other non-Anthropic vendors.
- **Media serving fix (STORE_DIR)** — the relative `./data/store` default resolved
  to *different* dirs for the worker (`apps/worker`) vs cockpit (`apps/cockpit`), so
  the cockpit 404'd all media (dead voiceover player + broken beat images). Moved the
  store to repo-root `data/store` and set `STORE_DIR` absolute; both serve now.
  (Local `.env` change — code default still needs hardening, below.)
- **Adam voice** — channel `voiceId` + global `ELEVENLABS_VOICE_ID` set to the
  premade Adam (`pNInz6obpgDQGcFmaJgB`).
- **First long-form video E2E** — force-forward → Adam voiceover (`multilingual_v2`,
  7:51) → reused images → Remotion render (303 MB) → final-review gate. Approved.

**Outstanding — visual engagement (HIGH; the main "boring" feedback):**
- **✅ Stills-too-long + rhythm cutting SHIPPED 2026-07-09 (`a622e69`, #4 cut 1).**
  `planShots` (@ytauto/core) sub-divides each beat into SHOTS cut on the spoken
  rhythm (sentence boundaries / audio pauses from the voiceover word timestamps),
  one image per shot → a fresh visual every few seconds. Lights up the Profile
  **rhythm** axis (sentence default / section = 1-per-beat / pause). Guards:
  MIN_SHOT_SEC 2s + MAX_SHOTS_PER_BEAT 4. Render unchanged (already one image per
  timed segment). Shot 0 keeps the beat's authored prompt + reference photo; later
  shots append their sentence for a distinct generated image. Verified: unit tests +
  Remotion still render (frame cuts between shot images at 1s vs 5s). **Covers:** "more
  images cycling", "one image per mini-section", and "rhythm / pause-aware cutting"
  below. **Cost note:** default `sentence` = more fal images/video; `section` opts back.
- **✅ Image relevance scoring SHIPPED 2026-07-09 (`ba68620`, #4 cut 2).** A vision
  model (`scoreImageFit`, cheap tier) looks at the actual pixels of a sourced Wikimedia
  reference image and scores whether it fits the shot; `!fits || score < IMAGE_FIT_MIN (5)`
  → discard → generate instead. Records fit score / rejection reason in asset meta; a
  scoring error fails safe (keep the reference). Verified live (Haiku 4.5 + real images):
  genuine Spitfire → 9 KEEP, banana → 0 REJECT; recalibrated the prompt after it
  false-rejected a clipped-wing Spitfire (reject only CLEAR mismatches, not variant
  quibbles). **#4 is now complete** (cut 1 shots + cut 2 scoring).
- **Background music layering.** Optionally layer a music bed under the voiceover
  (per-channel toggle; duck under speech). Needs a music source (licensed/generated)
  + a mix step in the render.
- **Higgsfield AI video (full or partial).** Add Higgsfield as an AI-video media
  provider (key slot + connector) to add MOTION — whole-video or **partial** (video
  on key beats, images elsewhere; partial keeps cost/latency sane). Gate behind the
  Production Profile.

**Outstanding — the unifying control plane:**
- **✅ Production Profile scaffold SHIPPED 2026-07-09 (`e44143d`).** Per-channel
  **Profile tab** — a tile-picker control dashboard (visual style · motion · rhythm ·
  captions · music · persona voice+delivery) with a live 9:16/16:9 preview, a recipe
  readout, and a rough $/episode + render estimate. Optional free-text **art direction**
  (steers the image model / reference selection) + general pipeline notes. Data:
  nullable `channel_dna.production_profile` jsonb (migration 0016), `ProductionProfile`
  type + `resolveProductionProfile()` in `@ytauto/core` (behaviour-preserving defaults;
  captions default ON for Shorts). Wires the orphaned **VoicePicker** into Persona; new
  channels seed a format-aware default. Each axis is a **scaffold seam** — options are
  tagged live vs `soon`; the choice is stored and the pipeline honours each axis as that
  feature ships. Design was operator-approved as a clickable prototype before porting.
  **Axes wired into the pipeline:** **captions** (`4c2d80a`), **visualMode** (`5748b12` —
  ai_images/ai_video force generation, real_footage/mixed keep reference-first), and
  **delivery** (`5748b12` — persona → ElevenLabs voice_settings via `deliveryVoiceSettings`),
  and **rhythm** (`a622e69` — `planShots` sub-divides beats into rhythm-cut shots).
  **Still read-but-waiting** (need unbuilt features): motion AI-video (#6 Higgsfield), music
  mix (#5). That's the per-feature work the
  scaffold now unblocks; wizard still seeds defaults (no in-wizard dashboard yet).
  **Runtime-verified 2026-07-09** on the local stack against the real Hangar Histories channel:
  tab renders (light + dark), long-form → 16:9 preview + captions default OFF, tile→preview
  reactivity, and the save round-trip persisted the exact selections to `production_profile`
  (0 console errors). Original spec below.
- **Production Profile — per-channel toggles that decide which tools run.** The
  operator wants toggles to fine-tune HOW a channel is made, which then selects the
  tools. Consolidates persona/voice/style into one profile:
  - **Visual style:** simple/stick-figure · real footage (Wikimedia) · AI images
    (fal) · AI video (Higgsfield) · mixed.
  - **Motion:** static images · AI video · video-on-key-beats-only (partial).
  - **Captions:** word-by-word burned-in (default ON for Shorts).
  - **Persona:** voice (premade/cloned) + delivery/expression — the "Persona section"
    (voice + how the person expresses) the operator asked for, in Settings & DNA AND
    the wizard. Subsumes #14/#16 per-channel voice. **Note:** the `VoicePicker`
    component EXISTS but is orphaned in the legacy manual form (`channel-form.tsx`) —
    it is NOT in the wizard or Settings & DNA, which is why channels default to the
    `"default"` placeholder. Wire it into the Profile.
  - **Rhythm:** cut visuals per sentence / section / pause.
  Each feature above becomes a toggle on the Profile rather than a bespoke feature —
  build the Profile scaffold once, plug the rest in.
- **Stick-figure / simple-explainer style (trending + cheap).** Simple, non-cinematic
  backgrounds are over-performing right now. Double win: a visual-style toggle AND an
  ideation bias (charter leans "simple explainer"). Cheap — a Remotion template /
  light line-art, skipping expensive image gen.

**Captions — ✅ SHIPPED 2026-07-09 (`4c2d80a`, first wired Profile axis).** The
karaoke word-by-word overlay (`packages/video/src/Captions.tsx`, fed by
`ShortProps.captions`) already existed but was **always-on**; it's now gated on the
per-channel `productionProfile.captions` flag (default ON for Shorts, OFF for
long-form). `buildShortProps` gained a `captions` arg; the pipeline resolves the
profile in load-context and threads `profile.captions` into the render. Verified via
unit test + Remotion still render (caption burns in when on, nothing when gated off).
(Overlaps #11 AEO caption-track upload — this is the on-screen burn.)

**Outstanding — publish/schedule proof + UX:**
- **Schedule bridge + calendar — ✅ SHIPPED 2026-07-09 (`b836d75`, #8).** Root cause
  found: a `publications` row was only written at UPLOAD time, so a "scheduled"
  production had no queryable row with a future date — the schedule was invisible and
  no calendar could exist; warm-up slotting also only ran for T2/T3. Fixed: nullable
  `publications.providerVideoId`/`url` (migration 0017); the pipeline creates the row at
  SCHEDULE time (future scheduledFor, null video) then updates it on upload/release;
  gated (T1) channels are auto-slotted onto the warm-up ramp at the final gate (using the
  channel's real format). New shared `ScheduleCalendar` (month grid, pills by format,
  daypart hints, click-a-day, channel filter) on the per-channel **Schedule tab** (with a
  plan→publish funnel + warm-up ramp) and a cross-channel **Overview Schedule tab**.
  Verified live: scheduled rows render on both calendars + the old "Upcoming scheduled"
  table now populates. Design operator-approved as a prototype first.
- **Remaining (#8): full worker-driven publish proof.** Code-verified but not yet driven
  end-to-end: approve final gate → scheduled row appears on the calendar → the sleep/quota
  path fires → mock upload + release → status published. Needs the worker + Inngest running
  and a production through the T1 gates (or a T2 auto channel). Real YouTube publish still
  needs the test channel connected (OAuth).

**Outstanding — voice / render / ops:**
- **v3 for long-form needs chunking. ✅ CHUNKING SHIPPED 2026-07-21 (`12ef09d`).**
  `eleven_v3` caps at 5000 chars; long scripts 400 with `text_too_long`. The TTS
  step used to synthesize the WHOLE script in one call — fixed: a script over
  `TTS_CHUNK_LIMIT` (4500) is split on sentence boundaries (`chunkText`,
  `apps/worker/src/voiceover.ts`, unit-tested) and synthesized in stitched pieces
  via the existing per-piece assembly + word-offset machinery (word timestamps stay
  a continuous stream); short scripts keep the single continuous call. This unblocks
  30–120 min videos on any model. (Default is still `eleven_turbo_v2_5`, whose cap
  is higher than v3's — the chunking is model-agnostic insurance.)
- **Long-form render speed (HIGH) → Remotion Lambda (operator-picked, 2026-07-10).**
  ~28 min for an 8-min/14k-frame video (Remotion, CPU `swangle`,
  `REMOTION_CONCURRENCY=2`). Decision: move renders to **Remotion Lambda** — fans a
  render across hundreds of AWS Lambdas, pay per render-second (~$0.10–0.30 per
  long-form, zero idle), 28 min → ~2–4 min. Lets the Render worker stay on the cheap
  starter plan (no big always-on render box; GPU doesn't help — Remotion is CPU-bound
  Chromium). Needs an AWS account + `@remotion/lambda` deploy (site + function), and
  the render step in the worker swapped to `renderMediaOnLambda` with output back to
  R2. **Operator: NEXT BIG TICKET once one video publishes to YouTube E2E** (that
  hurdle first).
- **Render reads images over worker HTTP (fragile).** `renderShort` points Remotion at
  `http://localhost:3010/store/...`; a stale/zombie worker serving the wrong store path
  404s → render dies (this session's failure mode). Have the render read bytes from the
  ObjectStore directly (or a stable file server) so it doesn't depend on the worker's
  HTTP endpoint + store path.
- **Failed force-forward dead-ends on idempotency.** `production-pipeline` idempotency
  is keyed on `productionId`, so a `failed` run can't be re-fired; recovery meant
  minting a fresh production. Add a retry path (new run id or idempotency reset).
- **STORE_DIR default is a footgun.** `?? "./data/store"` resolves per-CWD. Hardened
  locally via absolute STORE_DIR; codify: resolve to an absolute repo-anchored path
  and/or document "STORE_DIR must be an absolute shared path" in `docs/LOCAL.md` +
  `.env.example`.
- **File size OK, not a blocker.** 303 MB / 8 min is fine for YouTube (256 GB / 12 h
  limit). Optional CRF/h265 tuning to ~100–150 MB for faster uploads.
- **Local dev instability.** Editing worker-imported files triggers `tsx watch` reload
  → `EADDRINUSE` on :3010 → zombie workers serving stale code/store (root cause of the
  render 404 above). Mitigated by manual kill-port + clean restarts; a nicer dev story
  (kill-port on restart, or don't watch shared packages) would help.

---

## 19. Render migration + cockpit "live status" + AI scheduling (2026-07-09 evening)

### Render migration (IN FLIGHT — see HANDOFF.md "Render migration state")
Moving the whole platform OFF the DigitalOcean droplet ONTO **Render** (cockpit web +
worker web + Render Managed Postgres) + **Cloudflare R2** media + **Inngest Cloud**;
retire DigitalOcean. Decisions: fresh DB (no data migration). Repo was already built for
this (`render.yaml` blueprint + `DEPLOY.md`; the S3 store is R2-compatible as-is; the
cockpit media route streams from the store; the render's image loading is loopback-local
in the worker). **Done:** all three services green on Render from `main`; Inngest synced
(12 fns); R2 bucket `ytauto`; migrations applied; GitHub default branch → `main`; Render
MCP added (needs Claude restart + `/mcp` auth). **Remaining:** flip the worker to a
**Docker** service (native can't render — no Chromium), migrate the secret keys
(decrypt-local → re-encrypt-Render, needs the Render DB external URL), `PUBLIC_BASE_URL` +
YouTube OAuth redirect, confirm R2 `S3_*` on both services, smoke test, decommission droplet.

### Cockpit "live status" system (task #21) — ✅ SHIPPED 2026-07-10
Built as: `lib/status.ts` (status→kind mapping) + `StatusBadge` (components/ui) + the
per-production `ProductionStepper` (production page, artifact-aware for stopped runs) +
`StatusStrip`/`SystemStatus` (Overview + topbar, topbar polls `/api/status/summary`).
Live advancement rides the existing /api/live SSE → router.refresh() (BACKLOG #17).
Original ask, kept for reference:
Render-style status language across the platform so the operator always knows things are
**progressing and haven't silently halted** (their "info doesn't auto-populate / how do I
know it hasn't halted" pain). Pieces: a consistent **StatusBadge** (in-progress / scheduled
/ live / waiting-on-you / halted-failed); a **live per-production pipeline stepper** (script
→ voiceover → images → render → publish) that **advances without a refresh** — spinner on the
active stage, ✓ on done, red "Halted" + reason if it stops; a **portfolio system-status strip**
(N in production · N scheduled · N need you · N failed); and **client polling / auto-refresh**
(= the deferred "live polling" item). The cockpit has the raw pieces (stage counts, failure
badges, a live-pulse chip) — tie them into one live language.

### AI plan & auto-scheduling
On-page **AI chat** about the plan, and an **"AI review & schedule" button** that reads the
series + targets + channel state and slots ALL planned videos onto the calendar (produced or
not); a **cadence review** of the pipeline; and **at-risk flags** ("a slot publishes in <1
day but no produced video is ready"). The AI should also be able to tweak the warm-up / steady
schedule (via chat or automatically from analysis loops).

### IA cleanup + Profile/Schedule polish
- Move production-**timing** (the warm-up ramp / cadence) UNDER the Profile tab; strip anything
  the Profile tab covers OUT of Settings & DNA (dedupe — operator noted the Profile tab is much
  cleaner and Settings should defer to it).
- **Warm-up ramp** hogs space → compact to toggles + editable numbers on the right that lock the
  cycle, PLUS a **post-warm-up steady** setting (videos/month, hand-editable).
- **Schedule calendar** visual polish to the Profile-tab quality bar.
- Deferred perf: per-tab lazy loading (lower priority now on Render).

---

## 20. Platform polish pass — operator/AI dual-drive + declutter (2026-07-10, during Render smoke test)

Operator feedback while walking the new-channel → plan flow on Render: **"way too many
words"** — the wizard, charter review, and Plan tab are prose walls next to the clean,
tile-and-toggle Profile tab and reworked Overview. Elevate the whole platform to that bar.

### The ask
1. **Dramatic visual elevation** of the wordy surfaces — wizard steps, charter review,
   Plan tab (charter block, series arc, research health) — to Profile-tab quality:
   tile pickers, toggles, compact chips, progressive disclosure (details behind a click),
   no raw paragraph dumps. Use the bundled `ui-ux-pro-max` skill pack when building.
2. **Toggle-first controls**: anywhere the operator can change a setting, prefer a
   toggle/segmented/stepper control with an editable number over free-text/prose.
3. **Dual-drive model (the big one)**: the AI drives everything in the backend by
   default; the operator can question or tweak ANY decision inline; and the AI **sees
   operator shifts and adapts** (e.g. operator edits a target, drops the corroboration
   bar, re-orders episodes → the engine treats that as signal, doesn't overwrite it,
   and folds it into future decisions). Hand-holding early, autonomy later — the
   trust dial the charter's autonomy tier already implies, surfaced everywhere.

**✅ SHIPPED 2026-07-11 (batch 1 — design operator-approved as a clickable prototype
first).** New `components/ui` primitives (**Tile / Switch / Stepper / Disclosure**, on
/design-system). **Wizard** rebuilt: step 1 "Blueprint" = format art tiles (the derive-
Shorts dropdown folds into a linked-companion tile), rigor + autonomy tiles with one-
line consequences, monetisation Switch, release plan as Steppers beside a live ramp
chart with a first-month estimate, pinned CTA bar; step 2 identity cards lead with
avatar mark + collapsed concepts + inline re-roll; step 3 review = four summary cards
(Identity · Verification · Mission & objectives · Voice & style) with steppers/
switches/chips, DNA details behind "More", and live **"AI default" / "Your steer"**
chips (edits vs the AI proposal); step 4 = checkable provisioning list with copy
button. **Plan tab** rebuilt: one-line pipeline chip strip (paragraph behind ⓘ),
charter header card + chips, dual-drive steer strip, research health as 3 stat tiles +
proportion bar + cut-facts disclosure, series as progress cards with status pills and
compact episode rows (status dot + fact pills; facts popup kept). **Dual-drive
backend:** charter/objective edits now insert `operator_steer` decision rows (actor
operator) that `channelStateSummary` already feeds into planner/writer prompts —
verified E2E (edit bar in Settings → decision row lands). Wizard rigor default now
"standard" to match the bar-1 default. Smoke-tested on a real local stack (Postgres 16
+ pgvector, mock providers): full wizard walk → channel created → Plan tab, 18/18
assertions, screenshots light/dark desktop/390px, zero console errors.
**Still open (batch 2):** Briefings-tab elevation; Settings & DNA ↔ Profile dedupe
(#19 IA); steer recording for episode re-orders/cuts; operator tweak pass after
using it live.

### Quick default change (operator-decided, do first) — ✅ SHIPPED 2026-07-10
- **Corroboration bar default → 1 source** (was ≥2). On the aviation smoke-test channel
  the ≥2 bar cut 14/24 facts (58%) and the UI itself warned the bar was too high.
  Shipped: wizard preset standard=1 / deep=2 (was 2/3), charter-drafter prompt + schema
  hint updated, mock charter proposal updated. Existing channels keep their saved value
  (still editable in Settings & DNA → Charter).

### Pipeline ordering: factuality proof belongs in SCRIPTING (operator, 2026-07-10)
Observed live on the Render smoke test: the production generated the voiceover + 12
images, then went `on_hold` at the review-board compliance check ("script includes at
least one factual claim not directly supported by the VERIFIED FACTS"). That check runs
at assembly — after the asset spend. Move the factuality/claim-support proof into the
**scripting stage** with an automatic proof → rewrite loop (bounded retries, then
on_hold): a script never leaves scripting with unsupported claims, and assembly is
never the first place one is caught. (The script_review operator gate can then show
"factuality: passed" instead of gating on it late.)
**✅ SHIPPED 2026-07-10:** `proveScriptFactuality` (`packages/agents/src/factuality-proof.ts`,
agentic tier; `factualityProofSchema` in core) runs inside the scripting stage on
fact-constrained channels with a bounded proof → rewrite loop (`MAX_FACT_REWRITES = 2`;
rewrite notes list the unsupported claims); still failing → `on_hold` + a
`factuality_proof` evidence row (the standard triad) — all before any voiceover/image
spend. The script gate snapshot carries `factualityProof` and the gate panel shows a
"Factuality proof passed" chip; the review-board compliance checker stays as the
pre-render backstop. Not yet exercised E2E through Inngest — verify on the next run.

### Image lightbox (operator re-ask, 2026-07-10) — ✅ SHIPPED 2026-07-10
Images in the production/review UI aren't clickable — add a lightbox (click → full-size
popup, esc/click-out to close) everywhere pipeline images render (production page,
review gates, briefs). Was already the 2026-07-08 "expand-images lightbox" quick win.
Shipped: `ZoomImage`/`ZoomButton`/`Lightbox` (`components/ui/lightbox.tsx` + `.lightbox`
CSS) — beat visuals open full-size on click; thumbnail candidates at the final gate get
a hover expand button (click still selects). Screenshot pass still owed (the cloud
session couldn't run the stack).

### Force-forward semantics: skip the flag, don't re-run (operator, 2026-07-10)
"Force forward — override checks" currently re-runs from the current script and
REGENERATES media (the stepper visibly drops back to scripting/assets) — duplicate
ElevenLabs/FAL spend for assets that already exist. Expected semantics: waive the
specific failed check and resume from the halted stage (assembly), reusing existing
voiceover/images; regenerate only what's actually missing.
**✅ SHIPPED 2026-07-10:** force-forward now resumes the SAME production — no new row,
no media copy: it sets `bypassChecks`, expires stale gates, and re-fires
`production/greenlit` with a fresh `attempt` nonce (the pipeline idempotency key is now
productionId+attempt, which also fixes the #18 "failed run can't be re-fired"
dead-end); the pipeline's skip-if-present steps reuse every attached asset and only
missing ones are generated. Cockpit action + assistant tool + page copy updated.
Halt/Resume (mint-new-production) semantics unchanged.

### Archival-first imagery (operator, 2026-07-10) — tagging is the gap, not the order
Smoke-test data: channel visualMode=mixed so reference-first WAS active, but only 2 of
12 shots carried a `referenceEntity` → the other 10 went straight to fal generation
(and AI images arrive with garbled burned-in text). Three fixes:
1. **Shot planner: aggressive entity tagging for historical channels** — every shot
   should name the most photographable real entity it can (aircraft, person, place,
   era-scene), so the Wikimedia reference path fires on most shots; generation stays
   the backup/filler for abstract or connective shots (operator's requested order).
2. **No-text image prompts** — append "no text, no lettering, no typography" to
   generation prompts; the caption overlay owns on-screen text (kills the garbled-text
   artifact).
3. **fal image conditioning** — pass the sourced archival photo (or a channel style
   frame) as image-to-image / reference conditioning so generated shots are stylized
   variants of real references instead of from-scratch hallucinations. (fal supports
   this on several models.)

### Publish controls (operator, 2026-07-10, first-publish session)
- **Release button on a scheduled video crashes** — ✅ FIXED 2026-07-10 via the
  publishAt rework below: scheduled videos are now uploaded immediately, so
  "Publish now — skip the schedule" simply calls `release()` (flips public, overriding
  the pending publishAt) + shared `markPublicationLive` bookkeeping; the action returns
  `{ error }` instead of throwing (real messages in prod), and the button is hidden for
  legacy not-yet-uploaded rows. A reschedule control (datetime + "Move schedule", one
  videos.update) sits next to it on the production page.
- **OAuth scope fix (SHIPPED this session)** — the connect flow only requested
  `youtube.upload`/readonly scopes, so `videos.update` (Release) and
  `thumbnails.set` always 403'd. Added `youtube.force-ssl`. **Channels connected
  before the fix must RE-CONNECT** to grant the new scope.
- **Scheduler calendar: click video → popup with controls** — ✅ SHIPPED 2026-07-10.
  Clicking a video in the day-detail panel (channel Schedule tab + Overview calendar)
  opens a popup with **Publish now / Move schedule / Cancel schedule** + a link to the
  production page. No sleeping run to affect any more (publishAt rework): each action
  is one `videos.update`/release call that propagates straight to YouTube, and the
  platform calendar stays the source of truth. Cancel keeps the uploaded video private
  until an explicit release (`markScheduleCancelled`); the same three controls also sit
  on the production page. **YouTube→platform reconciliation shipped too:** the
  `publish-finalize` cron now reads each scheduled video's real status
  (`PublishProvider.videoStatus`, 1 quota unit) — went-public → marked live +
  post-publish events; Studio-side reschedule → `scheduled_for` follows; Studio-side
  cancel or deleted video → back to private-until-release; mock/read-error → time-based
  fallback. So Studio drift flows back, but the intended workflow is platform-first.
- **Timezone: Melbourne (AEST/AEDT), not UTC** — ✅ SHIPPED 2026-07-10. All cockpit
  timestamps render Australia/Melbourne (`DISPLAY_TZ` in `lib/format.ts`, overridable
  via `NEXT_PUBLIC_DISPLAY_TZ`): `fmtDateTime`/`fmtDate` are TZ-pinned, the schedule
  calendar buckets/labels days in Melbourne time, and every datetime input (final-gate
  schedule, Move-schedule on the production page + calendar popup) is interpreted as
  Melbourne wall time via `zonedInputToIso` (DST-correct, unit-verified across both
  AEDT boundaries; storage stays UTC). Also fixed a real bug: the final-gate schedule
  input used to be parsed by the SERVER in its own timezone (UTC on Render), so an
  18:00 entry meant 18:00 UTC = 4am Melbourne.

### Auto-release to public (operator, 2026-07-10)
Main productions always upload PRIVATE and wait for a manual Release click — no
code path flips them public automatically (derived Shorts clips already
auto-release). Add a per-channel **publish visibility** setting
(private-until-release | public-on-schedule), honoured by the pipeline's publish
step: when public-on-schedule, call `providers.publish.release()` right after
upload. Gate to T2/T3 autonomy tiers so assisted channels keep the manual
safety net. Requires the youtube.force-ssl scope (shipped 2026-07-10 — channels
connected earlier must re-connect).

### Use YouTube's native scheduler for releases (operator, 2026-07-10) — PREFERRED DIRECTION
Instead of the pipeline holding the video and sleeping until the slot (Inngest
sleepUntil → upload → release), upload IMMEDIATELY once final approval lands,
with `status.privacyStatus=private` + `status.publishAt=<slot>` — YouTube flips
it public at the scheduled time itself. Wins: no sleeping runs (no cancel/
duplicate-upload class of bugs — both bit us on 2026-07-10), reschedule = one
videos.update call (and visible/editable in Studio too), and the operator
principle "everything that leaves the platform is approved, so schedule = release"
holds. Supersedes parts of the publish-now/scheduler-popup items above: the
popup then edits publishAt via the API. Keep the platform calendar as the
source of truth; sync scheduled_for ↔ publishAt.

**✅ SHIPPED 2026-07-10 (cloud session):** the pipeline uploads IMMEDIATELY on final
approval with `status.publishAt` (privacy private) — no `sleepUntil` holds the video;
`publications.privacyStatus` gains a `scheduled` state (providerVideoId/url set,
publishedAt null) and a new `publish-finalize` cron (*/10) does the go-live bookkeeping
when the slot passes (marks public, production published, fires `production/published`
+ derive-shorts at ACTUAL publish time via the shared `markPublicationLive` helper in
core). `PublishProvider` gained `publishAt` on upload + a `schedule()` method (real
YouTube + mock); `publish-clip` (derived Shorts) uses the same native path. Reschedule
= `reschedulePublicationAction` (production-page control; the calendar click-popup is
still open — now ✅ shipped, see the scheduler-popup item above, along with cancel +
YouTube→platform reconciliation). Melbourne timezone display also ✅ shipped —
this block is now fully landed. Migration note: rows scheduled by the OLD sleep-based pipeline (privacyStatus
`private`, no video id) are untouched; their sleeping runs upload on wake with the new
code and publish immediately (operator releases manually). Not yet exercised E2E
through Inngest — verify on the next run.

## 21. Writing personas (versioned) + multi-model output quality (2026-07-11)

Operator direction, on top of the prompt audit (`docs/PROMPT-AUDIT.md`):
writing personas deployable consistently per channel by type, viewable in the
backend, AI may propose a TWEAKED persona version as a test (never silent
drift); and the platform must get good output from every model tier — Opus 4.8
is best but expensive.

### 21.1 Persona system (first-class, versioned)

- **`personas` table**: id, channelId (null = library archetype), name,
  version, parentId (lineage), status `draft|active|testing|retired`,
  createdBy `operator|agent`, and the doc itself:
  - `identity` — who is speaking: background, point of view, attitude (2–4 sentences)
  - `voiceRules` — register, rhythm, opinionatedness, "would never say" list
  - `lexicon` — favor/avoid words + phrases
  - `exemplars` — 2–3 short passages in the target voice (few-shot anchors;
    the single biggest consistency lever per the audit)
  - `deliveryDefault` — maps onto the existing Production Profile delivery axis
  - `ctaStyle`
- `channel_dna.activePersonaId` points at the live version; `productions`
  records personaId+version used (same provenance pattern as experimentId).
- **Library by channel type**: seed archetypes (Documentary Narrator,
  Enthusiast Expert, Contrarian Analyst, Storyteller, Explainer…) keyed by
  contentFormat + niche class; the charter wizard generates a channel-specific
  persona from archetype + niche + tone (frontier call, operator approves as a
  wizard step; classic form gets a picker).
- **Runtime**: scriptwriter system prompt rebuilt per the audit —
  Identity → Instructions → Exemplars → task mechanics (persona in the SYSTEM
  prompt, per-episode facts in the user prompt); the humanize pass rewrites
  "in THIS person's voice"; deliveryDefault feeds ElevenLabs settings.
- **Backend UI**: per-channel Persona tab (+ /personas library): active doc,
  version history with diffs, per-version usage + performance (join
  productions→analytics). Editing always creates a new version; activation
  flips the pointer; never mutate in place.
- **AI tweaks ride the EXISTING experiment machinery**: agent/briefing proposes
  `variable='persona'` → accepting creates persona v(n+1) draft
  (createdBy=agent) + an experiment whose directive = "use persona vN+1";
  experiment productions use the candidate, baseline stays on the active
  version; existing conclusion flow decides promote (activate) vs retire.
  One-active-experiment-per-channel constraint already enforces sanity; note
  n=3 samples make verdicts directional, not statistical.

### 21.2 Multi-model quality strategy

**STATUS 2026-07-13: 21.2.3 escalation slot + 21.2.5 eval harness SHIPPED**
(migration 0027). `LLM_MODEL_ESCALATION` is a strictly opt-in 4th tier slot on
/account Models (unset = aliases frontier = disabled); the production pipeline
redoes the draft ONCE on the escalation model when a script still fails its
factuality proof after the repair loop (draft→humanize→proof, steps
`*-v{n}-esc`), before holding. Eval harness: 6 frozen golden fixtures
(`packages/agents/src/eval/golden-set.ts` — Shorts+long-form ×
strict/balanced/entertainment), `eval-harness` Inngest fn runs
draft→humanize per candidate model (`createEvalLLM` swaps frontier+agentic to
the candidate) and measures with FIXED instruments: factuality proof + judge
(TASK:script-judge, base router, judge temp) + deterministic `aiTellMetrics`
in core (phrase counts, em-dash density, sentence-length stdev). Results in
`eval_runs`/`eval_results`/`eval_votes`; /account **Evals tab** = run form +
per-model quality/cost table + blind A/B voting (picks revealed after voting).
Eval spend lands under the `eval-harness` pseudo-channel in cost_records.
Fixtures are frozen — add, don't edit, or cross-run comparisons break.
NOT yet exercised against real providers — first real run doubles as the
Opus-vs-Sonnet-vs-Qwen A/B (run it from /account → Evals).
**VERIFY (operator, 2026-07-13): Chinese-model cells in the first real run.**
Models run in list order, so qwen/glm/kimi (positions 6-8) execute LAST —
mid-run they look untouched. When the run concludes, confirm their cells are
status ok (not error): qwen needs DASHSCOPE_API_KEY (migrated from droplet),
glm needs ZAI_API_KEY (migrated), kimi has NO direct key and must route via
OpenRouter (openrouter:moonshotai/kimi-k2-turbo-preview). Any error rows →
check the stored error text on eval_results.

1. **Model-agnostic prompt structure**: explicit prescriptive prompts +
   persona exemplars serve BOTH frontier and cheap models (verified guidance:
   cheap models need explicit instructions; frontier models tolerate them).
2. **The chain lifts weaker models**: draft → humanize/editor pass →
   factuality proof lets a Sonnet-5/Qwen draft approach Opus single-pass
   quality at ~1/5 the cost (vendor-canonical self-correction chaining).
3. **Escalation routing — pay Opus only on failure**: draft on the configured
   frontier tier; if the humanize critic or board-quality fails twice, redo
   once on `LLM_MODEL_ESCALATION` (Opus 4.8). New optional tier slot on
   /account Models tab.
4. **Cost reality**: a script call ≈ $0.20 Opus / ~$0.04 Sonnet vs images+
   voiceover dominating per-video cost — Opus-for-scripts-only is affordable;
   keep bulk tasks (ideation, meta-analysis, summaries) on cheap.
5. **Own-content eval harness**: golden set (~6 idea+facts fixtures) run
   through the script chain per candidate model; judge rubric (fact
   compliance, AI-tell density, hook strength) + operator blind A/B page;
   per-model quality/cost table surfaced on /account Models tab. Re-run when
   a new model drops — routing by evidence, not vibes.

Sequencing: personas (21.1) land WITH audit seams 1–2 (humanize pass +
system-prompt restructure) since they share the scriptwriter surgery; eval
harness (21.2.5) lands with the smoke tests from the audit §6.

### 21.3 Per-channel factuality tolerance — conjecture is content (2026-07-11)

Operator: not all channels are historical/factual — some are fun/engaging; the
verification bar was cutting most stories; and even history has unknowns where
conjecture is legitimate. Root cause in code: `decideClaimStatus`
(`packages/core/src/editorial.ts:163`) is binary — under-corroborated
established claims are CUT (there is no "unknown but tellable" disposition),
and `minFactsToScript` cuts whole episodes. #20 already lowered the
corroboration default to 1; this is the structural fix.

- **`verificationBar.factualityMode: 'strict' | 'balanced' | 'entertainment'`**
  (charter wizard picks from channel intent; operator dial in Settings & DNA
  next to minFactsToScript):
  - `strict` (science/finance/news): current behavior — cut unsupported
    claims, cut thin episodes, factuality proof hard-gates.
  - `balanced` (history/mystery — most channels): **a new claim disposition
    `conjecture`** replaces "cut" for plausible-but-uncorroborated material.
    Conjecture MUST be framed as such in the script ("historians still
    debate…", "according to legend…", "no one knows why…"). Episodes are cut
    only when even attributable/conjecture material is thin. Unknowns are
    retention gold — "no one knows" is a hook, not a defect.
  - `entertainment` (fun/engaging): research feeds color and ideas; nothing
    is cut for lack of corroboration; no minFacts gate. Platform-safety and
    forbidden-topics checks still run (they are orthogonal to rigor).
- **Mode-aware factuality proof**: strict = support check (current);
  balanced = FRAMING check — fail only claims asserted as established fact
  without support OR conjecture stated unhedged; entertainment = harm check
  only (false checkable real-world claims that could mislead; the safety
  checker remains the backstop).
- **Scriptwriter prompt by mode**: strict = VERIFIED FACTS only (current);
  balanced = VERIFIED FACTS + CONJECTURE list with framing rules (and the
  freedom to lean into mystery); entertainment = facts are inspiration, not
  constraints.
- **Review-board compliance checker** gets the same mode switch.
- **Persona tie-in (21.1)**: fun-channel personas carry voiceRules that
  embrace speculation and playfulness; strict personas stay measured.
- Migration: existing channels default to `balanced` EXCEPT where charter
  researchDepth = deep → `strict`, and the operator can flip any channel.

### 21.4 Channel setup proposes persona + factuality mode (2026-07-11)

Operator: when determining the account/channel, the AI should consider all of
the above and propose what WORKS for that channel — not inherit defaults.

- **Charter proposal** (`TASK:charter`) gains two reasoned outputs:
  `factualityMode` (21.3) and a recommended persona archetype + generated
  persona draft (21.1), each with a one-line rationale tied to niche + intent
  ("aviation mysteries → balanced: the unknowns ARE the stories; documentary
  narrator persona with measured awe"). Wizard shows both as editable steps —
  operator approves or overrides before create.
- The same reasoning applies at IDEATION/planning time: series planner and
  ideation prompts receive the mode ("lean into unsolved questions" on
  balanced; "prioritize fun/surprise over completeness" on entertainment), so
  the channel's whole editorial slant matches its rigor setting, not just its
  gates.
- Wizard assistant (`TASK:wizard`) patch schema gains factualityMode +
  personaArchetype so the co-pilot can adjust them conversationally.

### 21.5 Post-publish learning loop — channel playbook, decisioning, trial queue (2026-07-11)

**STATUS 2026-07-13: 21.5 + 21.6 SHIPPED (096c827, migrations 0028+0029).**
channel_playbook (trial→adopted→retired, evidence+confidence; adopted top-6
injected into scriptwriter/ideation/scoring as CHANNEL PLAYBOOK block;
hierarchy facts > own evidence > market stated at every grounding site);
channel-retro Inngest fn (maturity cadence warming=observe-only /
establishing 28d / established 14d; ≥3-matured-video evidence ENFORCED IN
CODE via validateRetroProposal; T0/1 propose, T2/3 auto-adopt);
performance windows (short 14d retention / 28d views; long 21/42);
experiments.priority queue auto-starts next on T2/3 conclusion; WINS graduate
to the playbook (origin=experiment). Playbook panel on the channel Analytics
tab (+ Run retro now). Adoption will stay empty until ~3 videos mature
(early August on current pace) — the retro observes and logs until then.

Operator: channel performance must feed new scripts/videos; market intel may
INFLUENCE but never OVERRIDE a video's content; true channel-level decisioning
on small improvements when something demonstrably works; and trialling new
ideas to measure impact over time. Today the loop half-exists (hook/script
analyses → pattern store → prompt grounding lines; performance one-liner in
ideation; briefings propose one experiment) but nothing DECIDES and nothing
persists learned improvements.

- **Channel playbook (new table `channel_playbook`)**: small standing
  directives learned from evidence — "open cold, no greeting", "keep beats
  under 12s", "end on an open question". Fields: directive, scope
  (hook/pacing/structure/visual/topic), origin (analysis|experiment|operator),
  status `trial → adopted → retired`, evidence links (video ids + metric
  deltas), adoptedAt. Adopted entries (capped ~top 6, by evidence strength)
  are injected into the scriptwriter/ideation prompts as a CHANNEL PLAYBOOK
  block with the WHY attached, so the writer applies them with intent.
- **Channel retro agent (the decision engine)**: after each analytics-ingest
  batch (or every N published videos), reads recent hook/script analyses +
  performance vs channel baseline and decides: (a) propose/adopt playbook
  entries when a pattern repeats across ≥N videos (small improvements — the
  "true decisioning"); (b) queue experiment candidates for bigger swings;
  (c) retire playbook entries whose evidence decays. Autonomy-tier gated:
  T0/T1 → proposals surface in the briefing for operator approval; T2/T3 →
  auto-adopt with a decision-ledger row. Every adopt/retire writes evidence.
- **Experiment queue**: keep the one-active-per-channel constraint (clean
  attribution) but add a prioritized queue of proposed trials; when the
  active experiment concludes, the next starts automatically (tier-gated).
  Win → playbook adoption (the experiment's directive becomes a standing
  entry); loss → retired with the ledger recording what was learned. This is
  "trialling new ideas over time" as a continuous background process.
- **Influence hierarchy (make precedence explicit in every generation
  prompt)**: (1) VERIFIED FACTS / brief = the video's content, inviolable;
  (2) channel's OWN evidence (playbook + performance) steers style/structure;
  (3) market/niche patterns are SHAPE suggestions only — and when own-channel
  evidence conflicts with market patterns, own evidence wins. Rewrite the
  pattern-grounding preamble lines (ideation/scriptwriter/scoring/board) to
  state this hierarchy instead of today's flat "bias toward these".
- **Honesty guards**: minimum sample (e.g. ≥3 videos showing the same signal)
  before adoption; playbook entries carry confidence and decay (re-verified
  against rolling window); retro agent must distinguish "worked once" from
  "works repeatedly". Small-channel data is noisy — the ledger records the
  uncertainty, and trial status exists precisely so adoption is reversible.

### 21.6 Learning-loop timing — let videos perform before deciding (2026-07-11)

Operator: videos need time to perform — no changes a day or two after publish
on a warming channel; run 2–3 months initially, and change the cadence once
the channel is established.

- **Video performance windows**: a video's data only counts toward decisions
  once it is ≥N days old (default 14 for Shorts retention signals, 28+ for
  view/CTR conclusions; long-form longer). Analytics keep ingesting from day
  one — the gate is on USING the data, not collecting it. Retention-shape
  signals stabilise earlier than view counts and may use the shorter window.
- **Channel maturity phases** drive the retro agent's cadence:
  - `warming` (first ~8–12 weeks / until warm-up ramp completes + ≥12 videos
    with matured windows): OBSERVE ONLY — no playbook adoptions, no
    experiments started; the retro agent still logs candidate observations so
    nothing is lost, and briefings show "what we're seeing (not acting yet)".
  - `establishing`: quarterly-style retro (the 2–3 month initial run) — first
    playbook adoptions from accumulated evidence; experiments allowed, sized
    to cadence (an experiment concludes only when EACH of its videos has a
    matured window — replaces today's "has analytics" bar).
  - `established` (baseline stable, e.g. ≥25 matured videos): retro cadence
    tightens (monthly → biweekly at operator's option); experiment queue runs
    continuously.
  - Phase is computed (channel age, published count, matured-video count,
    baseline variance) but operator-overridable per channel.
- Guard in code, not just prompts: the retro agent's input query EXCLUDES
  unmatured videos, so a hot day-one video cannot trigger a playbook change;
  trend/market intel stays real-time (it informs IDEATION, which is exempt —
  timeliness is its point; the timing gates apply to self-evaluation).

### 21.7 Data retention + capacity alerts — keep what informs, expire spent fuel (2026-07-11)

Operator direction: think per-episode — raw research can expire (~30d); keep
scripts, what-we-said, analytics/performance. Verified in code before design:
`retrieveMemory` reads channel-scope chunks + ONLY the current episode's own
episode-scoped chunks — once an episode is published/cut its raw research is
never read again by anything. Coverage summaries (channel scope) are the
durable "what we spoke about", enough to avoid repeats AND to expand a touched
topic into a follow-up episode.

**Keep forever (drives future output / evaluation):**
- Approved script text + episode brief + coverage summaries (channel-scope
  memory chunks) — the "what we said" layer; substanceFingerprints (variation)
- analytics_snapshots, hook/script analyses — the learning loop's raw signal
  (21.6 maturity windows need months of history); pattern store; experiments;
  channel_decisions ledger; personas (versioned); playbook (21.5)
- cost_records + agent_actions METADATA (agent, tier, tokens, cost, duration)
  — unit economics; claims text+status (tiny; "have we asserted this before")

**Expire (weekly `data-janitor` cron, new Inngest fn):**
- Episode-scoped memory_chunks (research text + 1536-dim vectors — the #1
  storage driver): DELETE 30d after the episode reaches published/cut.
- agent_actions.output payloads (#2 driver — full LLM outputs as jsonb):
  NULL the payload after 90d, EXCEPT evidence-class rows (factuality_check/
  factuality_proof/variation_check/review_board/board_*/operator_override)
  which keep 1y as the compliance trail. Row + cost metadata stays forever.
- citations: trim snippet text after 90d (keep url/domain/title provenance).
- Superseded script drafts >30d (keep the approved + latest versions).
- Janitor logs deleted counts as an agent_actions row (auditable shrink).

**Capacity alerts (same cron; alerts system already exists):**
- Storage: `pg_database_size(current_database())` vs `DB_STORAGE_GB` env
  (default 10) → warning alert ≥70%, critical ≥85%, with "bump plan / add
  storage ($0.30/GB/mo)" guidance in the alert body.
- RAM proxy: pg_stat_database cache-hit ratio < 95% sustained → alert
  suggesting the next instance tier (vector index no longer fits in RAM).

**Done 2026-07-11:** live DB bumped basic_256mb → basic_1gb (~$20/mo, 1GB RAM,
~10GB storage) via API during the empty-prod window; render.yaml drift closed.

## 22. Market opportunities — cross-niche discovery feeding Ideas (2026-07-11, SHIPPED)

Operator: the Ideas tab was per-channel story ideas; it should surface MARKET
intelligence — new niches trending, channel topics rising, styles working.
Root cause: every intel path was keyed to EXISTING channels' niches (market-scan
iterated `channels.niche`, the patterns table has niche in its identity, all
ResearchProvider methods take a niche seed) — nothing could discover new
territory. Shipped:

- **ResearchProvider** gains optional niche-less methods: `trendCategories()`
  + `globalBreakoutChannels()` (vidIQ: `vidiq_trend_categories` /
  `vidiq_breakout_channels`, defensive payload parsing; deterministic mock).
- **`market_opportunities` table** (migration 0021): kind niche/topic/style,
  label+summary, wizard-ready suggestedNiche/Intent, momentum, evidence jsonb,
  status new→shortlisted/dismissed/actioned (dismissed never resurrected).
- **market-scan** gains a global `discover-opportunities` step (skipped for
  scoped requests): signals → `opportunity_scout` agent (TASK:opportunity,
  agentic — portfolio strategist; never proposes existing niches or known
  labels) → upsert with momentum/lastSeen bumps.
- **Ideas page → "Ideas & opportunities"**: three-column opportunity panels
  (New niches trending / Topic waves / Styles working now) with actions —
  **Start a channel →** (marks actioned + opens the wizard PRE-FILLED with
  niche/intent via query params), **Seed idea** (topic → chosen channel's
  inbox), Shortlist, Dismiss; story-ideas table below unchanged. "Run market
  scan" button on the page head.
- Verified live in mock: scan → 4 opportunities → UI renders → Start-a-channel
  prefills the wizard ("abandoned engineering" + intent). Migration 0021
  applies on deploy via the worker preDeploy hook.

## 23. Series scheduling, plan steering, niche intel, IA polish (operator, 2026-07-11 evening)

### 23.1 NOW — tentative series scheduling + gap-fill (operator continuing with the 12-part arc)
- On PLAN APPROVAL of a series (e.g. 12 episodes, 3 researched): **instantly
  tentatively schedule all episodes across the timeline** (calendar shows
  tentative slots derived from the release plan/cadence — a new lightweight
  "tentative" publication/slot state, visually distinct on both calendars).
- **Gap-fill on failure**: if an episode's production fails/is cut, the
  planner proposes a REPLACEMENT episode for that slot (research → gate) until
  the gap is filled — slots don't silently vanish.
- **Lock-in flow**: greenlit + produced + approved → slot flips tentative →
  locked → uploads with YouTube publishAt (existing #20 scheduler). Tentative
  slots never touch YouTube.
- **Research-ahead depth by format**: short-form channels research 6 episodes
  ahead (long-form stays 3). Wire into editorial-plan research-ahead constant.

### 23.2 NOW — operator steering on Plan
- The "Plan / research now" section gains a **steer comment box**: free-text
  direction ("lean into engine failures", "more human stories") stored as an
  operator steer (channel_decisions) and injected into the series planner +
  episode research prompts (same dual-drive pattern as charter edits #20).

### 23.3 NOW — per-channel Niche intel tab (maybe replaces/joins Analytics section)
- New channel tab "Niche intel": competitor market scan for THIS channel's
  niche — what's doing well, **tagged competing channels** (persist a
  competitor list; VidIQ competitors API exists), trending niche videos.
- **Cadence indicator/control at top** (how often the scan runs per channel —
  per-channel cron preference), intel retained **90 days**, scrollable feed.
- Click-to-act on any intel item: create a single video idea from it / borrow
  thumbnail style / borrow structure / add to an existing series / create a
  new series around it.
- Data: external_videos + patterns already exist; add per-channel competitor
  tags + a scan-cadence field + retention window (janitor #21.7 trims >90d).

### 23.4 NOW — IA polish
- **Color-coded channel tabs** by group: monitoring (Analytics, Niche intel,
  Briefings), production (Plan, Production, Videos, Schedule), settings
  (Profile, Persona, Settings & DNA, Costs?) — subtle accent per group.
- **Sidebar channels flyout**: hovering "Channels" pops a flyout listing all
  channels for direct jump.

### 23.5 NEXT BIGGER UPDATE — multi-season story architecture
- Series → SEASONS: plan whole arcs (e.g. chemistry, 6 seasons × 12 episodes,
  difficulty building season over season). Structured seasons with set
  episode counts; sequencing between seasons.
- **Comments everywhere**: operator comments per season (updates/changes),
  per idea, per story/episode — stored, surfaced to the planner/writer as
  steers (extends 23.2's mechanism).

### 23.6 BACKLOG — multi-account management
- View/manage which channels sit under which Google/email account (several
  accounts eventually): account entity, channel→account mapping, per-account
  OAuth token grouping on /account, filters in the channels list.

## 24. Archival-first imagery for historical channels + no-text generation (operator, 2026-07-11 first real video)

- **Too many AI images on a historical video.** Push real images much harder:
  (a) scriptwriter on historical/balanced channels should set referenceEntity
  for EVERY beat that plausibly has a real subject (people, machines, places,
  events, documents) — today it under-tags and everything untagged goes to fal;
  (b) topic-level archival fallback: when a beat has no entity, search Commons
  by topic keywords (not just canonical entity) before generating; (c) consider
  visualMode default real_footage for historical niches + a per-channel
  "archival-first" strength dial on the Profile tab; (d) surface the real/AI
  ratio per production so drift is visible. Extends #20's archival-first item.
- **Garbled text on AI images.** FLUX renders junk text when prompts imply
  printed/readable surfaces. No negative prompts exist (verified #21 research)
  → builder must (a) describe text-free surfaces positively ("clean unmarked
  metal", "plain fabric", "empty sky"), (b) never emit words like poster,
  sign, label, diagram, chart, document, newspaper unless the shot NEEDS
  rendered text (then quoted ≤3 words), (c) image-fit scorer already rejects
  text-heavy refs — add the same check for GENERATED images (vision scorer on
  generated output, regenerate once on text-junk detection). Prompt hardening
  shipped in the pending commit; scorer loop is the backlog part.

## 25. Pipeline run controls — halt-anything + per-step retry (operator, 2026-07-11 late)

- **Halt halts the CURRENT process, everywhere**: the Halt button must cancel
  the in-flight Inngest run immediately at ANY stage (today it's an
  idea-pool pull-back designed around gates; mid-step cancellation of a
  running render/scripting step should take effect on the next step boundary
  via cancelOn + a status check inside long steps).
- **Per-step retry ("redeploy") instead of restart-from-start**: each stage
  chip on the production page gets a retry affordance that re-runs THAT step
  onward (re-fire production/greenlit with a fresh attempt nonce is today's
  whole-run rescue; the asset-reuse short-circuits make it near-idempotent,
  but surface it as per-step buttons: "Retry from render", "Retry from
  visuals" — deleting that stage's assets when the operator wants a true
  regen of just that stage).
- **Clear stale failure_reason on resume/rescue** (found live): a re-fired
  run leaves the old failure text displayed while it works — clear it when a
  run (re)enters scripting, or render the chip from live status only.
- Context (this evening's incident): render-step retries were burned by two
  Lambda main-function timeouts + a deploy restart; the rescue required a
  manual event re-fire. Per-step retry + halt-current would have made this a
  two-click recovery.

**UPDATE 2026-07-15 (halt → push-back-and-edit, `690359d`/`f66bd54`/`dbf894a`):**
resuming a halted production used to reuse the kept script and SKIP the script
gate. Now it re-presents the kept script at `script_review` (reuses the seeded v1
row, skips only the drafting LLM steps) so the operator can EDIT or approve. New
Plan ⋯ action **"Resume production (keep the script)"** for halted episodes (vs
"Re-greenlight from the start" = fresh). `greenlit` + `voiceover_recording` now
count as in-production so a pushed-back video shows under In-production at SCRIPT
REVIEW instead of vanishing; the Videos tab hides halted/rejected attempts.

## 26. Real video footage — SHIPPED v1 2026-07-12 (hero shots)

v1 SHIPPED: licence-safe archival FOOTAGE on hero shots. Connector
(apps/worker/src/footage.ts) searches NASA video + Internet Archive (safe
gov/newsreel collections + PD/CC-licence-filtered broaden), downloads the
smallest derivative, ffmpeg-trims a beat-length silent clip scaled to the
aspect, stores a video_clip asset (migration 0026) idx-aligned with the
image. Remotion Beat renders <OffthreadVideo> (muted) when a clip exists,
else the still. GATED opt-in: visualMode real_footage/mixed AND motion !=
static AND heroShot — dormant until the operator turns motion on (Profile
tab); the clip is part of the visuals-review gate, credited in the
description alongside stills, and a miss silently keeps the still.
REMAINING (v2, backlogged): shot planner still-vs-clip per NON-hero beat;
vision fit-gate on clips (currently entity-search relevance only — WATCH
the first footage render at the visuals gate); footage swap/regenerate in
the visuals grid; motion axis "partial" semantics; Pexels/stock connector.

**UPDATE 2026-07-15 (AI animation now actually works, `be8c7d2`):** "Key beats"
never produced clips because i2v vendors cap at 10s but the "fewest images"
rhythm made ~22s shots (`planMotion` kept them as stills). When a video animates
(motion≠static) shots are now capped ~9s via a shared `shotPlanOptions` used by
the render, the after-the-fact Animate path, and the cockpit estimate (so indices
line up). New `writeMotionPrompt` vision agent writes the i2v prompt from the
actual frame + shot context (used by Key beats and the manual Animate button;
falls back to the fixed template). Pexels stock-clip connector already present;
motion "partial" (Key beats) semantics now exercised.

## 26.0 (original) First real video review — footage, sync, captions, pacing, image quality (operator, 2026-07-11 night)

Operator's review of the first end-to-end video (Wings & Stories, jet engine):

- **REAL VIDEO FOOTAGE (headline ask)**: pull in actual footage (jets flying)
  and embed it in productions — real footage would elevate the video.
  Design directions: (a) stock/archival VIDEO connector (Pexels/Pixabay/
  Internet Archive/NASA — licence-safe, same attribution pattern as Wikimedia
  stills), (b) new asset kind "video_clip" + Remotion <OffthreadVideo> beat
  variant, (c) shot planner decides still vs clip per beat (visualMode/motion
  axes finally get their real meaning), (d) reference-entity search extended
  to footage. Big feature — spec before build.
- **Shot/narration sync**: images feel timer-based, not rhythm-aligned; many
  images don't match what's being spoken. Investigate: planShots uses real
  word timestamps, so alignment mechanics exist — likely the per-shot image
  PROMPTS (scene ideas) drift from the sentence content, and sub-shots reuse
  the beat prompt + appended sentence. Consider per-shot relevance scoring
  (vision) against the sentence, and stricter builder instruction to depict
  THE SENTENCE, not the beat theme.
- **Captions on long-form**: operator wants captions imposed going forward —
  flip the Production Profile default to ON for long-form too (currently ON
  only for Shorts); keep the per-channel toggle.
- **Speech pace**: narration a little slow — expose a pace/speed control on
  the persona/delivery axis (ElevenLabs voice settings or speed param), and
  consider persona-level default pace.
- **More real images** — reinforces #24 (archival-first): raise reference
  coverage before AI generation.
- **Evaluate image generators beyond fal/FLUX-schnell**: A/B flux/dev,
  recraft, Imagen, gpt-image for historical-photo fidelity; slot into the
  golden-set eval harness (#21.2.5) rather than switching blind.
- **BUG — thumbnail candidate can't be selected**: clicking a candidate at
  the thumbnail gate only opens the expand/lightbox; the SELECT action is
  unreachable on some candidates. Decouple: click = select, dedicated corner
  button = expand (or explicit Select button on each card).

## 27. Operator-recorded voiceover — direct audio, chunked per beat (operator, 2026-07-11)

**STATUS 2026-07-13: SHIPPED (4244280, migration 0030).** productions.voice_source
toggle ("Record my own voice" panel pre-assets); voiceover_recording gate pends
BEFORE any TTS spend; Recording booth = per-beat MediaRecorder (record/preview/
re-take/save/download/delete); takes = PERMANENT voiceover_take assets (voice-
clone source — janitor must never prune, delete keeps bytes); assembly
(apps/worker/src/voiceover.ts) normalizes takes + per-beat TTS fills to 44.1k
PCM → ffmpeg concat → one mp3; word timestamps via Whisper (OPENAI_API_KEY,
word granularity) or linear estimate; hybrid free (unrecorded beats TTS-fill);
reject gate → full TTS fallback. Downstream (shots/captions/render) untouched.
**NOT yet driven with a real microphone — dry-run on a test production first.**
Remaining: per-take waveform/trim, cloned-voice loop (record → clone →
persona voiceId), caption words from actual recorded text when Whisper drifts.

- Record voiceover DIRECTLY in the cockpit (browser mic capture), replacing or
  mixing with TTS for a production.
- **Chunked per section**: record each beat's text separately (script gate or a
  dedicated recording view shows one beat at a time with its text — record,
  re-take, accept per beat), so a flub only re-records that section.
- Pipeline: accepted takes upload as the beat's audio segments; assembly
  concatenates chunks (or aligns per-beat like the render already does),
  captions derive word timestamps from the recorded audio (whisper-style
  alignment instead of ElevenLabs char timings).
- Per-production voice source toggle: TTS (persona voice) | operator-recorded
  | hybrid (recorded intro, TTS body).

## 29. fal.ai image quality unacceptable (operator, 2026-07-12 — next two videos)

**UPDATE 2026-07-13: thumbnails now ALWAYS use nano-banana-pro** (`4187357`).
`quality:"hero"` used to route to nano only when `FAL_IMAGE_MODEL_HERO` was set;
unset → SILENT fallback to flux (prod cost_records confirmed video-1/Me-262
thumbs were flux). The hero model now DEFAULTS to `fal-ai/nano-banana-pro` in
code so thumbnails + hero beat shots can never drop to flux. Filler beat images
still use the standard model; the flux-vs-premium bake-off below is unchanged.

**INCIDENT 2026-07-15 (root cause of a channel-wide "stick figures / off-model"
regression):** the Google-direct hero model (fal retired) was pinned to
`gemini-3-pro-image-preview`, **retired by Google 2026-07-17**; in its final
window every hero call 429'd and the media factory **silently degraded to
qwen/fal**. Fixed: hero default → GA `gemini-3-pro-image` (`1d052f9`, env override
`GEMINI_IMAGE_MODEL_HERO`). Then the operator's key returned **429
RESOURCE_EXHAUSTED — depleted prepay credits**: added **`/api/diag/media`**
(`6f632cc`) to prove key/model/credit state live, and made the fallback LOUD (the
factory stamps the served engine; thumbnail generate/tweak warn when it isn't
Gemini — `1e9ce28`). **OPERATOR: top up AI Studio billing for YTAuto; confirm via
/api/diag/media (`heroTest.ok`).** Lesson: the silent multi-engine fallback masked
a billing outage for days — consider failing loud (or a health banner) rather than
degrading hero image quality invisibly.

- Operator: "getting the craziest things being produced... not worthy of being
  put up." Escalates #26's generator question from evaluate-later to urgent.
- **Mitigation applied**: FAL_IMAGE_MODEL was the provider default
  `fal-ai/flux/schnell` (fal's fastest/cheapest tier) since Lambda day one —
  env now set to `fal-ai/flux/dev` (activates on next worker deploy; ~$0.03 vs
  $0.003/image, ≈ +$2 per long-form video, major quality jump).
- Investigate whether the 2026-07-11 23:51 deploy's prompt changes (sentence-
  first sub-shots + aggressive builder rules) contributed — compare asset
  meta prompts before/after on the two bad videos.
- Then the proper fix: generator bake-off in the eval harness (flux/dev vs
  flux-1.1-pro vs recraft vs Imagen vs gpt-image) on historical-photo
  fidelity + prompt adherence; plus consider per-channel model choice on the
  Profile tab (hero shots premium model, filler cheaper).
- Interim guardrail already live: image-fit vision gate rejects wrong-subject
  refs; text-junk check catches garbled text — but neither judges AESTHETIC
  quality of generated images. Consider extending the vision check to a
  quality score with one regenerate on low scores.

## 30. Niche intel + market intel — REAL data + rich cards (operator, 2026-07-12) — SHIPPED + VidIQ pending

STATUS 2026-07-12: REAL data verified + rich UI SHIPPED.
- youtube backend (RESEARCH_PROVIDER=youtube, keyless) VERIFIED returning
  real videos/channels/keywords; velocity accuracy bug fixed (898a80c).
- Rich cards SHIPPED: niche intel feed + market "Scouted videos" now render
  16:9 YouTube thumbnails (keyless i.ytimg.com/vi/{id}/mqdefault.jpg from
  the video id parsed out of the stored URL), title/channel/views/velocity,
  click-thumbnail-or-title to watch. Make-idea / tag-competitor inline.
- KNOWN GAP the youtube backend can't fill: subscriber counts (0) + channel
  growth — NOT in search nodes.

**VidIQ TODO (operator + small code):** VidIQ backend already built and its
mapping VALIDATED against a live vidiq_trending_videos response 2026-07-12
(fields match VidiqTrending exactly; real subscriberCount IS present — fills
the gap above). To activate: (1) operator obtains a VidIQ API key with MCP
access and confirms the mcp.vidiq.com/mcp bearer-auth endpoint; (2) set
VIDIQ_API_KEY + RESEARCH_PROVIDER=vidiq on worker+cockpit. COST: ~5 credits
per trending/outlier call — a daily per-niche scan burns credits, so pair
with weekly cadence or a credit budget. requireAllTitleTerms=true already
set (validated: loose semantic query bled football into "aviation history").

## 30.orig Niche intel + market intel must show REAL channels/videos, richly (operator, 2026-07-12)

Operator (with screenshots): the intel tab shows channels that don't exist
("channel-154", "rising-aviation-11") and bare text video rows.

- **ROOT CAUSE (diagnosed)**: prod worker has no `RESEARCH_PROVIDER` env, so
  `selectResearchProvider` silently falls back to the MOCK research provider
  — every trending video / breakout channel on the intel + market tabs is
  fabricated (`channel-${fnv1a…}`). Real backends already exist:
  `RESEARCH_PROVIDER=vidiq` + `VIDIQ_API_KEY` (MCP, costs credits) or
  `RESEARCH_PROVIDER=youtube` (keyless). Step 0 is config, not code.
- **Never fake silently**: when the research provider is the mock, the intel
  UI must SAY so (a "sample data — connect a research provider" banner), not
  render fabricated channels as if real.
- **Rich competitor cards**: breakout/tagged competitors → real channel cards
  with avatar, name, subs/videos, linked to the channel (YouTube Data API
  channels.list enrichment where the backend doesn't supply it).
- **Rich video rows**: trending/outlier videos → thumbnail, title, channel,
  views + velocity, published-at, CLICKABLE to watch on YouTube (target
  _blank). Thumbnails via videos.list or i.ytimg.com/vi/{id}/mqdefault.jpg.
- Same treatment on BOTH surfaces: per-channel Niche intel tab (#23.3) and
  the cross-niche market opportunities feed (#22).
- Keep vidIQ credit frugality: enrich from the YouTube Data API (cheap/free
  quota) rather than extra vidIQ calls; cache channel avatars on the store.

## 31. Per-image swap controls + no repeated archival photos (operator, 2026-07-12) — SHIPPED same day; only 31.b remains

STATUS 2026-07-12 evening: everything below shipped (1c83591…f6037a2) and
was used live on the Me 262 re-run — plus extras beyond this spec:
reference-conditioned regeneration (nano /edit, flux /image-to-image, with
CC-BY(-SA) derivative credits carried), thumbnail regen with prompt+model
picker at the final gate, one-click duplicate sweep in the cockpit AND an
automatic dedupe-real-images step in the pipeline (every tier), and a
stale-render approve guard. Open: **31.b archive-source expansion** below.

- **Click any image in the production's visual section** → popup (existing
  lightbox grows controls) with:
  - **"Find another real photo"** — re-source: next archival candidate for
    the shot (skip every image already used in this production), fit-gate it,
    swap in place.
  - **"Regenerate (standard)"** — fal / FAL_IMAGE_MODEL from the shot's
    built prompt.
  - **"Regenerate (premium)"** — nano-banana-pro / FAL_IMAGE_MODEL_HERO,
    per-image operator escalation regardless of heroShot flag.
  - Swap updates the asset row + meta (provenance: operator_swap), and the
    render step picks the new file up on re-render (assets are keyed by idx).
- **DUPLICATE REAL IMAGES (bug, report from Me 262 run)**: every shot of a
  beat now inherits the beat's referenceEntity (2026-07-12 change), and the
  top Commons candidate (Wikipedia lead image) wins repeatedly → the same
  archival photo appears on multiple shots. Fix in the pipeline image step:
  track used source URLs per production; a candidate already used by another
  shot is skipped (the multi-candidate fetch already returns alternates in
  relevance order — take the next unused one); if every candidate is used,
  fall back to generation. Also vary: prefer a DIFFERENT candidate index per
  shot within the same beat so consecutive shots don't twin.

## 32. Script pacing polish — shorter spoken paragraphs (operator, 2026-07-12) — SHIPPED 2026-07-12

- Me 262 script: first-pass quality confirmed good + fast (no re-review
  loops — the memoized drafting + persona work paying off), but paragraphs
  ran a bit big. Tweak scriptwriter/humanize prompts toward 2–3 sentence
  breath-groups per paragraph; bonus: more natural sentence-rhythm cut
  points for the shot planner. Low-risk prompt change; verify on the next
  scripted episode.

### 31.b Archive-source expansion (operator, 2026-07-12 — "anywhere we can expand the search?")

STATUS 2026-07-12 late: **NASA image library SHIPPED** (keyless, public
domain, deep for aviation/aerospace — merged into entity+topic candidate
pools; an archive being down never blocks the others). LOC probed and
DEFERRED with findings: the photos JSON API returns access_restricted=true
+ 150px thumbs for the WWII-era German material we want — needs item-detail
fetches for full-res renditions and a rights filter before it's usable.
NARA (v2 catalog), Flickr Commons and Europeana all need (free) API keys —
wire behind env keys when wanted. RESEARCH_PROVIDER=youtube also set on
both services (real intel data for #30).

### 31.c Generalist resource layer — any topic, not just aviation (design, 2026-07-12)

- **Openverse SHIPPED same day** as the generalist backbone: keyless API
  over ~800M openly-licensed images (licence metadata included), integrated
  as a LAZY TOP-UP — queried only when the niche archives can't fill the
  candidate quota (preserves its anonymous rate budget for exactly the
  rare-subject cases). Optional registered OAuth creds later for 100x rate.
- **Source registry with niche affinities** (build with #26): each archive
  declares topic tags + licence model + still/video capability; the
  channel's NICHE picks which archives lead (aviation → NASA; medicine →
  Wellcome; natural history → BHL; art → Met open access; US military →
  NARA; European culture → Europeana; maps → Rumsey). Commons + Openverse +
  Internet Archive backfill everything.
- **Charter-time archive scouting**: reuse the scoutAuthoritativeDomains
  pattern — the wizard proposes the niche's best archives; keyless ones
  activate instantly, keyed ones surface on /account as "add this free key
  to unlock X". New niche = platform assembles its own supply chain.
- **TODO (operator, at laptop): Openverse API auth** — register a free
  OAuth app at https://api.openverse.org/v1/#tag/auth (client credentials),
  drop OPENVERSE_CLIENT_ID/OPENVERSE_CLIENT_SECRET on the worker+cockpit
  env. CODE side (small, do when keys exist): openverseSearch fetches a
  client-credentials token when the envs are present and sends it as
  Bearer — lifts the anonymous rate cap ~100x, at which point Openverse can
  join the ALWAYS-QUERIED pool instead of the lazy top-up.
- **Learning which sources deliver**: assets already record their source;
  once the #21 eval harness lands, rank archives by per-niche fit-rate and
  let the registry ordering learn from results instead of guesses.

- SHIPPED same day: per-shot candidate ROTATION (k-th shot of an entity
  starts at the k-th candidate) + hint-diversified Commons queries
  ("<entity> <shot visual brief>" searched before the plain entity) — kills
  most same-photo repetition within a production.
- REMAINING: additional licence-safe archives as ReferenceImageProvider
  backends, merged into the same candidate pool: NARA catalog API, Library
  of Congress (loc.gov JSON API), Flickr Commons (no known copyright),
  Europeana, Smithsonian Open Access. Aviation/military history coverage in
  NARA + LOC is far deeper than Commons alone. Same store/credit pattern;
  per-source licence mapping needed.


## 36. Claude-app MCP connector — ideate in Claude, act on the platform (operator, 2026-07-13)

**STATUS 2026-07-21: ✅ SHIPPED and greatly EXPANDED (prod `343878e`; see the
2026-07-21 HANDOFF).** The connector went from "ideate + create a channel" into a
full **direct-authoring control plane**: Claude authors the content and sets every
knob, the platform executes — and every creative LLM the platform would run is
replaced by what Claude wrote. Landed:
- **`/api/mcp`** streamable-HTTP JSON-RPC server (hand-rolled, no SDK), guarded by
  `MCP_BEARER_TOKEN` (token in the connector URL `?key=` — Claude's dialog has no
  static-token field), basic-auth-exempt. 23 tools; every mutation audited.
- **Read/intel + v1 act tools** as specced (`list_channels`, `get_channel_state`,
  `get_intel`, `get_playbook`, `get_eval_results`, `run_market_scan`, `seed_idea`,
  `propose_channel`, `create_channel`).
- **Direct authoring** (new): `author_script` (full script + image/motion prompts +
  per-video profile → seeded run that skips drafting/profile/image-prompt/motion-prompt
  LLMs via `productions.external_script`, migration 0046), `set_channel_config`,
  `create_series`, `write_idea`, plus `get_channel_config`/`list_ideas`/`list_series`/
  `list_productions`/`get_production`.
- **Gate driving**: `list_gates`/`get_gate`/`decide_gate` so Claude clears the same
  halts the operator would; per-channel **`autoApproveVisuals`/`autoApproveFinal`**
  (ProductionProfile, also toggles in the Profile tab) to auto-run once dialled in.
- **Help/ops**: `get_guide` (serves `docs/MCP-CLAUDE-GUIDE.md`), `get_diagnostics`
  (debug console), `report_issue`/`list_issues`/`resolve_issue` (the `agent_tickets`
  bridge, migration 0047) — `report_issue` also opens a **GitHub issue** (0048
  `github_url`) so the developer reads/answers directly.
- Also pulled in: **stock media libraries** (#7 — Pexels/Pixabay/Unsplash photos +
  Pexels/Pixabay/Coverr video) and **long-form TTS chunking** (#18) since Claude can
  now author 30–120 min scripts directly.
**Remaining:** the OWED live verification (authored E2E run, stock, long-form,
GitHub sync — needs a stack); fix the stale `yt-auto-platform.onrender.com`
hostname in CLAUDE.md/docs (real host is `ytauto-cockpit.onrender.com`).

**Operator ask:** "create a connection from the Claude app or desktop app
with a connector or MCP, to link to my platform so I could ideate with
Claude, and it could then fire off a create new channel."

- **MCP server endpoint on the cockpit** (e.g. `/api/mcp`, streamable-HTTP
  transport, bearer-token auth via a dedicated secret — NOT the operator
  basic-auth password; exempt the path from the basic-auth middleware and
  guard it with the token instead).
- **Tools (v1):** `list_channels`, `get_channel_state` (charter/plan/
  performance summary), `get_intel` (niche outliers + opportunities),
  `run_market_scan`, `seed_idea`, `propose_channel` (returns a draft charter
  via the existing proposeCharter agent), `create_channel` (drives
  createChannelWithCharterAction — incl. #35.1 styleExampleUrls), plus
  read-only `get_playbook` / `get_eval_results` as the insight layer grows.
- **Client side:** add as a custom connector in the Claude desktop/mobile
  app (remote MCP URL + bearer token) — then channel ideation happens in a
  normal Claude chat grounded in the platform's real intel, and "make it so"
  actually creates the channel (wizard provisioning checklist still manual).
- Reuses the assistant's runControl tool implementations where they exist;
  compliance: every MCP-invoked mutation logs a channel_decisions row with
  actor operator (the token IS the operator).

## 35. Visual style DNA — example-seeded styles, persistent characters, thumbnail intelligence (operator, 2026-07-13)

**Operator pain driving this:** auto-created thumbnails are consistently bad —
"I always recreate with nano" — and there is no way to bed down a channel's
LOOK so every video (and thumbnail) comes out consistent.

**STATUS 2026-07-15: 35.1/35.2/35.3 largely SHIPPED this arc.** Persistent
characters (35.2) live — `channel_characters` with `cast_mode`
(off/auto/25/50/75/always, migration 0037), deterministic per-shot casting,
verbatim canonical-description prefix + reference-sheet conditioning on Nano;
softened so the scene leads and the character is a participant, not the frame's
subject. Thumbnail Studio (35.3) shipped — format presets + title-as-text +
style/character refs + live prompt + click-to-Tweak (faithful edit), conditions
on the active style by default, character path mirrors the Style-tab injection;
Download per candidate; swap gallery also on the published-video page; failed
YouTube custom-thumbnail uploads surfaced (meta.applyError + banner). Style
conditioning (35.1) now applies to the Studio by default. **Blocked in prod on
Gemini AI Studio credits (429) — see #29.** REMAINING: whole-channel @handle
ingestion; per-SHOT visual-brief derivation (a beat spanning topics still leaks
one brief onto later shots — mitigated by narration-driven prompts + batching +
regenerate-from-narration, but the clean fix is a per-shot brief step); 35.4
title templates / 35.5 packaging strategist.

### 35.1 Example-seeded channel style (wizard + Profile)

**STATUS 2026-07-13: SHIPPED (migration 0032).** `visual_styles` (versioned
like personas, activation via channel_dna.active_style_id, provenance on
productions.styleId/styleVersion) + `visual_style_refs` (channel image pool:
uploads via /api/style-ref, YouTube video URLs via i.ytimg, promoted own
thumbnails via "Save to style refs"). `style_distiller` vision agent (one
multi-image pass, ≤8 refs) → structured doc (palette/lighting/composition/
subject/texture/typography/energy/promptSuffix) flowing into buildImagePrompts
(CHANNEL VISUAL STYLE block + verbatim suffix rule) AND buildThumbnailPrompts
(palette/typography defaults + suffix — closes the artDirection-never-reached-
thumbnails gap). Image conditioning: refs rotate deterministically into
generateImage referenceImageUrl (+ new tunable referenceStrength, style
default 0.45 vs the swap dialog's 0.8) — scope dial off/thumbnails/
thumbs_hero(default)/all_generated on the Style tab; degrades to prompts-only
without presignGet. Wizard-lite: "Style examples" URLs on the Review step →
ingest + distill + auto-activate v1 at creation (non-fatal). Channel Style
tab: ref pool, distill (+notes), version list, conditioning dials.
REMAINING: whole-channel @handle ingestion; conditioning strength tuning from
real runs; visuals-grid promote button; avatar/banner conditioning on refs.

- **At channel creation (and later on the Profile tab): inject visual
  examples** — upload thumbnails/frames the operator likes, OR point at other
  YouTube channels/videos whose style should be replicated (fetch their
  thumbnails via the keyless i.ytimg.com pattern already used by intel).
- **Style distillation → templates.** A vision pass over the examples
  distills a structured style doc (composition, palette, typography treatment,
  face/subject framing, energy) stored as `channel_style_refs` (files in the
  ObjectStore + the distilled doc on channel_dna, extending the existing
  free-text artDirection into structured, evidence-backed style DNA). The
  image-prompt builder + thumbnail prompts consume the doc; reference
  CONDITIONING (nano /edit, flux image-to-image — the machinery shipped in
  #31) uses the example images directly so generations are stylized variants
  of the bedded-down look, not from-scratch guesses.
- Templates are versioned like personas: edits create a new version, the
  active one is pinned, per-video provenance recorded.

### 35.2 Persistent characters (kids-ed mascots, recurring presenters)

**STATUS 2026-07-15: SHIPPED (migration 0037 `cast_mode`).** `channel_characters`
(name, role, canonical description + reference sheet, enabled), Style-tab creation
+ refine + test scenes; `cast_mode` off/auto/25/50/75/always drives deterministic
per-shot casting in the pipeline (verbatim description prefix + sheet at 0.55 on
Nano); the manual swap dialog can inject a character too. Scene leads, character
integrated (not the subject). Consistency "same character?" scorer mode still open.

- **`characters` table**: channelId, name, role, canonical reference images
  (multi-angle set in the store), style notes, voiceId (optional — a
  character can own a voice), status active/retired.
- **Wizard step / Profile section**: create a character at channel setup
  (generate candidates with the hero model → operator picks → that becomes
  the canonical set) or upload one. Children's-education channels get a
  channel mascot; any channel can keep recurring visual subjects consistent.
- **Pipeline wiring**: when a beat/script references a character (scriptwriter
  gains a `characterRef` per beat, like referenceEntity), image generation
  runs reference-conditioned on the canonical set (nano /edit multi-image,
  flux redux-style) so the SAME character renders across videos and
  thumbnails. Character appears in thumbnail prompts when flagged.
- Consistency check: the image-fit vision scorer gains a "same character?"
  mode comparing output to the canonical set; mismatch → regenerate.

### 35.3 Thumbnail intelligence — best-practice engine + outlier deconstruction

**STATUS 2026-07-13: SHIPPED (80107f3, migration 0031).** Pattern store gains
kind `thumbnail`; the intel deep-read vision-deconstructs each niche winner's
thumbnail (i.ytimg.com, free; runs BEFORE the transcript check so the
POT-blocked-transcript videos still contribute) into composition/subject/
text/palette/emotion patterns; buildThumbnailPrompts adds feed-size
legibility to every concept + a pattern-led 3rd candidate grounded on the
freshest winner; pre-gate regenerates any candidate scoring predictedCtr < 4
once with a bolder brief; thumbnails.meta records prompt/patterns/regenerated
provenance. VERIFIED live: first scoped scan wrote a real deconstructed
pattern within seconds. Remaining below (ruleset deep-research refinement,
VidIQ score_thumbnail as an extra gate) stay open; 35.1/35.2/35.4/35.5 not
started.

- **Dedicated thumbnail best-practice ruleset** (like #11's AEO rules): a
  standing, prompt-injectable block built from research — face+emotion
  close-ups, ≤3-word text, high contrast subject/bg separation, curiosity
  composition, mobile-size legibility. Deep-research task first, then bake
  into thumbnail prompt building (today's prompts are generic — root cause of
  "bad ones").
- **Outlier thumbnail deconstruction loop**: the intel scan already finds
  NEW videos with massive views (outliers, velocity). Add a vision pass over
  those winners' thumbnails (i.ytimg.com fetch, zero API cost): deconstruct
  composition/text/palette/emotion into `thumbnail_patterns` (pattern-store
  shape, niche+format tagged, freshness-decayed). Generation grounds on the
  top patterns for the channel's niche; the operator sees "built from these
  3 winning patterns" with the source videos linked.
- **Default the pipeline to the hero model for thumbnails** (operator
  already always regenerates with nano — stop generating the bad ones first;
  FAL_IMAGE_MODEL_HERO is live) + keep VidIQ `score_thumbnail` as a cheap
  pre-gate: score candidates, auto-regenerate the low scorers before the
  operator ever sees them.
- Feeds the #21 eval harness: thumbnail generation joins the golden-set
  bake-off (which model + which pattern grounding produces winners) and the
  learning loop (#21.5) closes it with real CTR once impressions data flows.

### 35.4 Title structure intelligence (operator, 2026-07-13)

- **Channels do well when titles share a consistent STRUCTURE** — a
  recognizable per-channel title formula ("The <Aircraft> That <Twist>",
  "Why <Subject> <Surprising Verb>") that compounds into brand recognition
  and lets a series read as a series in the feed.
- **`title_templates` per channel** (versioned like personas/style refs):
  2-4 active formulas with slot definitions + exemplars, seeded three ways —
  (a) distilled from the channel's own best performers, (b) deconstructed
  from niche outlier titles the intel scan already collects (same loop as
  the 35.3 thumbnail deconstruction — titles are free text, no vision cost),
  (c) operator-authored. Scriptwriter/metadata step generates titles INTO
  the active formulas; VidIQ `score_title` pre-gates candidates the same way
  score_thumbnail gates thumbnails.
- Consistency dial: formula-locked | formula-preferred | free — some
  channels win on uniformity, trend-reactive ones need latitude; the
  playbook/experiment rail (#21.5) measures which setting wins per channel.

### 35.5 Packaging strategist — the conversational layer over all of it

- **One AI the operator TALKS to about packaging strategy** — an engaging,
  conversational strategist (not another form) that lays out the channel's
  packaging system: proposes the style refs, character, thumbnail patterns
  and title formulas TOGETHER as a coherent identity, explains WHY each
  choice fits the niche ("kids-ed channels with a mascot hold returning
  viewers; here are 3 mascot directions"), and applies changes on approval.
- **Grounded in the insight we are accumulating**: pattern store (hooks,
  structures, thumbnail + title patterns), niche intel outliers, the channel
  playbook + experiment history (#21.5), eval results (#21.2.5), own
  analytics. The strategist cites its evidence — "channels in your niche
  doing X are pulling Y views/h" — from real rows, never vibes.
- Builds on the existing chat seams (wizard co-pilot, plan-tab
  channel-scoped chat + tools): add packaging tools (propose_style,
  create_character, set_title_templates, borrow_thumbnail_pattern) so the
  conversation can DO, not just advise. Surfaces at wizard time (initial
  packaging identity) and on the Profile tab (ongoing refinement as intel
  accrues).

## 34. Social media creation + cross-platform deployment (operator, 2026-07-13)

**Goal:** every piece of content the platform produces can be pushed to the
other social surfaces too — X, Instagram (Reels), Facebook (Reels/Pages),
Pinterest, LinkedIn, TikTok — with platform-native packaging, not blind
re-uploads. Extends #9's parked "cross-post shorts to the socials" note into a
real build. Per the #9 research verdict: this is DISTRIBUTION + funnel value
(each platform's own audience), not a YouTube ranking lever.

### Shape (reuses the spine)

- **`DistributionProvider` interface** (real + mock per platform, same pattern
  as PublishProvider): `publishPost({ kind: video|image|text, media, caption,
  link, scheduledFor })` per platform adapter. Mock-first so the whole flow
  runs with zero keys. API reality: X API (paid tiers), Meta Graph API
  (IG Reels + FB Reels/Pages — one app, review process), Pinterest API,
  LinkedIn API, TikTok Content Posting API — each needs its own OAuth app +
  per-channel token (reuse the secrets table + per-channel token pattern).
- **Per-channel social identity set.** `channel_social_accounts` table:
  platform, handle, OAuth token ref, status. Wizard/Settings gains a "Social
  accounts" section (connect per platform; provisioning stays manual like
  YouTube).
- **Derivation, platform-native.** A distribution step derives per-platform
  variants from existing assets — the Shorts vertical cut (already produced)
  for Reels/TikTok/X video; thumbnail + title + link as a Pinterest pin;
  script summary → X thread / LinkedIn post (LLM repackaging, persona-voiced,
  cheap tier); long-form → key-quote cards (image gen already exists).
- **Scheduling + volume.** Social pushes ride the publication's schedule
  (publish to socials when the YouTube video goes live, or staggered hours
  later); per-channel per-platform toggles + cadence caps in the Production
  Profile / release plan.
- **Tracked links (ties to #2).** Every cross-post carries a UTM'd link back
  to the YouTube video (or the owned property later); funnel conversion joins
  the analytics story.
- **Compliance.** AI-disclosure + credits rules apply per platform; the
  review-board/gate model extends: cross-posts inherit the production's
  approval (no new human gate on T2/T3, an operator toggle on T0/T1).

### Sequencing

Mock-first end-to-end (derive → schedule → mock-publish → cockpit "Distribution"
tab on the production page), then real adapters in order of API friction:
Pinterest/LinkedIn (simplest) → Meta (app review) → TikTok → X (paid API).
Prereq for real IG/FB: a Meta developer app + business verification — operator
step, backlog the runbook when we get there.

## 33. Visuals review gate — polish BEFORE the render (operator, 2026-07-12) — SHIPPED same day

Operator: "why would we have it render first, then review the inputs and
re-render again?" Right — every image polish cost a re-render. Gated (T0/
T1) channels now pend a visuals_review gate AFTER images + auto-dedupe and
BEFORE the render: the operator swaps/regenerates freely at zero render
cost, approves, and the video renders ONCE from the final set (the render
step re-reads live asset rows, so gate-time swaps always reach it). T2/T3
skip it. Migration 0025 (enum values). Reject → on_hold. The stale-render
guard remains the backstop for post-render changes at the final gate.

## 34. Free / royalty-free music library integration (operator, 2026-07-17)

Music candidates today are AI-generated (ElevenLabs Music, else a deterministic
placeholder bed) and picked per video in the production page's Music panel.
Operator asked whether we can also plug in a library of FREE / royalty-free
tracks to choose from. Plan: add a second `MusicProvider`-style source that
lists/searches a royalty-free catalog (e.g. a curated bundled set, or an API
like Free Music Archive / Pixabay Music / YouTube Audio Library exports) and
returns candidate tracks the operator can preview + pick with the SAME
`production_music` rows and Music-panel UI. Considerations: licence/attribution
metadata carried on each track (surface in the video description like image
credits), duration/looping to fit the voiceover, and a per-channel default
"source" (AI vs library). No pipeline changes needed beyond a catalog adapter —
the selection + render path already exist.

## 35. True sidechain music ducking (operator, 2026-07-17)

Background music today ducks against the voice with a **static** gain
(`MUSIC_VOLUMES = {off:0, subtle:0.03, standard:0.08}` in
`packages/core/src/production-profile.ts`; voiceover plays at full volume in the
Remotion `ShortComposition`). That keeps the bed under the narration but it does
NOT breathe — it stays the same level under speech and during pauses. Proper
**sidechain compression** would pull the music down only while the voice is
speaking and let it swell in the gaps (the "radio duck"), which sounds far more
professional. Options: (a) a Remotion-side per-frame volume envelope derived from
the voiceover's word timings (we already have `voiceoverWords` at render time — a
cheap approximation is "duck to X while a word is active, ease back to Y in
silence"); (b) do the mix in ffmpeg with `sidechaincompress` before/instead of the
Remotion `<Audio>` layer. Start with (a) — it needs no new binary and reuses data
we already pass to `buildShortProps`.

## 36. Stale-render UX — auto-offer re-render, don't just flag it (operator, 2026-07-17)

We now (a) never reuse a stale kept render and (b) show a "rendered without your
clips/music" banner with a one-click Retry from render. Two follow-ups: (i) when
the operator animates a clip or picks a track *after* a render already exists,
proactively surface the stale state at the final gate (and consider
auto-firing the re-render on approve, behind a per-channel toggle) rather than
relying on the operator noticing the banner; (ii) the media route still sets
`max-age=3600` and we defeat it per-URL with `?v=<updatedAt>` cache-busting —
consider dropping the render/clip `cache-control` to `no-cache` (or adding
ETag/If-None-Match) so even a hand-typed URL can't serve a stale cut.
