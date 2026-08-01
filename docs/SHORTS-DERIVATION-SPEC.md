# Shorts derivation — slicing a long-form master into styled Shorts (spec)

Status: **design + Phase 1 (cut planner) + Phase 2 (subchannel model) landed**
(2026-08-01). Owner-driven (operator). Phases 3–6 remain.

## Goal

Take an **already-published long-form master** and cut it into short-form videos —
**by pure slicing of the finished master render, with NO re-render and NO re-TTS**.
Each Short is literally a slice of the master's video + audio, reframed to 9:16,
carrying the **subchannel's own styling** (framing, Part-N/title overlay, branding,
and short-native captions). Selection is operator-controlled: even split into N
parts, or an AI "best-moments" pass, or manual windows.

This is an **evolution of the existing** `derive-shorts.ts` + `clip.ts` pipeline
(today: blind sequential 60s ffmpeg blur-pad chunks stamped "Part N", auto-fired
only at master go-live), not a greenfield build.

## Hard constraints (operator, 2026-07-31)

1. **No re-render, no re-TTS.** A Short is an ffmpeg slice of the master's `render`
   asset + its original audio. Styling is applied as ffmpeg overlays on the slice,
   never a fresh Remotion render or a new voiceover.
2. **Short-native captions** — captions on the Short are in the *subchannel's* style,
   not the long-form's. Achieved without re-rendering the Short via a **captionless
   master track** (see §4).
3. **Same channel by default** — Shorts publish to the *parent's* YouTube channel
   (Shorts are native to a channel on YouTube); a separate Shorts channel is opt-in.
4. **Operator sets, before cutting:** how many Shorts (N) and/or the average length
   (L seconds). A short is capped at YouTube's 180s Shorts limit.

## 1. The subchannel model (covers both destinations with one concept)

A **subchannel** is a lightweight child of a parent channel that publishes short-form
with its **own styling** and a configurable **publish target**:

- **`publishTarget: "parent-youtube"` (DEFAULT)** — the Short uploads to the *parent
  channel's* YouTube account. One YouTube channel carries both long + short. The
  subchannel is a styling/config namespace under the parent.
- **`publishTarget: "own-youtube"`** — a separate Shorts YouTube channel (the existing
  `channels.derivedFromChannelId` model).

**Implementation:** a subchannel **is a `channels` row** (`contentFormat: "short"`,
`derivedFromChannelId = parent`) so it reuses every existing per-channel system —
DNA-lite, `productionProfile`, `captionStyle`, `titleTemplates`, cadence, thumbnail
style, gates, scheduling, analytics. The one new field is a publish-auth pointer,
**`youtubeAuthChannelId`**: when it points at the parent, uploads use the parent's
credentials (Mode 1); when it points at itself, its own (Mode 2). Sharing the parent's
auth for Mode 1 is the only genuinely new plumbing; everything else is reuse.

The subchannel's config **is** "the sub-flow with its own style."

## 2. The cut — pure slice, operator-controlled

Inputs (give either knob; the other is derived):
- **`count`** — how many Shorts.
- **`avgLengthSec`** — target average length per Short (clamped to 10–180s).

Selection modes (all pure ffmpeg slices of the master; no re-render/TTS):
1. **`even`** — tile the master into N sequential windows (`Part 1…N`). Boundaries
   **snapped to sentence/word edges** using the voiceover `WordTimestamp[]` so a cut
   never lands mid-word.
2. **`ai-best`** — an agent (MCP or in-platform) reads the transcript + retention
   curve (`analyticsSnapshots.retentionCurve`) and returns the best N windows of ~L
   each with proposed titles; operator approves; then slice exactly those.
3. **`manual`** — operator passes `windows: [{ startSec, endSec, title }]`.

Each selected window → a **clip spec** `{ index, startSec, endSec, label, title }`.
The core planner (`packages/core/src/shorts-derivation.ts`, Phase 1) computes and
snaps windows deterministically (pure + unit-tested).

## 3. Slice + style (ffmpeg, no re-render)

Per clip spec, one ffmpeg pass over the master's `render` asset + captionless track:
- **Cut** `[startSec, endSec]` from the master render (video) and its audio.
- **Reframe** 16:9 → 9:16 (subchannel choice: blur-pad, default, or smart-crop).
- **Overlay** the subchannel styling: Part-N / title card, watermark/branding,
  optional intro/outro sting.
