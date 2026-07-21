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
  { name: "OPENAI_API_KEY", label: "OpenAI API key (GPT direct — also embeddings)", group: "LLM" },
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
  // #21.2.3 pay-on-failure escalation: OPTIONAL — unset means the escalation
  // retry is disabled (the tier aliases frontier and the pipeline skips it)
  {
    name: "LLM_MODEL_ESCALATION",
    label: "Model — escalation (redo-on-failure, optional)",
    group: "LLM",
  },
  // #21 per-agent routing: JSON map of agentName → vendor-prefixed model ref;
  // edited via the per-agent overrides panel on /account Models, never raw
  {
    name: "LLM_AGENT_MODELS",
    label: "Per-agent model overrides (JSON)",
    group: "LLM",
  },
  { name: "ELEVENLABS_API_KEY", label: "ElevenLabs API key", group: "Voice / TTS" },
  { name: "SEEDREAM_API_KEY", label: "BytePlus ModelArk key — Seedream image (activate the image model on its key)", group: "Media generation" },
  { name: "SEEDANCE_API_KEY", label: "BytePlus ModelArk key — Seedance video (separate key; activate the video model + raise Safe Experience Mode)", group: "Media generation" },
  { name: "ARK_API_KEY", label: "BytePlus ModelArk key — shared fallback (used for Seedream/Seedance if no dedicated key above)", group: "Media generation" },
  // AI beat-video engines (2026-07-14, faceless tier) — DIRECT vendor APIs.
  // Wan reuses DASHSCOPE_API_KEY above (same Alibaba Model Studio account).
  { name: "MINIMAX_API_KEY", label: "Minimax API key (Hailuo video)", group: "Media generation" },
  { name: "MINIMAX_GROUP_ID", label: "Minimax GroupId (only if file download needs it)", group: "Media generation" },
  { name: "KLING_ACCESS_KEY", label: "Kling Access Key (premium cinematic video — with the Secret Key)", group: "Media generation" },
  { name: "KLING_SECRET_KEY", label: "Kling Secret Key (paired with the Access Key)", group: "Media generation" },
  { name: "PEXELS_API_KEY", label: "Pexels API key (free stock photos + b-roll)", group: "Media generation" },
  { name: "PIXABAY_API_KEY", label: "Pixabay API key (free stock photos + video)", group: "Media generation" },
  { name: "UNSPLASH_ACCESS_KEY", label: "Unsplash Access Key (free stock photos)", group: "Media generation" },
  { name: "COVERR_API_KEY", label: "Coverr API key (free stock video)", group: "Media generation" },
  { name: "TAVILY_API_KEY", label: "Tavily API key (research search)", group: "Research" },
  { name: "EXA_API_KEY", label: "Exa API key (research search)", group: "Research" },
  { name: "PERPLEXITY_API_KEY", label: "Perplexity API key (Sonar research)", group: "Research" },
  { name: "YOUTUBE_CLIENT_ID", label: "YouTube OAuth client ID", group: "YouTube publishing" },
  { name: "YOUTUBE_CLIENT_SECRET", label: "YouTube OAuth client secret", group: "YouTube publishing" },
  { name: "YOUTUBE_REFRESH_TOKEN", label: "YouTube OAuth refresh token", group: "YouTube publishing" },
  { name: "S3_ENDPOINT", label: "S3 endpoint (e.g. DO Spaces)", group: "Object storage" },
  { name: "S3_REGION", label: "S3 region", group: "Object storage" },
  { name: "S3_BUCKET", label: "S3 bucket", group: "Object storage" },
  { name: "S3_ACCESS_KEY_ID", label: "S3 access key id", group: "Object storage" },
  { name: "S3_SECRET_ACCESS_KEY", label: "S3 secret access key", group: "Object storage" },
  // Remotion Lambda cloud renders (BACKLOG #18; docs/LAMBDA.md). All five set →
  // renders fan out on AWS Lambda; clear FUNCTION_NAME to fall back to local CPU.
  {
    name: "REMOTION_AWS_ACCESS_KEY_ID",
    label: "AWS access key id (remotion-user)",
    group: "Cloud render (Remotion Lambda)",
  },
  {
    name: "REMOTION_AWS_SECRET_ACCESS_KEY",
    label: "AWS secret access key",
    group: "Cloud render (Remotion Lambda)",
  },
  {
    name: "REMOTION_AWS_REGION",
    label: "AWS region (e.g. ap-southeast-2)",
    group: "Cloud render (Remotion Lambda)",
  },
  {
    name: "REMOTION_LAMBDA_FUNCTION_NAME",
    label: "Deployed function name (from deploy script)",
    group: "Cloud render (Remotion Lambda)",
  },
  {
    name: "REMOTION_SERVE_URL",
    label: "Deployed site serve URL (from deploy script)",
    group: "Cloud render (Remotion Lambda)",
  },
  // BACKLOG #36: bearer token that guards the /api/mcp connector endpoint. NOT
  // the operator basic-auth password — a dedicated secret so the Claude app can
  // reach /api/mcp (exempt from basic auth) while everything else stays locked.
  {
    name: "MCP_BEARER_TOKEN",
    label: "MCP connector token (guards /api/mcp — set this in the Claude app connector)",
    group: "Claude MCP connector",
  },
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
