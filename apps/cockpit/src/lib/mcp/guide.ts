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
   + charter + autonomy, plus #93 activeStyle — the distilled Style-tab style or null —
   and shotStyleRegister {source, register}: exactly which register an AUTHORED
   imagePrompt gets on this channel, so the visual register is checkable before spend)
   → get_channel_state / get_intel / get_playbook.
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
  review_slate also ADVISES on PRODUCIBILITY (#54/#53): ideas the channel's own
  production reality can't build — a live host / props / a real shoot
  on a faceless generative channel (gated on productionProfile.visualMode =
  ai_images/ai_video/simple), a rap/song/chant the TTS voiceover can't perform, or a
  comment CTA on a Made-for-Kids channel (madeForKids true → comments are disabled).
  Advisory, never a block — which to archive is the operator's call (set_idea_status).
  The backlog is MUTABLE (#59/#60), not write-once: update_series (rename/re-describe
  an arc, promote a proposed arc to active, or reorder its episodes via episodeOrder),
  set_episode_status (planned/queued/… /cut — drop an episode from an arc),
  set_idea_status (batch archive/reject duplicate ideas — pass many ideaIds at once),
  and update_idea (edit an idea's title/angle when it's nearly-right, #60).
  Pruning the backlog is what keeps scoring + review_slate's near-duplicate check
  meaningful — and review_slate now EXCLUDES rejected/archived ideas from its
  comparison set (#60), so a retired idea stops tripping the duplicate check. Get ids
  from list_series / list_ideas.
3. AUTHOR + PRODUCE: author_script (hook + beats). Kicks the pipeline.
4. GATES (read-only over MCP): on autonomy T0/T1 it stops at the visuals gate then
   the final gate. Use list_gates + get_gate to SEE what's waiting and inspect the
   shots, and report problems (report_issue) ahead of review. list_gates only shows
   gates whose production is STILL ACTIVE — a retired/failed/halted/superseded/
   rejected production never leaves a phantom gate in the queue. At the visuals gate,
   get_production_shots lists every shot (idx, narration, sourced/generated, entity,
   #93 renderedPrompt = the EXACT string sent to the image engine (render register
   included) + styleSource (distilled_style | channel_image_style | none — which
   register won) + authoredPrompt (what you submitted) + styleConditioned (whether
   distilled-style reference-image conditioning also rode it — nano-banana only),
   engine, animated, and #65/#67 assetType = still | generated_clip | sourced_clip —
   the true asset behind the shot, since animated conflated generated i2v clips with
   real archival footage; a sourced_clip carries clipProvenance, and top-level
   assetCounts gives the AI-vs-real split the publish disclosure flag needs). NOTE the
   imageUrl/image is the STILL poster — for a sourced_clip the rendered asset is the clip.
   assetCounts also carries clipsBilledToVideoEngine + generatedClipLedgerMismatch (#67):
   assetType reads stored clip ROWS, so a generated_clip row never billed to a video engine
   is a phantom/stale row — trust the cost ledger over the row when they disagree.
   get_production_shot (singular, idx) reads ONE shot cheaply — the "did shot N change?"
   check after a regenerate_shot that timed out at the connector (#66), without pulling
   all N. regenerate_shot(productionId, idx, {imagePrompt?/
   referenceEntity?/imageEngine?/characterId?/aspectRatio?}) fixes ONE bad/duplicate shot without
   re-running the production — re-source a real photo, regenerate the still on a chosen engine,
   or CAST a recurring character into it (characterId from list_characters, #70; composes with
   imagePrompt). The cost appends; the gate STAYS OPEN for you (regenerating never auto-approves).
   get_production_shots AND get_gate also return outstandingDuplicateShots +
   duplicateRiskGroups (STILL-SOURCED shots sharing a referenceEntity — duplicate-image
   risk; #52: a shot already regenerated from an authored imagePrompt is 'generated', its
   entity is historical, so it no longer counts — the number reflects real remaining risk):
   fix or accept them BEFORE approving, because regenerate_shot only runs at
   visuals_review — once the production advances to thumbnail_review the per-shot fix
   window CLOSES, and reopening the visuals gate is a cockpit operator action (a
   corrected copy re-bills the whole video). So finish a shot-fix pass before the gate
   is approved. regenerate_shot's out-of-state error names the current status + the
   recovery path.
   APPROVAL IS A HUMAN ACTION in the cockpit — it is deliberately NOT exposed over MCP
   (the approval log is the editorial-judgment record that protects the channels). Do
   not try to clear gates or flip autoApprove* — leave that to the operator.
5. MONITOR: list_productions, get_production (status + failureReason + publication:
   url/providerVideoId/publishedAt/privacyStatus, #81 — a published video is never
   mistaken for un-published when the status row is stale; publication.statusMismatch
   flags a live video sitting on an on_hold/failed/rejected row);
   get_production_costs / get_channel_costs (spend by stage — get_channel_costs also
   returns byIdea: cumulative spend per idea {attempts, publishedCount, cumulativeUsd},
   #49, so a re-greenlit idea burning spend across many abandoned attempts is legible in
   one call; list_productions now carries costUsd per row); get_video_analytics
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
  real photo/clip is sourced), referenceEntities (#69: an ORDERED list of subjects
  consumed across the shots ONE beat is cut into — supply N distinct briefs for a
  beat that fans into N shots WITHOUT adding beats; shot i takes referenceEntities[i],
  falling back to referenceEntity. The fix for an artwork/still-image channel where
  the shot count exceeds the beat count — check review_beat_map's entityCoverage),
  imagePrompts (#69: the GENERATED twin of referenceEntities — an ORDERED list of
  per-shot prompts consumed across the shots one beat is cut into, shot i takes
  imagePrompts[i] else imagePrompt; use it so a GENERATED beat that fans into N shots
  renders N distinct images instead of the same prompt N times — two takes of one
  diagram read as an error. imagePrompts for generated channels, referenceEntities
  for sourced ones),
  visualBrief (concrete visual ask, never echo the
  narration), heroShot (true on 2-4 pivotal beats), quoteCard (#72: {text, attribution?}
  → render THIS beat as a typeset quote card on a plain ground instead of an image —
  the section-boundary device), motionPrompt (i2v prompt, used
  verbatim if the beat animates).
- productionProfile: optional per-video overrides. #80: PARTIAL MERGE over the channel
  profile — sending one axis overrides only that axis; every other axis inherits from the
  channel (never resets the rest to platform defaults). Same as set_channel_config's partial
  write. The response echoes resolvedProfile (motion, all four image engines, voiceModel,
  music, captions, archivalStrength, visualDirector, and #93 imageStyle) — assert what the
  video generates against from THAT, don't infer engines from the shot-plan notes.
  #93: an authored imagePrompt is verbatim for the SUBJECT/composition, but the channel's
  house dna.imageStyle is still applied as a render-register suffix (so a "NOT photographic"
  channel does not render photoreal) — resolvedProfile.imageStyle is that string.
  #93 (2026-08-03 REOPEN — corrected): when a DISTILLED Style-tab style is active its
  promptSuffix becomes the register instead (it is what the builder would have woven in);
  there is NO carve-out that skips the text register. The earlier claim that an active
  distilled style "rides as reference-image conditioning and wins" was WRONG and caused a
  live regression: that conditioning fires only on nano-banana, so on a qwen/seedream
  channel an authored prompt got NO style at all. Read get_channel_config.shotStyleRegister
  {source, register} to see which register an authored prompt will get, and
  get_production_shots[].renderedPrompt / .styleSource to see what actually steered a shot. Bake a one-off
  look into the prompt only to override the house style for that shot.
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
  says "stored; not rendered"). To render or SOURCE a new thumbnail, use
  regenerate_thumbnail(productionId, {thumbnailPrompt?, referenceEntity?, imageEngine?,
  quality?}) — the MCP twin of regenerate_shot: a verbatim thumbnailPrompt GENERATES,
  and #74 referenceEntity SOURCES a real archival photo of that subject (auto-credited —
  for the one image that most needs a real photograph, e.g. a specific aircraft), up to
  3 candidates. #92: every sourced candidate is now VISION-VERIFIED to actually depict the
  named subject before it's offered — the archival tier (Wikimedia/NASA) silently fell
  through to generic stock (Pexels) on a niche subject and returned the wrong aircraft as
  "sourced"; candidates that don't depict the subject are dropped, and list_thumbnails
  returns sourceTier (archival vs stock_fallback) + fitScore (0-10) per sourced candidate.
  And #74-append referenceImages (url[]) GENERATES from an operator-supplied
  photo (text-to-image can't render a specific 1950s airframe — hand it the real one; the
  photo conditions geometry/markings, thumbnailPrompt drives composition; pair with a
  verbatim thumbnailPrompt so the channel imageStyle doesn't fight the reference). Combine
  any of them. Cost appends; the gate stays OPEN (never auto-approves/publishes).
  get_gate on a thumbnail_review gate returns the candidates (#66: thumbnails[] {id, url,
  predictedCtr, selected, prompt, engine, createdAt}) — how you review over MCP AND recover
  a timed-out regenerate_thumbnail (rising thumbnailCount / fresh createdAt = it landed;
  don't blind-retry — that double-bills). list_thumbnails(productionId) returns the same.
- THUMBNAIL is NO LONGER FROZEN at gate approval (#76): regenerate_thumbnail runs at
  thumbnail_review (candidates land on the open gate) AND after — while the video is
  ready/scheduled/published (private for hours). Post-gate the candidate is NOT applied;
  call set_video_thumbnail(productionId, {thumbnailId?}) to push a chosen candidate to
  the live/scheduled YouTube video via thumbnails.set (a one-call swap, not a re-upload).
  Omit thumbnailId to apply the highest-predictedCtr candidate. Needs the youtube
  thumbnails.set OAuth scope. NOTE: set_publication_schedule(cancel:true) parks the video
  private (status → published) and does NOT reopen the thumbnail gate — use the
  regenerate_thumbnail + set_video_thumbnail path instead of cancelling to repackage.
- Provide ideaId (a backlog idea from list_ideas) — OR (#86) a series EPISODE id from
  list_series, which author_script resolves to the episode's backing idea (minting +
  linking one if the episode isn't queued yet, so the arc episode reconciles to
  published after upload — reconciliation is by ideaId). review_beat_map accepts + resolves
  the id the same way and returns ideaIdWarning if it matches neither. Else pass
  ideaTitle+ideaAngle to mint a standalone idea.
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
a shotPlan (exact projectedShots + projectedMovingShots + unusedMotionPromptBeats).
#81: shotPlan.estimatedDurationSec echoes the channel targetLengthSec when set, while
shotPlan.wordBasedDurationSec is always THIS script's own runtime at ~2.5 w/s — compare
them to catch a script written well under/over target (a notes entry flags a >25% gap,
since review_beat_map advisories + the length floor score against the target).
review_beat_map returns a shotEstimate BEFORE you write narration — including
(#69) suppliedEntities + entityCoverage (distinct briefs you gave ÷ estimated shots):
below 1.0 the uncovered shots re-query one photo pool (duplicates), so add
beats[].referenceEntities for sourced shots or beats[].imagePrompts for GENERATED
shots (#69 — the ordered per-shot prompt list; not more beats), or raise
minSecondsPerShot. CAVEAT (#69): minSecondsPerShot is INERT while motion animates —
the i2v clip cap (~10s) force-cuts moving shots, so raising the floor above it on a
motion: partial/ai_video channel saves no shots (set_channel_config + shotPlan.notes
now warn). For fewer, longer shots use motion: static (Ken-Burns holds honour the
floor). On a motion:static + imageDensity:relaxed channel a high beats/min is a
shot-supply strategy, so runtime_compressed_for_beats is suppressed (the word budget
stays the real cramming test).
- ITERATING a beat map: pass ideaId to review_beat_map. Its structural_repetition
  block (compliance: templated low-variation structure across a channel is what
  YouTube's inauthentic-content enforcement targets) compares only against OTHER
  episodes — revisions sharing an ideaId are excluded, so re-submitting a revised
  map is never blocked as a near-duplicate of the draft it supersedes (the corpus
  keeps just the latest map per other episode). Cross-episode similarity stays as
  strict as before. Omit ideaId only for a one-off standalone check.
- ADVISORY calibration (#69) — the payoff_position and flat_run advisories key on
  INTENT and ELAPSED TIME, not beat position/count, so they don't fire on every
  fine-grained map. Mark the payoff beat with beats[].payoff:true (the one beat that
  discharges the hook's promise); payoff_position then checks THAT against the
  channel's ~60% target. Without a marker it falls back to the last heroShot, and if
  there's neither it stays silent rather than reporting a false ~99%. flat_run fires
  when a no-re-hook stretch exceeds ~3.5 min of narration (derived from timingSec,
  else wordBudget, else runtime/beat-count), so a 9-beat run is flagged on a coarse
  map but not on a fine one where it's under two minutes.
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

## Channel strategy document (#61 — durable planning memory, NOT creative instruction)
get_channel_strategy / set_channel_strategy hold a channel's long-term structure,
taxonomy, competitive analysis, dated decisions + reasons, open questions and vision.
It is high-capacity and SECTION-SCOPED: set_channel_strategy(channelId, content,
section?) writes one section (default "main"; e.g. "taxonomy" / "decisions" / "vision"
/ "open-questions"), each timestamped, so you append a decision without rewriting a
40k-char doc; empty content clears a section. Per-section cap 100k chars; the doc as a
whole is unbounded. CRITICAL: this is the RIGHT home for strategy precisely because it
is NOT read by the authoring pipeline — nothing here reaches a script/image/thumbnail
prompt, unlike productionProfile.notes/artDirection (creative instruction, 6k cap) or
charter.mission (feeds ideation). Use it as the durable memory a fresh session reads to
learn what a channel is TRYING to become. (The ideation + slate agents reading it is a
documented opt-in follow-up, not on yet — see get_deferred_work.)

## Channel-config surface (set_channel_config — partial, only sent fields change)
- autonomyTier 0-3. contentFormat (#51: long | short | both — the CHANNEL-LEVEL format,
  now settable over MCP; it is load-bearing, not a label — render orientation/aspect
  (16:9 vs 9:16), the shot planner and the scriptwriter all read it, so moving a long
  channel to "both" changes real behaviour. Per-VIDEO orientation is a separate axis,
  productionProfile.orientation).
  SUBCHANNELS (Shorts-derivation Phase 2, plumbing landed / not yet operator-wired): a
  subchannel is an ordinary channel row (contentFormat "short", derivedFromChannelId =
  parent) that will publish Shorts sliced from the parent's long-form masters with its OWN
  styling/captionStyle/cadence. The one new field is youtubeAuthChannelId — the publish-AUTH
  pointer: set to the PARENT id, the subchannel's Shorts upload to the parent's YouTube
  channel (Mode 1 "parent-youtube", the default — Shorts are native to one channel); left
  null, the subchannel uploads with its OWN token (Mode 2 "own-youtube", a separate Shorts
  channel). Publish + analytics resolve it automatically (loadChannelToken follows the
  pointer), so a normal channel (null pointer) is unaffected. The on-demand cut
  (derive_shorts) is a later phase — see docs/SHORTS-DERIVATION-SPEC.md.
  madeForKids (#53: true | false | null — YouTube's
  Made-for-Kids/COPPA self-designation, now settable + stored. Load-bearing: the publish
  path sends it as selfDeclaredMadeForKids on upload/release/schedule, and MFK DISABLES
  comments, end-cards/cards, the notification bell and save-to-playlist (ads go
  contextual-only). Set it on any channel aimed at under-13s; consistencyWarnings then
  flags charter objectives that depend on now-disabled features, and review_slate flags
  comment CTAs as unproducible). ideationPaused (#68: true → the daily trend-scan/ideation
  cron SKIPS this channel, so no auto-generated ideas land in the backlog while you set up
  its format; manual write_idea/seed_idea + series planning still work; set false to resume).
  dna: tone, audiencePersona, hookStyles[], forbiddenTopics[],
  ctaTemplate, voiceId, targetLengthSec, cadencePerWeek, titleTemplates[] (named
  title families {name, pattern, example?} so review_slate can flag title-format
  drift), searchTerms[] (the terms your audience actually SEARCHES, e.g. "Book of
  Enoch" — review_slate's keyword-position check uses these, not the niche string;
  unset → that check is skipped), imageStyle (#57: the channel HOUSE IMAGE STYLE — a
  plain-language render register, e.g. "bold graphic illustration, painted graphic-novel
  look, NOT photographic" — that steers EVERY generated image, characters AND scenes.
  This is the chat lever for a non-photoreal channel; set the LOOK here, not in a
  character brief. Precedence: an active distilled Style-tab style, built from uploaded
  examples, still WINS for the render; imageStyle applies when there is none.
  #93 (2026-08-03): on an AUTHORED prompt (which skips the prompt builder) the winning
  style is applied as a TEXT register — the distilled promptSuffix, else imageStyle. It
  is NOT left to reference-image conditioning, which only fires on nano-banana; assuming
  otherwise is what let a seedream channel render every authored shot with no style.
  get_channel_config now RETURNS dna.imageStyle (#64 — it was write-only; null when
  blank), so you can read it before changing or clearing it.
  NOTE (#64): imageStyle is GLOBAL — it steers every generated image and an authored
  prompt cannot locally override it (a per-surface thumbnailImageStyle is a known gap).
  On a CHARTER'd channel create_channel now COMMITS the reviewed dnaDefaults.imageStyle
  verbatim (#58 — it used to silently drop it, leaving a generated-visual channel with
  no register); a channel created without a charter-supplied imageStyle starts blank,
  and blank means BLANK — while unset the platform writes NO style clause into any
  prompt rather than substituting a default, so an unstyled channel renders with no
  imposed look at all. Send "" to clear it),
  lengthPolicy (#39: content-driven runtime band —
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
  #89: the prose caps on titleTemplates[].pattern (now 2000) and dna.imageStyle (now 2000)
  were raised so a full rule/brief fits, and any write that STILL exceeds a cap returns a
  warnings[] entry naming the field, the limit and the submitted length — truncation is no
  longer silent (it used to sever a compliance rule mid-word at 500).
  LEGACY channels provisioned before the fix may still hold comma-shredded hookStyles
  (orphaned clause-tails like "then rewind…" / "the flight that changed everything");
  get_channel_config's consistencyWarnings now flags these on read — rewrite the whole
  list to repair. Reading each channel's config IS the backfill audit.
  consistencyWarnings ALSO flags (#48) a targetLengthSec stored BELOW the channel's own
  hard lengthPolicy.floorSec (or outside every declared band) — a legacy soft anchor
  under a later-declared floor forfeits mid-rolls; #46 clamped the DERIVED suggestion,
  this catches the AUTHORED value. set_channel_config returns the same as a non-blocking
  warnings note when a write lands the anchor below the floor (stored as-is, not rejected).
- productionProfile must be an OBJECT of axes ({ artDirection: "…", notes: "…" }), not a
  JSON string (a stringified one is now tolerated + parsed, but pass a real object). The
  set_channel_config "stored" echo covers productionProfile + lengthPolicy too, and is
  OMITTED entirely when nothing echoable changed (no more empty {}). NOTE: get_channel_config
  returns the RESOLVED productionProfile + lengthPolicy (defaults filled on READ) — a partial
  write only persists the axes you send; extra fields you see on read are resolved defaults,
  not silent drift (ticket 01KY98YR…).
- productionProfile axes: visualMode (simple/real_footage/ai_images/ai_video/mixed),
  motion (static/partial/ai_video), rhythm (sentence/section/pause), imageDensity
  (relaxed/standard/busy), minSecondsPerShot (#73: a NUMERIC hold-duration floor,
  2-60s, overriding the density tier — the tiers top out at ~11s on relaxed, but a
  contemplative still-image channel wants ~20-25s; a higher floor = fewer/longer
  shots = ~half the shot count + generation bill, and it dissolves the #69 beat-vs-
  shot supply gap), stillMotion (#73: render-time Ken-Burns on stills, NOT i2v
  clips — none/slow_push/slow_pull/drift; unset = slow_push, the prior hardcoded
  zoom) + stillMotionAmount (0-0.15 scale delta) + transition (cut/dissolve) +
  transitionMs (0-2000 dissolve length), captions (bool on/off), captionStyle (#72/#79:
  burned-in caption STYLE — {position:lower-third/center/upper-third, casing:as-written/
  upper/sentence, typeface:sans/serif/slab, weight:400-900, maxLines, color:hex (base text,
  default white), activeColor:hex (the currently-spoken word; UNSET → uses base color, so a
  white caption stays white — the karaoke highlight is the scale-up; set it to opt into a
  coloured highlight), outlineColor:hex (default black), outlineWidth:0-12px (default 4 = heavy;
  0 = none; outline:false also disables), shadow:bool (default true), scrim:bool (dark band
  behind text, default false), emphasisColor:hex, emphasisPhrases:[phrases coloured wherever
  they appear]}. #79: the DEFAULT is white + heavy dark outline + shadow (applied PER WORD) so
  text survives over any imagery; the active word no longer forces the brand accent (that
  overrode the base color and rendered captions in the accent colour — use activeColor to opt in);
  emphasisColor ONLY colours words that match emphasisPhrases (set the phrases or
  it has no visible effect); UNKNOWN keys are REJECTED with a validation error, not silently
  dropped), music (off/subtle/standard), musicMood,
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
  notes + artDirection + thumbnailTemplate (each capped at 50,000 chars — LLM-read
  standing guidance; raised from 6,000 in ticket 01KYGEW6… / #71 so a fully-specified
  brief fits without cutting evidence), musicMood (short, 800 chars),
  autoApproveVisuals, autoApproveFinal.
  A productionProfile validation error names the offending field + the actual vs
  allowed length (e.g. "productionProfile.thumbnailTemplate: 51,893 characters exceeds
  the 50,000-character limit"), so you don't bisect a multi-field patch.
  These fields ARE prompt context, not just storage: notes injects once per authoring
  pass, thumbnailTemplate once per thumbnail build, but artDirection injects into EVERY
  per-shot image prompt — so a big artDirection multiplies token cost across a video's
  shots. set_channel_config returns a non-blocking warnings[] advisory when a guidance
  field is large (esp. artDirection); keep art direction tight and put per-shot detail
  in the beat's imagePrompt.
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
name, brief, {constraints?, castMode?, castTarget?, role?}) turns a plain brief ("a warm 40s
physics teacher with round glasses") into that canonical description AND renders a
Nano Banana reference sheet in the channel's active style (a few seconds, synchronous).
- constraints (#90) = HARD proportional/anatomical rules passed to the render VERBATIM,
  never distilled: ratios ("legs roughly half his total height"), "N heads tall",
  negations ("not dwarfish / not squat"). The brief->description distiller compresses
  measurements into vague adjectives and a diffusion model defaults to squat on a heavy
  build, so put load-bearing measurements here. The response returns droppedConstraints[]
  when a brief measurement did not survive distillation — move those into constraints.
  refine_character takes constraints too (replaces, else keeps the stored ones).
- castMode = how often the pipeline FORCES the character on-screen: auto (default —
  the scene-builder casts by name where the scene calls for it), off (never), smart
  (~castTarget% of shots, importance-ranked so hero/named/opener beats get it and
  diagram/text filler rides the cheap engine), fixed 25/50/75, or always (every
  shot; a mascot). set_character_cast(channelId, characterId, {castMode?, castTarget?,
  enabled?}) changes this WITHOUT re-rendering; enabled:false benches a character
  without deleting it.
- Casting is ALSO per-shot, not only per-channel (#70): castMode is the channel-level
  forcing knob, but you can cast one character into one shot at the visuals gate with
  regenerate_shot(..., {characterId}), or in BULK with edit_shot_prompts(shots:[{shotIndex,
  characterId, ...}], regenerate:true). Use this to place a period-specific cast
  deterministically (one figure in exactly the beats it belongs in) instead of leaving it
  to castMode:auto. Casting redraws the shot (so edit_shot_prompts needs regenerate:true);
  the id must belong to the channel; ignored in re-source mode.
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
  scene supplies the framing. The reference sheet is a neutral, SINGLE-FIGURE identity
  plate rendered IN that style — no scenery, props, collage/model-sheet layout or text
  (and only the channel's render register, not its scene composition, is applied, so
  channel-thematic scenery can't bleed in); the canonical description is stripped to
  identity so scenes stay free
  to pose and scale the character (human-sized, god-size, mid-action) — it never locks
  them into a photoreal portrait. To change the medium/look, change the channel style,
  not the character brief. THE CHAT LEVER: set_channel_config dna.imageStyle = a
  plain-language house style ("bold graphic illustration, NOT photographic") steers every
  character + scene render; a distilled Style-tab style (uploaded examples) wins over it
  when active.
- TEST SCENES (try before you author): generate_test_scene(channelId, scene, {characterIds?,
  styleId?, imageEngine?}) renders a throwaway image — CAST ANY NUMBER of characters via
  characterIds and each one's description AND reference sheet go in, so you can check they
  hold distinct identities in one frame. It does NOT need a distilled style: it uses the
  active/newest distilled style, else the house imageStyle, else no style. Returns the URL
  plus what steered it (style used, cast, engine). list_test_scenes shows past ones;
  refine_test_scene(channelId, sceneId, comments) reworks one with its current image as the
  edit reference. Test scenes cost one hero image each, belong to NO production, and never
  publish — promote a keeper into the example pool from the cockpit Style tab.
- ASPECT RATIO is an explicit Production Profile axis: orientation = "auto" (default) |
  "landscape" (16:9) | "portrait" (9:16). Set it with set_channel_config's
  productionProfile, or per video on author_script. "auto" derives it from the content
  format (long-form or targetLengthSec > 90 → landscape, else portrait). SET IT
  EXPLICITLY on a channel whose contentFormat is "both": the cockpit used to test
  contentFormat === "long" alone, so a "both" channel regenerated its shots as PORTRAIT
  on a 16:9 video while the pipeline made them landscape. One rule (core videoAspect)
  now decides for every image, clip and render. NOTE the two-level model (#51):
  contentFormat is the CHANNEL-LEVEL format switch (long/short/both, set via
  set_channel_config) and it is load-bearing — it feeds this same videoAspect rule,
  the shot planner's isLong and scriptwriter length steering; orientation above is the
  per-VIDEO override. Moving a channel to "both" changes real render behaviour, so set
  orientation explicitly in the same call.
- ORIENTATION IS ENFORCED IN THE PROMPT (2026-07-25 operator): every image AND
  animation prompt in production automatically gets its frame shape appended
  ("Wide 16:9 landscape orientation…" / "Vertical 9:16 portrait orientation…") to
  match the video's format, because engines treat the aspect API parameter as a
  hint and return the wrong shape (#50). This applies to authored/verbatim prompts
  too — you do NOT need to write orientation into imagePrompt/motionPrompt, and if
  you do it is not duplicated. Channel brand art is the one exception (its authored
  prompt stays byte-for-byte verbatim).
  AUDIT ASPECT OVER MCP (#50): get_production_shots and get_gate return renderAspect
  (what the video renders at), a per-shot aspect (recorded when the still was
  generated/re-sourced; null on shots produced before aspect recording landed),
  aspectMismatchShots (recorded aspect ≠ renderAspect), and shotsWithUnknownAspect.
  regenerate_shot takes an aspectRatio override (16:9/9:16/1:1) to force one shot's
  orientation. NOTE: this reports the RECORDED render aspect, not decoded pixel
  width/height — capturing true served dimensions at every generation site is a
  deferred follow-up (see get_deferred_work).
- ENGINE PREFERENCE: the Style-tab per-role engines (imageEngine bulk /
  heroImageEngine / characterImageEngine / thumbnailImageEngine) are now honoured
  EVERYWHERE. The cockpit's thumbnail + per-shot regeneration used a legacy helper
  that always pinned nano-banana, so a channel set to seedream still rendered on
  nano; that is fixed, and an explicit imageEngine argument still wins.
- BRAND ART (logo + banner) is on the MCP too: generate_brand_art(channelId, surface:
  'logo'|'banner', {...}). Pass prompt and it is used VERBATIM (nothing prepended — no
  channel preamble, no style block, no character description); omit it and the platform
  COMPOSES one from the channel name/niche + options (includeName, tagline, background,
  alignStyle, extra). mode:'refine' with changes edits the CURRENT art in place. Reference
  images ride along either way: characterId (feature a character IN the art), sceneId (a test
  scene's palette/mood), useCurrent (rework the existing art). The result is applied to the
  channel immediately, old versions are kept (revert in the cockpit), and the exact prompt is
  written to the decision ledger. Read assets back with get_channel_branding. Pushing a banner
  to YouTube is a cockpit action; YouTube has NO avatar API, so that upload stays manual.
- MODEL PICK: create_character/refine_character take an optional imageEngine
  (nano-banana | seedream | qwen) for the reference sheet — the cockpit Style tab has the
  same dropdown. Omitted → the channel's Production Profile characterImageEngine (Nano
  Banana unless set); the sheet is no longer hardcoded to Nano. Prefer nano-banana for
  characters you expect to REFINE: it conditions on the existing sheet, so it holds the
  same face best. A failed render degrades down the channel's own Style-tab engines.
Per-role render engines (characterImageEngine / characterVideoEngine) still control
which model draws/animates character shots — set those on the Production Profile.

## Branding (avatar + banner)
Generated in the cockpit (channel Settings → Branding), NOT by create_channel over
MCP — a freshly MCP-created channel has no avatar/banner until you generate them
there. get_channel_branding reads whether each is set and its /api/media URL. Avatar
is 800x800 square; banner needs >=2048x1152 with the subject in the central safe area
(cropped on mobile). Applying to YouTube stays a manual operator step.

## Music (per-channel bed + per-video track)
Two scopes. A CHANNEL BED is a reusable pool of ~8 tracks the render ALTERNATES
through (least-recently-used first) — consistent identity, no repeat. A PRODUCTION
track is the bed for one video only. The music axis (off/subtle/standard, set via
set_channel_config) gates whether a bed plays; musicMood is the default brief.
Tracks are free CC audio from Openverse (auto-credited) or a paid AI bed.

MCP tools (also editable in the cockpit Music panel):
- get_music(productionId) — reads musicMood, bedTarget, the channel bed[], and this
  production's candidate tracks (which one is selected for the render). Start here.
- search_free_music(query) — Openverse CC audio; returns track objects you pass
  straight into the set_* tools (unavailable in mock mode).
- set_music_bed(channelId, {addOpenverseTrack | addProductionStorageKey |
  removeBedTrackId}) — edit the channel's reusable pool (affects ALL future videos).
  addOpenverseTrack takes a search_free_music track (+ optional mood);
  addProductionStorageKey promotes a production track into the bed.
- set_production_music(productionId, {selectCandidateId | useBedStorageKey |
  useLibraryStorageKey | useOpenverseTrack}) — pick the track for ONE video without
  touching the bed (select an existing candidate, pull a bed track in, reuse a prior
  generated track, or drop in a one-off free track).
- generate_music(productionId, mood?) — PAID AI bed for one video (ElevenLabs), sized
  to the voiceover; first candidate auto-selects. Prefer a bed/free track first.

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

## Driving & recovering productions (2026-07-28 parity batch)
You can now steer a production's whole lifecycle, not just author it. (Gate
APPROVAL stays human — approve/reject/revise is the editorial-judgement record —
but everything around it is here.)
- greenlight_idea(ideaId, {allowDuplicate?}) — send an EXISTING backlog idea into
  production (author_script is the hand-authored path; this is the "just produce it"
  path). allowDuplicate overrides the already-published guard.
- halt_production(productionId, {discard?}) — stop an in-flight run, hand the idea
  back; discard any of script/voiceover/images/render/thumbnails you don't want reused.
- resume_production(productionId) — restart a HALTED production as a fresh one (reuses
  survivors, skips the script gate); returns the NEW productionId — track that.
  #94: the copy now CARRIES the halted run's per-video settings — externalScript (an
  operator-AUTHORED production stays authored: script gate skipped, authored imagePrompts
  used VERBATIM, authored motionPrompts honoured), productionProfile (no re-run of the
  profile-proposal LLM, no fresh profile_review gate on an already-decided profile), plus
  the voice/audio dials and persona/style pins. Before this a resumed authored production
  silently reverted to channel defaults, re-gated, and had its authored prompts rewritten.
  #96: the carried profile is MERGED over the channel's CURRENT config, so a setting you changed
  after the halt (e.g. archivalStrength:"off") takes effect instead of being frozen at the
  ancestor's snapshot — and when the resolved profile forbids real photography, the ancestor's
  SOURCED archival stills are NOT copied forward (they were surviving as real photos on an
  ai_images channel, with styleSource/engineRequested/engineServed all null — the tell that they
  were never generated by that run at all). Those shots regenerate under the current policy.
- retry_production(productionId, stage) — re-run FROM script|visuals|render|publish.
  'visuals' regenerates every beat image and reopens the visuals gate (the agent-usable
  "regenerate all storyboard" — per-shot fixes are regenerate_shot).
- force_forward(productionId) — un-stick a production and resume it IN PLACE, reusing
  every built artifact so it makes NO new LLM/generation calls. #98: it re-fires the pipeline
  (which skips every stage whose artifacts exist) and now PRESENTS the status matching the work
  that exists — assembling when a render exists, producing_assets when images do — instead of
  writing 'greenlit', which showed a fully-built, human-APPROVED production as if it were back
  at the start and implied the visuals approval no longer applied. Accepts on_hold/failed/
  rejected (waive a soft check you judged a false positive) AND the built-but-unpublished
  states halted/scheduled/ready — the manual override to publish a production that rendered
  but never published (a scheduled row with no providerVideoId, or an approved halted
  corrected copy stopped at publish). For halted this is the reuse-the-render path, distinct
  from resume_production which re-renders on a fresh copy. FORWARD ONLY: it SKIPS the human
  review gates (visuals + final) and drives straight to upload+publish (private) — the
  operator's force-forward IS the approval (logged), so it never drops the video back to a
  gate. Re-renders only if the render asset is missing. To re-review/rebuild, use resume/retry.
- retire_production(productionId) — archive a dead production (live video untouched).
- correct_published_production(productionId, {mode?}) — mint a CORRECTED COPY of a
  published/scheduled video: 'fix' (reuse all assets, land at visuals gate) or 'rebuild'
  (regenerate all visuals from the approved script). The original stays live (delete it
  in the cockpit if replacing). Returns the new productionId.
- release_publication(productionId) — publish an uploaded video NOW. Works on a video
  sitting SCHEDULED (releases it now AND clears the future YouTube slot in one call) or
  one parked private — this is how the operator says "just publish that scheduled one
  now". The immediate counterpart to set_publication_schedule's future slot. The
  channel's Made-for-Kids (COPPA) designation is preserved on go-live (#53).
- dedupe_shot_images(productionId) — one-click re-source of duplicate REAL photos at the
  visuals gate (complements get_production_shots' duplicateRiskGroups).
- fill_thin_prompts(productionId) — elaborate every thin/empty image prompt before render.
  #83: ASYNC — returns a jobId immediately (the pass fans out over an LLM and would
  outlive the MCP timeout); poll get_job(jobId), then re-read get_production_shots.
- get_job(jobId) — poll a background worker job (status queued|running|done|failed, op,
  error). #83: poll THIS after an async tool instead of retrying the original call — a
  retry on a timeout is what double-bills. Read-only.
- run_trend_scan() / run_analytics_ingest() — kick the trend fast-lane / analytics ingest
  on demand (run_analytics_ingest refreshes get_video_analytics/get_channel_analytics,
  subject to YouTube's 24-72h lag — use to verify an analytics-gated fix). ack_alert(alertId)
  clears a get_diagnostics alert you've handled. #94/#98: get_diagnostics.stuckReviewStates lists
  productions that are mid-pipeline but going NOWHERE — any non-terminal status with no activity
  past the threshold (#98: it used to watch only *_review, so a production stranded at 'greenlit'
  by a force-forward whose run never took was invisible to the very detector meant to catch it),
  and productions parked in a *_review status with NO pending gate row — a decision that CANNOT be
  made, because list_gates only returns PENDING gates, so the production is invisible until the
  pipeline's gate timeout strands it. Empty is the healthy answer; force_forward is the unblock
  (retry_production re-enters the stage). If a production reads as "stuck at voiceover", check
  this first — it may never have REACHED voiceover. #87: get_diagnostics.publicationIssues now
  flags STUCK UPLOADS (a production at scheduled/published with no providerVideoId = an upload
  that never completed, e.g. quota-exhausted) + duplicate published/scheduled productions for
  one idea — so a silent upload failure is discoverable, not found by scrolling Studio.
- P1/P5 READ 'blocked' FIRST on any stopped production. get_production returns
  blocked: null when healthy, else {kind, reason, summary, recommendedAction,
  canAutoRetry, stuckForMinutes}. kind is one of human_decision | gate_timeout |
  compliance_block | external_retryable | precondition. This REPLACES reading a
  failureReason string to guess a recovery verb — 19 of the pipeline's 20 pre-publish
  exits used to write plain 'on_hold' and differ only by prose. canAutoRetry is true
  ONLY for external_retryable (quota, upload limits, a stale render bundle): those are
  safe to re-fire unattended. Everything else needs a human judgement, so ASK rather
  than force_forward on the operator's behalf.
- P3 A TIMED-OUT GATE IS NO LONGER A DEAD END. Deciding a gate only works while a
  pipeline run is listening; when a gate had already TIMED OUT that run was gone, so
  the decision marked the gate 'decided' (hiding it from list_gates) and the production
  sat untouched — the exact state #94 reported. Deciding a timed-out gate now re-fires
  the pipeline automatically and the response says resumed:true.
- P6 AUTHORING INTENTIONS: scriptAuthored / promptsAuthored / motionAuthored replace the
  single externalScript flag, which silently governed all three (skip the script gate,
  skip the image-prompt builder, honour authored motionPrompts). author_script sets all
  three; resume and corrected copies carry them as a STRUCT, so a copy boundary can no
  longer half-un-author a production the way #94 did. A partial pass (your script, the
  platform's prompts) is now expressible.
- P4 resume_production(productionId, {inPlace: true}) recovers IN PLACE — no sibling
  production. resume's default new-row behaviour is what mints the same-idea siblings
  behind #94/#96/#97; in-place reuses every surviving artifact, re-bills nothing, and
  SKIPS the gates (same contract as force_forward). Use it when the built work is
  already what you want; leave it off for a clean re-render with every gate re-presented.
- P2 productionProfile.earlyComplianceChecks (OPT-IN, default off) runs the variation /
  anti-clone / review-board checks BEFORE the visuals gate instead of after, so a block
  lands on work nobody has reviewed yet. Off by default because it changes what
  'approved' means in the compliance log — turn it on with the operator present.
- #97 VARIATION CHECK (why an approved production can land in on_hold): after the
  visuals gate the pipeline compares the script's substance against the channel's
  CATALOGUE. The corpus is now published/scheduled rows of OTHER ideas only — a
  production cannot be a duplicate of itself, and every recovery path (resume_production,
  force_forward, correct_published_production) mints a SIBLING production that reuses the
  parent's substanceFingerprint verbatim, so counting siblings returned jaccard=1.000 and
  stranded human-approved work. failureReason now NAMES the production (and title) it
  matched, so a block can be audited instead of guessed at.
- #99 SECURITY — who is calling this connector: get_diagnostics returns mcpClients (distinct
  clients: clientId, self-reported name/version, a salted hash of the source address, call
  counts, sensitiveCalls, first/last seen) and per-call attribution on mcpCalls (clientId,
  targetChannelId, targetProductionId). The connector URL carries a token and can publish to
  the operator's channels and spend credits, so a client in that roster the operator does not
  recognise means the URL should be treated as LEAKED: rotate MCP_BEARER_TOKEN on /account,
  which invalidates the old URL immediately. A billable/publishing call from a never-seen
  client also raises a CRITICAL alert in openAlerts rather than sitting silently in a receipt.
- Playbook writes (get_playbook reads): add_playbook_entry(channelId, directive, {scope?})
  codifies a durable rule (scope hook/pacing/structure/visual/topic/title) that steers every
  future production; adopt_playbook_entry / retire_playbook_entry promote a trial rule or
  remove one. Use these to persist a learning across sessions.
- Series/episode editorial (ids from list_series): update_series flips status/
  renames/reorders; the heavier planner-LLM edits are revise_series(seriesId,
  instructions) (re-plan an arc), replace_episode(episodeId, {steer?}) (swap in a
  fresh episode), cut_episode(episodeId, {notes?}) / restore_episode_research
  (remove / bring back), regreenlight_episode (fresh production for an episode),
  run_editorial_plan(channelId) (kick the planner). Approving a proposed arc stays
  a human review (update_series can still flip proposed→active).
- edit_script_beats(productionId, {beats[] | texts[]}) — edit beats at the
  script_review gate: narration AND visual direction. #88 PREFERRED shape is
  beats[], a SPARSE list of per-index edits — [{index, text?, imagePrompt?,
  imagePrompts?, referenceEntity?, visualBrief?, motionPrompt?, animates?}] — so
  you edit 3 of 16 beats without matching the platform's beat count, and each beat
  can carry its own visual ask. imagePrompts[] is the #69 per-shot fan-out: an
  ORDERED list consumed across the several shots one beat is cut into, which is
  how ~70 shot prompts get authored from ~16 beats. Read the beats with
  get_production first and edit by index. texts[] is the legacy narration-only
  shape (length must equal the beat count). A visuals-only edit does NOT recut the
  voiceover; changing narration does. THIS IS THE AUTHORING PATH THAT DOES NOT
  DEPEND ON author_script — if author_script is unreachable, greenlight normally
  and shape the draft here, BEFORE any image is generated, so nothing is re-billed.
- edit_shot_prompts(productionId, shots[], regenerate) — #88: the shot-level
  sibling, for bulk fixes at the visuals gate when the images already exist
  (regenerate_shot does one shot at a time, impractical at ~70). shots[] is sparse:
  [{shotIndex, imagePrompt?, referenceEntity?, imageEngine?, characterId?}], indices from
  get_production_shots. #70: characterId casts a recurring character into a shot in bulk
  (the same per-shot cast as regenerate_shot) — needs regenerate:true (casting redraws),
  the id must belong to the channel, ignored when re-sourcing.
  #93 (append): an imagePrompt you write here is VERBATIM for the subject/composition,
  and the redraw appends the channel's render register the same way the pipeline does
  (the distilled Style-tab promptSuffix when a style is active, else dna.imageStyle) —
  so redrawing shots to FIX a styleless episode can't reproduce the styleless look.
  Same for regenerate_shot's prompt override. Bake a one-off look into the prompt to
  override the house style for that shot.
  regenerate is REQUIRED and IS the spend decision:
  false = store the prompts only (free; nothing is redrawn, so the rendered images
  do NOT change — use it to stage and review a pass), true = store them AND queue
  a redraw of exactly those shots, which BILLS per shot. Redraws are async durable
  jobs (#83), one jobId per shot, run one-at-a-time per production — poll
  get_job(jobId) or re-read get_production_shots; never re-run the call to "retry"
  a slow one (that double-bills, #66). Only at visuals_review; never auto-approves.
- Thumbnails: list_thumbnails(productionId) reads the candidates WITH ids (id/url/
  predictedCtr/selected/sourced) — the source for set_video_thumbnail's thumbnailId.
  refine_thumbnail(productionId, thumbnailId, changes, {characterId?}) edits an
  existing candidate ('bigger type', 'warmer sky') instead of rerolling.
- promote_test_scene(channelId, sceneId) — adopt a validated style test scene (from
  list_test_scenes) as the channel's active visual style (steers every future render).
- set_audio_levels(productionId, voiceVolume, musicVolume) — per-video audio mix +
  re-render (voice 0-1.5, music 0-1) when the bed sits too loud under the narration.
- Market intel: set_intel_cadence(channelId, daily|weekly|off) tunes/pauses scanning;
  add_competitor(channelId, name, {url?}) tracks a competitor; set_opportunity_status(
  opportunityId, shortlisted|dismissed) curates the get_intel feed (opportunityId from
  get_intel opportunities[].id).

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
- list_issues returns an ENVELOPE { appliedStatus, count, total, tickets[] } (#62):
  appliedStatus echoes the filter actually applied (a specific status, or
  "open+acknowledged" when none is passed) and total is the whole board size — so you
  can ASSERT the filter was honoured and spot truncation, not infer them. A
  status-filtered call NEVER returns an off-status ticket (guaranteed in code, not
  just the query), so a closed-set can't hide an open ticket.
- New tools ship behind the connector's cached tool list. If a tool named in
  this guide (e.g. get_deferred_work) returns "unknown tool" or never appears,
  the connector is holding a stale list — reconnect it (remove + re-add, or
  toggle it off/on) to refresh. get_guide self-audits and lists any tool it
  references that isn't actually registered, so a genuine gap is named explicitly.
- Approvals: read-only + advisory tools advertise a readOnlyHint so the app can run
  them WITHOUT a per-call approval; tools that SPEND or WRITE omit it and still ask.
  The compliance pre-check review_beat_map is auto-run (it's deterministic, no LLM
  spend, only logs an audit row — #88). author_script is NOT (it spends + creates a
  production), so it always needs an explicit approval — if a call returns the bare
  "No approval received", the host's approval prompt wasn't actioned: approve it (or
  approve when prompted). That message is emitted by the app, not the platform, so a
  spending tool that legitimately gates can only be run by granting the approval.
- "No approval received" — PROVE where it comes from before theorising (#88).
  That string is not in the platform's code at all, and the failing set has
  included get_production, which IS advertised readOnly — so it is not about tool
  annotations. get_diagnostics now returns mcpCalls: a receipt for every MCP call
  that actually REACHED the server (tool, ok, error, durationMs, argsBytes, at),
  plus lastHandshakeAt / lastToolsListAt. Make the failing call, then read it:
    * no row for that tool at that time  → the call never arrived. The failure is
      entirely host-side; nothing in the platform can fix it, and no amount of
      re-filing will change that. Report it to Anthropic, not as a platform ticket.
    * a row with ok:true  → we ran it and answered; the reply was lost in transit.
    * a row with ok:false → it IS the platform's, and the error field names the cause.
  lastToolsListAt also settles "is the fix deployed?" vs "is my tool list stale?" —
  if it predates the deploy, RECONNECT before concluding a tool is missing.
- If author_script is unreachable, operator-authored content is NOT blocked (#88).
  author_script is the whole-new-production path, not the only one: greenlight the
  idea normally, then author the draft in place with edit_script_beats at the
  script gate (narration + imagePrompt/imagePrompts/referenceEntity/visualBrief per
  beat, sparse by index — no beat-count matching), and fix shots in bulk after the
  fact with edit_shot_prompts at the visuals gate. Authoring at the SCRIPT gate is
  strictly better than at the visuals gate: the direction lands before any image is
  generated, so nothing has to be paid for twice. Both are in-gate edits and neither
  approves a gate — approval stays a human cockpit action.
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
  slot while it's uploaded-but-not-yet-public — the calendar follows. Reschedule = call
  it again with a new scheduledFor; the Made-for-Kids (COPPA) designation is preserved
  across (re)schedule/cancel (#53). #85: a NOT-YET-UPLOADED production (a legacy
  sleep-based schedule, or one whose upload never completed) can be (re)scheduled/cancelled
  too — a purely LOCAL calendar write (response carries uploaded:false + a note that it
  won't go live until uploaded via retry_production or reconciled). To publish a scheduled
  video immediately instead, use release_publication (it clears the slot and flips it
  public in one call). For a video the
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
