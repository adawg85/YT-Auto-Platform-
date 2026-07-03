import { getDb } from "@ytauto/db";
import { createDbCostSink, loadSecretsEnv, type CostSink } from "@ytauto/core";
import { createProviders, type Providers } from "@ytauto/providers";

const TTL_MS = 15_000;

let cache: { providers: Providers; costSink: CostSink; at: number } | undefined;

/**
 * Providers are rebuilt from process.env merged with the encrypted secrets
 * stored in the DB (DB wins), so keys saved in the cockpit reach the worker
 * within the TTL — no restart needed.
 */
export async function getContext() {
  const db = getDb();
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const costSink = createDbCostSink(db);
    const env = { ...process.env, ...(await loadSecretsEnv(db)) };
    cache = { costSink, providers: createProviders(costSink, env), at: Date.now() };
  }
  return { db, providers: cache.providers, costSink: cache.costSink };
}
