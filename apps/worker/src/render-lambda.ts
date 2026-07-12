import {
  getRenderProgress,
  renderMediaOnLambda,
  type AwsRegion,
} from "@remotion/lambda/client";
import type { ShortProps } from "@ytauto/core";
import type { ObjectStore } from "@ytauto/providers";
import type { RenderInput } from "./render";

/**
 * Remotion Lambda render (BACKLOG #18, docs/LAMBDA.md). Fans the render across
 * AWS Lambdas (~2–4 min long-form vs ~28 min local CPU) and writes final.mp4
 * DIRECTLY to the R2 bucket via `outName.s3OutputProvider`, so the storageKey
 * convention and asset rows are identical to the local path. Assets reach the
 * renderers as presigned R2 URLs — no dependency on the worker's own
 * :3010/store route (the historical render 404 failure mode).
 *
 * Selection is config-level (see getLambdaConfig in production-pipeline):
 * clearing REMOTION_LAMBDA_FUNCTION_NAME on /account falls back to the local
 * CPU render on the next run. No silent in-process fallback — a fatal Lambda
 * error is almost always a bundle/asset/props problem that would fail locally
 * too, and Inngest retries the step.
 */

export type LambdaRenderConfig = {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  region: AwsRegion;
  functionName: string;
  serveUrl: string;
  /** the R2 target final.mp4 is written to (same bucket the store serves) */
  r2: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  /**
   * REMOTION_FRAMES_PER_LAMBDA: explicit chunk size (wins over the cap below).
   */
  framesPerLambda?: number;
  /**
   * REMOTION_CONCURRENCY_PER_LAMBDA: browser tabs per render Lambda (1-10).
   * The lever that keeps LONG videos inside the main function's 900s ceiling
   * while the account concurrency quota is low: same Lambda count, each chunk
   * renders N frames in parallel. Set 4 while capped at 8 Lambdas.
   */
  concurrencyPerLambda?: number;
  /**
   * REMOTION_MAX_CONCURRENCY: cap on concurrent render Lambdas — chunk size is
   * computed per video from its frame count so ANY length fits (long-form
   * included). Set ~8 while a fresh AWS account sits at the 10-concurrency
   * default (leaves headroom for the main invocation); clear it once the 1000
   * quota lands and Remotion auto-tunes.
   */
  maxConcurrency?: number;
};

/**
 * Chunk size that keeps a render inside `maxConcurrency` Lambdas. Remotion's
 * minimum chunk is 20 frames; ~7 frames/s/Lambda observed on 2GB means even an
 * 8-min video (~14.4k frames) at cap 8 → 1800-frame chunks ≈ 4-5 min/Lambda,
 * well inside the 900s function timeout.
 */
export function framesPerLambdaFor(totalFrames: number, maxConcurrency: number): number {
  return Math.max(20, Math.ceil(totalFrames / Math.max(1, maxConcurrency)));
}

/** presign TTL: queue + full render window with generous margin */
const ASSET_URL_TTL_SEC = 7200;
const POLL_MS = 5000;

/**
 * Non-null iff Lambda rendering is fully configured: all five REMOTION_*
 * secrets plus the S3/R2 store creds (final.mp4 is written straight to R2),
 * and not in forced-mock mode.
 */
export function getLambdaConfig(env: Record<string, string | undefined>): LambdaRenderConfig | null {
  if (env.PROVIDERS_FORCE_MOCK === "1") return null;
  const {
    REMOTION_AWS_ACCESS_KEY_ID: awsAccessKeyId,
    REMOTION_AWS_SECRET_ACCESS_KEY: awsSecretAccessKey,
    REMOTION_AWS_REGION: region,
    REMOTION_LAMBDA_FUNCTION_NAME: functionName,
    REMOTION_SERVE_URL: serveUrl,
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
  } = env;
  if (
    !awsAccessKeyId ||
    !awsSecretAccessKey ||
    !region ||
    !functionName ||
    !serveUrl ||
    !endpoint ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey
  ) {
    return null;
  }
  return {
    awsAccessKeyId,
    awsSecretAccessKey,
    region: region as AwsRegion,
    functionName,
    serveUrl,
    r2: { endpoint, bucket, accessKeyId, secretAccessKey },
    framesPerLambda: Number(env.REMOTION_FRAMES_PER_LAMBDA) || undefined,
    maxConcurrency: Number(env.REMOTION_MAX_CONCURRENCY) || undefined,
    concurrencyPerLambda: Number(env.REMOTION_CONCURRENCY_PER_LAMBDA) || undefined,
  };
}

