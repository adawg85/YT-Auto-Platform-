# Cockpit UI/UX review — full audit & remediation log

Reviewed against live screenshots of every page (light + dark, seeded with
realistic data: pending script/final gates, published video with analytics,
alerts, costs). Benchmarked against current dashboard best practice
(Linear/Stripe/Vercel-class operator tools: one button system, no raw enum
values, no ASCII/emoji glyphs in chrome, humanized dates, designed empty
states, consistent naming between nav and page titles).

Every issue below was fixed in this change; the "after" state is noted inline.

---

## 1. Cross-cutting problems (the "why it looks basic" list)

### 1.1 Two button systems — one designed, one browser-default
The single biggest source of the "crap buttons" impression. `.btn` (blue,
rounded, shadowed) exists, but most working buttons were bare `<button>`
elements with **no class at all** — rendered as native browser buttons
(gray bevel, tiny, wrong font) right next to styled ones:

- Ideas: `✨ Generate ideas — {channel}`, `Score`, `Greenlight ▶`
- Gates batch row: `✓` / `↻` / `✕` (unlabeled 20px glyph buttons)
- Gate panel: `✓ Approve` (native) next to a styled amber `↻ Revise` — three
  different button styles inside one decision panel
- Account: every `Save`, `Clear`
- Channel form: `Create channel` / `Save changes`
- Assistant: `Send`; Alerts: `⟳ Run analytics ingest now`, `Ack`
- Production: `🚀 Release to public`

**Fix:** one button system. Every interactive element now uses `.btn` with
exactly four variants (primary / ghost / success / warn / danger, plus `.sm`),
proper disabled and busy states, and inline SVG icons instead of glyphs.

### 1.2 ASCII arrows and emoji as UI (the "little arrows inside")
`▶ → ← ✓ ↻ ✕ ⟳ ✨ ⚡ 🚀 📝 🎬 🎉` were used as icons inside buttons, links
and headings ("See all →", "video →", "← back to gates", "Greenlight ▶",
"Nothing waiting. 🎉"). Emoji render differently per OS, ignore the color
system, and read as unfinished.

**Fix:** removed every one. Wireframe-style line icons (the existing icon set
the operator likes, extended with ~10 new glyphs) or plain text everywhere.

### 1.3 Raw database values leaking into the UI
`thumbnail_review`, `script_review`, `low_retention`, `comment_sentiment`,
lowercase `active/paused/greenlit/inbox`, cost categories `llm/voice/media`,
`production 00000000`, ISO timestamps (`2026-07-07 03:50`), 4-decimal money
everywhere (`$0.2446`).

**Fix:** a single label layer in `lib/format.ts` — `prodStatusLabel`,
`gateKindLabel`, `alertKindLabel`, `ideaStatusLabel`, `costCategoryLabel`,
`fmtMoney`, `fmtDateTime`, `fmtDate` — used by every page. No enum value or
raw ISO string renders anywhere anymore.

### 1.4 Real rendering bugs
- **Giant icons:** `IconSparkle` inside `panel-head h3` had no size constraint
  → rendered as a huge glyph above "What's working" / "Hook analysis" /
  "Script analysis" (looked like a broken loading spinner). Fixed with a CSS
  rule sizing all `.panel-head h3 svg`.
- **Broken tokens:** `GatePanel` and the account/settings alert cards used
  `var(--amber)` / `var(--red)` — tokens that don't exist (they're `--warn` /
  `--crit`). Result: harsh black borders around the most important surface in
  the product (the decision panel) and error text in the wrong color. Fixed.
- **Dead control:** the topbar bell button did nothing. It now links to
  Alerts.

### 1.5 Inconsistent naming between nav, breadcrumb and page titles
Sidebar says **Review**, crumb says **Review queue**, page says **Review
gates**. Nav says **Account & keys**, page says **Account · Provider keys**.
Crumb **Ideas** vs page **Idea backlog**; crumb **Costs** vs page **Unit
economics**. Each screen effectively renamed itself.

**Fix:** one name per surface, used in all three places: Overview, Channels,
Review, Ideas, Alerts, Costs, Assistant, Account & keys.

### 1.6 Undesigned empty states and loading feedback
Empty states were single muted sentences ("No messages yet.",
"Nothing waiting. 🎉"). Buttons gave no busy feedback beyond "…submitting".

**Fix:** proper empty states (icon tile + heading + one-line explanation +
the next action) on Review, Alerts, Assistant and tables; buttons disable and
show "Working…" while pending.

---

## 2. Page-by-page findings (all fixed)

### Overview
- "3 channels · aggregates across everything" → vague; now "Portfolio-wide
  performance across 3 channels".
- "See all →" arrow link → text link with chevron icon.
- Review-tab empty copy and 🎉 emoji removed; designed empty state.
- Channel card "PUB 7D" label → "posted 7d"; footer tier chip now shows the
  full tier badge (`T0 · Manual`).

