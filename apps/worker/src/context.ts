import { getDb } from "@ytauto/db";
import { createDbCostSink, loadChannelToken, loadSecretsEnv, type CostSink } from "@ytauto/core";
import { createProviders, type Providers } from "@ytauto/providers";

const TTL_MS = 15_000;

type MergedEnv = NodeJS.ProcessEnv;

let cache: { providers: Providers; costSink: CostSink; env: MergedEnv; at: number } | undefined;

/**
 * Providers are rebuilt from process.env merged with the encrypted secrets
 * stored in the DB (DB wins), so keys saved in the cockpit reach the worker
 * within the TTL — no restart needed. The merged `env` is exposed for
 * config-level backend selection (e.g. Remotion Lambda vs local render).
 */
export async function getContext() {
  const db = getDb();
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const costSink = createDbCostSink(db);
    const env: MergedEnv = { ...process.env, ...(await loadSecretsEnv(db)) };
    cache = {
      costSink,
      env,
      providers: createProviders(costSink, env, {
        resolveChannelToken: (channelId) => loadChannelToken(db, channelId),
      }),
      at: Date.now(),
    };
  }
  return { db, providers: cache.providers, costSink: cache.costSink, env: cache.env };
}
