import { and, desc, eq, inArray } from "drizzle-orm";
import { channels, costRecords, ideas, productions, thumbnails } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { loadUsdAudRates } from "@/lib/fx";
import { IN_PRODUCTION_STATUSES } from "@/lib/status";
import { ProductionsTable, type ProductionRow } from "@/components/productions-table";

export const dynamic = "force-dynamic";

/**
 * The "In production" board (2026-07-24 operator ask): every video currently in
 * the pipeline — greenlit through scheduled — in one consolidated, sortable
 * table. A row click opens that video's production page. The status allowlist is
 * the shared `IN_PRODUCTION_STATUSES` (lib/status.ts), so this board and the
 * per-channel Videos table always agree on what "in production" means.
 */
export default async function ProductionsPage() {
  const { db } = await getAppContext();

  const recent = await db
    .select({ production: productions, idea: ideas, channel: channels })
    .from(productions)
    .innerJoin(ideas, eq(productions.ideaId, ideas.id))
    .innerJoin(channels, eq(productions.channelId, channels.id))
    .where(inArray(productions.status, [...IN_PRODUCTION_STATUSES]))
    .orderBy(desc(productions.updatedAt));

  const prodIds = recent.map((r) => r.production.id);

  // selected thumbnail per production (real art once one's been chosen)
  const selThumbs = prodIds.length
    ? await db
        .select({ productionId: thumbnails.productionId, storageKey: thumbnails.storageKey })
        .from(thumbnails)
        .where(and(inArray(thumbnails.productionId, prodIds), eq(thumbnails.selected, true)))
    : [];
  const thumbByProd = new Map(selThumbs.map((t) => [t.productionId, t.storageKey]));

  // spend-to-date per production, converted USD→AUD at each cost's day rate
  const costs = prodIds.length
    ? await db
        .select({ productionId: costRecords.productionId, cost: costRecords.costUsd, createdAt: costRecords.createdAt })
        .from(costRecords)
        .where(inArray(costRecords.productionId, prodIds))
    : [];
  const fx = await loadUsdAudRates(db, costs.map((c) => c.createdAt));
  const costByProd = new Map<string, number>();
  for (const c of costs) {
    if (!c.productionId) continue;
    const v = Number(c.cost) * fx.rateFor(c.createdAt);
    costByProd.set(c.productionId, (costByProd.get(c.productionId) ?? 0) + v);
  }

  const rows: ProductionRow[] = recent.map(({ production, idea, channel }) => ({
    id: production.id,
    title: idea.title,
    channelId: channel.id,
    channelName: channel.name,
    status: production.status,
    revisionCount: production.revisionCount,
    cost: costByProd.get(production.id) ?? null,
    thumbKey: thumbByProd.get(production.id) ?? null,
    createdAt: production.createdAt.toISOString(),
    updatedAt: production.updatedAt.toISOString(),
  }));

  const channelCount = new Set(rows.map((r) => r.channelId)).size;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">In production</h1>
          <p className="page-sub">
            {rows.length === 0
              ? "No videos are in the pipeline right now."
              : `${rows.length} video${rows.length === 1 ? "" : "s"} in the pipeline` +
                (channelCount > 1 ? ` across ${channelCount} channels` : "") +
                " — greenlight through scheduled. Sort any column; click a row to open its production."}
          </p>
        </div>
      </div>

      <ProductionsTable rows={rows} />
    </>
  );
}
