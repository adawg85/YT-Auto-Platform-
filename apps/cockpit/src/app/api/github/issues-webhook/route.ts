import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { agentTickets } from "@ytauto/db";
import { getAppContext, getMergedEnv } from "@/lib/context";

export const runtime = "nodejs"; // needs node:crypto + the encrypted secret
export const dynamic = "force-dynamic";

/**
 * Two-way ticket sync (task zero): GitHub → platform. When the developer closes
 * (or reopens) the mirrored GitHub issue, flip the matching agent_ticket so the
 * two never drift. Verified with the repo webhook's HMAC-SHA256 signature
 * (GITHUB_WEBHOOK_SECRET); a bad/absent signature is rejected. Best-effort and
 * never throws to GitHub — a 200 with a note keeps the webhook healthy.
 *
 * Configure: repo → Settings → Webhooks → Payload URL
 *   https://<cockpit-host>/api/github/issues-webhook
 * content-type application/json, secret = GITHUB_WEBHOOK_SECRET, event: Issues.
 */
function verify(secret: string, raw: string, sigHeader: string | null): boolean {
  if (!sigHeader?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(sigHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const env = await getMergedEnv();
  const secret = env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    // Not configured — accept but no-op so GitHub's "recent deliveries" shows a
    // clear reason rather than a hard failure.
    return NextResponse.json({ ok: false, note: "GITHUB_WEBHOOK_SECRET not set — two-way sync disabled." });
  }

  const raw = await req.text();
  if (!verify(secret, raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ ok: false, note: "bad signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  if (event !== "issues") return NextResponse.json({ ok: true, note: `ignored event: ${event}` });

  let payload: { action?: string; issue?: { number?: number; html_url?: string } };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, note: "unparseable body" }, { status: 400 });
  }

  const action = payload.action;
  const number = payload.issue?.number;
  if (number == null || (action !== "closed" && action !== "reopened")) {
    return NextResponse.json({ ok: true, note: `no-op for action: ${action}` });
  }

  try {
    const { db } = await getAppContext();
    const nextStatus = action === "closed" ? "closed" : "open";
    await db
      .update(agentTickets)
      .set({ status: nextStatus })
      .where(eq(agentTickets.githubNumber, number));
    return NextResponse.json({ ok: true, ticketStatus: nextStatus, issue: number });
  } catch (e) {
    // Never fail the webhook on a DB hiccup — GitHub would retry-storm.
    return NextResponse.json({ ok: false, note: e instanceof Error ? e.message : String(e) });
  }
}
