# Operating the YT-Auto platform from Claude (MCP connector guide)

This is a reference for **Claude in a normal chat** connected to the YT-Auto
platform via its MCP connector. It lists every tool ("access right") Claude has,
and — more importantly — **where each one is needed in the end-to-end flow** so a
video gets made correctly. Give this to Claude (paste into a Project's custom
instructions, or attach it) before asking it to run channels.

The connector URL is `https://ytauto-cockpit.onrender.com/api/mcp?key=<token>`.
Every write is logged as an operator decision (`actor: operator`, `via: mcp`) —
the token *is* the operator.

---

## 1. The mental model — who does what

The platform makes faceless YouTube videos on a fixed spine:

```
Channel ──▶ Idea ──▶ (Series/Episode) ──▶ Script ──▶ Assets ──▶ Gates ──▶ Publish
            (backlog)  (optional arc)     (beats)   (voice+     (human    (YouTube)
                                                     images+     review)
                                                     render)
```

**Claude authors the creative + sets the knobs. The platform executes.** On an
**authored** production (made with `author_script`), every creative LLM the
platform would normally run is replaced by what Claude wrote:

| Step | Normally an LLM | On an authored run |
|---|---|---|
| Script drafting / humanize / factuality proof | yes | **skipped** — Claude's script used verbatim |
| Per-video profile proposal | yes | **skipped** — the profile is set |
| Image prompts (`buildImagePrompts`) | yes | **skipped when the beat carries a full `imagePrompt`** (≥20 chars); thin ones are still elaborated |
| Motion/i2v prompts (`writeMotionPrompt`) | yes | **skipped when the beat carries a `motionPrompt`** |

**The platform still does (by design, not LLM-authored):** generate the actual
image pixels, generate/​source video clips, synthesize the voiceover (TTS),
render the video, and upload to YouTube. Claude controls *what* those produce
via prompts, reference entities, and the Production Profile — but doesn't draw
pixels or speak audio itself.

**Real images** (Wikimedia/NASA/Openverse + Pexels/Pixabay/Unsplash stock) are
sourced automatically for shots whose beat names a `referenceEntity` or has a
`visualBrief`, when the channel's visual mode allows it (see §6). Generation is
the fallback.

---

## 2. The end-to-end flow and which tool acts at each stage

Follow this order. Steps in *italics* are optional.

**Stage 0 — Orient (always start here).**
- `list_channels` → get channel ids.
- `get_channel_state` → charter mission/objectives + a state summary + performance.
- `get_channel_config` → the DNA + **resolved Production Profile (all axes)** + charter + autonomy. Read this before you set anything or author against a channel.
- *`get_intel`* → rising niches/topics + top patterns (to ground ideas).
- *`get_playbook`* → what already works for this channel (adopt its directives).
- *`get_eval_results`* → which model tier scripts best (informational).

**Stage 1 — Set up / tune the channel.**
- New channel: *`propose_channel`* (draft a charter to review) → `create_channel` **passing the returned `charter` object verbatim** (`create_channel({charter, name, handle})`) so what you reviewed is what's committed. Without `charter`, `create_channel` re-drafts a **different** charter and the compliance-relevant fields (`forbiddenTopics`, `verificationBar`) drift silently. Provisions charter + DNA + persona + sources; returns the **manual** YouTube-account checklist.
- Existing channel: `set_channel_config` to set autonomy, DNA, Production Profile, charter (see §4 for the full surface). Do this **before** authoring so the video inherits the right options.
- *`run_market_scan`* → refresh intel, then re-read `get_intel`.

