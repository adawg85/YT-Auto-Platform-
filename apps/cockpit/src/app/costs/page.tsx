import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { channels, costRecords, ideas, productions } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { costCategoryLabel } from "@/lib/format";
import { fmtAud, loadUsdAudRates } from "@/lib/fx";

export const dynamic = "force-dynamic";

const CATEGORIES = ["llm", "voice", "media", "render", "publish", "research"] as const;
const day = sql<string>`to_char(${costRecords.createdAt}, 'YYYY-MM-DD')`;

export default async function CostsPage() {
  const { db } = await getAppContext();

  // Grouped by DAY too so each day's USD converts at ITS OWN spot rate before we
  // aggregate (2026-07-19 operator, in Australia — show AUD at that day's rate).
  const byChannel = await db
    .select({
      channelId: costRecords.channelId,
      category: costRecords.category,
      day,
      total: sql<string>`sum(${costRecords.costUsd})`,
    })
    .from(costRecords)
    .groupBy(costRecords.channelId, costRecords.category, day);

  const byProduction = await db
    .select({
      productionId: costRecords.productionId,
      day,
      total: sql<string>`sum(${costRecords.costUsd})`,
    })
    .from(costRecords)
    .where(sql`${costRecords.productionId} is not null`)
    .groupBy(costRecords.productionId, day);

  const allChannels = await db.select().from(channels);
  const channelName = new Map(allChannels.map((c) => [c.id, c.name]));

  const prods = await db
    .select({ production: productions, idea: ideas })
    .from(productions)
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .orderBy(desc(productions.createdAt))
    .limit(50);
  const prodTitle = new Map(prods.map((p) => [p.production.id, p.idea.title]));

  const fx = await loadUsdAudRates(db, [
    ...byChannel.map((r) => r.day),
    ...byProduction.map((r) => r.day),
  ]);
  const aud = (usd: string, d: string) => Number(usd) * fx.rateFor(d);

  const channelTotals = new Map<string, Record<string, number>>();
  for (const row of byChannel) {
    const rec = channelTotals.get(row.channelId) ?? {};
    rec[row.category] = (rec[row.category] ?? 0) + aud(row.total, row.day);
    channelTotals.set(row.channelId, rec);
  }
  const prodTotals = new Map<string, number>();
  for (const row of byProduction) {
    prodTotals.set(row.productionId!, (prodTotals.get(row.productionId!) ?? 0) + aud(row.total, row.day));
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
          <p className="page-sub">Unit economics — what every channel and every video costs to make. Shown in AUD at each day&rsquo;s USD→AUD spot rate.</p>
        </div>
        <span className="chip">Total {fmtAud(grand)}</span>
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
                        {cats[c] ? fmtAud(cats[c]) : <span className="muted">—</span>}
                      </td>
                    ))}
                    <td className="r">
                      <strong>{fmtAud(total)}</strong>
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
            {prodTotals.size === 0 ? (
              <tr>
                <td colSpan={2} className="muted">
                  No per-video costs yet.
                </td>
              </tr>
            ) : (
              [...prodTotals.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([productionId, totalAud]) => (
                  <tr key={productionId}>
                    <td>
                      <Link href={`/productions/${productionId}`} style={{ fontWeight: 600 }}>
                        {prodTitle.get(productionId) ?? productionId}
                      </Link>
                    </td>
                    <td className="r">{fmtAud(totalAud)}</td>
                  </tr>
                ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
