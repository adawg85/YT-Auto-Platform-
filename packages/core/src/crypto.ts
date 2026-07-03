import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for provider keys at rest. The 256-bit key is derived
 * (SHA-256) from SECRETS_ENCRYPTION_KEY, so any sufficiently long random
 * passphrase works. Losing/rotating the passphrase orphans stored secrets —
 * re-enter them in the cockpit.
 */

const IV_LEN = 12;
const TAG_LEN = 16;

function masterKey(env = process.env): Buffer {
  const passphrase = env.SECRETS_ENCRYPTION_KEY;
  if (!passphrase || passphrase.length < 16) {
    throw new Error(
      "SECRETS_ENCRYPTION_KEY is not set (need a random passphrase of at least 16 chars) — " +
        "generate one with: openssl rand -hex 32",
    );
  }
  return createHash("sha256").update(passphrase, "utf8").digest();
}

export function isEncryptionConfigured(env = process.env): boolean {
  return (env.SECRETS_ENCRYPTION_KEY?.length ?? 0) >= 16;
}

/** → base64( IV ∥ authTag ∥ ciphertext ) */
export function encryptSecret(plaintext: string, env = process.env): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", masterKey(env), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decryptSecret(payload: string, env = process.env): string {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_LEN + TAG_LEN + 1) throw new Error("Corrupt secret payload");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(env), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
