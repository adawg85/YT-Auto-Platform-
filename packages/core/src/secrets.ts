import { eq } from "drizzle-orm";
import { secrets, type Db } from "@ytauto/db";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * Whitelist of secret names the account page may store. Keys flow into the
 * provider factory as env overrides, so an explicit list prevents arbitrary
 * env injection.
 */
export const SECRET_KEYS = [
  { name: "ANTHROPIC_API_KEY", label: "Anthropic API key (Claude direct)", group: "LLM" },
  { name: "GEMINI_API_KEY", label: "Gemini API key (Google direct)", group: "LLM" },
  { name: "ZAI_API_KEY", label: "Z.ai API key (GLM direct)", group: "LLM" },
  { name: "DASHSCOPE_API_KEY", label: "DashScope API key (Qwen direct)", group: "LLM" },
  { name: "MOONSHOT_API_KEY", label: "Moonshot API key (Kimi direct)", group: "LLM" },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter API key (fallback/long-tail)", group: "LLM" },
  // model routing — not secrets, but the same encrypted store gives instant,
  // no-SSH overrides; values are vendor-prefixed refs (anthropic:claude-opus-4-8,
  // google:gemini-2.5-flash-lite, glm:glm-4.6, qwen:qwen-plus, kimi:…;
  // bare ids still mean OpenRouter slugs — see real/llm.ts)
  { name: "LLM_MODEL_CHEAP", label: "Model — cheap tier (bulk ideation/scoring)", group: "LLM" },
  { name: "LLM_MODEL_AGENTIC", label: "Model — agentic tier (checkers/analysis)", group: "LLM" },
  { name: "LLM_MODEL_FRONTIER", label: "Model — frontier tier (scripts/charters)", group: "LLM" },
  { name: "ELEVENLABS_API_KEY", label: "ElevenLabs API key", group: "Voice / TTS" },
  { name: "FAL_KEY", label: "fal.ai API key", group: "Media generation" },
  { name: "YOUTUBE_CLIENT_ID", label: "YouTube OAuth client ID", group: "YouTube publishing" },
  { name: "YOUTUBE_CLIENT_SECRET", label: "YouTube OAuth client secret", group: "YouTube publishing" },
  { name: "YOUTUBE_REFRESH_TOKEN", label: "YouTube OAuth refresh token", group: "YouTube publishing" },
  { name: "S3_ENDPOINT", label: "S3 endpoint (e.g. DO Spaces)", group: "Object storage" },
  { name: "S3_REGION", label: "S3 region", group: "Object storage" },
  { name: "S3_BUCKET", label: "S3 bucket", group: "Object storage" },
  { name: "S3_ACCESS_KEY_ID", label: "S3 access key id", group: "Object storage" },
  { name: "S3_SECRET_ACCESS_KEY", label: "S3 secret access key", group: "Object storage" },
] as const;

export type SecretName = (typeof SECRET_KEYS)[number]["name"];

/** Per-channel YouTube refresh tokens live in the same encrypted table. */
const CHANNEL_TOKEN_PREFIX = "YOUTUBE_REFRESH_TOKEN__CH_";

export function channelTokenName(channelId: string): string {
  return `${CHANNEL_TOKEN_PREFIX}${channelId}`;
}

export function isChannelTokenName(name: string): boolean {
  return name.startsWith(CHANNEL_TOKEN_PREFIX) && name.length > CHANNEL_TOKEN_PREFIX.length;
}

export function isAllowedSecretName(name: string): name is SecretName {
  return SECRET_KEYS.some((k) => k.name === name);
}

/** Accepts account-page names AND channel-scoped token names. */
export function isStorableSecretName(name: string): boolean {
  return isAllowedSecretName(name) || isChannelTokenName(name);
}

export async function setSecret(db: Db, name: string, value: string): Promise<void> {
  if (!isStorableSecretName(name)) throw new Error(`Not a storable secret name: ${name}`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Empty secret value");
  const row = {
    name,
    ciphertext: encryptSecret(trimmed),
    last4: trimmed.slice(-4),
  };
  await db
    .insert(secrets)
    .values(row)
    .onConflictDoUpdate({
      target: secrets.name,
      set: { ciphertext: row.ciphertext, last4: row.last4 },
    });
}

export async function deleteSecret(db: Db, name: string): Promise<void> {
  if (!isStorableSecretName(name)) throw new Error(`Not a storable secret name: ${name}`);
  await db.delete(secrets).where(eq(secrets.name, name));
}

/** Decrypted per-channel YouTube refresh token, or null if not connected. */
export async function loadChannelToken(db: Db, channelId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(secrets)
    .where(eq(secrets.name, channelTokenName(channelId)));
  if (!row) return null;
  try {
    return decryptSecret(row.ciphertext);
  } catch {
    console.error(`[secrets] cannot decrypt channel token for ${channelId} — reconnect the channel`);
    return null;
  }
}

export type SecretMeta = { name: string; last4: string; updatedAt: Date };

/** Metadata only — plaintext never leaves the server boundary. */
export async function listSecretMeta(db: Db): Promise<SecretMeta[]> {
  const rows = await db
    .select({ name: secrets.name, last4: secrets.last4, updatedAt: secrets.updatedAt })
    .from(secrets);
  return rows;
}

/**
 * Decrypted secrets as an env-shaped record, to merge OVER process.env when
 * building providers (DB-stored keys win over env).
 */
export async function loadSecretsEnv(db: Db): Promise<Record<string, string>> {
  const rows = await db.select().from(secrets);
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (!isAllowedSecretName(row.name)) continue;
    try {
      out[row.name] = decryptSecret(row.ciphertext);
    } catch {
      // wrong/rotated master key: skip rather than crash the whole app
      console.error(`[secrets] cannot decrypt ${row.name} — re-enter it on /account`);
    }
  }
  return out;
}
