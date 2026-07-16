# Visual Director — design spec (2026-07-16, operator-requested)

**Status:** SPEC for review — no code yet. Operator decisions baked in:
1. The **Director owns cadence** — it cuts the video into shots on *meaning*, not
   on sentence boundaries. Rhythm/Image-density become a *target* it aims for,
   not a hard mechanical cut.
2. The Director is **medium-aware** — it knows the channel's visual intent
   (stills-only / all-video / mixed, and AI vs real footage) and plans each
   shot's medium within what the channel actually allows.
3. Ship **spec-first**, then an opt-in MVP with the current pipeline as fallback.

---

## 1. The problem this fixes

Today the visual pipeline is two decoupled, non-cinematic steps:

- **`planShots`** (`packages/core/src/shots.ts`) cuts the script into shots
  **mechanically** — purely on the Rhythm axis over voiceover word-timings. It
  has no sense of story: it slices on sentences/pauses and emits one image per
  slice.
- **`image_prompt_builder`** (`packages/agents/src/image-prompt.ts`, agentic
  tier) then writes each shot's prompt **in isolation** (batches of 8), guarded
  only by a "don't look like the shot *next to you*" rule.

Consequences: locally-fine frames with **no global visual arc** — no deliberate
establishing→detail→payoff, no motifs/callbacks, no intentional wide/close
rhythm, no planned placement of the character across the piece, and a beat that
spans multiple topics leaks one `visualBrief` onto shots it doesn't fit. (The
backlog already flags "derive a per-shot visual brief" under #35 — this spec is
the fuller version.)

## 2. The three stages

```
script beats + voiceover timings + channel style/character + MEDIUM intent
        │
        ▼
[1] VISUAL DIRECTOR  (new, frontier tier, once per video)
        → an ordered VisualSequence of DirectedShots (meaning-based),
          each with subject/scale/angle/medium/character/hero/motif/intent
        │
        ▼
[2] TIME-CUT  (deterministic, in shots.ts)
        → map each DirectedShot's narration span onto real start/end seconds
          using word-timings; enforce min/max shot length + clip cap
        │
        ▼
[3] PER-SHOT ARTICULATION  (upgraded image_prompt_builder, agentic tier, batched)
        → the exact text-to-image prompt for each shot, grounded in the
          director's intent for THAT shot
        │
        ▼
existing downstream: character conditioning · per-role image engines ·
motion/clips (honours the director's medium) · visuals gate · render
```

## 3. Stage 1 — the Director agent

**Agent:** `visual_director`, **frontier tier** (one high-leverage call per
video; add to `AGENT_REGISTRY`). Runs as a single cached `step.run` so Inngest
replays/retries reproduce it.

### Inputs
- Full script: every beat's `type`, `text` (narration), `visualBrief`,
  `referenceEntity`, `heroShot`.
- Voiceover total duration (for pacing) — NOT the per-word timings (those are for
  stage 2; the director works in narration order + a target count).
- Channel **style doc** (distilled `#35.1`), **character(s)** (name + canonical
  description), **niche**, **orientation** (9:16 / 16:9).
