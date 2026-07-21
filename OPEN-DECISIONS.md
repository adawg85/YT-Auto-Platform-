# Open decisions

Decisions that are genuinely the operator's to make, surfaced rather than silently
chosen (per the remediation brief §0.1 rule 3). Each notes the current
implementation choice so nothing is blocked, and what would change it.

---

## D1. Duplicate-detection key (remediation §2.1 / §6)

**Chosen (shipped):** the duplicate-publish guard keys on **Idea identity**
(`productions.ideaId`) — it blocks a second upload for an idea that already has a
publication with a real `providerVideoId`. This exactly targets the confirmed bug
(Krypton published twice, Argon re-greenlit 4×: all the SAME idea re-greenlit).

**Not yet covered:** two DIFFERENT ideas about the same subject (the brief's
"Helium: The Element That Cools…" vs "Helium: The Element That Floats Away" —
different `ideaId`s, planned separately). That is a **planning-stage dedup**
problem, not a publish guard, and needs a different mechanism (title/substance
similarity at ideation/plan time). Left open.

**Would change it:** add `productions.substanceFingerprint` and/or published-title
similarity to the guard's match (an OR against the idea-id check) if same-subject
different-idea re-publishes prove to be a real pattern. The guard helper
(`publishedVideoForIdea`, `packages/core/src/publish.ts`) is the single place to
extend.

**Override:** re-publishing is still possible — `greenlightAction(id, {allowDuplicate:true})`
and `productions.allowDuplicate` carry an explicit operator override through to the
pipeline guard. No UI exposes the override yet (deliberate — corrected-copy is the
intended re-cut path); wire a confirm-dialog override into the re-greenlight button
if operators need it.

---

## D2. Empty descriptions (remediation §2.2)

**Finding:** the publish path assembles a non-empty description
(`idea.angle` + AI-disclosure + image credits) and threads it to
`snippet.description` correctly — static analysis found no drop. The 12 affected
videos likely predate the credit code, or hit the reuse/orphan branch that skips
the upload snippet. **Open:** whether to (a) backfill descriptions on the existing
12 via `videos.update` (needs the API + a one-off script), and/or (b) add a hard
non-empty assertion at `real/publish.ts` upload. The durable fix is metadata
authoring (§3.4) — giving the operator/Claude explicit control of title/description/
tags, with credits appended.

---

## D3. Cost figures — raw vs marked-up (remediation §6)

`get_production_costs` / `get_channel_costs` currently expose **raw provider spend
in USD** from `cost_records`. Open: whether to surface a marked-up internal figure
instead/as-well. Raw is chosen for now (it's the true number for a single operator).

---

## D4. Ken Burns fallback vs halt (remediation §4.1 / §6)

A Seedance clip that fails the privacy filter currently **keeps the still, which
already renders with a Ken Burns zoom** (existing behavior). Open: is that
editorially acceptable, or should a failed animation **halt for operator review**
instead? Current choice: keep the still (graceful), but SURFACE the fallback so
it's visible rather than silent. Flip to halt-on-failure if the silent still is
not acceptable for a channel.

---

## D5. Authored metadata vs the SEO generator (remediation §6)

Open: should operator/Claude-authored title/description (§3.4) **bypass** the
existing SEO metadata generator, or **feed** it as a seed it refines? Current lean:
authored values win verbatim (with credits appended), the generator fills gaps only
when nothing is authored.
