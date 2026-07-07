import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { channels, costRecords, ideas, productions } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { costCategoryLabel, fmtMoney } from "@/lib/format";

export const dynamic = "force-dynamic";

const CATEGORIES = ["llm", "voice", "media", "render", "publish", "research"] as const;

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

  const channelTotals = new Map<string, Record<string, number>>();
  for (const row of byChannel) {
    const rec = channelTotals.get(row.channelId) ?? {};
    rec[row.category] = Number(row.total);
    channelTotals.set(row.channelId, rec);
  }
  const grand = [...channelTotals.values()].reduce(
    (a, cats) => a + Object.values(cats).reduce((x, y) => x + y, 0),
    0,
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Costs</h1>
          <p className="page-sub">Unit economics — what every channel and every video costs to make.</p>
        </div>
        <span className="chip">Total {fmtMoney(grand)}</span>
      </div>

      <h2 style={{ marginTop: 0 }}>By channel</h2>
      <div className="tablewrap">
        <table className="data">
          <thead>
            <tr>
              <th>Channel</th>
              {CATEGORIES.map((c) => (
                <th key={c} className="r">
                  {costCategoryLabel(c)}
                </th>
              ))}
              <th className="r">Total</th>
            </tr>
          </thead>
          <tbody>
            {channelTotals.size === 0 ? (
              <tr>
                <td colSpan={CATEGORIES.length + 2} className="muted">
                  No cost records yet — costs are written as productions run.
                </td>
              </tr>
            ) : (
              [...channelTotals.entries()].map(([channelId, cats]) => {
                const total = Object.values(cats).reduce((a, b) => a + b, 0);
                return (
                  <tr key={channelId}>
                    <td>{channelName.get(channelId) ?? channelId}</td>
                    {CATEGORIES.map((c) => (
                      <td key={c} className="r">
                        {cats[c] ? fmtMoney(cats[c]) : <span className="muted">—</span>}
                      </td>
                    ))}
                    <td className="r">
                      <strong>{fmtMoney(total)}</strong>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <h2>By video</h2>
      <div className="tablewrap">
        <table className="data">
          <thead>
            <tr>
              <th>Video</th>
              <th className="r">Cost</th>
            </tr>
          </thead>
          <tbody>
            {byProduction.length === 0 ? (
              <tr>
                <td colSpan={2} className="muted">
                  No per-video costs yet.
                </td>
              </tr>
            ) : (
              byProduction.map((row) => (
                <tr key={row.productionId}>
                  <td>
                    <Link href={`/productions/${row.productionId}`} style={{ fontWeight: 600 }}>
                      {prodTitle.get(row.productionId!) ?? row.productionId}
                    </Link>
                  </td>
                  <td className="r">{fmtMoney(Number(row.total))}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
