import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { channels, costRecords, ideas, productions } from "@ytauto/db";
import { getAppContext } from "@/lib/context";

export const dynamic = "force-dynamic";

export default async function CostsPage() {
  const { db } = getAppContext();

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
      <table className="data">
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
                  <td key={c} className="mono">
                    {cats[c] ? `$${cats[c].toFixed(4)}` : "—"}
                  </td>
                ))}
                <td className="mono">
                  <strong>${total.toFixed(4)}</strong>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Per video</h2>
      <table className="data">
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
              <td className="mono">${Number(row.total).toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
