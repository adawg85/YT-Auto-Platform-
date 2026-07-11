/**
 * Deploy/refresh the Remotion Lambda render function + site (BACKLOG #18).
 *
 *   REMOTION_AWS_ACCESS_KEY_ID=… REMOTION_AWS_SECRET_ACCESS_KEY=… \
 *   REMOTION_AWS_REGION=ap-southeast-2 \
 *   pnpm --filter @ytauto/worker exec tsx scripts/remotion-lambda-deploy.ts
 *
 * Idempotent: deployFunction returns the existing function for the same
 * Remotion version/specs; the fixed siteName overwrites in place so
 * REMOTION_SERVE_URL stays stable. Rerun after any packages/video change
 * (site) or any @remotion/* version bump (function + site). Full runbook:
 * docs/LAMBDA.md.
 */
import { fileURLToPath } from "node:url";
import { deployFunction, deploySite, getOrCreateBucket } from "@remotion/lambda";
import type { AwsRegion } from "@remotion/lambda/client";

const region = (process.env.REMOTION_AWS_REGION ?? "") as AwsRegion;
if (!region) throw new Error("Set REMOTION_AWS_REGION (e.g. ap-southeast-2)");
if (!process.env.REMOTION_AWS_ACCESS_KEY_ID || !process.env.REMOTION_AWS_SECRET_ACCESS_KEY) {
  throw new Error("Set REMOTION_AWS_ACCESS_KEY_ID and REMOTION_AWS_SECRET_ACCESS_KEY (remotion-user)");
}

console.log(`[lambda-deploy] region=${region}`);

const fn = await deployFunction({
  region,
  memorySizeInMb: 2048,
  diskSizeInMb: 10240, // max — comfortably holds an 8-min 1080p concat
  timeoutInSeconds: 900, // max — protects the main/concatenation invocation
  createCloudWatchLogGroup: true,
});
console.log(`[lambda-deploy] function: ${fn.functionName} (alreadyExisted=${fn.alreadyExisted})`);

const { bucketName } = await getOrCreateBucket({
  region,
  enableFolderExpiry: true, // powers renderMediaOnLambda's deleteAfter
});
console.log(`[lambda-deploy] bucket: ${bucketName}`);

const entryPoint = fileURLToPath(import.meta.resolve("@ytauto/video/entry"));
const site = await deploySite({ entryPoint, bucketName, region, siteName: "ytauto" });
console.log(`[lambda-deploy] site: ${site.serveUrl}`);

console.log("\nPaste these on /account → Cloud render (Remotion Lambda):");
console.log(`  REMOTION_LAMBDA_FUNCTION_NAME = ${fn.functionName}`);
console.log(`  REMOTION_SERVE_URL            = ${site.serveUrl}`);
