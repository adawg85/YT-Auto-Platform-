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
- New channel: *`propose_channel`* (draft a charter to review) → `create_channel` (provisions charter + DNA + persona + sources; returns the **manual** YouTube-account checklist — account/handle/avatar creation stays human).
- Existing channel: `set_channel_config` to set autonomy, DNA, Production Profile, charter (see §4 for the full surface). Do this **before** authoring so the video inherits the right options.
- *`run_market_scan`* → refresh intel, then re-read `get_intel`.

**Stage 2 — Plan the content.**
- Arc: `create_series` (title + description + episode list) — no planner LLM.
- Single ideas: `write_idea` (lands in the backlog + auto-scores; or `greenlight:true` to push straight into production).
- Inspect: `list_ideas`, `list_series`.

**Stage 3 — Author + produce the video (the core).**
- `author_script` — hook + beats. Each beat: `type`, spoken `text`, and optionally `imagePrompt`, `referenceEntity`, `visualBrief`, `heroShot`, `motionPrompt`. Optionally pass a per-video `productionProfile`. Give it an existing `ideaId`, or `ideaTitle`+`ideaAngle` to mint one. This **kicks the pipeline**.
- After it returns a `productionId`, the pipeline runs: voiceover → images (using your prompts / real sources) → clips → render.

**Stage 4 — Watch the halts (read-only; approval is human).**
- On a gated channel (autonomy T0/T1) the run stops at the **visuals** gate, then the **final** gate. Poll `list_gates` (filter by channel) to see what's waiting. `list_gates` shows **only gates whose production is still active** — a retired/failed/halted/superseded/rejected production never leaves a phantom gate in the queue.
- `get_gate` — for a `visuals_review` gate it returns each shot's narration + image + whether it was animated, plus a `reviewPath` to open in the cockpit. Use it to **inspect and flag** problems (`report_issue`) ahead of the human review.
- **Approval is a human action in the cockpit and is NOT exposed over MCP** — there is no `decide_gate`. The approval log is the editorial-judgment record that protects the channels under YouTube's inauthentic-content enforcement, so an AI operator must not clear its own gates. Don't flip `autoApprove*` either — leave gate clearing to the operator.

**Stage 5 — Monitor.**
- `list_productions` (per channel, optional status filter) and `get_production` (status, idea, script summary, `failureReason`).

---

## 3. Full tool reference (all access rights)

