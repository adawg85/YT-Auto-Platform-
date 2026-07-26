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
      "get_portfolio_analytics + cost-per-1k-views join; scheduled tiered refresh with per-metric fetchedAt. Impressions/CTR are Studio-only (not in the Analytics API) — need the Reporting API bulk exports.",
    nextStep: "Scope with the operator; the Reporting API is a separate async integration.",
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
    key: "producibility-mfk-and-ideation",
    title: "Producibility — MFK comment-CTA check + ideation-side constraint",
    ticket: "01KY9F0KMQM9FXHVZJ4GAG85XP",
    status: "deferred",
    summary:
      "SHIPPED the review_slate producibility DIMENSION (#54): a deterministic, advisory check flags ideas a faceless generative channel can't film (live host/props/real shoot, gated on productionProfile.visualMode) and rap/song/chant formats the TTS voiceover can't perform. DEFERRED two pieces: (1) the Made-for-Kids comment-CTA check — the ticket wants ideas with 'invite kids to comment' CTAs flagged, but madeForKids is NOT stored anywhere (it's a hardcoded literal `false` at every publish call site), so it needs a stored MFK flag (channels column + migration) before a check can consult it; flagging ALL comment CTAs would wrongly hit non-kids channels. (2) constraining the IDEATION agent itself (feed it the charter mission + visualMode so it stops generating unproducible ideas at the source) — that changes live generation behaviour and can't be verified without a real LLM run, so it ships with the operator present. The review_slate gate catches them post-generation in the meantime.",
    nextStep:
      "Add a stored madeForKids flag (channels column + migration + set_channel_config field + publish call-sites read it), then a comment-CTA producibility rule gated on it. Separately, thread charter mission + productionProfile.visualMode into the ideation prompt (packages/agents/src/ideation.ts) with the operator present.",
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
