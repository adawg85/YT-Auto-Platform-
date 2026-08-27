/**
 * #129 — the ACTION CONSEQUENCES registry: for every tool that changes state,
 * what it DISCARDS, what it KEEPS, whether it BILLS, whether it is REVERSIBLE,
 * and how to PREVIEW it.
 *
 * Why this is code and not a document. The operating guide served by `get_guide`
 * is the live contract (the MCP client is told to read it at session start and to
 * treat it as superseding any file in the project folder) precisely because files
 * drift. A consequences reference kept as a markdown file would drift the same
 * way — and a consequences reference that has drifted is worse than none, because
 * it is believed. So the table is DATA here, rendered into the guide, and the
 * registry is audited against the tool registry: a tool that mutates state and is
 * missing from this file fails `pnpm --filter @ytauto/cockpit test` and surfaces
 * as a `get_guide` warning. A new mutating tool cannot ship undocumented.
 *
 * The cost of not having had this, measured 2026-08-17/18: a 24-shot Short that
 * costs ~$0.72 to generate once was generated roughly three times over (~$2.20),
 * and another production reached A$6.27 — none of it caused by a change to the
 * creative work.
 */

/** What a call does to spend. */
export type ActionBilling =
  /** no generation spend — DB/YouTube-metadata writes only */
  | "free"
  /** spends on generation (LLM / image / video / voice / music) */
  | "bills"
  /** free itself, but the run it starts re-bills the stage(s) it rebuilds */
  | "bills_downstream";

export type ActionConsequence = {
  tool: string;
  /** grouping in the rendered table */
  group:
    | "Recovery & re-entry"
    | "Authoring & editing"
    | "Generation"
    | "Publication"
    | "Channel & config"
    | "Planning & backlog"
    | "Characters & style"
    | "Music & audio"
    | "Intel, alerts & tickets";
  /** artifacts/state this call destroys or invalidates — "nothing" when it destroys nothing */
  discards: string;
  /** what survives the call */
  keeps: string;
  bills: ActionBilling;
  /** the nuance the three-value enum can't carry (which mode bills, what the spend is) */
  billsNote?: string;
  /** how to get back — or the plain statement that you cannot */
  reversible: string;
  /** the free way to see the consequences first, or how to check state instead */
  preview: string;
};

/**
 * Tools that are NOT in READ_ONLY_TOOLS (so the host prompts for approval) but
 * write nothing. Listed WITH A REASON rather than skipped, so the audit stays
 * total: every registered tool is accounted for in exactly one of these two
 * places. The allowlist mismatch itself is a papercut, not a defect — being
 * asked to approve a read is safe, and changing the auto-run hint is a
 * live-behaviour change, so it is filed rather than slipped in here.
 */
export const NON_MUTATING_UNLISTED: Record<string, string> = {
  list_characters: "pure read — missing from READ_ONLY_TOOLS, so it prompts for approval it doesn't need",
  list_test_scenes: "pure read — same allowlist gap",
  list_audio_assets: "pure read — same allowlist gap",
  get_audio_asset: "pure read — same allowlist gap",
};

/**
 * The registry. Ordered by group, then by how much damage the tool can do —
 * the recovery verbs lead because they are where the money was lost.
 */
