# Backlog

Future builds, in spec-brief style. Each reuses the existing spine
(Channel → Idea → Score → Production → Assets → Publication → Analytics),
the provider-interface pattern (real + mock adapters), the review-gate
compliance model, and per-video cost accounting. New capability lands as new
providers + ChannelDNA extensions, not as parallel pipelines.

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
- **Derivation pipeline.** Master render on the long-form channel →
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
