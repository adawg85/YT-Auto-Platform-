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
2. PLAN: create_series (arc + episodes) and/or write_idea. Before writing a BATCH
   of ideas/titles to the backlog, run review_slate — the cheapest gate, one stage
   before review_beat_map. It BLOCKS titles/angles that violate the channel's own
   forbiddenTopics (semantic — catches a rule phrased differently), overclaims a
   contested matter, or duplicate the backlog; it ADVISES on intra-slate repetition,
   keyword position (needs searchTerms on DNA), and title-family drift (declare
  titleTemplates on DNA). When titleTemplates are declared, cross-slate shape
  clustering is suppressed (conforming to a family is expected) — the reviewer
  instead flags titles that are near-interchangeable WITHIN one family.
3. AUTHOR + PRODUCE: author_script (hook + beats). Kicks the pipeline.
4. GATES (read-only over MCP): on autonomy T0/T1 it stops at the visuals gate then
   the final gate. Use list_gates + get_gate to SEE what's waiting and inspect the
   shots, and report problems (report_issue) ahead of review. list_gates only shows
   gates whose production is STILL ACTIVE — a retired/failed/halted/superseded/
   rejected production never leaves a phantom gate in the queue. At the visuals gate,
   get_production_shots lists every shot (idx, narration, sourced/generated, entity,
   engine, animated) and regenerate_shot(productionId, idx, {imagePrompt?/
   referenceEntity?/imageEngine?}) fixes ONE bad/duplicate shot without re-running the
   production — re-source a real photo, or regenerate the still on a chosen engine. The
   cost appends; the gate STAYS OPEN for you (regenerating never auto-approves).
   get_production_shots AND get_gate also return outstandingDuplicateShots +
   duplicateRiskGroups (shots sharing a referenceEntity — duplicate-image risk):
   fix or accept them BEFORE approving, because regenerate_shot only runs at
   visuals_review — once the production advances to thumbnail_review the per-shot fix
   window CLOSES, and reopening the visuals gate is a cockpit operator action (a
   corrected copy re-bills the whole video). So finish a shot-fix pass before the gate
   is approved. regenerate_shot's out-of-state error names the current status + the
   recovery path.
   APPROVAL IS A HUMAN ACTION in the cockpit — it is deliberately NOT exposed over MCP
   (the approval log is the editorial-judgment record that protects the channels). Do
   not try to clear gates or flip autoApprove* — leave that to the operator.
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
- beats[] in order, each: type (hook/stat/insight/cta/rehook — rehook is a mid-video
  beat that re-grabs attention, breaking a long exposition run; the same type
  review_beat_map's flat-run check looks for), text (spoken narration),
  imagePrompt (FULL prompt >=20 chars = used verbatim, subject-first, no on-screen
  text; thin = platform elaborates), referenceEntity (a NAMED real subject → a
  real photo/clip is sourced), visualBrief (concrete visual ask, never echo the
  narration), heroShot (true on 2-4 pivotal beats), motionPrompt (i2v prompt, used
  verbatim if the beat animates).
- productionProfile: optional per-video overrides (else the channel profile is used).
- PACKAGING (the main discovery lever): title, description, tags, thumbnailPrompt —
  set them on author_script or later via set_publication_metadata. Authored values
  override the auto ones; image credits + the AI-disclosure line are still appended
  to a description. A per-channel thumbnailTemplate (Production Profile) keeps a
  series' frame consistent.
- THUMBNAIL, two distinct things: set_publication_metadata only STORES thumbnailPrompt
  (a string) — it does NOT render an image. The thumbnail IMAGE is generated BEFORE
  the thumbnail_review (final) gate opens, so a prompt authored on author_script (or
  set before generation) feeds that generation, but setting thumbnailPrompt once the
  production is AT the thumbnail_review gate is a no-op for the image (the response
  says "stored; not rendered"). To render a new thumbnail from a prompt at the final
  gate, use regenerate_thumbnail(productionId, {thumbnailPrompt?, imageEngine?,
  quality?}) — the MCP twin of regenerate_shot: verbatim prompt, cost appends, the
  gate stays OPEN (never auto-approves/publishes). Runs only at status thumbnail_review.
- Provide ideaId (from list_ideas — NOT an episode id from list_series; series
  episodes flow into the idea backlog and get their own idea id), or
  ideaTitle+ideaAngle to mint one.
- The duplicate guard blocks re-publishing an idea that already has a LIVE PUBLISHED
  video — make a corrected copy for that. A REJECTED / halted / failed production does
  NOT block re-authoring against the same idea; re-running after a gate rejection is
  the normal path (ticket 01KY27G4…).
- Length: ~2.5 spoken words/second; set the channel's targetLengthSec first.
- Anti-clone check + review board ALWAYS run; a block shows as on_hold + failureReason.

## Shots & motion — how many images, and which ones move (ticket 01KY25DN…)
The pipeline cuts each beat into SHOTS, one image per shot — so the shot count is
usually FAR higher than the beat count, and you must supply enough distinct visual
briefs to fill it or the same referenceEntity re-queries one photo pool (duplicate
images). You DON'T have to hand-compute it: author_script and get_production return
a shotPlan (exact projectedShots + projectedMovingShots + unusedMotionPromptBeats);
review_beat_map returns a shotEstimate BEFORE you write narration.
- ITERATING a beat map: pass ideaId to review_beat_map. Its structural_repetition
  block (compliance: templated low-variation structure across a channel is what
  YouTube's inauthentic-content enforcement targets) compares only against OTHER
  episodes — revisions sharing an ideaId are excluded, so re-submitting a revised
  map is never blocked as a near-duplicate of the draft it supersedes (the corpus
  keeps just the latest map per other episode). Cross-episode similarity stays as
  strict as before. Omit ideaId only for a one-off standalone check.
- SHOT COUNT drivers: rhythm sets where cuts land (sentence ≈ 1 shot/sentence;
  section = 1 shot/beat; pause = cut on audio gaps). imageDensity sets the
  min-seconds-per-shot floor + per-beat cap (relaxed = fewer/longer, busy = more).
  BUT when the video animates (motion != static) EVERY shot is also force-cut at the
  i2v clip cap (~9s), and that dominates: an animating ~15-min video is ~80-100 shots
  almost regardless of beat count. Fix for "too few distinct images" is MORE, finer
  beats with shot-specific entities (e.g. "SR-71 cockpit", "SR-71 at takeoff") — not
  fewer shots. 19 paragraph beats → ~83 slots → 64 re-queries of one entity.
- WHICH SHOTS MOVE: the motion axis decides. static → none. partial → ONLY heroShot
  beats' first shot (typically 2-4), capped at maxAiClips — motionPrompt does NOT
  select under partial, so an authored motionPrompt on a non-hero beat is IGNORED
  (surfaced as unusedMotionPromptBeats). ai_video → the budget (maxAiClips) is spread
  EVENLY ACROSS THE RUNTIME so movement is sustained, not front-loaded: hero shots +
  the opening always move, then the beats YOU marked (animates:true, or a motionPrompt;
  sampled evenly if they exceed the budget), then an even spread across the rest. So
  under ai_video, marking the beats you most want to move (animates:true, or supply a
  motionPrompt) steers the budget to them. "I supplied 9 motionPrompts and 1 moved" = you were on 'partial'
  (hero-only) — switch to ai_video, or mark more beats heroShot. Clips that fail or
  return nothing fall back to the still and are recorded in get_production.clipFailures.
- visualDirector ON OVERRIDES the rhythm axis: the director cuts shots on meaning and
  picks each shot's medium, so both the shot count AND which shots move change (it can
  animate a shot it marks "motion", not just heroShots). The shotPlan/shotEstimate
  projections describe the MECHANICAL path (visualDirector off); with it on the real
  cut differs. See the config surface for when to leave it on.
- The visuals gate returns one entry per SHOT (not per beat), so on a 19-beat script
  it shows ~83 shots. Only the shots that open a beat carry that beat's narration; the
  extra shots WITHIN a beat have narration: null (they share the beat's spoken line) —
  each shot's beatIndex maps it back to its parent beat. This is expected, not a fault.

## Channel-config surface (set_channel_config — partial, only sent fields change)
- autonomyTier 0-3. dna: tone, audiencePersona, hookStyles[], forbiddenTopics[],
  ctaTemplate, voiceId, targetLengthSec, cadencePerWeek, titleTemplates[] (named
  title families {name, pattern, example?} so review_slate can flag title-format
  drift), searchTerms[] (the terms your audience actually SEARCHES, e.g. "Book of
  Enoch" — review_slate's keyword-position check uses these, not the niche string;
  unset → that check is skipped), lengthPolicy (#39: content-driven runtime band —
  floorSec HARD 480 = the 8-min mid-roll threshold, ceilingSec soft, named bands,
  principle; partial-merged, defaults resolved; targetLengthSec stays the soft anchor.
  review_beat_map ADVISES — never blocks — when the proposed runtime is padded/crammed
  vs the map's depth or below the floor. Per-production runtime driving assembly is a
  DEFERRED next step, see get_deferred_work. get_channel_state's performance.suggestedLengthSec
  is DISPLAY-ONLY (nothing consumes it), now CLAMPED to lengthPolicy [floorSec,ceilingSec]
  and SUPPRESSED (null) below an evidence bar — read suggestedLengthBasis for the inputs).
  charter: mission,
  objectives[], verificationBar (partial-merged: establishedMinSources 1-5,
  presentDebateMode, minFactsToScript 1-20, factualityMode) — patch the bar to fix
  any drift from create_channel's draft (charter'd channels only).
- Array fields (hookStyles[], forbiddenTopics[], titleTemplates[], searchTerms[]) are
  stored VERBATIM — a comma inside an entry stays part of that entry, so a multi-clause
  hook style is ONE entry, not several. The response echoes "stored" with the written
  array fields so you can confirm the value landed intact without a separate
  get_channel_config read. (The cockpit Persona/Settings forms now take these one-per-line.)
  LEGACY channels provisioned before the fix may still hold comma-shredded hookStyles
  (orphaned clause-tails like "then rewind…" / "the flight that changed everything");
  get_channel_config's consistencyWarnings now flags these on read — rewrite the whole
  list to repair. Reading each channel's config IS the backfill audit.
- productionProfile must be an OBJECT of axes ({ artDirection: "…", notes: "…" }), not a
  JSON string (a stringified one is now tolerated + parsed, but pass a real object). The
  set_channel_config "stored" echo covers productionProfile + lengthPolicy too, and is
  OMITTED entirely when nothing echoable changed (no more empty {}). NOTE: get_channel_config
  returns the RESOLVED productionProfile + lengthPolicy (defaults filled on READ) — a partial
  write only persists the axes you send; extra fields you see on read are resolved defaults,
  not silent drift (ticket 01KY98YR…).
- productionProfile axes: visualMode (simple/real_footage/ai_images/ai_video/mixed),
  motion (static/partial/ai_video), rhythm (sentence/section/pause), imageDensity
  (relaxed/standard/busy), captions (bool), music (off/subtle/standard), musicMood,
  delivery (measured/warm/energetic/dramatic), voiceModel (the ElevenLabs TTS model,
  separate from the voice id: turbo_v2_5 [default] / flash_v2_5 = cheap ~$0.05/1k
  chars; multilingual_v2 / v3 = expressive ~$0.10/1k, ~2x — v3 most expressive but
  alpha, sync falls back to an estimate if it returns no word timings), archivalStrength
  (off/light/balanced/strong/max), imageEngine (the STANDARD-still model, default
  qwen — set seedream for higher quality) + heroImageEngine +
  characterImageEngine + thumbnailImageEngine (qwen/seedream/nano-banana; set via
  set_channel_config's productionProfile for the channel default, or author_script's
  productionProfile per-video, or per-shot at the gate with regenerate_shot),
  videoEngine + characterVideoEngine + heroVideoEngine
  (wan/minimax/seedance/seedance-pro/kling), maxAiClips (0-20), visualDirector
  (bool — see below; does NOT need to be off to own your prompts), artDirection,
  notes + artDirection + thumbnailTemplate (each capped at 6000 chars — LLM-read
  standing guidance; thumbnailTemplate was raised from 800 in ticket 01KY6F1X…),
  musicMood (short, 800 chars), autoApproveVisuals, autoApproveFinal.
  A productionProfile validation error names the offending field + the actual vs
  allowed length (e.g. "productionProfile.thumbnailTemplate: 1,893 characters exceeds
  the 6,000-character limit"), so you don't bisect a multi-field patch.
- visualDirector is a SHOT PLANNER, not a prompt writer (ticket 01KY27G4…). ON, an
  LLM cuts the script into shots on MEANING and picks each shot's medium (still vs
  animated), overriding the mechanical rhythm cut. It does NOT touch your authored
  image/motion prompts — the image-prompt + motion-prompt agents are ALREADY skipped
  on an authored production, so your verbatim prompts are safe whether it's on or off.
  Turning it OFF does not protect your prompts; it just falls back to the mechanical
  planShots/planMotion cut (the ~83-shots / 1-animated behaviour below). For authored
  long-form, leaving it ON generally gives fewer, meaning-based shots and more
  shots that actually move.

## Real images
Sourced automatically when visualMode is real_footage/mixed AND the beat names a
referenceEntity (or has a visualBrief). Archival (Wikimedia/NASA/Openverse,
keyless) first, then stock (Pexels/Pixabay/Unsplash photos; Pexels/Pixabay/Coverr
video) if the keys are on /account. Vision-scored for fit; credited automatically;
generation is the fallback. Name real subjects for real footage; leave abstract
beats to generate. No on-screen text in image prompts — captions own text.
Use a SHOT-SPECIFIC referenceEntity, not one generic name repeated across beats: a
well-photographed subject has only ~30-50 genuinely distinct public-domain images,
so "SR-71 Blackbird" on 11 beats (→ ~48 shots) queries ONE pool and visibly repeats.
"SR-71 cockpit", "SR-71 at Kadena", "SR-71 inlet spike" each query a distinct pool.
review_beat_map + the author_script shotPlan flag a repeated entity before spend.
Stock is globally rate-limited (a shared per-provider token bucket across ALL
channels + a 24h cache) so free-tier limits are never breached — under load a
stock source is simply skipped (falls to archival/generation). Invisible to you.

## Characters (recurring on-screen cast)
A channel can have a named on-screen character — a teacher, a mascot, or SEVERAL
co-hosts — with a canonical look the pipeline injects into shots so it stays
consistent across every video. list_characters(channelId) shows them; each has a
name, a canonical description, a role, and a castMode. create_character(channelId,
name, brief, {castMode?, castTarget?, role?}) turns a plain brief ("a warm 40s
physics teacher with round glasses") into that canonical description AND renders a
Nano Banana reference sheet in the channel's active style (a few seconds, synchronous).
- castMode = how often the pipeline FORCES the character on-screen: auto (default —
  the scene-builder casts by name where the scene calls for it), off (never), smart
  (~castTarget% of shots, importance-ranked so hero/named/opener beats get it and
  diagram/text filler rides the cheap engine), fixed 25/50/75, or always (every
  shot; a mascot). set_character_cast(channelId, characterId, {castMode?, castTarget?,
  enabled?}) changes this WITHOUT re-rendering; enabled:false benches a character
  without deleting it.
- MULTIPLE characters on one video: add several and give each a forcing castMode — e.g.
  two co-hosts at "50" each. The pipeline gives each its own share of shots and never
  double-books one, so both hosts appear in the same video. role "main" is the lead
  presenter and is filled first when two characters want the same shot.
- refine_character(channelId, characterId, comments) revises the look ("shorter hair,
  a red scarf") — same face, updated description + reference sheet. delete_character
  removes one for good (prefer enabled:false to keep it).
- BRIEF = WHO, not HOW. Describe physical IDENTITY only — age, build, hair, skin,
  face, signature clothing, palette. Do NOT put render medium/register (photoreal,
  painterly, animation, "not a painting"), pose, camera/crop (portrait, full-body),
  background, or scale into the brief: the channel's active visual style (Style tab —
  built from the operator's prompt + uploaded examples) supplies the LOOK, and each
  scene supplies the framing. The reference sheet is a neutral identity plate rendered
  IN that style; the canonical description is stripped to identity so scenes stay free
  to pose and scale the character (human-sized, god-size, mid-action) — it never locks
  them into a photoreal portrait. To change the medium/look, change the channel style,
  not the character brief.
Per-role render engines (characterImageEngine / characterVideoEngine) still control
which model draws/animates character shots — set those on the Production Profile.

## Branding (avatar + banner)
Generated in the cockpit (channel Settings → Branding), NOT by create_channel over
MCP — a freshly MCP-created channel has no avatar/banner until you generate them
there. get_channel_branding reads whether each is set and its /api/media URL. Avatar
is 800x800 square; banner needs >=2048x1152 with the subject in the central safe area
(cropped on mobile). Applying to YouTube stays a manual operator step.

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
- MORE EVIDENCE for a KNOWN defect → append_to_issue(ticketId, detail), NOT a new
  report_issue. It posts your detail as a comment on the linked GitHub issue, keeping
  one ticket per defect (check list_issues first; the ticket needs a githubUrl).
- Ticket lifecycle: report_issue → GitHub issue → a developer fixes it, posts a
  Resolution comment, and DELIBERATELY leaves it OPEN for YOU to verify live and
  close (they don't self-close — an auto-closed board hides unverified work). So an
  open ticket with a Resolution is "fixed, awaiting your check", not "ignored".
- A ticket may carry a resolution (the developer's answer, synced from a linked
  GitHub issue). list_issues returns it — READ it before resolve_issue; if it says
  the fix is deployed + how to verify, verify then resolve_issue(...,"closed"). Many
  fixes need a connector RECONNECT (new tools/fields) and/or a deploy (migrations)
  before you can verify — the resolution says which.
- New tools ship behind the connector's cached tool list. If a tool named in
  this guide (e.g. get_deferred_work) returns "unknown tool" or never appears,
  the connector is holding a stale list — reconnect it (remove + re-add, or
  toggle it off/on) to refresh. get_guide self-audits and lists any tool it
  references that isn't actually registered, so a genuine gap is named explicitly.
- Read-only tools (list_*/get_*) advertise a readOnlyHint so the app can run them
  without a per-call approval; mutating tools still ask.
- reconcile_publications verifies each publication against the live YouTube video;
  pass fix:true to CLEAN confirmed phantoms — a record whose id resolves to no live
  video is demoted from 'published' to 'published_unverified' (id kept for history),
  so published counts/averages are correct and it stops blocking re-publishing. It
  ALSO flags publishedAt DATE DRIFT (a live record whose stored publish date differs
  from YouTube's real publishedAt by >1h — e.g. a scheduled video released early in
  Studio still carrying its future slot); fix:true corrects the date to YouTube's
  value and re-triggers analytics ingest when it moves backward (the missed early
  window was empty while publishedAt sat in the future). fix never touches 'unknown'
  (provider unreachable) or a merely-private live video, and it's a WRITE so the app
  asks for approval.
- Scheduling control lives over MCP: set_publication_schedule sets/moves (scheduledFor,
  a future ISO time) or clears (cancel:true) a production's native YouTube release
  slot while it's uploaded-but-not-yet-public — the calendar follows. For a video the
  operator published MANUALLY/externally (a legitimate, recurring case) or one that
  went live off-slot, sync_publication_from_youtube pulls the real publishedAt/privacy
  from YouTube for a single production (pass providerVideoId to attach an id the
  platform never recorded), marks it live with the REAL date, and re-triggers ingest.
  Both need the channel's YouTube credentials; with the mock they report 'unknown' and
  make no change. Prefer these over "make a corrected copy", which would create a
  duplicate record for one live video.
- Before concluding a fix "didn't work", call get_deferred_work. Some fixes are
  DEPLOYED but their EFFECT is gated on the next analytics-ingest cycle or
  YouTube's 24-72h data lag (e.g. new analytics fields populate, stale alerts
  auto-clear, only on the next ingest). Verify the post-ingest signal (check
  get_video_analytics dataState/coverage), not the pre-deploy snapshot. A closed
  ticket + a shipped_pending_verification entry means done-pending-data, not failed.
`;
