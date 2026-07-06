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
  the long-form capability. A channel running both keeps two independent ramps
  on two dayparts.
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

**⏸ PARKED — needs a networked machine (not this cloud sandbox):** the live
research transports were never exercised because the sandbox blocks youtube.com
and vidIQ's endpoint. Mappers are unit-tested (vidIQ vs real captured responses)
and both adapters typecheck against the installed SDKs, but **first-run
smoke-testing on a networked machine is the open item** before either backend is
trusted in production. Steps are in `STATUS.md` → "Verify the new research
backends". Do `RESEARCH_PROVIDER=youtube` first (free, keyless). Until then the
platform runs on the deterministic mock (the default).

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

Pseudoscience-accuracy watch: ancient-civilisations / ancient-aliens style
niches pull high volume but attract pseudoscience and are competitive — skipped
in favour of the corroboratable picks above. **Operator picks #1 at channel
setup; that seeds the charter.**

### New capabilities / entities

- **Channel charter** (extends ChannelDNA): mission, objectives, audience,
  **content archetype** (evergreen-series | monitor/digest | reactive→#8),
  **format policy** (see #6), **source strategy**, **verification bar**, cadence
  targets. Created **interactively at channel setup** — the operator co-creates
  the idea + initial roadmap. Ghost-niche discovery can be an AI-assisted step
  (reuses the existing `ghostNiche` scoring axis).
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

---

## 6. Format modes + long-form → shorts derivation

**Goal:** channels differ in format, and it's per-channel policy — not global.

- **Format policy per channel:** `shorts-only` | `long-form-only` |
  `long-form + derived shorts`. (v1 is shorts-only.) Shorts-only suits fast/
  topical channels (a 60s take on an event); long-form suits deep evergreen.
- **Long-form-first master → derive N shorts** (a ~14-min video → ~15 shorts).
  Clip selection is itself a retention/hook problem the pattern store informs.
  The per-format warm-up ramps (build #3) already anticipate two formats.
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
