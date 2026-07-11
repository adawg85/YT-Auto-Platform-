SUMMARY:
Primary-source guidance from Anthropic, OpenAI, Black Forest Labs, and fal.ai converges on a clear architecture for an automated faceless-YouTube pipeline: put persona/voice in the system (developer) prompt and per-episode content in user messages; use explicit multi-pass draft-critique-refine chains only where you need to inspect or gate intermediate outputs, since 2026-era frontier models handle most multi-step reasoning internally; and get JSON adherence via dedicated Structured Outputs features or plain instruction-plus-retries (prefill hacks are now hard-removed on Claude 4.6+), optionally embedding a reasoning-steps array before the final answer field so the model thinks before emitting structure. OpenAI explicitly endorses per-task model-tier routing (reasoning/frontier models for complex planning, cheap fast models with more explicit instructions for execution). For FLUX imagery (the fal.ai-hosted family), the rules are: natural-language prose ordered subject-first (early tokens are weighted most), no negative prompts (rewrite exclusions positively), exact text in quotation marks kept to 1-5 words, camera/lens/film-stock and era descriptors for photorealistic/archival looks, explicit lighting (called the single biggest quality lever), and appended Style/Mood tags repeated across every prompt for cross-image consistency within a video. Notably, no claims survived verification for text-to-video prompting (Kling/Runway/Veo/Higgsfield) or for creator-economy retention-vs-script-style evidence, so those areas remain guided by vendor docs not yet verified here.

### Multi-pass self-correction chains (draft -> review against criteria -> refine, each as a separate API call) are Anthropic's canonical chaining pattern for quality-critical generation, directly endorsing draft->humanize->critique loops for script pipelines when you need to log, evaluate, or branch on intermediate outputs.
[high | 3-0 (x2, merged duplicates)]
Verified verbatim on Anthropic's live 2026 docs (covers Claude Fable 5 / Opus 4.8 / Sonnet 5): "The most common chaining pattern is self-correction: generate a draft -> have Claude review it against criteria -> have Claude refine based on the review. Each step is a separate API call so you can log, evaluate, or branch at any point." Merged claims [0] and [3], both 3-0.
SOURCES: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices ; https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/chain-prompts

### On current (2026) Claude models, explicit prompt chaining is no longer required for most multi-step reasoning — adaptive thinking and subagent orchestration handle it internally — so a pipeline should justify each discrete stage by the need to inspect intermediate outputs or enforce structure, not by reasoning capacity. Single-pass generation is viable more often than legacy multi-stage designs assume.
[high | 3-0]
Verbatim on the live Anthropic docs: "With adaptive thinking and subagent orchestration, Claude handles most multi-step reasoning internally. Explicit prompt chaining ... is still useful when you need to inspect intermediate outputs or enforce a specific pipeline structure." Corroborated by Wharton 2025 Prompting Science Report finding CoT prompting adds negligible benefit on reasoning models. Claim [4], 3-0.
SOURCES: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/chain-prompts

### Persona/voice definition belongs in the system (developer) prompt and per-request content in user messages: Anthropic says even a one-sentence role assignment in the system prompt focuses behavior and tone; OpenAI says developer messages take priority over user messages and should be treated like a function versus its arguments; OpenAI further recommends ordering the developer message as Identity, Instructions, Examples, Context — persona first, retrieved context last. For episode-to-episode voice consistency, keep a stable persona block in the system prompt.
[high | 3-0 (x3, merged group)]
All three quotes verified verbatim on live vendor docs: Anthropic "Setting a role in the system prompt focuses Claude's behavior and tone ... Even a single sentence makes a difference"; OpenAI "developer messages ... prioritized ahead of user messages" and the function/arguments analogy; OpenAI section ordering "Identity, Instructions, Examples, Context ... usually in this order." Verifiers note persona improves tone/behavior control, not factual accuracy (EMNLP 2024), and OpenAI hedges the ordering with 'usually'. Merged claims [2], [6], [7], each 3-0.
SOURCES: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices ; https://developers.openai.com/api/docs/guides/prompt-engineering

