import { createServer } from "node:http";
import { serve } from "inngest/node";
import { inngest } from "@ytauto/core";
import { productionPipeline } from "./functions/production-pipeline";
import { analyticsIngest } from "./functions/analytics-ingest";
import { trendScan } from "./functions/trend-scan";
import { videoAnalysis } from "./functions/analysis";
import { marketScan } from "./functions/market-scan";
import { editorialPlan } from "./functions/editorial-plan";
import { editorialGapfill } from "./functions/editorial-gapfill";
import { deriveShortsFn } from "./functions/derive-shorts";
import { publishClipFn } from "./functions/publish-clip";
import { publishFinalize } from "./functions/publish-finalize";
import { dataJanitor } from "./functions/data-janitor";
import { ideaAutoscore } from "./functions/idea-autoscore";
import { episodeResearch } from "./functions/episode-research";
import { editorialPostpublish } from "./functions/editorial-postpublish";
import { operatorBriefing } from "./functions/operator-briefing";
import { evalHarness } from "./functions/eval-harness";
import { channelRetroFn } from "./functions/channel-retro";
import { getContext } from "./context";

const handler = serve({
  client: inngest,
  functions: [
    productionPipeline,
    analyticsIngest,
    trendScan,
    videoAnalysis,
    marketScan,
    editorialPlan,
    editorialGapfill,
    deriveShortsFn,
    publishClipFn,
    publishFinalize,
    episodeResearch,
    editorialPostpublish,
    operatorBriefing,
    dataJanitor,
    ideaAutoscore,
    evalHarness,
    channelRetroFn,
  ],
  // In containers the SDK must advertise a URL the Inngest server can reach
  // (e.g. http://worker:3010) — registering via localhost would make the
  // server call itself back and fail with "Unable to reach SDK URL".
  serveHost: process.env.INNGEST_SERVE_HOST,
});

// PORT is what PaaS platforms (Render, Railway, Fly) inject; WORKER_PORT is
// the local-dev override. render.ts derives the same value for /store URLs.
const port = Number(process.env.PORT ?? process.env.WORKER_PORT ?? "3010");

const MIME_BY_EXT: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
};

createServer(async (req, res) => {
  if (req.url?.startsWith("/api/inngest")) {
    return handler(req, res);
  }
  // serves stored assets to the local Remotion render browser — which runs on
  // THIS host, so loopback only. Anything else gets 404: these are private R2
  // objects (finished masters included) and must not be publicly downloadable.
  if (req.url?.startsWith("/store/")) {
    const remote = req.socket.remoteAddress ?? "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.writeHead(404);
      return res.end();
    }
    const key = decodeURIComponent(req.url.slice("/store/".length));
    try {
      const { providers } = await getContext();
      const { stream, mimeType } = await providers.store.getStream(key);
      const ext = key.split(".").pop() ?? "";
      res.writeHead(200, {
        "content-type": mimeType ?? MIME_BY_EXT[ext] ?? "application/octet-stream",
      });
      return stream.pipe(res);
    } catch {
      res.writeHead(404);
      return res.end();
    }
  }
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  res.writeHead(404);
  res.end();
}).listen(port, () => {
  console.log(`[worker] listening on :${port} (inngest at /api/inngest, assets at /store)`);
});
