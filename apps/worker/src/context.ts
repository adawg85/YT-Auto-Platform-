import { getDb } from "@ytauto/db";
import { createDbCostSink } from "@ytauto/core";
import { createProviders, type Providers } from "@ytauto/providers";
import type { CostSink } from "@ytauto/core";

let cached: { providers: Providers; costSink: CostSink } | undefined;

export function getContext() {
  const db = getDb();
  if (!cached) {
    const costSink = createDbCostSink(db);
    cached = { costSink, providers: createProviders(costSink) };
  }
  return { db, ...cached };
}