**Read / intel**
| Tool | Args | Use |
|---|---|---|
| `list_channels` | — | All channels: id, name, @handle, niche, format, tier. |
| `get_channel_state` | `channelId` | Charter + state-of-the-world summary + performance. |
| `get_channel_config` | `channelId` | DNA + resolved Production Profile + charter + autonomy. |
| `get_intel` | `niche?`, `limit?` | Rising opportunities + top pattern-store patterns. |
| `get_playbook` | `channelId` | Adopted/trial directives with why + confidence. |
| `get_eval_results` | `limit?` | Recent model-quality runs (per-model avg score). |
| `list_ideas` | `channelId`, `status?` | Backlog ideas. |
| `list_series` | `channelId` | Story arcs + episode statuses. |
| `list_productions` | `channelId`, `status?` | In-flight + finished productions. |
| `get_production` | `productionId` | Status + idea + script-draft summary. |
| `list_gates` | `channelId?` | Pending gates (the pipeline's halts) — **read-only**. |
| `get_gate` | `gateId` | Inspect a gate; visuals gate returns shots + images — **read-only**. |
| `get_video_analytics` | `productionId` | Per-video: views, retention curve, watch time, traffic sources, engagement; `dataState` = none/pending/partial/full. Impressions/CTR are Studio-only → null. |
| `get_channel_analytics` | `channelId`, `sinceDays?` | Windowed views/subs/watch-hours + subscriber count + median/mean views per video. |

**Act / author** (all audited)
| Tool | Args | Use |
|---|---|---|
| `run_market_scan` | `niche?` | Refresh intel now. |
| `propose_channel` | `niche`, `intent`, `format?`, `researchDepth?`, `monetisationSafe?` | Draft a charter (no commit). |
| `create_channel` | `niche`, `intent`, `name`, `handle`, `format?`, `autonomyTier?`, `derivedFromChannelId?`, `styleExampleUrls?` | Provision a channel end-to-end. |
| `set_channel_config` | `channelId`, `autonomyTier?`, `dna?`, `productionProfile?`, `charter?` | Set any channel option directly (§4). |
| `create_series` | `channelId`, `title`, `description`, `episodes[]`, `status?` | Author an arc + episodes. |
| `write_idea` | `channelId`, `title`, `angle`, `greenlight?` | Add an idea (or greenlight it). |
| `author_script` | `channelId`, `hookText`, `beats[]`, `ideaId?`/`ideaTitle?`+`ideaAngle?`, `substanceFingerprint?`, `productionProfile?` | Author a full video + run it (§5). |

*(There is intentionally no `decide_gate` — gate approval is a human cockpit action; see Stage 4.)*

**Tickets** — `report_issue` (title, detail?, severity?, channelId?, productionId?) files a ticket on the cockpit Tickets page **and mirrors it to a GitHub issue** when `GITHUB_ISSUE_TOKEN` is set on `/account` (severity → label; channel/production carried into the body). Its return `note` names the exact env to set if mirroring is off, and `githubUrl` is the created issue. Closing that GitHub issue closes the ticket (two-way). `list_issues` / `resolve_issue` read + acknowledge/close. A ticket can also carry a **`resolution`** — the developer's answer synced from a linked GitHub issue (a body carrying `ytauto-ticket:<id>` links; the resolution is written by the fixer via the issue body/comments, never overwritten by the filing text). `list_issues` returns it; read it before closing.

**`get_deferred_work`** — the durable record of shipped-but-not-yet-verifiable and deliberately-deferred work. Call it before concluding a fix "didn't work": some fixes are DEPLOYED but their effect is gated on the next `analytics-ingest` cycle or YouTube's 24-72h lag (new analytics fields populate, stale alerts auto-clear, only on the next ingest). Verify the post-ingest signal (`get_video_analytics` `dataState`/`coverage`), not the pre-deploy snapshot. A closed ticket + a `shipped_pending_verification` entry = done-pending-data, not failed.

---

## 4. The channel-config surface (everything `set_channel_config` can set)

Pass only the fields you want to change; the rest are untouched. A partial
`productionProfile` is **merged** over the stored one.

**Top-level:** `autonomyTier` (0 manual · 1 assisted/human gates · 2 auto-publish · 3 exception-only).

**`dna`:** `tone`, `audiencePersona`, `hookStyles[]`, `forbiddenTopics[]`,
`ctaTemplate`, `voiceId` (an ElevenLabs voice id), `targetLengthSec` (e.g. `45`
Shorts, `600` for 10-min, `1800` for 30-min), `cadencePerWeek`.

**`charter`:** `mission`, `objectives[]` (only on charter'd channels; no-op on legacy manual channels).

**`productionProfile` axes** (the "how this video is made" control plane):

| Axis | Values | Meaning |
|---|---|---|
| `visualMode` | `simple`·`real_footage`·`ai_images`·`ai_video`·`mixed` | source real footage, generate, or mix. Real-image sourcing only fires on `real_footage`/`mixed`. |
| `motion` | `static`·`partial`·`ai_video` | stills, key-beats animated, or all-video. |
| `rhythm` | `sentence`·`section`·`pause` | how finely beats are cut into shots (more shots = more images). |
| `imageDensity` | `relaxed`·`standard`·`busy` | image frequency (use `relaxed` for very long videos to bound cost). |
| `captions` | boolean | burned-in word captions. |
| `music` | `off`·`subtle`·`standard` | background bed level. |
| `musicMood` | free text | e.g. "tense cinematic". |
| `delivery` | `measured`·`warm`·`energetic`·`dramatic` | voice expression. |
| `archivalStrength` | `off`·`light`·`balanced`·`strong`·`max` | how hard to try real images before generating. |
| `imageEngine` / `heroImageEngine` / `characterImageEngine` / `thumbnailImageEngine` | `qwen`·`seedream`·`nano-banana` | per-role image models. |
| `videoEngine` / `characterVideoEngine` / `heroVideoEngine` | `wan`·`minimax`·`seedance`·`seedance-pro`·`kling` | per-role clip engines. |
| `maxAiClips` | 0–20 | cap on generated clips per video (cost knob). |
| `visualDirector` | boolean | let the director agent cut shots (an LLM — leave off if you want full authoring control). |
| `artDirection` / `notes` | free text | steer the image models / pipeline. |
| **`autoApproveVisuals`** | boolean | **skip the visuals halt** (default off). |
| **`autoApproveFinal`** | boolean | **skip the final publish halt** (default off). |

Engines only work if the matching provider key is set on `/account`; otherwise
the pipeline falls back (and warns). Stock sourcing needs the library keys (§6).

---

## 5. Authoring a script the right way (`author_script`)

Give the pipeline a complete, self-consistent script:

- **`hookText`** — the spoken first 1–2 seconds.
- **`beats[]`** in order. Per beat:
  - `type` — `hook` (usually beat 0) · `stat` · `insight` · `cta` (usually last).
  - `text` — the spoken narration for this beat. This drives everything (voiceover, captions, shot timing).
  - `imagePrompt` — **provide a full prompt to own it.** ≥20 chars → used verbatim, the prompt-builder LLM is skipped. Subject-first, concrete, era-correct, no on-screen text. Leave thin/empty → the platform writes one from the beat.
  - `referenceEntity` — a **named real subject** ("Supermarine Spitfire", a person, place, event) → the platform sources a real photo/clip of it. Use for anything real.
  - `visualBrief` — the concrete visual ask (never echo the narration; figurative language gets drawn literally).
  - `heroShot` — `true` on the 2–4 pivotal beats only (premium image model).
  - `motionPrompt` — an i2v motion prompt (subject action + camera move, no text) — used verbatim if this beat animates.
- **`productionProfile`** (optional) — per-video overrides; else the channel profile is used (either way the profile LLM is skipped).
- Provide **`ideaId`** (existing) or **`ideaTitle`+`ideaAngle`** (mints an idea).

**Length:** the number/length of beats should sum to the target duration
(~2.5 spoken words/second). For long videos, author many beats; set the
channel's `targetLengthSec` first for consistency.

**Where it lands:** on T0/T1 it stops at the visuals gate → clear it (§2 Stage 4).
On T2/T3, or with `autoApproveVisuals`/`autoApproveFinal`, it flows straight
through. The **anti-clone check + review board always run** — if either blocks,
`get_production` shows `on_hold` + a `failureReason`.

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

**Stock rate governor (why a source may be skipped):** the free stock APIs have
strict app-wide limits (Unsplash demo = 50/hr for the *whole platform*), so
every stock call draws from a global per-provider token bucket shared across all
channels, plus a 24h search cache. When a bucket is empty that source is skipped
and the beat falls through to the next library or to generation — never blocked.
This is invisible to authoring; it just means under heavy load some beats lean on
archival/generation instead of stock. Nothing you set can breach the limit.

---

## 6b. Music — the per-channel bed

Music is set up in the cockpit, not over MCP, but know how it resolves so your
channel guidance is right:

- Each channel keeps a **reusable bed of ~6-8 tracks**; the render **alternates**
  through them least-recently-used, so a channel sounds consistent without
  repeating one bed on every video.
- Tracks are **free CC audio** sourced from **Openverse** (auto-credited), or an
  AI-generated bed (ElevenLabs) / a promoted library track.
- The Music panel on a production lets the operator build the bed, pull a **new
  Openverse track** when the bed lacks what a video needs, or **search all
  channels'** saved tracks.
- The **`music`** axis (`off`/`subtle`/`standard`) still gates whether any bed
  plays and at what level; `musicMood` is the default brief.

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
- **Everything is audited** — every write lands as a `channel_decisions` row.
- **Real vs generated:** name real subjects (`referenceEntity`) for archival/stock;
  leave abstract beats for generation. Don't put on-screen text in image prompts —
  captions own text.