### For JSON schema adherence in 2026: use the provider's dedicated Structured Outputs feature or simply instruct the model to conform (newer models reliably match complex schemas when told to, especially with retries). Prefill tricks are dead — last-assistant-turn prefills return a 400 error on Claude 4.6+ models. With OpenAI Structured Outputs enabled, strongly worded formatting instructions are no longer needed, freeing prompt space for content/prose quality instructions.
[high | 3-0 (x3, merged group); companion over-claim refuted 0-3]
Anthropic (verbatim): "Try asking the model to conform to your output structure first, as newer models can reliably match complex schemas when told to, especially if implemented with retries" plus "prefilled responses ... on the last assistant turn are no longer supported. Requests ... return a 400 error." OpenAI (verbatim): "Simpler prompting: No need for strongly worded prompts to achieve consistent formatting." Important limit: the stronger claim that strict mode removes all need for validation/retries was REFUTED 0-3 — safety refusals, max-token truncation, and value-level errors still require pipeline handling. Merged claims [1], [5], [9], each 3-0.
SOURCES: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices ; https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/chain-prompts ; https://developers.openai.com/api/docs/guides/structured-outputs

### Chain-of-thought-before-structured-emission is officially endorsed by OpenAI as a schema pattern: define an array of reasoning steps (each with explanation/output fields) followed by a final_answer field, so the model reasons step-by-step inside the structured output before committing to the final result — a direct template for 'think, then emit' in a pipeline's structured stages.
[high | 3-0]
The OpenAI structured-outputs guide has a dedicated "Chain of thought" section with the exact schema: Step = { explanation, output }; MathReasoning = { steps: array(Step), final_answer: string }, introduced with "You can ask the model to output an answer in a structured, step-by-step way." Claim [10], 3-0. Minor gloss: the doc frames it as guiding the user through the solution; steps-before-answer ordering is what produces reason-first behavior.
SOURCES: https://developers.openai.com/api/docs/guides/structured-outputs

### Per-task model-tier routing (frontier/reasoning models for complex planning and quality-critical steps, cheap fast models for mechanical execution) is explicitly endorsed by OpenAI: reasoning models excel at complex multi-step tasks but are slower and more expensive; non-reasoning GPT models are fast and cost-efficient but require more explicit instructions. OpenAI's companion guide states most AI workflows use a combination of both.
[high | 3-0]
Verified verbatim: "Reasoning models generate an internal chain of thought ... excel at understanding complex tasks and multi-step planning ... generally slower and more expensive"; "GPT models are fast, cost-efficient ... but benefit from more explicit instructions." Companion guide: "Most AI workflows will use a combination of both models." Claim [8], 3-0. Practical implication: cheap-tier prompts need more explicit, prescriptive instructions than frontier-tier prompts.
SOURCES: https://developers.openai.com/api/docs/guides/prompt-engineering ; https://developers.openai.com/api/docs/guides/reasoning-best-practices

### FLUX prompt ordering: put the subject first — FLUX weights earlier tokens more heavily and may deprioritize a subject buried at the end. BFL's official recommended structure is [Subject] + [Action] + [Style] + [Context] + [Lighting] + [Technical] (docs variant: subject, location, style, camera settings, lighting, colors, effects, additional elements), explicitly framed as a flexible starting structure, not a strict formula.
[high | 3-0 (x3, merged group)]
BFL FLUX.2 guide (verbatim): "Word order matters - FLUX.2 pays more attention to what comes first" with priority "Main subject -> Key action -> Critical style -> Essential context -> Secondary details"; fal.ai: "If you bury the subject at the end of a long description, FLUX may deprioritize it"; BFL skills repo: "[Subject] + [Action] + [Style] + [Context] + [Lighting] + [Technical]". BFL frames it as "a prompt-building aid, not a rule." Merged claims [11], [16], [18], each 3-0. Note: token-position weighting is a behavioral heuristic, not a documented architectural mechanism.
SOURCES: https://docs.bfl.ai/guides/prompting_summary ; https://fal.ai/learn/tools/how-to-use-flux ; https://github.com/black-forest-labs/skills

### FLUX models do not support negative prompts, and negation inside the positive prompt backfires — naming the unwanted element ('a person without glasses') makes the model generate it. The official remedy is to rewrite exclusions as positive descriptions of what should fill that space ('If this thing wasn't there, what would I see instead?'). This directly contradicts SDXL-era negative-prompt workflows and should shape any shared prompt-template code.
[high | 3-0 (x2, merged); over-strong variant refuted 0-3]
BFL docs (verbatim): "FLUX models don't support negative prompts ... the model focuses on the word 'glasses' and often generates exactly what you're trying to avoid"; skills repo: "NO negative prompts — FLUX doesn't support them; describe what you want." Architectural reason (fal.ai corroboration): FLUX dev/schnell are guidance-distilled to CFG=1. Merged claims [12], [19], each 3-0. Caveat: a stronger variant claiming the API errors on negative_prompt was refuted 0-3; unofficial true-CFG ComfyUI workarounds exist on FLUX.1 dev.
SOURCES: https://docs.bfl.ai/guides/prompting_summary ; https://github.com/black-forest-labs/skills

