import Link from "next/link";
import { sql } from "drizzle-orm";
import { channels, costRecords, productions } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { IconPlus, IconChannels } from "@/components/icons";
import { channelStatusLabel, fmtMoney, tierLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  const { db } = await getAppContext();
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
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Channels</h1>
          <p className="page-sub">
            {rows.length} channel{rows.length === 1 ? "" : "s"} in the portfolio.
          </p>
        </div>
        <Link className="btn" href="/channels/new">
          <IconPlus /> New channel
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="panel">
          <div className="placeholder">
            <div className="pic">
              <IconChannels />
            </div>
            <h2>No channels yet</h2>
            <p>Create your first channel to start generating ideas and producing Shorts.</p>
          </div>
        </div>
      ) : (
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Niche</th>
                <th>Autonomy</th>
                <th>Status</th>
                <th className="r">In pipeline</th>
                <th className="r">Total cost</th>
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
                    <span className="chip">{tierLabel(c.autonomyTier)}</span>
                  </td>
                  <td>
                    <span className={`chip ${c.status === "active" ? "good" : "warn"}`}>
                      <span className="d" />
                      {channelStatusLabel(c.status)}
                    </span>
                  </td>
                  <td className="r">{countBy.get(c.id) ?? 0}</td>
                  <td className="r">{fmtMoney(costBy.get(c.id) ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
