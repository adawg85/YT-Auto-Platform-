"use server";

import { revalidatePath } from "next/cache";
import {
  deleteSecret,
  isAllowedSecretName,
  isEncryptionConfigured,
  setSecret,
} from "@ytauto/core";
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
