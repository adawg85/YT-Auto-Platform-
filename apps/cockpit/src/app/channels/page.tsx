import Link from "next/link";
import { sql } from "drizzle-orm";
import { channels, costRecords, productions } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { Badge, ButtonLink, DataTable, EmptyState } from "@/components/ui";
import { IconChannels, IconPlus } from "@/components/icons";

export const dynamic = "force-dynamic";

const TIERS = ["T0 manual", "T1 assisted", "T2 supervised", "T3 exception-only"];

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
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Channels</h1>
          <p className="page-sub">
            {rows.length} channel{rows.length === 1 ? "" : "s"} · autonomy tier, status and spend at a glance
          </p>
        </div>
        <ButtonLink href="/channels/new" icon={<IconPlus />}>
          New channel
        </ButtonLink>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={<IconChannels />}
          title="No channels yet"
          description="Create your first channel to start planning, producing and publishing."
          action={
            <ButtonLink href="/channels/new" icon={<IconPlus />}>
              New channel
            </ButtonLink>
          }
        />
      ) : (
        <DataTable>
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
                  <Badge tone="accent">{TIERS[c.autonomyTier] ?? c.autonomyTier}</Badge>
                </td>
                <td>
                  <Badge tone={c.status === "active" ? "good" : "warn"} dot>
                    {c.status}
                  </Badge>
                </td>
                <td className="num">{countBy.get(c.id) ?? 0}</td>
                <td className="num">${(costBy.get(c.id) ?? 0).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
