import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { alerts, channels, productions, publications } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { Badge, Button, Card, DataTable, EmptyState, type Tone } from "@/components/ui";
import { IconCheck, IconRevise } from "@/components/icons";
import { ackAlertAction, runIngestNowAction } from "./actions";

export const dynamic = "force-dynamic";

const SEVERITY_TONE: Record<string, Tone> = {
  critical: "crit",
  warning: "warn",
  info: "neutral",
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
    <DataTable>
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
              <Badge tone={SEVERITY_TONE[alert.severity] ?? "neutral"} dot>
                {alert.severity}
              </Badge>
            </td>
            <td>
              <Badge>{alert.kind}</Badge>
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
                  <Button type="submit" variant="secondary" size="sm" icon={<IconCheck />}>
                    Ack
                  </Button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );

  return (
    <div>
      <h1>Alerts</h1>
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <form action={runIngestNowAction}>
            <Button type="submit" icon={<IconRevise />}>
              Run analytics ingest now
            </Button>
          </form>
          <span className="muted">Auto-ingest runs every 6 hours; snapshots feed scoring and the alert rules.</span>
        </div>
      </Card>

      <h2>Open ({open.length})</h2>
      {open.length ? (
        <AlertTable items={open} />
      ) : (
        <EmptyState
          icon={<IconCheck />}
          title="No open alerts"
          description="Everything is healthy. New alerts from analytics ingest will show up here."
        />
      )}

      {acked.length > 0 && (
        <>
          <h2>Acknowledged</h2>
          <AlertTable items={acked} />
        </>
      )}
    </div>
  );
}
