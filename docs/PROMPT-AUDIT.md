# Prompt & LLM-Usage Audit — 2026-07-11

A deep audit of every LLM/generative-media prompt in the platform: where each
lives, what it produces, and where the output quality is being left on the
table. Written to drive a prompt-improvement batch + smoke tests (see §6).

Companion doc: operator-supplied "humanize" prompt patterns are folded into
§4.2 and §5.1.

---

## 1. How LLM calls are wired (the shared mechanics)

- **Dispatch**: every agent call goes through `runAgent(name, tier, ctx, summary, fn)`
  (`packages/agents/src/run-agent.ts`) — resolves the tier's model, times the
  call, writes an `agent_actions` audit row + cost line. **Single-shot: no
  retries, no self-critique in the helper.** Retries exist only at the Inngest
  step level (re-runs the whole step).
- **Structured output**: 25 of 26 call sites use `generateObject` with a Zod
  schema (+ `repairDoubleEncodedJson`). The one exception is the control-plane
  assistant (`generateText` + 18 tools, max 5 steps).
- **Sampling**: **no temperature / top_p / maxTokens set anywhere** — every
  call runs at provider defaults, creative and judge tasks alike.
- **Tier routing** (`packages/providers/src/real/llm.ts:188`): first resolvable wins —
  - `cheap`: `google:gemini-2.5-flash-lite` → … → `anthropic:claude-haiku-4-5`
  - `agentic`: `qwen:qwen-max` → … → `anthropic:claude-sonnet-5`
  - `frontier`: `qwen:qwen-max` → … → `anthropic:claude-opus-4-8`
  - Per-tier env override `LLM_MODEL_<TIER>`; per-account override on `/account`.
- **Non-Anthropic schema shim**: `schemaCompat` strips unsupported JSON-schema
  bounds into description hints and forces Qwen to `json_object` mode.

## 2. Full prompt inventory (26 call sites, 32 TASK markers)

### 2.1 The production chain (quality-critical path)

| # | Agent | File:line | Tier | Purpose | Output |
|---|-------|-----------|------|---------|--------|
| 1 | `ideation` | `agents/src/ideation.ts:59` | cheap | DNA + research feed + pattern store → 3–10 idea rows | `{title, angle}[]` |
| 2 | `trend_scanner` | `agents/src/trend.ts:33` | cheap | Rising outliers → ≤3 fast-lane ideas | suggestions |
| 3 | `scoring` | `agents/src/scoring.ts:52` | agentic | 7-axis rubric (demand, saturation, RPM…) per idea | per-axis `{score, rationale}` |
| 4 | `hook_picker` | `agents/src/hooks.ts:45` | cheap | Pick best hook template for the idea | `{templateId, reason}` |
| 5 | `hook_ingest` | `agents/src/hooks.ts:77` | agentic | Abstract outlier videos → content-free hook skeletons | templates |
| 6 | `scriptwriter` | `agents/src/scriptwriter.ts:153` | frontier | Idea + DNA + verified facts + hook skeleton → full narration, per-beat imagePrompts, fingerprint | `scriptOutputSchema` |
| 7 | `factuality_proof` | `agents/src/factuality-proof.ts:21` | agentic | Audit draft vs VERIFIED FACTS before asset spend; drives ≤2 rewrite loop | unsupported claims |
| 8 | `image_fit_scorer` | `agents/src/image-score.ts:30` | cheap (vision) | Does the sourced Wikimedia photo fit this shot? keep ≥5/10 | `{fits, score, reason}` |
| 9 | `variation_judge` | `agents/src/similarity-judge.ts:15` | cheap | Borderline-Jaccard fingerprint pairs: same substance? | `{similar, reason}` |
| 10 | review board ×4 | `agents/src/review-board.ts` | agentic | compliance / charter alignment / platform safety / quality (predicts retention %) | pass/fail + reason |
| 11 | `thumbnail_scorer` | `agents/src/thumbnail.ts:14` | cheap | Predicted CTR from the candidate's *text description* (not pixels) | `{predictedCtr, critique}` |

