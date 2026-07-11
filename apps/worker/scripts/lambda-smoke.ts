import { renderMediaOnLambda, getRenderProgress } from "@remotion/lambda/client";

// Smoke-test the deployed Remotion Lambda: 6s demo props, no assets needed.
// REMOTION_AWS_ACCESS_KEY_ID/SECRET must be set; overrides via env below.
const region = (process.env.REMOTION_AWS_REGION ?? "ap-southeast-2") as "ap-southeast-2";
const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME ?? "remotion-render-4-0-484-mem2048mb-disk10240mb-900sec";
const serveUrl = process.env.REMOTION_SERVE_URL ?? "https://remotionlambda-apsoutheast2-5e4occn295.s3.ap-southeast-2.amazonaws.com/sites/ytauto/index.html";

const demoProps = {
  beats: [
    { type: "hook", text: "Ever wondered why airplane windows are round?", imageSrc: "", startSec: 0, endSec: 2.5 },
    { type: "insight", text: "Square corners concentrate stress until the fuselage cracks.", imageSrc: "", startSec: 2.5, endSec: 6 },
  ],
  captions: [
    { word: "Ever", startSec: 0.2, endSec: 0.5 },
    { word: "wondered", startSec: 0.5, endSec: 0.9 },
    { word: "why", startSec: 0.9, endSec: 1.2 },
  ],
  audioSrc: "",
  durationSec: 6,
  orientation: "portrait",
  brand: { primaryColor: "#38bdf8", font: "Inter" },
};

const started = Date.now();
const { renderId, bucketName } = await renderMediaOnLambda({
  region, functionName, serveUrl,
  composition: "Short",
  inputProps: demoProps,
  codec: "h264",
  framesPerLambda: 150,
  maxRetries: 2,
});
console.log("renderId:", renderId, "bucket:", bucketName);
for (;;) {
  const p = await getRenderProgress({ renderId, bucketName, functionName, region });
  if (p.fatalErrorEncountered) {
    console.error("FATAL:", p.errors?.map((e) => e.message).join(" | "));
    process.exit(1);
  }
  if (p.done) {
    console.log("DONE in", ((Date.now() - started) / 1000).toFixed(1) + "s",
      "| lambdas:", p.renderMetadata?.estimatedRenderLambdaInvokations,
      "| cost: $" + (p.costs?.accruedSoFar ?? 0).toFixed(4),
      "| output:", p.outputFile);
    break;
  }
  await new Promise((r) => setTimeout(r, 4000));
}
