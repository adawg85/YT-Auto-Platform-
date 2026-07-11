import { describe, expect, it } from "vitest";
import { getLambdaConfig } from "../src/render-lambda";

const FULL = {
  REMOTION_AWS_ACCESS_KEY_ID: "AKIA_TEST",
  REMOTION_AWS_SECRET_ACCESS_KEY: "secret",
  REMOTION_AWS_REGION: "ap-southeast-2",
  REMOTION_LAMBDA_FUNCTION_NAME: "remotion-render-4-0-484-mem2048mb-disk10240mb-900sec",
  REMOTION_SERVE_URL: "https://remotionlambda-xyz.s3.ap-southeast-2.amazonaws.com/sites/ytauto/index.html",
  S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  S3_BUCKET: "ytauto",
  S3_ACCESS_KEY_ID: "r2key",
  S3_SECRET_ACCESS_KEY: "r2secret",
};

describe("getLambdaConfig (BACKLOG #18)", () => {
  it("parses a full config", () => {
    const cfg = getLambdaConfig(FULL);
    expect(cfg).not.toBeNull();
    expect(cfg!.region).toBe("ap-southeast-2");
    expect(cfg!.r2.bucket).toBe("ytauto");
  });

  it("is null when any REMOTION_* or S3_* key is missing (config-level fallback)", () => {
    for (const k of Object.keys(FULL)) {
      const env = { ...FULL, [k]: undefined };
      expect(getLambdaConfig(env), `missing ${k}`).toBeNull();
    }
  });

  it("is null under PROVIDERS_FORCE_MOCK=1 (mock e2e keeps the local render path)", () => {
    expect(getLambdaConfig({ ...FULL, PROVIDERS_FORCE_MOCK: "1" })).toBeNull();
  });
});

describe("framesPerLambdaFor (long-form under low quota)", () => {
  it("fits an 8-min video under a cap of 8 lambdas", async () => {
    const { framesPerLambdaFor } = await import("../src/render-lambda");
    const frames = 8 * 60 * 30; // 14400
    const chunk = framesPerLambdaFor(frames, 8);
    expect(Math.ceil(frames / chunk)).toBeLessThanOrEqual(8);
    expect(chunk).toBe(1800);
  });
  it("respects Remotion's 20-frame minimum for tiny videos", async () => {
    const { framesPerLambdaFor } = await import("../src/render-lambda");
    expect(framesPerLambdaFor(60, 100)).toBe(20);
  });
});
