"use server";

import { revalidatePath } from "next/cache";
import {
  AGENT_REGISTRY,
  deleteSecret,
  inngest,
  isAllowedSecretName,
  isEncryptionConfigured,
  parseAgentModelOverrides,
  setSecret,
} from "@ytauto/core";
import { evalRuns, evalVotes, ulid } from "@ytauto/db";
import { GOLDEN_SET } from "@ytauto/agents";
import { getAppContext, getMergedEnv, invalidateProviderCache } from "@/lib/context";

export async function saveSecretAction(formData: FormData) {
  const name = String(formData.get("name") ?? "");
  const value = String(formData.get("value") ?? "");
  if (!isAllowedSecretName(name)) throw new Error(`Unknown secret: ${name}`);
  if (!isEncryptionConfigured()) {
    throw new Error("SECRETS_ENCRYPTION_KEY is not set on the server — see .env.example");
  }
  if (!value.trim()) return; // ignore empty submits
  const { db } = await getAppContext();
  await setSecret(db, name, value);
  invalidateProviderCache();
  revalidatePath("/account");
}

export async function deleteSecretAction(name: string) {
  if (!isAllowedSecretName(name)) throw new Error(`Unknown secret: ${name}`);
  const { db } = await getAppContext();
  await deleteSecret(db, name);
  invalidateProviderCache();
  revalidatePath("/account");
}

/**
 * #21 per-agent routing: set or clear ONE agent's model override inside the
 * LLM_AGENT_MODELS JSON secret. Empty value = clear; an empty map deletes the
 * secret so the router sees a clean unset state.
 */
export async function saveAgentModelAction(formData: FormData) {
  const agent = String(formData.get("agent") ?? "");
  const value = String(formData.get("value") ?? "").trim();
  if (!AGENT_REGISTRY.some((a) => a.name === agent)) throw new Error(`Unknown agent: ${agent}`);
  if (!isEncryptionConfigured()) {
    throw new Error("SECRETS_ENCRYPTION_KEY is not set on the server — see .env.example");
  }
  const { db } = await getAppContext();
  const env = await getMergedEnv();
  const map = parseAgentModelOverrides(env.LLM_AGENT_MODELS);
  if (value) map[agent] = value;
  else delete map[agent];
  if (Object.keys(map).length === 0) await deleteSecret(db, "LLM_AGENT_MODELS");
  else await setSecret(db, "LLM_AGENT_MODELS", JSON.stringify(map));
  invalidateProviderCache();
  revalidatePath("/account");
}

export async function clearAgentModelAction(agent: string) {
  const fd = new FormData();
  fd.set("agent", agent);
  fd.set("value", "");
  await saveAgentModelAction(fd);
}

/** #21.2.5: start a golden-set eval run over the submitted candidate models
 * (checkbox picks + an optional free-text extras field, comma/newline split). */
export async function startEvalRunAction(formData: FormData) {
  const picked = formData.getAll("models").map(String);
  const extras = String(formData.get("customModels") ?? "").split(/[\n,]+/);
  const models = [
    ...new Set([...picked, ...extras].map((m) => m.trim()).filter(Boolean)),
  ].slice(0, 8); // sanity cap: 8 models × 6 fixtures = 48 script chains
  if (models.length === 0) return;
  const { db } = await getAppContext();
  const runId = ulid();
  await db.insert(evalRuns).values({
    id: runId,
    models,
    fixtureCount: GOLDEN_SET.length,
    note: String(formData.get("note") ?? "").slice(0, 300) || null,
  });
  await inngest.send({ name: "eval/run.requested", data: { runId } });
  revalidatePath("/account");
}

/** #21.2.5 blind A/B: record the operator's pairwise pick for one fixture. */
export async function voteEvalPairAction(formData: FormData) {
  const runId = String(formData.get("runId") ?? "");
  const fixtureId = String(formData.get("fixtureId") ?? "");
  const winnerResultId = String(formData.get("winnerResultId") ?? "");
  const loserResultId = String(formData.get("loserResultId") ?? "");
  if (!runId || !fixtureId || !winnerResultId || !loserResultId) return;
  const { db } = await getAppContext();
  await db.insert(evalVotes).values({ id: ulid(), runId, fixtureId, winnerResultId, loserResultId });
  revalidatePath("/account");
}