**Stage 2 — Plan the content.**
- Arc: `create_series` (title + description + episode list) — no planner LLM.
- Single ideas: `write_idea` (lands in the backlog + auto-scores; or `greenlight:true` to push straight into production).
- **Batch check first: `review_slate`** — before writing a batch of ideas/titles to
  the backlog, run it (the cheapest gate, one stage before `review_beat_map`). It
  **BLOCKS** titles/angles that violate the channel's own `forbiddenTopics` (semantic —
  catches a rule phrased differently), overclaim a contested matter, or duplicate the
  backlog/published set; it **ADVISES** on intra-slate structural clustering, keyword
  position (set `searchTerms` on DNA to enable it), title-family drift (declare
  `titleTemplates` on DNA), and **producibility** (**#54/#53** — ideas the channel's own
  production reality can't build: a live host / props / a real shoot on a faceless
  generative channel, gated on `productionProfile.visualMode` = `ai_images`/`ai_video`/
  `simple`; a rap/song/chant the TTS voiceover can't perform; or a comment CTA on a
  Made-for-Kids channel (`madeForKids` true → comments disabled). Advisory, never a
  block — which to archive is the operator's call via `set_idea_status`). When `titleTemplates` are declared, cross-slate shape
  clustering is suppressed — conforming to a declared family is expected, so the
  reviewer instead flags titles near-interchangeable *within* one family. The
  semantic reviewer distinguishes a neutral statement of what a tradition's canon IS
  from a disparaging/contested claim, so neutral facts aren't blocked.
  Same `{ verdict, blockingFindings[], advisoryFindings[] }` shape as `review_beat_map`.
- Inspect: `list_ideas`, `list_series`.
- Mutate (**#59** — the backlog is no longer write-once): `update_series` (rename / re-describe / promote `proposed`→`active` / reorder episodes), `set_episode_status` (drop an episode with `cut`, or move it), `set_idea_status` (batch archive/reject duplicate ideas). Pruning the backlog keeps scoring + `review_slate`'s near-duplicate check meaningful. Ids come from `list_series` / `list_ideas`.

**Stage 3 — Author + produce the video (the core).**
- `author_script` — hook + beats. Each beat: `type`, spoken `text`, and optionally `imagePrompt`, `referenceEntity`, `visualBrief`, `heroShot`, `motionPrompt`. Optionally pass a per-video `productionProfile`. Give it an existing `ideaId`, or `ideaTitle`+`ideaAngle` to mint one. This **kicks the pipeline**.
- After it returns a `productionId`, the pipeline runs: voiceover → images (using your prompts / real sources) → clips → render.

**Stage 4 — Watch the halts (read-only; approval is human).**
- On a gated channel (autonomy T0/T1) the run stops at the **visuals** gate, then the **final** gate. Poll `list_gates` (filter by channel) to see what's waiting. `list_gates` shows **only gates whose production is still active** — a retired/failed/halted/superseded/rejected production never leaves a phantom gate in the queue.
- `get_gate` — for a `visuals_review` gate it returns each shot's narration + image + whether it was animated, plus a `reviewPath` to open in the cockpit. Use it to **inspect and flag** problems (`report_issue`) ahead of the human review.
- **Fix a bad/duplicate shot in place (ticket 01KY5W4T…):** `get_production_shots(productionId)` lists every shot (idx, narration, sourced/generated, entity, engine, animated, and **`assetType`** = `still`/`generated_clip`/`sourced_clip` — **#65/#67**, the true rendered asset, since `animated` conflated AI i2v clips with real archival footage; a `sourced_clip` carries `clipProvenance`, and top-level `assetCounts` gives the AI-vs-real split. The `imageUrl` is the still **poster** — a `sourced_clip` renders the clip, not this still). `assetCounts` also carries `clipsBilledToVideoEngine` + `generatedClipLedgerMismatch` (**#67**) — `assetType` reads stored clip **rows**, so a `generated_clip` row never billed to a video engine is a phantom/stale row; trust the cost ledger over the row when they disagree). **`get_production_shot(productionId, idx)`** reads **one** shot cheaply (**#66** — the "did shot N change?" check after a connector timeout, without pulling all N). `regenerate_shot(productionId, idx, {imagePrompt?/referenceEntity?/imageEngine?/characterId?/aspectRatio?})` re-does **one** shot — including **casting a recurring character** (`characterId` from `list_characters`, **#70**, composes with `imagePrompt`) — re-source a real photo, or regenerate the still on a chosen engine — **without re-running the production or re-billing the other shots**. The cost appends; the gate **stays open** for your review (regenerating never auto-approves). Only works while the production is at the visuals gate; for a published video, make a corrected copy.
  - **Finish the pass before approving (ticket 01KY6DCD…):** `get_production_shots` and `get_gate` also return **`outstandingDuplicateShots`** + **`duplicateRiskGroups`** — **still-sourced** shots sharing a `referenceEntity` with another shot (duplicate-image risk). **#52:** a shot already regenerated from an authored `imagePrompt` is `generated` and its entity is historical, so it no longer counts — the number now reflects real remaining risk, not stale plan strings. `regenerate_shot` runs **only** at `visuals_review`; once the gate is approved and the production moves to `thumbnail_review`, the per-shot fix window **closes**, and the only recoveries are shipping the known-bad shots or re-authoring the whole video. So clear (or accept) the duplicate groups **before** approval. Reopening the visuals gate is a cockpit operator action (deferred — see `get_deferred_work` `reopen-visuals-gate`). `regenerate_shot`'s out-of-state error names the current status and the recovery path.
- **Render or SOURCE a thumbnail (ticket 01KY6F1X…, #74, #76):** `regenerate_thumbnail(productionId, {thumbnailPrompt?, referenceEntity?, imageEngine?, quality?})` — a verbatim `thumbnailPrompt` **generates**; **#74** `referenceEntity` **sources a real archival photo** of that subject (the same path `regenerate_shot`'s re-source mode uses — vision-scored, auto-credited), up to 3 candidates. **#92: every sourced candidate is now VISION-VERIFIED to actually depict the named subject before it's offered** — the archival tier (Wikimedia/NASA) silently fell through to generic stock (Pexels) on a niche subject and returned the wrong aircraft as "sourced"; candidates that don't depict the subject are dropped, and `list_thumbnails` returns **`sourceTier`** (`archival` vs `stock_fallback`) + **`fitScore`** (0-10) per sourced candidate so you can discard a weak stock match; **#74-append** `referenceImages` (url[]) **generates from an operator-supplied photo** — when text-to-image can't render a specific subject (a 1950s airframe), you hand it the real one (the photo conditions geometry/markings, the prompt drives composition; pair with a verbatim `thumbnailPrompt` so `imageStyle` doesn't fight the reference). Combine any of them. **`get_gate`** on a `thumbnail_review` gate now returns the **candidates** (`thumbnails[]` `{id,url,predictedCtr,selected,prompt,engine,createdAt}` + `thumbnailCount`) — how you review over MCP **and** recover a timed-out `regenerate_thumbnail` (rising count / fresh `createdAt` = it landed; don't blind-retry). Cost appends; the gate **stays open** (never auto-approves/publishes). **#76 — the thumbnail is no longer frozen at gate approval:** `regenerate_thumbnail` runs at `thumbnail_review` (candidates land on the open gate) **and after**, while the video is `ready`/`scheduled`/`published` (private for hours). Post-gate the candidate is **not** applied — call **`set_video_thumbnail(productionId, {thumbnailId?})`** to push a chosen candidate to the live/scheduled YouTube video via `thumbnails.set` (a one-call swap, not a re-upload; omit `thumbnailId` for the highest-`predictedCtr` candidate; needs the `thumbnails.set` OAuth scope). **Note:** `set_publication_schedule(cancel:true)` parks the video private (status → `published`) and does **not** reopen the thumbnail gate — use the `regenerate_thumbnail` + `set_video_thumbnail` path to repackage, not cancel. **Key distinction:** `set_publication_metadata` only *stores* `thumbnailPrompt` (a string) — it does not render.
- **Approval is a human action in the cockpit and is NOT exposed over MCP** — there is no `decide_gate`. The approval log is the editorial-judgment record that protects the channels under YouTube's inauthentic-content enforcement, so an AI operator must not clear its own gates. Don't flip `autoApprove*` either — leave gate clearing to the operator.

**Stage 5 — Monitor.**
- `list_productions` (per channel, optional status filter) and `get_production` (status, idea, script summary, `failureReason`, and **#81:** the **`publication`** — `url`, `providerVideoId`, `publishedAt`, `privacyStatus` — so a published video is never mistaken for un-published when its status row is stale; `publication.statusMismatch` flags a live video sitting on an `on_hold`/`failed`/`rejected` row).

---

## 3. Full tool reference (all access rights)

**Read / intel**
| Tool | Args | Use |
|---|---|---|
| `list_channels` | — | All channels: id, name, @handle, niche, format, tier. |
| `get_channel_state` | `channelId` | Charter + state-of-the-world summary + performance. |
| `get_channel_config` | `channelId` | DNA + resolved Production Profile + charter + autonomy. **#93:** also returns `activeStyle` (the distilled Style-tab style, or `null` — `styleId`, `promptSuffix`, `conditioningScope`, `refCount`; its reference-image conditioning fires only on **nano-banana**, so on a qwen/seedream channel the text register is the only carrier of the look) and `shotStyleRegister` `{source, register}` — exactly which register an **authored** `imagePrompt` gets on this channel right now. |
| `get_intel` | `niche?`, `limit?` | Rising opportunities + top pattern-store patterns. |
| `get_playbook` | `channelId` | Adopted/trial directives with why + confidence. |
| `get_eval_results` | `limit?` | Recent model-quality runs (per-model avg score). |
| `list_ideas` | `channelId`, `status?` | Backlog ideas. |
| `list_series` | `channelId` | Story arcs + episode statuses. |
| `list_productions` | `channelId`, `status?` | In-flight + finished productions, with `costUsd` per row (**#49**). |
| `get_channel_costs` | `channelId` | Spend by stage + per-production totals + **`byIdea`** (**#49**: `{ideaId, title, attempts, publishedCount, cumulativeUsd}`, sorted by spend — a re-greenlit idea burning cost across abandoned attempts shows in one call). Only *successful* steps are billed, so true burn is higher. |
| `get_production` | `productionId` | Status + idea + script-draft summary + `shotPlan` + **`publication`** (live/scheduled video url + `statusMismatch` flag, **#81**). |
| `list_gates` | `channelId?` | Pending gates (the pipeline's halts) — **read-only**. |
| `get_gate` | `gateId` | Inspect a gate; visuals gate returns shots + images — **read-only**. |
| `get_video_analytics` | `productionId` | Per-video: views, retention curve, watch time, traffic sources, engagement; `dataState` = none/pending/partial/full. Impressions/CTR are Studio-only → null. |
| `get_channel_analytics` | `channelId`, `sinceDays?` | Windowed views/subs/watch-hours + subscriber count + median/mean views per video. |
| `list_characters` | `channelId` | The channel's recurring on-screen characters: id, name, brief, canonical description, role, castMode, castTarget, enabled (§6c). |

**Act / author** (all audited)
| Tool | Args | Use |
|---|---|---|
| `run_market_scan` | `niche?` | Refresh intel now. |
| `propose_channel` | `niche`, `intent`, `format?`, `researchDepth?`, `monetisationSafe?` | Draft a charter (no commit). |
| `create_channel` | `niche`, `intent`, `name`, `handle`, **`charter?`** (pass propose_channel's output verbatim → committed unchanged; omitting it re-drafts a different charter), `format?`, `autonomyTier?`, `derivedFromChannelId?`, `styleExampleUrls?` | Provision a channel end-to-end. |
| `set_channel_config` | `channelId`, `autonomyTier?`, `dna?`, `productionProfile?`, `charter?` | Set any channel option directly (§4). |
| `set_production_profile` | `productionId`, `productionProfile?`, `resyncFromChannel?` | Update **one production's** per-video profile in place. A production snapshots the channel profile at start and never picks up later channel edits — this is the only way to correct that snapshot. Returns `changed` + `reopenToApply` (stages to reopen for it to reach already-built work; reopening re-bills). |
| `create_series` | `channelId`, `title`, `description`, `episodes[]`, `status?` | Author an arc + episodes. |
| `update_series` | `channelId`, `seriesId`, `title?`, `description?`, `status?`, `episodeOrder?` | **#59** — rename/re-describe an arc, promote `proposed`→`active`, or reorder episodes. Only sent fields change. |
| `set_episode_status` | `channelId`, `episodeId`, `status` | **#59** — move one episode (`planned`…`queued`…`cut`); `cut` drops it from the arc. |
| `set_idea_status` | `channelId`, `ideaIds[]`, `status` | **#59** — batch archive/reject backlog ideas (`inbox`/`scored`/`greenlit`/`rejected`/`archived`); unknown ids returned in `skipped`. `review_slate` now excludes `rejected`/`archived` from its comparison set (**#60**). |
| `update_idea` | `channelId`, `ideaId`, `title?`, `angle?` | **#60** — edit a nearly-right idea's title/angle. |
| `get_channel_strategy` | `channelId` | **#61** — read the durable strategy document (taxonomy/decisions/vision), section-scoped + timestamped. **Not** read by the authoring pipeline. |
| `set_channel_strategy` | `channelId`, `content`, `section?` | **#61** — write/clear one section of the strategy document (default `main`); per-section cap 100k chars, doc unbounded. |
| `write_idea` | `channelId`, `title`, `angle`, `greenlight?` | Add an idea (or greenlight it). |
| `author_script` | `channelId`, `hookText`, `beats[]`, `ideaId?`/`ideaTitle?`+`ideaAngle?`, `substanceFingerprint?`, `productionProfile?` | Author a full video + run it (§5). |
| `create_character` | `channelId`, `name`, `brief`, `castMode?`, `castTarget?`, `role?`, `imageEngine?` | Create a recurring on-screen character; distills the brief → canonical look + renders a reference sheet (§6c). Synchronous (a few seconds). |
| `set_character_cast` | `channelId`, `characterId`, `castMode?`, `castTarget?`, `enabled?` | Change how often a character appears / bench it — no re-render (§6c). |
| `refine_character` | `channelId`, `characterId`, `comments` | Revise a character's look (same face, updated description + reference sheet) (§6c). |
| `delete_character` | `channelId`, `characterId` | Remove a character (prefer `set_character_cast` `enabled:false` to keep it). |
| `generate_test_scene` | `channelId`, `scene`, `characterIds?`, `styleId?`, `imageEngine?` | Render a throwaway test scene, casting any number of characters, to see what the look + cast actually produce (§6c). No distilled style required. |
| `list_test_scenes` | `channelId` | List rendered test scenes (ask, URL, cast, style version, refine comments). |
| `refine_test_scene` | `channelId`, `sceneId`, `comments` | Rework a test scene with its current image as the edit reference. |
| `generate_brand_art` | `channelId`, `surface`, `prompt?`, `mode?`, `changes?`, `includeName?`, `tagline?`, `background?`, `alignStyle?`, `extra?`, `characterId?`, `sceneId?`, `useCurrent?` | Generate/refine the channel **logo or banner**. `prompt` is used **verbatim**; omit it to have one composed (§6c). Applied to the channel immediately. |

*(There is intentionally no `decide_gate` — gate approval is a human cockpit action; see Stage 4.)*

**Tickets** — `report_issue` (title, detail?, severity?, channelId?, productionId?) files a ticket on the cockpit Tickets page **and mirrors it to a GitHub issue** when `GITHUB_ISSUE_TOKEN` is set on `/account` (severity → label; channel/production carried into the body). Its return `note` names the exact env to set if mirroring is off, and `githubUrl` is the created issue. Closing that GitHub issue closes the ticket (two-way). `list_issues` / `resolve_issue` read + acknowledge/close. **More evidence for a KNOWN defect → `append_to_issue(ticketId, detail)`** (not a second `report_issue`): it posts your detail as a comment on the linked GitHub issue, keeping one ticket per defect. Check `list_issues` first; the ticket must have a `githubUrl` (was mirrored). A ticket can also carry a **`resolution`** — the developer's answer synced from a linked GitHub issue (a body carrying `ytauto-ticket:<id>` links; the resolution is written by the fixer via the issue body/comments, never overwritten by the filing text). `list_issues` returns it; read it before closing. `list_issues` returns an envelope
`{ appliedStatus, count, total, tickets[] }` (**#62**): `appliedStatus` echoes the filter
actually applied (a specific status, or `open+acknowledged` when none is passed) and
`total` is the whole board size — so you can *assert* the filter was honoured and see if
the list was truncated, instead of inferring either from the payload.

**Ticket lifecycle (what happens after you file one):** `report_issue` → GitHub issue → a developer grounds the fix in the code, ships it, posts a **Resolution** comment (commit + how to verify), and **deliberately leaves the ticket OPEN for you to verify live and close** — they do not self-close, because an auto-closed board hides unverified work. So an **open ticket that has a Resolution is "fixed, awaiting your check"**, not "ignored". Many fixes need a **connector reconnect** (to see new tools/return fields) and/or a **deploy** (to apply migrations) before you can verify — the resolution says which. Before concluding a fix "didn't work", also check `get_deferred_work`: some fixes are deployed but their effect is gated on the next analytics ingest / a data cycle.

**`get_deferred_work`** — the durable record of shipped-but-not-yet-verifiable and deliberately-deferred work. Call it before concluding a fix "didn't work": some fixes are DEPLOYED but their effect is gated on the next `analytics-ingest` cycle or YouTube's 24-72h lag (new analytics fields populate, stale alerts auto-clear, only on the next ingest). Verify the post-ingest signal (`get_video_analytics` `dataState`/`coverage`), not the pre-deploy snapshot. A closed ticket + a `shipped_pending_verification` entry = done-pending-data, not failed.

---

## 4. The channel-config surface (everything `set_channel_config` can set)

Pass only the fields you want to change; the rest are untouched. A partial
`productionProfile` is **merged** over the stored one.

**Top-level:** `autonomyTier` (0 manual · 1 assisted/human gates · 2 auto-publish · 3 exception-only)
· `contentFormat` (**#51** — `long` | `short` | `both`, now settable over MCP). This is
**not a label**: render orientation/aspect (16:9 vs 9:16), the shot planner and the
scriptwriter all read it, so moving a long-only channel to `both` changes real behaviour.
Per-**video** orientation is a separate axis (`productionProfile.orientation`); `contentFormat`
is the channel-level default.
· **Subchannels (Shorts-derivation Phase 2, plumbing landed / not yet operator-wired):**
a **subchannel** is an ordinary channel row (`contentFormat: "short"`,
`derivedFromChannelId` = parent) that will publish Shorts sliced from the parent's
long-form masters, with its **own** styling/`captionStyle`/cadence. The one new field is
`youtubeAuthChannelId` — the publish-**auth** pointer: set to the **parent** id, the
subchannel's Shorts upload to the *parent's* YouTube channel (Mode 1 "parent-youtube",
the default — Shorts are native to one channel); left `null`, the subchannel uploads with
its **own** token (Mode 2 "own-youtube", a separate Shorts channel). The publish and
analytics paths resolve this automatically (`loadChannelToken` follows the pointer), so a
normal channel (`null` pointer) is unaffected. The on-demand cut itself (`derive_shorts`)
is a later phase — see `docs/SHORTS-DERIVATION-SPEC.md`.
· `madeForKids` (**#53** — `true` | `false` | `null`, YouTube's Made-for-Kids/COPPA
self-designation, now stored + settable). Load-bearing: the publish path sends it as
`selfDeclaredMadeForKids` on upload/release/schedule, and MFK **disables** comments,
end-cards/cards, the notification bell and save-to-playlist (ads become contextual-only).
Set it on any channel aimed at under-13s; `consistencyWarnings` then flags charter
objectives that depend on now-disabled features, and `review_slate` flags comment CTAs.
· `ideationPaused` (**#68** — `true` → the daily trend-scan/ideation cron **skips** this
channel, so no auto-generated ideas land in the backlog while you establish its format;
manual `write_idea`/`seed_idea` and series planning still run; set `false` to resume).

**`dna`:** `tone`, `audiencePersona`, `hookStyles[]`, `forbiddenTopics[]`,
`ctaTemplate`, `voiceId` (an ElevenLabs voice id), `targetLengthSec` (e.g. `45`
Shorts, `600` for 10-min, `1800` for 30-min), `cadencePerWeek`, `titleTemplates[]`
(named title families `{name, pattern, example?}` so `review_slate` can flag
title-format drift; multiple families are a deliberate declaration, not drift),
`searchTerms[]` (the terms your audience actually SEARCHES, e.g. "Book of Enoch",
"Qumran" — `review_slate`'s keyword-position check uses these, NOT the niche
description string; unset → that check is skipped rather than firing on everything),
`imageStyle` (**#57** — the channel **house image style**: a plain-language render
register, e.g. *"bold graphic illustration, painted graphic-novel look, NOT
photographic"*, that steers **every** generated image — characters **and** scenes.
This is the chat lever for a non-photoreal channel: set the LOOK here, not in a
character brief. **Precedence:** an active distilled Style-tab style, built from
uploaded example images, still **wins** for the render; `imageStyle` applies when the
channel has no active distilled style. **#93 (2026-08-03):** on an **authored** prompt
(which skips the prompt builder) the winning style is applied as a **text register** —
the distilled style's `promptSuffix`, else `imageStyle`. It is *not* left to
reference-image conditioning, which only fires on **nano-banana**; assuming otherwise
is what let a seedream channel render every authored shot with no style at all. `get_channel_config` now **returns**
`dna.imageStyle` (**#64** — it was write-only; `null` when blank), so you can read it
before changing or clearing it; note it is **global** and an authored prompt can't
locally override it (a per-surface `thumbnailImageStyle` is a known gap). On a
**charter'd** channel `create_channel` now **commits the reviewed `dnaDefaults.imageStyle`
verbatim** (**#58** — it used to drop it silently); a channel created without a charter-supplied imageStyle **starts blank, and
blank means blank** — while unset the platform writes **no** style clause into any
prompt rather than substituting a default, so an unstyled channel renders with no
imposed look at all. Send `""` to clear it. The same field is editable in the cockpit
under **Style → House style**).

**`lengthPolicy` (#39 — content-driven runtime).** A DNA band so episode length can
track the material instead of a single fixed default: `floorSec` (**hard** — 480 =
YouTube's 8-min mid-roll threshold, below which the channel loses the mid-roll ad
lever), `ceilingSec` (soft, default 2400), `bands` (named advisory targets — **contiguous**
defaults: short-doc 480–720, standard 720–1500, deep 1500–2400, longform 2400–7200),
and a `principle` string. Partial-merged, defaults resolved on read. `targetLengthSec`
stays the soft anchor / fallback. `review_beat_map` **ADVISES** (never blocks) when
the proposed runtime is padded/crammed vs the map's depth (beats + words) or below
the mid-roll floor, and returns which band the runtime sits in. Making a
per-production runtime target actually drive `author_script`/assembly is a **deferred**
next step (`get_deferred_work` → `content-driven-runtime-consumption`).
`get_channel_state`'s `performance.suggestedLengthSec` is **display-only** (nothing
consumes it), now **clamped** to `lengthPolicy [floorSec, ceilingSec]` and **suppressed**
(null) below an evidence bar (≥8 analysed videos at ≥50 median views) — read
`suggestedLengthBasis` for the inputs (ticket 01KY99AE…).

**Config reads are resolved, writes are partial (ticket 01KY98YR…).** `productionProfile`
must be an **object** of axes (`{ artDirection: "…" }`), not a JSON string (a stringified
one is now tolerated and parsed, but pass a real object). `get_channel_config` returns the
**resolved** `productionProfile` + `lengthPolicy` (defaults filled on read) — a partial
`set_channel_config` only persists the axes you send; extra fields on read are resolved
defaults, not silent drift. `set_channel_config`'s `stored` echo now covers
`productionProfile` + `lengthPolicy` too, and is **omitted** when nothing echoable changed
(no more empty `{}` that read as "nothing saved").

Array fields (`hookStyles[]`, `forbiddenTopics[]`, `titleTemplates[]`,
`searchTerms[]`) are stored **verbatim** — a comma inside an entry stays part of
that entry, so a multi-clause hook style is ONE entry, never split into fragments.
The response echoes back `stored` with the written array fields, so you can confirm
the value landed intact without a follow-up `get_channel_config`. (The cockpit
Persona/Settings forms now take these **one-per-line** for the same reason.) **#89:
the prose caps on `titleTemplates[].pattern` (now 2000) and `dna.imageStyle` (now
2000) were raised so a full rule/brief fits, and any write that STILL exceeds a cap
returns a `warnings[]` entry naming the field, the limit and the submitted length —
truncation is no longer silent (it used to sever a compliance rule mid-word at 500).**
Legacy
channels provisioned before the fix may still hold comma-shredded `hookStyles`
(orphaned clause-tails); `get_channel_config`'s `consistencyWarnings` now **flags**
these on read, so reading each channel's config doubles as the backfill audit —
rewrite the whole list to repair. `consistencyWarnings` **also** flags (**#48**) a
`targetLengthSec` stored **below** the channel's own hard `lengthPolicy.floorSec` (or
outside every declared band) — a legacy soft anchor under a later-declared floor forfeits
mid-rolls. (#46 clamped the *derived* `suggestedLengthSec`; this catches the *authored*
value.) `set_channel_config` returns the same as a non-blocking `warnings` note when a
write lands the anchor below the floor — it is stored as-is, not rejected.

**`charter`:** `mission`, `objectives[]`, `verificationBar` (partial-merged —
`establishedMinSources` 1–5, `presentDebateMode`, `minFactsToScript` 1–20,
`factualityMode` strict/balanced/entertainment; patch it to fix any drift from
`create_channel`'s draft) — only on charter'd channels; no-op on legacy manual channels.

**`productionProfile` axes** (the "how this video is made" control plane):

| Axis | Values | Meaning |
|---|---|---|
| `visualMode` | `simple`·`real_footage`·`ai_images`·`ai_video`·`mixed` | source real footage, generate, or mix. Real-image sourcing only fires on `real_footage`/`mixed`. |
| `motion` | `static`·`partial`·`ai_video` | stills, key-beats animated, or all-video. |
| `rhythm` | `sentence`·`section`·`pause` | how finely beats are cut into shots (more shots = more images). |
| `imageDensity` | `relaxed`·`standard`·`busy` | image frequency (use `relaxed` for very long videos to bound cost). |
| `minSecondsPerShot` | number 2–60 (**#73**) | explicit **hold-duration floor**, overriding the `imageDensity` tier (which tops out at ~11s on `relaxed`). A contemplative still-image channel wants ~20–25s. A higher floor = **fewer, longer shots** for the same runtime → roughly halves the shot count + generation bill, and dissolves the #69 beat-vs-shot supply gap. Unset = the density-derived floor. |
| `stillMotion` | `none`·`slow_push`·`slow_pull`·`drift` (**#73**) | render-time **Ken-Burns** transform on stills (a free move, **not** i2v clip generation — that's `motion`). Unset resolves to `slow_push`, the renderer's prior hardcoded zoom. |
| `stillMotionAmount` | number 0–0.15 (**#73**) | Ken-Burns strength (scale delta over the hold). Default 0.12 (= the prior 1→1.12 zoom). |
| `transition` / `transitionMs` | `cut`·`dissolve` / 0–2000 (**#73**) | transition between stills — hard `cut` (prior default) or a `dissolve` crossfade over `transitionMs`. |
| `captions` | boolean | burned-in word captions (on/off). |
| `captionStyle` | object (**#72/#79**) | caption **styling** (the `captions` bool still gates on/off): `{ position: lower-third·center·upper-third, casing: as-written·upper·sentence, typeface: sans·serif·slab, weight: 400–900, maxLines, color: hex (base text, default **white**), activeColor: hex (the currently-spoken word; **unset → uses the base `color`**, so a white caption stays white and the karaoke highlight is the scale-up; set it to opt into a coloured highlight), outlineColor: hex (default **black**), outlineWidth: 0–12px (default **4** = heavy; `0` or `outline:false` disables), shadow: bool (default **true**), scrim: bool (dark band behind text, default false), emphasisColor: hex, emphasisPhrases: [phrases coloured wherever they appear] }`. **#79:** the DEFAULT is white text + heavy dark outline + shadow (applied **per word**) so captions stay legible over any imagery; the active word no longer forces the brand accent (that overrode `color` and rendered captions in the accent colour — use `activeColor` to opt in). `emphasisColor` **only** colours words matching `emphasisPhrases` — set the phrases or it has no visible effect. **Unknown keys are rejected** with a validation error naming the field (no silent drops). `center` + `upper` + `serif` + `emphasisColor` + `emphasisPhrases` reproduces the contemplative essay-channel format. |
| `music` | `off`·`subtle`·`standard` | background bed level. |
| `musicMood` | free text | e.g. "tense cinematic". |
| `delivery` | `measured`·`warm`·`energetic`·`dramatic` | voice expression. |
| `voiceModel` | `turbo_v2_5`·`flash_v2_5`·`multilingual_v2`·`v3` | ElevenLabs TTS **model** (separate from the voice id). `turbo_v2_5` (default) / `flash_v2_5` = cheap tier ~**$0.05/1k chars**; `multilingual_v2` / `v3` = expressive ~**$0.10/1k (~2×)**. `v3` is the most expressive (alpha) — if it returns no word alignment, captions/shot-sync fall back to an estimate. Also settable in the cockpit Production Profile panel. |
| `archivalStrength` | `off`·`light`·`balanced`·`strong`·`max` | how hard to try real images before generating. |
| `imageEngine` / `heroImageEngine` / `characterImageEngine` / `thumbnailImageEngine` | `qwen`·`seedream`·`nano-banana` | per-role image models. `imageEngine` is the **standard-still** default (`qwen`; set `seedream` for higher quality). Set via `set_channel_config`'s `productionProfile` (channel default) or `author_script`'s (per-video), or per-shot at the gate via `regenerate_shot`. The concrete model id is env-pinned (`SEEDREAM_IMAGE_MODEL`), so it moves with the vendor without a code change. |
| `videoEngine` / `characterVideoEngine` / `heroVideoEngine` | `wan`·`minimax`·`seedance`·`seedance-pro`·`kling` | per-role clip engines. |
| `maxAiClips` | 0–20 | cap on generated clips per video (cost knob). |
| `visualDirector` | boolean | **SHOT PLANNER, not a prompt writer** (see below). It does NOT need to be off to own your prompts. |
| `artDirection` / `notes` / `thumbnailTemplate` | free text (each ≤ **50,000 chars**) | steer the image models / pipeline; LLM-read standing guidance. Raised from 6,000 → 50,000 in ticket 01KYGEW6… / #71 so a fully-specified brief fits without cutting evidence (`musicMood` stays short at 800). **These are prompt context, not just storage:** `notes` injects once per authoring pass, `thumbnailTemplate` once per thumbnail build, but **`artDirection` injects into EVERY per-shot image prompt** — a big artDirection multiplies token cost across a video's shots. `set_channel_config` returns a non-blocking `warnings[]` advisory when a guidance field is large; keep art direction tight and put per-shot detail in the beat's `imagePrompt`. A validation error names the field + actual-vs-allowed length so a multi-field patch doesn't need bisecting. |
| **`autoApproveVisuals`** | boolean | **skip the visuals halt** (default off). |
| **`autoApproveFinal`** | boolean | **skip the final publish halt** (default off). |

Engines only work if the matching provider key is set on `/account`; otherwise
the pipeline falls back (and warns). Stock sourcing needs the library keys (§6).

**`visualDirector` — read this before switching it off (ticket 01KY27G4…).** It is a
**shot planner**: ON, an LLM cuts the script into shots on *meaning* and picks each
shot's medium (still vs animated), overriding the mechanical `rhythm` cut. It does
**not** write image or motion prompts — those are separate agents that an authored
production **already bypasses**, so your verbatim `imagePrompt`/`motionPrompt` are safe
whether it's on or off. Turning it **off does not protect your prompts**; it just falls
back to the mechanical `planShots`/`planMotion` cut (the ~83-shots / 1-animated
behaviour in §5b). For authored long-form, **leaving it ON** generally gives fewer,
meaning-based shots and more shots that actually move.

---

## 5. Authoring a script the right way (`author_script`)

Give the pipeline a complete, self-consistent script:

- **`hookText`** — the spoken first 1–2 seconds.
- **`beats[]`** in order. Per beat:
  - `type` — `hook` (usually beat 0) · `stat` · `insight` · `cta` (usually last) · `rehook` (a mid-video beat that re-grabs attention — use it to break a long exposition run; it's the type `review_beat_map`'s flat-run check looks for).
  - `text` — the spoken narration for this beat. This drives everything (voiceover, captions, shot timing).
  - `imagePrompt` — **provide a full prompt to own it.** ≥20 chars → used verbatim, the prompt-builder LLM is skipped. Subject-first, concrete, era-correct, no on-screen text. Leave thin/empty → the platform writes one from the beat.
  - `referenceEntity` — a **named real subject** ("Supermarine Spitfire", a person, place, event) → the platform sources a real photo/clip of it. Use for anything real.
  - `referenceEntities` — **#69:** an **ordered list** of real subjects consumed across the shots this **one** beat is cut into (shot *i* → `referenceEntities[i]`, falling back to `referenceEntity`). Supply **N distinct briefs for a beat that fans into N shots without adding beats** — the fix for an artwork/still-image channel where the shot count exceeds the beat count. Check `review_beat_map`'s `entityCoverage`.
  - `imagePrompts` — **#69 (append):** the **generated-shot twin** of `referenceEntities` — an **ordered list** of per-shot image prompts consumed across the shots this **one** beat is cut into (shot *i* → `imagePrompts[i]`, falling back to `imagePrompt`). Use it so a **generated** beat that fans into N shots renders **N distinct images** instead of the same prompt N times (two takes of one diagram read as an error). `imagePrompts` for generated channels; `referenceEntities` for sourced ones.
  - `visualBrief` — the concrete visual ask (never echo the narration; figurative language gets drawn literally).
  - `heroShot` — `true` on the 2–4 pivotal beats only (premium image model).
  - `quoteCard` — **#72:** `{ text, attribution? }` → render this beat as a **typeset quote card** (centred text on a plain near-black ground) instead of an image, held for the beat's spoken duration. The section-boundary device (a quote, a verse ref).
  - `payoff` — `true` on the **one** beat that discharges the hook's promise (**#69**). `review_beat_map`'s `payoff_position` advisory checks *that* beat against the channel's ~60% target; without it the check falls back to the last `heroShot`, and if there's neither it stays silent (rather than reporting a false ~99% on a fine-grained map).
  - `motionPrompt` — an i2v motion prompt (subject action + camera move, no text) — used verbatim if this beat animates.
- **`productionProfile`** (optional) — per-video overrides. **#80: this is a PARTIAL MERGE over the channel profile — sending one axis overrides only that axis and every other axis inherits from the channel** (it never resets the rest to platform defaults). Same semantics as `set_channel_config`'s partial write. Either way the profile-proposal LLM is skipped. The response echoes the **`resolvedProfile`** (`motion`, all four image engines, `voiceModel`, `music`, `captions`, `archivalStrength`, `visualDirector`, and **#93 `imageStyle`**) so you can assert exactly what the video will generate against — don't infer engines from the shot-plan notes. **#93: an authored `imagePrompt` is verbatim for the SUBJECT/composition, but the channel's house `dna.imageStyle` is still applied as a render-register suffix** (so a *"NOT photographic"* channel doesn't render photoreal) — `resolvedProfile.imageStyle` is that string. **#93 (2026-08-03 REOPEN — corrected):** when a **distilled Style-tab style is active its `promptSuffix` becomes the register instead** (it is what the builder would have woven in), and there is **no carve-out that skips the text register**. The earlier claim that an active distilled style *"rides as reference-image conditioning and wins"* was **wrong** and caused a live regression: that conditioning fires only on **nano-banana**, and the distilled style's own text lives in the builder that authored prompts skip — so on a qwen/seedream channel an authored prompt reached the model with **no style at all**. Verify for free with `get_channel_config.shotStyleRegister` `{source, register}` (which register an authored prompt gets on this channel) and `get_production_shots[].renderedPrompt` / `.styleSource` (what actually steered a rendered shot). Bake a one-off look into the prompt only to override the house style for that shot.
- Provide **`ideaId`** (existing) or **`ideaTitle`+`ideaAngle`** (mints an idea).
  The `ideaId` is a backlog idea from **`list_ideas`** — **or (#86) a series EPISODE id
  from `list_series`**, which `author_script` now resolves to the episode's backing idea
  (minting + linking one if the episode isn't queued yet, so the arc episode reconciles
  to `published` after upload — reconciliation is by ideaId). `review_beat_map` accepts
  and resolves the id the same way and returns an `ideaIdWarning` up front if the id
  matches neither an idea nor an episode.
- **Duplicate guard scope:** it blocks re-publishing an idea that already has a **live
  published** video (make a corrected copy for that). A **rejected / halted / failed**
  production does **not** block re-authoring against the same idea — re-running after a
  gate rejection is the normal path, not a reason to mint a duplicate idea.

**Length:** the number/length of beats should sum to the target duration
(~2.5 spoken words/second). For long videos, author many beats; set the
channel's `targetLengthSec` first for consistency.

**Where it lands:** on T0/T1 it stops at the visuals gate → clear it (§2 Stage 4).
On T2/T3, or with `autoApproveVisuals`/`autoApproveFinal`, it flows straight
through. The **anti-clone check + review board always run** — if either blocks,
`get_production` shows `on_hold` + a `failureReason`.

---

## 5b. Shots & motion — how many images, and which ones move

The pipeline cuts each **beat** into **shots** — one image per shot — so the shot
count is usually far higher than the beat count. You never have to hand-compute it:

- `author_script` and `get_production` return an exact **`shotPlan`**
  (`projectedShots`, `projectedMovingShots`, `unusedMotionPromptBeats`, per-beat).
  **#81:** `estimatedDurationSec` echoes the channel `targetLengthSec` when one is set;
  **`wordBasedDurationSec`** is always this script's own runtime at ~2.5 w/s — compare
  them to catch a script written well under/over its target (a `notes` entry flags a
  >25% gap, since `review_beat_map` advisories + the length floor score against the target).
- `review_beat_map` returns a **`shotEstimate`** *before* you write narration — with (**#69**) `suppliedEntities` + `entityCoverage` (distinct briefs ÷ estimated shots). Below 1.0 the uncovered shots re-query one photo pool (duplicates); close it with `beats[].referenceEntities` (sourced) or `beats[].imagePrompts` (generated) — not more beats — or a higher `minSecondsPerShot`. **Caveat (#69):** `minSecondsPerShot` is **inert while motion animates** — the i2v clip cap (~10s) force-cuts moving shots, so raising the floor above it on a `motion: partial`/`ai_video` channel saves no shots (`set_channel_config` and `shotPlan.notes` now warn). For fewer, longer shots use `motion: static` (Ken-Burns holds honour the floor). On a `motion: static` + `imageDensity: relaxed` channel, `runtime_compressed_for_beats` is suppressed (a high beats/min there is a shot-supply strategy; the word budget stays the cramming test).
- **Iterating a beat map:** pass **`ideaId`**. The `structural_repetition` block (the
  compliance check — templated low-variation structure across a channel is what
  YouTube's inauthentic-content enforcement targets) compares only against **other**
  episodes; revisions sharing an `ideaId` are excluded, so re-submitting a revised map
  is never blocked as a near-duplicate of the draft it supersedes (the corpus keeps
  only the latest map per other episode). Cross-episode similarity stays exactly as
  strict. Omit `ideaId` only for a one-off standalone check.

**What drives the shot COUNT**
- `rhythm` sets where cuts land: `sentence` ≈ one shot per sentence; `section` = one
  shot per beat; `pause` = cut on real audio gaps (`> 0.35s`).
- `imageDensity` sets the min-seconds-per-shot **floor** and per-beat **cap**:
  `relaxed` = fewer/longer stills (long-form floor ≈ 11s, ≤2/beat), `standard` ≈ 7s
  ≤3/beat, `busy` ≈ 5s ≤4/beat.
- **When the video animates (`motion` ≠ `static`), every shot is also force-cut at
  the i2v clip cap (~9s), and that dominates** — an animating ~15-min video is
  ~80–100 shots almost regardless of beat count. There is no fixed words-per-shot
  number; it's emergent.
- Consequence: **supply enough distinct visual briefs to fill the slots.** 19
  paragraph-sized beats on one `referenceEntity` → ~83 slots → ~64 re-queries of the
  same photo pool → duplicate images. The fix is **more, finer beats** with
  shot-specific entities (`"SR-71 cockpit"`, `"SR-71 at takeoff"`), not fewer shots.

**Which shots MOVE** — decided by the `motion` axis:
- `static` → nothing moves.
- `partial` → **only `heroShot` beats' first shot** (typically 2–4), capped at
  `maxAiClips`. `motionPrompt` does **not** select here — a `motionPrompt` (or beat-map
  `animates`) on a **non-hero** beat is **ignored** (surfaced as `unusedMotionPromptBeats`).
- `ai_video` → the budget (`maxAiClips`) is **spread evenly across the runtime** so
  movement is sustained, not front-loaded (ticket 01KY3HWK…): **hero shots + the
  opening always move**, then the **beats you marked** (`animates:true`, or a
  `motionPrompt`; sampled evenly if they exceed the budget), then an even spread across
  the rest. So under `ai_video`, marking the beats you most want to move
  (`animates:true`, or supply a `motionPrompt`) steers the clip budget to them.
- "I supplied 9 `motionPrompt`s and 1 moved" = you were on `partial` (hero-only) —
  switch to `ai_video`, or mark more beats `heroShot`.
- Clips that fail or return no usable output fall back to the still and are recorded in
  `get_production.clipFailures` (previously this could be silently empty).

**`visualDirector` ON overrides this** (§4): the director cuts shots on meaning and
picks each shot's medium, so both the shot count AND which shots move change (it can
animate a shot it marks "motion", not only `heroShot`s). The `shotPlan`/`shotEstimate`
projections describe the **mechanical path** (`visualDirector` off); with it on, the
real cut differs.

**Reading the visuals gate:** `get_gate` returns one entry per **shot**, not per beat —
so a 19-beat script shows ~83 shots. Only the shot that opens a beat carries that beat's
narration; the extra shots within a beat have `narration: null` (they share the beat's
spoken line). Each shot's `beatIndex` maps it back to its parent beat. This is expected.

---

## 6. Getting real images from the libraries

Real imagery is sourced automatically — you don't call a "fetch image" tool.
To make it happen for a shot:

1. The channel's `visualMode` must be `real_footage` or `mixed` (set via `set_channel_config`).
2. The beat must name a **`referenceEntity`** (best) or carry a **`visualBrief`** / descriptive narration.
3. The relevant keys must be on `/account`:
   - Archival (keyless, always on): Wikimedia Commons, NASA, Openverse.
   - Stock photos: `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `UNSPLASH_ACCESS_KEY`.
   - Stock video: `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `COVERR_API_KEY`.

The platform tries archival first, tops up with stock when thin, vision-scores
each candidate for fit, and **auto-credits** everything in the description. If
nothing fits, it generates an image from your `imagePrompt`. So: name real
subjects and the video uses real footage; leave a beat abstract and it generates.

**Use a shot-specific `referenceEntity`, not one generic name repeated across beats**
(ticket 01KY27G4…). A well-photographed subject has only ~30–50 genuinely distinct
public-domain images, so `"SR-71 Blackbird"` on 11 beats (→ ~48 shots) queries **one**
pool and visibly repeats. `"SR-71 cockpit"`, `"SR-71 at Kadena"`, `"SR-71 inlet spike"`
each query a distinct pool. `review_beat_map` and the `author_script` `shotPlan` flag a
repeated entity **before** spend.

**Stock rate governor (why a source may be skipped):** the free stock APIs have
strict app-wide limits (Unsplash demo = 50/hr for the *whole platform*), so
every stock call draws from a global per-provider token bucket shared across all
channels, plus a 24h search cache. When a bucket is empty that source is skipped
and the beat falls through to the next library or to generation — never blocked.
This is invisible to authoring; it just means under heavy load some beats lean on
archival/generation instead of stock. Nothing you set can breach the limit.

---

## 6a. Branding — avatar + banner

Branding is generated in the **cockpit** (channel Settings → Branding), **not** by
`create_channel` over MCP — so a freshly MCP-created channel has no avatar/banner
until you generate them there. **`get_channel_branding(channelId)`** reads whether
each asset is set and its `/api/media` URL. Constraints the generator encodes:
avatar is **800×800 square**; banner needs **≥2048×1152** with the subject in the
central **safe area** (~1235×338 guaranteed visible; edges cropped per device).
Applying either to YouTube stays a manual operator step (no avatar API).

---

## 6b. Music — per-channel bed + per-video track

Two scopes, both editable over MCP and in the cockpit Music panel:

- A **CHANNEL BED** is a reusable pool of ~8 tracks; the render **alternates**
  through them least-recently-used first, so a channel sounds consistent without
  repeating one bed on every video. A **PRODUCTION track** is the bed for one
  video only.
- Tracks are **free CC audio** sourced from **Openverse** (auto-credited), or an
  AI-generated bed (ElevenLabs) / a promoted library track.
- The **`music`** axis (`off`/`subtle`/`standard`, set via `set_channel_config`)
  gates whether any bed plays and at what level; `musicMood` is the default brief.

MCP tools:

- **`get_music(productionId)`** — reads `musicMood`, `bedTarget`, the channel
  `bed[]`, and this production's candidate tracks (which one is `selected`).
  Start here.
- **`search_free_music(query)`** — Openverse CC audio; returns track objects you
  pass straight into the `set_*` tools (unavailable in mock mode).
- **`set_music_bed(channelId, {addOpenverseTrack | addProductionStorageKey |
  removeBedTrackId})`** — edit the channel's reusable pool (affects **all** future
  videos). Exactly one op per call.
- **`set_production_music(productionId, {selectCandidateId | useBedStorageKey |
  useLibraryStorageKey | useOpenverseTrack})`** — pick the track for **one** video
  without touching the bed. Exactly one op per call.
- **`generate_music(productionId, mood?)`** — **paid** AI bed for one video
  (ElevenLabs), sized to the voiceover; first candidate auto-selects. Prefer a bed
  or free track first.

---

## 6c. Characters — the recurring on-screen cast

A channel can have a named on-screen character — a teacher, a mascot, or **several
co-hosts** — with a canonical look the pipeline injects into shots so it stays
consistent across every video. This is fully manageable over MCP (it was previously
cockpit-only):

- **`list_characters(channelId)`** shows the cast: each has a name, a canonical
  description, a `role`, a `castMode`, a `castTarget`, and `enabled`.
- **`create_character(channelId, name, brief, {constraints?, castMode?, castTarget?, role?})`**
  turns a plain brief (*"a warm 40s physics teacher with round glasses and a
  cardigan"*) into that canonical description **and** renders a Nano Banana
  reference sheet in the channel's active visual style. It runs **synchronously**
  (a few seconds) because it generates an image.
  - **`constraints` (#90)** — HARD proportional/anatomical rules passed to the
    render **verbatim, never distilled**: ratios (*"legs roughly half his total
    height"*), *"N heads tall"*, explicit negations (*"not dwarfish / not squat"*).
    The brief→description distiller compresses measurements into vague adjectives,
    and a diffusion model defaults to squat on a heavy build — so put load-bearing
    measurements here. The response returns **`droppedConstraints[]`** when a
    measurement in the brief didn't survive distillation; move those into
    `constraints`. `refine_character` takes `constraints` too (replaces/keeps).
- **`castMode`** = how often the pipeline FORCES the character on-screen:
  - `auto` (default) — the scene-builder casts them **by name** only where the
    scene genuinely calls for them;
  - `off` — never cast;
  - `smart` — forced into ~`castTarget`% of shots, **importance-ranked** (hero/
    named/opener beats first; diagram/text filler rides the cheap engine);
  - `25`/`50`/`75` — forced into that fixed share;
  - `always` — every generated shot (a mascot).
  **`set_character_cast(channelId, characterId, {castMode?, castTarget?, enabled?})`**
  changes this **without re-rendering** the look. `enabled:false` benches a
  character (kept, never cast) instead of deleting it.
- **Casting is ALSO per-shot, not only per-channel (#70).** `castMode` is the
  channel-level *forcing* knob, but you can cast one specific character into one
  specific shot at the visuals gate with **`regenerate_shot(..., {characterId})`**,
  or in BULK with **`edit_shot_prompts(shots:[{shotIndex, characterId, …}], regenerate:true)`**
  — the cheap way to place a period-specific cast (Jude in one beat, Tertullian in
  six) deterministically instead of leaving it to `castMode:auto`. Casting redraws
  the shot (so `edit_shot_prompts` needs `regenerate:true`); the id must belong to
  the channel. `characterId` is ignored in re-source mode.
- **Multiple characters on one video (a multi-host show):** add several characters
  and give each a forcing `castMode` — e.g. two co-hosts at `50` each. The pipeline
  gives **each its own share of shots and never double-books one**, so both hosts
  appear in the same video. `role: "main"` marks the lead presenter and is filled
  first when two characters want the same shot.
- **`refine_character(channelId, characterId, comments)`** revises the look
  (*"shorter hair, a red scarf"*) — the same face/identity is preserved, and the
  canonical description + reference sheet update together. **`delete_character`**
  removes one for good (prefer `enabled:false` to keep it).
- **Test scenes — try before you author.** `generate_test_scene(channelId, scene,
  {characterIds?, styleId?, imageEngine?})` renders a throwaway image. **Cast any number of
  characters** with `characterIds`: each one's canonical description *and* reference sheet go
  to the model, so you can verify they hold **distinct** identities in one frame. It does
  **not** require a distilled style — it uses the active/newest distilled style, else the
  house `imageStyle`, else no style at all — and returns the URL plus exactly what steered it
  (style used, cast, engine). `list_test_scenes` shows past ones; `refine_test_scene` reworks
  one with its current image as the edit reference. Each costs one hero image, belongs to
  **no** production and never publishes; promote a keeper into the example pool from the
  cockpit **Style** tab so the next distill learns from it.
- **Aspect ratio is an explicit axis.** `productionProfile.orientation` = `auto`
  (default) · `landscape` (16:9) · `portrait` (9:16), settable via
  `set_channel_config`, per video on `author_script`, or in the cockpit under
  **Profile → Aspect ratio**. `auto` derives it from the content format (long-form,
  or `targetLengthSec > 90` → landscape; else portrait). **Set it explicitly on a
  channel whose `contentFormat` is `"both"`** — the cockpit used to test
  `contentFormat === "long"` alone, so a `"both"` channel regenerated its shots as
  **portrait** on a 16:9 video while the pipeline produced landscape. A single rule
  (core `videoAspect`) now decides for every image, clip and render. Note the
  two-level model (**#51**): `contentFormat` is the **channel-level** format switch
  (`long`/`short`/`both`, set via `set_channel_config`) and is **load-bearing** — it
  feeds this same `videoAspect` rule, the shot planner's `isLong`, and scriptwriter
  length steering; `orientation` is the per-**video** override. Moving a channel to
  `both` changes real render behaviour, so set `orientation` explicitly in the same call.
- **Orientation is enforced in the prompt.** Every image **and animation** prompt in
  production automatically has its frame shape appended — *"Wide 16:9 landscape
  orientation…"* / *"Vertical 9:16 portrait orientation…"* — matching the video's
  format. Image and video models treat the `aspect` API parameter as a hint and
  routinely return the wrong shape (ticket 01KY9EBK…/#50), so the orientation is
  stated where they actually obey it. This applies to **authored/verbatim prompts
  too**: you don't need to write orientation into `imagePrompt` / `motionPrompt`, and
  if you do it isn't duplicated. Channel **brand art is the exception** — its authored
  prompt stays byte-for-byte verbatim.
- **Audit aspect over MCP (#50).** `get_production_shots` and `get_gate` return
  `renderAspect` (what the video renders at), a **per-shot `aspect`** (recorded when the
  still is generated/re-sourced — `null` on shots produced before aspect recording
  landed), `aspectMismatchShots` (recorded aspect ≠ `renderAspect`) and
  `shotsWithUnknownAspect`. `regenerate_shot` accepts an **`aspectRatio`** override
  (`16:9`/`9:16`/`1:1`) to force one shot's orientation. This reports the *recorded
  render aspect*, not decoded pixel width/height — capturing true served dimensions at
  every generation site is a **deferred** follow-up (`get_deferred_work`).
- **Engine preference is honoured everywhere.** The Style-tab per-role engines
  (`imageEngine` bulk, `heroImageEngine`, `characterImageEngine`,
  `thumbnailImageEngine`) now drive the cockpit's thumbnail generation, thumbnail
  refine and per-shot regeneration too. Those paths previously used a legacy helper
  that **always pinned `nano-banana`**, so a channel set to `seedream` still rendered
  on nano while the worker honoured the setting. An explicit `imageEngine` argument
  still wins.
- **Alignment means alignment (2026-08-07).** Operator narration is force-aligned with
  Whisper, and the aligner emitted **Whisper's words** — what the ASR *heard*, not what
  was written. Those words are the render's **captions** and each shot's reported
  narration, so a real 122-segment read carried one surname four ways
  (`Fuscone`/`Foscone`/`Fuscoen`/`Fusco`), "Housel's account" as "households account",
  and "**Tails** drive everything" as "Tales". Whisper now supplies only the **timings**;
  the **script** supplies the words, matched monotonically — a mis-heard word keeps the
  script's spelling, ASR insertions ("um") are dropped, and words the ASR missed are
  spread across their gap so timings stay monotonic and inside the piece. Re-assemble
  (`reopen_stage` → `voiceover`) to pick this up on a production assembled before it shipped.
- **A production's profile can now be corrected (2026-08-07).** `set_production_profile`
  — a production snapshots the channel profile when it starts and deliberately never picks
  up later channel edits, but nothing could update that snapshot afterwards. That is why a
  channel switched to `seedream` everywhere still rendered 31 shots on `qwen`: the
  production predated the change. It governs stages that run **from now**, so the response
  names the stages to reopen for it to reach work that already exists.
- **Cockpit parity for the in-place verbs (2026-08-07).** `continue_production`,
  `reopen_stage` and `cancel_reopen` are now **buttons on the production page**, not
  MCP-only. A halted production previously offered only a legacy **Resume** (mints a
  **sibling** production row) and **Force forward** (publishes, skipping the gates) — so the
  only visible "carry on" control was the one that starts a *new* production, where
  per-production voiceover takes do **not** follow. **Continue** now leads; Resume is
  labelled as the legacy new-row path and states outright that recorded takes don't come
  across; Reopen previews its impact (the same `reopenImpact` the MCP tool returns) before
  anything changes. The recorded-takes list also decodes the encoded take index — a segment
  take read `Beat 100001` instead of `Beat 1 · part 1`.
- **A keyless engine no longer jumps the list.** If the configured engine has no API
  key on the worker, the request degrades to the channel's **next configured** engine.
  It used to be substituted *before* the Style-tab list was read — that list was only
  consulted when a call **failed**, and a missing provider never throws — so it fell
  through to a **qwen-first** last resort. A channel with all four image roles set to
  `seedream` and no ModelArk key therefore rendered **every** shot on `qwen`, an engine
  appearing nowhere in its config, silently. When *nothing* configured has a key the
  platform still serves (placeholder art in a real video is worse), but logs it as an
  explicit substitution naming the missing key. **Same shape on video:** a `seedance`
  channel with no `SEEDANCE_API_KEY`/`ARK_API_KEY` serves clips on `wan` — the video
  side has no per-channel fallback list, so that substitution stands, but it is now
  logged by name. **Check keys first** when an engine looks wrong: `/api/diag/media`
  reports which of GEMINI/DASHSCOPE/SEEDREAM/SEEDANCE/ARK are present, and
  `get_production_shots` reports `engineRequested` vs `engineServed`.
- **Brand art (logo + banner) over MCP.** `generate_brand_art(channelId, surface,
  {...})` is the cockpit's Branding generator. Pass **`prompt`** and it is used
  **verbatim** — nothing is prepended (no channel preamble, no style block, no character
  description), so what you write is exactly what the model gets. Omit it and the
  platform **composes** one from the channel name/niche plus `includeName`, `tagline`,
  `background`, `alignStyle` and `extra`. `mode:"refine"` with `changes` edits the
  **current** art in place. Reference images ride along either way: `characterId`
  (feature a character *in* the art, never as the art), `sceneId` (a test scene's
  palette/mood), `useCurrent` (rework the existing art). The result is **applied to the
  channel immediately**, old versions are kept (revert in the cockpit), and the exact
  prompt is written to the decision ledger. Read the assets back with
  `get_channel_branding`. Pushing a banner to YouTube is a cockpit action, and YouTube
  has **no avatar API** — that upload stays manual.
- **Pick the model.** `create_character` and `refine_character` take an optional
  **`imageEngine`** (`nano-banana` · `seedream` · `qwen`) for the reference sheet —
  the cockpit **Style → Characters** section has the same dropdown. Omitted → the
  channel's Production Profile **`characterImageEngine`** (Nano Banana unless set);
  the sheet is no longer hardcoded to Nano. Prefer `nano-banana` for characters you
  expect to **refine** — it conditions on the existing sheet, so it holds the same
  face best. A failed render degrades down the channel's own Style-tab engines.
- **The brief is WHO, not HOW.** Describe physical **identity** only — age, build,
  hair, skin, face, signature clothing, palette. Do **not** put render
  medium/register (photoreal, painterly, animation, *"not a painting"*), pose,
  camera/crop (portrait, full-body), background, or scale into the brief. The
  channel's **active visual style** (Style tab — built from the operator's prompt +
  uploaded examples) supplies the LOOK, and each **scene** supplies the framing. The
  reference sheet is a neutral, **single-figure** identity plate rendered *in that
  style* — no scenery, props, collage/model-sheet layout or text, and only the
  channel's render *register* (not its scene composition) is applied, so
  channel-thematic scenery can't bleed into the plate. The
  canonical description is stripped to identity so scenes stay free to pose and scale
  the character (human-sized, god-size, mid-action) — it never locks them into a
  photoreal portrait. **To change the medium/look, change the channel style, not the
  character brief.** The chat lever is `set_channel_config` `dna.imageStyle` (a
  plain-language house style like *"bold graphic illustration, NOT photographic"*),
  which steers every character + scene render; a distilled Style-tab style (built from
  uploaded examples) wins over it when one is active.

Which model actually draws/animates character shots is a separate axis — the
`characterImageEngine` / `characterVideoEngine` on the **Production Profile** (§4).

---

## 7. Recipes

**Run one video end-to-end on an existing channel**
1. `get_channel_config <id>` — see the profile + autonomy.
2. *(optional)* `set_channel_config` — tune `visualMode`, `targetLengthSec`, engines.
3. `author_script` — hook + beats with full `imagePrompt`s and `referenceEntity`s.
4. `list_gates <id>` → `get_gate` to inspect the shots and flag anything off
   (`report_issue`). **The operator approves the visuals + final gate in the cockpit.**
5. `get_production` until `status` is `scheduled`/`published`.

**On approval:** it stays with the human until output quality is proven — don't
propose flipping `autoApprove*` or raising autonomy. Your job is to author well and
surface problems so the review is fast, not to remove the review.

**Stand up a new channel**
1. `propose_channel` → review the draft charter.
2. `create_channel` → follow the returned manual YouTube checklist (create the
   Google/YouTube account + handle + avatar by hand, connect OAuth in the cockpit).
3. `set_channel_config` to finalise the profile, then author as above.

---

## 8. Long-form (30–120 minutes)

- Set the channel's **`targetLengthSec`** first (`1800` = 30 min, `7200` = 120 min).
- In `author_script`, write **many beats** — total spoken words ≈ `targetLengthSec × 2.5` (30 min ≈ 4,500 words; 120 min ≈ 18,000). Break narration into paragraph-sized beats, one visual section each.
- **Voiceover chunks automatically** — the platform splits a long script into TTS-sized pieces on sentence boundaries and stitches them (no per-call char-limit failures).
- **Cost/scale:** a long video implies hundreds of shots/images. Set `productionProfile.imageDensity = relaxed` and lean on real footage (`visualMode: real_footage`/`mixed` + `referenceEntity`) to bound generation cost.
- **Render:** very long videos need **Remotion Lambda** (set the `REMOTION_*` keys on `/account`); the local renderer is too slow at this length.

## 8b. Driving & recovering productions (parity batch, 2026-07-28)

You can steer a production's whole lifecycle over MCP, not just author it. **Gate approval stays human** (approve/reject/revise is the editorial-judgement record), but everything around it is now a tool:

| Tool | What it does |
|---|---|
| `greenlight_idea(ideaId, {allowDuplicate?})` | send an **existing** backlog idea into production (the "just produce it" path; `author_script` is the hand-authored one). |
| `halt_production(productionId, {discard?})` | stop an in-flight run, return the idea to the pool; `discard` any of `script`/`voiceover`/`images`/`render`/`thumbnails`. |
| `continue_production(productionId)` | **CONTINUE** — resume a held/blocked production from exactly where it stopped, **in place**. Nothing deleted, nothing re-billed, no new row; the status lands on the work that **exists**, never upstream of it. Accepts `halted`/`on_hold`/`failed`. Prefer this over `resume_production`. |
| `reopen_stage(productionId, stage, {mode?, confirm?})` | Go **back to a stage** — `script`\|`voiceover`\|`visuals`\|`music`\|`render`\|`thumbnail`\|`publish` — in place. `mode:"reopen"` (default) **keeps** that stage's output so you can refine it; `mode:"clean"` rebuilds it. Everything downstream is marked **stale** and destroyed only when the stage actually re-runs, so it is **reversible** until then. **Call with `confirm:false` first** to preview: the impact names exactly what is discarded *and* what is kept. **The cascade:** `script` → voiceover, visuals, render, thumbnail · `voiceover` → **visuals**, render · `visuals` → render · `music` → render. The non-obvious edge: **re-recording the voiceover invalidates the visuals**, because shots are cut from its word timestamps — the script survives, the shots cannot. Re-cutting visuals **keeps** the music bed and the thumbnail. |
| `cancel_reopen(productionId)` | Undo a reopen that hasn't run yet — the production comes back untouched. This is why deletion is deferred: reopening is often **diagnostic**, and a diagnostic action must not be destructive. |
| `resume_production(productionId)` | **Legacy — prefer `continue_production` / `reopen_stage`.** Restarts a **halted** production as a **new production row** (reuses survivors, skips the script gate); returns the **new** `productionId`. **#94: the copy now carries the halted run's per-video settings** — `externalScript` (an operator-**authored** production stays authored: script gate skipped, authored `imagePrompt`s used verbatim, authored `motionPrompt`s honoured), `productionProfile` (no re-run of the profile-proposal LLM and no fresh `profile_review` gate on an already-decided profile), plus the voice/audio dials and persona/style pins. Before this, a resumed authored production silently reverted to channel defaults, re-gated, and had its authored prompts rewritten by the builder. |
| `retry_production(productionId, stage)` | re-run from `script`/`visuals`/`render`/`publish`. `visuals` regenerates every image and reopens the visuals gate (the agent-usable "regenerate all storyboard"; per-shot fixes are `regenerate_shot`). |
| `force_forward(productionId)` | un-stick a production and resume **in place, reusing all built artifacts (no new LLM/generation calls, no re-render)**. Accepts `on_hold`/`failed`/`rejected` (waive a soft check) AND the built-but-unpublished states `halted`/`scheduled`/`ready` — the manual override to publish a video that rendered but never published (a `scheduled` row with no `providerVideoId`, or an approved `halted` corrected copy stopped at publish). For `halted` this is the reuse-the-render path, distinct from `resume_production` (which re-renders on a fresh copy). **#98:** it re-fires the pipeline (which skips every stage whose artifacts already exist) and now **presents the status matching the work that exists** — `assembling` with a render, `producing_assets` with images — instead of writing `greenlit`, which showed a fully-built, human-approved production as if it were back at the start. **Forward only:** it **skips the human review gates** (visuals + final) and drives straight to upload+publish (private) — the operator's force-forward IS the approval (logged), so it never drops the video back to a gate. Re-renders only if the render asset is missing. To re-review/rebuild, use resume/retry. |
| `retire_production(productionId)` | archive a dead production (live video untouched). |
| `correct_published_production(productionId, {mode?})` | mint a **corrected copy** of a published/scheduled video — `fix` (reuse assets, land at visuals gate) or `rebuild` (regenerate all visuals). Original stays live. Returns the new `productionId`. |
| `release_publication(productionId)` | publish an uploaded video **now** — works on a **scheduled** video (releases it now **and** clears the future slot in one call) or a parked-private one; the Made-for-Kids (COPPA) designation is preserved on go-live (#53). Immediate counterpart to `set_publication_schedule`. |
| `dedupe_shot_images(productionId)` | one-click re-source of duplicate **real** photos at the visuals gate. |
| `fill_thin_prompts(productionId)` | elaborate every thin/empty image prompt before render. **#83: ASYNC** — returns a `jobId` immediately (the pass fans out over an LLM and would outlive the MCP timeout); poll `get_job(jobId)`, then re-read `get_production_shots`. |
| `get_job(jobId)` | **#83:** poll a background worker job — `status` (queued/running/done/failed), `op`, `error`. Poll this after an async tool **instead of retrying** the original call (a retry on a timeout is what double-bills). Read-only. |
| `run_trend_scan()` / `run_analytics_ingest()` | kick the trend fast-lane / analytics ingest on demand (the latter refreshes `get_video_analytics`/`get_channel_analytics`, subject to YouTube's 24–72h lag — use to verify an analytics-gated fix). |
| **#101 operator narration** | `productionProfile.voiceSource` = `tts` (default, synthesised) or `operator` (**you narrate**). On `operator` the run **holds at a `voiceover_recording` gate**; record in the cockpit (production page → voiceover recorder — needs a browser mic, so the recording itself can't happen over MCP), then approve the gate. You record **segments**, not paragraphs: each beat is cut into sentence-grouped ~25-word chunks that **never break mid-sentence**, so a fluffed line costs one short re-take rather than a 50-110 word paragraph. Anything left unrecorded is **TTS-filled per segment**, so a partial read is fine. **Recorded in a DAW instead?** Each card also accepts an **uploaded file** (wav/mp3/m4a/ogg, ≤ 50MB), and over MCP **`set_production_voiceover(productionId, {audioUrl, beatIdx?, segIdx?})`** attaches audio from a URL — omit `beatIdx`/`segIdx` to supply **one file for the whole script**, which becomes the entire narration and is force-aligned against the approved script. Attach it while the run sits at the `voiceover_recording` gate (before visuals), since shot boundaries are cut from the voiceover. Takes are **force-aligned with Whisper**, so captions and shot boundaries cut from your real delivery (needs `OPENAI_API_KEY`; without it timings fall back to a linear estimate and captions drift). Set per channel with `set_channel_config`, or per production with `set_voice_source` — and set it **before the visuals stage**, since shot boundaries derive from the voiceover and changing it later re-cuts and re-bills the shots. `get_production().voiceover` reports the source, `segmentCount`, `takesRecorded`, `segmentsAwaitingTake` and whether the assembled track is yours — plus **`alignment` `{whisper, estimated, pieces}`**. An `estimated` count above zero on recorded audio means Whisper did **not** align it (missing or failed `OPENAI_API_KEY`), so captions and shot boundaries drift against the real delivery; `alignmentWarning` names the fix. The recorded audio is unaffected — re-assemble once the key is working. **#103: assembly gives every SEGMENT its own file.** The assembler named its working files by **beat**, which was unique until #101 cut beats into segments — after that all the segments of one beat shared a name, the last one overwrote its siblings, and the concatenation played **one take per beat on repeat** while every count still read correct. Fixed, and guarded: a plan that is not 1:1 now **fails** the assembly rather than shipping repeated audio. The recordings were never at risk — each take is stored under its own key and is individually downloadable from the production page. `get_production().voiceover` also reports **`assembledAt`, `assembledPieces`, `assembledDurationSec`**, plus an `assemblyWarning` when `assembledPieces` disagrees with `segmentCount`, or when an assembled **file** exists in storage with **no asset row attached** — what halting with `discard:['voiceover']` leaves behind, which reads `assembled:false` while the audio is still audible. Rebuild with `continue_production` or `reopen_stage('voiceover')`. |
| **Per-role image engines** | Set each independently on `productionProfile` via `set_channel_config`: `imageEngine` (bulk/filler, default `qwen`), `heroImageEngine`, `characterImageEngine`, `thumbnailImageEngine` (those three default to `nano-banana`). Engines: `qwen` ($0.025) · `seedream` ($0.03) · `nano-banana` ($0.134). **Thumbnails are NOT pinned to Nano Banana** — `thumbnailImageEngine` is honoured like every other role, and `quality` (`standard`/`hero`) is a separate axis that never overrides the engine. A failing engine degrades only down the engines you set. `regenerate_thumbnail` also takes a per-**call** `imageEngine` override for trying one model on a single thumbnail without changing the channel default. |
| **#102 `productionProfile.gates`** | Name the human review gates a channel wants — `script_review` · `profile_review` · `voiceover_recording` · `visuals_review` · `thumbnail_review` — via `set_channel_config`. Placement used to be *implied* by `autonomyTier` plus `scriptAuthored`, which conflated **who wrote it** with **does a human approve it**, making "I authored this AND I want to approve it" unexpressible. Naming a gate **adds** it regardless of tier or authoring flags. Declaring gates **never removes** one — removal stays with the audited `autoApprove*` flags — and omitting the field preserves today's behaviour. Approval is still a human cockpit action; this configures placement, not bypass. |
| **#102 generation failures** | A structured-output failure now names the **agent** and **model**, and distinguishes **truncation** (hit the output cap mid-JSON — retrying at the same cap repeats it; shorten the ask or raise the cap) from a **shape mismatch** (complete but wrong shape — flaky, and now **retried once** automatically). Failed calls are recorded in `agent_actions` with their token cost, so vendor-charged spend on a discarded response is no longer invisible. |
| **P1/P5 `get_production().blocked`** | **Read this first on any stopped production.** `null` when healthy, else `{kind, reason, summary, recommendedAction, canAutoRetry, stuckForMinutes}` with `kind` one of `human_decision` · `gate_timeout` · `compliance_block` · `external_retryable` · `precondition`. Replaces parsing a `failureReason` string to guess a recovery verb — 19 of the pipeline's 20 pre-publish exits wrote plain `on_hold` and differed only by prose. **`canAutoRetry` is true only for `external_retryable`** (quota, upload limits, a stale render bundle); everything else needs a human judgement, so ask rather than `force_forward` on their behalf. **#103: `halted` is covered too.** Halting is deliberate, so it writes no `failureReason` — which meant a stopped run reported `blocked: null`, the *healthy* shape, with no reason and no recommended action. A halt now reports `kind: human_decision` with the **in-place** recovery verbs (`continue_production` / `reopen_stage`), not the gate-rejection ones. |
| **P3 timed-out gates** | Deciding a gate only works while a pipeline run is listening. When a gate had already **timed out** that run was gone, so the decision marked the gate `decided` (hiding it from `list_gates`) and the production sat untouched — the exact state **#94** reported. Deciding a timed-out gate now **re-fires the pipeline automatically**. |
| **P6 authoring intentions** | `scriptAuthored` / `promptsAuthored` / `motionAuthored` replace the single `externalScript` flag, which silently governed all three (skip the script gate, skip the prompt builder, honour authored `motionPrompt`s). Carried across resume and corrected copies as a **struct**, so a copy boundary can no longer half-un-author a production (#94). A partial pass — your script, the platform's prompts — is now expressible. |
| **P4 `resume_production(…, {inPlace:true})`** | Recover **in place**, with no sibling production. Resume's default new-row behaviour is what mints the same-idea siblings behind #94/#96/#97; in-place reuses every surviving artifact, re-bills nothing, and **skips the gates** (same contract as `force_forward`). Leave it off for a clean re-render with every gate re-presented. |
| **P2 `productionProfile.earlyComplianceChecks`** | **Opt-in, default off.** Runs variation / anti-clone / review board **before** the visuals gate instead of after, so a block lands on work nobody has reviewed yet rather than stranding an approved production (#97). Off by default because it moves what "approved" means in the compliance log — enable it with the operator present. |
| **#97 variation check** | After the visuals gate the pipeline compares the script's substance against the channel's **catalogue**. The corpus is **published/scheduled rows of OTHER ideas only** — a production cannot be a duplicate of itself, and every recovery path (`resume_production`, `force_forward`, `correct_published_production`) mints a **sibling** production reusing the parent's `substanceFingerprint` verbatim, so counting siblings returned `jaccard=1.000` and stranded human-approved work in `on_hold`. `failureReason` now **names** the production (and title) it matched. |
| **#99 `get_diagnostics().mcpClients`** | Distinct MCP clients seen in the retention window — `clientId`, self-reported name/version, a **salted hash** of the source address (never the address), call counts, `sensitiveCalls`, first/last seen; `mcpCalls` rows now carry `clientId`/`targetChannelId`/`targetProductionId`. The connector URL carries a token that can publish to your channels and spend credits, so a client you do not recognise means treat the URL as **leaked**: rotate `MCP_BEARER_TOKEN` on `/account`, which invalidates the old URL immediately. A billable/publishing call from a never-seen client also raises a **critical** alert in `openAlerts`. |
| **`get_diagnostics().storage`** | Live **database sizing**: `usedBytes`/`usedPretty`, `usedPct`, the Postgres `cacheHitRatio`, and `largestTables` — the 15 biggest tables by `pg_total_relation_size` (heap + indexes + TOAST), biggest first. Same measurement the nightly `data-janitor` raises its capacity alert on, surfaced so **"is `ytauto-db` the right plan/disk?" is answerable without `psql`** (it was not, and the question came up while the operator was travelling). `usedPct` is against **`DB_STORAGE_GB`, which is CONFIGURED (default 10) and NOT read from Render** — if the provisioned disk differs, set `DB_STORAGE_GB` to match or both this percentage and the janitor's alert thresholds key off the wrong number. `largestTables` is where retention work pays: the top entry is usually a table to expire, not a plan to upgrade. |
| `ack_alert(alertId)` | clear a `get_diagnostics` alert you've handled. |
| `get_diagnostics().stuckReviewStates` | **#94/#98:** productions that are mid-pipeline but going nowhere — **any non-terminal status** idle past the threshold (**#98:** it used to watch only `*_review`, so a production stranded at `greenlit` by a force-forward whose run never took was invisible to the very detector meant to catch it), plus productions parked in a `*_review` status with **no pending gate row** — waiting on a decision that *cannot* be made, since `list_gates` only returns **pending** gates, so the production stays invisible until the pipeline's gate timeout strands it. Empty is the healthy answer. `force_forward` is the unblock (`retry_production` re-enters the stage). **If a production reads as "stuck at voiceover", check this first** — it may never have *reached* voiceover. |
| `add_playbook_entry(channelId, directive, {scope?})` · `adopt_playbook_entry` · `retire_playbook_entry` | write to the channel **playbook** (`get_playbook` reads it) — codify a durable rule (`scope`: hook/pacing/structure/visual/topic/title) that steers every future production, promote a trial rule, or retire one. |
| `revise_series(seriesId, instructions)` | re-plan a story arc via the planner LLM (heavier than `update_series`). ids from `list_series`. |
| `cut_episode(episodeId, {notes?})` · `restore_episode_research(episodeId)` | remove a planned episode / bring it back. |
| `replace_episode(episodeId, {steer?})` | swap in a fresh LLM-generated episode in the same slot. |
| `regreenlight_episode(episodeId)` | mint a fresh production for an episode whose prior one was abandoned. |
| `run_editorial_plan(channelId)` | kick the editorial planner (proposes arcs/episodes). |
| `edit_script_beats(productionId, {beats[] \| texts[]})` | edit beats at the `script_review` gate — narration **and visual direction**. **#88 preferred:** `beats[]`, a **sparse** list of per-index edits `[{index, text?, imagePrompt?, imagePrompts?, referenceEntity?, visualBrief?, motionPrompt?, animates?}]` — edit 3 of 16 beats **without matching the platform's beat count**, each carrying its own visual ask. `imagePrompts[]` is the **#69 per-shot fan-out** (an ordered list consumed across the several shots one beat is cut into) — how ~70 shot prompts get authored from ~16 beats. Read the beats with `get_production` first and edit by index. `texts[]` is the legacy narration-only shape (length must equal the beat count). A **visuals-only edit does not recut the voiceover**; changing narration does. **This is the operator-authoring path that does not depend on `author_script`.** |
| `edit_shot_prompts(productionId, shots[], regenerate)` | **#88:** the shot-level sibling — **bulk** prompt replacement at the **visuals** gate, for when the images already exist (`regenerate_shot` does one shot at a time, impractical at ~70). `shots[]` is sparse: `[{shotIndex, imagePrompt?, referenceEntity?, imageEngine?, characterId?}]` (indices from `get_production_shots`). **#70: `characterId` casts a recurring character into a shot in bulk** (the same per-shot cast as `regenerate_shot`) — needs `regenerate:true` (casting redraws), the id must belong to the channel, ignored when re-sourcing. **#93 (append): an `imagePrompt` you write here is verbatim for the SUBJECT/composition, and the redraw appends the channel's render register exactly as the pipeline does** (the distilled Style-tab `promptSuffix` when a style is active, else `dna.imageStyle`) — so redrawing shots to *fix* a styleless episode can't reproduce the styleless look. Same for `regenerate_shot`'s prompt override. Bake a one-off look into the prompt to override the house style for that shot. **`regenerate` is REQUIRED and is the spend decision:** `false` = store the prompts only (free — nothing is redrawn, so the rendered images do **not** change; use it to stage a pass and review it), `true` = store them **and** queue a redraw of exactly those shots, which **bills per shot**. Redraws are **async durable jobs** (#83), one `jobId` per shot, run one-at-a-time per production — poll `get_job(jobId)` or re-read `get_production_shots`; never re-run the call to "retry" a slow one (that double-bills, #66). Only at `visuals_review`; never auto-approves. |
| `list_thumbnails(productionId)` | read the thumbnail **candidates** with ids (`id`/`url`/`predictedCtr`/`selected`/`sourced`) — the source for `set_video_thumbnail`'s `thumbnailId`. |
| `refine_thumbnail(productionId, thumbnailId, changes, {characterId?})` | edit an existing candidate ("bigger type", "warmer sky") instead of rerolling. |
| `promote_test_scene(channelId, sceneId)` | adopt a validated style test scene (from `list_test_scenes`) as the channel's active visual style. |
| `set_audio_levels(productionId, voiceVolume, musicVolume)` | per-video audio mix + re-render (voice 0–1.5, music 0–1). |
| `set_intel_cadence(channelId, daily\|weekly\|off)` · `add_competitor(channelId, name, {url?})` · `set_opportunity_status(opportunityId, shortlisted\|dismissed)` | tune/pause market scanning, track a competitor, and curate the `get_intel` feed (`opportunityId` from `get_intel` `opportunities[].id`). |

## 9. Gotchas

- **Legacy channels** (created via the classic form) may have **no charter** →
  `get_channel_config` returns `charter: null` and charter edits no-op. DNA,
  profile, authoring, and gates all still work.
- **Autonomy drives the gates:** T0/T1 halt at visuals + final; T2/T3 auto-run.
  The `autoApprove*` toggles override the visuals/final halts independently.
- **`visualDirector: true`** hands shot-cutting to an LLM — leave it **off** if
  you want to fully own the visuals via authored prompts.
- **Engines/stock need keys** on `/account`; without them the pipeline falls back.
- **Stock is globally rate-limited** — under load a stock source is skipped (falls
  to archival/generation), never breached. See §6.
- **Music alternates from a per-channel bed** of ~6-8 free Openverse tracks; the
  `music` axis gates whether it plays. See §6b.
- **New tools ship behind the connector's cached tool list.** If a tool named in
  this guide (e.g. `get_deferred_work`) returns "unknown tool" or never appears,
  the connector is holding a stale list — **reconnect it** (remove + re-add, or
  toggle off/on) to refresh. `get_guide` self-audits and lists any tool it
  references that isn't actually registered, so a genuine gap is named explicitly.
- **Approvals — what auto-runs vs what asks.** Read-only *and* deterministic advisory
  tools carry a `readOnlyHint` so the app runs them **without a per-call approval**;
  tools that **spend on an LLM or write** omit the hint and still ask. The compliance
  pre-check **`review_beat_map` is auto-run** (deterministic, no model spend, only logs
  an audit row — #88), so the structural check is always reachable before spend.
  **`author_script` is not** — it spends and creates a production, so it **always needs
  an explicit approval**. If a call returns the bare **`No approval received`**, the
  host's approval prompt wasn't actioned — **grant the approval** (that string is emitted
  by the Claude app, not the platform, so a legitimately-gated spending tool can only run
  once you approve it).
- **`No approval received` — prove where it comes from before theorising (#88).** That
  string is **not in the platform's code at all**, and the failing set has included
  `get_production`, which **is** advertised `readOnly` — so it is **not** about tool
  annotations. **`get_diagnostics` now returns `mcpCalls`:** a receipt for every MCP call
  that actually **reached the server** (`tool`, `ok`, `error`, `durationMs`, `argsBytes`,
  `at`), plus `lastHandshakeAt` / `lastToolsListAt`. Make the failing call, then read it:
  - **no row** for that tool at that time → the call **never arrived**. The failure is
    entirely host-side; nothing in the platform can fix it. Raise it with Anthropic
    rather than re-filing it as a platform ticket.
  - **a row with `ok: true`** → we ran it and answered; the reply was lost in transit.
  - **a row with `ok: false`** → it **is** the platform's, and `error` names the cause.

  `lastToolsListAt` also settles "is the fix deployed?" versus "is my tool list stale?" —
  if it predates the deploy, **reconnect** before concluding a tool is missing.
- **If `author_script` is unreachable, operator-authored content is NOT blocked (#88).**
  `author_script` is the whole-new-production path, not the only one: **greenlight the
  idea normally**, then author the draft in place with **`edit_script_beats`** at the
  script gate (narration **plus** `imagePrompt`/`imagePrompts`/`referenceEntity`/
  `visualBrief` per beat, sparse by index — no beat-count matching), and fix shots in
  bulk after the fact with **`edit_shot_prompts`** at the visuals gate. Authoring at the
  **script** gate is strictly better than at the visuals gate: the direction lands
  **before any image is generated**, so nothing has to be paid for twice. Both are
  in-gate edits and neither approves a gate — approval stays a human cockpit action.
- **`reconcile_publications` can clean phantoms AND fix date drift** — it verifies each
  publication against the live YouTube video, and `fix:true` demotes a confirmed phantom
  (id resolves to no live video) from `published` to `published_unverified` (id kept for
  history) so counts/averages are right and it stops blocking re-publishing. It ALSO
  flags publishedAt **date drift** (a live record whose stored publish date differs from
  YouTube's real `publishedAt` by >1h — e.g. a scheduled video released early in Studio
  still holding its future slot); `fix:true` corrects the date to YouTube's value and
  **re-triggers analytics ingest** when it moves backward (the missed early window was
  empty while `publishedAt` sat in the future). It never touches `unknown` (provider
  unreachable) or a merely-private live video; `fix:true` is a WRITE, so the app asks
  for approval.
- **Scheduling control + external publish over MCP** — `set_publication_schedule` sets or
  moves (`scheduledFor`, a future ISO time) or clears (`cancel:true`) a production's
  native YouTube release slot while it's uploaded-but-not-yet-public; the platform
  calendar follows. **Reschedule** = call it again with a new `scheduledFor`; to **publish
  a scheduled video now** use `release_publication` (clears the slot + flips public in one
  call). The Made-for-Kids (COPPA) designation is preserved across (re)schedule / cancel /
  release (#53). **#85:** a **not-yet-uploaded** production (a legacy sleep-based schedule,
  or one whose upload never completed) can be (re)scheduled/cancelled too — a purely LOCAL
  calendar write (response has `uploaded:false` + a note that it won't go live until it's
  uploaded via `retry_production` or reconciled), instead of the old dead-end refusal that
  pointed at a closed gate. When the operator publishes a video **manually/externally** (a
  legitimate, recurring case) or a scheduled video goes live off-slot,
  `sync_publication_from_youtube` pulls the real `publishedAt`/privacy for a single
  production (pass `providerVideoId` to attach an id the platform never recorded), marks
  it live with the REAL date, and re-triggers ingest. Both need the channel's YouTube
  credentials; with the mock they report `unknown` and make no change. Prefer these over
  "make a corrected copy", which would create a duplicate record for one live video.
- **Everything is audited** — every write lands as a `channel_decisions` row.
- **Real vs generated:** name real subjects (`referenceEntity`) for archival/stock;
  leave abstract beats for generation. Don't put on-screen text in image prompts —
  captions own text.