### 2.2 Editorial engine (research → brief)

| # | Agent | File:line | Tier | Purpose |
|---|-------|-----------|------|---------|
| 12 | `charter_proposal` | `editorial/charter.ts:63` | frontier | Niche+intent → channel charter |
| 13 | `identity_proposal` | `editorial/charter.ts:105` | frontier | 3 channel identity options |
| 14 | `series_planner` | `editorial/planner.ts:20` | frontier | Charter + state → ordered episode arc |
| 15 | `source_discovery` | `editorial/research.ts:27` | agentic | Topic → authoritative fetchable sources (legacy path; Tavily preferred) |
| 16 | `claim_extraction` | `editorial/research.ts:50` | agentic | Evidence → atomic tiered claims (established/emerging/contested) |
| 17 | `claim_verification` | `editorial/research.ts:71` | agentic | ONE claim vs ONE passage, quote required; fan-out per candidate |
| 18 | `episode_brief` | `editorial/research.ts:99` | frontier | Surviving claims → episode brief, claim ids cited |
| 19 | `wizard_assistant` | `editorial/wizard-assistant.ts:79` | agentic | Conversational wizard co-pilot, returns `reply` + form `patch` |

### 2.3 Analysis / memory / ops

| # | Agent | File:line | Tier | Purpose |
|---|-------|-----------|------|---------|
| 20 | `hook_analysis` | `agents/src/analysis.ts:115` | agentic | Published hook vs retention curve |
| 21 | `script_analysis` | `agents/src/analysis.ts:145` | agentic | Beat-by-beat vs retention curve, one trim suggestion |
| 22 | `meta_hook` / `meta_script` / `meta_topics` | `agents/src/meta-analysis.ts` | cheap | Competitor transcripts → pattern store (shape only) |
| 23 | `briefing_compose` / `experiment_conclude` | `editorial/briefing.ts` | agentic | Operator check-in; experiment narration (verdict precomputed) |
| 24 | `coverage_summary` / `memory_scope` | `editorial/postpublish.ts` | cheap | Transcript compression; memory promotion |
| 25 | `control` | `agents/src/control.ts:329` | agentic | NL control plane, 18 tools, ≤5 steps, free text |

### 2.4 Generative media (non-LLM prompt consumers)

