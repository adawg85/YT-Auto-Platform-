# ▶ Standing mode: ticket triage — READ FIRST

Most work here arrives as **`report_issue` tickets mirrored to GitHub issues
labelled `mcp-ticket`**. That open-issue list is the live work queue. To resume:
list OPEN `mcp-ticket` issues (newest first), then address them per the
**"Tickets — the triage loop"** section in `CLAUDE.md` (ground the fix in real
code → typecheck/build/test → docs-sync → land on `main` → post a `Resolution`
comment → **leave the issue OPEN for the operator to verify + close**, never
self-close; record deploy-gated work in `get_deferred_work`; default-off for any
live-behaviour change). New tools/fields need a **connector reconnect** to appear;
migrations apply on the worker `preDeploy`. There's no live YouTube API / prod DB
from the sandbox, so state that fixes are build/test-verified and the operator does
the live check. When the operator is away, poll the issue list periodically for new
tickets rather than ending the watch.

**Current queue state (session 5):** #28–#38 all SHIPPED to `main` and OPEN pending
the operator's live verification (connector reconnect + migrations `0056`–`0060`).
See `get_deferred_work` for what's shipped-pending-verification vs deferred.

**Chat-driven fixes (not report_issue tickets), also on `main`:**
- Persona tab reverted the selected voice before Save — the Voice & tone form wasn't
  under the `useRefreshHold` guard, so a LiveRefresh remounted it and re-seeded the
  picker from the old value. Fixed to mirror `production-profile-panel.tsx`
  (`persona-panel.tsx` + `voice-picker.tsx` gained an onChange).
- ElevenLabs voice MODEL is now selectable (operator asked for v3 + "both options").
  New `productionProfile.voiceModel` (turbo_v2_5 default / flash_v2_5 = ~$0.05/1k;
  multilingual_v2 / v3 = ~$0.10/1k, ~2×) threaded profile → pipeline → provider
  (`voice.ts` `resolveElevenModel` + per-model cost). v3 is alpha and may not return
  character alignment on /with-timestamps, so the provider falls back to
  `estimateWords` (2.5 wps) — captions/shots never break, but v3 sync is approximate
  until we wire ElevenLabs Forced Alignment (the accurate follow-up). Dropdown on the
  Production Profile panel; settable over MCP via set_channel_config/author_script.
  Default model unchanged (turbo v2.5), so existing channels are cost/behaviour-neutral.

- **#38 (`01KY5W4T…`, warn)** — per-shot regeneration + image-engine control. The
  cockpit already has per-shot Regenerate/Re-source buttons (`swapShotImageAction`), so
  this EXPOSES them over MCP rather than adding a new image path: `get_production_shots`
  (read: per-shot idx/narration/source/entity/engine/animated — also answers #30 item 6,
  reading `meta.narration` not the buggy `beats[idx]`) + `regenerate_shot(productionId,
  idx, {imagePrompt?/referenceEntity?/imageEngine?})` — a thin wrapper over
  `swapShotImageAction`. Scoped to `status === "visuals_review"` so the pending gate
  stays open (never auto-approves; no mid-flight Inngest resume). Cost appends via the
  provider. `imageEngine` (standard-still, default qwen) was ALREADY settable via
  `set_channel_config`/`author_script` productionProfile — confirmed + documented;
  Seedream id is env-pinned (`SEEDREAM_IMAGE_MODEL=dola-seedream-5-0-pro-260628`, tidied
  the stale `.env.example`). `get_production_costs` gains a `mediaByEngine` breakdown.
  Pure `regenShotMode`/`imageSourceKind` helpers + 3 tests. **Deferred:** a shared
  `generateShotImage` primitive refactor + per-beat imageEngine (noted, not needed).

- **#37 (`01KY4VVP…`, error)** — phantom publication records (two Bell X-1 rows
  `published` with a dead `providerVideoId jreAKQCsl68`). Three parts:
  (1) **cleanup** — `reconcile_publications` gained `fix:true`: demotes confirmed
  phantoms (verdict no_video_id/missing/shell, never unknown/private) from `published`
  to a new `published_unverified` status (migration `0060`), clears publishedAt, keeps
  the id for history. It's now a WRITE, so removed from `READ_ONLY_TOOLS`.
  (2) **root cause** — the pipeline recorded `providerVideoId` (step 9c) BEFORE media
  verification (9c.5); on a definitive failure it now NULLS the id before throwing, so
  the re-fire re-uploads fresh and no phantom id is left behind
  (`production-pipeline.ts` verify-upload-media).
  (3) **guard** — `publishedVideoForIdea` keyed on any non-null id, so a phantom
  false-blocked re-publishing; it now ignores `published_unverified`
  (`publicationBlocksRepublish` pure helper, tested). +4 reconcile/guard tests.

- **#36 (`01KY3HWK…`, warn)** — `motion: ai_video` front-loaded all 12 clips to the
  first 2 min (allocator walked earliest-first). Rewrote `planMotion`'s ai_video
  branch (`packages/core/src/motion.ts`) to DISTRIBUTE the budget across the runtime:
  hero shots + the opening always move, then author-marked (`motionPrompt`) beats
  sampled evenly, then an even spread across the rest (`pickEvenly` helper). Added
  `preferMotion` to the shot input so an authored `motionPrompt` now STEERS ai_video
  selection (wired from the pipeline + shot-projection). +2 motion tests; guide's
  "which shots move" section updated in both mirrors.

---

# Handoff — 2026-07-21 (session 5) — MCP discoverability (#29) + shot/motion projection (#28) + guide corrections (#30)

Prod head after this session on **`main`** (`a66c3de`→`fd6a006`→ guide-corrections commit).
Cleared the three tickets filed during a day of live operation. All typecheck +
cockpit build + worker typecheck + core tests (237) + guide↔registry audit green.
**Verification caveat unchanged:** no live YouTube API / no prod DB from the sandbox —
everything is typecheck/build/unit-test verified; the operator verifies live after a
**connector reconnect** (new tools/return-fields don't appear until the connector
refreshes its cached tool list — this was the root of #29).

- **#29 (`01KY25NFHJ…`) — MCP discoverability.** (a) `tools/list` now emits
  `annotations.readOnlyHint` for every read tool (`READ_ONLY_TOOLS` in `tools.ts`,
  applied in `protocol.ts`), so the Claude app stops gating pure reads behind an
  approval that never resolved (`get_agent_prompts` "No approval received"). (b)
  `get_deferred_work` was already registered — its invisibility is a connector
  tool-list cache; documented the reconnect fix. (c) Systemic: `guide-audit.ts` flags
  any guide tool token not in the registry — `get_guide` self-audits (returns
  `warnings[]`) and `scripts/audit-mcp-guide.mjs` is a CI gate (`check:mcp-guide`).
- **#28 (`01KY25DN…`) — shot count + motion projected before spend.** New
  `projectShotPlan()` (core, + 5 tests) runs the REAL `planShots`+`planMotion` on
  synthetic word timings: `author_script` + `get_production` return an exact `shotPlan`
  (projectedShots / projectedMovingShots / unusedMotionPromptBeats / per-beat);
  `review_beat_map` returns a coarse `shotEstimate` before narration. Confirmed the
  operator's hypothesis: under `motion: partial` only `heroShot` beats' first shot
  animates — `motionPrompt` never selects a shot (9 supplied → 1 moved = 1 hero beat).
  Also: the AI-clip loop now ledgers NULL clip returns (not only thrown errors), so
  `clipFailures` is no longer falsely empty. Shot count is dominated by the i2v
  clip-cap length-cut when animating (~duration/9s → 83), not rhythm.
- **#30 (`01KY27G4…`) — guide corrections from live operation.** Guide (both mirrors)
  fixed: `visualDirector` is a SHOT PLANNER, not a prompt writer — authored prompts are
  already bypassed, so turning it off doesn't protect them, it just falls back to the
  mechanical cut (verified against `prompt-registry.ts`); duplicate guard blocks only a
  LIVE PUBLISHED video (rejected/failed don't); `ideaId` is from `list_ideas` not a
  `list_series` episode id; visuals gate returns one entry per SHOT (later shots have
  `narration: null`, mapped by `beatIndex`); shot-specific `referenceEntity` vs pool
  exhaustion; `notes`/`artDirection` cap = 6000. Item 8 (narration rate 2.2 vs 2.5) left
  unwritten — operator flagged it as inferred-only, pending a measured render.

Then three more arrived during the same flight:
- **#31 (`01KY294Y…`, error)** — `create_channel researchDepth: "deep"` hard-failed on a
  charterProposalSchema miss with NO retry (and the unset default is "deep"). The charter
  draft now retries 3× on a schema miss only (`packages/agents/src/editorial/charter.ts`).
  Also exposed `verificationBar` on `set_channel_config` (partial-merged, validated) —
  it was readable but unpatchable, so charter drift on `establishedMinSources` was
  unfixable. Confirmed the `charter` param IS in create_channel's schema (from #27) — the
  operator's "absent" reading was the connector cache.
- **#32 (`01KY29ZW…`, warn)** — added `rehook` to the `author_script` beat enum (+
  ScriptBeat/ScriptBeatAnalysis unions) so a reviewer-approved structure carries into the
  script; `payoffBeat`/`flatRunSpan` now name the beat index/span in findings.
- **#33 (`01KY2A8H…`, warn)** — MCP `create_channel` generates NO branding (that's the
  cockpit wizard); fixed the misleading checklist and added a `get_channel_branding` read
  tool (avatar/banner URL + set state). Authored regeneration over MCP deferred
  (`get_deferred_work: branding-authoring-over-mcp`).

Then a seventh, the largest:
- **#34 (`01KY2BJ9…`, warn)** — `review_slate`: a BATCH pre-check of proposed
  ideas/titles against a channel's OWN rules BEFORE they enter the backlog (the
  cheapest gate, one stage before `review_beat_map`). Deterministic core
  (`packages/core/src/slate-review.ts`, +7 tests): intra-slate structural clustering,
  near-duplicate vs slate + backlog + published, keyword position, overclaim verbs.
  Semantic LLM layer (`packages/agents/src/editorial/slate-review.ts`, cheap tier,
  adversarial prompt): forbiddenTopics violation (semantic — catches a rule phrased
  differently) + overclaim-vs-rule as BLOCK, title-family drift + substance overlap as
  ADVISE. New `titleTemplates` DNA field (migration `0058`) + `set_channel_config` /
  `get_channel_config` exposure. Tool returns `review_beat_map`'s
  `{verdict, blockingFindings[], advisoryFindings[]}` shape. Registered `slate-review`
  in the agent registry + a mock-LLM branch. **Deferred (get_deferred_work:
  slate-gate-enforcement):** auto-wiring it as a HARD gate on write_idea/create_series
  (live-behaviour change) + the runReviewLoop-bounded revision loop + auditing which
  other config fields are set-but-never-tested — all to enable with the operator present.

And #35 — the first live `review_slate` run's feedback (it caught more than the
manual audit did):
- **#35 (`01KY3B8N…`, warn)** — three refinements to the tool just shipped. (1)
  keyword-position check now uses a new `searchTerms` DNA field (migration `0059`) —
  the real terms the audience searches — instead of the niche phrase, which fired on
  26/27; unset → the check is skipped (no noise). (2) The semantic reviewer prompt now
  distinguishes a NEUTRAL statement of what a tradition's canon IS from a disparaging/
  contested CLAIM, so neutral facts (e.g. "Enoch is still scripture in Ethiopia")
  aren't blocked. (3) When `titleTemplates` are declared, cross-slate shape clustering
  is suppressed (family conformance is expected) and the LLM flags intra-family
  interchangeability instead. `searchTerms` is on set_/get_channel_config.

**All eight left OPEN for the operator to close after a live round-trip**, per the #25
lesson (never self-close without live verification). Resolution comments posted on each.

---

# Handoff — 2026-07-21 (session 4) — ticket wiring + orphaned-gate fix + alert-threshold fix

Prod head after this session on **`main`**. Worked the "Ticket wiring + two open
tickets" work order. Migrations: `0053` (`agent_tickets.github_number`), `0054`
(orphan-gate sweep + enforcement trigger). All typecheck + cockpit build + core
tests (205) green. **Ticket closure caveat:** the ticket/gate/issue MCP tools are
NOT reachable from this session (only the 9 control-plane MCP tools are), so I
could not call `resolve_issue`/`list_issues`/`get_guide` — worked from the repo
(the source of the served guide) + the work-order evidence. **The operator (or an
MCP-connected Claude) still needs to `resolve_issue` both tickets** once verified
live, and to set `GITHUB_ISSUE_TOKEN` on /account for the acceptance to fully pass.

1. **Task zero — GitHub ticket sync** (was already wired; failing only on config).
   Root cause: `GITHUB_ISSUE_TOKEN` unset + an unhelpful "not configured" note.
   Fix: `createGithubIssue` now returns a discriminated result; `report_issue`'s
   note names the EXACT env to set (or the real API error — 401/403/404 hints).
   Added two-way close: signed webhook `POST /api/github/issues-webhook`
   (`GITHUB_WEBHOOK_SECRET`, HMAC-verified, middleware-exempt) flips the ticket
   when the GitHub issue closes/reopens; stores `agent_tickets.github_number` to
   match. Pure config logic extracted to `core/github-sync.ts` (+ tests, since
   cockpit has no test harness).
2. **Ticket 01KY1SWM… — orphaned gate** (confirmed: retire nulled `currentGateId`
   but left the `review_gates` row `pending`; `list_gates` didn't filter by
   production status). Fix, three layers: (a) DATA — trigger
   `trg_expire_gates_on_dead_production` expires pending gates on any transition
   into rejected/failed/halted/superseded/retired (0054) + one-shot sweep of
   existing orphans; (b) WRITE — `cancelPendingGates` in retire/delete handlers;
   (c) READ — `list_gates` (MCP) + the cockpit gates queue exclude dead-production
   gates via `GATE_DEAD_PRODUCTION_STATUSES`. `core/gate-lifecycle.ts` + a
   regression test covering ALL FIVE gate kinds.
3. **Ticket 01KY1SX2… — alert fatigue** (confirmed: median=2 passed the weak
   `medianViews>0` guard). Fix: underperformance now requires ≥10 published AND
   median ≥50 views AND age ≥24h (`meetsUnderperformanceSampleGate`); below → fully
   suppressed. analytics-ingest auto-acks stale open underperformance alerts below
   the gate, so the three existing criticals self-clear on the next ingest.
   Reasoning for the numbers is in `alert-rules.ts`. Tests updated + added
   (including the exact "0 views vs median 2" case).

**Open decisions surfaced (not chosen unilaterally):** (a) thresholds are starting
points for two very-new channels — revisit as they mature; (b) orphan prevention is
in BOTH the trigger (authoritative) and the handlers/read-filter (belt-and-suspenders);
(c) GitHub two-way sync is implemented but optional (needs the webhook secret) so
the added failure surface is opt-in.

Guide updated (guide.ts + docs §2/§3): list_gates active-only + report_issue GitHub mirror.

---

# Handoff — 2026-07-21 (session 3) — stock diagnostics, GLOBAL stock rate governor, per-channel music bed (Openverse)

Prod head after this session on **`main`**. Three shipped items:

1. **Stock key diagnostics** (`60bb860`-era): `/api/diag/stock` — operator-only GET
   that live-probes Pexels/Pixabay/Unsplash/Coverr and reports OK/FAIL without
   exposing keys. All four confirmed working live (Pixabay video was a slow
   first-byte, not an auth fail; probe timeout raised to 20s).
2. **Global stock rate governor + 24h cache** (migration `0051`): free stock APIs
   have strict app-wide limits (Unsplash demo 50/hr for the WHOLE app). Added a
   Postgres-coordinated token bucket, one row per provider, shared by every channel
   and worker instance — atomic refill-then-consume; empty bucket SKIPS that source
   (falls through), never queues/spikes. `packages/core/stock-budget.ts`
   (`consumeStockToken` fail-closed, `getStockCache`/`putStockCache`,
   `createStockGate`). Wired into the reference provider (photo path: cache→bucket→
   fetch) and the pipeline stock-video calls. Unsplash `download_location` ping on
   used images (Terms compliance). Caps env-overridable: Unsplash 40/hr, Coverr
   30/hr, Pexels 180/hr, Pixabay 90/min.
3. **Per-channel music bed** (migration `0052`, `channel_music`): each channel keeps
   ~6-8 reusable tracks the pipeline ALTERNATES through (least-recently-used) —
   consistent identity, no repeat. Free CC tracks from **Openverse audio**
   (`packages/providers/real/music-openverse.ts`, keyless, `MusicLibraryProvider`).
   Core rotation in `channel-music.ts` (`pickChannelBedTrack` stamps `lastUsedAt`).
   Pipeline: no manual pick + music axis on → rotate the bed before falling back to
   ElevenLabs generate. Music panel rebuilt: channel-bed section, Openverse search
   (add-to-bed / use-here), promote-to-bed, and a "search all channels" global
   escape hatch. New actions in `actions.ts`.

**Governance:** CLAUDE.md now REQUIRES the MCP/Claude guide
(`docs/MCP-CLAUDE-GUIDE.md` + `apps/cockpit/src/lib/mcp/guide.ts` — kept mirrored)
to be updated in the same commit as HANDOFF/BACKLOG. Both guide files updated this
session (§6 stock governor, §6b music bed).

**Standing caveat unchanged:** no local Postgres — typecheck + cockpit/worker build
+ core/providers test suites all green; OWES a live end-to-end run (esp. the token
bucket UPDATE and the bed rotation) and DB-integration regression tests.

---

# Handoff — 2026-07-21 (session 2) — REMEDIATION BRIEF: whole `ytautoremediationbrief.md` worked P0→P3 (duplicate-publish guard, cost/analytics tools, reliability, packaging authoring, batchable gate queue)

