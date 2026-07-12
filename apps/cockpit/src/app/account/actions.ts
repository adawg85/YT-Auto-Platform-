"use server";

import { revalidatePath } from "next/cache";
import {
  deleteSecret,
  inngest,
  isAllowedSecretName,
  isEncryptionConfigured,
  setSecret,
} from "@ytauto/core";
import { evalRuns, evalVotes, ulid } from "@ytauto/db";
import { GOLDEN_SET } from "@ytauto/agents";
import { getAppContext, invalidateProviderCache } from "@/lib/context";

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

/** #21.2.5: start a golden-set eval run over the submitted candidate models. */
export async function startEvalRunAction(formData: FormData) {
  const raw = String(formData.get("models") ?? "");
  const models = [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((m) => m.trim())
        .filter(Boolean),
    ),
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
