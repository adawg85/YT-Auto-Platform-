import { desc } from "drizzle-orm";
import { agentTickets } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { fmtDateTime } from "@/lib/format";
import { setTicketStatusAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * BACKLOG #36: the shared issue log. Claude in chat files problems via the MCP
 * `report_issue` tool; they land here for the operator (and, relayed, the
 * developer) to read and triage. A lightweight bridge between the two Claudes.
 */
export default async function TicketsPage() {
  const { db } = await getAppContext();
  const rows = await db.select().from(agentTickets).orderBy(desc(agentTickets.createdAt)).limit(200);
  const open = rows.filter((r) => r.status !== "closed");
  const closed = rows.filter((r) => r.status === "closed");

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
      <p style={{ opacity: 0.7, marginTop: 0, marginBottom: 16 }}>
        Issues filed by Claude via the MCP connector (<code>report_issue</code>) and other sources. Triage them here.
      </p>

      <h2 style={{ fontSize: 16, marginBottom: 8 }}>Open ({open.length})</h2>
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