### To render legible text in FLUX images without garbled artifacts: put the exact desired wording in quotation marks (a stronger signal to render literal text), keep it short (1-5 words most reliable), match capitalization (ALL CAPS in prompt yields ALL CAPS in image), simplify the background behind the text, and specify typography/colors explicitly — including hex codes (#RRGGBB) alongside color names for exact color reproduction.
[high | 3-0 (x3, merged group)]
BFL docs (verbatim): "Quotation marks help separate written content from the rest of the scene, which gives FLUX a stronger signal to render the words as text"; fal.ai: "Always use quotation marks around the exact text you want", "Shorter text renders more accurately", "ALL CAPS in the prompt produces ALL CAPS in the image", clean backgrounds help; BFL skills repo: "Quote text — use quotation marks for typography ... Hex colors — use #RRGGBB format with color names." Merged claims [13], [17], [21], each 3-0.
SOURCES: https://docs.bfl.ai/guides/prompting_summary ; https://fal.ai/learn/tools/how-to-use-flux ; https://github.com/black-forest-labs/skills

### For photorealistic and archival/vintage imagery (key for historical faceless channels), BFL instructs naming specific camera models, lenses, and film stocks ('Shot on Kodak Portra 400, natural grain, organic colors'; 'Shot on Fujifilm X-T5, 35mm f/1.4' beats 'professional photo'), and evoking eras with period descriptors like 'film grain, warm color cast, soft focus, 80s vintage photo' or 'early digital camera, slight noise, flash photography, 2000s digicam style'.
[high | 3-0]
Verified verbatim in BFL's FLUX.2 prompting guide including the vintage style table and Kodak Portra 400 example; companion photorealistic use-case page reinforces: "prompt the model as if describing a real photograph: specify lens, lighting, framing, and texture details", "35mm Kodak film aerial photograph, underexposed and richly grainy". Claim [14], 3-0.
SOURCES: https://docs.bfl.ai/guides/prompting_summary ; https://docs.bfl.ai/guides/prompting_guide_flux2 ; https://docs.bfl.ai/guides/usecases_t2i_photorealistic

### For consistent aesthetics across a set of images in one video, BFL recommends appending explicit style/mood tags at the end of every prompt (e.g. '[Scene]. Style: ... Mood: ...') — a repeatable suffix block is the official consistency mechanism. Prompt-length tolerance varies by variant: FLUX.2 [pro]/[max]/[flex] automatically upsample short prompts with added visual detail, while FLUX.2 [klein] renders literally ('what you write is what you get') and requires fully descriptive prompts.
[high | 3-0]
Verbatim on BFL unified guide sub-pages: "Add explicit tags at the end of your prompt for consistent aesthetics" with example "Style: Country chic meets luxury lifestyle editorial. Mood: Serene, romantic, grounded"; "On FLUX.2 [klein], what you write is what you get — be descriptive"; pro/max/flex "automatically enhance short prompts by adding visual detail and context while preserving your original intent" (prompt upsampling). Claim [15], 3-0.
SOURCES: https://docs.bfl.ai/guides/prompting_summary ; https://docs.bfl.ml/guides/prompting_unified_style.md ; https://docs.bfl.ml/guides/prompting_unified_technical.md

### FLUX responds best to natural-language prose (not keyword/tag soup) with high specificity, and BFL identifies lighting specification as the single factor with the biggest quality impact — so pipeline image prompts should be generated as descriptive sentences with an explicit lighting clause in every prompt.
[high | 3-0]
BFL official skills repo Core Rules (verbatim): "Be specific - Vague prompts produce mediocre results; Use natural language - Prose/narrative style works best; Specify lighting - Lighting has the biggest impact on quality." Corroborated by BFL's docs.bfl.ml FLUX.2 guide (prose-over-keyword guidance, extensive lighting section). Claim [20], 3-0. The 'biggest impact' superlative is attributed specifically to the skills repo.
SOURCES: https://github.com/black-forest-labs/skills ; https://docs.bfl.ai/guides/prompting_guide_flux2


