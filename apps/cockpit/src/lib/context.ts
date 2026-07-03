import { getDb } from "@ytauto/db";
import { createDbCostSink, loadSecretsEnv, type CostSink } from "@ytauto/core";
import { createProviders, type Providers } from "@ytauto/providers";

const TTL_MS = 15_000;

let cache: { providers: Providers; costSink: CostSink; at: number } | undefined;

/**
 * Providers are rebuilt from process.env merged with the encrypted secrets
 * stored in the DB (DB wins), so keys saved on /account take effect without
 * a restart. Short TTL + explicit invalidation on save.
 */
export async function getAppContext() {
  const db = getDb();
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const costSink = createDbCostSink(db);
    const env = { ...process.env, ...(await loadSecretsEnv(db)) };
    cache = { costSink, providers: createProviders(costSink, env), at: Date.now() };
  }
  return { db, providers: cache.providers, costSink: cache.costSink };
}

export function invalidateProviderCache() {
  cache = undefined;
}

export function operatorName(): string {
  return process.env.OPERATOR_USER ?? "operator";
}