Prod head after this session: **`ceb5366`** (branch `claude/backlog-handoff-docs-1rzye9`,
all merged to **`main`**). Worked the operator's remediation brief (gaps found
operating the platform live over MCP against Atom & Friends + Wings & Stories) in
priority order. **Migrations this session: `0049` (`productions.allow_duplicate`),
`0050` (`productions.authored_metadata`).** All typecheck + cockpit build green per
commit. **Standing caveat: no local Postgres — build+typecheck verified; OWES a
live end-to-end run + a DB-integration regression test for the dup guard (the repo
has no Postgres test harness).**

## ⚠️ Compliance constraint (brief §0.1) — approval stays HUMAN
Both channels are T1 and MUST stay gated; `autoApproveVisuals`/`autoApproveFinal`
stay false. Approval is a **human cockpit action** and is **NOT** reachable over
MCP — `decide_gate` was removed (`c2a44c5`). The approval log is the
editorial-judgment evidence that protects the channels under YouTube's
inauthentic-content enforcement; an AI clearing its own gates would hollow it out.
MCP gate tools are read-only (`list_gates`/`get_gate`) — see, inspect, flag only.

## P0 — the actively-harmful bug: duplicate publishes (`3b544a7`, §2.1)
Re-greenlighting an idea that already published created a fresh production and
uploaded a SECOND video (every idempotency check was keyed to the current
productionId; the variation check only compares script substance, and a
re-greenlight makes a new script → passes). Krypton published twice, Argon 4×.
Fix (layered): `publishedVideoForIdea` helper (core); `greenlightAction` blocks
with a message pointing at "Make a corrected copy"; `greenlightAllowDuplicateAction`
+ `productions.allow_duplicate` (0049) is the explicit override; the pipeline has an
early duplicate-publish-guard step that halts on_hold BEFORE spend (defense-in-depth
for resume/MCP paths), naming the conflicting providerVideoId; MCP `author_script`
guarded too. Surfaced via `get_production.failureReason`.

## P0 — empty descriptions (§2.2): NOT a code bug
Traced the whole publish path — the description IS assembled (idea.angle +
AI-disclosure + credits) and threaded to `snippet.description` correctly. The 12
affected videos likely predate the credit code, or hit the reuse branch that skips
the upload snippet. The durable fix shipped is **packaging authoring (§3.4)**. Open:
backfill the 12 via `videos.update` (OPEN-DECISIONS.md D2).

## P1 — MCP surface gaps
- `c2a44c5`/`214a85c`: `list_productions` fixed (explicit projection — was likely a
  full-row deserialization/bad-arg failure); `get_production_costs` +
  `get_channel_costs` (spend by stage/provider; NOTE: failed ops aren't recorded but
  partial spend on a failed production is); `get_video_analytics`
  (views/CTR/retention curve + hook/script analysis; curve null on real channels
  until the YouTube provider is extended); `maxAiClips` surfaced in
  `get_channel_config` (resolve returns undefined → was invisible).
- `507d137` (§3.4/§3.5): **packaging authoring** — `productions.authored_metadata`
  (0050): title/description/tags/thumbnailPrompt override the auto values (credits +
  AI-disclosure still appended; thumbnail prompt used verbatim). MCP: `author_script`
  gains those fields + new `set_publication_metadata` (before the final gate,
  locked after). Per-channel `productionProfile.thumbnailTemplate` for a consistent
  series frame.

## P2 — reliability (`e332cb9`)
- §4.1 Seedance duration: Mini/Pro shared one `SEEDANCE_ALLOWED_DURATIONS` (their
  discrete sets differ → 400). Now per-tier via `opts.allowedDurations` +
  `SEEDANCE_ALLOWED_DURATIONS`/`SEEDANCE_PRO_ALLOWED_DURATIONS` on /account.
- §4.1 clip failures were silent (console.error only) — now recorded as a
  retro_observation + returned by `get_production.clipFailures`. **The Ken-Burns
  fallback the brief wanted ALREADY EXISTS** — a failed clip keeps the still, which
  renders with a Ken Burns zoom (OPEN-DECISIONS D4).
- §4.2 research stall: the Tavily search fetch had no timeout — added
  `AbortSignal.timeout` (`RESEARCH_SEARCH_TIMEOUT_MS`, 30s) so a hang throws and the
  Inngest step retries instead of stranding for the daily watchdog.
- §4.3 render/stock preflight: a `render-preflight` step fails fast on_hold when a
  long video needs Remotion Lambda but the keys are absent
  (`LOCAL_RENDER_CEILING_SEC`, 900s), and warns on real_footage/mixed with no stock keys.

## P3 — config + throughput
- §5.2 (`ceb5366`): `get_channel_config.consistencyWarnings` flags DNA↔charter
  contradictions (e.g. objective "10-15 min" vs targetLengthSec 8 min). Surface, not
  auto-correct.
- §5.3: the Review queue (`/gates`) was already cross-channel with inline decide for
  scripts; extended so the VISUALS gate shows the whole shot set (image+narration)
  inline, approvable in one action with **a/r/x keyboard shortcuts** (per-shot fixes
  stay on the production page), and the FINAL gate is inline-decidable cards. A
  sitting of twenty is now minutes from one screen; every decision still writes the
  evidence log.

## OPEN-DECISIONS.md (new — brief §0.1 rule 3 / §6)
D1 duplicate-detection key (chose idea-id; same-subject-different-idea planning dedup
left open), D2 description backfill, D3 raw vs marked-up cost, D4 Ken-Burns vs halt,
D5 authored metadata vs the SEO generator.

## OWED (next session, needs a live stack)
Live E2E: dup guard blocks a re-greenlight/authored dupe & publishes nothing;
authored title/description/tags land on YouTube; Seedance duration fix ends the 400s;
research no longer stalls; render preflight fails fast; the visuals queue approves
inline. Plus the DB-integration regression test for the dup guard, and the §2.2
backfill decision.

## Commits (oldest→newest, all on `main`)
`c2a44c5` remove decide_gate · `214a85c` cost/analytics tools + list_productions fix
· `3b544a7` P0 duplicate-publish guard · `e332cb9` reliability (seedance/research/
render) · `507d137` packaging authoring · `ceb5366` charter/DNA check + batchable
gate queue.

---

# Handoff — 2026-07-21 — MCP CONNECTOR + full direct-authoring epic (#36): Claude runs the platform end-to-end (scripts/arcs/ideas/options + every creative LLM), drives the gates, stock libraries, long-form chunking, a debug console, and a two-Claude ticket bridge

Prod head after this session: **`343878e`** (branch `claude/backlog-handoff-docs-1rzye9`,
every commit merged to **`main`** and pushed — Render redeploys cockpit + worker on
push). **Three migrations this session (all additive, worker `preDeploy` applies
them): `0046` (`productions.external_script`), `0047` (`agent_tickets` + ticket enums),
`0048` (`agent_tickets.github_url`).** db/core/providers/cockpit/worker typecheck +
cockpit production build green on every commit; `chunkText` unit-tested (4 green).
**Standing caveat (same as recent sessions): NO local Postgres/click-test this
session — everything is build+typecheck-verified and OWES an eyeball + a real
end-to-end authored run on the deploy.** This was a long operator-driven session
building BACKLOG #36 from nothing to a complete authoring control plane.

## ⚠️ The domain gotcha (read first) — the cockpit is `ytauto-cockpit.onrender.com`
CLAUDE.md / older handoffs say `yt-auto-platform.onrender.com`; the **actual live
Render service is `ytauto-cockpit.onrender.com`** (a separate host that 404s
`/api/mcp`). Hours were lost pointing the connector at the wrong host. The MCP
connector URL is **`https://ytauto-cockpit.onrender.com/api/mcp?key=<token>`**.
(TODO: fix the stale hostname in CLAUDE.md / docs.)

## The MCP connector (`/api/mcp`)
Streamable-HTTP JSON-RPC MCP server, hand-rolled (no SDK dep), Node runtime,
`apps/cockpit/src/app/api/mcp/route.ts` + `lib/mcp/{protocol,tools,guide}.ts`.
Added as a **custom connector** in the Claude app. Auth learnings, in order:
- **Middleware** exempts `/api/mcp` from operator basic auth; the route enforces a
  dedicated **`MCP_BEARER_TOKEN`** secret (NOT the operator password).
- Claude's Add-custom-connector dialog has **no static-token field** (only OAuth
  or no-auth), so the working setup is a **no-auth connector with the token in the
  URL**: `?key=<token>` (the route also accepts `Authorization: Bearer`).
- The connector expects **SSE** responses when it sends `Accept: text/event-stream`
  (returning plain JSON tripped "invalid MCP server"); GET serves an SSE stream to
  clients and a **browser health check** (`{"ok":true,...}`) to a plain browser —
  the fastest way to prove deploy + token are good.

## Direct authoring — Claude writes, the platform executes
The core: an **authored** production reuses the pipeline's seeded-draft rails and a
new **`productions.external_script`** flag so **every creative LLM is replaced by
what Claude wrote**, while the automated safety checks (variation/anti-clone +
review board) STILL run:
- Script drafting/humanize/proof — skipped (seed verbatim).
- Per-video profile proposal — skipped (`author_script` always sets the profile).
- Image prompts (`buildImagePrompts`) — skipped when a beat's `imagePrompt` ≥20 chars.
- Motion/i2v prompts (`writeMotionPrompt`) — skipped when a beat carries `motionPrompt`.
- The human **script gate** is skipped (`external_script`); the **visuals** + **final**
  gates still halt on T0/T1 — Claude clears them via the gate tools, or the channel
  auto-runs them (below).
Server functions: `apps/cockpit/src/app/mcp-authoring-actions.ts` — `authorProduction`,
`setChannelConfig`, `createSeriesDirect`, `writeIdea` (mirror `correctPublishedProductionAction`).

## Gate automation
`ProductionProfile` gained **`autoApproveVisuals`** + **`autoApproveFinal`** (jsonb,
no migration; defaults false). When set the pipeline skips that human gate even on
T0/T1 (checks stay on). Settable via MCP `set_channel_config` AND now via **two seg
toggles in the channel Profile tab** (`production-profile-panel.tsx` +
`updateProductionProfileAction`). "Review at first, auto-run once dialled in."

## MCP tool inventory (23 tools, `lib/mcp/tools.ts`)
- Read/intel: `list_channels`, `get_channel_state`, `get_channel_config`, `get_intel`,
  `get_playbook`, `get_eval_results`, `list_ideas`, `list_series`, `list_productions`,
  `get_production`.
- Act/author: `run_market_scan`, `propose_channel`, `create_channel`, `set_channel_config`,
  `create_series`, `write_idea`, `seed_idea`, `author_script`.
- Gates: `list_gates`, `get_gate` (visuals gate returns shots + images + `reviewPath`),
  `decide_gate` (reuses `decideGateAction`).
- Help/ops: `get_guide` (serves the operating guide), `get_diagnostics` (blocked
  productions + reason, open alerts, deploy versions), `report_issue`/`list_issues`/
  `resolve_issue`.
Every mutation logs a `channel_decisions` row (actor operator, `detail.via=mcp`).

## Stock media libraries (BACKLOG #7 advanced)
Free-for-commercial sources feed the EXISTING asset seams (no new pipeline):
- **Photos** (Pexels/Pixabay/Unsplash) → candidate producers in
  `real/reference-images.ts`, mapped to `WikimediaCandidate` so they flow through the
  same pick → vision-fit-gate → auto-credit; `isReusableLicence` extended for the
  named stock licences; keys threaded via the factory. Top-up when the archival pool
  is thin; direct on topic shots.
- **Video** (Pixabay/Coverr; Pexels video already existed) → `sourcePixabayClip` +
  `sourceCoverrClip` in `footage.ts`, wired into the `source-hero-footage` fallback
  chain (Pexels → Pixabay → Coverr, key-gated).
- Secrets: `PIXABAY_API_KEY`, `UNSPLASH_ACCESS_KEY`, `COVERR_API_KEY` (Pexels existed).
  Mixkit/Videvo skipped (no clean API / per-asset licensing).

## Long-form (30–120 min) — the real blocker fixed
The TTS step synthesized the **entire script in one `voice.synthesize` call**, which
400s past the provider char cap on long scripts. Fixed: a script over
`TTS_CHUNK_LIMIT` (4500 chars) is split on sentence boundaries (`chunkText`,
`voiceover.ts`, unit-tested) and synthesized in stitched pieces via the existing
per-piece assembly + word-offset machinery (word timestamps stay a continuous
stream). Short scripts keep the single continuous call.

## Two-Claude ticket bridge
`agent_tickets` table (0047) + MCP `report_issue`/`list_issues`/`resolve_issue` + a
cockpit **/tickets** page (new nav item). `report_issue` also **best-effort opens a
GitHub issue** (labels `mcp-ticket`+severity) so the DEVELOPER (Claude Code) can read
+ answer directly — needs `GITHUB_ISSUE_TOKEN` (PAT, issues:write) on /account
(`GITHUB_ISSUE_REPO` defaults to the repo). The issue URL lands on the ticket.

## Docs
`docs/MCP.md` (setup), `docs/MCP-CLAUDE-GUIDE.md` (the full operating guide to paste
into a Claude **Project** — every tool, the E2E flow, the config surface, real-image
sourcing, long-form, recipes, gotchas). The guide is also served live via `get_guide`.

