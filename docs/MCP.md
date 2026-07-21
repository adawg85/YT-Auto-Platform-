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

## Notes

- The read tools reflect live data — run `run_market_scan` first if the intel
  looks stale, then re-read `get_intel`.
- `create_channel` drafts a fresh charter each call. Use `propose_channel` to
  iterate on the concept first, then commit with `create_channel`.