- **MEDIUM INTENT (the operator's key ask):** the allowed visual media, derived
  from the Production Profile:
  - `visualMode` → `simple` | `real_footage` | `ai_images` | `ai_video` | `mixed`
  - `motion` → `static` | `partial` | `ai_video`
  - `archivalStrength` → how hard to prefer real footage
  - `maxAiClips` → the clip budget (so it doesn't plan more motion than we'll make)
  The director is told, in plain terms, the palette it may use, e.g.:
  - stills-only AI channel → every shot `still` (generated)
  - all-video channel → choose `still` vs `motion` per shot; lean motion on dynamic beats
  - real-footage/mixed → choose `real_footage` for sourceable subjects, `still`/`motion` (AI) elsewhere
  It must NOT plan a medium the channel disallows (e.g. no `motion` on a
  `static` channel, no `real_footage` on an `ai_images` channel).
- **Cadence target:** a target shot count (and soft ± range) derived from the
  existing `shotPlanOptions` math (Rhythm + Image-density → avg shot length →
  target count for this duration). The director aims for it but may deviate for
  story.

### Output — `VisualSequence`
An ordered list of `DirectedShot` (Zod-validated). Proposed shape (extends the
current `Shot`):

```ts
type ShotMedium = "still" | "motion" | "real_footage";
type ShotScale  = "wide" | "medium" | "close" | "insert";

interface DirectedShot {
  beatIndex: number;            // which beat this shot belongs to (provenance + timing)
  narrationSpan: string;        // the exact narration slice this shot covers —
                                //   spans MUST tile each beat's text with no gaps/overlaps
  subject: string;              // the concrete thing shown
  shotScale: ShotScale;
  angle?: string;               // front | low | high | over-shoulder | profile | aerial …
  medium: ShotMedium;           // chosen within the channel's allowed palette
  character: string | null;     // which character appears (director places them deliberately)
  hero: boolean;                // pivotal frame (supersedes the mechanical "first shot of hero beat")
  motif?: string | null;        // recurring-motif tag → deliberate callbacks, always a NEW angle
  continuity?: string | null;   // link to the prior shot ("same lab, tighter", "reverse angle")
  intent: string;               // one line of directorial intent → feeds stage 3
}
```

### Prompt shape (behavioural rules the director follows)
- Read the whole script as ONE piece; design a visual ARC (open with an
  establishing frame, vary scale/angle across the sequence, escalate to hero
  beats, resolve on the CTA).
- **Cut on meaning:** a new subject/idea in the narration = a new shot; keep a
  single idea in one shot even across two sentences. Aim for the cadence target
  but let story win.
- **Global anti-repetition:** never two look-alike shots anywhere; when a motif
  must recur, tag it `motif` and specify a NEW scale/angle/state each time.
- **Medium per shot** from the allowed palette; explain (in `intent`) why a shot
  is a clip vs a still vs real footage.
- Place the **character** where it reads (opener, hero/emotional beats, shots
  that name it); leave diagrams/establishing shots character-free.
- Mark `hero` on the genuine peak frames only (≈ the scriptwriter's hero beats,
  refined to the exact frame).

## 4. Stage 2 — Time-cut (deterministic)

Lives in `shots.ts` (new `planShotsFromDirection(beats, words, sequence, opts)`
beside the existing `planShots`).

1. For each `DirectedShot`, find its `narrationSpan` inside the parent beat's
   text, map the span's first/last word to `startSec`/`endSec` via the
   voiceover word-timings (same machinery `planShots` already uses).
2. Enforce the existing guards from `shotPlanOptions`:
   - `minShotSec` — merge a too-short directed shot into its neighbour (or the
     director avoids sub-2s spans; validated).
   - `maxShotSec` (when animating) — a `motion` shot longer than the clip cap is
     split, or downgraded to `still`.
   - Tile the timeline contiguously (no gaps/overlaps) — same final pass as today.
3. **Validation + fallback (critical):** if the director's spans don't cleanly
   tile a beat (gaps/overlaps/unfound text), fall back to the **mechanical
   `planShots`** for that beat only. The whole video never fails on a bad
   director pass — worst case it degrades to today's behaviour.
4. Emits the same `Shot[]` the rest of the pipeline consumes, now carrying the
   extra director fields (`shotScale`, `medium`, `angle`, `motif`, `continuity`,
   `intent`, `character`, `hero`).

## 5. Stage 3 — Per-shot articulation

The existing `image_prompt_builder`, upgraded to consume the director's fields:
each prompt is written to render *that shot's* subject at its scale/angle, in the
channel style, honouring `intent` and `motif`. The global no-repeat burden moves
UP to the director (it planned variety), so the articulator focuses on faithful
execution. Still batched (~8) on the agentic tier for cost.

## 6. How downstream steps change

- **Character casting** folds INTO the director: the per-shot `character` field
  replaces the separate `selectForcedCharacterShots` smart-% pass when the
  director is on. Smart-% stays as the fallback (director off / director beat
  fell back). Reference-sheet conditioning + per-role engines are unchanged.
- **Motion / clips** (`planMotion`) honours the director's `medium`: shots marked
  `motion` become i2v clips (still bounded by `maxAiClips`; if the director plans
  more motion than the budget, prioritise hero + character), `real_footage` go to
  the sourcing chain, `still` stay still. This replaces today's hero-only/all
  heuristic with an intentional per-shot decision.
- **Per-role engines** (image + video) are unchanged — still routed by
  character/hero/bulk role, which the director now assigns explicitly.
- **Visuals gate** (nice-to-have): surface the director's `shotScale` / `medium`
  / `intent` per tile so the operator sees the plan, not just the picture.

## 7. Determinism, cost, safety

- **Determinism:** director output persisted (script-draft meta or a new
  `directed_sequence` field) and read on replay; one `step.run`. Moderate
  temperature but cached, so Inngest retries reproduce.
- **Cost:** one extra frontier LLM call per video (reads the script once) —
  negligible next to image/clip generation, and the highest-leverage place to
  spend a strong model. Per-shot articulation stays agentic/batched.
- **Safety:** per-beat fallback to mechanical `planShots`; opt-in per channel;
  current path untouched when off.

## 8. Rollout

- **Phase 1 (MVP, opt-in):** `visual_director` agent + `DirectedShot` schema +
  `planShotsFromDirection` + validation/fallback + articulation consumes director
  fields + motion honours `medium`. Per-channel toggle (`profile.visualDirector`
  off/on), default OFF. Verify on one real MIXED-mode video end-to-end.
- **Phase 2:** fold casting fully into the director; surface the plan in the
  visuals gate; tune the prompt from real output.
- **Phase 3:** make it the default once proven across formats (Shorts + long).

## 9. Open questions for implementation

- Cadence target math: reuse `shotPlanOptions` to derive the target count, or
  give the director min/max shot-length bounds and let it choose the count?
- Should `real_footage` sourcing feedback (a subject that couldn't be sourced)
  loop back to the director for a still fallback, or handle silently downstream
  (as today)?
- Persist the sequence on the script draft (survives resume) vs regenerate on
  each production — recommend persist, keyed to the draft version.

---

*Files this touches when built: `packages/agents/src/visual-director.ts` (new),
`packages/core/src/shots.ts` (+`planShotsFromDirection`), `packages/core/src/beats.ts`
(schemas), `packages/core/src/agent-registry.ts` (+`visual_director`),
`apps/worker/src/functions/production-pipeline.ts` (wire stages 1-2, motion),
`packages/agents/src/image-prompt.ts` (consume director fields),
`packages/core/src/production-profile.ts` + `packages/db/src/schema.ts`
(`visualDirector` toggle), cockpit Profile panel (the toggle).*