| Surface | File:line | What is sent |
|---------|-----------|--------------|
| fal image gen | `providers/src/real/media.ts:22` | `{prompt, image_size, num_images:1}` to `FAL_IMAGE_MODEL ?? fal-ai/flux/schnell` — **raw pass-through, no style layer, no negative prompt** |
| Beat image prompts | authored BY the scriptwriter (schema field `beats[].imagePrompt`), steered only by one `IMAGE STYLE:` line from `dna.visualStyle.imageStyle`; sub-shots append the sentence text (`core/src/shots.ts:135`) |
| Thumbnails | `production-pipeline.ts:911` | the ONLY in-code image prompt assembly: `"{label}, {style}: {title}. {thumbnailSpec…}"` ×2 candidates |
| Wikimedia reference | `providers/src/real/reference-images.ts` | entity string → Wikipedia lead image → Commons file search (PD/CC0/CC-BY only) |
| ElevenLabs TTS | `providers/src/real/voice.ts:49` | **raw `script.fullText`, zero preprocessing**; `delivery` axis → stability/style settings; model `eleven_turbo_v2_5` default |
| Text-to-video | — | **does not exist** (`MediaProvider` has no `generateVideo`; `motion`/`ai_video` axes are inert scaffolds — BACKLOG #6 Higgsfield) |

## 3. What's already good

- **Decomposition** is genuinely strong: research → atomic claims → per-claim
  verification with quoted evidence → brief with claim ids → fact-constrained
  script → factuality proof → review board. This is a proper pipeline, not one
  mega-prompt.
- **Cost/audit discipline**: every call lands an `agent_actions` row + cost line.
- **Deterministic guardrails where they belong**: score clamping, Jaccard
  pre-filter before the LLM similarity judge, precomputed experiment verdicts,
  code-computed beat durations.
- **Fail-safe defaults**: image-fit errors keep the image; verification errors
  cut the episode rather than publish unverified.

## 4. Systemic issues (ranked by expected output impact)

### 4.1 Prose is written inside `generateObject` (the "schema tax")
The scriptwriter emits narration + imagePrompts + fingerprint in ONE structured
call. Models measurably flatten prose when simultaneously satisfying a JSON
schema — attention splits between "sound like a person" and "be valid JSON".
Worst on Qwen in `json_object` mode (the current default frontier route).
**Fix direction**: two-call split — (a) free-text narration draft (system prompt
optimised purely for spoken-word quality), (b) cheap structuring call that cuts
the approved prose into beats + writes imagePrompts. The prose call can also be
`generateText` with a light markdown convention instead of JSON.

### 4.2 No humanize/anti-AI-tell pass exists
The only rewrite loops are mechanical (length, factuality). Nothing addresses
AI tells: uniform sentence rhythm, neutral pleasing tone, overbuilt phrasing,
"not X but Y" constructions, em-dash chains. The operator-supplied patterns
(IG @airesearches) are exactly the missing seam — an **editor pass** between
draft and factuality proof:

1. *Real Person Rewrite* — editor persona, "the way someone who actually lived
   it would say it: rougher, more direct; cut anything rehearsed/overbuilt".
2. *Thought Flow Fix* — "ideas move the way a real mind moves: uneven, punchy
   in places, slower in others; break even pacing".
3. *Pattern Disruptor* — "spot the tells that expose AI writing, strip them one
   by one; every word chosen in the moment".
4. *Voice Shaper* — "one real person's voice, clear POV, not a neutral observer
   pleasing everyone; let opinions and small contradictions through".
5. *Make It Hit* — "cut anything flat, calculated, forgettable".
6. *Credibility Test* — "a reader who distrusts writing that's too clean;
   sentence by sentence, like something said out loud".

**Constraint unique to this pipeline**: the humanize pass must not invent facts
on gated channels — so it runs BEFORE `proveScriptFactuality` (which already
exists and catches drift), with its own "you may not add any factual claim,
number, name, date or event" clause. Cost: one extra agentic-tier call.

### 4.3 Persona is a one-liner, not a voice
Voice = `TONE: punchy, curious, plain language` + one audience line. Best
practice for consistent multi-episode voice: a persona block (who is speaking,
what they care about, what they'd never say) + 2–3 few-shot exemplar passages
of the target voice, stored per channel and versioned. The DNA already has the
storage shape (`channel_dna`); it just doesn't carry exemplars. The `delivery`
axis changes ElevenLabs settings but nothing tells the WRITER the delivery is
"dramatic" vs "measured" — the axes should steer the text too.

### 4.4 Image prompting has no dedicated author, no style system
- `beat.imagePrompt` is written by the scriptwriter as a side-effect, steered by
  ONE style string; sub-shots just append the spoken sentence (`shots.ts:135`),
  which produces literal, text-artifact-prone prompts.
- `profile.artDirection` (the operator's 800-char art-direction field!) **is
  never read by anything** — confirmed dead-end scaffold.
- The fal layer adds nothing: no style prefix/suffix, no negative prompt, no
  consistency tokens across a video's set, default `flux/schnell` (speed tier).
**Fix direction**: a dedicated image-prompt builder step (cheap tier) that takes
shot text + entity + style + artDirection + orientation and emits a structured
prompt following BFL's official ordering — subject first → action → style →
context → **lighting (BFL: the single biggest quality lever)** → technical
(camera/lens/film stock for archival realism) — with a repeated `Style:/Mood:`
suffix block across the whole video's set (BFL's official cross-image
consistency mechanism). **No negative prompts**: FLUX doesn't support them and
naming the unwanted element makes it appear — exclusions must be rewritten as
positive descriptions ("clean unmarked metal skin" not "no watermarks/text").
This builder is also the natural seam for the future video-prompt builder (#6) —
same builder, motion/camera fields added.

### 4.5 One default temperature for everything
Judges (claim verification, similarity, compliance, image fit) want ~0–0.3;
creative generation (script, ideas, identity) wants ~0.8–1.0. Setting none
means the creative calls are less diverse than they could be AND the judges
less consistent than they should be. Cheap fix: add an optional `temperature`
to `runAgent`/call sites with a per-task policy.

### 4.6 TTS gets raw text
No pause/emphasis markup, no number normalization ("1,200 mph" read as
digits?), no paragraph breaks → ElevenLabs prosody is flat on long passages.
`eleven_turbo_v2_5` default while long-form quality work found v3's 5k-char cap
— per-format model choice + light SSML-ish preprocessing (break tags at beat
boundaries) is available for free.

### 4.7 Smaller per-prompt issues
- `scriptwriter` expand loop: "restate the stakes" invites the repetition the
  same prompt forbids; expansion should ask for NEW angles on the same facts
  (mechanism walk-through, contrast, scene-setting) — never "restate".
- `board_quality` predicts a retention % from text alone — pseudo-precision;
  better as a rubric grade (hook strength / pacing / payoff) with pass bar.
- `thumbnail_scorer` scores a text description, never the pixels — the vision
  tier used by `image_fit_scorer` works here unchanged.
- `scoring` rubric has no calibration anchors (what does demand=7 mean?) —
  add 2 worked examples per axis or a short anchor scale in the system prompt.
- `hook→stat→insight→cta` beat enum forces every video into a listicle shape;
  long-form especially needs `story/context/reveal/escalation` beat types.
- `ideation` (cheap tier) writes the titles that everything downstream
  elaborates — worth agentic tier + a "write titles as a viewer's curiosity,
  not a description" instruction.
- `charter` targets are hardcoded numeric blocks — fine, but they leak into
  every proposal identically.

## 5. Recommendations (grounded in the deep-research report)

Deep research ran 2026-07-11 (106-agent fan-out over primary sources with 3-vote
adversarial verification; 12 findings survived, all high-confidence 3-0 votes).
What survived, applied to this codebase:

**Verified findings that shape the recommendations**
- *Multi-pass draft → review-against-criteria → refine, each a separate API
  call, is Anthropic's canonical chaining pattern for quality-critical
  generation* — direct endorsement of the humanize/editor pass. But the same
  docs warn: on 2026 models, add a discrete stage only when you need to
  inspect/gate the intermediate output, not for reasoning capacity.
- *Persona belongs in the system prompt* (Anthropic: even one sentence of role
  focuses tone; OpenAI: developer message = the function, user message = its
  arguments; order Identity → Instructions → Examples → Context). Today the
  scriptwriter's TONE/AUDIENCE live in the **user** prompt and the system
  prompt is task mechanics — backwards relative to both vendors' guidance.
- *CoT-before-structured-emission is an official OpenAI schema pattern*
  (a `steps[]` reasoning array before the final field) — cheap way to get
  think-then-emit inside `generateObject` without a second call.
- *Schema adherence 2026*: newer models conform to complex schemas when simply
  instructed, especially with retries; but strict/native modes do NOT remove
  the need for validation + retry handling (refusals, truncation, value-level
  errors) — keep `repairDoubleEncodedJson` + Inngest retries.
- *Tier routing is vendor-endorsed*, with a corollary we violate: **cheap-tier
  models need MORE explicit, prescriptive instructions** — our cheap-tier
  prompts (ideation, hook pick, meta-analysis) are currently the tersest.
- *FLUX*: subject-first ordering (early tokens weighted most); natural-language
  prose, not tag soup; explicit lighting clause in every prompt (biggest
  quality lever per BFL); camera/lens/film-stock + era descriptors for
  archival realism ("35mm Kodak film photograph, natural grain" beats
  "professional photo"); quotation marks only for text you WANT rendered
  (1–5 words); repeated `Style:/Mood:` suffix for set consistency; **no
  negative prompts — rewrite exclusions positively**.

**Verified gaps (don't over-trust here)**
- Nothing survived verification on text-to-video prompting (Kling/Runway/Veo/
  Higgsfield) — revisit with vendor docs when #6 is built.
- No published empirical evidence linking script style to retention survived —
  the humanize direction rests on vendor architecture guidance + operator
  judgment, so **measure it ourselves** (§6).
- Whether JSON-constrained emission degrades prose ("schema tax") is an open
  question in the literature — our two-call split in 5.1(2) is a hypothesis to
  A/B, with the CoT-field-in-schema pattern as the cheaper verified fallback.

### 5.1 New pipeline seams (ordered by impact/cost)
1. **Humanize/editor pass** after draft, before factuality proof (§4.2) — one
   agentic call, fact-constrained, using a merged version of the six operator
   patterns. Re-run `proveScriptFactuality` after it (already exists). This is
   the vendor-canonical self-correction chain.
2. **Persona-in-system-prompt restructure** (§4.3) — move voice/persona/DNA to
   the system prompt (Identity → Instructions → Examples → Context order),
   keep per-episode facts/brief in the user prompt; add per-channel exemplar
   passages to DNA.
3. **Image-prompt builder step** (§4.4) — per-shot structured prompts
   (subject-first, lighting clause, film-stock realism, Style/Mood suffix);
   wire `profile.artDirection`; positive-only exclusions; evaluate `flux/dev`
   vs `schnell` for hero shots vs filler.
4. **Prose-first drafting A/B** (§4.1) — split narration writing from
   structuring; fallback: add a leading `reasoning`/`voiceNotes` field to
   `scriptOutputSchema` (verified CoT-in-schema pattern).
5. **Temperature policy** (§4.5) — per-task sampling params via `runAgent`.
6. **Explicit-ify cheap-tier prompts** — ideation/hook-pick/meta prompts get
   prescriptive step-by-step instructions (cheap models need them).
7. **TTS preprocessing** (§4.6).

### 5.2 Creative-latitude principle (operator ask)
Prompts currently either hard-template (hook skeleton, CTA line, image style)
or leave everything implicit. The better pattern: **defaults with declared
freedom** — state the template, then explicitly grant the model authority to
deviate when the story demands it, with a required `deviations` field
explaining any departure (auditable latitude instead of silent compliance or
silent drift). Apply to: hook skeleton, beat types, image prompts (scene choice
free, style fixed), CTA phrasing.

## 6. Smoke-test plan (after changes land)

Mock-mode (free, CI-able):
- Pipeline still e2e-green with new steps (`PROVIDERS_FORCE_MOCK=1`).
- Schema round-trips for new fields (deviations, humanize output).

Real-provider A/B (one channel, n≥4 scripts):
1. Same idea + facts → current prompt vs new chain; blind read-aloud test +
   AI-tell count (em-dash chains, "isn't just", uniform sentence length var).
2. Image set: current single-string prompts vs builder output — judge subject
   accuracy, text artifacts, style consistency across the set (image-fit scorer
   gives a free numeric proxy).
3. Cost/latency delta per production (agent_actions makes this queryable).
4. Board quality + factuality pass-rates unchanged or better.

## 7. Sources (all verified live 2026-07-11)

- Anthropic prompting best practices — platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- Anthropic prompt chaining — docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/chain-prompts
- OpenAI prompt engineering + reasoning best practices — developers.openai.com/api/docs/guides/prompt-engineering, …/reasoning-best-practices
- OpenAI structured outputs (CoT schema pattern) — developers.openai.com/api/docs/guides/structured-outputs
- BFL FLUX prompting guides — docs.bfl.ai/guides/prompting_summary, …/prompting_guide_flux2, …/usecases_t2i_photorealistic
- BFL official skills repo — github.com/black-forest-labs/skills
- fal.ai FLUX guide — fal.ai/learn/tools/how-to-use-flux

Full verified-findings dump (incl. refuted claims + open questions):
`docs/research/prompting-best-practices-2026.md`.

---
*Generated 2026-07-11. Inventory verified against `main`@99666a8.*
