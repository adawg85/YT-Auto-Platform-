import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { channels, costRecords, ideas, productions } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { DataTable, EmptyState } from "@/components/ui";
import { IconDollar } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function CostsPage() {
  const { db } = await getAppContext();

  const byChannel = await db
    .select({
      channelId: costRecords.channelId,
      category: costRecords.category,
      total: sql<string>`sum(${costRecords.costUsd})`,
    })
    .from(costRecords)
    .groupBy(costRecords.channelId, costRecords.category);

  const byProduction = await db
    .select({
      productionId: costRecords.productionId,
      total: sql<string>`sum(${costRecords.costUsd})`,
    })
    .from(costRecords)
    .where(sql`${costRecords.productionId} is not null`)
    .groupBy(costRecords.productionId);

  const allChannels = await db.select().from(channels);
  const channelName = new Map(allChannels.map((c) => [c.id, c.name]));

  const prods = await db
    .select({ production: productions, idea: ideas })
    .from(productions)
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .orderBy(desc(productions.createdAt))
    .limit(50);
  const prodTitle = new Map(prods.map((p) => [p.production.id, p.idea.title]));

  const categories = ["llm", "voice", "media", "render", "publish", "research"] as const;
  const channelTotals = new Map<string, Record<string, number>>();
  for (const row of byChannel) {
    const rec = channelTotals.get(row.channelId) ?? {};
    rec[row.category] = Number(row.total);
    channelTotals.set(row.channelId, rec);
  }

  return (
    <div>
      <h1>Unit economics</h1>

      <h2>Per channel (by category)</h2>
      {channelTotals.size === 0 ? (
        <EmptyState
          icon={<IconDollar />}
          title="No spend recorded yet"
          description="Cost records accrue as productions run through the pipeline."
        />
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th>Channel</th>
              {categories.map((c) => (
                <th key={c}>{c}</th>
              ))}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {[...channelTotals.entries()].map(([channelId, cats]) => {
              const total = Object.values(cats).reduce((a, b) => a + b, 0);
              return (
                <tr key={channelId}>
                  <td>{channelName.get(channelId) ?? channelId}</td>
                  {categories.map((c) => (
                    <td key={c} className="num">
                      {cats[c] ? `$${cats[c].toFixed(4)}` : "—"}
                    </td>
                  ))}
                  <td className="num">
                    <strong>${total.toFixed(4)}</strong>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      <h2>Per video</h2>
      {byProduction.length === 0 ? (
        <EmptyState
          icon={<IconDollar />}
          title="No per-video costs yet"
          description="Once productions incur spend, per-video unit economics show up here."
        />
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th>Video</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {byProduction.map((row) => (
              <tr key={row.productionId}>
                <td>
                  <Link href={`/productions/${row.productionId}`}>
                    {prodTitle.get(row.productionId!) ?? row.productionId}
                  </Link>
                </td>
                <td className="num">${Number(row.total).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
