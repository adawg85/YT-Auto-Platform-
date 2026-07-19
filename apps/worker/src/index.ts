import { createServer } from "node:http";
import { serve } from "inngest/node";
import { inngest } from "@ytauto/core";
import { serviceVersions } from "@ytauto/db";
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
import { supersedeCleanup } from "./functions/supersede-cleanup";
import { dataJanitor } from "./functions/data-janitor";
import { ideaAutoscore } from "./functions/idea-autoscore";
import { episodeResearch } from "./functions/episode-research";
import { editorialPostpublish } from "./functions/editorial-postpublish";
import { operatorBriefing } from "./functions/operator-briefing";
import { evalHarness } from "./functions/eval-harness";
import { channelRetroFn } from "./functions/channel-retro";
import { styleDistill } from "./functions/style-distill";
import { clipGenerate } from "./functions/clip-generate";
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
    supersedeCleanup,
    episodeResearch,
    editorialPostpublish,
    operatorBriefing,
    dataJanitor,
    ideaAutoscore,
    evalHarness,
    channelRetroFn,
    styleDistill,
    clipGenerate,
  ],
  // In containers the SDK must advertise a URL the Inngest server can reach
  // (e.g. http://worker:3010) — registering via localhost would make the
  // server call itself back and fail with "Unable to reach SDK URL".
  // RENDER_EXTERNAL_URL is Render's injected public URL for this service —
  // without a serve host the SDK derives it from the sync request's Host
  // header, and the boot self-sync below would advertise localhost (seen
  // live 2026-07-14: "Cannot deploy localhost functions to production").
  serveHost: process.env.INNGEST_SERVE_HOST ?? process.env.RENDER_EXTERNAL_URL,
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
  // Stamp the deployed build so the cockpit can show whether the WORKER
  // (pipeline) build is live yet (2026-07-19 operator: "add the deploy version").
  void (async () => {
    try {
      const { db } = await getContext();
      const commit = (process.env.RENDER_GIT_COMMIT ?? "dev").slice(0, 7);
      await db
        .insert(serviceVersions)
        .values({ service: "worker", commit, bootedAt: new Date() })
        .onConflictDoUpdate({ target: serviceVersions.service, set: { commit, bootedAt: new Date() } });
      console.log(`[worker] build ${commit} stamped`);
    } catch (err) {
      console.error("[worker] version stamp failed:", err);
    }
  })();
  // Self-register with Inngest on boot (2026-07-14): every NEW function used
  // to need a manual `curl -X PUT …/api/inngest` after deploy (the standing
  // HANDOFF gotcha) — a forgotten sync sent fresh events into the void, e.g.
  // the first async style-distill. A PUT against our own handler makes the
  // SDK push the CURRENT function config to Inngest; retried because the
  // platform router can lag a few seconds behind listen().
  // Only self-sync when a PUBLIC serve host is known — a localhost-derived
  // registration poisons the prod app ("Cannot deploy localhost functions").
  const publicHost = process.env.INNGEST_SERVE_HOST ?? process.env.RENDER_EXTERNAL_URL;
  if (!publicHost) {
    console.log("[worker] inngest self-sync skipped (no INNGEST_SERVE_HOST/RENDER_EXTERNAL_URL — dev?)");
    return;
  }
  const selfSync = async (attempt = 1): Promise<void> => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/inngest`, { method: "PUT" });
      console.log(`[worker] inngest self-sync as ${publicHost}: ${res.ok ? "ok" : "failed"} (${res.status})`);
      if (!res.ok && attempt < 5) setTimeout(() => void selfSync(attempt + 1), attempt * 5000);
    } catch (err) {
      if (attempt < 5) return void setTimeout(() => void selfSync(attempt + 1), attempt * 5000);
      console.error("[worker] inngest self-sync failed — run the manual PUT:", err);
    }
  };
  setTimeout(() => void selfSync(), 3000);
});
