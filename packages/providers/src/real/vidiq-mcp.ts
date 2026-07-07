import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { VidiqCaller } from "./research";

/**
 * MCP-client transport for the vidIQ real research adapter. vidIQ exposes an
 * MCP server (not a REST API), so the deployed worker speaks MCP to it: connect
 * once (lazily, memoised), then callTool per request. The vidIQ→ResearchProvider
 * mapping lives in ./research and consumes this via the `VidiqCaller` seam, so
 * the mapping is unit-testable without a live connection.
 *
 * The endpoint + auth are env-configured (VIDIQ_MCP_URL, VIDIQ_API_KEY) because
 * vidIQ's MCP URL/auth scheme isn't a stable public contract — override if it
 * differs from the default.
 */
export function createVidiqMcpCaller(cfg: {
  url: string;
  apiKey: string;
  clientName?: string;
}): VidiqCaller {
  let clientPromise: Promise<Client> | null = null;

  async function getClient(): Promise<Client> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
        });
        const client = new Client({ name: cfg.clientName ?? "ytauto-worker", version: "1.0.0" });
        await client.connect(transport);
        return client;
      })();
      // don't cache a failed connection
      clientPromise.catch(() => {
        clientPromise = null;
      });
    }
    return clientPromise;
  }

  return async (tool, args) => {
    const client = await getClient();
    const res = await client.callTool({ name: tool, arguments: args });
    const blocks = Array.isArray(res.content)
      ? (res.content as Array<{ type?: string; text?: string }>)
      : [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (res.isError) throw new Error(text || `vidiq tool ${tool} returned an error`);
    return text;
  };
}
