import { desc } from "drizzle-orm";
import { agentTickets } from "@ytauto/db";
import { githubSyncConfigured } from "@ytauto/core";
import { getAppContext, getMergedEnv } from "@/lib/context";
import { fmtDateTime } from "@/lib/format";
import { mirrorAllOpenTicketsFormAction, mirrorTicketFormAction, setTicketStatusAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * BACKLOG #36: the shared issue log. Claude in chat files problems via the MCP
 * `report_issue` tool; they land here for the operator (and, relayed, the
 * developer) to read and triage. A lightweight bridge between the two Claudes.
 */
export default async function TicketsPage({
  searchParams,
}: {
  searchParams?: Promise<{ synced?: string; failed?: string; err?: string }>;
}) {
  const { db } = await getAppContext();
  const env = await getMergedEnv();
  const ghConfigured = githubSyncConfigured(env);
  const params = (await searchParams) ?? {};
  const rows = await db.select().from(agentTickets).orderBy(desc(agentTickets.createdAt)).limit(200);
  const open = rows.filter((r) => r.status !== "closed");
  const closed = rows.filter((r) => r.status === "closed");
  const unmirrored = open.filter((t) => !t.githubUrl).length;
  const syncedN = Number(params.synced ?? 0);
  const failedN = Number(params.failed ?? 0);
  const ranSync = params.synced != null || params.failed != null || params.err != null;

  const sevColor: Record<string, string> = { error: "#ef4444", warn: "#f59e0b", info: "#38bdf8" };

  function Ticket({ t }: { t: (typeof rows)[number] }) {
    return (
      <div className="panel" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <span className="chip" style={{ background: sevColor[t.severity] ?? "#64748b", color: "#0b1220" }}>
                {t.severity}
              </span>
              <span className="chip">{t.status}</span>
              <span className="chip">{t.source}</span>
            </div>
            <div style={{ fontWeight: 600 }}>{t.title}</div>
            {t.detail ? (
              <div style={{ whiteSpace: "pre-wrap", opacity: 0.85, marginTop: 4, fontSize: 14 }}>{t.detail}</div>
            ) : null}
            <div style={{ opacity: 0.6, fontSize: 12, marginTop: 6 }}>
              {fmtDateTime(t.createdAt)}
              {t.channelId ? ` · channel ${t.channelId}` : ""}
              {t.productionId ? ` · production ${t.productionId}` : ""}
              {t.githubUrl ? (
                <>
                  {" · "}
                  <a href={t.githubUrl} target="_blank" rel="noreferrer">GitHub issue ↗</a>
                </>
              ) : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {!t.githubUrl ? (
              <form action={mirrorTicketFormAction.bind(null, t.id)}>
                <button className="btn" type="submit" title="Open a linked GitHub issue so the developer can pick it up">
                  Send to GitHub
                </button>
              </form>
            ) : null}
            {t.status === "open" ? (
              <form action={setTicketStatusAction.bind(null, t.id, "acknowledged")}>
                <button className="btn" type="submit">Ack</button>
              </form>
            ) : null}
            {t.status !== "closed" ? (
              <form action={setTicketStatusAction.bind(null, t.id, "closed")}>
                <button className="btn" type="submit">Close</button>
              </form>
            ) : (
              <form action={setTicketStatusAction.bind(null, t.id, "open")}>
                <button className="btn" type="submit">Reopen</button>
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "16px 0" }}>
      <h1 style={{ marginBottom: 4 }}>Tickets</h1>
      <p style={{ opacity: 0.7, marginTop: 0, marginBottom: 12 }}>
        Issues filed by Claude via the MCP connector (<code>report_issue</code>) and other sources. Triage them here.
      </p>

      {/* Status line — GitHub sync state + last bulk-mirror result */}
      <div
        style={{
          fontSize: 12.5,
          padding: "8px 10px",
          borderRadius: 8,
          marginBottom: 16,
          border: "1px solid rgba(148,163,184,0.25)",
          background: ranSync && (failedN > 0 || params.err) ? "rgba(239,68,68,0.12)" : "rgba(148,163,184,0.08)",
        }}
      >
        <div style={{ opacity: 0.85 }}>
          GitHub sync: <strong>{ghConfigured ? "configured ✓" : "OFF — set GITHUB_ISSUE_TOKEN on /account"}</strong>
          {" · "}
          {open.length} open · <strong>{unmirrored}</strong> not yet on GitHub
        </div>
        {ranSync ? (
          <div style={{ marginTop: 4 }}>
            Last “Send to GitHub”: mirrored <strong>{syncedN}</strong>, failed <strong>{failedN}</strong>
            {params.err ? (
              <span style={{ color: "#ef4444" }}> — {decodeURIComponent(params.err)}</span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Open ({open.length})</h2>
        {open.some((t) => !t.githubUrl) ? (
          <form action={mirrorAllOpenTicketsFormAction}>
            <button className="btn" type="submit" title="Open a linked GitHub issue for every open ticket not yet on GitHub">
              Send all open to GitHub ({open.filter((t) => !t.githubUrl).length})
            </button>
          </form>
        ) : null}
      </div>
      {open.length === 0 ? <p style={{ opacity: 0.6 }}>No open tickets.</p> : open.map((t) => <Ticket key={t.id} t={t} />)}

      {closed.length > 0 ? (
        <>
          <h2 style={{ fontSize: 16, margin: "20px 0 8px" }}>Closed ({closed.length})</h2>
          {closed.map((t) => (
            <Ticket key={t.id} t={t} />
          ))}
        </>
      ) : null}
    </div>
  );
}
