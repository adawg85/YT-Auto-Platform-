# MCP connector — ideate in Claude, act on the platform (BACKLOG #36)

The cockpit exposes a Model Context Protocol (MCP) server at **`/api/mcp`** so you
can add the platform as a **custom connector** in the Claude desktop/mobile app.
Channel ideation then happens in a normal Claude chat, grounded in the platform's
own real intel — and "make it so" actually seeds ideas, drafts charters, and
creates channels here.

## Setup

1. **Set the bearer token.** On **/account → Claude MCP connector**, set
   `MCP_BEARER_TOKEN` (or put it in the environment). Generate one with
   `openssl rand -hex 32`. This is a dedicated secret — **not** the operator
   basic-auth password. Until it's set, `/api/mcp` returns `503 not configured`.

2. **Add the connector in Claude.** Claude → Settings → Connectors → Add custom
   connector. The dialog only offers OAuth or no-auth (no static-token field),
   so use a **no-auth** connector with the token in the URL:
   - **Name:** anything (e.g. `YT Auto Cockpit`).
   - **Remote MCP server URL:**
     `https://yt-auto-platform.onrender.com/api/mcp?key=<MCP_BEARER_TOKEN>`
     (or dev `http://localhost:3000/api/mcp?key=<token>`).
   - **OAuth Client ID / Secret:** leave BLANK.

   The server accepts the token from `?key=` in the URL **or** a standard
   `Authorization: Bearer <token>` header (for curl / SDK clients).

3. **Ideate.** Ask Claude things like *"what niches are heating up?"*,
   *"draft a channel about maritime archaeology"*, or *"seed three Spitfire ideas
   on Hangar Histories"* — Claude calls the tools below.

## Auth & security

- `/api/mcp` is **exempt from operator basic auth** (the Claude app can't send it)
  and is guarded by `MCP_BEARER_TOKEN` inside the route handler instead.
- The token **is** the operator: every mutating call logs a `channel_decisions`
  row with `actor: operator` and `detail.via: "mcp"`, so the audit trail matches
  the cockpit buttons.
- Transport is Streamable HTTP, request/response only (no server-initiated
  stream). A hand-rolled JSON-RPC server — no external SDK dependency.

## Tools (v1)

**Read**
- `list_channels` — every channel with id / name / @handle / niche / format / tier.
- `get_channel_state` — a channel's charter, distilled state-of-the-world summary,
  and performance summary.
- `get_intel` — rising market opportunities + top pattern-store patterns
  (optionally niche-filtered). The real scouted intel.
- `get_playbook` — a channel's learned adopted/trial directives with the why +
  confidence.
- `get_eval_results` — recent model-quality eval runs (per-model avg judge score,
  ok/error counts).

**Act** (every mutation is audited)
- `run_market_scan` — kick the meta-analysis engine now (global or niche-scoped).
- `seed_idea` — add an idea to a channel's inbox and auto-score it (goes through
  the normal gates).
- `propose_channel` — draft a charter for a niche + intent **without creating**
  anything (review it in chat).
- `create_channel` — provision a channel end-to-end (charter + DNA + persona +
  standing sources), exactly like the setup wizard. Returns the **manual**
  YouTube provisioning checklist — creating the Google/YouTube account and setting
  the name/@handle/avatar stays a human step (ToS/CAPTCHA/verification).

**Direct authoring (BACKLOG #36 — Claude writes, the platform executes)**

The platform normally runs its own LLMs for ideation/planning/scripting. These
tools let Claude author that content DIRECTLY, so the pipeline just executes it
(only images + TTS + render still get generated). Every mutation is audited.

- `get_channel_config` — read a channel's full config (DNA, resolved Production
  Profile with all axes, charter, autonomy) before authoring against it.
- `list_ideas` / `list_series` / `list_productions` / `get_production` — read the
  backlog, arcs, and in-flight/finished productions (incl. a script-draft summary).
- `set_channel_config` — set channel options directly (no wizard/planner LLM):
  autonomy tier; DNA (tone, hooks, forbidden topics, CTA, voice, **targetLengthSec**,
  cadence); a partial Production Profile (merged over the stored one); charter
  mission/objectives.
- `create_series` — author a story arc + its episodes directly (no editorial
  planner). Active by default; episodes flow into research/production as normal.
- `write_idea` — write one idea to the backlog (auto-scores), or `greenlight:true`
  to send it straight into production.
- `author_script` — the big one: author a full script (hook + beats, each with
  type/text and optional imagePrompt/referenceEntity/visualBrief/heroShot) and run
  it through the pipeline with **no platform scripting LLM**. Optionally set a
  per-video Production Profile (else the channel's profile is used, which also
  skips the profile-proposal LLM + its gate). The human **script gate is skipped**
  (you wrote it), but the **anti-clone check + review board still run**, then
  voiceover → images → render → publish. Give it an `ideaId` or
  `ideaTitle`+`ideaAngle`.

**Driving the halts (review gates)**

An authored production still stops at the same gates the operator would hit on a
gated (T0/T1) channel — the **visuals** gate and the **final** gate — so Claude
drives the whole pipeline but you (or Claude) clear the halts:

- `list_gates` — what's waiting for a decision (per channel or all).
- `get_gate` — inspect a gate; for a `visuals_review` gate it returns each shot's
  narration + image + whether it was animated, plus the cockpit `reviewPath`.
- `decide_gate` — `approved` / `rejected` / `revise` (with notes) — the same
  effect as the cockpit buttons. This is how you push a production past a halt.

**Auto-run once it's dialled in.** Set `autoApproveVisuals: true` (or
`autoApproveFinal: true`) in a channel's Production Profile via `set_channel_config`
to stop halting that gate — the pipeline flows straight through while the safety
checks (anti-clone + review board) stay on. Default off, so you review at first.

**Claude owns the LLM touchpoints.** On an authored production, every creative LLM
step the platform would run is replaced by what Claude wrote:
- **Script** — the drafting/humanize/proof LLMs are skipped (seeded verbatim).
- **Profile proposal** — skipped (the profile is set).
- **Image prompts** — when a beat carries a full `imagePrompt` (>=20 chars), the
  `buildImagePrompts` LLM is skipped and Claude's prompt is used verbatim; leave a
  beat's prompt thin and the platform elaborates just that one.

Still generated by the platform (by design): image/clip pixels, TTS voiceover, the
render. Motion/video prompts are also Claude-authorable (a beat's `motionPrompt`
is used verbatim when it animates).

**Help, diagnostics, and the issue bridge**

- `get_guide` — returns the full operating guide (how to drive the platform
  correctly). Read it first if unsure.
- `get_diagnostics` — a debug console: blocked productions (failed/on_hold) + the
  reason, open alerts, and the deployed build versions. (For per-render media
  detail, `/api/diag/media` and `/api/diag/clips` in the cockpit.)
- `report_issue` — file a ticket when something goes wrong or needs attention; it
  lands on the cockpit **Tickets** page for the operator + developer to read.
- `list_issues` / `resolve_issue` — read filed tickets; mark them acknowledged/closed.

**Stock media sourcing** (real images/clips) is automatic on `real_footage`/`mixed`
channels when a beat names a `referenceEntity`/`visualBrief` and the library keys
are set on `/account`: photos from Pexels/Pixabay/Unsplash, video from
Pexels/Pixabay/Coverr — archival first, stock as top-up, credited automatically.

## Notes

- The read tools reflect live data — run `run_market_scan` first if the intel
  looks stale, then re-read `get_intel`.
- `create_channel` drafts a fresh charter each call. Use `propose_channel` to
  iterate on the concept first, then commit with `create_channel`.
