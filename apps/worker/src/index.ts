import { createServer } from "node:http";
import { serve } from "inngest/node";
import { inngest } from "@ytauto/core";
import { productionPipeline } from "./functions/production-pipeline";

const handler = serve({
  client: inngest,
  functions: [productionPipeline],
});

const port = Number(process.env.WORKER_PORT ?? "3010");

createServer((req, res) => {
  if (req.url?.startsWith("/api/inngest")) {
    return handler(req, res);
  }
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  res.writeHead(404);
  res.end();
}).listen(port, () => {
  console.log(`[worker] listening on :${port} (inngest at /api/inngest)`);
});
