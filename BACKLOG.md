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

**Status:** design direction locked via a clickable HTML prototype
(`scratchpad/cockpit-redesign.html`, light-first + blue accent `#2867e5`,
both themes, headless-verified). Next step is porting the IA into the real
Next.js cockpit. The prototype resolves the two-level structure below.

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
tab + a scheduler behind it):

- **Warm-up ramp** (default, editable): Week 1 ≈ 3/wk → Week 2 ≈ 4/wk →
  Weeks 3–4 ≈ 5/wk → Weeks 5–6 = full cadence (e.g. 7/wk). Show progress
  (Week N of 6) and which slots are done / scheduled / open.
- **Front-load the backlog** so the ramp always has ready videos to draw from.
- **Never delete + re-upload** a video to "retry" it — that's a spam signal;
  enforce/warn in the scheduler.
- Trust signals worth surfacing/checking: phone-verified account, consistent
  cadence, no sudden volume spikes.
- Requires the Phase-3 scheduled-publishing rail (already present) plus a
  per-channel warm-up policy that caps how many uploads the scheduler will
  release per week during the ramp.

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
