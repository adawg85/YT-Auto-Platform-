# STYLE-GUIDE.md — the cockpit look, and how to keep it

One source of truth for how every cockpit surface should look and behave. If a
screen breaks a rule here, it's a bug — fix the screen, don't fork the system.
This sits above `UI-REVIEW.md` (a historical audit log) and the living
`/design-system` route (the component reference). **Read this before building
or changing any UI.**

Design language: **data-dense operator dashboard** — Linear / Stripe / Vercel
class. Calm, high-signal, scannable. Indigo accent, slate neutrals, status
colors carry meaning. Light + dark are co-equal; every rule must hold in both.

---

## 1. Non-negotiables (the "why it looks basic" list)

1. **One button system.** Every interactive control is `.btn` (or a `components/ui`
   primitive over it) — variants `primary | ghost | success | warn | danger`, plus
   `.sm`. Never a bare `<button>` (renders as a native gray browser button).
2. **No raw enum / ISO / raw money in the UI.** Route every value through
   `lib/format.ts` (`prodStatusLabel`, `gateKindLabel`, `costCategoryLabel`,
   `channelStatusLabel`, `fmtMoney`, `fmtDate`, `fmtDateTime`). No `thumbnail_review`,
   no `2026-07-13 03:50`, no `$0.0780`, no lowercase `llm/voice/media` in a header.
3. **No emoji or ASCII glyphs as icons.** Use `components/icons.tsx` (lucide-style
   line icons). Never `▶ → ✓ ✕ 🚀 ✨` in chrome.
4. **Semantic tokens only — never raw hex in a component.** Use the CSS variables
   below. A component with `#4f46e5` or `color:#fff` hardcoded is a bug.
5. **One name per surface** across nav, breadcrumb, and page title (Overview,
   Channels, Review, Ideas, Costs, Market intel, Assistant, Account & keys).
6. **Every empty state is designed** — icon + one-line explanation + the next
   action. Never a bare muted sentence, never `🎉`.

---

## 2. Tokens (from `globals.css` — light + dark defined together)

| Purpose | Token |
|---|---|
| Page background | `--ground` |
| Card / panel surface | `--surface`, raised `--surface-2` |
| Border / stronger border | `--border`, `--border-strong` |
| Text / secondary / muted | `--text`, `--text-2`, `--muted` |
| Accent (brand) | `--accent`, `--accent-2`, soft `--accent-soft`, ink `--accent-ink` |
| Status: good / warn / crit / info | `--good` / `--warn` / `--crit` / `--info` (+ `-soft` fills) |
| Radius | `--r` (12) · `--r-sm` (8) · `--r-xs` (6) |
| Shadow | `--shadow`, `--shadow-lg` |
| Fonts | `--sans` (Inter) · `--mono` (JetBrains Mono) |

Spacing rhythm: **4 / 8 / 12 / 16 / 24 / 32** (dashboard density). Section gaps 16;
card padding 14–16; KPI gap 14.

---

## 3. Data tables (the standard — the Costs table was the counter-example)

- Wrap in a `.panel`; table is `.data`, header row lives in `<thead>`.
- **Headers:** humanized labels (`costCategoryLabel(...)`), `text-transform` handled
  by the class — never render the raw enum.
- **Numbers:** right-aligned, tabular figures via the `.num` / `td.r` class
  (`font-variant-numeric: tabular-nums`) so columns don't jitter. Money through
  `fmtMoney` (2 dp, not 4).
- **Rows:** hover highlight (`--surface-2`), 1px `--border` dividers, comfortable
  row height (≥40px). Zebra optional, subtle if used.
- **Sortable tables** (e.g. the video performance strip): clickable headers with an
  `aria-sort` attribute and a direction caret; sort state is visible.
- **Empty:** a full-width designed empty state row, not a lone "No data".
- Wide tables scroll inside their own `overflow-x:auto` container — the page body
  never scrolls sideways.

## 4. Cards & panels

- `.panel` (header via `.panel-head h3` + optional right-side action) or `.kpi` for
  stat tiles. Panel-head icons are auto-sized (16px) — never a giant glyph.
- **Equal heights:** cards sharing a grid row stretch to match (`height:100%` on the
  grid children). Don't let a short card float above a tall neighbor.
- One primary CTA per screen; secondary actions are `ghost`.

## 5. Tabs & navigation

- Page-level tabs (`.ptabs` / `PageTabs`) run across the top of the content area,
  not the global nav. **The strip fits on desktop — no scroll affordance** unless it
  genuinely overflows (narrow mobile only).
- **Active tab is persisted in the URL** (`?tab=`), so a refresh / live-refresh /
  drag action never bounces you back to the first tab, and tabs are deep-linkable.
- The left sidebar is the only primary nav. Current location is always highlighted.

## 6. Interaction & motion

- Transitions 150–300ms, `transform`/`opacity` only (never width/height/top/left).
- Hover states on everything clickable + `cursor:pointer`; visible focus rings.
- Respect `prefers-reduced-motion`. Touch targets ≥44px; gate actions safe-area aware.

## 7. Responsive

- Verify **every** change in light + dark, at **desktop and 390px**. Screenshots in
  the PR/summary.
- Breakpoints already in use: **980px** (grid → 1 col, sidebar → drawer), **760px**.
  No horizontal page scroll at any width.

---

## 8. Enforcement

- New UI: build on `components/ui/*` + the tokens; check it against `/design-system`.
- Before pushing UI: `pnpm --filter @ytauto/cockpit typecheck` + `build`, and a
  light/dark × desktop/390px screenshot pass.
- Reviewing UI: run the `ui-ux-pro-max` skill; anything violating §1 is a blocker.
- When a surface drifts (like the Costs table did), fix it onto the standard in the
  same change — don't leave a second style alive.