## OPERATOR TODOs (all account-side, on `ytauto-cockpit.onrender.com/account`)
- **`MCP_BEARER_TOKEN`** — set it, put the same value in the connector URL `?key=`.
- **Stock libraries** — `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `UNSPLASH_ACCESS_KEY`,
  `COVERR_API_KEY` (all free). Only fire on `real_footage`/`mixed` channels.
- **Ticket → GitHub sync** — `GITHUB_ISSUE_TOKEN` (fine-grained PAT, Issues:write).
- **Remotion Lambda** (`REMOTION_*`) for fast very-long-form renders.
- **Refresh the connector** (toggle off/on) after each deploy to pick up new tools.

## OWED verification (next session, needs a live stack)
1. Eyeball the new **Profile automation toggles** (light/dark, 390px mobile).
2. Drive a **real authored video E2E** via the connector: `author_script` → visuals
   gate → `decide_gate approved` → render → publish; confirm A$0/no scripting LLM.
3. Confirm **long-form** synthesizes (a >4500-char script chunks + stitches cleanly).
4. Confirm **stock** photos/video land + credit once keys are set.
5. Confirm **report_issue → GitHub issue** once the PAT is set.

## Commits this session (oldest→newest, all on `main`)
`540c95d` MCP connector · `32d2dae` SSE responses · `203cdf7` `?key=` URL auth ·
`bf0909a` GET health-check + SSE stream · `fed888c` direct-authoring layer ·
`b389e5e` gate tools + auto-approve · `9c9af3e` image-prompt ownership · `8048ea1`
stock libraries · `baecad5` motion-prompt ownership · `55c3e1e` operating guide doc ·
`cb61307` guide tool + diagnostics + tickets · `966b5e2` ticket→GitHub sync ·
`12ef09d` long-form TTS chunking · `343878e` Profile auto-approve toggles.

---

# Handoff — 2026-07-19/20 — CORRECTED-COPY re-cut flow (the "Fix a few things" saga), deploy-version badge, delete/retire videos, global music library, AUD costs, prompt caching, direct script editing, and manual visuals-gate editing (move image / use still / duplicate flag)

Prod head after this session: **`803f7f8`** (branch `claude/music-in-video-vudau7`,
every commit merged to **`main`** and pushed — Render redeploys cockpit + worker on
push). **Five migrations this session (all additive, worker `preDeploy` applies
them): `0041` (superseded status + `supersedes_production_id`/`supersede_delete_old`
on productions), `0042` (`voice_volume`/`music_volume`), `0043` (retired status +
`production_music.name`), `0044` (`fx_rates`), `0045` (`service_versions`).** Both
`0041` and `0043` use `ALTER TYPE … ADD VALUE` (same pattern as the working
`0011`/`0020`/`0029`). Cockpit typecheck + production build green on the final
commit. **Standing caveat: no local click-test — build+typecheck verified; owed an
eyeball on deploy.** This was almost entirely operator-driven, iterating live on
the published **Krypton** short they wanted to re-cut.

## ⚠️ Deploy-limbo lesson (read this first)

Rapid back-to-back pushes to `main` **restart the Render worker build before the
previous one finishes**, so the worker can sit on OLD code for a long time while
`main` looks up to date. This burned hours: pipeline fixes for the corrected copy
were correct in git but the running worker hadn't picked them up, so the operator
kept seeing the OLD behaviour (copies landing on the script gate, firing Sonnet).
**The `service_versions` build badge (below) exists to make this visible — always
confirm `app` and `worker` commits MATCH and are green before concluding a
pipeline fix "doesn't work."** When iterating on the worker, push once and wait.

## The headline feature: "Make a corrected copy" of a published video ("Fix a few things")

A published video is intentionally locked (YouTube can't swap a live file). The
way back in is **`correctPublishedProductionAction`** — it mints a NEW production
that publishes as a fresh upload, carrying the approved script + a copy of every
still/clip/voiceover/music so the operator swaps one bad shot and republishes,
cheap. Two intents (chosen in `CorrectedCopyPanel`): **"Fix a few things"** (copy
all media, land at the visuals gate) and **"Rebuild the visuals"** (keep script,
regenerate all visuals). A corrected copy is marked by `supersedesProductionId`
being non-null → `ctx.isCorrectedCopy` in the pipeline.

**A corrected copy MUST skip every re-planning/spend stage** (the operator is
fixing VISUALS, not re-writing). Each of these was a separate leak found and
plugged this session — if a copy ever fires Sonnet again, this is the checklist:

1. **Script gate** — `skipScriptGate = ctx.isCorrectedCopy` (keyed on the copy
   flag ALONE, not on `reuseSeed`; a copy must never sit on script review).
2. **Script drafting Sonnet** — the copy carries the approved script as a v1 seed
   (`resumedScript`), so `reuseSeed` short-circuits drafting/humanize/proof.
   `correctPublishedProductionAction` now **throws** if the source has no draft
   to seed, and the pipeline logs if a copy ever reaches it with no seed.
3. **Per-video Profile proposal (`proposeProfileTweaks`, a Sonnet call) + the
   `profile_review` gate** — skipped for `isCorrectedCopy` even when the source
   carried NO `productionProfile` (Krypton predates per-video profiles; the copy
   fell through to the LLM + gate and stalled at "Profile review" firing Sonnet).
4. **Visual Director** — reused from the carried `directedSequence` (copied onto
   the seed draft), never re-run.
5. **`align-visuals-to-shots`** — **skipped entirely for a corrected copy.** It
   re-fits stills to a recomputed shot plan; the copied media (47 imgs) outnumbered
   the recomputed shots (45), so it DROPPED the 3 unmatched stills + a clip and
   then fired the Sonnet prompt-builder to refill the now-empty shots. A copy
   reuses its media verbatim.
6. **Variation check + review board** — return early / skipped for `isCorrectedCopy`.
7. **Stale render** — `copyProductionMedia` never copies the `render` asset (a
   carried render produced a false "rendered without N clips" banner).
8. **Verify-before-fire** — after the copy transaction, the action re-reads the
   row and throws if `supersedes_production_id` didn't persist, so a copy can
   never silently run as a full pipeline re-run.

**Diagnostic surfaced on the production page:** a "Pipeline diagnostics" block
(always open) shows a **FLOW:** line classifying the production as `CORRECTED
COPY` / `PUBLISHED ORIGINAL` / `RESUME` / `FRESH`, plus `supersedes`,
`inngestRunId`, seeded drafts + `directedSequence` length, pending gate, and
copied-media counts. This is temporary instrumentation from the debugging — leave
it until the copy flow has a few clean real runs, then it can be trimmed.

## Deploy-version badge (`service_versions`)

The worker stamps `{service:"worker", commit, bootedAt}` into `service_versions`
on boot (`apps/worker/src/index.ts`); the cockpit layout reads it and
`RENDER_GIT_COMMIT` for its own build, and `AppShell` renders a `BuildBadge` at
the bottom of the sidebar: `● app <c> · worker <c> · <relTime>`, green dot when
the commits match (fully deployed), amber while the worker is mid-deploy. This is
the antidote to the deploy-limbo problem above.

## Manual visuals-gate editing (new operator tools)

All in `visuals-grid.tsx` + `actions.ts`, all free / no LLM:
- **Move an image to another shot** (`reassignShotImageAction`) — swaps a shot's
  image AND its clip with the target shot (temp-idx hop around the
  `(productionId,kind,idx)` unique index). For fixing an off-by-one drift where the
  right picture exists but sits in the wrong slot. Dropdown of all shots in the
  swap dialog.
- **"Use the still instead — remove clip"** (`removeShotClipAction`) — deletes a
  shot's `video_clip` row so the render falls back to the still (render prefers a
  same-idx clip). Image untouched. Button in the Animate section.
- **Duplicate flag** — an amber "Duplicate A/B/…" chip on any shot card that
  repeats another shot's **narration line OR image file** (matching shots share a
  letter). Computed in `page.tsx` (`dupGroupFor`), no cost. Catches the
  images-outnumber-shots drift where a trailing orphan image falls back to a
  repeated narration line.

**Known data quirk on old videos (Krypton):** the source had 47 stills but a
45-entry `directedSequence`, so the re-derived shot plan is shorter than the
image set — the render (shot-plan-driven: `shots.map((_,i)=>image[i])`) ignores
images past the last shot, and the tail labels drift/repeat. The move/duplicate
tools let the operator hand-fix it. **Owed systematic fix (see BACKLOG #38):**
persist a production's shot plan and reuse it verbatim on a corrected copy so
images can never drift or drop.

## Other operator features this session

- **Delete / Retire videos + a ⋯ row menu** on the channel Videos tab
  (`video-actions-menu.tsx`): "Reopen production", "View analytics", **Retire**
  (`retireProductionAction`, archive in-tool only) and **Delete**
  (`deleteVideoAction` → `providers.publish.deleteVideo`, 404-idempotent, removes
  the live YouTube upload when present). Delete-published defaults chosen by the
  operator: "Remove from YouTube + archive".
- **Global music library** — every generated track is reusable across all videos
  via a deduped-by-audio dropdown in `MusicPanel`; new tracks are AI-named
  (`packages/agents/src/music-namer.ts`, cheap tier). Scope: **global (all
  channels)**, per operator.
- **Prompt caching** — `anthropicPromptCache` middleware
  (`packages/providers/src/real/llm.ts`) sets `cacheControl:{type:"ephemeral"}`
  on large system messages (≥4096 chars) via `wrapLanguageModel`, to cut token
  spend (from the operator's Anthropic email).
- **Costs in AUD at each day's spot rate** — `loadUsdAudRates` (Frankfurter/ECB,
  free, cached in `fx_rates`, nearest-prior fallback, default 1.53) in
  `lib/fx.ts`; `fmtAud` lives in `lib/format.ts` (client-safe — do NOT import it
  from `fx.ts`, which pulls DB+sharp into the client bundle and breaks the build).
  USD kept alongside for reconciliation.
- **Direct per-segment script editing at the review gate** — `ScriptEditor` +
  `saveScriptBeatsAction` (on text change, wipes only voiceover+render, NOT
  images; count-stable rewords keep all stills via `align-visuals-to-shots`
  content-matching). The storyboard now shows LIVE shot text so an edit reflects
  immediately.
- **Audio levels** — per-video `voiceVolume`/`musicVolume` (`AudioLevelsPanel`,
  `setAudioLevelsAction`); the render reuse-guard also compares levels so a
  volume change re-renders.

## Owed real-run checks (next session)

- Confirm a fresh **"Fix a few things"** copy on the deployed `803f7f8`: FLOW =
  CORRECTED COPY, **A$0.00 / no Sonnet**, all media kept (no drop), lands at the
  visuals gate. (Operator saw exactly this on the last clean run — verify it holds.)
- Confirm **Delete (remove from YouTube)** against a real upload (404-idempotent).
- Confirm the **duplicate flag** lights the repeated-narration tail shots on Krypton.
- The "Pipeline diagnostics" + FLOW block is temporary — trim once the copy flow
  is trusted.

---

# Handoff — 2026-07-17 (session 2) — MUSIC end-to-end, character look-alikes, Animate reliability, Seedance Mini/Pro, and the "clips + music never reach the rendered video" hunt

Prod head after this session: **`91c3afe`** (branch `claude/music-in-video-vudau7`,
all commits merged to **`main`** and pushed — Render redeploys cockpit + worker on
push). **One migration this session: `0040_public_triton.sql` (production_music
table)** — the worker `preDeploy` applies it. Cockpit typecheck + production build
green on the final commit. **Same caveat as always: no local click-test (no
Postgres this session) — everything is build+typecheck-verified and owes an
eyeball on the deploy.** This session grew directly out of the operator's music
request and then chased a persistent "the render doesn't contain the clips or the
music I approved" symptom to ground.

## The headline bug: why approved clips + music weren't in the rendered short

The operator kept reporting: *"the videos were all animated before I rendered, I
watched them all an hour before I approved, and the render still had neither the
clips nor the music."* That is a real content bug, and it had **three independent
causes**, all now fixed:

1. **Stale render REUSE (`91ea0ce`, the big one).** The render step had a
   "reuse a kept render" short-circuit (from the copy-render optimisation) that
   returned **any** existing `render` asset wholesale — including one produced
   *before* the operator animated clips / picked music at the visuals gate. So a
   correct set of clips sat in the DB while the pipeline handed back the old cut.
   Fix: the reuse guard now only fires when the kept render's stamped
   `meta.clipIdxs` **and** `meta.musicKey` match the CURRENT live `video_clip`
   rows + selected `production_music` track; otherwise it logs
   `[render] <id>: NOT reusing kept render — stale (...)` and re-renders. Every
   render now stamps `renderMeta = {clipIdxs, musicKey}` so the guard (and the
   cockpit banner) can tell fresh from stale.

2. **Music axis "off" silently dropped an explicitly-picked track (`01f33b8`).**
   The Music axis defaults to `off`. The `generate-music` step only honoured a
   track when the axis was on, so an operator who generated + "Use this"-picked a
   track in the Music panel but never flipped the axis got silence. Fix: an
   explicit `production_music` selection now always plays (at the `standard`
   level) regardless of the axis; the axis only governs *auto-generating* a bed
   when no track was picked.

3. **Browser served a STALE cached render (`91c3afe`, this session's last fix).**
   `final.mp4` and every per-shot clip/image use **deterministic** storage keys,
   and `/api/media/[...key]` sets `cache-control: private, max-age=3600`. So even
   after a *correct* re-render overwrote `final.mp4` at the same key, the browser
   kept playing the **cached old video (no clips / no music) for up to an hour** —
   which looks exactly like "the render still doesn't have them." Fix:
   cache-bust every deterministic-key media src with `?v=<updatedAt-ms>` (rendered
   short + clip strip on the production page; thumbnail, in-place preview, and
   swap-dialog image/clip in the visuals grid). A new render/clip mints a fresh
   URL that misses the cache; unchanged assets keep their URL and stay cached.

**If it recurs after this deploy:** check the worker logs for the
`[render] … NOT reusing kept render — stale` line. If it's absent on a
re-render, the render step isn't re-running (Inngest step memo / gate issue). If
it's present but the operator still sees the old video, it's the cache again —
confirm the `?v=` param is on the `<video>` src in the deployed bundle. The
content path itself (verified this session) is: `render` step reads **live**
`video_clip` rows fresh (not memoised keys), builds `renderVideoKeys` preferring
a clip over the still per shot, and passes `musicSrc`/`musicVolume` into
`buildShortProps`. That path is correct — the bugs were all *around* it.

## Music feature — shipped end-to-end (`54d78d2`, `66bfebe`, `41fc2fb`, `ca992f3`, `e147bd9`)

- **Provider**: new `MusicProvider` interface + `packages/providers/src/{real,mock}/music.ts`.
  Real = **ElevenLabs Music** (`POST /v1/music`, `model_id` from
  `ELEVENLABS_MUSIC_MODEL_ID` default `music_v2`, `force_instrumental:true`,
  `AbortController` timeout `ELEVENLABS_MUSIC_TIMEOUT_MS` default 180s), degrades
  to the mock ambient-pad bed on any error. The ElevenLabs key lives on
  **/account** (same `ELEVENLABS_API_KEY` as voice — it just needs Music access).
- **DB**: `production_music` table (migration `0040`) — candidate tracks per
  production, one `selected`.
- **Cockpit**: **Music panel** on the production page — Generate (~10–30s, manual
  busy state, not `useTransition`), preview each candidate in an `<audio>`, "Use
  this" / Delete. Per-channel **`musicMood`** on the Production Profile drives the
  brief. Actions: `generateMusicCandidateAction`, `selectMusicAction`,
  `deleteMusicCandidateAction`.
- **Volume vs voice (`ca992f3`)**: music is ducked well under the voiceover —
  `MUSIC_VOLUMES = {off:0, subtle:0.03, standard:0.08}` (voiceover renders at full
  volume). NOTE: this is a **static** duck, not sidechain — see backlog #35.
- **Backlog #34**: plugging in a free/royalty-free library as a second source.

## Character look-alikes fixed (`4965957`)

Every beat image was getting the recurring character's full style-guide appended,
so background/incidental people rendered as hero look-alikes. Fix: casting is now
**deliberate** — the character description + reference sheet ride a shot only when
it's a genuine character shot (`heroShot || mentionsName`), gated under cast_mode
`auto`. `packages/agents/src/image-prompt.ts` RECURRING-CHARACTERS instruction
rewritten so incidental people must NOT resemble the character. (`mentionsName`
exported from `character-cast.ts`.)

## Animate (i2v) reliability overhaul

The operator hit false "animate failed" and false "done" repeatedly. Journey:
- **Seedance duration (`6d6b7e6`, `0a3f483`)**: ModelArk i2v only accepts discrete
  durations (5/10s, not 7). A raw request 400'd (`InvalidParameter`). Now
  `seedanceDuration()` snaps **UP** to the nearest allowed value that covers the
  beat (`COVER_SLACK=0.6`) so a 6s shot gets 10s, never a frozen tail.
- **No self-timeout (`14269ed`)**: dropped the 8-minute client timeout that was
  reporting still-running clips as failed; added **Cancel** buttons (clip via
  `production/clip.cancel` + `cancelOn`; image regen queue).
- **Idempotency (`25be8da`)**: stacked regens were dropped by a shared Inngest
  dedupe — each click now gets a **unique `reqToken`** dedupe; thrown clip errors
  record a failure ledger instead of vanishing.
- **Completion detection (`0c3d4ef` → `16e1509`)**: went from timestamp (clock
  skew) → relative-to-queue → finally **exact `reqToken` match** (clip is "done"
  only when `clip.meta.reqToken === the token this click issued`) — kills both the
  false-done and stuck-spinner cases.
- **Queue + instant update (`25be8da`, `746a012`)**: image regens **queue** and
  fire in series, thumbnails update in place (no refresh) via `imgOverride` +
  `swapShotImageAction` returning the new `storageKey`, and queues **persist
  across reloads** (sessionStorage).
- **Motion-prompt help (`1b983b1`)**: "Suggest from image" button writes a motion
  prompt from the still's image prompt (dialog + inline storyboard row).
- **UX**: storyboard prompt collapses to one line, expands on focus (`72afab2`);
  click any thumbnail to preview in place (`8973cf5`).

## Seedance Mini (cheap default) vs Pro (cinematic) (`e147bd9`, `cf317ff`, `85eebf6`)

Full Seedance was too expensive for cartoon content. Split into two engines:
**`seedance`** (Mini, `dreamina-seedance-2-0-mini-260615`, ~$0.02/s, the default
everywhere) and **`seedance-pro`** (cinematic, via `SEEDANCE_PRO_VIDEO_MODEL`).
Both map through the factory `byEngine`; the Animate dropdown and Production
Profile expose "Seedance Mini" / "Seedance Pro" with Mini as default. The video
engine union was widened to include `"seedance-pro"` across core/db/providers/
cockpit. (Seedance is the operator's only keyed i2v engine, so it's now the
genuine default, not just a per-channel Style override.)

## Stale-render banner (`3d20555`)

Belt-and-braces for cause #1 above: the production page diffs the render's
stamped `meta.clipIdxs`/`meta.musicKey` against live clips + selected music and,
when they differ, shows a **"This video was rendered without N clips / your
music"** banner with a one-click **Retry from render** (`retryFromStageAction(id,
"render")`, which keeps every upstream artifact and just re-renders).

## Commits this session (oldest→newest, all on `main`)
`fd273e6` (prev-session handoff) · `54d78d2` music axis→render · `4965957`
stop mis-casting character · `cff6e6a` surface regen failures · `8973cf5`
thumbnail preview · `ed89711` live animate/image status · `22e92f5` always-show
character picker · `66bfebe` music choose+preview · `25be8da` image queue +
instant update + animate retry · `6d6b7e6` Seedance duration snap · `0a3f483`
snap UP to cover beat · `1b983b1` suggest motion prompt · `746a012` persist
queues + inline motion · `72afab2` collapse prompt · `85eebf6` default Animate
engine Seedance · `cf317ff` default clip engine Seedance · `14269ed` drop 8-min
timeout + Cancel · `0c3d4ef` clock-skew-proof landed-clip detect · `16e1509`
token-match completion · `41fc2fb` fix ElevenLabs Music call + surface failures ·
`e147bd9` Seedance Mini/Pro · `ca992f3` lower music bed level · `01f33b8` play
selected track even when axis off · `3d20555` stale-render banner · `91ea0ce`
never reuse a stale kept render · `91c3afe` cache-bust deterministic media URLs.

## What to verify on the live deploy (owed)
1. Generate a short with clips animated at the visuals gate + a music track
   picked → the rendered short **plays with the clips and the music** (this is
   the whole point). If not, grep worker logs for the `[render]` stale line.
2. The rendered `<video>` src carries `?v=<number>` in the deployed HTML (cache).
3. Music sits **under** the voice, not over it (`MUSIC_VOLUMES.standard = 0.08`).
4. Animate a shot → spinner runs to real completion, no false "failed", Cancel
   works; stacked regens all land; queue survives a reload.

---

# Handoff — 2026-07-17 — real-views fix, Style-tab-aware fallback, thin-prompt saga, storyboard row overhaul; GEMINI BILLING FIXED

Prod head: **`7f671a9`**. All 11 commits pushed to `main` (list below). **No
migration** this session. Cockpit/core/providers/worker typecheck + cockpit
production build green on every commit. **BIG CAVEAT: nothing was click-tested —
local Docker/Postgres was down the whole session, so every UI change is
build+typecheck-verified only and OWES an eyeball on the deploy.**

## Commits (oldest→newest)
`c0c5cef` overview real-views · `3d4167d` Style-tab fallback · `558ef3e`
prompt split-retry · `0c314d9` regen/animate dropdowns + regen-prompt · `c3fa7ed`
fill-thin-prompts · `c24dd2e` production-page layout · `014e5b9` single-shot
prompt reliability · `60dc10d` yellow-headlines fix · `4424d74` animate queued UX
· `f4e000e` /api/diag/clips · `7f671a9` inline storyboard row (editable prompt +
per-row pickers).

## 1. Overview "Views" were ~100× inflated — fixed (`c0c5cef`)
The channel cards + Views/Subs 30d KPIs + 14-day chart summed EVERY analytics
snapshot in the window, but snapshots hold CUMULATIVE lifetime views and the
ingest writes one every 6h — so a 30-day video contributed ~120 growing totals.
New **`AnalyticsProvider.fetchChannelStats`** (real + mock) pulls genuine
windowed views/subs/retention + a daily series **straight from the YouTube
Analytics API** (`ids=channel==MINE`); `loadPortfolio` uses it (memoised ~30 min
so the force-dynamic page never fires N live calls per render), fail-soft to 0.
Top-videos was already correct (latest-snapshot-per-video).

## 2. Image fallback now follows the Style tab, not a hardcoded qwen (`3d4167d`)
The media factory degraded a failed hero image through a HARDCODED `[qwen,
seedream]` order, ignoring the channel's engine choice — so `bulk=seedream` still
fell to qwen whenever DashScope was keyed. New **`imageEnginePreference`** builds
the degrade list from ONLY the Style-tab engines; threaded as `generateImage`'s
`fallbackEngines` and honoured by the factory. Wired into the pipeline + the
cockpit generate/studio/swap paths.

## 3. The thin-prompt saga (consistent generation)
Root cause: `buildImagePrompts` batches shots 8-at-a-time and on a miscount/error
the WHOLE batch of 8 reverted to raw beat briefs → "a handful of great prompts,
the majority thin."
- `558ef3e` — a mismatched batch now **splits and retries down to single shots**;
  only a shot whose own call fails degrades.
- `014e5b9` — single-shot builds (the manual "Regenerate prompt") are **lenient
  on count + retry + run on the frontier tier**, and the action now REPORTS a
  fallback ("couldn't elaborate, try again") instead of silently returning thin.
- `c3fa7ed` — a **"Fill thin prompts"** batch button on the storyboard re-runs
  the agent for every generated shot missing the `Style:/Mood:` suffix.
- `60dc10d` — **"yellow headlines" bug**: the operator's brown-haired character
  went yellow. Root cause (found WITH the operator via the diag path): the
  distilled channel style contains "yellow headlines" (a thumbnail/text colour),
  the whole style block rides every beat-image prompt, and the builder both
  carried it in AND mis-applied "yellow" to the hair. Two guardrails added to the
  builder system prompt: OMIT text/headline styling from text-free beat images,
  and NEVER recolour a named subject from the palette (hair comes only from the
  character description).

## 4. Storyboard row overhaul (`0c314d9`, `5e1b0ec`, `4424d74`, `7f671a9`)
Evolved over the session per operator asks, ending at **`7f671a9`**:
- The **full generation prompt shows under the narration as an editable,
  auto-grown textarea** (persists on blur via `saveShotPromptAction`); Regenerate
  drops its result there; archival rows show their (now-wrapped) subject line.
- **Per-row inline pickers**: image-model select beside **Image**, video-model
  beside **Animate**, character select ("No character"/any) beside **Prompt**.
  The old global toolbar was removed.
- **All buttons uniform ghost** (Image was the odd primary-blue). Row
  click-to-open removed (it fought the inline controls); **Edit ▸** opens the
  dialog.
- Buttons fire **independently/concurrently** (per-row busy keys); one refresh
  when the last settles. **Animate is async** → shows **"Queued ✓"** + a
  background banner and surfaces queue-time errors (`4424d74`).

## 5. Production page: full-width storyboard (`c24dd2e`)
Was a 2-col grid with the wide storyboard squished in the left half and
Script/Costs/History filling the right (dead space). Now single full-width
column: stepper (flow) on top, a compact render+voiceover media strip, then the
storyboard EDGE-TO-EDGE. Script v1, Cost breakdown, Review history moved into
**modals** off `ProductionMetaBar` buttons in the status bar.

## THE operational finding — GEMINI BILLING IS FIXED
`/api/diag/media` this session: **`heroTest: ok:true`** on `gemini-3-pro-image`
(HTTP 200, image returned). The prepaid-credits 429 that silently degraded
everything to fallback engines is **resolved** — nano-banana-pro works. The whole
off-model saga (incl. the yellow-hair severity) was amplified by that fallback;
regenerating affected shots now lands on the real hero model.

## Owed / next-session TODO
1. **Eyeball ALL the UI on the deploy** — nothing was click-tested (local stack
   down all session). Highest-risk: the inline storyboard row (`7f671a9`) — row
   height / the 234px action column / editable-prompt auto-grow / 390px mobile;
   and the production-page redesign (`c24dd2e`).
2. **Seedance video not producing clips.** `/api/diag/media` keys: `SEEDANCE_API_KEY`
   **null**, only `ARK_API_KEY` set (`len 38, "Argo…"`). Seedance is wired via the
   ARK fallback but the **Seedance video model is almost certainly not activated**
   on that key → the vendor rejects the clip (failure lands in `channel_decisions`
   / `/api/diag/clips`). Operator has two `ark-…` keys (BOTH different from the
   current `ARK_API_KEY`) — set the correct one as `SEEDANCE_API_KEY` on /account
   with the Seedance model activated (+ raise Safe Experience Mode), restart
   worker, confirm via `/api/diag/clips`. **Wan works now (DashScope keyed) — use
   it meanwhile.** New route **`/api/diag/clips`** shows animate failures + video
   keys + landed clips.
3. **Argon "real images despite 'no real images'.**" Not a sourcing bug —
   `archivalImagePolicy` is airtight for `ai_images`. Means the production's
   PERSISTED per-video `visualMode` wasn't `ai_images` (profile is locked at
   greenlight). Check `productions.production_profile->>'visualMode'` vs the
   channel's; fix = re-apply channel profile or expose visualMode at the gate.
4. **"Dr Atom" cast into the majority of shots** = the character's **cast dial**
   (`castMode`/`castTarget` on the Style tab); `auto` is presenter-biased. When
   **Visual Director** is ON it owns casting per shot (dial % bypassed, only
   `off` honoured). Operator to tune the dial or the director rules.
5. **analytics-ingest cron freshness** (top-videos staleness, the session's first
   thread) was never confirmed live — less pressing now the overview pulls channel
   stats directly, but top-videos still depends on the 6h ingest running.

---

# Handoff — 2026-07-16 (evening) — BytePlus keys VERIFIED LIVE + adapter shapes fixed; two-key support; profile-save "revert" fixed (live-refresh)

Prod heads: **`e25c716`** (BytePlus media fixes) + **`ec5d9e9`** (profile-save
fix). Both pushed to `main`; worker live on `ec5d9e9`, cockpit finishing its
build at handoff time. **No migration** this session. Cockpit typecheck + build
green throughout.

## 1. BytePlus Seedream/Seedance — keys verified live, adapters corrected (`e25c716`)
The operator supplied real ModelArk keys + activated model ids and asked me to
verify. I tested both against the live API and found the adapters (built blind
last session, "medium confidence" per the older handoff below) sent the WRONG
request shape. Both are now fixed and re-verified end-to-end:
- **Seedream image**: was sending `sequential_image_generation` → hard **HTTP
  400** (`not supported by the current model`). Removed it. Default model →
  `dola-seedream-5-0-pro-260628`. **Re-tested: HTTP 200, real image URL.**
- **Seedance video**: was encoding params as `--flags` in the text (Seedance 1.0
  style). Seedance **2.0** needs the keyframe image tagged `role: "first_frame"`
  and `ratio`/`duration`/`generate_audio`/`watermark` as **TOP-LEVEL** fields.
  Rewrote it. Default model → `dreamina-seedance-2-0-260128`. **Re-tested: task
  created + `status: running` (renders, no longer fails on shape).**
- **Two separate keys**: Seedream and Seedance are DIFFERENT ModelArk keys, each
  with its own model activation. Added `SEEDREAM_API_KEY` + `SEEDANCE_API_KEY`
  secrets on `/account` (each falls back to the shared `ARK_API_KEY`); factory
  wires the right key per engine; `/api/diag/media` masks both.

**LEARNING — "Safe Experience Mode"**: both models initially 429'd with
`SetLimitExceeded` ("model service has been paused… visit the Model Activation
page to adjust or close Safe Experience Mode"). This is a per-model BytePlus
account cap, NOT a code issue. Once the operator raised it, Seedream → 200 and
Seedance → running. **Any newly activated ModelArk model needs this limit raised
or it silently falls back to mock.**

## 2. Profile "Save reverts my dropdowns" — root-caused + fixed (`ec5d9e9`)
Operator reported the channel Production Profile dropdowns reverting on Save.
**The save was NOT broken** — prod DB confirmed values persisting
(`channel_dna.production_profile`). The culprit was the platform **live-refresh**
(`components/live-refresh.tsx`): its `router.refresh()` (SSE ~1s during active
backend work + 20s backstop) re-runs the async channel page through `loading.tsx`
and **REMOUNTS the `<PageTabs>` panels**, re-seeding every form's `useState` from
server props — wiping in-progress edits *before* Save was clicked. With a
production running on the channel, SSE fired constantly, so edits reverted almost
immediately.
- **Fix**: new `apps/cockpit/src/lib/refresh-guard.ts` — a form with unsaved
  changes holds a guard; `LiveRefresh` skips refreshing while any hold is active,
  then fires one catch-up refresh on release. The Profile panel holds it while
  `dirty || focused` (focus covers the uncontrolled art-direction/notes
  textareas). Guard is **reusable** — persona/style/charter forms on the same
  live-refreshing page are candidates if they show the same symptom.
- Memory saved: `live-refresh-remounts-forms`.

## OPERATOR TODO
- **Add both keys on `/account`**: `SEEDREAM_API_KEY` (image) + `SEEDANCE_API_KEY`
  (video). Raise **Safe Experience Mode** on BytePlus for any model you activate.
- **ROTATE the two ModelArk keys** — they were pasted into chat in plaintext, so
  treat them as exposed. Regenerate on BytePlus after setting them on `/account`.
- **Verify the profile fix** once the cockpit build finishes: hard-refresh
  (Ctrl+Shift+R) the channel page, change dropdowns, Save — they should stick.
- **Real-run check**: run a production with Seedream/Seedance selected + confirm
  the clips render (not stills) and character shots land on the right engine.

---

# Handoff — 2026-07-16 (later) — fal STRIPPED; every engine vendor-direct; Seedream/Seedance re-hosted on ByteDance ModelArk

Operator: "fal should be gone and stripped." Done. fal was only ever a gateway;
the ByteDance models (Seedream/Seedance) I'd added earlier today rode it — they
are now **re-hosted DIRECT on BytePlus ModelArk** (`ARK_API_KEY`). Every engine
is vendor-direct: Claude/OpenAI (agentic), **Gemini Nano** (hero/character
image; Veo for video is a future build), **Qwen** (DashScope, bulk image),
**Wan/Minimax** (DashScope/direct, bulk video), **Seedream** (ModelArk, bulk
image alt), **Seedance** (ModelArk, character video). All kept as per-channel
choices so channels can A/B.

## What changed
- **Deleted** `packages/providers/src/real/media.ts` (fal provider). Rewrote
  `media-seedream.ts` → ModelArk `POST /api/v3/images/generations` (Bearer
  `ARK_API_KEY`, OpenAI-shaped, `data:[{url|b64_json}]`); `video-seedance.ts` →
  ModelArk async content-task create/poll. Base URL/model ids env-overridable
  (`ARK_BASE_URL`, `SEEDREAM_IMAGE_MODEL`, `SEEDANCE_VIDEO_MODEL`).
- **factory**: base is now **mock** (no fal). Real image engines gemini/qwen/
  seedream (ARK); the last resort is a REAL engine, then mock — never a silent
  drop to placeholder. Video seedance on `ARK_API_KEY`. LOUD warns preserved.
- **secrets**: `FAL_KEY` → `ARK_API_KEY`. **schema** imageEngine union dropped
  `fal`/`mixed` (legacy DB strings still resolve to qwen). **pricing**: dropped
  fal consts, Seedream now $0.03 (direct). Removed the FLUX-only text-junk
  regeneration (the direct models render text well — saves a vision call/image).
  UI hints, `/api/diag/media` (ARK_API_KEY), `.env.example`, `docs/LOCAL.md`
  updated. `IMAGE_ENGINES`/`VIDEO_ENGINES` unchanged (already fal-free).

## OPERATOR TODO to activate ByteDance direct
- **Sign up for BytePlus ModelArk** (ByteDance's international arm; email +
  business verification), create an **`ARK_API_KEY`**, add it on `/account`.
  Until then Seedream/Seedance are unavailable (selecting them warns LOUD +
  falls back to a real engine; Qwen/Wan cover bulk with no new key).
- **Verify the ModelArk request schemas on the first real call** — I built the
  image path to the documented OpenAI-compatible shape (high confidence) and the
  video path to the content-task create/poll shape (medium confidence; model ids
  are dated — set `SEEDREAM_IMAGE_MODEL`/`SEEDANCE_VIDEO_MODEL` from your
  console). Failures degrade gracefully (image → sibling engine; video → keeps
  the still), so nothing crashes; just confirm output in worker logs.
- No migration this push. 174 core + 101 providers green; typecheck + build pass.

---

# Handoff — 2026-07-16 — image/video COST controls: smart-% casting, Seedream/Seedance engines, clip budget, engine transparency, image density

Prod head `<this push>`, both services live (Render auto-deploys `main`).
Migration **0038** (`channel_characters.cast_target`). Operator-driven session
attacking the credit spike from the neon/Dr Atom video (100% character = every
shot on Nano Pro; expensive video). All levers are **opt-in per channel** — no
behaviour changes until set. Sandbox can't reach Render/fal/DashScope, so the
real-run checks below are OWED.

## Shipped (all on main)
1. **Smart-% character casting** (`ac31284`, migr 0038) — `cast_mode="smart"` +
   `cast_target` (default 55%) on each character (Style tab: mode + % slider).
   `selectForcedCharacterShots` (packages/core/src/character-cast.ts) picks the
   mascot's shots ONCE by IMPORTANCE (hero/named/opener first; FILLER_RE
   diagrams/text/establishing last), counts builder picks, even-spreads,
   deterministic. Un-cast shots fall through to qwen (the saving — the per-shot
   `castCharacter ? nano : qwen` routing already existed; 100% casting defeated
   it). image-prompt.ts: "smart"→"(recurring)" tag; no-lookalike rule widened
   adjacent→whole-video.
2. **Seedream selectable bulk image engine** (`76858ea`) — ByteDance via fal
   (FAL_KEY, `media-seedream.ts`, model env `SEEDREAM_IMAGE_MODEL`=
   fal-ai/bytedance/seedream/v4.5, $0.04). Profile "Image engine" toggle: Qwen |
   Seedream | All Nano. imageEngineFor gains "seedream" (bulk only; hero=nano).
   factory selectMediaProvider generalised to an engine-map + ordered fallback.
3. **Video cost phase** (`03aa96e`) — per-channel **clip budget** (`maxAiClips`),
   **character-aware clip routing** (`characterVideoEngine`: character clips →
   chosen engine e.g. Seedance, filler → videoEngine; reads image
   meta.characterId), and **Seedance i2v engine** (`video-seedance.ts`, fal
   async queue, FAL_KEY, 720p ~$0.06/s, env `SEEDANCE_VIDEO_*`). videoEngineFor
   gains a `{character}` opt; Profile tab: video engine adds Seedance +
   "Character clips" select + "Max clips/video" field.
4. **Engine transparency** (this push) — the operator's ask ("don't let me think
   I'm on a model when it fell back to fal"). Image meta now records
   `engineRequested`+`engineServed`; the visuals gate shows a **warn banner + a
   per-tile ⚠ badge** when served≠requested (imageEngineFellBack in core). Factory
   (image+video) `console.warn`s LOUD when a requested engine has NO provider
   (missing key) instead of silently using base. (Thumbnail path already warned.)
5. **Image-density lever** (this push) — `imageDensity` relaxed/standard/busy on
   the Profile tab, a finer frequency dial on top of rhythm. shotPlanOptions
   scales the long-form still floor (×1.6/×1/×0.7) + short-form floor (relaxed
   4.5s) + splits-per-beat (2/3/4); **standard is byte-identical to before**
   (unit-proven).

## OPERATOR TODOs
- **No new API keys** — Seedream + Seedance both ride the existing **FAL_KEY**.
  But the fal ACCOUNT needs (a) access to those models and (b) balance; and each
  lever must be SELECTED per channel. (Gemini billing top-up from 07-15 still
  stands for hero/character image quality — see below.)
- **Flip Dr Atom → Smart 55%** (Style tab) and set the neon channel: visualMode
  **AI images** (its "random archival footage" clips were the `mixed`/real path
  pulling Pexels — a setting, not a bug), Motion **Key beats**, Character clips
  **Seedance**, Max clips **~4–6**.
- **Live-verify** (none runnable in-sandbox): smart-cast %; Seedream stills;
  Seedance clip (**its fal queue param schema is unverified — a wrong field 422s
  and the pipeline keeps the still, so safe, but confirm the first clip in worker
  logs**); the fallback banner (unplug an engine); density relaxed→fewer images.
- Migration 0038 applies on the worker preDeploy — confirm the deploy went green.

## Verify quick refs
- Core unit: `pnpm --filter @ytauto/core test` (character-cast / video-engine /
  shots density covered). Engine prices: pricing.ts (IMAGE_PRICE_SEEDREAM 0.04,
  VIDEO_PRICE_SEEDANCE_PER_SEC 0.06). Served-engine truth: asset meta
  engineServed + `imageEngineFellBack`.

---

# Handoff — 2026-07-15 — visual-style/character suite, thumbnail studio, image-model incident, halt→edit-script, animation, narration-match

Prod head `9c5c23a`, both services live (Render auto-deploys `main`). Migrations
through **0037** (`0037_soft_mascot` = `channel_characters.cast_mode`). Long,
operator-driven session across brand art, thumbnails, character/imagery quality,
the halt/resume flow, and animation. **Sandbox can't reach onrender.com / Inngest
/ Gemini** — pipeline + LLM paths were verified by typecheck + unit tests + logic
review only; the live checks below are OWED.

## THE incident (root cause of "everything looks wrong / stick figures")
The hero image model was pinned to `gemini-3-pro-image-preview`, **retired by
Google 2026-07-17**; in its final window every hero image 429'd and the media
factory **silently degraded to qwen/fal**, so thumbnails/test-scenes/characters
all came out off-model. Fixed: hero default → GA **`gemini-3-pro-image`**
(`1d052f9`), env-overridable via `GEMINI_IMAGE_MODEL_HERO`. Then the operator's
own key returned **429 RESOURCE_EXHAUSTED — "prepayment credits are depleted"**:
built **`/api/diag/media`** (`6f632cc`, operator-only; reports key presence,
resolved model, the account's image-model list, and a live hero test with
Google's exact error) — that's how we proved it. Also made the silent fallback
LOUD: the factory now stamps the served engine on the result and thumbnail
generate/tweak warn "Served by qwen, not Nano Banana…" (`1e9ce28`).
**OPERATOR TODO #1: top up Google AI Studio billing for project YTAuto, then
re-hit `/api/diag/media` until `heroTest.ok` is true — image quality is blocked
on this, not code.**

## Shipped (all on main, deployed)
1. **Brand art suite** (earlier in the arc) — logo/banner dialogs: structured
   ticks + character/scene refs + live prompt, fed from the ACTIVE distilled
   style; Refine (edit the current art), revert/undo, logo Download, push banner
   to YouTube.
2. **Thumbnail Studio** (`8fe9558`…`769375f`, `dbf894a`, `42ac5ef`, `c8d2f1e`) —
   format presets + title-as-text + style/character refs + live prompt + click-to-
   **Tweak** a candidate (faithful edit). Studio conditions on the active style by
   default (matches the auto thumbnails); character path mirrors the Style-tab
   injection (full description verbatim, character sheet the SOLE reference — no
   competing style image). **Download** button per candidate; the swap gallery now
   also lives on the published-video page (`/channels/[id]/videos/[videoId]`,
   where the operator actually lands). Custom-thumbnail upload failures are no
   longer swallowed — persisted to `thumbnails.meta.applyError` and surfaced with
   a "verify your channel (youtube.com/verify)" banner + retry.
3. **Characters in productions** (`8af417c`…`a71eabe`, `50c65a5`, migration 0037)
   — `cast_mode` off/auto/25/50/75/always; deterministic per-shot casting;
   verbatim canonical-description prefix + reference-sheet conditioning; cast/
   conditioned shots forced onto Nano. Later softened so the SCENE leads and the
   character is a participant, not the frame's subject (`04015d7`).
4. **Halt → push-back lands at an EDITABLE script gate** (`690359d`) — resuming a
   halted production now re-presents the kept script at `script_review` (reuses
   the seeded v1 row, skips only the drafting LLM steps) so the operator can edit
   or approve, instead of skipping the gate. New Plan ⋯ menu action **"Resume
   production (keep the script)"** for halted episodes (`f66bd54`). `greenlit` +
   `voiceover_recording` now count as in-production (`dbf894a`). **Videos tab** =
   published + in-production only (hides halted/rejected attempts that multiply on
   each push-back) and shows the real selected thumbnail.
5. **Imagery quality** (`04015d7`, `3c25897`, `9c5c23a`) — narration DRIVES the
   shot subject (the beat brief is treatment only; fixed "welding image on a
   museums narration"); no two adjacent shots may look alike (repetition on
   per-sentence); the image-prompt builder now BATCHES (~8/call) so one bad count
   can't revert the whole video to raw beat briefs; **plain Regenerate re-derives
   the prompt from the shot's own narration** (swap dialog) so a mis-narrated frame
   is fixable; copied-from-a-prior-run images are re-used only if they still fit
   the shot (no stale archival frames after a resume).
6. **Animation** (`be8c7d2`) — root cause of "Key beats never worked": i2v clips
   cap at 10s but "fewest images" made ~22s shots. When a video animates
   (motion≠static) shots are now capped ~9s (shared `shotPlanOptions` across
   render/animate/estimate so indices align) so every shot CAN move. New
   `writeMotionPrompt` vision agent writes the i2v prompt from the actual frame +
   context (used by Key beats and the manual Animate button; template fallback).
7. **Rhythm UX** (`66e8313`) — dropdown ordered fewest→most images with an inline
   count reminder per option (short LLM sentences make "Per sentence" cut a lot).
8. **Restore an accidentally-cut episode** back into research (`f828d51`).

## Operator TODOs / next-session follow-ups
1. **Gemini billing** — top up AI Studio credits (see incident above); confirm via
   `/api/diag/media`. Nothing image-side is truly fixed until `heroTest.ok`.
2. **Custom thumbnails need a verified YouTube channel** (youtube.com/verify), else
   use the per-thumbnail **Download** + upload by hand in Studio.
3. **Live-verify the pipeline changes** (none runnable in-sandbox): halt→Resume
   lands at the editable script gate; Key beats now produces clips on ≤10s shots;
   a fresh production's images match their narration across a long beat; the swap
   dialog's Regenerate fixes a mis-narrated frame.
4. Deeper follow-ups if drift persists: derive a per-SHOT visual brief (a beat
   spanning multiple topics is the structural cause) rather than inheriting one
   beat brief; soften the swap-path character prepend to match the pipeline's
   scene-led integration.

## Session ops notes
- Local like-prod verify: `PROVIDERS_FORCE_MOCK=1` + local pgvector Postgres
  (`postgres://postgres:pg@127.0.0.1:5432/ytauto`), Playwright via
  `/opt/pw-browsers/chromium`. Mock media ignores pixels — it verifies WIRING
  (refs/prompts/meta), not rendered images. Core unit tests: `packages/core`
  `./node_modules/.bin/vitest run` (shots/motion covered).
