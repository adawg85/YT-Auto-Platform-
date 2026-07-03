import { createServer } from "node:http";
import { serve } from "inngest/node";
import { inngest } from "@ytauto/core";
import { productionPipeline } from "./functions/production-pipeline";
import { analyticsIngest } from "./functions/analytics-ingest";
import { getContext } from "./context";

const handler = serve({
  client: inngest,
  functions: [productionPipeline, analyticsIngest],
});

const port = Number(process.env.WORKER_PORT ?? "3010");

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
  // serves stored assets to the local Remotion render browser
  if (req.url?.startsWith("/store/")) {
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
