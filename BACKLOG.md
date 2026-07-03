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
