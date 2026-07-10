/**
 * One-shot secrets migration: copy every row of the `secrets` table from one
 * database to another, decrypting with the SOURCE key and re-encrypting with
 * the TARGET key. Built for the droplet→Render move (HANDOFF 2026-07-09 /
 * BACKLOG #19): run it LOCALLY, where the local .env and DB live.
 *
 * Usage (from the repo root):
 *
 *   TARGET_DATABASE_URL='postgresql://…render.com/ytauto_db…' \
 *   TARGET_SECRETS_ENCRYPTION_KEY='9ebdad236a…' \
 *   node scripts/rekey-secrets.mjs [--dry-run] [--include-channel-tokens]
 *
 * Source defaults come from the local .env (DATABASE_URL +
 * SECRETS_ENCRYPTION_KEY); override with SOURCE_DATABASE_URL /
 * SOURCE_SECRETS_ENCRYPTION_KEY. The Render "External Connection String" is
 * the TARGET_DATABASE_URL; TARGET_SECRETS_ENCRYPTION_KEY must equal the
 * SECRETS_ENCRYPTION_KEY env var set on BOTH Render services.
 *
 * Behavior:
 *   - skips rows that fail to decrypt (wrong/rotated source key) with a warn
 *   - skips per-channel YouTube tokens (YOUTUBE_REFRESH_TOKEN__CH_*) unless
 *     --include-channel-tokens — channel ids won't exist in a fresh target DB
 *   - upserts by name, then round-trips a decrypt against the target to verify
 *   - never prints plaintext; only names + last4
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "packages/db/package.json"));
const postgres = require("postgres");

// ---- args / env -----------------------------------------------------------
const dryRun = process.argv.includes("--dry-run");
const includeChannelTokens = process.argv.includes("--include-channel-tokens");

/** minimal .env parser — only used to default the SOURCE side */
function loadDotenv(file) {
  try {
    const out = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  } catch {
    return {};
  }
}
const dotenv = loadDotenv(path.join(repoRoot, ".env"));

const sourceUrl =
  process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL ?? dotenv.DATABASE_URL;
const sourceKey =
  process.env.SOURCE_SECRETS_ENCRYPTION_KEY ??
  process.env.SECRETS_ENCRYPTION_KEY ??
  dotenv.SECRETS_ENCRYPTION_KEY;
const targetUrl = process.env.TARGET_DATABASE_URL;
const targetKey = process.env.TARGET_SECRETS_ENCRYPTION_KEY;

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
if (!sourceUrl) fail("No source DB. Set SOURCE_DATABASE_URL (or DATABASE_URL / .env).");
if (!sourceKey || sourceKey.length < 16)
  fail("No source key. Set SOURCE_SECRETS_ENCRYPTION_KEY (or SECRETS_ENCRYPTION_KEY / .env).");
if (!targetUrl) fail("Set TARGET_DATABASE_URL to the Render External Connection String.");
if (!targetKey || targetKey.length < 16)
  fail("Set TARGET_SECRETS_ENCRYPTION_KEY (min 16 chars — the value on the Render services).");
if (targetUrl === sourceUrl) fail("Source and target DB are the same — refusing.");

// ---- crypto (mirrors packages/core/src/crypto.ts: AES-256-GCM, IV∥tag∥ct) --
const IV_LEN = 12;
const TAG_LEN = 16;
const keyOf = (passphrase) => createHash("sha256").update(passphrase, "utf8").digest();

function decrypt(payload, passphrase) {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_LEN + TAG_LEN + 1) throw new Error("corrupt payload");
  const decipher = createDecipheriv("aes-256-gcm", keyOf(passphrase), raw.subarray(0, IV_LEN));
  decipher.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(raw.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString("utf8");
}
function encrypt(plaintext, passphrase) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", keyOf(passphrase), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

// ---- run --------------------------------------------------------------------
const sslFor = (url) =>
  /localhost|127\.0\.0\.1|@postgres[:/]/.test(url) ? undefined : "require";
const src = postgres(sourceUrl, { ssl: sslFor(sourceUrl), max: 1, onnotice: () => {} });
const dst = postgres(targetUrl, { ssl: sslFor(targetUrl), max: 1, onnotice: () => {} });

try {
  const rows = await src`select name, ciphertext, last4 from secrets order by name`;
  console.log(`Source: ${rows.length} secret row(s).${dryRun ? " (dry run — target untouched)" : ""}\n`);

  let copied = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    const isChannelToken = row.name.startsWith("YOUTUBE_REFRESH_TOKEN__CH_");
    if (isChannelToken && !includeChannelTokens) {
      console.log(`  – skip  ${row.name} (channel token; --include-channel-tokens to copy)`);
      skipped++;
      continue;
    }
    let plaintext;
    try {
      plaintext = decrypt(row.ciphertext, sourceKey);
    } catch {
      console.warn(`  ✗ FAIL  ${row.name} — cannot decrypt with the source key (re-enter on /account)`);
      failed++;
      continue;
    }
    if (dryRun) {
      console.log(`  ✓ would copy ${row.name} (…${row.last4})`);
      copied++;
      continue;
    }
    const ciphertext = encrypt(plaintext, targetKey);
    await dst`
      insert into secrets (name, ciphertext, last4)
      values (${row.name}, ${ciphertext}, ${row.last4})
      on conflict (name) do update set ciphertext = excluded.ciphertext, last4 = excluded.last4
    `;
    // verify: read back and decrypt under the target key
    const [back] = await dst`select ciphertext from secrets where name = ${row.name}`;
    if (decrypt(back.ciphertext, targetKey) !== plaintext) {
      console.error(`  ✗ FAIL  ${row.name} — target round-trip mismatch`);
      failed++;
      continue;
    }
    console.log(`  ✓ copied ${row.name} (…${row.last4})`);
    copied++;
  }

  console.log(
    `\nDone: ${copied} ${dryRun ? "would be " : ""}copied, ${skipped} skipped, ${failed} failed.`,
  );
  if (failed > 0) process.exitCode = 1;
} finally {
  await Promise.all([src.end(), dst.end()]);
}
