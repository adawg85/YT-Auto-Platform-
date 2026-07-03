import { costRecords, ulid, type Db } from "@ytauto/db";

export type CostCategory = "llm" | "voice" | "media" | "research" | "publish" | "render";

export type CostEntry = {
  category: CostCategory;
  provider: string;
  model?: string;
  units: Record<string, number>;
  costUsd: number;
  channelId: string;
  productionId?: string;
  agentActionId?: string;
  meta?: Record<string, unknown>;
};

/**
 * Single choke point for cost accounting — every provider adapter (real AND
 * mock) records through this, so per-video unit economics exist from day one.
 */
export interface CostSink {
  record(entry: CostEntry): Promise<void>;
}

export function createDbCostSink(db: Db): CostSink {
  return {
    async record(entry) {
      await db.insert(costRecords).values({
        id: ulid(),
        channelId: entry.channelId,
        productionId: entry.productionId,
        category: entry.category,
        provider: entry.provider,
        model: entry.model,
        units: entry.units,
        costUsd: entry.costUsd.toFixed(6),
        agentActionId: entry.agentActionId,
        meta: entry.meta,
      });
    },
  };
}

/** In-memory sink for tests. */
export function createMemoryCostSink(): CostSink & { entries: CostEntry[] } {
  const entries: CostEntry[] = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}
