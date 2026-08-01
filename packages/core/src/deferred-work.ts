/**
 * Outstanding-work registry (2026-07-21): the durable, MCP-visible record of
 * what's shipped-but-not-yet-verifiable and what's deliberately deferred, so a
 * closed ticket is never mis-read as "not done" and a deploy-timing-gated fix is
 * never mis-read as a failure. Surfaced by the `get_deferred_work` MCP tool and
 * referenced from resolutions. Update this when an item ships or is verified.
 *
 * `status`:
 *  - shipped_pending_verification: code deployed + tested, but the EFFECT only
 *    shows after a data cycle (next analytics ingest, YouTube's 24-72h lag) or
 *    needs a live check the sandbox can't run. NOT incomplete — verify the right
 *    signal, not the pre-deploy state.
 *  - deferred: intentionally not built yet (usually because it changes live
 *    production behaviour and must be enabled with the operator present).
 */

export type DeferredStatus = "shipped_pending_verification" | "deferred";

export type DeferredItem = {
  key: string;
  title: string;
  /** source ticket ULID(s) */
  ticket: string;
  status: DeferredStatus;
  summary: string;
  /** what must happen to close it out / verify it */
  nextStep: string;
};

export const DEFERRED_WORK: DeferredItem[] = [
  {
    key: "force-forward-publish-and-upload-limit-guard",
    title: "force_forward = forward-only Publish-what's-built + YouTube upload-limit halt (Pentimento incident)",
    ticket: "operator-incident-2026-07-31",
    status: "shipped_pending_verification",
    summary:
      "SHIPPED (2026-07-31/08-01): a Pentimento ~45-min essay had a completed render but no clean way to publish it. force_forward now (1) accepts halted/scheduled/ready, (2) reuses every built artifact + skips variation under bypassChecks so a re-run makes ZERO new LLM/generation calls and no re-render (verified live: cost held at $1.02), (3) is FORWARD-ONLY — under bypassChecks it skips both human gates (visuals + final) and drives straight to upload+publish instead of dropping the production back to a gate (the force-forward click IS the approval, logged); cockpit button relabelled 'Publish what's built'. (4) New isTerminalUploadLimit() + UPLOAD_LIMIT_HALT_MESSAGE in upload-errors.ts: the upload step now HALTS on YouTube uploadLimitExceeded (the per-account daily upload-COUNT cap) instead of letting Inngest retry — every retry/force-forward was burning the cap even though nothing published. Core 406 tests + core/worker/cockpit typecheck + cockpit build pass.",
    nextStep:
      "Operator: the Carl Jung production is on_hold on the daily upload cap (uploadLimitExceeded). The cap resets at midnight US Pacific (~5pm AEST) — do NOT retry before then (each attempt counts). After the reset, open the production and click 'Publish what's built' ONCE: confirm it reuses the render (no re-render, cost unchanged), skips the gates, and uploads (providerVideoId + url populate). If it fails again with uploadLimitExceeded, it should now halt on_hold with the clear message rather than retry-burning. Deterministic parts (the error detector, the forward-only gate-skip) are unit/typecheck-covered.",
  },
  {
    key: "mcp-call-receipts-and-author-script-alternatives",
    title: "MCP call receipts (get_diagnostics.mcpCalls) + operator-authoring paths that don't need author_script (#88 append)",
    ticket: "01KYVE4AAY7N28H09XXQM1CPQQ",
    status: "shipped_pending_verification",
    summary:
      "#88 APPEND SHIPPED (2026-08-01): the operator appended that a FOURTH tool (get_production) now returns the same bare `No approval received`, which kills the ticket's own tool-annotation hypothesis — get_production has been in READ_ONLY_TOOLS all along, so the failing set does not correlate with the advertised hint (list_characters and set_channel_config are NOT hinted and succeeded). The remaining theories (host-side consent, session age, cumulative call count, payload size) were all indistinguishable from the client, and the ticket's open question — did the call ever reach the server? — had no answer. FIX 1, make it answerable: new mcp_call_log table + get_diagnostics.mcpCalls, an append-only RECEIPT for every MCP call that reaches the server (tool, ok, error, durationMs, argsBytes, at) plus lastHandshakeAt/lastToolsListAt from the initialize/tools-list handshake. No row for a failing tool = the call never arrived (host-side, unfixable here); ok:true = we answered and the reply was lost in transit; ok:false = it's genuinely ours and the error names it. Recording is best-effort and swallowed on failure, so a diagnostic can never break the call it observes; argument CONTENT is never stored, only its byte size (what a payload-limit theory needs). lastToolsListAt also separates 'not deployed' from 'stale cached tool list'. FIX 2, remove author_script as the single choke point (the ticket's §2 — with it blocked, every route to a finished episode runs the platform's own writer, forcing the visual-selection surface #65 is about): edit_script_beats now takes a SPARSE beats[] of per-index edits, so there is no beat-count matching (blocker a — the old failure was the browser string 'Segment count mismatch — reload and try again', which names no count; the legacy texts[] path now reports the actual beat count and points at beats[]), and each edit carries the VISUAL direction — imagePrompt, imagePrompts[] (#69 per-shot fan-out: how ~70 shot prompts are authored from ~16 beats), referenceEntity, visualBrief, motionPrompt, animates (blocker b). A visuals-only edit does NOT recut the voiceover. FIX 3 (the ticket's §3): new edit_shot_prompts(productionId, shots[], regenerate) — bulk shot-prompt replacement at the visuals gate, sparse by shotIndex; `regenerate` is REQUIRED and is the spend decision (false stores prompts only, free and nothing redrawn; true queues an async durable redraw job per shot, #83, one at a time per production, one jobId each — so a bulk pass can't time out mid-flight or be blind-retried into a double-bill, #66). Authoring at the SCRIPT gate is the cheaper path and the guide says so: direction lands before any image is generated. Both guide mirrors + HANDOFF + BACKLOG updated. 13 new unit tests; typecheck + prod build pass.",
    nextStep:
      "Operator: (1) MIGRATION 0068_mcp_call_log must deploy (worker preDeploy) before mcpCalls returns anything — until then it is an empty list, by design, not an error. (2) After a connector RECONNECT, reproduce a `No approval received` failure, then call get_diagnostics and read mcpCalls: no row for that tool = the call never reached us and the fault is host-side (raise with Anthropic, not as a platform ticket); a row means it did and the row says what happened. lastToolsListAt should show your reconnect. (3) The authoring workaround needs no live YouTube: greenlight an idea, wait for script_review, then edit_script_beats(productionId, beats:[{index:0, text:'…', imagePrompt:'…', referenceEntity:'B-47 Stratojet'}]) — confirm it succeeds WITHOUT matching the beat count, that get_production shows the authored prompt/entity on beat 0, and that the response says narrationChanged/visualsChanged. (4) At the visuals gate, edit_shot_prompts(..., regenerate:false) should store prompts with zero spend (verify in get_production_shots), and regenerate:true should return one jobId per shot. Deterministic parts are covered by unit tests, so this can close on the tests plus (2) and (3) if a live production isn't handy.",
  },
  {
    key: "authoring-path-approval-annotations",
    title: "review_beat_map auto-runs (compliance pre-check unblocked); author_script gates by design; get_channel_analytics hang-guard (#88)",
    ticket: "01KYVE4AAY7N28H09XXQM1CPQQ",
    status: "shipped_pending_verification",
    summary:
      "#88 SHIPPED (2026-07-31): the operator reported get_channel_analytics, review_beat_map and author_script all failing with the bare `No approval received` while every other tool on the connector worked, blocking the authored path. Grounding in code: `No approval received` is NOT a string anywhere in this repo — it's emitted by the Claude app, and no production/billing resulted, so the call was rejected at the HOST approval step before reaching the server. The server's only lever is the tools/list annotation. Diagnosis corrects the ticket's hypothesis: (a) get_channel_analytics has carried readOnlyHint since 2026-07-24 (commit b5fedf4, on main), so it was NOT missing the hint — it's the only read-only tool that makes a live external call (YouTube Analytics), so an auto-run that hangs has no fallback; (b) author_script SPENDS + creates a production, so it correctly requires an explicit approval — the fix is to grant it, not to auto-run a spending tool; (c) review_beat_map is the compliance/structural pre-check, is deterministic (reviewBeatMapDeterministic, no model call), touches no external system and only appends one audit row — gating it behind an approval the host wasn't surfacing left the compliance check unreachable. FIX: review_beat_map added to READ_ONLY_TOOLS so the app auto-runs it (annotation-only; execution unchanged, it still logs the row); get_channel_analytics's external call bounded by withTimeout(20s) → degrades to the stored-snapshot distribution on a hang instead of stalling the auto-run. New withTimeout util in @ytauto/core (5 tests). Both guide mirrors document the approval model. Typecheck + prod build + 389 core tests pass.",
    nextStep:
      "Operator, AFTER a connector reconnect (the readOnlyHint change ships in the cached tools/list): call review_beat_map — it should now run WITHOUT an approval prompt (like the other read tools). For author_script, expect and GRANT the approval prompt; `No approval received` means the host prompt wasn't actioned (it's an app-side message, not a platform reject). If author_script's prompt genuinely never renders in your host, that's a Claude-app/connector issue to raise with Anthropic — the platform correctly gates a spending tool. No migration.",
  },
  {
    key: "author-script-profile-merge",
    title: "author_script productionProfile partial-merge + resolvedProfile echo (#80)",
    ticket: "01KYTMKH0X1SB6S2MT7VQXA0HM",
    status: "shipped_pending_verification",
    summary:
      "#80 SHIPPED (2026-07-30): author_script's per-video productionProfile REPLACED the channel's stored profile wholesale — sending one axis (e.g. minSecondsPerShot) silently reset motion + all four image engines + voiceModel + everything else to platform defaults (a whole-video quality regression, invisible in the response). Root cause: the call site used `normaliseProfile(input) ?? resolve(stored)`, so ANY caller override became the ENTIRE profile. FIX: new pure mergeProductionProfile(stored, override, opts) in production-profile.ts (spread override over stored, then resolve — mirrors set_channel_config's partial write); the call site (mcp-authoring-actions.ts) now merges. The author_script response also returns resolvedProfile {motion, imageEngine, heroImageEngine, characterImageEngine, thumbnailImageEngine, voiceModel, music, captions, archivalStrength, visualDirector} so a caller can assert the engines instead of inferring them from shot-plan notes. 4 new unit tests (single-axis keeps the rest; override wins; no-override == resolve(stored); empty stored + override). Both guide mirrors updated. Typecheck (core/cockpit/worker) + 366 core tests pass.",
    nextStep:
      "Operator (after a connector reconnect for the new resolvedProfile field): author_script with productionProfile:{minSecondsPerShot:14} on a channel whose stored profile has motion:partial + imageEngine:seedream, and confirm the response's resolvedProfile still shows motion:partial + seedream (not static/qwen) — and that the rendered video uses seedream. No migration; the merge is in the authoring action.",
  },
  {
    key: "published-status-and-publication-surface",
    title: "Published production kept stale on_hold failureReason; get_production surfaces the publication; wordBasedDurationSec (#81)",
    ticket: "01KYTN0XTV3KMY04KHD1TQC78H",
    status: "shipped_pending_verification",
    summary:
      "#81 SHIPPED (2026-07-30): a production that timed out at a gate (→ on_hold + 'visuals_review gate timed out') then published still read status:'on_hold' with the stale failureReason, so an agent/operator concluded nothing published. Root cause: the worker setStatus only ever WROTE a failureReason (never cleared) and the publish finalize-publication step set status:'published' without clearing it. FIX: new pure productionStatusPatch(status, reason?) in gate-lifecycle.ts (a transition CLEARS failureReason unless a new one is passed — verified all 14 off-ramp setStatus callers pass one) used by setStatus + finalize-publication. get_production now returns the publication (id, providerVideoId, url, privacyStatus, publishedAt, scheduledFor) + a statusMismatch flag (live video on an on_hold/failed/rejected row) so the contradiction is visible in the same tool. Secondary (runtime projection): shotPlan gains wordBasedDurationSec (this script's own runtime at 2.5 w/s, independent of the channel target that estimatedDurationSec echoes) + a >25% divergence note. 6 new unit tests. DEFERRED: (1) changing WORDS_PER_SEC 2.5→~2.7 — the projection is only ~8% off from the real spoken rate, and it's a platform-wide budget/advisory change to make with the operator present. (2) a gate-reopen-after-timeout recovery tool — the operator WITHDREW the recovery framing (the video published), and it overlaps the existing reopen-visuals-gate deferred item. NOTE: existing prod rows already published+stale are NOT retro-fixed by code — they need a one-time manual clear / reconcile; the fix prevents recurrence.",
    nextStep:
      "Operator (after a connector reconnect for the new get_production.publication field): get_production on a live production and confirm publication.url + publishedAt appear; for the specific stale row 01KY6DN3EYT3SW9JNY0297GJDE, confirm publication.statusMismatch:true flags it (and clear its status manually — code only prevents NEW occurrences). Same-commit deploy signal: the resolvedProfile field on author_script (#80) landing over MCP proves this build deployed.",
  },
  {
    key: "thumbnail-source-and-unfreeze",
    title: "Sourced thumbnail base (#74) + unfreeze thumbnail post-gate + live swap (#76)",
    ticket: "01KYK11TCZ5K4K7F0TGYV4NP50,01KYKHFZVEPQBWMK1G36HEJEY0",
    status: "shipped_pending_verification",
    summary:
      "#74 SHIPPED: regenerate_thumbnail now takes referenceEntity → sources a real archival photo of that subject (providers.reference.findEntityImages, the same path regenerate_shot's re-source uses), up to 3 auto-credited candidates, so the thumbnail (the one image that most needs a real photo) is no longer generate-only. #74 APPEND SHIPPED: referenceImages (url[]) → operator-supplied image-CONDITIONED generation (pass-through to generateImage's referenceImageUrl/extraReferenceImageUrls/referenceStrength — already supported by gemini/qwen/seedream), so text-to-image that can't render a specific 1950s airframe now generates FROM the operator's real photo while thumbnailPrompt drives composition. #76 SHIPPED: the thumbnail is no longer frozen at gate approval — regenerate_thumbnail runs at thumbnail_review AND while ready/scheduled/published; new tool set_video_thumbnail(productionId, {thumbnailId?}) pushes a chosen candidate to the live/scheduled YouTube video via the existing providers.publish.setThumbnail (thumbnails.set), a one-call swap. set_publication_schedule(cancel:true) is documented to park the video private (status→published), NOT reopen the gate. Typecheck + build verified.",
    nextStep:
      "Operator (live, after connector reconnect): on a scheduled/private production, regenerate_thumbnail({referenceEntity:'<subject>'}) → confirm a sourced candidate appears; set_video_thumbnail(productionId) → confirm the thumbnail changes on YouTube (needs the thumbnails.set OAuth scope — re-consent the channel if it 403s). No live YouTube API from the sandbox, so this is code-verified only.",
  },
  {
    key: "thumbnail-compositor",
    title: "Thumbnail compositor — real type engine + shape/band layers over a base image (#75)",
    ticket: "01KYK2310E8EHY2E6S895TDT1H",
    status: "deferred",
    summary:
      "#75: thumbnails are a SINGLE diffusion image — every element (subject, type, arrows) must emerge from one prompt, and the model garbles longer text + can't kern/place it. The winning thumbnails in the niche are COMPOSITED: photographic/cut-out subject + flat graphic ground + a separately-set typographic layer. Ground truth: there is NO compositing/text-overlay layer today (thumbnail-compose.ts builds a PROMPT, not a canvas; overlay text is baked into the diffusion prompt string in thumbnail-prompts.ts:96). sharp IS available (packages/providers) but used only to JPEG-normalize at push (publish.ts toYouTubeThumbnail). The fix is a real compositor: render/source the base as now, then composite a deterministic text layer (string, font, weight, size, colour, outline/stroke, x/y, optional solid band) with a real type engine (sharp + an SVG text layer), driven by regenerate_thumbnail fields + productionProfile.thumbnailTemplate; plus optional shape (arrow/ring/rule) and background-replacement/cut-out so a sourced airframe sits on a flat brand ground. DEFERRED as operator-present: the whole value is the VISUAL output (typography/placement/legibility at 320x180), which can't be verified from the sandbox — build it where the operator can review renders. The SVG-layer builder is pure and should ship with unit tests; the composite is the visual check.",
    nextStep:
      "With the operator present: add a pure SVG text-layer builder (unit-tested) + a sharp compositor in packages/providers, wire a caption/textLayer field onto regenerate_thumbnail and a channel default onto thumbnailTemplate, render samples, and check legibility against the reference thumbnails. Start with the text layer (the bulk of the gap), then shape + background-replacement.",
  },
  {
    key: "caption-style-and-quote-card",
    title: "Caption style object + per-phrase emphasis + quote-card beat type (#72)",
    ticket: "01KYGFBQ0RJEG8ZZWA92JCG628",
    status: "shipped_pending_verification",
    summary:
      "#72 SHIPPED (2026-07-27): captions were hardcoded lower-third TikTok style. Added productionProfile.captionStyle {position:lower-third/center/upper-third, casing:as-written/upper/sentence, typeface:sans/serif/slab, weight:400-900, outline, maxLines, emphasisColor, emphasisPhrases} — resolved by a pure, unit-tested core module (caption-style.ts: resolveCaptionStyle/applyCasing/emphasizedWordIndices), applied in Captions.tsx. serif/slab load real Google fonts (PlayfairDisplay/RobotoSlab) so they render on Lambda. Per-phrase emphasis is done by PHRASE MATCHING against the caption word stream (emphasisPhrases coloured wherever they appear) rather than an inline narration marker — no TTS-strip fragility, and it's what delivers 'ARE NOT LIBERATED in red'. Quote-card device shipped as beats[].quoteCard {text, attribution?}: a QuoteCard Remotion component renders typeset text on a near-black ground in place of the image (wired through ScriptBeat/BeatInput/Shot/planShots/shortProps/author_script). All behaviour-preserving: unset captionStyle + no quoteCard = today's render, byte-identical. Typecheck (db/core/video/worker/cockpit) + unit tests + cockpit prod build pass.",
    nextStep:
      "Operator (live render check): set captionStyle {position:center, casing:upper, typeface:serif, emphasisColor:#C1121F, emphasisPhrases:[...]} on the channel and author a beat with quoteCard, render a sample, and confirm against the reference frames (centred ALL-CAPS serif, the emphasis phrase coloured, a typeset quote card at the section boundary). No migration — captionStyle lives in the channel DNA productionProfile jsonb, quoteCard in script_drafts.beats. The inline-narration emphasis MARKER (vs the phrase list shipped) remains the one deferred sub-item; open a follow-up if phrase-matching proves insufficient.",
  },
  {
    key: "caption-legibility",
    title: "Caption legibility — base colour + outline/shadow/scrim, reject unknown keys (#79)",
    ticket: "01KYSA67QN5Z1DNZKRJ9RZS0HZ",
    status: "shipped_pending_verification",
    summary:
      "#79 SHIPPED (2026-07-30): captions vanished over bright imagery. Root cause: base text was white with only a SOFT shadow and no outline by default, active/emphasis words took the low-contrast brand colour, captionStyle had no base-colour/outline/shadow controls, AND unknown keys were silently dropped (the color/outlineColor/outlineWidth/shadow the operator sent returned ok:true and were discarded). Fix (caption-style.ts + Captions.tsx renderer + production-profile/beats/db schemas): (A) new fields color (default white), outlineColor (default black), outlineWidth (0-12px, default 4 heavy; 0 or outline:false disables), shadow (default true), scrim (dark band, default false). (B) DEFAULT is now white + heavy dark outline (paintOrder stroke-under-fill) + strong shadow. (C) optional scrim band. (D) the captionStyle schema is .strict() — unknown keys REJECTED with an error naming the key + listing accepted fields (normaliseProfile). (E) emphasisColor is wired but only colours emphasisPhrases matches (documented; the operator's cyan was the brand accent on the active word). COMPOSITION_BUNDLE_MIN_DATE bumped to 2026-07-30 so the fail-loud guard requires a fresh Lambda bundle. UPDATE 2026-07-31 (operator re-tested: paint fields stored but NOT rendered — captions came out BLUE not white, no scrim, thin outline, while position/casing/typeface WERE honored): root cause found + fixed in Captions.tsx — (1) the currently-spoken ('active') word was HARDCODED to the brand accentColor, overriding the configured `color`, so every spoken word rendered blue; now the active word uses the base `color` and a new OPT-IN `activeColor` field gives a coloured karaoke highlight (default null = base color). (2) outline (WebkitTextStroke) + shadow lived only on the container, so the per-word spans (which re-declare `color`) dropped them via unreliable inheritance — now applied PER WORD, so a configured 9px outline/shadow actually renders. COMPOSITION_BUNDLE_MIN_DATE re-bumped to 2026-07-31 (requires a fresh Lambda bundle again). 384 core tests (activeColor coverage added). This CHANGES the default: the active word is no longer brand-accent — channels wanting that set activeColor.",
    nextStep:
      "Operator (live render, after the Lambda site redeploys on THIS packages/video push): re-render Pentimento 01KYRBCPPPQC… with captionStyle {color:'#FFFFFF', scrim:true, outlineWidth:9} and confirm captions now render WHITE with a real outline + scrim band (not blue). To restore a coloured karaoke highlight set activeColor. Confirm the earlier scrim/outline now actually apply. If it still renders blue, the Lambda site bundle didn't redeploy — check deploy-lambda-site CI.",
  },
  {
    key: "publish-schedule-sync",
    title: "Publication schedule sync + drift correction",
    ticket: "01KY9C9RFR3J39MSYBZRASYAP3",
    status: "shipped_pending_verification",
    summary:
      "publishedAt drift is now detected + corrected: reconcile_publications flags a live record whose stored date disagrees with YouTube's real publishedAt by >1h and, under fix:true, rewrites it and re-triggers analytics ingest on a backward move; the publish-finalize cron now stamps YouTube's real go-live time (not the future slot) when a scheduled video is released off-slot; and set_publication_schedule / sync_publication_from_youtube expose scheduling + external-publish over MCP. All typecheck/build/unit-test verified only — no live YouTube API or prod DB from the sandbox.",
    nextStep:
      "Operator: reconnect the connector (new tools), then on production 01KY3B8ANSJR7150Z3BWKMXCTA run sync_publication_from_youtube (or reconcile_publications fix:true) to pull the real publishedAt for video 5sNT9OFv6DY; confirm get_video_analytics then shows a past publishedAt + dataState≠none after the next analytics-ingest cycle (YouTube's 24-72h lag applies).",
  },
  {
    key: "analytics-phase1-verify",
    title: "Analytics Phase 1 — live verification",
    ticket: "01KY1VEZ094TRVH8G06JX4MJVR",
    status: "shipped_pending_verification",
    summary:
      "Retention curve + watch/engagement/traffic reports are wired and unit-tested, but only populate on the NEXT analytics-ingest run (+ YouTube's 24-72h lag). get_video_analytics reads the latest snapshot, which is pre-deploy until then.",
    nextStep:
      "After the next analytics-ingest, check get_video_analytics coverage. If retentionCurve is still false, re-consent the channel with the yt-analytics.readonly scope.",
  },
  {
    key: "analytics-phase2",
    title: "Analytics Phase 2 — portfolio + scheduled refresh",
    ticket: "01KY1VEZ094TRVH8G06JX4MJVR",
    status: "deferred",
    summary:
      "get_portfolio_analytics + cost-per-1k-views join; scheduled tiered refresh with per-metric fetchedAt. CORRECTION (2026-07-28): impressions + CTR are NO LONGER Studio-only — YouTube added videoThumbnailImpressions + videoThumbnailImpressionsClickRate to the Analytics API on 2026-01-15, and we now FETCH them (packages/providers/src/real/analytics.ts, fail-soft report), STORE them (analytics_snapshots.impressions/ctr, columns already existed), roll them up (channelPerformanceSummary/videoPerformance + coverage.impressionsCtr), and DISPLAY them on the channel Analytics tab + get_channel_analytics/get_video_analytics. So the Reporting API bulk-export path is NOT needed for impressions/CTR. They populate on the next analytics-ingest, subject to YouTube's 24-72h lag on new videos.",
    nextStep: "Portfolio rollup + scheduled refresh remain the Phase-2 work; impressions/CTR are done (verify live on the next ingest).",
  },
  {
    key: "alert-selfheal-effect",
    title: "Alert self-heal — retroactive clear",
    ticket: "01KY1SX298DQW956GE7N38BCJ3",
    status: "shipped_pending_verification",
    summary:
      "The min-sample gate stops NEW criticals immediately; the three existing critical alerts auto-ack on the NEXT analytics-ingest run, not on deploy. get_diagnostics shows them open until that runs.",
    nextStep: "Confirm the three underperformance alerts clear after the next analytics-ingest cycle.",
  },
  {
    key: "beatmap-pipeline-gate",
    title: "Beat-map reviewer — pipeline hard-block + cross-model LLM",
    ticket: "01KY1Y9E1H2QF2CNJNECVNXREW",
    status: "deferred",
    summary:
      "review_beat_map (deterministic checks + loop controls) ships opt-in. The pipeline pre-authoring gate that HARD-blocks a production, and the cross-model LLM advisory layer, are default-off — they change live production behaviour.",
    nextStep: "Enable with the operator present, after confirming it doesn't wrongly halt real productions; wire the model config to OpenRouter.",
  },
  {
    key: "prompt-editing",
    title: "Prompt dashboard — editing + versioning",
    ticket: "01KY1X58XSCY27SD903Z4H73JC",
    status: "deferred",
    summary:
      "get_agent_prompts + /prompts ship read-only. Full prompt-text viewing, version history, diff-against-default and editing require centralising the inline system: prompts out of ~25 agent files — a cross-agent refactor.",
    nextStep: "Do the prompt-centralisation refactor with the operator present (it touches compliance-relevant agents).",
  },
  {
    key: "image-dedup-pipeline",
    title: "Image dedup — perceptual hash + cross-production",
    ticket: "01KY1ZNPT18X6CR3EZNN6FN1ZB",
    status: "deferred",
    summary:
      "Authoring-time advisory (repeated referenceEntity) shipped. The pipeline-side perceptual-hash + cross-production dedup is ABSORBED INTO the media-library epic (GitHub #26) — same substrate (queryable asset store + usage tracking + hashes).",
    nextStep: "Build as part of the media-library epic (media-library-epic).",
  },
  {
    key: "slate-gate-enforcement",
    title: "review_slate — hard gate on write_idea/create_series + revision loop",
    ticket: "01KY2BJ9YM7GPHMKB6K9NDNHWC",
    status: "deferred",
    summary:
      "review_slate ships standalone + opt-in (advisory, like review_beat_map) — it does NOT yet auto-block write_idea/create_series, because auto-rejecting ideas from the backlog changes live behaviour and must be enabled with the operator present. The slate-revision loop (reuse runReviewLoop for the block→revise→re-review cycle) is the second deferred piece. Also flagged by the ticket: audit which other DNA/charter fields are SET but never TESTED by any gate (forbiddenTopics is now tested at slate + production; others may not be).",
    nextStep:
      "With the operator present: wire review_slate as a pre-write hard gate on write_idea/create_series (block authority on forbiddenTopics), add a runReviewLoop-bounded slate-revision loop, and audit untested config fields.",
  },
  {
    key: "branding-authoring-over-mcp",
    title: "Channel branding — authored regeneration over MCP",
    ticket: "01KY2A8HRGSPSAP5NBY7EZQQ3T",
    status: "deferred",
    summary:
      "get_channel_branding (read) + an honest create_channel checklist shipped. The authored regenerate path (set_channel_branding with a verbatim avatarPrompt/bannerPrompt, mirroring the imagePrompt rails) is deferred: it spends on image generation and needs the square-avatar (800x800) + banner safe-area (central ~1235x338) composition the ticket specifies, best enabled deliberately. Generation exists today in the cockpit (Settings -> Branding).",
    nextStep:
      "Wire an MCP set_channel_branding to the existing generate actions with verbatim-prompt rails + explicit square/safe-area composition; enable with the operator present (it's a spend path).",
  },
  {
    key: "content-driven-runtime-consumption",
    title: "Content-driven runtime — per-production target consumed by author_script + assembly",
    ticket: "01KY61RCNZSHVG93P865M3K2D4",
    status: "deferred",
    summary:
      "SHIPPED the safe slice of #39: a lengthPolicy DNA field (floorSec hard 480 = mid-roll threshold, ceilingSec soft, named bands, principle) resolved with defaults, settable via set_channel_config and returned by get_channel_config; and an ADVISORY (never-block) runtime↔depth check in review_beat_map that flags padding/cramming and the mid-roll floor. targetLengthSec stays the runtime anchor — nothing in the pipeline changed. DEFERRED: making a PER-PRODUCTION runtime target (chosen at beat-map time) actually drive author_script + assembly instead of the channel default, and turning the floor into a hard bound — that changes live production runtime, so it's built default-off with the operator present.",
    nextStep:
      "With the operator present: thread a per-production runtimeSec (set at review_beat_map / author_script) through to assembly, and decide whether floorSec becomes a hard pre-publish check. Confirm the advisory bands are calibrated against real retention first.",
  },
  {
    key: "reopen-visuals-gate",
    title: "Reopen the visuals gate — recover a stranded shot-fix pass",
    ticket: "01KY6DCDXYP37VS4D03QTAJNNT",
    status: "deferred",
    summary:
      "regenerate_shot is gated to visuals_review, so a shot-fix pass that spans sessions is stranded if the gate is approved between sittings — the production advances to thumbnail_review and the remaining bad shots can only be shipped or fixed by re-authoring the whole video. SHIPPED the visibility half now: get_production_shots + get_gate surface outstandingDuplicateShots + duplicateRiskGroups (shots sharing a referenceEntity) so the operator sees what's unfixed BEFORE approving, and regenerate_shot's out-of-state error names the current status + recovery path. DEFERRED: the actual 'Revise visuals' operator action that returns a production thumbnail_review -> visuals_review, because it re-fires the Inngest pipeline mid-flight (reopen the visuals gate, cancel the thumbnail gate/state, re-run finalize->thumbnail after re-approval) — a live-behaviour change that must be built default-off with the operator present. Approval stays a cockpit action; MCP only needs to SEE it's possible and call regenerate_shot once reopened.",
    nextStep:
      "With the operator present: add a cockpit 'Revise visuals' decision on the final gate that reopens visuals_review and safely re-drives the pipeline from image-finalize; keep gate approval human-only. The durable fix is within-production sourcing dedup (media-library-epic), which removes most of these groups before they need hand-fixing.",
  },
  {
    key: "channel-strategy-agent-reading",
    title: "Channel strategy — opt-in reading by the ideation + slate agents",
    ticket: "01KYDZKW7BH2T9P4KBCTYMNDH9",
    status: "deferred",
    summary:
      "SHIPPED the durable store (#61): a high-capacity, section-scoped, timestamped channelStrategy document on the channel (jsonb column, migration 0065), with get_channel_strategy / set_channel_strategy over MCP. It is deliberately NOT read by the authoring pipeline — the whole point is a home for strategy that never pollutes a script/image/thumbnail prompt. DEFERRED the ticket's point 4: having the IDEATION and SLATE-REVIEW agents specifically read it (so they know the taxonomy + which clusters are covered) — that changes what those agents generate/flag (live behaviour) and needs the operator present to enable + calibrate, plus real-LLM verification the sandbox can't do. Ship it as a default-off per-agent opt-in.",
    nextStep:
      "With the operator present: thread the strategy doc (or selected sections) into the ideation prompt (packages/agents/src/ideation.ts) and the slate-review context as an opt-in, default-off input; verify against a real LLM run that it improves coverage-awareness without bloating token cost.",
  },
  {
    key: "producibility-mfk-and-ideation",
    title: "Producibility — MFK publish read-through (manual paths) + ideation-side constraint",
    ticket: "01KY9F0KMQM9FXHVZJ4GAG85XP",
    status: "deferred",
    summary:
      "SHIPPED the review_slate producibility DIMENSION (#54): flags ideas a faceless generative channel can't film (visualMode-gated) and rap/song/chant TTS can't perform. SHIPPED the Made-for-Kids storage + surface (#53): a channels.madeForKids column (migration 0066), set_channel_config + get_channel_config, a consistencyWarnings check (undeclared-kids-channel + charter objectives that depend on end-cards/comments MFK disables), a review_slate comment-CTA producibility rule gated on it, and the PRIMARY publish read-through — the two UPLOAD call sites (production-pipeline + publish-clip) send the stored madeForKids. UPDATE 2026-07-31: the MANUAL publish/schedule callers now ALSO thread it — releasePublicationAction, reschedulePublicationAction, cancelScheduledReleaseAction (cockpit actions.ts) and the MCP set_publication_schedule tool all re-send channel.madeForKids so a chat/cockpit 'publish this scheduled video now' or 'reschedule it' no longer strips the COPPA designation (the videos.update replaces status wholesale). So the release/reschedule half of piece (1) is DONE. STILL DEFERRED: (2) constraining the IDEATION agent at source (feed it charter mission + visualMode + madeForKids so it stops generating unproducible/comment-CTA ideas) — changes live generation, ships with the operator.",
    nextStep:
      "Operator (live, after connector reconnect): publish a scheduled MFK video via release_publication (or reschedule via set_publication_schedule) and confirm on YouTube the video stays declared Made-for-Kids. Then (deferred) thread charter mission + visualMode + madeForKids into the ideation prompt (packages/agents/src/ideation.ts) with the operator present.",
  },
  {
    key: "flat-run-duration-report",
    title: "review_beat_map flat_run reported total runtime, not the span's elapsed time (#82)",
    ticket: "01KYTPZTKRFQWFH533BVMDWVJG",
    status: "shipped_pending_verification",
    summary:
      "#82 SHIPPED (2026-07-31): flat_run's evidence said '16.8 min with no re-hook' for a span whose beats sum to 5.0 min — it reported the whole runtime, and rendered the interval as '~4-4 min'. Root cause in beatDurationsSec (beat-map.ts): it assumed timingSec is ALWAYS cumulative-from-start, so a map supplying PER-BEAT durations made the last beat absorb targetLengthSec−lastValue, ballooning a tail span to ~the whole runtime. Fix: infer the shape — cumulative offsets are monotonic AND sum to ≫ runtime (deltas), otherwise treat values as per-beat durations verbatim; and the interval string now renders '~3.5 min' (was '~4-4'). Unit-tested (per-beat vs cumulative durations; the span elapsed ≈ 5 min not 17; the clean interval string). Deterministic — closes on the tests.",
    nextStep:
      "Operator (after a connector reconnect): re-run review_beat_map on the reported 31-beat Lost Books map and confirm flat_run now reads the span's own ~5 min and '~3.5 min' interval, not '16.8 min' / '~4-4 min'. Closes on the unit tests without a live render.",
  },
  {
    key: "beat-visual-brief-supply",
    title: "One visual brief per beat, but the shot planner cuts more shots than beats (#69)",
    ticket: "01KYE-beat-visual-brief",
    status: "shipped_pending_verification",
    summary:
      "#69: a beat carried exactly one referenceEntity, but the shot planner cuts more shots than beats, so an artwork-driven channel couldn't supply enough distinct visual briefs and review_beat_map returned contradictory advisories. SHIPPED (2026-07-27): beats[].referenceEntities (an ordered list) is now on the beat-map schema, ScriptBeat, BeatInput, author_script + review_beat_map inputs; planShots + planShotsFromDirection consume it in order across a beat's shots (shot i → referenceEntities[i], fallback referenceEntity then null), so a beat that fans into N shots supplies N distinct subjects without inflating the beat count. review_beat_map's shotEstimate now returns suppliedEntities + entityCoverage (the coverage the operator was measuring by hand). The runtime_compressed_for_beats carve-out for motion:static + imageDensity:relaxed also shipped (a high beats/min there is a shot-supply strategy, not cramming). The earlier advisory-calibration half (payoff_position marker + flat_run elapsed-time) shipped separately in c019479. UPDATE 2026-07-31 — the GENERATED-shot half of the append shipped: beats[].imagePrompts[] (the generative twin of referenceEntities) is now on ScriptBeat, BeatInput and author_script; planShots + planShotsFromDirection consume it in order (shot i → imagePrompts[i], fallback imagePrompt), so a GENERATED beat that fans into N shots renders N distinct images instead of the same prompt N times. Also shipped the minSecondsPerShot-inert-while-animating warning: minSecondsPerShotOverrideWarning() (pure, unit-tested) surfaces on set_channel_config AND in shotPlan.notes when the floor is set above the ~10s i2v clip cap while motion animates (raising it saves no shots — the operator's #2 append). Typecheck + prod build + unit tests (planShots distribution for both lists, override warning, entityCoverage, carve-out) verified; live render is the operator's check.",
    nextStep:
      "Operator (after a connector reconnect): author_script a GENERATED beat with beats[].imagePrompts[] and confirm the rendered sibling shots use distinct prompts (no duplicate diagrams at the visuals gate); and set minSecondsPerShot > 10 on a motion:ai_video channel → confirm set_channel_config returns the inert-floor warning. No migration needed — beats persist in the existing script_drafts.beats jsonb.",
  },
  {
    key: "per-shot-animate-and-ideation-format-gate",
    title: "Per-shot animate over MCP (#70) + ideation reading its own format rules (#68B)",
    ticket: "01KYE-animate-ideation-format",
    status: "deferred",
    summary:
      "#70: regenerate_shot now casts a character (characterId) over MCP, but there's still no per-shot ANIMATE over MCP — generate/replace/remove a motion clip for one shot from an authored motionPrompt + videoEngine, the cockpit's per-shot Animate. Needs a new tool (or mode) wired to the clip-generation path (apps/worker clip-generate / clip-generation), cost-appending, gate-stays-open, human-approval preserved. #68B: automatic ideation should CHECK a proposed idea against the channel's own titleTemplates + charter.mission before writing it (it currently ignores them and writes off-format ideas). This is the same 'constrain ideation at source' work as producibility-mfk-and-ideation — run the review_slate deterministic checks (or a subset) inside the ideation cron before insert. Both change live generation/spend, so operator-present.",
    nextStep:
      "With the operator present: add a per-shot animate tool over MCP (verbatim motionPrompt + videoEngine, replace/remove a clip); and gate the ideation cron (trend-scan / scanTrendsForChannel) so a generated idea is checked against titleTemplates + charter before it lands in the backlog.",
  },
  {
    key: "regenerate-shot-reliability",
    title: "regenerate_shot — write serialization, generate-mode async/idempotency, gate-reentry clip cost",
    ticket: "01KYE-regenerate-shot-cluster",
    status: "deferred",
    summary:
      "SHIPPED the observable/auditable slice of the #63/#65/#66/#67 cluster: get_production_shots + get_gate now report assetType (still | generated_clip | sourced_clip) + clipProvenance + assetCounts so the gate is auditable and `animated` no longer conflates AI clips with real footage (#65/#67 reporting); get_production_shot reads ONE shot cheaply after a timeout (#66 shots); get_gate on a thumbnail_review gate + list_thumbnails now return the thumbnail CANDIDATES {id,url,prompt,engine,predictedCtr,selected,createdAt} so a timed-out regenerate_thumbnail is recoverable (a rising thumbnailCount / fresh createdAt = it landed; don't blind-retry) — the #66 append's read-back ask for the thumbnail twin; and swapShotImage no longer stores a shot's own narration as its imagePrompt (#63 minimum ask). DEFERRED the harder roots: (1) #63 — the deeper clobber is a cross-process race: the MCP-direct swapShotImageAction (runs in the cockpit) and the worker-queued shot-op (serialized only on the worker) both read-modify-write asset.meta with no shared lock, so a no-prompt op can overwrite an authored prompt; the fix is a per-production/per-asset advisory lock (or routing all shot ops through the worker queue). (2) #66 — generate mode blocks the MCP HTTP response on the inline image-engine round-trip and times out; the real fix is an async job handle + poll (like the cockpit's queueShotOpAction) plus an idempotency/request key so a retry doesn't double-bill — this applies EQUALLY to regenerate_thumbnail (#66 append: same timeout-completes-and-bills mode; the get_gate read-back above makes it recoverable, but blind-retry still double-bills two hero images until this lands). (3) #67 — a pipeline motion re-entry (retry-from-render / Inngest retry) regenerates EVERY planned-but-missing clip, not just the deleted one, and a clip DELETE doesn't bump updatedAt so the gate-skip guard misses it — real unrequested clip spend. (4) #65 cockpit — the visuals gate PAGE renders the still poster for a clip; making the preview a true poster frame of the clip is a cockpit-render change.",
    nextStep:
      "With the operator present (live-spend + concurrency, sandbox-untestable): serialize shot-op meta writes across the MCP + worker paths (advisory lock or worker-only queue); make generate-mode regenerate_shot async with a job handle + idempotency key; scope pipeline clip re-generation to only the intended shot on gate re-entry and make a clip delete visible to the gate-skip guard; and render a true clip poster-frame at the gate.",
  },
  {
    key: "async-mcp-jobs",
    title: "Async job handles for long MCP tools (#83) — fill_thin_prompts shipped, regenerate_thumbnail remains",
    ticket: "01KYTQ6EK9GW30WY6Z7WXM5EPA",
    status: "shipped_pending_verification",
    summary:
      "#83: regenerate_thumbnail and fill_thin_prompts held the MCP connection open while a worker/LLM job ran and routinely timed out, indistinguishable from failure, causing double-spend on retry. SHIPPED (2026-07-31): fill_thin_prompts is now ASYNC — it enqueues the existing shotJobs 'fill-prompts' worker op (shot-op.ts already handled it) via queueShotOpAction and returns { jobId, status:'running' } immediately; queueShotOpAction now returns the jobId; and a new read-only get_job(jobId) MCP tool polls shotJobs (status queued|running|done|failed, op, error, timestamps). So the worst offender (fill_thin_prompts, which fans out over many prompts and always timed out) is fixed and the async pattern + poll tool now exist. DEFERRED: making regenerate_thumbnail async the same way needs its generation logic (currently in the cockpit regenerateThumbnailsAction, not @ytauto/agents) extracted into a shared worker-callable op + a new 'thumbnail' shotJobs op + worker branch — a refactor of a live paid path, best done deliberately. Its documented recovery (list_thumbnails/get_gate rising count = it landed, don't blind-retry) still holds meanwhile. An idempotency-key column is now lower priority: returning a jobId immediately removes the timeout-then-retry that caused the double-spend. Typecheck + build + unit tests green.",
    nextStep:
      "Operator (after connector reconnect): call fill_thin_prompts → confirm it returns a jobId fast (no timeout); poll get_job(jobId) → done. Then (next change) extract thumbnail generation into a worker op and make regenerate_thumbnail async the same way.",
  },
  {
    key: "ideaid-episode-resolution",
    title: "review_beat_map accepted a series-episode id that author_script rejected (#86)",
    ticket: "01KYTZJG82VEQB2W1KJTR0PD8N",
    status: "shipped_pending_verification",
    summary:
      "#86 SHIPPED (2026-07-31): review_beat_map accepted a series-EPISODE id as ideaId (it only used it as an opaque comparison key) while author_script rejected the same id with 'ideaId not found' — so a map could pass review against an id that couldn't be authored, failing only after the full payload was built. FIX (operator's preferred option 2): a shared read-only resolveIdeaRef(db, id) now backs BOTH tools — it returns the id as-is when it's a real idea, resolves a series episode to its backing idea, or reports unknown. author_script accepts an episode id: it resolves to episode.ideaId, and if the episode isn't queued to one yet it MINTS an idea (sourceType 'editorial', like the episode-research handoff) and LINKS it (episodes.ideaId + status 'queued') — so the authored production ties to the arc episode and post-publish reconciliation (which matches by ideaId in editorial-postpublish, NOT by title — this also answers the ticket's 'related observation') marks the episode published. review_beat_map normalizes the same-episode key via the resolver and returns an ideaIdWarning up front when the id matches neither an idea nor an episode. A cut episode is rejected with a clear message. Typecheck + build verified; DB-resolution logic so the operator's repro is the live check.",
    nextStep:
      "Operator (after connector reconnect): author_script with a series episode id from list_series (e.g. the Comet episode) → confirm it succeeds and, after publish, the arc episode flips to published (was staying 'queued'). review_beat_map with a bogus id → confirm ideaIdWarning. No migration.",
  },
  {
    key: "legacy-schedule-escape-hatch",
    title: "Not-yet-uploaded scheduled production was un-reschedulable (#85)",
    ticket: "01KYTSDMY36QS9PFDYHY9ZEJ8B",
    status: "shipped_pending_verification",
    summary:
      "#85 SHIPPED (2026-07-31): a production scheduled through the OLD sleep-based pipeline (no providerVideoId) was stuck — release_publication refused ('not uploaded'), set_publication_schedule refused ('set it at the final review gate'), and the gate was already closed: a closed loop. FIX: set_publication_schedule now handles a NOT-YET-UPLOADED row as a purely LOCAL calendar write (update publications.scheduledFor + productions.status, no YouTube call since there's nothing to move there) for both (re)schedule and cancel, replacing the dead-end refusal. The response carries uploaded:false + a note that the row has no recorded upload so it won't go live until it's uploaded (retry_production) or reconciled — honest instead of pointing at a surface that no longer exists. Typecheck + build verified.",
    nextStep:
      "Operator (after connector reconnect): on the stuck Pentimento production, set_publication_schedule with a new scheduledFor → confirm it moves the slot (uploaded:false note). NOTE: to actually PUBLISH a legacy no-upload row still requires uploading it — that overlaps #87 (retry-from-render currently duplicates), which is the operator-live piece.",
  },
  {
    key: "duplicate-upload-and-silent-failure",
    title: "Retry-from-render duplicate uploads + silent upload failures (#87)",
    ticket: "01KYV5BHM54V5SZH5WFNGM0VAS",
    status: "deferred",
    summary:
      "#87: retry-from-render on production 01KYRBCPPPQC… initiated SEVEN new YouTube uploads (none completed — all stuck 'processing', likely quota-exhausted at ~7×1600=11,200 units > 10,000/day), the platform recorded NO providerVideoId for any, get_diagnostics showed nothing, and a duplicate PRODUCTION (01KYTSRE…) was minted too. SHIPPED (2026-07-31) the observability half: findSuspiciousPublications (→ get_diagnostics.publicationIssues) now flags STUCK UPLOADS (a production at scheduled/published with no providerVideoId, via UPLOAD_EXPECTED_STATUSES) and duplicate published/SCHEDULED productions for one idea — it only looked at status='published' before, which is exactly why the seven-scheduled-no-id case was invisible. DEFERRED (operator-live, sandbox-unverifiable — real uploads/quota/live YouTube processing states): (1) idempotent uploads — the pipeline orphan-adoption (findRecentUpload) requires an EXACT title match within 120min AND skips still-processing uploads (durationSec==null), so a retry after a title change / long gap / before processing finishes always re-uploads; the robust fix is matching on uploadStatus (adopt 'uploaded'/'processed', skip 'failed') + normalized title, and stamping productionId into the upload for a reliable link. (2) a retry-from-render preflight that refuses/​warns on an existing upload. (3) refuse an upload that would exceed remaining daily quota (needs live quota accounting) + raise a get_diagnostics alert on upload failure. (4) stop retry-from-render minting a duplicate PRODUCTION. All share the #84 record-divergence root and touch the live paid upload path — do with the operator present.",
    nextStep:
      "With the operator present (live YouTube + quota): make findRecentUpload adopt a still-processing recent upload by uploadStatus (not durationSec) + tolerate a changed title; add a retry-from-render preflight that detects an existing upload and refuses unless forced; add a pre-upload remaining-quota check + an upload-failure alert; and stop retry minting a second production. Verify against the real Pentimento channel (clean up the 2 orphan productions first).",
  },
  {
    key: "publication-record-reconciliation",
    title: "Publication records diverge from YouTube (#84) — duplicate-guard hardened; YouTube→platform discovery deferred",
    ticket: "01KYTR4TQ1XMYDTFTB5YDSD52B",
    status: "shipped_pending_verification",
    summary:
      "#84: the platform's model of what's live diverged from YouTube three ways (a live top video with NO record, a duplicate live, per-video counts disagreeing). SHIPPED (2026-07-31) the recurrence-prevention: the duplicate-publish guard now RE-RUNS immediately before the upload (production-pipeline.ts, right before the videos.insert), not only at pipeline start. The start-of-pipeline guard is a TOCTOU race — it reads a sibling's providerVideoId which is only written AFTER that sibling uploads, so two concurrent runs for one idea both passed it and both shipped (the two-live-Krypton case). The late re-check collapses the race window from the whole pipeline to the few steps between check and record-provider-video-id. DEFERRED (operator-live, sandbox-unverifiable): (1) the YouTube→platform DISCOVERY direction — reconcile_publications only verifies rows it already holds, so a live video the platform never produced (the 'Helium' top performer) is invisible; adopting it means minting synthetic production/publication records from external state, which writes prod data and needs the operator present. The provider already lists a channel's uploads inside findRecentUpload (channels.list uploads-playlist → playlistItems.list), the natural foundation. (2) A DB-level unique backstop (publications has no uniqueness on idea/video) to fully close the race — needs a denormalised ideaId + partial unique index migration. Typecheck + build verified; the guard's helper (publishedVideoForIdea) is already unit-tested.",
    nextStep:
      "With the operator present: add a provider listChannelUploads + a reconcile_publications discovery mode that REPORTS (then, opt-in, ADOPTS) live videos with no platform row; and add the ideaId + partial-unique-index migration as the hard duplicate backstop. Verify against the real Atom & Friends channel (Helium orphan + duplicate Krypton).",
  },
  {
    key: "analytics-video-zeros",
    title: "Per-video analytics read zeros where Studio has data (#17) — coverage now honest; ingest root deferred",
    ticket: "01KY1VEZ094TRVH8G06JX4MJVR",
    status: "shipped_pending_verification",
    summary:
      "#17 (latest appends): a published video read avgViewDuration/watchTime/subsGained = 0 where Studio shows real data, and coverage claimed watchPct/watchTime/engagement:true while returning 0 (a hard 0 that flows into channelAvgViewPct/vsChannelAvgPct is worse than a null). SHIPPED (2026-07-31) the coverage HONESTY fix: analyticsCoverage() (pure, unit-tested) now treats a watch metric of 0 on a video WITH views as not-yet-ingested — watchPct/watchTime/impressionsCtr require a value > 0, an empty retention array isn't coverage, and dataState reports 'pending' instead of 'partial/full' on a zero-watch snapshot. So the misleading 0s now correctly read as pending/uncovered (the operator's core complaint). DEFERRED (needs live Analytics API to diagnose, sandbox can't): WHY the video-level report returns 0 for watch/subs metrics while Studio shows non-zero — the provider mapping (analytics.ts: subscribersGained requested + mapped correctly, no hardcoded 0) is correct, so a stored 0 means the report returned a 0 row, pointing at a date-window or video-level-aggregation issue, not a mapping bug. Touching the fetch speculatively risks breaking working metrics. subsGained may also be downstream of #84 (a publication pointing at the wrong providerVideoId).",
    nextStep:
      "With the operator present (live Analytics API): diagnose the video-level report returning 0 for AVD/watch-time/subsGained on a video Studio shows data for — check the startDate/endDate window and whether isolating subscribersGained into its own report helps; reconcile the channel's records first (#84) in case a wrong providerVideoId is the cause.",
  },
  {
    key: "shot-pixel-dimensions",
    title: "Shot dimensions — true served pixel width/height capture",
    ticket: "01KY9EBKZ5T0MVT6JJRYDJ4ZQW",
    status: "deferred",
    summary:
      "SHIPPED the aspect-observability slice of #50: generated stills already inherit the production aspect (the videoAspect 'one rule'), and now regenerate_shot RECORDS that aspect on the shot + accepts an aspectRatio override, while get_production_shots + get_gate report renderAspect, per-shot aspect, aspectMismatchShots and shotsWithUnknownAspect. This surfaces the REQUESTED/recorded render aspect, not the DECODED pixel width/height of the served image — so an engine that ignores the aspect param and returns a portrait PNG for a 16:9 request is still not caught for shots generated before this landed. DEFERRED: decode true served dimensions (sharp is already a providers dep; the buffer is in hand in each adapter before upload), return width/height from MediaProvider.generateImage, and persist them at every generation site (worker pipeline + shot-ops) so aspectMismatch is pixel-true and older shots are backfillable.",
    nextStep:
      "Add width/height to the MediaProvider.generateImage return, decode via sharp in each real adapter + the mock, and persist to shot meta at the worker pipeline image-write sites and shot-ops. Then flag aspectMismatch on decoded pixels, not recorded aspect. Verify against a real generation (the sandbox is mock-only).",
  },
  {
    key: "media-library-epic",
    title: "Media asset library — variation-controlled reuse",
    ticket: "GitHub #26",
    status: "deferred",
    summary:
      "Store every image/clip with tags + license + useCount + lastUsedAt + perceptualHash; retrieve relevant+fresh+unused assets before sourcing/generating. Framed as variation-CONTROLLED reuse (deprioritise heavy/recent use; never repeat hero shots in consecutive videos) so it's a compliance asset, not a liability. Absorbs the cross-production image dedup.",
    nextStep: "Spec at GitHub #26. Sequence after analytics + reconciliation are verified live; get operator sign-off on the schema + freshness policy first.",
  },
];

export function deferredByStatus(status: DeferredStatus): DeferredItem[] {
  return DEFERRED_WORK.filter((d) => d.status === status);
}
