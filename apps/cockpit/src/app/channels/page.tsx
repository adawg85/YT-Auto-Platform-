import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { channels, costRecords, productions } from "@ytauto/db";
import { getAppContext } from "@/lib/context";

export const dynamic = "force-dynamic";

const TIERS = ["T0 manual", "T1 assisted", "T2 supervised", "T3 exception-only"];

export default async function ChannelsPage() {
  const { db } = getAppContext();
  const rows = await db.select().from(channels);
  const costTotals = await db
    .select({
      channelId: costRecords.channelId,
      total: sql<string>`sum(${costRecords.costUsd})`,
    })
    .from(costRecords)
    .groupBy(costRecords.channelId);
  const prodCounts = await db
    .select({
      channelId: productions.channelId,
      count: sql<number>`count(*)::int`,
    })
    .from(productions)
    .groupBy(productions.channelId);

  const costBy = new Map(costTotals.map((c) => [c.channelId, Number(c.total)]));
  const countBy = new Map(prodCounts.map((c) => [c.channelId, c.count]));

  return (
    <div>
      <h1>Channels</h1>
      <table className="data">
        <thead>
          <tr>
            <th>Channel</th>
            <th>Niche</th>
            <th>Autonomy</th>
            <th>Status</th>
            <th>Productions</th>
            <th>Total cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>
                <Link href={`/channels/${c.id}`}>
                  <strong>{c.name}</strong>
                </Link>
                <div className="muted">{c.handle}</div>
              </td>
              <td>{c.niche}</td>
              <td>
                <span className="badge">{TIERS[c.autonomyTier] ?? c.autonomyTier}</span>
              </td>
              <td>
                <span className={`badge ${c.status === "active" ? "green" : ""}`}>{c.status}</span>
              </td>
              <td>{countBy.get(c.id) ?? 0}</td>
              <td className="mono">${(costBy.get(c.id) ?? 0).toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