export async function renderShortOnLambda(
  store: ObjectStore,
  input: RenderInput,
  cfg: LambdaRenderConfig,
): Promise<{ storageKey: string; renderSec: number; costUsd: number | null }> {
  const started = Date.now();
  if (!store.presignGet) {
    throw new Error(
      "Remotion Lambda requires the S3/R2 object store (presigned asset URLs); the local fs store cannot serve Lambda renderers.",
    );
  }
  // @remotion/lambda reads AWS credentials from process.env (its documented
  // rotation pattern) — the merged secrets env never mutates process.env, so
  // set them here for this call.
  process.env.REMOTION_AWS_ACCESS_KEY_ID = cfg.awsAccessKeyId;
  process.env.REMOTION_AWS_SECRET_ACCESS_KEY = cfg.awsSecretAccessKey;

  const props: ShortProps = {
    ...input.props,
    beats: await Promise.all(
      input.props.beats.map(async (b, i) => ({
        ...b,
        imageSrc: await store.presignGet!(input.imageKeys[i] ?? "", ASSET_URL_TTL_SEC),
      })),
    ),
    audioSrc: await store.presignGet(input.audioKey, ASSET_URL_TTL_SEC),
  };

  const storageKey = `productions/${input.productionId}/final.mp4`;
  const outputProvider = {
    endpoint: cfg.r2.endpoint,
    accessKeyId: cfg.r2.accessKeyId,
    secretAccessKey: cfg.r2.secretAccessKey,
  };

  const { renderId, bucketName, cloudWatchMainLogs } = await renderMediaOnLambda({
    region: cfg.region,
    functionName: cfg.functionName,
    serveUrl: cfg.serveUrl,
    composition: "Short",
    inputProps: props,
    codec: "h264",
    maxRetries: 2,
    concurrencyPerLambda: cfg.concurrencyPerLambda,
    // explicit chunk size wins; else derive from the concurrency cap so every
    // video length (long-form included) fits the account's Lambda quota
    framesPerLambda:
      cfg.framesPerLambda ??
      (cfg.maxConcurrency
        ? framesPerLambdaFor(Math.ceil(input.props.durationSec * 30 /* SHORT_FPS */), cfg.maxConcurrency)
        : undefined),
    privacy: "no-acl", // R2 has no ACLs
    deleteAfter: "7-days", // Remotion-bucket artifacts; final.mp4 lives in R2
    // overwrite (2026-07-12): final.mp4 lives at a DETERMINISTIC key per
    // production — Retry-from-render deletes the asset ROW but the old file
    // remains, and Lambda refuses to replace it by default ("Output file
    // already exists"). The DB row is the source of truth; replacing the
    // object is always the intent here.
    overwrite: true,
    outName: {
      key: storageKey,
      bucketName: cfg.r2.bucket,
      s3OutputProvider: outputProvider,
    },
  });
  console.log(
    `[render-lambda] started renderId=${renderId} bucket=${bucketName} production=${input.productionId} logs=${cloudWatchMainLogs}`,
  );

  // Poll to completion inside the step — strictly lighter than the old
  // in-process 16–28 min CPU render this replaces.
  for (;;) {
    const progress = await getRenderProgress({
      renderId,
      bucketName,
      functionName: cfg.functionName,
      region: cfg.region,
      // progress needs the same custom output creds to see the R2-written file
      s3OutputProvider: outputProvider,
    });
    if (progress.fatalErrorEncountered) {
      const detail = progress.errors?.map((e) => e.message).join(" | ") || "unknown Lambda error";
      throw new Error(`Remotion Lambda render failed (renderId=${renderId}): ${detail}`);
    }
    if (progress.done) {
      // final.mp4 was written straight to R2 by the Lambda — sanity check.
      if (!(await store.exists(storageKey))) {
        throw new Error(
          `Lambda reported done but ${storageKey} is missing from the object store (renderId=${renderId})`,
        );
      }
      return {
        storageKey,
        renderSec: (Date.now() - started) / 1000,
        costUsd: progress.costs?.accruedSoFar ?? null,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