== REFUTED ==
[
 {
  "claim": "OpenAI's Structured Outputs feature, when strict mode is enabled, guarantees that model responses conform to a supplied JSON Schema, removing the need to validate or retry malformed responses in a pipeline.",
  "vote": "0-3",
  "source": "https://developers.openai.com/api/docs/guides/structured-outputs"
 },
 {
  "claim": "FLUX does not support negative prompts: its guidance-distilled architecture errors if a negative_prompt parameter is passed, so undesired elements must be handled with positive phrasing (describe what you want, not what to avoid).",
  "vote": "0-3",
  "source": "https://fal.ai/learn/tools/how-to-use-flux"
 },
 {
  "claim": "The optimal FLUX prompt length is roughly 40-50 words; prompts under ~10 words trigger internal expansion from training data, and prompts over ~200 words are internally summarized with possible loss of detail.",
  "vote": "1-2",
  "source": "https://fal.ai/learn/tools/how-to-use-flux"
 }
]
== CAVEATS ==
"Coverage gaps are the biggest caveat: NO claims survived verification for research area (3) — text-to-video/image-to-video prompting (Kling, Higgsfield, Runway, Veo motion/camera language and duration limits) — nor for the retention-focused half of area (1): no published creator-economy analyses of retention vs script style, hooks, pacing, or specific 'AI tell' avoidance techniques made it through; script-writing guidance here is architectural (multi-pass loops, persona-in-system-prompt) rather than stylistic. All surviving sources are first-party vendor docs (Anthropic, OpenAI, BFL, fal.ai) — authoritative for their own models but self-interested; no independent benchmarks corroborate quality claims like 'lighting has the biggest impact.' Three refuted claims mark the limits: OpenAI strict Structured Outputs does NOT remove the need for validation/retry handling (refusals, truncation, value-level errors persist); FLUX does not hard-error on negative_prompt (the claim was overstated — it is unsupported, not rejected); and the '40-50 word optimal FLUX prompt length' figure failed verification. Time-sensitivity is high: guidance is pegged to the FLUX.2 and Claude 4.6+/Fable 5 era (prefill removal is a 2026 breaking change), and several BFL citations point at a guide index page rather than the exact sub-pages holding the quotes (docs.bfl.ai/docs.bfl.ml prompting_unified_* and prompting_guide_flux2)."
== OPEN QUESTIONS ==
[
 "What do primary sources (Kling, Runway, Google Veo, Higgsfield docs) actually recommend for text-to-video and image-to-video prompting — motion verbs, camera-move vocabulary, per-clip duration limits, and image-to-video conditioning — since no claims in this area survived verification?",
 "Is there empirical, non-vendor evidence linking script style (sentence-rhythm variance, hook structure, spoken-word register) to YouTube retention metrics, and which concrete 'humanization' rewrite instructions measurably reduce AI-detectable prose patterns?",
 "Does constraining generation to a JSON schema degrade prose quality in the constrained fields, and is a two-step pattern (free-prose generation, then a cheap structuring pass) measurably better than schema-embedded CoT for narration-quality outputs?",
 "How much creative latitude should the model get per stage — e.g., letting the scripting model adapt imagery prompts to the story versus enforcing strict templates — given no verified source addressed the latitude-vs-template tradeoff directly?"
]
== REFUTED ==
[
 {
  "claim": "OpenAI's Structured Outputs feature, when strict mode is enabled, guarantees that model responses conform to a supplied JSON Schema, removing the need to validate or retry malformed responses in a pipeline.",
  "vote": "0-3",
  "source": "https://developers.openai.com/api/docs/guides/structured-outputs"
 },
 {
  "claim": "FLUX does not support negative prompts: its guidance-distilled architecture errors if a negative_prompt parameter is passed, so undesired elements must be handled with positive phrasing (describe what you want, not what to avoid).",
  "vote": "0-3",
  "source": "https://fal.ai/learn/tools/how-to-use-flux"
 },
 {
  "claim": "The optimal FLUX prompt length is roughly 40-50 words; prompts under ~10 words trigger internal expansion from training data, and prompts over ~200 words are internally summarized with possible loss of detail.",
  "vote": "1-2",
  "source": "https://fal.ai/learn/tools/how-to-use-flux"
 }
]
== UNVERIFIED ==
[]