- Image engines: `imageEngineFor(profile, quality)` → qwen (bulk, DashScope) |
  nano-banana (hero, Gemini, GA `gemini-3-pro-image`). Video engines cap clips at
  10s (Wan/Minimax). `@ytauto/core` barrel pulls `node:crypto` → NOT importable in
  client components (client-safe composers live in cockpit).

---

# Handoff — 2026-07-13 (evening) — thumbnail=nano-always, dashboard overhaul (migr 0033), real-views fix

Prod head `55fab32`, both services live. Migrations through **0033**
(`channels.avatar_key`, applied directly to prod + journal-consistent so the
worker preDeploy no-ops it). Two videos public with REAL view data now flowing
(Me 262 `WK7KfdVKVPQ` = 1 view; jet-engine `kZV2iIOM7PY` = 3 views —
operator-confirmed against Studio). Whole session was operator-driven UI review
of the Overview dashboard + two data-correctness fixes; verified live on a
local stack (Docker PG + seed + cockpit) in light/dark at desktop + mobile.

## Shipped today (all on main, deployed)
1. **Thumbnails = nano-banana-pro ALWAYS** (`4187357`, `packages/providers/src/real/media.ts`).
   Root cause of "it doesn't use nano": `quality:"hero"` only routed to
   nano when `FAL_IMAGE_MODEL_HERO` was set; unset → SILENT fallback to
   flux. Verified in prod cost_records: video 1/Me 262 thumbs were flux
   (env set ~07-12, newer runs already nano). Now the hero model DEFAULTS to
   `fal-ai/nano-banana-pro` in code — hero (thumbnails + hero beat shots) can
   never fall back to flux. Also confirmed the #35.1 Style-tab is EMPTY in prod
   (visual_styles + visual_style_refs have zero rows, active_style_id null) —
   the operator's example-thumbnail style approach has never been seeded, so no
   thumbnail has ever been style-conditioned. Operator TODO stands: seed +
   **Activate** the Style tab.
