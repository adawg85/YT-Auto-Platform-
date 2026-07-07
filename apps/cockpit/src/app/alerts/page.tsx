import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { alerts, channels, publications } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { ackAlertAction, runIngestNowAction } from "./actions";
import { IconBell, IconRefresh } from "@/components/icons";
import { alertKindLabel, alertSeverityLabel, fmtDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const SEVERITY_CHIP: Record<string, string> = {
  critical: "crit",
  warning: "warn",
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

  const AlertTable = ({ items, ackable }: { items: typeof rows; ackable: boolean }) => (
    <table className="data">
      <thead>
        <tr>
          <th>Severity</th>
          <th>Alert</th>
          <th>Channel</th>
          <th>Detail</th>
          <th>When</th>
          {ackable && <th style={{ width: 130 }} />}
        </tr>
      </thead>
      <tbody>
        {items.map(({ alert, channel, publication }) => (
          <tr key={alert.id}>
            <td>
              <span className={`chip ${SEVERITY_CHIP[alert.severity]}`}>
                <span className="d" />
                {alertSeverityLabel(alert.severity)}
              </span>
            </td>
            <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{alertKindLabel(alert.kind)}</td>
            <td>{channel.name}</td>
            <td>
              {alert.message}{" "}
              {publication && (
                <Link
                  href={`/productions/${publication.productionId}`}
                  style={{ color: "var(--accent-ink)", fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  View video
                </Link>
              )}
            </td>
            <td className="muted" style={{ whiteSpace: "nowrap" }}>
              {fmtDateTime(alert.createdAt)}
            </td>
            {ackable && (
              <td style={{ textAlign: "right" }}>
                {alert.status === "open" && (
                  <form action={ackAlertAction.bind(null, alert.id)}>
                    <button className="btn ghost sm" type="submit">
                      Acknowledge
                    </button>
                  </form>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Alerts</h1>
          <p className="page-sub">
            {open.length === 0 ? "No open alerts." : `${open.length} open alert${open.length === 1 ? "" : "s"} need a look.`}
          </p>
        </div>
        <form action={runIngestNowAction}>
          <button type="submit" className="btn ghost">
            <IconRefresh /> Run analytics ingest
          </button>
        </form>
      </div>
      <p className="muted" style={{ margin: "0 0 18px", fontSize: 12.5 }}>
        Analytics ingest runs automatically every 6 hours; snapshots feed scoring and the alert rules.
      </p>

      {open.length ? (
        <>
          <h2 style={{ marginTop: 0 }}>Open</h2>
          <AlertTable items={open} ackable />
        </>
      ) : (
        <div className="panel">
          <div className="placeholder">
            <div className="pic">
              <IconBell />
            </div>
            <h2>All quiet</h2>
            <p>No open alerts. Retention and performance alerts will land here as analytics come in.</p>
          </div>
        </div>
      )}

      {acked.length > 0 && (
        <>
          <h2>Acknowledged</h2>
          <AlertTable items={acked} ackable={false} />
        </>
      )}
    </>
  );
}
