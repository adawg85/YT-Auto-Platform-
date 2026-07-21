import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { agentTickets } from "@ytauto/db";
import { getAppContext, getMergedEnv } from "@/lib/context";

export const runtime = "nodejs"; // needs node:crypto + the encrypted secret
export const dynamic = "force-dynamic";

/**
 * Two-way ticket bridge (task zero + the "two Claudes" loop): GitHub → platform.
 *
 *  - LINK: a GitHub issue carrying `ytauto-ticket:<ULID>` in its body adopts that
 *    existing agent_ticket (sets github_url/number). Lets Claude Code — which can
 *    reach GitHub but not the ticket DB or the ticket MCP tools — answer a ticket
 *    by opening/commenting a linked issue.
 *  - RESOLUTION: the issue body (+ comments) is synced onto the ticket's
 *    `resolution`, so the operator and the MCP Claude see the answer in
 *    `list_issues` and can then `resolve_issue` to close.
 *  - STATUS: closing/reopening the issue closes/reopens the ticket.
 *
 * Verified with the repo webhook's HMAC-SHA256 signature (GITHUB_WEBHOOK_SECRET);
 * a bad/absent signature is rejected. Best-effort — never throws to GitHub.
 *
 * Configure: repo → Settings → Webhooks → Payload URL
 *   https://<cockpit-host>/api/github/issues-webhook
 * content-type application/json, secret = GITHUB_WEBHOOK_SECRET, events:
 * Issues (required) + Issue comments (optional, to sync comments).
 */
const TICKET_MARKER = /ytauto-ticket:\s*([0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26})/;

function expectedSig(secret: string, raw: string): string {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}

function verify(secret: string, raw: string, sigHeader: string | null): boolean {
  if (!sigHeader?.startsWith("sha256=")) return false;
  const a = Buffer.from(sigHeader);
  const b = Buffer.from(expectedSig(secret, raw));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Strip the linking marker so it never shows in the operator-facing resolution. */
function cleanBody(body: string): string {
  return body.replace(/<!--\s*ytauto-ticket:[^>]*-->/gi, "").replace(TICKET_MARKER, "").trim();
}

type Db = Awaited<ReturnType<typeof getAppContext>>["db"];
type Issue = { number?: number; html_url?: string; body?: string | null };

/**
 * Link an unlinked ticket to this issue by its embedded ULID marker, and sync
 * the issue body onto the ticket's resolution. Idempotent; safe on every event.
 * Returns the linked ticketId (or null).
 */
async function ensureLinkedAndSynced(db: Db, issue: Issue): Promise<string | null> {
  const marker = issue.body?.match(TICKET_MARKER)?.[1];
  if (!marker || issue.number == null) return null;
  const ticketId = marker.toUpperCase();
  const [ticket] = await db.select().from(agentTickets).where(eq(agentTickets.id, ticketId)).limit(1);
  if (!ticket) return null; // unknown marker — ignore
  await db
    .update(agentTickets)
    .set({
      githubUrl: issue.html_url ?? ticket.githubUrl,
      githubNumber: issue.number,
      resolution: cleanBody(issue.body ?? "") || ticket.resolution,
    })
    .where(eq(agentTickets.id, ticketId));
  return ticketId;
}

export async function POST(req: Request) {
  const env = await getMergedEnv();
  const secret = env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ ok: false, note: "GITHUB_WEBHOOK_SECRET not set — two-way sync disabled." });
  }

  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  if (!verify(secret, raw, sig)) {
    // Safe diagnostics: the secret's LENGTH and one-way signature prefixes never
    // reveal the secret, but pinpoint a mismatch (secretLen !== 64 → stray
    // whitespace/truncation on /account; equal length but differing prefixes →
    // GitHub's secret differs from /account).
    return NextResponse.json(
      {
        ok: false,
        note: "bad signature — the /account GITHUB_WEBHOOK_SECRET does not match this webhook's secret",
        secretLen: secret.length,
        sigReceived: sig?.slice(0, 18) ?? null,
        sigExpectedPrefix: expectedSig(secret, raw).slice(0, 18),
        bodyLen: raw.length,
      },
      { status: 401 },
    );
  }

  const event = req.headers.get("x-github-event");
  let payload: {
    action?: string;
    issue?: Issue;
    comment?: { body?: string | null; user?: { login?: string } };
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, note: "unparseable body" }, { status: 400 });
  }

  try {
    const { db } = await getAppContext();

    // Issue comment → append to the ticket resolution (comment sync).
    if (event === "issue_comment") {
      if (payload.action !== "created" || !payload.comment?.body) {
        return NextResponse.json({ ok: true, note: `no-op issue_comment: ${payload.action}` });
      }
      const ticketId = await ensureLinkedAndSynced(db, payload.issue ?? {});
      const target = ticketId
        ? eq(agentTickets.id, ticketId)
        : payload.issue?.number != null
          ? eq(agentTickets.githubNumber, payload.issue.number)
          : null;
      if (!target) return NextResponse.json({ ok: true, note: "comment on unlinked issue — ignored" });
      const [t] = await db.select({ resolution: agentTickets.resolution }).from(agentTickets).where(target).limit(1);
      if (!t) return NextResponse.json({ ok: true, note: "no matching ticket" });
      const who = payload.comment.user?.login ?? "github";
      const appended = `${t.resolution ? `${t.resolution}\n\n` : ""}— ${who}: ${payload.comment.body.trim()}`;
      await db.update(agentTickets).set({ resolution: appended }).where(target);
      return NextResponse.json({ ok: true, note: "comment synced to ticket resolution" });
    }

    if (event !== "issues") {
      return NextResponse.json({ ok: true, note: `ignored event: ${event}` });
    }

    // Any issues event first ensures the ticket is linked + resolution synced,
    // so linking is robust to webhook-deploy timing (even a first 'closed' links).
    const linkedId = await ensureLinkedAndSynced(db, payload.issue ?? {});
    const action = payload.action;
    const number = payload.issue?.number;

    if (action === "closed" || action === "reopened") {
      const nextStatus = action === "closed" ? "closed" : "open";
      const target = linkedId
        ? eq(agentTickets.id, linkedId)
        : number != null
          ? eq(agentTickets.githubNumber, number)
          : null;
      if (!target) return NextResponse.json({ ok: true, note: "no linked ticket for this issue" });
      await db.update(agentTickets).set({ status: nextStatus }).where(target);
      return NextResponse.json({ ok: true, ticketStatus: nextStatus, issue: number, linked: Boolean(linkedId) });
    }

    return NextResponse.json({ ok: true, note: `synced (action: ${action})`, linked: Boolean(linkedId) });
  } catch (e) {
    // Never fail the webhook on a DB hiccup — GitHub would retry-storm.
    return NextResponse.json({ ok: false, note: e instanceof Error ? e.message : String(e) });
  }
}
