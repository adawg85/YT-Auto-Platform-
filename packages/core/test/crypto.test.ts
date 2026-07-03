import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "../src/crypto";

const env = { SECRETS_ENCRYPTION_KEY: "test-passphrase-that-is-long-enough" } as NodeJS.ProcessEnv;

describe("secret encryption", () => {
  it("round-trips", () => {
    const payload = encryptSecret("sk-or-v1-abc123", env);
    expect(payload).not.toContain("abc123");
    expect(decryptSecret(payload, env)).toBe("sk-or-v1-abc123");
  });

  it("uses a fresh IV per encryption", () => {
    expect(encryptSecret("same", env)).not.toBe(encryptSecret("same", env));
  });

  it("fails on tampered ciphertext", () => {
    const payload = Buffer.from(encryptSecret("value", env), "base64");
    payload[payload.length - 1] = payload[payload.length - 1]! ^ 0xff;
    expect(() => decryptSecret(payload.toString("base64"), env)).toThrow();
  });

  it("fails with the wrong master key", () => {
    const payload = encryptSecret("value", env);
    expect(() =>
      decryptSecret(payload, { SECRETS_ENCRYPTION_KEY: "another-passphrase-entirely!" } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("refuses to run without a configured key", () => {
    expect(isEncryptionConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(() => encryptSecret("x", {} as NodeJS.ProcessEnv)).toThrow(/SECRETS_ENCRYPTION_KEY/);
  });
});