2. **Overview dashboard overhaul** (`e246ff7`…`9a426cb`) — from an operator
   screenshot review. `STYLE-GUIDE.md` added as the enforced reference above
   UI-REVIEW.md + /design-system. Fixes: top bar removed on desktop (mobile-only
   hamburger+status+bell; status single-sourced in the sidebar side-util so it
   never doubles), duplicate "Portfolio" gone, tab strip no longer scrolls,
   **active tab persisted in the URL** (`?tab=`) so a schedule drag / live-refresh
   no longer bounces you to Overview, equal-height cards, Review tab removed,
   Costs table rebuilt to the standard (humanized headers + fmtMoney + tabular).
   **Numbers off JetBrains Mono → Inter tabular** (operator: mono "terrible").
   KPIs reduced 7→6 (dropped Published-7d) on even 2/3/6 grids (no orphan tile).
   "Needs your attention" capped + internally scrolling so it aligns with the
   chart (was ballooning + sitting 16px low from a `.panel+.panel` margin
   leaking onto grid siblings — fixed via `.grid>.panel+.panel{margin-top:0}`).
   New widgets: **Subs 30d**, **Est. net 30d** (rev@`EST_RPM` default $3/1k −
   spend; global assumption, make per-channel later), **Pipeline health**,
   **Upcoming publishes**, **Top videos by performance** (sortable strip).
   **Channels section gets a Cards/Table toggle** (Segmented, persisted in
   localStorage; table = dense .data grid, rows link to channel).
3. **Channel logos** (`5478a45`, migration 0033) — the wizard-generated avatar
   was never persisted (no column). Now: `channels.avatar_key`; wizard create
   saves it; overview card + a new **Channel logo** control on Settings & DNA
   (Upload / Generate-with-AI[hero model] / Remove via `/api/channel-avatar` +
   setChannelLogoAction/generateChannelLogoAction); richer card metrics
   (published/scheduled/in-pipeline).
4. **Real view counts** (`b325797`, `packages/providers/src/real/analytics.ts`).
   Top-videos showed 0 views despite real YT views. Root cause (confirmed via
   prod raw `{"rows":[]}`): the adapter only queried the YouTube **Analytics
   reporting API**, which lags ~2-3 days and returns empty rows for new videos.
   Now it ALSO fetches **Data API v3** `videos.list?part=statistics` viewCount
   (near-real-time, matches Studio, 1 quota unit, same OAuth) and prefers it for
   `views`; retention/avg-view-% still from the Analytics API (mature later).
   VERIFIED end-to-end: fired `analytics/ingest.requested` on prod → fresh
   snapshots wrote liveViews 1 & 3 = real counts.
5. **Top-videos thumbnails** (`55fab32`) — each row leads with the video's
   `i.ytimg.com/vi/<id>/mqdefault.jpg` thumbnail, linking out to the YouTube
   watch page (new tab); title still links to the production.

## Operator TODOs / next-session follow-ups
- **Seed the Style tab** (still #1 un-done; visual_styles empty in prod) — the
  nano thumbnails now render but WITHOUT the operator's example-seeded style
  until a style is uploaded + distilled + **Activated**.
- **Profitability RPM**: `EST_RPM` is a single global $3/1k assumption — make it
  a per-channel editable field (needs a column + Settings input) when wanted.
- **Analytics CTR/impressions/subs still null** — Data API gives viewCount only;
  retention/avg-view-% populate as the Analytics API matures (2-3d); CTR +
  thumbnail impressions need a separate Analytics report (backlog "Phase 5").
- Small: channels **Table** columns → click-to-sort (like the top-videos strip);
  visuals-grid "Save to style refs"; the older standing ops debt (GoDaddy flip,
  droplet decommission, key rotation, eval RE-RUN, recording-booth mic dry-run).

## Session ops notes
- Local stack for verification: `docker compose up -d postgres` (pgvector),
  `pnpm db:migrate`, `DATABASE_URL=… pnpm db:seed` (seed script doesn't load
  .env), `DATABASE_URL=… STORE_DIR=… pnpm --filter @ytauto/cockpit dev`.
  Local sandbox DB has NO published videos, so Top-videos/Upcoming show empty
  states locally — both are populated on prod.
- Prod DB access: Render API `/postgres/<id>/connection-info` externalConnectionString
  (+ `?sslmode=require`) with the token in `~/.claude.json` mcpServers.render.
  Inngest event fire: POST `https://inn.gs/e/<INNGEST_EVENT_KEY>` (worker env).

---

# Handoff — 2026-07-13 — #21 COMPLETE (evals+escalation+routing+learning loop) + #27 voiceover; keys migrated; gate fix

Prod head `4244280`, both services live, migrations through **0030** (0028–0030
applied to prod manually, operator-approved; worker preDeploy journal is
consistent). Videos 1+2 PUBLIC (Me 262 went out 10am Melbourne after an
operator reschedule — platform reconciled correctly). Third video scheduled
Fri 9am (`z5bY-YH5G_I`).

## Shipped today (all deployed, on main)
1. **#21.2 eval harness + LLM_MODEL_ESCALATION** (7d353de, migration 0027) —
   6 frozen golden fixtures, eval-harness fn, fixed instruments (proof +
   TASK:script-judge + aiTellMetrics), /account Evals tab (vendor checkbox
   grid, per-model table, blind A/B). Escalation = opt-in 4th tier slot;
   pipeline redrafts once on it when the proof→repair loop fails.
   **First real run: all 48 cells ran, 35 errored — diagnosed + fixed**
   (gemini-2.5-pro/flash closed to new users → Gemini 3.x ids verified via
   live API; Kimi OpenRouter slugs k2.6/k2-thinking/k2.5; long-form JSON
   truncation → maxOutputTokens 8000 on draft/humanize/repair; GLM = Z.ai
   balance empty — OPERATOR: recharge or skip). GPT-5 6/6 ok. **RE-RUN OWED.**
2. **Per-agent model routing** (1565a25) — LLM_AGENT_MODELS JSON secret;
   agentModel/agentModelId (escalation never overridden); runAgent passes the
   routed modelId to temperature; /account per-agent overrides panel (40
   agents). Operator intent: Opus for scriptwriter only, GPT/Gemini elsewhere.
3. **Factuality-gate fix** (1565a25) — leftover UNVERIFIED claims no longer
   hold a production whose tellable bar is met; force-accept cuts leftovers.
   F-86 Sabre unstuck (was "9 claims never finished verification" w/ 11
   verified) — re-fired, now in flight.
4. **#21.5/21.6 learning loop** (096c827, migrations 0028+0029) —
   channel_playbook (evidence-backed directives injected into prompts;
   hierarchy facts > own evidence > market), channel-retro fn
   (maturity-gated; warming=observe-only; ≥3-matured-video adoptions enforced
   in code), performance windows, experiment priority queue (wins graduate to
   playbook), Playbook panel on channel Analytics tab.
5. **#27 operator voiceover** (4244280, migration 0030) — voice_source toggle,
   voiceover_recording gate + Recording booth (per-beat MediaRecorder,
   re-take, download per take — voice-clone source, PERMANENT assets),
   /api/voiceover-take route, ffmpeg assembly + Whisper/linear word
   timestamps, hybrid = TTS-fills unrecorded beats. **NOT yet driven with a
   real microphone — dry-run on a test production first.**
6. **Keys**: VidIQ live (new key, 2000cr/mo, RESEARCH_PROVIDER=vidiq);
   Openverse OAuth live (registered+verified, always-queried pool);
   Gemini/DashScope/GLM/OpenRouter keys migrated droplet→Render (filtered
   rekey — newer Render keys never clobbered).
7. **Ops gotcha captured**: NEW Inngest functions need
   `curl -X PUT https://yt-auto-platform.onrender.com/api/inngest` after
   deploy, then re-fire pre-sync events (eval run sat 25min at 0 runs).
8. **#35.3 thumbnail intelligence** (80107f3, migration 0031) — intel scan
   vision-deconstructs niche winners' thumbnails (runs before the blocked
   transcript check) into pattern-store kind `thumbnail`; buildThumbnailPrompts
   gains feed-size legibility + a pattern-led 3rd candidate; CTR<4 candidates
   regenerate once pre-gate. VERIFIED live (first real pattern written; watch
   for off-niche bleed in the outlier feed — one "pipe water" label).
9. **#35.1 visual style DNA** (660f626, migration 0032) — versioned
   visual_styles + visual_style_refs pool (upload / YouTube URLs / promote own
   thumbnails), style_distiller vision agent, doc → every image+thumbnail
   prompt (closes artDirection-not-in-thumbnails gap), ref conditioning on
   thumbs+hero (rotating refs, referenceStrength 0.45 dial), channel Style tab,
   wizard-lite "Style examples" URLs at creation. NOT yet exercised with real
   refs — operator: seed Wings & Stories' Style tab and watch the next video.
   BACKLOG #36 added: Claude-app MCP connector spec (operator ask).

## Operator TODOs (close-of-day 2026-07-13)
1. **Seed the Style tab** (Wings & Stories → Style): upload the best nano
   thumbnails + paste 2-3 admired channels' video URLs → Distill → Activate.
   The next production inherits the look (prompts + thumbs/hero conditioning).
2. **Eval RE-RUN** from /account Evals (fixed Gemini-3.x/Kimi checkboxes;
   skip GLM unless Z.ai recharged) → set per-agent routing from the results.