export const ACTION_CONSEQUENCES: ActionConsequence[] = [
  // ── Recovery & re-entry ───────────────────────────────────────────────────
  {
    tool: "reopen_stage",
    group: "Recovery & re-entry",
    discards:
      "mode `clean`/`rebuild`: the named stage's OWN output AND everything downstream. mode `reopen`/`keep` (default): only what is DOWNSTREAM — the stage's own output is kept, not rebuilt",
    keeps:
      "the script (unless you reopen `script`), ALL recorded operator takes in either mode, and — when reopening `visuals` — the voiceover, music bed and thumbnail",
    bills: "bills_downstream",
    reversible: "`cancel_reopen` — but ONLY until the reopened stage actually re-runs; after that the discarded artifacts are gone",
    preview: "`confirm: false` returns `discards`, `keeps`, `reversible`, `deletesWhen` and changes nothing. Free. Use it every time",
  },
  {
    tool: "cancel_reopen",
    group: "Recovery & re-entry",
    discards: "nothing — it restores the production to exactly its pre-reopen state",
    keeps: "everything, including the artifacts the reopen had marked stale",
    bills: "free",
    reversible: "re-issue the `reopen_stage` call",
    preview: "`get_production().reopen` shows the reopen in flight; it refuses once the stage has produced new output",
  },
  {
    tool: "continue_production",
    group: "Recovery & re-entry",
    discards: "nothing",
    keeps: "every artifact; the status lands on the work that EXISTS, not upstream of it",
    bills: "free",
    reversible: "`halt_production` stops the run it starts",
    preview:
      "check `get_production().blocked` FIRST — on a compliance block this resumes PAST it and records no waiver (#128); fix the substance or use `force_forward`, which IS logged",
  },
  {
    tool: "force_forward",
    group: "Recovery & re-entry",
    discards: "any pending gate (expired); the soft checks are WAIVED for the rest of the run",
    keeps: "every stored artifact — script, images, render, thumbnails, music, voiceover; no re-render",
    bills: "free",
    reversible: "no — the waiver is recorded and the run drives to upload/publish; `halt_production` is the only stop",
    preview: "`get_production().blocked` names the halt class; refused on a `precondition` halt, whose reason carries the real fix (#78)",
  },
  {
    tool: "halt_production",
    group: "Recovery & re-entry",
    discards:
      "nothing by default — but the OPTIONAL `discard` list (script/voiceover/images/render/thumbnails) deletes those groups permanently",
    keeps: "everything not named in `discard`; the idea returns to the pool",
    bills: "free",
    reversible: "`continue_production` (preferred) or `resume_production` — but a DISCARDED group is gone and re-bills when rebuilt",
    preview: "omit `discard` entirely unless you can name why each group must die",
  },
  {
    tool: "resume_production",
    group: "Recovery & re-entry",
    discards: "nothing on the original — but it mints a SIBLING production row; the lineage behind #94/#96/#97",
    keeps: "surviving script/media are reused on the copy, which carries the original's per-video settings",
    bills: "bills_downstream",
    reversible: "`retire_production` on the copy — the original row is untouched",
    preview: "prefer `continue_production` / `reopen_stage`; both work in place and mint nothing",
  },
  {
    tool: "retry_production",
    group: "Recovery & re-entry",
    discards: "the named stage's artifacts AND its downstream (script → voiceover, images, clips, render; visuals → images, clips, render)",
    keeps: "everything upstream of the stage",
    bills: "bills_downstream",
    reversible: "no — the deleted rows are gone; the re-run pays for them again",
    preview: "`get_production_shots` first — a per-shot fix is `regenerate_shot`, which re-bills ONE image instead of the stage",
  },
  {
    tool: "retire_production",
    group: "Recovery & re-entry",
    discards: "nothing on YouTube — a live video STAYS UP; the row goes terminal `retired` and pending gates are cancelled",
    keeps: "all artifacts, for the record",
    bills: "free",
    reversible: "no MCP un-retire — mint a fresh production, or use `correct_published_production` for a live video",
    preview: "`get_production` — confirm you are retiring the row you think you are",
  },
  {
    tool: "correct_published_production",
    group: "Recovery & re-entry",
    discards: "nothing — the ORIGINAL live video is left alone (deleting it stays a human cockpit action)",
    keeps: "mode `fix`: script, voiceover, stills and clips are reused. mode `rebuild`: the approved script only",
    bills: "bills_downstream",
    reversible: "`retire_production` on the copy",
    preview: "`get_production` on the original; the copy lands at the visuals gate, so nothing publishes without a decision",
  },
  {
    tool: "greenlight_idea",
    group: "Recovery & re-entry",
    discards: "nothing",
    keeps: "the idea; a production row is created",
    bills: "bills_downstream",
    reversible: "`halt_production` on the new production",
    preview: "`list_ideas` — and mind the duplicate guard: `allowDuplicate:true` is a deliberate second upload of the same idea",
  },

  // ── Authoring & editing ───────────────────────────────────────────────────
  {
    tool: "author_script",
    group: "Authoring & editing",
    discards: "nothing existing — it CREATES a production and starts the pipeline",
    keeps: "n/a",
    bills: "bills",
    reversible: "`halt_production` on the returned productionId",
    preview: "`review_beat_map` first — the cheapest gate, and it is free; read `perBeat[].shots` before writing `imagePrompts[]`",
  },
  {
    tool: "edit_script_beats",
    group: "Authoring & editing",
    discards:
      "visuals-only edits discard NOTHING. A narration (`text`) edit on a beat WITH recorded takes deletes those beats' takes — refused unless `invalidateTakes: true`",
    keeps: "unedited beats and their takes; a whole-script take is invalidated by any narration change",
    bills: "free",
    reversible: "re-send the previous text — but deleted takes must be RE-RECORDED",
    preview:
      "`get_script` first and edit by index. `visualsChanged: true` does NOT mean the shot plan rebuilt — `visualsStale` is the field that answers that",
  },
  {
    tool: "edit_shot_prompts",
    group: "Authoring & editing",
    discards: "with `regenerate: true`, the listed shots' current images",
    keeps: "every unlisted shot, the voiceover, the script",
    bills: "bills",
    reversible: "no — re-generating back costs the same again",
    preview: "`get_production_shots` for indices; without `regenerate` it only rewrites prompts and bills nothing",
  },
  {
    tool: "set_production_profile",
    group: "Authoring & editing",
    discards: "nothing — it updates the production's snapshotted profile in place",
    keeps: "all artifacts; changes apply to work generated AFTER the call",
    bills: "free",
    reversible: "call again with the previous values",
    preview: "`get_production` returns the current profile",
  },
  {
    tool: "set_voice_source",
    group: "Authoring & editing",
    discards: "nothing directly — but switching source after the visuals stage re-cuts (and re-bills) the shots",
    keeps: "recorded takes are never deleted by this call",
    bills: "bills_downstream",
    reversible: "set it back — the cost is in what has already been cut from the old audio",
    preview: "set it BEFORE the visuals stage; `get_production().voiceover` reports the current source",
  },
  {
    tool: "set_production_voiceover",
    group: "Authoring & editing",
    discards: "the take at that beat/segment (or, with no index, the whole narration is replaced by your file)",
    keeps: "every other take; the script",
bills: "free",
    billsNote: "Whisper alignment aside",
    reversible: "re-attach the previous audio",
    preview: "`get_production().voiceover` — check `segmentCount`, `takesRecorded`, `segmentsAwaitingTake` first",
  },
  {
    tool: "set_production_shot_video",
    group: "Authoring & editing",
    discards: "that shot's existing clip/still as the rendered source",
    keeps: "every other shot; the render until it is rebuilt",
bills: "free",
    billsNote: "a worker trim/scale, no generation",
    reversible: "re-attach or `regenerate_shot`",
    preview: "`get_production_shot` for the shot's window (aspect + length)",
  },
  {
    tool: "set_audio_levels",
    group: "Authoring & editing",
    discards: "the current render — it RE-RENDERS with the new mix",
    keeps: "voiceover, music, images, clips",
bills: "free",
    billsNote: "render compute only, no generation",
    reversible: "set the previous levels and re-render",
    preview: "`get_production` — the mix is per-video and overrides the channel ducking",
  },

  // ── Generation ────────────────────────────────────────────────────────────
  {
    tool: "regenerate_shot",
    group: "Generation",
    discards: "that ONE shot's current image (and its clip, which animated the replaced still)",
    keeps: "every other shot, the voiceover, the render until rebuilt",
bills: "bills",
    billsNote: "`referenceEntity` re-source is FREE (`mode:\"real\"`); generate mode is ~$0.03/image",
    reversible: "no — regenerating back costs again",
    preview:
      "requires the visuals gate. **Never retry on a timeout** — the call can bill while the HTTP response times out; check `get_production_shot` instead",
  },
  {
    tool: "regenerate_thumbnail",
    group: "Generation",
    discards: "nothing — new candidates are ADDED alongside the existing ones",
    keeps: "every existing candidate and the current selection",
    bills: "bills",
    reversible: "select a different candidate with `set_video_thumbnail`",
    preview:
      "**Times out on the HTTP response while still executing — never retry.** Check `list_thumbnails` to see what actually landed",
  },
  {
    tool: "refine_thumbnail",
    group: "Generation",
    discards: "nothing — the refined candidate is a new image",
    keeps: "the original candidate",
    bills: "bills",
    reversible: "re-select the earlier candidate",
    preview: "`list_thumbnails` for the id and the current selection",
  },
  {
    tool: "dedupe_shot_images",
    group: "Generation",
    discards: "the duplicate REAL photos it replaces",
    keeps: "every unique shot; the script and voiceover",
bills: "free",
    billsNote: "re-sourcing archival images, not generation",
    reversible: "no — the replaced sourcing is gone; `regenerate_shot` can re-source a specific shot",
    preview: "`get_production_shots().duplicateRiskGroups` reports the duplicates without changing anything",
  },
  {
    tool: "fill_thin_prompts",
    group: "Generation",
    discards: "nothing — it writes prompts, it does not generate images",
    keeps: "every existing prompt that is not thin/empty",
bills: "bills",
    billsNote: "one LLM pass over the thin prompts",
    reversible: "`edit_shot_prompts` to overwrite what it wrote",
    preview: "ASYNC — returns a `jobId`; poll `get_job`, do NOT re-run to 'retry' (#66 double-bills)",
  },
  {
    tool: "generate_music",
    group: "Generation",
    discards: "nothing — a new candidate is added (the first on a production auto-selects)",
    keeps: "every existing candidate",
bills: "bills",
    billsNote: "ElevenLabs — real money",
    reversible: "`set_production_music` back to the previous candidate",
    preview: "`search_free_music` / `list_audio_assets` first — a bed or free track costs nothing",
  },
  {
    tool: "generate_test_scene",
    group: "Generation",
    discards: "nothing — throwaway scenes, no production touched",
    keeps: "everything",
bills: "bills",
    billsNote: "one hero image",
    reversible: "n/a — nothing was changed",
    preview: "this IS the preview: it is how you see a look before authoring a video",
  },
  {
    tool: "refine_test_scene",
    group: "Generation",
    discards: "nothing — the current image rides as the edit reference",
    keeps: "the earlier scene",
bills: "bills",
    billsNote: "one hero image",
    reversible: "n/a",
    preview: "`list_test_scenes` for the scene id",
  },
  {
    tool: "generate_brand_art",
    group: "Generation",
    discards: "nothing until you adopt it — a new logo/banner candidate",
    keeps: "the channel's current branding",
    bills: "bills",
    reversible: "re-adopt the previous art",
    preview: "`get_channel_branding` shows what is live now",
  },

  // ── Publication ───────────────────────────────────────────────────────────
  {
    tool: "release_publication",
    group: "Publication",
    discards: "the future YouTube slot, if it had one",
    keeps: "the video and all artifacts",
    bills: "free",
    reversible: "**NO — OUTWARD-FACING. The video is LIVE immediately** and unpublishing is a human Studio action",
    preview: "`get_production().publication` — confirm the id, the title and the schedule before flipping it public",
  },
  {
    tool: "set_publication_schedule",
    group: "Publication",
    discards: "the previous slot; `cancel:true` clears the slot and leaves the video uploaded + PRIVATE",
    keeps: "the upload itself — this is one `videos.update`, never a re-upload",
    bills: "free",
    reversible: "call again with a new `scheduledFor`",
    preview: "`get_production().publication`; an already-public video must be unpublished first",
  },
  {
    tool: "set_publication_metadata",
    group: "Publication",
    discards: "the previous title/description/tags — on a live or scheduled video this is PUSHED to YouTube",
    keeps: "the video, the thumbnail, the schedule",
    bills: "free",
    reversible: "call again with the previous values (image credits + the AI-disclosure line are re-appended)",
    preview:
      "`get_production` for the authored metadata (#131: its `publication.musicCredit` is the MUSIC credit the live description carries — a pushed description re-resolves it from the live audio-library asset, requiredCreditFormat verbatim when set, and re-records it); `sync_publication_from_youtube` reports the LIVE title",
  },
  {
    tool: "set_video_thumbnail",
    group: "Publication",
    discards: "the thumbnail currently on YouTube",
    keeps: "every candidate; the video itself (this is a one-call swap, not a rebuild)",
    bills: "free",
    reversible: "push a different candidate",
    preview: "`list_thumbnails` — add candidates with `regenerate_thumbnail` first",
  },
  {
    tool: "sync_publication_from_youtube",
    group: "Publication",
    discards: "nothing — it reconciles ONE record to YouTube's truth",
    keeps: "everything; it can also ATTACH an external video id",
    bills: "free",
    reversible: "it only ever moves the record toward reality",
    preview: "safe to run; with the mock provider it reports `unknown` and changes nothing",
  },
  {
    tool: "reconcile_publications",
    group: "Publication",
    discards:
      "nothing without `fix`. **`fix:true` is a WRITE**: phantoms are demoted to `published_unverified`, drifted dates corrected, unrecorded publishes recorded (#126)",
    keeps: "every video id, for history; no YouTube-side change at all",
    bills: "free",
    reversible: "`sync_publication_from_youtube` re-reads the truth per record",
    preview: "run it WITHOUT `fix` — that read is the preview, and `fixHint` names exactly what `fix:true` would do",
  },

  // ── Channel & config ──────────────────────────────────────────────────────
  {
    tool: "create_channel",
    group: "Channel & config",
    discards: "nothing — creates a channel",
    keeps: "n/a",
bills: "bills",
    billsNote: "the charter LLM, UNLESS you pass the `charter` object from propose_channel",
    reversible: "no MCP delete — a channel is a durable object",
    preview: "`propose_channel` drafts the charter and commits nothing; pass that object back so what you reviewed is what ships",
  },
  {
    tool: "propose_channel",
    group: "Channel & config",
    discards: "nothing — creates nothing",
    keeps: "everything",
bills: "bills",
    billsNote: "one drafting LLM pass",
    reversible: "n/a",
    preview: "this IS the preview step for `create_channel`",
  },
  {
    tool: "set_channel_config",
    group: "Channel & config",
    discards: "the previous value of each field you send (only sent fields change)",
    keeps: "every field you omit; in-flight productions keep their snapshotted profile",
    bills: "free",
    reversible: "send the previous values",
    preview: "`get_channel_config` returns the current surface — read it before patching",
  },
  {
    tool: "set_channel_strategy",
    group: "Channel & config",
    discards: "that SECTION's previous content (empty `content` clears it); other sections untouched",
    keeps: "the rest of the document; each section is timestamped so superseded reasoning survives",
    bills: "free",
    reversible: "re-write the section",
    preview: "`get_channel_strategy`",
  },
  {
    tool: "set_channel_style",
    group: "Channel & config",
    discards: "nothing — it edits or deactivates the distilled style register",
    keeps: "every production's existing images; the style applies to FUTURE generations",
    bills: "free",
    reversible: "re-activate or re-edit",
    preview: "`get_channel_config`; the distilled `promptSuffix` OUTRANKS `dna.imageStyle` while a style is active",
  },
  {
    tool: "set_intel_cadence",
    group: "Channel & config",
    discards: "nothing",
    keeps: "existing intel; `off` just pauses scanning",
    bills: "free",
    reversible: "set it back",
    preview: "`get_intel`",
  },

  // ── Characters & style ────────────────────────────────────────────────────
  {
    tool: "create_character",
    group: "Characters & style",
    discards: "nothing",
    keeps: "everything",
bills: "bills",
    billsNote: "a distillation LLM + a reference-sheet render",
    reversible: "`delete_character`, or `set_character_cast` with `enabled:false`",
    preview: "`list_characters` first — a channel can carry many, and casting is per-video",
  },
  {
    tool: "refine_character",
    group: "Characters & style",
    discards: "the previous reference sheet — it RE-RENDERS the look",
    keeps: "the identity (the current image is the edit reference) and every unmentioned detail of the description",
    bills: "bills",
    reversible: "refine back, but the exact previous sheet is not restored",
    preview: "`list_characters` for the current canonical description",
  },
  {
    tool: "set_character_cast",
    group: "Characters & style",
    discards: "nothing — no re-render",
    keeps: "the character and its sheet; `enabled:false` removes it from the pipeline without deleting it",
    bills: "free",
    reversible: "set it back",
    preview: "`list_characters`",
  },
  {
    tool: "delete_character",
    group: "Characters & style",
    discards: "the character permanently — it is never cast again",
    keeps: "the reference-sheet bytes in the store (past productions may still cite them)",
    bills: "free",
    reversible: "**no** — re-create and re-render (which bills). Prefer `set_character_cast` `enabled:false`",
    preview: "`list_characters`",
  },
  {
    tool: "promote_test_scene",
    group: "Characters & style",
    discards: "the previously active style (it is stepped aside, not deleted)",
    keeps: "every existing image; the new style applies to FUTURE productions",
    bills: "free",
    reversible: "`set_channel_style` to re-activate the previous style",
    preview: "`list_test_scenes` — validate the look with `generate_test_scene`/`refine_test_scene` first",
  },

  // ── Music & audio ─────────────────────────────────────────────────────────
  {
    tool: "set_music_bed",
    group: "Music & audio",
    discards: "only what the single operation names (a removed track); the pool is otherwise untouched",
    keeps: "every other bed track; already-rendered videos keep their audio",
    bills: "free",
    reversible: "re-add the track",
    preview: "`get_music` for the current bed; a non-commercial licence is REFUSED rather than silently accepted",
  },
  {
    tool: "set_production_music",
    group: "Music & audio",
    discards: "the previous selection for this video (a re-render is needed for it to be heard)",
    keeps: "every candidate; the channel bed",
    bills: "free",
    reversible: "select the previous candidate",
    preview: "`get_music` on the production",
  },
  {
    tool: "register_audio_asset",
    group: "Music & audio",
    discards: "nothing — adds to the platform library",
    keeps: "everything",
bills: "free",
    billsNote: "a fetch into the store",
    reversible: "the asset can be edited with `patch_audio_asset`",
    preview: "`list_audio_assets` to avoid duplicates",
  },
  {
    tool: "patch_audio_asset",
    group: "Music & audio",
    discards: "the previous metadata of sent fields (licence normalisation may RE-DERIVE `commercialUse`)",
    keeps: "the audio itself and unsent fields",
    bills: "free",
    reversible: "patch back",
    preview: "`get_audio_asset` for the full T.A.S.L. record",
  },

  // ── Planning & backlog ────────────────────────────────────────────────────
  {
    tool: "write_idea",
    group: "Planning & backlog",
    discards: "nothing",
    keeps: "everything",
bills: "free",
    billsNote: "unless `greenlight:true` — which starts a production and bills the pipeline",
    reversible: "`set_idea_status` (rejected/archived); `halt_production` if it greenlit",
    preview: "`review_slate` is the cheapest gate — run a batch of titles through it BEFORE they enter the backlog",
  },
  {
    tool: "seed_idea",
    group: "Planning & backlog",
    discards: "nothing",
    keeps: "everything",
bills: "bills",
    billsNote: "auto-scoring",
    reversible: "`set_idea_status`",
    preview: "`list_ideas` for duplicates; `write_idea` is the documented canonical path",
  },
  {
    tool: "update_idea",
    group: "Planning & backlog",
    discards: "the previous title/angle of sent fields",
    keeps: "the idea's status, score and lineage",
    bills: "free",
    reversible: "send the previous values",
    preview: "`list_ideas`",
  },
  {
    tool: "set_idea_status",
    group: "Planning & backlog",
    discards: "nothing — ideas are never deleted, only moved out of the working set",
    keeps: "the idea rows (they still anchor the near-duplicate check)",
    bills: "free",
    reversible: "set the status back",
    preview: "`list_ideas`; unknown ids come back in `skipped` rather than failing the batch",
  },
  {
    tool: "create_series",
    group: "Planning & backlog",
    discards: "nothing",
    keeps: "everything",
bills: "free",
    billsNote: "authored directly — no planner LLM",
    reversible: "`update_series` status → archived",
    preview: "`list_series`",
  },
  {
    tool: "update_series",
    group: "Planning & backlog",
    discards: "the previous title/description/status/order of sent fields",
    keeps: "every episode and its research",
    bills: "free",
    reversible: "send the previous values",
    preview: "`list_series`",
  },
  {
    tool: "revise_series",
    group: "Planning & backlog",
    discards: "the planner's previous episode set for that arc",
    keeps: "the arc; produced/published episodes",
bills: "bills",
    billsNote: "re-runs the series-planner LLM",
    reversible: "no — the previous plan is replaced; `update_series` is the non-LLM edit",
    preview: "`list_series`; prefer `update_series` when you only need a rename/reorder/status flip",
  },
  {
    tool: "set_episode_status",
    group: "Planning & backlog",
    discards: "nothing — `cut` removes the episode from the arc's working set",
    keeps: "the episode row and its research",
    bills: "free",
    reversible: "set the status back, or `restore_episode_research`",
    preview: "`list_series`",
  },
  {
    tool: "cut_episode",
    group: "Planning & backlog",
    discards: "nothing permanently — the episode leaves the arc",
    keeps: "its research, and the optional note recording why",
    bills: "free",
    reversible: "`restore_episode_research`",
    preview: "`list_series`",
  },
  {
    tool: "restore_episode_research",
    group: "Planning & backlog",
    discards: "nothing",
    keeps: "everything — it is the inverse of `cut_episode`",
    bills: "free",
    reversible: "`cut_episode`",
    preview: "`list_series`",
  },
  {
    tool: "replace_episode",
    group: "Planning & backlog",
    discards: "the episode in that slot",
    keeps: "the rest of the arc",
bills: "bills",
    billsNote: "an LLM writes the replacement",
    reversible: "`restore_episode_research` on the cut episode",
    preview: "`list_series`; a `steer` guides the replacement",
  },
  {
    tool: "regreenlight_episode",
    group: "Planning & backlog",
    discards: "nothing — it mints a FRESH production for the episode",
    keeps: "the abandoned/failed production row",
    bills: "bills_downstream",
    reversible: "`halt_production` on the new production",
    preview: "`list_series`; use it only when the prior production is genuinely abandoned",
  },
  {
    tool: "run_editorial_plan",
    group: "Planning & backlog",
    discards: "nothing — it PROPOSES arcs/episodes",
    keeps: "existing arcs",
bills: "bills",
    billsNote: "the planner LLM + research",
    reversible: "archive what it proposes",
    preview: "`list_series` before and after; it runs on the worker",
  },
  {
    tool: "review_slate",
    group: "Planning & backlog",
    discards: "nothing — it is a pre-check, not a write to the backlog",
    keeps: "everything",
bills: "bills",
    billsNote: "a small LLM pass — the cheapest gate in the pipeline",
    reversible: "n/a",
    preview: "this IS the preview step for a batch of ideas",
  },
  {
    tool: "accept_slate_finding",
    group: "Planning & backlog",
    discards: "nothing — the standing rule is UNCHANGED",
    keeps: "the rule; the acceptance is recorded in the editorial decision ledger with your written reason",
    bills: "free",
    reversible: "the acceptance is a one-off by construction — it does not weaken the rule",
    preview: "`review_slate` output names the finding you would be accepting",
  },
  {
    tool: "add_playbook_entry",
    group: "Planning & backlog",
    discards: "nothing — a standing directive every future production honours",
    keeps: "every existing entry",
    bills: "free",
    reversible: "`retire_playbook_entry`",
    preview: "`get_playbook` — read the standing rules before adding one that contradicts them",
  },
  {
    tool: "adopt_playbook_entry",
    group: "Planning & backlog",
    discards: "nothing — promotes a TRIAL directive to permanent",
    keeps: "the entry",
    bills: "free",
    reversible: "`retire_playbook_entry`",
    preview: "`get_playbook`",
  },
  {
    tool: "retire_playbook_entry",
    group: "Planning & backlog",
    discards: "the directive's influence on future productions",
    keeps: "the entry's record",
    bills: "free",
    reversible: "`add_playbook_entry` again",
    preview: "`get_playbook`",
  },

  // ── Intel, alerts & tickets ───────────────────────────────────────────────
  {
    tool: "run_market_scan",
    group: "Intel, alerts & tickets",
    discards: "nothing — refreshes intel",
    keeps: "everything",
bills: "bills",
    billsNote: "research + LLM",
    reversible: "n/a",
    preview: "`get_intel` shows what is already there — it runs daily on a cron anyway",
  },
  {
    tool: "run_trend_scan",
    group: "Intel, alerts & tickets",
    discards: "nothing — adds trend-driven candidates to the backlog",
    keeps: "everything",
    bills: "bills",
    reversible: "`set_idea_status` on what it adds",
    preview: "`list_ideas`",
  },
  {
    tool: "run_analytics_ingest",
    group: "Intel, alerts & tickets",
    discards: "nothing — pulls YouTube analytics in",
    keeps: "everything",
    bills: "free",
    reversible: "n/a",
    preview: "safe; subject to YouTube's own 24-72h reporting lag",
  },
  {
    tool: "add_competitor",
    group: "Intel, alerts & tickets",
    discards: "nothing",
    keeps: "everything",
    bills: "free",
    reversible: "no MCP remove today",
    preview: "`get_intel` lists who is already tracked",
  },
  {
    tool: "set_opportunity_status",
    group: "Intel, alerts & tickets",
    discards: "nothing — shortlists or dismisses an opportunity",
    keeps: "the opportunity row",
    bills: "free",
    reversible: "set the status back",
    preview: "`get_intel`",
  },
  {
    tool: "ack_alert",
    group: "Intel, alerts & tickets",
    discards: "nothing — the alert is marked handled, not deleted",
    keeps: "the alert record",
    bills: "free",
    reversible: "no un-ack over MCP — a genuine condition raises a fresh alert",
    preview: "`get_diagnostics` / `get_channel_state` for the open alerts",
  },
  {
    tool: "report_issue",
    group: "Intel, alerts & tickets",
    discards: "nothing — files a ticket (mirrored to a GitHub issue)",
    keeps: "everything",
    bills: "free",
    reversible: "`resolve_issue` to close it",
    preview: "`list_issues` first — `append_to_issue` is right when the defect is already filed",
  },
  {
    tool: "resolve_issue",
    group: "Intel, alerts & tickets",
    discards: "nothing — sets a ticket's status",
    keeps: "the ticket and its history",
    bills: "free",
    reversible: "set the status back (`open` exists exactly for a premature close)",
    preview: "`list_issues`",
  },
  {
    tool: "append_to_issue",
    group: "Intel, alerts & tickets",
    discards: "nothing — appends a comment",
    keeps: "everything",
    bills: "free",
    reversible: "no delete over MCP",
    preview: "`list_issues` for the ticket's `githubUrl`",
  },
];