### Channels (list)
- Bare `h1` + floating button; no page header pattern → now standard
  page-head (title, subtitle, primary action with icon).
- Status/autonomy shown as gray lowercase badges → status chips with dot
  (Active green / Paused amber), tier chips `T2 · Supervised`.
- "Productions" column → "In pipeline"; money → `fmtMoney`; rows link
  properly; empty state for zero channels.

### Ideas
- Title "Idea backlog" → "Ideas" (matches nav/crumb).
- The generate toolbar (one native emoji button *per channel* — scales
  terribly) → a single panel: channel picker + one "Generate ideas" primary
  button + "Scan trends" ghost button, with a caption explaining the fast
  lane.
- "Greenlight ▶" → primary small button with play icon; "Score" → ghost.
- Fast-lane ⚡ badge → chip with zap icon; statuses humanized; score shown as
  `8.2 / 10`; footer note rewritten ("watch progress in Review").

### Review (was "Review gates")
- Scripts section: batch decision row had unlabeled ✓/↻/✕ native buttons →
  labeled Approve / Revise / Reject small buttons with icons, styled notes
  field with clear placeholder ("Notes — required to request a revision").
- Final review table: added header row, humanized dates, "Review" →
  "Open review" ghost button with chevron.
- Empty state designed (check icon, "All clear", link to Ideas).

### Production detail / decision panel (the core surface)
- "📝 Script review — decision required" → clean panel header ("Script
  review · decision required") with icon, amber accent border that actually
  renders (was the black-border bug).
- Mixed native/styled decision buttons → Approve (green) / Request revision
  (amber) / Reject (danger), all labeled, all with icons, disabled+busy
  states.
- Thumbnail picker: raw radio circles + naked images → selectable cards with
  accent ring, hidden native radio, predicted-CTR chip per candidate.
- "🚀 Release to public" native button → primary button with upload icon and
  clear caption of what it does.
- `production 00000000 · cost $0.0780` meta line → tidy chips and formatted
  money; "← back to gates" → backlink chevron "Review queue"; gate history
  and cost tables humanized (Script review / LLM / ElevenLabs…), money
  right-aligned.
- Beat visuals now lay out in a wrapping row of fixed-ratio tiles.

### Alerts
- "⟳ Run analytics ingest now" → styled ghost button with refresh icon.
- "Ack" → "Acknowledge"; kind `low_retention` → "Low retention"; severity
  chips colored + capitalized; ISO timestamps → "7 Jul, 03:50"; "video →" →
  "View video" link; designed empty state.

### Costs
- Title "Unit economics" → "Costs" with subtitle; category columns humanized
  (LLM, Voice, Media…); all money right-aligned tabular numerals via
  `fmtMoney`; tables get the panel treatment.

### Account & keys
- Title unified with nav; the wall-of-text intro tightened to one sentence
  with a "How keys behave" callout.
- Key rows: headerless table → panels per provider group with a proper
  header row (Key / Status / Update), `Set ····abcd` vs "Not set" chips,
  styled Save/Remove buttons, humanized updated-at dates.
- Active adapters strip → labeled chips (Mock vs Live coloring).

### Assistant
- Raw transcript with "you/assistant" badges → chat bubbles (operator right,
  assistant left), suggestion chips that send real example commands, styled
  composer with send icon button, busy indicator, designed empty state.

### Channel detail
- Duplicate "Channel DNA" heading (tab section + form both) → single heading.
- "rev 1" → "revision 1"; scheduled dates humanized; connection chips
  capitalized ("Not connected"); Disconnect → ghost danger button.
- Settings form (also New channel): one undifferentiated 16-field column →
  two panels ("Channel" / "Channel DNA") with 2-col grid, numeric inputs are
  real `type="number"`, submit is a primary button, form capped at a readable
  max-width.

### Video detail
- Giant sparkle-icon bug fixed (see 1.4); dates humanized; "+0 pts vs
  channel" no longer renders when the delta is zero.

---

## 3. Design-system deltas (globals.css)

- `.btn` grew: `success`/`warn`/`danger` variants, `:disabled` (55% opacity,
  no pointer), `:active` press, focus ring; ghost variant used for all
  secondary actions. Legacy `button.secondary/.danger/.warn` kept as aliases
  so nothing regresses, but no page uses them anymore.
- `.panel-head h3 svg { width:16px; height:16px }` — kills the giant-icon
  class of bugs permanently.
- Numeric table cells: `td.r/th.r` right-aligned tabular numerals.
- Chat styles (`.chat`, `.bubble`), suggestion chips, thumbnail-picker cards
  (`.tpick`), empty-state tweaks, form `max-width`, section captions.
- No new dependencies; everything stays inline-SVG + CSS variables, and every
  change themes correctly in light and dark.