3. **Recording-booth mic dry-run** on a test production before a real video
   (#27 is code-complete but never driven with a real microphone).
4. **GoDaddy CNAME flip** (app → ytauto-cockpit.onrender.com) — next session
   verifies cert, sets PUBLIC_BASE_URL + Google OAuth redirect; droplet
   decommission after (droplet DB still holds old keys — rotation pending).
5. Render API key + YouTube OAuth rotation.

## Next builds
#35.2 persistent characters (reuses the #35.1 ref/conditioning machinery) →
#35.4 title templates → #35.5 packaging strategist · **#36 Claude-app MCP
connector** (operator ask — ideate in Claude, fire create_channel) · #34
social distribution · #23.5 seasons · #23.6 multi-account. Small debt:
eval cells don't skip already-done rows on re-fire (re-spend on resume);
visuals-grid "Save to style refs" button; watch intel outlier feed for
off-niche bleed (one "pipe water" thumbnail pattern observed).

## Session ops notes
- Migrations 0027–0032 applied to prod (0028-0030, 0032 manually with
  operator approval — journal consistent, worker preDeploy no-ops them).
- Prod-DB access pattern: Render API connection-info + packages/db postgres
  driver (ssl require). Inngest event re-fire: POST https://inn.gs/e/<key>.
- Worker autoDeploy was paused/resumed around the eval run — currently ON.

---

# Handoff — 2026-07-12 (night close) — real footage v1, visuals gate, force-accept, real intel data

Prod head `5744516`, both services live, migrations through **0026**
(verify: `video_clip` in asset_kind, `visuals_review`/`profile_review` in
the enums, `production_profile` column). Two videos out: video 1 public
`kZV2iIOM7PY`; Me 262 scheduled Mon 6pm (`WK7KfdVKVPQ`, production
`01KXA87698N4RTRS2MAWC9MWEF`) — verified single, no duplicate.

## Shipped this afternoon (all deployed, on main)
1. **#33 Visuals-review gate** (8fc0d9a, migration 0025) — gated channels now
   review/swap the image set BEFORE the render; render re-reads live asset
   rows so gate-time swaps land; T2/T3 skip. Render-once flow:
   script→profile→visuals→render→final.
2. **Lambda overwrite fix** (5a868b9) — re-render over an existing
   final.mp4 (Retry-from-render was failing "Output file already exists").
3. **Thumbnail pick bug** (09671b9) — pick only sent from the FINAL gate
   (a gate replay had reset it to candidate #1); + post-publish Thumbnail
   gallery on the production page to swap the live YouTube thumbnail.
4. **#26 Real footage v1** (84cbbfe, migration 0026) — archival FOOTAGE on
   hero shots: NASA video + Internet Archive → ffmpeg-trim beat-length
   silent clip → video_clip asset → Remotion OffthreadVideo. GATED opt-in
   (visualMode real_footage/mixed + motion != static + heroShot) — DORMANT
   (Wings & Stories motion=static). apps/worker/src/footage.ts. **First
   footage render must be WATCHED at the visuals gate — no vision fit-gate
   on clips yet (v2).**
5. **Force-accept research** (08fa745) — "Accept facts & queue now" in the
   Plan ⋯ menu: cancels that episode's research (per-episode halt event),
   writes brief from facts on hand, hands off. Bypasses the facts-gate min.
6. **#32 short paragraphs** (9106eb7) — scriptwriter+humanize breath-groups.
7. **Intel = REAL + rich** (898a80c, 3fd55f6, 5744516) — RESEARCH_PROVIDER=
   youtube VERIFIED real; fixed a velocity accuracy bug (age was defaulting
   to 1h → fake "views/h"); rich thumbnail cards on BOTH the niche-intel tab
   and market page, richer stats (views/h · outlier× · age · format),
   mobile-first. **VidIQ mapping VALIDATED against live data** (real subs
   present) — see #30 for the operator key step.

## Standing operator TODOs (at laptop)
- **VidIQ**: get an API key + confirm mcp.vidiq.com bearer endpoint → set
  VIDIQ_API_KEY + RESEARCH_PROVIDER=vidiq (fills subs/growth; ~5 credits/
  scan → weekly cadence). Balance was 90.
- **Openverse OAuth** (31.c), **Render API key rotation**, YouTube OAuth
  rotation, GoDaddy cutover + droplet decommission.

## Next builds (unchanged order)
#21 eval harness → #27 operator voiceover · #23.5 seasons, #23.6 multi-
account. Footage v2: vision fit-gate on clips, footage swap in the visuals
grid, per-non-hero-beat still-vs-clip. #30: VidIQ activation.

---

# Handoff — 2026-07-12 (evening close) — TWO VIDEOS OUT; operator visual suite; mobile pass

Session end state (prod head `042c00b`, both services live, migrations
through 0024): **video 1 PUBLIC** (`watch?v=kZV2iIOM7PY`), **video 2 Me 262
SCHEDULED Mon 2026-07-13 6pm Melbourne** (`WK7KfdVKVPQ`, media verified,
**34 real / 11 AI images — 76% real vs 10% on video 1**).

## Shipped after the day section below (all deployed)
1. **Operator visual suite** (1c83591…68c48b1): every Beat-visuals tile is
   clickable with real/AI provenance tag → swap dialog: "Find another real
   photo" (deep 40-result hinted pool, used-sources excluded), regenerate on
   fal dev or nano-banana-pro, optional prompt, optional "use current image
   as reference" (nano /edit, flux /image-to-image; CC-BY(-SA) derivatives
   keep their credit); "Auto-fix N duplicate real images" one-click sweep
   (vision-gated); final gate gains "Regenerate thumbnails" with prompt +
   model picker. FAL env now on BOTH services (cockpit had NONE — both
   buttons were silently schnell); pipeline thumbnails always hero-model.
2. **Duplicate-reals fixes in the pipeline** (7bd875f, f6037a2): candidate
   rotation per entity occurrence + hint-diversified Commons queries at pick
   time, plus an automatic dedupe-real-images step before render (every
   tier) — "auto mode must not pump out rubbish". Render consumes the
   post-sweep keys.
3. **Stale-render guard** (52eea74): approving a final gate while any image
   postdates the render is blocked server-side + UI callout (operator
   almost published an old cut after swapping images).
4. **Mobile pass** (c94bef3, 042c00b): 2-up thumbnails, 3-up beat tiles,
   sticky gate actions (safe-area), dialogs are bottom sheets <560px, 44px
   touch targets, episode ⋯ menu is a dialog (popover clipped on phones).
   KNOWN GAP: calendar drag-drop is mouse-only; phones use the tap dialog.

## Verify next session
- Me 262 flips public Mon 08:00 UTC (finalizer reconciles; stuck alarm now
  exists). Compare retention/CTR video 1 vs 2 (nano thumbnail, 76% real).
- First T2/T3-style run end-to-end with the auto profile-apply + auto
  dedupe (no operator run has exercised auto-apply yet).
- The scripting "paras a bit big" tweak (#32) is spec'd, not implemented.

## Queue (operator-confirmed)
#26 real footage → #21 batch-3 eval harness → #27 operator voiceover ·
then #23.5 seasons, #23.6 multi-account · #30 real intel data (mock
fallback diagnosed — RESEARCH_PROVIDER env unset) · #31.b more archives
(NARA/LOC/Flickr Commons/Europeana). Ops debt: GoDaddy cutover, droplet
decommission, **Render API key rotation (used extensively today)**,
YouTube OAuth rotation.

---

# Handoff — 2026-07-12 (day) — FIRST VIDEO PUBLIC (kZV2iIOM7PY) + big operator batch (see evening close above)

**The first video is LIVE**: `watch?v=kZV2iIOM7PY` (jet-engine long-form,
re-uploaded after the shell incident below; verified public via oembed).
Prod head at close of the day session: `5de0573`, worker+cockpit both live,
migration 0024 applied (verified: production_profile column + profile_review
enum values).

## Shipped today after the incident guards (all deployed)
1. **Scheduler fix + drag-drop calendar (273eb91)** — weekday-first even
   spread (Sat-launch clustering fixed), drag any tentative/scheduled slot to
   another day, "Respread tentative slots" button; prod calendar respread
   (Me 262 → Mon 07-13, 4/wk weekdays only, no more 2-week gap).
2. **Archival-strength dial (f4f1b5c)** — profile "Real imagery push"
   off/light/balanced/strong/max (candidates per shot + fit bar + topic
   retry); Wings & Stories set to STRONG on prod.
3. **Per-video Production Profile stage (258c609, migration 0024)** — after
   script approval an AI pass proposes low-cost-axis tweaks from the script;
   T0/T1 pend a profile_review gate (full axis editor in the gate panel);
   T2/T3 auto-apply; chosen profile persists on productions.production_profile.
4. **Imagery overhaul (486ae0b)** — narration BANNED from generation prompts
   (the "horses pulling planes" fix: shot-sync was appending spoken sentences
   into FLUX prompts); scriptwriter emits per-beat visualBrief (the actual
   ask) + heroShot flags; every shot inherits the beat's referenceEntity
   (was shot-0-only — the real 8-vs-74 bottleneck); CC-BY-SA accepted
   (operator decision; credits in description); long-form density minShotSec
   7 / max 3 per beat (~82 → ~45 images); hero tier
   FAL_IMAGE_MODEL_HERO=fal-ai/nano-banana-pro live on the worker (2-4
   pivotal frames per video, ~$0.15 each, cost-tracked meta.hero).
5. **Plan-tab episode ⋯ menu (5de0573)** — stop & cut (halts live runs),
   replace with a new idea (operator direction steers the planner; inherits
   the slot; fires research), re-greenlight from scratch.

## Verify on the next production (Me 262, due Mon 6pm slot)
script gate → NEW profile gate (expect an archival/delivery proposal) →
visual-ask prompts in asset meta → real-image share under Strong+BY-SA →
hero images (meta.hero) → image count ~half → verify-upload-media step.

## Next builds queue (operator-confirmed order today)
#26 real video footage (headline) → #21 batch-3 eval harness/learning loop →
#27 operator voiceover · then #23.5 seasons, #23.6 multi-account. Ops debt:
GoDaddy cutover, droplet decommission, Render API key rotation (used heavily
today — rotate soon), YouTube OAuth rotation.

---

# Handoff — 2026-07-12 (morning) — SHELL-VIDEO INCIDENT: eXgnXsAjj9U had NO MEDIA; guards shipped

The "scheduled" video `eXgnXsAjj9U` was a **medialess shell**: Studio showed
"Processing will begin shortly" + Visibility "Pending" forever — YouTube had
the metadata (incl. a literal `[sprint theme]` placeholder from ctaTemplate)
but never the bytes, so the 6pm Melbourne release could never fire and the
finalize cron would have reported a quiet "pending" every 10 min. The RENDER
was fine: `productions/01KX8AZGPNDSDK5G3743H4HEFY/final.mp4` is a valid
330 MB / 8:17 MP4 in R2 (the 12:38 UTC Lambda attempt succeeded after 9
failures — 900s timeouts, then `concurrencyPerLambda=4 > 2 cores`; env is now
`REMOTION_CONCURRENCY_PER_LAMBDA=2`, FRAMES/MAX cleared, leave as is).
Operator deleted the shell in Studio 2026-07-12 morning.

Shipped guards (this commit): videoStatus now returns durationSec/
uploadStatus/processingStatus; publish-preflight re-verifies a recorded
video id (shell → fresh upload; deleted-after-live → hard fail per #10);
findRecentUpload never adopts a medialess record; new `verify-upload-media`
step fails the run if no duration appears within 3 min of upload; YouTube
upload now streams (no 330 MB buffers) and asserts the sent byte count;
publish-finalize raises a deduped `publish_stuck_alert` agent action +
console.error when a slot passes and the video is still private; worker
`/store/*` is loopback-only (it was serving private masters to the
internet); unfilled `[placeholder]` ctaTemplates are dropped from
descriptions with a loud log — **operator: fix the channel's ctaTemplate in
Settings & DNA, then re-fire publish from the cockpit** (preflight sees the
deleted id + null publishedAt and uploads fresh; render is reused).

---

# Handoff — 2026-07-12 (overnight close) — FIRST REAL VIDEO LIVE-SCHEDULED; Lambda renders; intel tab; big-day incident fixes

Marathon session (2026-07-11 → past midnight). The platform produced and
scheduled its **first real YouTube video**: `watch?v=eXgnXsAjj9U` (Hangar
Histories long-form), goes **public 2026-07-12 08:00 UTC = 6pm Melbourne**
via the release finalizer cron — **verify it flipped to public**. Prod head
at close: `81c9780` (deploy watcher was confirming worker+cockpit live as
the session ended — check Render if in doubt; preDeploy runs migrations,
0023 included).

## What shipped tonight (all on main, deployed)
1. **Remotion Lambda render farm (#18)** — ap-southeast-2, quota 1000
   approved, long-form renders ~83s/$0.20 (was ~28min on the worker).
   Runbook: `docs/LAMBDA.md`. Worker CPU render remains the config fallback.
2. **Idempotent publish** — upload split into preflight → upload →
   record-id → thumbnail → finalize with orphan adoption (fixes the
   FOUR-duplicate-uploads incident; operator deleted 3 dupes in Studio).
3. **Scripting-loop cost fix** — memoized per-step drafting + surgical
   `repairScriptFactuality` (the $2.31 / 11-Opus-drafts incident).
4. **Series scheduling (#23)** — tentative slots honor the channel
   ReleasePlan ramp (3/wk fixed), gap-fill replacements (fired in real
   life: MiG-15 replacement at position 12 — **operator to keep or cut**),
   rebuilt Schedule calendar, per-step Retry buttons, halt-current.
5. **Niche intel tab (#23.3)** — per-channel competitors/what's-working/
   90-day trending feed, Daily/Weekly/Off cadence, migration 0023
   (`channels.intel_cadence`, `channel_competitors`), janitor 90d sweep.
6. **Reliability pair** — voiceover word-timestamps OUT of Inngest step
   state (prime suspect for big-run "Invalid signature" stalls; now read
   from the asset row) + `repairDoubleEncodedJson` unwraps single-key
   `{"parameters":{…}}` envelopes (gpt-5-mini idea-autoscore crash).
7. **First-video quality feedback (#26 partials)** — captions ON long-form,
   persona pace → TTS speed, archival-first imagery, sentence-synced shot
   prompts, garbled-text image check, thumbnail radio fix.
8. **Image quality (#29)** — operator: fal output "not worthy of being put
   up" on the next two videos. Root cause candidate: we were on the
   provider-default `fal-ai/flux/schnell` (cheapest tier) all along.
   `FAL_IMAGE_MODEL=fal-ai/flux/dev` is now set on the Render worker
   (active with the 81c9780 deploy, ~+$2/long-form). **Re-generate visuals
   on the two bad videos before publishing**; full generator bake-off is
   backlogged behind the eval harness.

## Operational loose ends (check these first next session)
- **Video go-live**: confirm eXgnXsAjj9U went public at 6pm Melbourne.
- **Gloster Meteor episode**: reset to `planned` (bad-claims purged); the
  research re-fire timed out — re-fire from the Plan tab.
- **MiG-15 gap-fill episode**: operator decision — keep as ep 13 or cut.
- **Two "crazy images" productions**: regenerate visuals under flux/dev.
- Older ops debt: GoDaddy DNS cutover, droplet decommission, **Render API
  key rotation** (token lives in ~/.claude.json — flagged), YouTube OAuth
  key rotation after the bootstrap-key episode.

## Not built (parked with specs in BACKLOG)
Real video-footage embedding (#26 headline) · operator-recorded chunked
voiceover (#27) · learning loop + eval harness (#21 batch 3 — unblocks
Opus-escalation, TTS preprocessing, generator bake-off, persona-tweak
experiments) · seasons (#23.5) · multi-account email mgmt (#23.6) ·
controls polish batch (regenerate-thumbnails button, true mid-step halt,
archival-strength dial).

---

# Handoff — 2026-07-11 — #21 batches 1+2 SHIPPED (personas, humanize, factuality modes, image-prompt builder)

Laptop session. Implemented the prompt-audit + BACKLOG #21 design set (see
`docs/PROMPT-AUDIT.md` + BACKLOG #21.1–21.6). Typecheck 13/13, cockpit prod
build, all unit suites green (core 91, providers 79, worker 4). **RUNTIME-VERIFIED same day**: Docker restarted, migration 0019 applied
locally, full mock E2E green through Inngest (commit 1267036) — wizard →
research → humanize → proof → gates → render → thumbnail/final review →
uploaded + scheduled. Also caught+fixed a #20 gap: the mock LLM had NO
TASK:factuality-proof route, so EVERY fact-gated mock pipeline failed at
scripting (schema error). Persona v1 + provenance, humanize edit-notes,
built image prompts (Style/Mood suffix) all confirmed in agent_actions/
assets. Still owed: real-provider production (hear the humanize delta),
dark/390px screenshot pass, **migration 0019 on Render before next prod run**.

## Shipped (commits 2abd254 + c88271d)
1. **Writing personas (#21.1)** — `personas` table (migration 0019, + claim_status
   'conjecture', dna.active_persona_id, productions.persona_id/version);
   archetype library (5 seeds) in core; persona generator agent (frontier);
   scriptwriter system prompt rebuilt persona-first (Identity→Rules→Exemplars);
   pipeline auto-seeds legacy channels; Persona tab (view doc, versions,
   explicit activate, AI redraft-with-tweak lands as draft).
2. **Humanize/editor pass (#21 / audit §4.2)** — every draft passes through
   `humanizeScript` (merged operator IG patterns, persona-voiced,
   fact-constrained by mode, beat-count + length fail-safes) BEFORE factuality
   proof; proof re-audits the humanized text each rewrite loop.
3. **Factuality modes (#21.3)** — verificationBar.factualityMode
   strict/balanced/entertainment; decideClaimStatus emits CONJECTURE outside
   strict; episode + pipeline facts gates count tellable (verified+attributed+
   conjecture) and skip entirely on entertainment; brief/scriptwriter carry a
   hedged-framing CONJECTURE block; proof + board compliance audit FRAMING
   (balanced) or harm-only (entertainment). Settings & DNA has the dial.
4. **Wizard proposes what WORKS (#21.4)** — charter agent reasons mode +
   personaArchetype with rationales; wizard UI: rigor segmented control +
   persona picker; creation generates + activates persona v1 (LLM, safe
   fallback to seed).
5. **Image-prompt builder (#21 / audit §4.4)** — per-shot FLUX prompts
   (subject-first, explicit lighting, film-stock realism, one shared
   Style/Mood suffix, positive-only), **profile.artDirection finally wired**;
   asset meta keeps draft + final prompts.
6. **Temperature policy (audit §4.5)** — temperatureFor(modelId, kind)
   creative 0.9 / editor 0.7 / judge 0.2, omitted on OpenAI reasoning models.

## Render migration state (2026-07-11, later) — 0019 APPLIED + root cause fixed
- **Deploys never ran migrations**: the live services were created by hand
  during the Render migration, so render.yaml's `preDeployCommand` was NOT on
  the real worker service — every "live" deploy since has skipped migrate.
- Migration 0019 applied to the live DB manually (drizzle-kit + external URL,
  `sslmode=require` — without it drizzle exits 1 silently). Verified: personas
  table, conjecture enum value, journal at 20.
- `preDeployCommand: pnpm --filter @ytauto/db migrate` set on the worker via
  the API (PATCH serviceDetails.preDeployCommand) and PROVEN with a triggered
  deploy (build → pre_deploy_in_progress → live).
- Live DB has **0 channels** — the Airframe Minute smoke-test channel was
  deleted post-test (cascade took ideas/productions/publications); secrets
  (incl. YouTube tokens) intact. Not data loss.
- Drift note for the operator: DB plan is basic_256mb; render.yaml wants
  basic-1gb. Bump in the dashboard when pgvector memory grows.

## Verify on next run (in order)
- `pnpm db:migrate` locally AND **confirm migration 0019 applied on Render**
  (deploy runs it? check — ALTER TYPE + personas table + 3 columns).
- Mock E2E: wizard → charter (expect factualityMode+persona rationales) →
  create (persona v1 active on Persona tab) → greenlight → expect
  humanize edit-notes agent_actions row, conjecture in gate evidence,
  build-image-prompts step, persona provenance on the production row.
- Real run on Airframe Minute: script should read noticeably more spoken;
  check agent_actions for humanize_editor + image_prompt_builder rows and
  the new image prompts in asset meta (Style:/Mood: suffix, no negations).
- Screenshot pass: wizard Verification + Voice&style, Persona tab, Settings
  rigor dial — light/dark, desktop/390px (NOT done: Docker was down).

## Deliberately deferred (batch 3 — BACKLOG #21.5/21.6 + audit leftovers)
- Learning loop: channel_playbook + retro agent + experiment queue +
  influence hierarchy in ideation/scoring prompts (hierarchy preamble IS in
  the scriptwriter already); maturity phases + performance windows.
- LLM_MODEL_ESCALATION slot (pay-Opus-on-failure) + golden-set eval harness
  (audit §6 smoke tests) — eval harness first run doubles as the A/B.
- TTS preprocessing; prose-first drafting A/B; agent-proposed persona tweaks
  riding the experiment machinery end-to-end (schema seam exists:
  personas.status='testing', experiments variable='persona').

# Handoff — 2026-07-11 (cloud session) — #20 platform polish batch 1 SHIPPED to main

Design was locked first as a clickable prototype (operator-approved, artifact
"Platform polish — design plan"). Then implemented + smoke-tested on a real local
stack IN the cloud container (apt Postgres 16 + pgvector, mock providers, Playwright
+ bundled Chromium): full wizard walk → channel created → Plan tab; 18/18 smoke
assertions; light/dark, desktop/390px screenshots; zero console errors. typecheck
13/13, prod build, all unit suites green. No migrations.

## Shipped
- **UI primitives** Tile / Switch / Stepper / Disclosure (`components/ui`, demoed on
  /design-system) — the Profile-tab pattern as shared components.
- **Wizard**: Blueprint step (format/rigor/autonomy tiles, release-plan steppers +
  live ramp chart, pinned CTA), identity cards (collapsed concepts, inline re-roll),
  review as four summary cards with "AI default"/"Your steer" chips, checkable
  YouTube provisioning list. Rigor default now "standard" (matches bar=1).
- **Plan tab**: one-line pipeline strip (ⓘ expander), charter header card, dual-drive
  steer strip, research health = stat tiles + proportion bar + cut-facts disclosure,
  series progress cards with status pills + compact episode rows (facts popup kept).
- **Dual-drive backend**: charter settings/objective edits insert `operator_steer`
  decision rows → already flow into planner/writer prompts via channelStateSummary.
  Verified E2E on the local stack.

## Next (batch 2, after operator feedback)
- Briefings-tab elevation to the same bar; Settings & DNA ↔ Profile dedupe (#19).
- Steer recording for episode re-orders/cuts + surfacing steers in briefings.
- Operator tweak pass ("we can tweak a bit further" — collect notes in the app).

---

# Handoff — 2026-07-10 (cloud session) — publish rework (#20 batch 1-5) SHIPPED to main

Cloud session (remote container). Worked the top five operator items from BACKLOG #20
end-to-end; typecheck (13/13) + cockpit prod build + full unit suite green (76 provider
tests incl. a new publishAt/reschedule contract test). **No migrations** (privacyStatus
is text; no new columns). NOT runtime-verified — the cloud sandbox can't pull Docker
images (proxy blocks registry blobs), so the first E2E through Inngest + a screenshot
pass on the lightbox/publish controls are owed on the laptop.

## Shipped (one commit batch, merged to `main`)
1. **YouTube-native publishAt scheduling (the preferred direction).** Pipeline uploads
   IMMEDIATELY on final approval with `status.publishAt`; YouTube flips public at the
   slot. No `sleepUntil` holds videos any more. `publications.privacyStatus` gains
   `scheduled`; new `publish-finalize` cron (*/10) does go-live bookkeeping + fires
   `production/published` / derive-shorts at ACTUAL publish time (shared
   `markPublicationLive` in core). `PublishProvider.upload` gained `publishAt`, plus a
   new `schedule()` (reschedule = one videos.update). `publish-clip` uses the same
   path. Release-button crash fixed: "Publish now — skip the schedule" + "Move
   schedule" controls on the production page (`publish-controls.tsx`), actions return
   `{error}`. Needs `youtube.force-ssl` scope (already shipped 2026-07-10; re-connect
   channels connected before that).
2. **Corroboration bar default → 1** (wizard standard=1/deep=2, drafter prompt, mock).
3. **Force-forward = resume the SAME production.** No new row, no regeneration:
   `bypassChecks` set + `production/greenlit` re-fired with an `attempt` nonce
   (idempotency key is now productionId+attempt — also fixes the #18 failed-run
   re-fire dead-end). All greenlit senders now pass `attempt` (required field).
4. **Factuality proof in scripting.** `proveScriptFactuality` proof → rewrite loop
   (≤2 rewrites) inside the draft step on fact-constrained channels; fail → on_hold +
   `factuality_proof` evidence row BEFORE any asset spend; gate shows "Factuality
   proof passed"; review board stays as backstop.
5. **Image lightbox** (`components/ui/lightbox.tsx`): beat visuals click-to-expand;
   thumbnail candidates get a hover expand button.

## Verify on the laptop (first run after deploy)
- Drive one gated production: approve final gate with a future date → expect the
  upload to happen immediately, publication chip "Scheduled — goes public
  automatically", YouTube Studio showing the scheduled time; then either wait for the
  slot (finalizer flips the row within ~10 min of it) or hit "Publish now".
- Force-forward a held production → same production id resumes, stepper does NOT
  regenerate voiceover/images (watch the cost table).
- Deliberately under-research an episode → the factuality proof should rewrite/hold
  at scripting, before any voiceover/images exist.
- Lightbox + publish controls: screenshot pass light/dark, desktop/390px.
- ⚠️ Legacy sleeping publish runs (scheduled before this deploy) wake into the new
  code path: they upload on wake and stay private until manually released. The
  Airframe Minute mock-scheduled test from the Render smoke test may do this.

## Follow-up shipped same day (operator ask: "operate in the platform, not YouTube")
- **Cancel schedule** — provider `schedule({ publishAt: null })` clears YouTube's
  pending publishAt (video stays uploaded + private until release);
  `cancelScheduledReleaseAction` + button on the production page.
- **Calendar click → popup with controls** — clicking a video in the day-detail panel
  (channel Schedule tab + Overview) opens Publish now / Move schedule / Cancel
  schedule + a production link. Every action is one API call that propagates to
  YouTube; the platform calendar is the source of truth.
- **YouTube→platform reconciliation** — `publish-finalize` now reads each scheduled
  video's real status (`PublishProvider.videoStatus`): went public → marked live +
  post-publish events; Studio reschedule → scheduled_for follows; Studio
  cancel/deleted → back to private-until-release; mock/read-error → time-based
  fallback. Verify on a real video: the API-clears-publishAt behaviour of
  videos.update (cancel path) is documented-but-unexercised.

- **Melbourne timezone (also shipped)** — every cockpit timestamp renders
  Australia/Melbourne (`DISPLAY_TZ`, override via `NEXT_PUBLIC_DISPLAY_TZ`); the
  calendar buckets days in Melbourne time; every schedule input is Melbourne wall
  time (`zonedInputToIso`, DST-verified both boundaries; storage stays UTC). Fixed
  the final-gate schedule input being parsed in SERVER time (UTC) — an 18:00 entry
  used to mean 4am Melbourne.

## Still open in #20 (next up)
- (publish/schedule block fully landed) — next: #20 polish pass (wordy surfaces →
  Profile-tab quality + dual-drive), archival-first imagery, per-channel
  auto-release visibility setting.
- Per-channel auto-release-to-public visibility setting (T2/T3).
- The #20 polish pass (wordy wizard/charter/Plan surfaces → Profile-tab quality) and
  the dual-drive model.
- Archival-first imagery (entity tagging / no-text prompts / fal conditioning).

---

# Handoff — 2026-07-10 (laptop) — RENDER MIGRATION COMPLETE; E2E smoke test passed (mock publish)

Laptop session. **The Render migration is done.** Full E2E on Render: wizard →
charter → plan/research/fact-check/brief → auto-score 8.0 → greenlight → script
gate → voiceover + 12 images → render (52MB `final.mp4` **in R2**) → thumbnail +
final review → approve → **scheduled via mock-publish**. Channel: "Airframe
Minute" (aviation-history Shorts, T1).

## What was done (all via Render API + browser; no code changes except BACKLOG)
- Env vars set: cockpit `PUBLIC_BASE_URL`/`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`/
  `INNGEST_EVENT_KEY`/`S3_*`; worker `S3_*` + **`NODE_OPTIONS=--max-old-space-size=3072`**
  (the render OOMs Node's default ~2GB heap cap — this var is REQUIRED for renders).
- Secrets re-keyed local→Render DB (`scripts/rekey-secrets.mjs`, 8/8 verified on /account).
- R2 creds verified (put/get/delete) and set on both services; media lands in R2.
- Inngest re-registered to the Docker worker ("Successfully registered").
- YouTube OAuth redirect registered in Google Cloud Console (operator).
- Custom domain `app.commongroundsocial.com.au` pre-added to the cockpit service
  (unverified until the GoDaddy CNAME flip — see "Remaining" below).
- Worker plan: starter → pro (temp, for the render test) → **back to starter**.
  ⚠️ RENDERS WILL OOM ON STARTER (512MB) — bump to pro for any render until
  **Remotion Lambda** ships (operator-picked NEXT BIG TICKET after first real
  YouTube publish; see BACKLOG).

## Remaining (operator decisions)
1. **Real YouTube publish** — connect the channel (Settings & DNA → Connect
   YouTube; redirect URI already registered) and publish private. First hurdle.
2. **Domain cutover (zero-downtime, do BEFORE decommission):** GoDaddy → DNS →
   change `app` record from the droplet A-record to CNAME `ytauto-cockpit.onrender.com`
   → wait for Render to show the domain verified + cert issued → update cockpit
   `PUBLIC_BASE_URL` to `https://app.commongroundsocial.com.au` + add that
   redirect URI in Google Cloud Console.
3. **Decommission the DigitalOcean droplet** (after 1+2 verified).
4. **Rotate the Render API key + R2 creds + Cloudflare token** (pasted in chat).
5. Operator feedback backlogged this session (BACKLOG #20 + additions):
   platform polish/dual-drive, corroboration bar default→1, factuality proof in
   scripting (not assembly), force-forward should resume not re-run, image
   lightbox, archival-first imagery + no-text prompts + fal image conditioning.

## Smoke-test learnings (already in BACKLOG #20 area)
- Render (starter AND default Node heap) OOMs: exit 134 ×3 on starter, then V8
  "heap out of memory" on pro until NODE_OPTIONS was set. 45s Short ≈ 16 min on
  pro (2 CPU, swangle) — Remotion Lambda is the real fix.
- Force-forward mints a NEW production and regenerates media (3× voiceover/image
  spend this session) — resume-from-halt semantics backlogged.
- A worker redeploy mid-run 502s Inngest and can burn the run's retries — avoid
  pushing to main while a production is in flight (auto-deploy on commit).
- The wizard/Plan flow is too wordy (operator) — see BACKLOG #20 polish pass.

---

# Handoff — 2026-07-10 — Live status system shipped + Render migration prep; PICK UP ON THE LAPTOP

Cloud session (remote container). Two features shipped and **merged to `main`**
(`2dc6258` — Render auto-deploys from `main`, so both are rolling out now). The
Render migration itself is still the open item — the operator is moving to the
laptop specifically to finish it, because the cloud session hit two hard walls
(below).

## Shipped to `main` (typecheck + build + full test suite green)
- **Live status system (task #21)** (`2dc6258`) — the operator's #1 UX ask, done:
  `lib/status.ts` maps every production status → working / waiting-on-you /
  scheduled / live / halted; `StatusBadge` (components/ui) renders it identically
  everywhere (pulsing dot while working); a per-production **pipeline stepper** on
  the production page (Script → Voiceover → Visuals → Assemble → Final review →
  Publish; spinner on active, amber at gates, red stage + failure reason when
  stopped — artifact-aware for stopped runs); a **system-status strip** ("N in
  production · N scheduled · N need you · N failed") in the global topbar (polls
  new `/api/status/summary` every 15s) and on the Overview. Live advancement
  rides the existing `/api/live` SSE → router.refresh() (BACKLOG #17). Verified
  with screenshots on a seeded local stack: light+dark, desktop+390px, all five
  status kinds.
- **Render migration tooling** (`419d530`) — `scripts/rekey-secrets.mjs` (secrets
  table migration between DBs: decrypt with source key → re-encrypt with target
  key → upsert → round-trip verify; `--dry-run`; channel tokens skipped by
  default; **tested E2E against the real crypto** incl. the wrong-key path) +
  **`docs/RENDER-RESUME.md`** — the 5-step operator checklist to finish the
  migration. That doc is the migration runbook; below is only what changed since.

## Render migration — state after this session (START HERE ON THE LAPTOP)
Nothing on Render itself changed this session. Two blockers stopped remote work:
1. **The cloud container has no Render access** — the Render MCP from 2026-07-09
   lives in the LAPTOP's `~/.claude.json` (still needs a Claude restart + `/mcp`
   auth once, if not already done). The operator then created a **Render API key**
   and pasted it into the cloud session, but the session's **egress network policy
   blocks `api.render.com`** (proxy 403, org policy — not routable-around).
   → On the laptop, none of this applies: use the Render MCP (or the API key)
   directly. **The API key was shared in a chat session — rotate it after the
   migration.**
2. **The secrets re-key must run on the laptop anyway** — the encrypted keys are
   in the laptop's local Postgres and decrypt only with the local `.env` key.

**Laptop order of operations** (details in `docs/RENDER-RESUME.md`):
1. Flip the worker to **Docker** (or recreate from the Blueprint) + re-sync
   Inngest (12 fns). This is THE gap — native worker cannot render (no Chromium).
2. Run `scripts/rekey-secrets.mjs` (`--dry-run` first) with the Render External
   DB URL + the Render `SECRETS_ENCRYPTION_KEY`.
3. `PUBLIC_BASE_URL` on the cockpit + register the YouTube OAuth redirect in
   Google Cloud Console (Settings tab shows the exact string).
4. R2 `S3_*` env on both services (needs an R2 API token: Object Read & Write on
   bucket `ytauto`).
5. Smoke test (wizard → greenlight → render → publish) → decommission droplet.
   The new status stepper/strip (#21) is the progress instrument for this run —
   it's live on `main`.

## Next feature queue (unchanged, BACKLOG #19)
- IA cleanup: production-timing under Profile; dedupe Settings & DNA vs Profile.
- Warm-up ramp redesign (compact toggles + editable numbers + post-warm-up
  steady videos/month).
- Schedule calendar visual polish; then AI plan & auto-scheduling.

---

# Handoff — 2026-07-09 — Production Profile, engagement fixes, Schedule calendar, + Render migration (in flight)

Huge session. Shipped a stack of pipeline/engagement/UX features to `main`, then
started migrating the whole platform **off the DigitalOcean droplet onto Render**
(the operator wanted faster frontend iteration + a smoother app). The migration is
**~80% done and paused mid-flight** — read "Render migration state" below before
touching anything, and pick it up from the remaining checklist.

## Shipped to `main` today (all typecheck+build+tests green; most runtime-verified live)
- **Facts-gate** (`a027239`) — per-channel `verificationBar.minFactsToScript` (default 3);
  blocks scripting below the bar at the episode-research brief (cut) + the production-
  pipeline factuality gate (on_hold). "No full scripts on 1 fact."
- **Production Profile** (`e44143d`) — per-channel **Profile tab**: tile-picker control
  dashboard (visual style · motion · rhythm · captions · music · persona voice+delivery)
  + live 9:16/16:9 preview + free-text art-direction/notes. `channel_dna.production_profile`
  jsonb (migration 0016) + `resolveProductionProfile()` defaults. Operator-approved as a
  clickable artifact prototype before porting.
- **Profile axes wired into the pipeline:** captions (`4c2d80a`, gate the always-on
  karaoke overlay), visualMode + delivery (`5748b12` — ai-images force generation;
  delivery→ElevenLabs voice_settings), rhythm via **planShots** (`a622e69` — sub-divide
  beats into rhythm-cut shots, one image each → fixes "boring stills"), and **image
  relevance scoring** (`ba68620` — a vision model rejects a wrong sourced photo → generate
  instead; verified live: Spitfire 9 KEEP / banana 0 REJECT). **#4 complete.** Still
  needing their own features: motion AI-video (#6 Higgsfield), music (#5).
- **Schedule bridge + Plan & Schedule calendar** (`b836d75`, #8) — root cause: a
  `publications` row was only written at UPLOAD time, so the schedule was invisible + no
  calendar possible. Now the row is created at SCHEDULE time (nullable video cols,
  migration 0017); gated T1 channels auto-slot onto the warm-up ramp; new `ScheduleCalendar`
  on the channel Schedule tab (+ plan→publish funnel) and the Overview.
- **Inline Plan-tab actions** (`a9d7d50`) — score + greenlight an episode from the Plan
  tab (no trip to Ideas); live production-status chip inline; **auto-score** editorial ideas
  at handoff. Diagnosis: manual scoring always worked; there was just no auto-scoring and
  editorial ideas skipped `scored`.
- **Perf** (`dc8b924`) — instant loading skeletons (channel page + Overview), parallelized
  the channel page's ~11-query waterfall into one `Promise.all`, + FK indexes (migration
  0018). The cockpit was slow because force-dynamic pages blocked on a serial SSR waterfall
  with no loading state.
- **Bug fixes** (`0da4e42`) — voice picker falls back to premade voices when the ElevenLabs
  key lacks `voices_read` (dropdown was showing a raw text box); resume a halted production
  even with no script draft (early halts); a Settings-tab helper showing the exact YouTube
  OAuth redirect URI to whitelist.
- **Deploy** (`75e4c2f`, `dc8b924`) — all-on-Render `render.yaml` blueprint + rewritten
  `DEPLOY.md` runbook (R2 + Inngest Cloud + migrate/fresh).

## Render migration state (IN FLIGHT — resume here)
Operator is moving the whole app to **Render** (retiring the droplet + DigitalOcean).
Decisions locked: **Cloudflare R2** for media · **Inngest Cloud** · **start FRESH** (no data
migration). Also changed the **GitHub default branch → `main`** (was a stale feature branch,
which caused Render to deploy an old build).

**✅ Done:**
- Cockpit + worker + Postgres all **green on Render**, deployed from `main`.
- Inngest Cloud synced — **12 functions** registered (worker on current code).
- R2 bucket `ytauto` created (endpoint `https://2f3618b63e3f27f022f58490e344d7fe.r2.cloudflarestorage.com`).
- Migrations applied on Render Postgres.
- Render MCP added to `~/.claude.json` (HTTP, user scope) — **needs a Claude restart + `/mcp`
  auth (render)** to activate; once live, next session can drive Render directly.

**⏳ Remaining (next session):**
1. **Worker is NATIVE, not Docker** → **video renders WILL FAIL** (no Chromium). This is the
   one real gap. Flip the worker to a **Docker** web service (Dockerfile `apps/worker/Dockerfile`,
   context `.`, branch main, health `/healthz`, higher-CPU plan) + re-sync Inngest.
   *(Cockpit + worker were created as NATIVE Node services, not from the Blueprint — that's why
   both needed Start Commands set: cockpit `pnpm --filter @ytauto/cockpit start`, worker
   `pnpm --filter @ytauto/worker start`. The Docker blueprint avoids all that.)*
2. **Migrate the secret keys** — ✅ script SHIPPED 2026-07-10: `scripts/rekey-secrets.mjs`
   (tested E2E against the real crypto: decrypt-local → re-encrypt-target → round-trip verify;
   `--dry-run` supported; channel tokens skipped by default). Run it LOCALLY with
   `TARGET_DATABASE_URL` (Render External URL) + `TARGET_SECRETS_ENCRYPTION_KEY` — see
   **`docs/RENDER-RESUME.md`** (the full 5-step operator checklist for this whole section).
   Fallback: re-enter on `/account`.
3. **`PUBLIC_BASE_URL`** on the cockpit = its Render URL, + register
   `https://<cockpit>.onrender.com/api/oauth/youtube/callback` in Google Cloud Console (the
   Settings-tab helper shows the exact string).
4. Confirm `S3_*` (R2) env set on **both** services (needs the R2 API token — Access Key ID +
   Secret from R2 → Manage R2 API Tokens).
5. Smoke test: fresh channel via wizard → Score/Greenlight from Plan → render (needs the Docker
   worker) → publish. Then decommission the droplet.

## Still-open feature requests (operator, today — after the migration)
- ~~**Live status system** (task #21)~~ — ✅ SHIPPED 2026-07-10. One status language
  everywhere: `StatusBadge` (lib/status.ts maps every production status → working /
  waiting-on-you / scheduled / live / halted; pulsing dot while working), a per-production
  **pipeline stepper** on the production page (Script → Voiceover → Visuals → Assemble →
  Final review → Publish; spinner on the active stage, red stage + reason when halted;
  advances live via the existing /api/live SSE refresh), a **system-status strip**
  ("N in production · N scheduled · N need you · N failed") in the global topbar (polls
  /api/status/summary every 15s) and on the Overview, and StatusBadge swapped in across
  the channel In-production/Videos tables. Verified with screenshots: light+dark, desktop
  +390px, all five status kinds.
- **IA cleanup:** move production-timing (warm-up ramp) UNDER Profile; strip anything the
  Profile tab covers OUT of Settings & DNA (dedupe).
- **Warm-up ramp redesign:** it hogs space — compact to toggles + editable numbers on the
  right that lock the cycle, PLUS a post-warm-up steady setting (videos/month, hand-editable);
  the on-page AI should be able to tweak it (chat or auto from analysis loops).
- **Schedule calendar** visual polish (to Profile-tab quality).
- **AI plan & auto-scheduling:** on-page AI chat about the plan + an "AI review & schedule"
  button that reads the series/targets/channel state and slots all planned videos onto the
  calendar (produced or not), a cadence review, and at-risk flags ("publishes in <1d, nothing
  ready").
- Deferred perf: `b) per-tab lazy loading` (lower priority once on Render).

---

# Handoff — 2026-07-08 (evening) — first watchable long-form, Tavily research, Plan-tab rework

Same day, evening session. Docker/Postgres back up; ran the **full local stack**
(worker + cockpit) with **real providers** against the local sandbox DB/store, and
drove a real aviation long-form (**Hangar Histories**) end-to-end to the **first
watchable, operator-approved video** (as a test). Detailed capture in **BACKLOG #18**.

**Prod state:** `main` @ `7f194f7` (Tavily connector) — pushed; droplet auto-deploys.
This session's commits: `d710dfb` OpenAI schemaCompat · `d7e7ecb` Stop/Restart+cap3 ·
`a303715` Plan-tab rework · `f01dc25`/`3a92791` Tavily/Exa/Sonar key slots · `7f194f7`
Tavily connector. (STORE_DIR + Adam voice + v3→v2 model are **local `.env`/DB** changes,
not committed — see the local-config note.)

## Shipped this session (see BACKLOG #18 for detail)
- **Tavily research connector** — one search → clean multi-domain sources → the existing
  extract/verify. **Verified live:** 7+ distinct domains (vs old single NTRS); a claim
  corroborated across 4–5 domains; ~$0.016/search. Legacy scrape stays as fallback.
- **Plan-tab rework** — pipeline explainer, plain-English statuses, compact Research-health
  strip (collapsible cut-facts), click-an-episode → facts popup.
- **Stop/Restart research + 3-concurrent-per-channel cap.**
- **OpenAI/GPT-5 structured-output fix** (schema sanitizer).
- **STORE_DIR media-serving fix** — worker/cockpit were reading different `./data/store`
  dirs → cockpit 404'd all media; moved to repo-root `data/store` + absolute STORE_DIR.
- **Adam voice** (channel + global fallback); **first long-form video rendered E2E**
  (Adam `multilingual_v2`, 7:51, 303 MB) to the final gate — approved.

## Critical findings from the run
- **v3 can't do long-form** — `eleven_v3` caps at 5000 chars; scripts run ~6700 → 400
  `text_too_long`. Fell back to `multilingual_v2`. v3 needs text-chunking.
- **Long-form render is slow** — ~28 min for 8-min/14k-frame on CPU `swangle` @ conc 2.
- **Render fragility** — Remotion loads beat images over `http://localhost:3010/store`;
  a stale/zombie worker (tsx-watch `EADDRINUSE` churn) served the wrong store path → 404
  → render failed. Read bytes from the ObjectStore directly instead.
- **Failed force-forward dead-ends** — pipeline idempotency keyed on productionId; a
  failed run can't be re-fired (had to mint a fresh production).
- **Auto-publish/auto-schedule still UNPROVEN** — reached the final gate, nothing has
  been uploaded/scheduled/published to YouTube E2E yet.

## Local-config note (not in git — re-apply on a fresh clone/machine)
- `.env`: `STORE_DIR=<repo>/data/store` (absolute), `ELEVENLABS_VOICE_ID=pNInz6obpgDQGcFmaJgB`
  (Adam), `ELEVENLABS_MODEL_ID=eleven_multilingual_v2`.
- DB: `channel_dna.voice_id` = Adam for Hangar Histories; Tavily key stored under
  `TAVILY_API_KEY` on `/account` (moved off the mislabeled `S3_ENDPOINT` slot).

## Suggested sequence (next up) — operator's list + this session's findings
1. ~~**Facts-gate + constrain the writer**~~ — ✅ SHIPPED 2026-07-09 (`a027239`,
   BACKLOG #18). Per-channel `verificationBar.minFactsToScript` (default 3) blocks
   scripting below the bar at both the episode-research brief (cut) and the
   production-pipeline factuality gate (on_hold). Writer-constraint was already in
   place. Not yet exercised E2E through Inngest — verify on the next real run.
2. ~~**Production Profile scaffold (control plane)**~~ — ✅ SHIPPED 2026-07-09 (`e44143d`,
   BACKLOG #18). Per-channel **Profile tab**: tile-picker dashboard (visual style · motion ·
   rhythm · captions · music · persona voice+delivery) + live 9:16/16:9 preview + free-text
   art-direction/notes. `channel_dna.production_profile` jsonb (migration 0016) +
   `resolveProductionProfile()` defaults; VoicePicker wired into Persona. Each axis is a
   seam (tagged live/soon). Runtime-verified live on the local stack (tab render light+dark,
   16:9 long-form preview, save round-trip persisted to `production_profile`). **Axes now
   wired into the pipeline:** captions (`4c2d80a`), visualMode + delivery (`5748b12`). Still
   read-but-waiting on unbuilt features: motion AI-video (#6), music (#5), rhythm cutting (#4).
3. ~~**Captions on Shorts**~~ — ✅ SHIPPED 2026-07-09 (`4c2d80a`). The karaoke overlay
   already existed but was always-on; now gated on `productionProfile.captions` (default
   ON Shorts / OFF long-form) — the first wired Profile axis. Verified via unit test +
   Remotion still (burns in when on, nothing when off).
4. **Image density + rhythm cuts** — ✅ cut 1 SHIPPED 2026-07-09 (`a622e69`). `planShots`
   sub-divides beats into shots cut on the spoken rhythm (sentence/pause from word
   timestamps), one image per shot → the frame keeps moving; lights up the Profile rhythm
   axis. Fixes the "boring stills" note. **Cut 2 also SHIPPED (`ba68620`):** image relevance
   SCORING — a vision model scores whether a sourced Wikimedia image fits the shot; poor fit
   → generate instead (verified live: Spitfire 9 KEEP / banana 0 REJECT). **#4 complete.**
5. **Background music** — optional ducked music bed (per-channel toggle).
6. **Higgsfield AI video (partial first)** — motion on key beats; gated by the Profile.
7. **Long-form render speed** — concurrency bump / GPU / cloud render; also move the
   render to read from the store directly (removes the :3010/store failure mode).
8. **Schedule bridge + Calendar UI** — ✅ SHIPPED 2026-07-09 (`b836d75`). The schedule was
   invisible (no `publications` row until upload time); now the row is created at schedule
   time (nullable video cols, migration 0017), gated channels auto-slot onto the ramp, and
   there's a **Plan & Schedule calendar** on the channel Schedule tab (+ plan→publish funnel)
   and a cross-channel Overview Schedule tab. Verified live. **Remaining:** the full
   worker-driven approve→scheduled→published (mock) run, and real-YouTube publish (needs the
   test channel connected).
9. **Expand-images lightbox** on the production review page (quick).
- **Deferred:** v3 chunking; Exa/Sonar connectors; STORE_DIR default hardening +
  failed-run retry + dev kill-port story; optional render compression (CRF/h265).

---

# Handoff — 2026-07-08 (morning) — first live walkthrough

First end-to-end live walkthrough of **channel creation → production pipeline**
on prod (`app.commongroundsocial.com.au`). Focus was validating the flow and
fixing whatever blocked it. Docker/Postgres was down on the dev machine all
session, so everything was built against static gates (typecheck/build/tests)
and validated by the operator on the live droplet.

## Shipped today (all merged to `main` + deployed)

**Wizard / setup UX**
- Pre-filled step-1 fields (format, research depth, cadence, length, autonomy,
  monetisation-safe), Back-nav + clickable step chips, persistent co-pilot dock,
  "Generate 3 more" identities, channel avatar generation, **draft autosave**
  (localStorage — survives refresh/crash), review-step **preset objectives**
  (tick + counters) and **tone quick-pick chips**.
- Tabbed **/account** — Models tab (per-tier vendor+model picker) + API keys tab.
- **Channel deletion** — Danger-zone button on Settings & DNA with a Dialog
  confirm (transactional child cleanup).

**Bug fixes (in order found)**
- **Qwen json_object** — DashScope needs the word "json" in the prompt; added an
  `ensureJsonWord` middleware (`packages/providers/src/real/llm.ts`).
- **Strict schema bounds vs real models** — relaxed hard `.min/.max/.length` to
  describe-hints (+ clamp) on charter/identity/rubric/script-beats/thumbnail.
  This bug class recurred all day (see Learnings).
- **Score button crash** — rubric `score.min(0).max(10)`; relaxed + clamp.
- **"Server Action not found" after every deploy** — pinned
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (Dockerfile build arg + compose +
  `.env`).
- **YouTube "redirect_uri_mismatch"** — behind Caddy, Next resolved
  `req.nextUrl.origin` to `https://localhost:3000`; pinned the OAuth redirect to
  `PUBLIC_BASE_URL` in both start/callback routes.
- **Voiceover 404 stall** — channel `voiceId` was the placeholder `"default"`;
  ElevenLabs provider now resolves it to `ELEVENLABS_VOICE_ID` (else the Rachel
  premade).

Default LLM tiers were set to **qwen-max** (frontier+agentic via OpenRouter),
then the operator moved everything to **Anthropic** on /account for reliability
(see Learnings). Cheap tier = Gemini Flash.

## Key learnings (why the bugs happened)

1. **Structured-output reliability.** Qwen/DashScope only supports
   `response_format: json_object` (no strict `json_schema`), so on complex nested
   schemas its JSON often fails local zod validation → `generateObject` retries →
   **tokens burned, production silently stuck**. Anthropic/Gemini do native
   strict structured output and are reliable. Complex-schema tiers (frontier =
   scripts/charters) should stay on json_schema-capable models, or the
   json_object path needs a repair/reprompt step. (BACKLOG #15)
2. **Strict zod bounds are landmines.** The mock always returns in-bounds output,
   so `.min/.max/.length` bugs were invisible until real models (which overshoot)
   ran. Fix pattern: relax to `.describe()` hints + clamp in code. **More schemas
   likely still have this — a full audit is worth doing.**
3. **Failed agent calls burn untracked spend.** `runAgent` records a cost line
   only *after* success, so failed retries consume provider tokens with no cost
   record (Qwen dashboard showed usage the cockpit never logged). (BACKLOG #15)
4. **No retry/reset for stuck productions.** A failed step leaves a production in
   limbo; we reset via raw SQL (`ideas.status='scored'` + delete stuck
   `productions`). Need a UI Retry action. (BACKLOG #15)
5. **Every code deploy is disruptive.** A push rebuilds → new server-actions key
   (now pinned) + worker restart (interrupts in-flight productions) + client RSC
   prefetch failures until a hard refresh. **Docs-only pushes are safe** —
   `BACKLOG.md`/`.env.example` aren't in the cockpit build context, so they don't
   rebuild it. Prefer docs pushes during a live session.
6. **Console noise ≠ app bugs.** Wallet extensions (`evmAsk.js`, `inpage.js`,
   `contentscript.js`, "message channel closed") and post-deploy `_rsc` prefetch
   failures are harmless. Only traces through the app's own hashed bundle or an
   `app.commongroundsocial.com.au/...` request are real.

## Operator `.env` steps (verify these are done on the droplet)

Add to the droplet `.env`, then `docker compose -f docker-compose.prod.yml up -d --build`:
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=` (openssl rand -base64 32) — stops the
  server-action errors + tab breaks on redeploy.
- `PUBLIC_BASE_URL=https://commongroundsocial.com.au` — makes YouTube Connect work.
- `ELEVENLABS_VOICE_ID=bfGb7JTLUnZebZRiFYyq` — the operator's "Adam – Distinct,
  Deep, and engaging" voice; the global default until per-channel voice ships.

## Current pipeline state

- One charter'd channel; frontier/agentic tiers = Anthropic; ElevenLabs + fal
  connected (real assets); YouTube **not** connected yet (publish is mock).
- Dead productions to recover: ~3 stuck at `scripting` (Qwen-era validation
  failures) and 1 stuck at `producing_assets` (the voiceover 404). **Now
  recoverable from the UI** — open each production and hit **"Halt & return to
  ideas"** (keep or discard its artifacts); the golden idea returns to the pool
  as `scored`, ready to re-greenlight fresh. No more raw SQL. (BACKLOG #15
  Land 1, shipped 2026-07-08 — needs the redeploy that carries migration 0011.)

## Start here tomorrow

1. **Confirm the `.env` redeploy ran** (voice + the two keys). Sanity-check:
   `docker compose -f docker-compose.prod.yml exec -T worker sh -c 'echo $ELEVENLABS_VOICE_ID'`.
2. **Greenlight ONE fresh idea** and walk it end-to-end: Script gate → voiceover
   (Adam voice) → images → render → **Review → Final cuts** (pick thumbnail) →
   mock publish. This is the outstanding "validate the flow" goal.
3. **Connect YouTube** (now that `PUBLIC_BASE_URL` is set) and test a real
   private publish + Release.
4. Then pick a UX batch — all design-skill-led, and get **Docker up locally** so
   the redesign can be screenshotted (it couldn't be all session):
   - **BACKLOG #14** — wizard step-1 redesign (janky grid/spacing, format-dependent
     length, release schedule, side-drawer co-pilot), cross-channel **Production
     Flow** view, per-row status/failure surfacing, tabbed Review with aggregate
     approvals, Schedule + Calendar, embedded assistant, per-channel voice pick.
   - **BACKLOG #15** — length-aware scriptwriter (scripts come out far under the
     target length; critical for long-form), Retry-production action, untracked
     failure spend, Qwen structured-output hardening, and a **full strict-schema
     audit** (learning #2).

## Reference
- Backlog: `BACKLOG.md` §14 (UX overhaul) + §15 (pipeline quality).
- Today's commits: `3fec8bd` … `a7ea12e` on `main`.