/** The `bills` column, rendered. */
const BILLING_LABEL: Record<ActionBilling, string> = {
  free: "no",
  bills: "**YES**",
  bills_downstream: "**downstream** — the re-run pays for what it rebuilds",
};

const GROUP_ORDER: ActionConsequence["group"][] = [
  "Recovery & re-entry",
  "Authoring & editing",
  "Generation",
  "Publication",
  "Channel & config",
  "Characters & style",
  "Music & audio",
  "Planning & backlog",
  "Intel, alerts & tickets",
];

/** One markdown table per group, generated from the registry. */
function renderTables(): string {
  const out: string[] = [];
  for (const group of GROUP_ORDER) {
    const rows = ACTION_CONSEQUENCES.filter((a) => a.group === group);
    if (!rows.length) continue;
    out.push(`### ${group}`);
    out.push("");
    out.push("| Tool | Discards | Keeps | Bills | Undo | Preview / check first |");
    out.push("|---|---|---|---|---|---|");
    for (const r of rows) {
      const bills = r.billsNote ? `${BILLING_LABEL[r.bills]} — ${r.billsNote}` : BILLING_LABEL[r.bills];
      out.push(
        `| \`${r.tool}\` | ${r.discards} | ${r.keeps} | ${bills} | ${r.reversible} | ${r.preview} |`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * The `actions` guide section, rendered at module load. Served by
 * `get_guide(section:'actions')` and embedded in the full guide.
 */
export const ACTIONS_SECTION: string = [
  "## Action consequences — what each call discards, bills, and how to undo it",
  "",
  "**Before any state-changing call, be able to state three things: what it discards, whether it re-bills generation, and how to undo it. If you cannot answer all three, do not make the call — read the tool description in full, or run the preview.**",
  "",
  "`reopen_stage` accepts `confirm: false`. It is free and returns `discards`, `keeps`, `reversible` and `deletesWhen` without changing anything. Use it every time.",
  "",
  "This is not generic caution. Measured 2026-08-17/18: *5 Compliments* (`01KZZNV2P3WSRZVQY1XN8TVBJP`) — a 24-shot Short costing ~$0.72 to generate once — was generated roughly THREE TIMES OVER, ~$2.20; *7 Habits* (`01KZZPGB80J21ZMBFPWDBE4BT9`) reached A$6.27. Not one of those regenerations was caused by a change to the creative work. They were caused by calls whose consequences were not known before they were made.",
  "",
  "### The four traps that actually cost money",
  "",
  "1. **`reopen_stage` mode `reopen` KEEPS the reopened stage's own output and does NOT rebuild it** — it detaches it and lets you re-decide. `clean` is what rebuilds. The naming is the trap: choosing `reopen` when you meant `clean` leaves the stage detached but not rebuilt, which is what left a broken 94-piece voiceover track attached to *7 Habits*. Since #127 the modes also answer to `keep` and `rebuild`, which say what they do.",
  "2. **`edit_script_beats` returning `visualsChanged: true` does NOT mean the shot plan rebuilt.** It means the visual fields were written. **`visualsStale`** is the field that answers the real question. Reading the first as the second is what produced orphan shots cut from a superseded script.",
  "3. **`continue_production` resumes PAST a compliance block** — `blocked` goes to `null`, the run carries on with the offending script intact, and no waiver is recorded (#128, open). A blocked production has exactly two legitimate paths: fix the substance (reopen to an editable gate), or `force_forward`, which IS logged. The approval log is the artefact protecting these channels under YouTube's inauthentic-content policy.",
  "4. **An empty singular `imagePrompt` on an authored production renders a mock-media placeholder SVG, silently** (#122). Always set the singular `imagePrompt` as a real fallback; `shotPlan.perBeat[].singularPromptEmpty` reports when it is missing.",
  "",
  "### The reopen cascade — downstream of the reopened stage is ALWAYS stale",
  "",
  "| Reopen at | Discards | Keeps |",
  "|---|---|---|",
  "| `voiceover` (`clean`/`rebuild`) | the assembled track, all images, the render | **the script, ALL recorded takes, the music bed, the thumbnail** |",
  "| `voiceover` (`reopen`/`keep`) | images, the render | the script, the takes, and the (possibly broken) existing track |",
  "| `visuals` (`clean`/`rebuild`) | all images, the render | the script, the **voiceover** |",
  "| `visuals` (`reopen`/`keep`) | the render | the script, the voiceover, the existing images |",
  "",
  "**Recorded operator takes are ALWAYS kept, in either mode** — they are stored per segment under their own keys. Reopening the voiceover never costs a re-record; only a narration EDIT does.",
  "",
  "Reopening is reversible with `cancel_reopen` **until the stage actually re-runs**; after that the discarded artifacts are gone. And `applied: true` does NOT mean the new gate exists yet — confirm with **`list_gates`**, not `get_production` (which reads `reopen: null` in between). Expect a minute or two of lag.",
  "",
  "### edit_script_beats — when it is allowed, and what it costs",
  "",
  "Only while a `script_review` **or** `voiceover_recording` gate is PENDING. Past that window it refuses, and `reopen_stage('voiceover')` is the way back.",
  "",
  "| Change | Effect |",
  "|---|---|",
  "| `imagePrompt` / `imagePrompts` only | free; `narrationChanged: false`; nothing re-billed |",
  "| `text` on a beat with **no** takes | free; segments recut |",
  "| `text` on a beat **with recorded takes** | **REFUSED** unless `invalidateTakes: true` — which DELETES those takes and needs a re-record. Only the edited beats' takes are affected |",
  "",
  "### Verify BEFORE generating, not after",
  "",
  "Images are cut from the voiceover's word timestamps, so generating before the audio is right wastes the whole stage. Check `get_production().voiceover` first:",
  "",
  "| Field | Must read |",
  "|---|---|",
  "| `assembledPieces` | == `segmentCount` == `takesRecorded` |",
  "| `assembledFromCurrentScript` | `true` |",
  "| `alignment.tts` | `0` on an operator-narrated channel — anything else is the synthetic voice, not the operator |",
  "| `alignment.whisper + estimated + tts` | == `pieces` |",
  "| `assembledDurationSec` | within a few percent of `expectedDurationSec` |",
  "",
  "Any mismatch → `reopen_stage('voiceover', mode:'clean')` and re-assemble BEFORE touching visuals. Also spot-check one shot's `narration` (`get_production_shots`) against `get_script`: if they differ, the plan was cut from a superseded script and every downstream image is misaligned. One free call; it would have saved two full regeneration cycles.",
  "",
  "### Shot planning — supply prompts 1:1, no more",
  "",
  "`imagePrompts[]` should match the beat's shot count EXACTLY. Surplus prompts are dropped from the trailing end (wasted authoring, not wasted money); **under-supply is the dangerous direction** — an uncovered shot falls back to the singular `imagePrompt`, and if that is empty it renders a placeholder (#122).",
  "",
  "**Beat count is the binding constraint, not `minSecondsPerShot`.** At `imageDensity: busy` the cap is `beats x 4`, so a 5-beat map yields 9-12 shots however low the floor is set — more shots means MORE BEATS. Run `author_script` once, read `perBeat[].shots`, then supply exactly that many prompts per beat.",
  "",
  "### Word budgets — compute, never estimate",
  "",
  "`words = targetLengthSec / ( 1/wordsPerSec + gapSec/wordsPerSegment )`. Read `readRate` from `get_channel_config` — do not hand-calculate it. Measured segment lengths: Shorts ~17 words, long-form ~20. `author_script`'s `shotPlan.durationBasisSec` is computed at a stale 2.5 w/s (#121, open) and is NOT the check; verify with `wordCount / readRate.wordsPerSec + segmentCount x readRate.segmentGapSec`.",
  "",
  "### Never",
  "",
  "- Clear a gate, or flip `autoApproveVisuals` / `autoApproveFinal`, to get past a review.",
  "- Use `continue_production` to pass a compliance block (#128).",
  "- Retry a generation call that timed out — `regenerate_shot` and `regenerate_thumbnail` can bill while the HTTP response times out. Check `list_thumbnails` / `get_production_shot` / `get_job` instead.",
  "- Approve a gate on the operator's behalf. Gate approval is a human cockpit action and is not an MCP tool at all.",
  "",
  "### Every state-changing tool",
  "",
  "Generated from the tool registry — a tool that mutates state and is missing from this table fails the build, so this list cannot silently fall behind the platform.",
  "",
  renderTables(),
  "These prompt for approval but write nothing (an allowlist gap, not a risk): " +
    Object.entries(NON_MUTATING_UNLISTED)
      .map(([tool, why]) => `\`${tool}\` (${why.split(" — ")[0]})`)
      .join(", ") +
    ".",
].join("\n");

/**
 * Audit: every registered tool must be either documented in ACTION_CONSEQUENCES
 * or declared non-mutating. Pure, so it runs both in `get_guide`'s self-audit and
 * in the CI script. `missing` = a mutating tool with no consequences row (the
 * thing that must never ship); `unknown` = a row for a tool that no longer
 * exists (a rename that left the table behind).
 */
export function auditActionCoverage(
  registeredTools: readonly string[],
  readOnlyTools: ReadonlySet<string>,
): { ok: boolean; missing: string[]; unknown: string[] } {
  const documented = new Set(ACTION_CONSEQUENCES.map((a) => a.tool));
  const registered = new Set(registeredTools);
  const missing = registeredTools.filter(
    (t) => !readOnlyTools.has(t) && !documented.has(t) && !(t in NON_MUTATING_UNLISTED),
  );
  const unknown = [
    ...ACTION_CONSEQUENCES.map((a) => a.tool),
    ...Object.keys(NON_MUTATING_UNLISTED),
  ].filter((t) => !registered.has(t));
  return { ok: missing.length === 0 && unknown.length === 0, missing, unknown };
}
