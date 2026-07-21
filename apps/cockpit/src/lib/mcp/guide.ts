/**
 * BACKLOG #36: the operating guide the MCP `get_guide` tool serves, so Claude in
 * chat can always fetch the platform's own instructions through the connector.
 * Mirrors docs/MCP-CLAUDE-GUIDE.md (kept in sync by hand).
 */
export const MCP_GUIDE = `# Operating the YT-Auto platform (MCP guide)

You author the creative + set the knobs; the platform executes. On an AUTHORED
production (author_script), every creative LLM the platform would run is replaced
by what you wrote: script drafting, per-video profile proposal, image prompts
(when a beat's imagePrompt is >=20 chars), and motion prompts (when the beat has
a motionPrompt). The platform STILL generates image pixels, sources/generates
clips, synthesizes the voiceover (TTS), renders, and uploads.

## End-to-end flow and the tool for each stage
0. ORIENT: list_channels → get_channel_config (DNA + resolved Production Profile
   + charter + autonomy) → get_channel_state / get_intel / get_playbook.
1. SET UP: new channel = propose_channel → review → create_channel PASSING the
   returned charter object verbatim (create_channel({charter, name, handle})) so
   the reviewed charter is committed unchanged; without it create_channel
   re-drafts a DIFFERENT charter (forbiddenTopics/verificationBar drift). Returns
   a MANUAL YouTube-account checklist. Existing = set_channel_config (autonomy,
   DNA, Production Profile, charter). Do this BEFORE authoring.
2. PLAN: create_series (arc + episodes) and/or write_idea.
3. AUTHOR + PRODUCE: author_script (hook + beats). Kicks the pipeline.
4. GATES (read-only over MCP): on autonomy T0/T1 it stops at the visuals gate then
   the final gate. Use list_gates + get_gate to SEE what's waiting and inspect the
   shots, and report problems (report_issue) ahead of review. list_gates only shows
   gates whose production is STILL ACTIVE — a retired/failed/halted/superseded/
   rejected production never leaves a phantom gate in the queue. APPROVAL IS A HUMAN
   ACTION in the cockpit — it is deliberately NOT exposed over MCP (the approval
   log is the editorial-judgment record that protects the channels). Do not try to
   clear gates or flip autoApprove* — leave that to the operator.
5. MONITOR: list_productions, get_production (status + failureReason);
   get_production_costs / get_channel_costs (spend by stage); get_video_analytics
   (a published video's views/retention curve/watch time/traffic sources — with a
   dataState of none/pending/partial/full so you can tell "not fetched yet" from
   "bad"); get_channel_analytics (windowed views/subs/watch hours + median/mean
   per video). NOTE: impressions + click-through-rate are NOT available from the
   YouTube Analytics API (Studio-only) — they read null by design, not a bug.
   Debug with get_diagnostics; file problems with report_issue.

## author_script — do it right
- hookText: spoken first 1-2 seconds.
- beats[] in order, each: type (hook/stat/insight/cta), text (spoken narration),
  imagePrompt (FULL prompt >=20 chars = used verbatim, subject-first, no on-screen
  text; thin = platform elaborates), referenceEntity (a NAMED real subject → a
  real photo/clip is sourced), visualBrief (concrete visual ask, never echo the
  narration), heroShot (true on 2-4 pivotal beats), motionPrompt (i2v prompt, used
  verbatim if the beat animates).
- productionProfile: optional per-video overrides (else the channel profile is used).
- PACKAGING (the main discovery lever): title, description, tags, thumbnailPrompt —
  set them on author_script or later via set_publication_metadata (before the final
  gate). Authored values override the auto ones; image credits + the AI-disclosure
  line are still appended to a description; the thumbnail prompt is used verbatim.
  A per-channel thumbnailTemplate (Production Profile) keeps a series' frame consistent.
- Provide ideaId, or ideaTitle+ideaAngle to mint one.
- You CANNOT re-publish an idea that already has a video (duplicate guard) — make a
  corrected copy instead.
- Length: ~2.5 spoken words/second; set the channel's targetLengthSec first.
- Anti-clone check + review board ALWAYS run; a block shows as on_hold + failureReason.

## Channel-config surface (set_channel_config — partial, only sent fields change)
- autonomyTier 0-3. dna: tone, audiencePersona, hookStyles[], forbiddenTopics[],
  ctaTemplate, voiceId, targetLengthSec, cadencePerWeek. charter: mission,
  objectives[] (charter'd channels only).
- productionProfile axes: visualMode (simple/real_footage/ai_images/ai_video/mixed),
  motion (static/partial/ai_video), rhythm (sentence/section/pause), imageDensity
  (relaxed/standard/busy), captions (bool), music (off/subtle/standard), musicMood,
  delivery (measured/warm/energetic/dramatic), archivalStrength
  (off/light/balanced/strong/max), imageEngine + heroImageEngine +
  characterImageEngine + thumbnailImageEngine (qwen/seedream/nano-banana),
  videoEngine + characterVideoEngine + heroVideoEngine
  (wan/minimax/seedance/seedance-pro/kling), maxAiClips (0-20), visualDirector
  (bool — an LLM; leave OFF to fully own visuals), artDirection, notes,
  autoApproveVisuals, autoApproveFinal.

## Real images
Sourced automatically when visualMode is real_footage/mixed AND the beat names a
referenceEntity (or has a visualBrief). Archival (Wikimedia/NASA/Openverse,
keyless) first, then stock (Pexels/Pixabay/Unsplash photos; Pexels/Pixabay/Coverr
video) if the keys are on /account. Vision-scored for fit; credited automatically;
generation is the fallback. Name real subjects for real footage; leave abstract
beats to generate. No on-screen text in image prompts — captions own text.
Stock is globally rate-limited (a shared per-provider token bucket across ALL
channels + a 24h cache) so free-tier limits are never breached — under load a
stock source is simply skipped (falls to archival/generation). Invisible to you.

## Music (per-channel bed)
Set up in the cockpit, not over MCP. Each channel has a reusable bed of ~6-8
tracks the render ALTERNATES through (least-recently-used) — consistent identity,
no repeat. Tracks are free CC audio from Openverse (auto-credited) or an AI bed.
The music axis (off/subtle/standard) gates whether a bed plays; musicMood is the
default brief. Operators build the bed / pull a new Openverse track in the Music
panel.

## Long-form (30-120 minutes)
- Set the channel's targetLengthSec first (e.g. 1800 = 30 min, 7200 = 120 min).
- author_script: write MANY beats — total spoken words ~= targetLengthSec * 2.5
  (30 min ~= 4,500 words; 120 min ~= 18,000). Break the narration into paragraph-
  sized beats; each beat is one visual section.
- Voiceover chunks automatically (no per-call char-limit failures).
- Cost/scale: a long video implies hundreds of shots/images. Set
  productionProfile.imageDensity = relaxed and lean on real footage
  (visualMode real_footage/mixed + referenceEntity) to bound generation cost.
- Render: very long videos need Remotion Lambda (set the REMOTION_* keys on
  /account); the local renderer is too slow at this length.

## Gotchas
- Legacy channels may have no charter (charter edits no-op; everything else works).
- Autonomy T0/T1 halt at visuals+final; T2/T3 auto-run; the autoApprove* toggles
  override the visuals/final halts independently.
- Engines/stock need keys on /account or the pipeline falls back.
- Every write is audited (channel_decisions). If you hit a problem, call
  report_issue so the operator + developer can see it. report_issue mirrors to a
  GitHub issue when GITHUB_ISSUE_TOKEN is set on /account (its return note names
  the exact env to set if it isn't); closing that GitHub issue closes the ticket.
- A ticket may carry a resolution (the developer's answer, synced from a linked
  GitHub issue). list_issues returns it — READ it before resolve_issue; if it says
  the fix is deployed + how to verify, verify then resolve_issue(...,"closed").
- Before concluding a fix "didn't work", call get_deferred_work. Some fixes are
  DEPLOYED but their EFFECT is gated on the next analytics-ingest cycle or
  YouTube's 24-72h data lag (e.g. new analytics fields populate, stale alerts
  auto-clear, only on the next ingest). Verify the post-ingest signal (check
  get_video_analytics dataState/coverage), not the pre-deploy snapshot. A closed
  ticket + a shipped_pending_verification entry means done-pending-data, not failed.
`;
