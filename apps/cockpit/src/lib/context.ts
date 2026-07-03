import { getDb } from "@ytauto/db";
import { createDbCostSink, type CostSink } from "@ytauto/core";
import { createProviders, type Providers } from "@ytauto/providers";

let cached: { providers: Providers; costSink: CostSink } | undefined;

export function getAppContext() {
  const db = getDb();
  if (!cached) {
    const costSink = createDbCostSink(db);
    cached = { costSink, providers: createProviders(costSink) };
  }
  return { db, ...cached };
}

export function operatorName(): string {
  return process.env.OPERATOR_USER ?? "operator";
}
