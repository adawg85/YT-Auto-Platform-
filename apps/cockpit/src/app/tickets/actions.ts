"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull, ne } from "drizzle-orm";
import { agentTickets } from "@ytauto/db";
import { getAppContext, getMergedEnv } from "@/lib/context";
import { createGithubIssue } from "@/lib/github-issues";

/** Set a ticket's status (operator triage on the Tickets page). */
export async function setTicketStatusAction(ticketId: string, status: "open" | "acknowledged" | "closed") {
  const { db } = await getAppContext();
  await db.update(agentTickets).set({ status }).where(eq(agentTickets.id, ticketId));
  revalidatePath("/tickets");
}

/**
 * Backfill a GitHub issue for a DB-only ticket (one filed before GitHub sync was
 * configured). Embeds the `ytauto-ticket:<id>` marker so the webhook links it
 * back and closing the issue closes the ticket, and stores github_url/number.
 * Idempotent — a ticket that's already mirrored is left alone.
 */
export async function mirrorTicketToGithubAction(ticketId: string): Promise<{ error?: string; url?: string }> {
  const { db } = await getAppContext();
  const [t] = await db.select().from(agentTickets).where(eq(agentTickets.id, ticketId)).limit(1);
  if (!t) return { error: "Ticket not found" };
  if (t.githubUrl) return { url: t.githubUrl };

  const body = [
    t.detail ?? "(no detail provided)",
    "",
    "---",
    `ytauto-ticket:${t.id}`,
    `Filed on the platform · severity **${t.severity}**` +
      (t.channelId ? ` · channel \`${t.channelId}\`` : "") +
      (t.productionId ? ` · production \`${t.productionId}\`` : ""),
  ].join("\n");

  const issue = await createGithubIssue(await getMergedEnv(), {
    title: t.title,
    body,
    labels: ["mcp-ticket", t.severity],
  });
  if (!issue.ok) {
    return {
      error:
        issue.reason === "unconfigured"
          ? `GitHub sync is off — set ${issue.missing} on /account, then retry.`
          : `GitHub rejected the issue: ${issue.detail}.`,
    };
  }
  await db
    .update(agentTickets)
    .set({ githubUrl: issue.url, githubNumber: issue.number })
    .where(eq(agentTickets.id, ticketId));
  revalidatePath("/tickets");
  return { url: issue.url };
}

/** Form-action wrapper (returns void) so it can drive a `<form action=…>`. */
export async function mirrorTicketFormAction(ticketId: string): Promise<void> {
  await mirrorTicketToGithubAction(ticketId);
}

/** Form-action wrapper (returns void) for the bulk button. */
export async function mirrorAllOpenTicketsFormAction(): Promise<void> {
  await mirrorAllOpenTicketsToGithubAction();
}

/**
 * Bulk-mirror every open, not-yet-mirrored ticket to GitHub. Sequential (small
 * volume; avoids a burst against the GitHub API). Reports how many landed.
 */
export async function mirrorAllOpenTicketsToGithubAction(): Promise<{
  error?: string;
  mirrored?: number;
  failed?: number;
}> {
  const { db } = await getAppContext();
  const pending = await db
    .select({ id: agentTickets.id })
    .from(agentTickets)
    .where(and(ne(agentTickets.status, "closed"), isNull(agentTickets.githubUrl)));
  if (pending.length === 0) return { mirrored: 0, failed: 0 };

  let mirrored = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const { id } of pending) {
    const res = await mirrorTicketToGithubAction(id);
    if (res.error) {
      failed++;
      firstError ??= res.error;
      // If GitHub sync isn't configured, stop early — every one will fail.
      if (res.error.includes("GitHub sync is off")) break;
    } else {
      mirrored++;
    }
  }
  revalidatePath("/tickets");
  return { mirrored, failed, error: failed > 0 ? firstError : undefined };
}