- **Burn short-native captions** from the sliced word timestamps in the subchannel's
  `captionStyle` (see §4) — via an ffmpeg `ass`/`subtitles` filter, still no re-render.

Reuses `assets kind="render"` + `providers.store.getBuffer(storageKey)` to source the
master file (exactly as `derive-shorts.ts` does today).

## 4. Short-native captions without re-rendering the Short

The master render currently has its long-form captions **burned in**, so a naive slice
inherits them. To give Shorts their own captions without re-rendering the Short:

- The **master render also emits a caption-less track** — `assets kind="render"` gains
  a sibling `kind="render_clean"` (or an `idx`/meta variant) produced in the same
  Remotion render pass with captions off. Small master-side addition; the Short slice
  is taken from the clean track and gets **fresh ffmpeg-burned captions** in the
  subchannel's `captionStyle`, sourced from the master's voiceover `WordTimestamp[]`
  offset to the window.
- Trade-off accepted by the operator: a small extra master-render output in exchange
  for true short-native caption styling with zero Short re-render.

## 5. Provenance, gating, publish (mostly reuse)

- Each Short = a real `production` on the **subchannel**, `masterProductionId = master`,
  its own `productionProfile` (subchannel default, optionally overridden per-derivation),
  a proper `idea` (title from the selection step, not just "Part N"), and the source
  window stored on the production.
- Because they're real productions, they pass the **subchannel's autonomy-tier gates**
  (visuals/final) — operator reviews the styled Shorts before they go out. Made-for-Kids
  + AI disclosure inherited from the subchannel.
- Publish via the existing `publish-clip` path, staggered per the subchannel's cadence;
  description funnels back to the long-form master (existing one-way link).
- Optional new `publications.sourcePublicationId` to attribute a Short's analytics back
  to the master (funnel metrics).

## 6. Operator + MCP surface

- `derive_shorts(masterProductionId, { subchannelId?, count?, avgLengthSec?, selection:
  "even"|"ai-best"|"manual", windows? })`. For `ai-best`, returns candidate windows for
  approval **before** any slicing; then cuts + styles + schedules them (Part 1…N) to the
  subchannel's target. Mirrored in the cockpit with the same knobs.
- Guide (both mirrors) documents the tool + the subchannel concept.

## 7. Phasing

1. **Cut planner (pure, this commit)** — `planEvenWindows` + word-boundary snapping +
   types, unit-tested. The deterministic heart of the cut.
2. **Subchannel model (landed 2026-08-01)** — `channels.youtubeAuthChannelId` column
   (migration `0069_subchannel_youtube_auth.sql`) + `packages/core/src/subchannel.ts`
   (`pickAuthChannelId` / `resolveYoutubeAuthChannelId` / `subchannelChannelFields` /
   `subchannelPublishTarget`), unit-tested. `loadChannelToken` now follows the pointer,
   so Mode 1 ("parent-youtube") publish + analytics resolve the parent's OAuth token;
   a null pointer (normal channel / Mode 2 "own-youtube") is unchanged. Default-off:
   nothing sets `youtubeAuthChannelId` until the operator creates a subchannel, so no
   live channel's behavior changes on deploy. Not yet wired into `create_channel`/cockpit
   (Phase 4 surfaces it alongside `derive_shorts`).
3. **Captionless master track** — master render emits the clean sibling track.
4. **`derive_shorts` (on-demand)** — even-split + count/avgLength, ffmpeg slice + reframe
   + Part-N + short-native captions from the clean track. Replaces the hardcoded
   60s/max-10 in `clip.ts`.
5. **AI best-moments** selection (transcript + retention) with propose→approve.
6. **Subchannel styling overlays** (title cards / branding) + `sourcePublicationId`
   funnel analytics.

Each phase ships default-off / opt-in and is verified with the operator present
(live publish path). No live YouTube API or prod render from the sandbox, so slice
math + planners are unit-tested; the render/publish effects are the operator's live check.

## 8. Non-goals / decisions recorded

- **No Remotion re-render of Shorts**, ever, in this design (operator constraint).
- **No re-TTS**; audio is sliced from the master voiceover.
- `cut_episode` is unrelated (removes a planned series episode) — avoid the name
  collision; this feature is `derive_shorts`.
- `video_clip` (per-shot i2v animation) is unrelated to a derived Short.
