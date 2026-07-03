import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { alerts, channels, productions, publications } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { ackAlertAction, runIngestNowAction } from "./actions";

export const dynamic = "force-dynamic";

const SEVERITY_COLOR: Record<string, string> = {
  critical: "red",
  warning: "amber",
  info: "",
};

export default async function AlertsPage() {
  const { db } = await getAppContext();
  const rows = await db
    .select({ alert: alerts, channel: channels, publication: publications })
    .from(alerts)
    .innerJoin(channels, eq(alerts.channelId, channels.id))
    .leftJoin(publications, eq(alerts.publicationId, publications.id))
    .orderBy(desc(alerts.createdAt))
    .limit(100);

  const open = rows.filter((r) => r.alert.status === "open");
  const acked = rows.filter((r) => r.alert.status === "acked");

  const prodByPub = new Map<string, string>();
  const pubIds = rows.map((r) => r.publication?.id).filter(Boolean) as string[];
  if (pubIds.length) {
    const prods = await db
      .select({ id: publications.id, productionId: publications.productionId })
      .from(publications);
    for (const p of prods) prodByPub.set(p.id, p.productionId);
  }

  const AlertTable = ({ items }: { items: typeof rows }) => (
    <table className="data">
      <thead>
        <tr>
          <th>Severity</th>
          <th>Kind</th>
          <th>Channel</th>
          <th>Message</th>
          <th>When</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {items.map(({ alert, channel, publication }) => (
          <tr key={alert.id}>
            <td>
              <span className={`badge ${SEVERITY_COLOR[alert.severity]}`}>{alert.severity}</span>
            </td>
            <td>
              <span className="badge">{alert.kind}</span>
            </td>
            <td>{channel.name}</td>
            <td>
              {alert.message}{" "}
              {publication && prodByPub.get(publication.id) && (
                <Link href={`/productions/${prodByPub.get(publication.id)}`}>video →</Link>
              )}
            </td>
            <td className="muted">{alert.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
            <td>
              {alert.status === "open" && (
                <form action={ackAlertAction.bind(null, alert.id)}>
                  <button className="secondary" type="submit">
                    Ack
                  </button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div>
      <h1>Alerts</h1>
      <div className="card">
        <form action={runIngestNowAction} className="inline">
          <button type="submit">⟳ Run analytics ingest now</button>
        </form>
        <span className="muted"> Auto-ingest runs every 6 hours; snapshots feed scoring and the alert rules.</span>
      </div>

      <h2>Open ({open.length})</h2>
      {open.length ? <AlertTable items={open} /> : <p className="muted">No open alerts.</p>}

      {acked.length > 0 && (
        <>
          <h2>Acknowledged</h2>
          <AlertTable items={acked} />
        </>
      )}
    </div>
  );
}
