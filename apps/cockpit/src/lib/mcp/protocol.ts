/**
 * BACKLOG #36 — minimal, spec-compliant MCP server over JSON-RPC 2.0.
 *
 * Hand-rolled (no @modelcontextprotocol/sdk dependency) so the cockpit bundle
 * stays lean and there's zero install/build risk. It implements exactly the
 * Streamable-HTTP surface a remote connector needs: initialize, tools/list,
 * tools/call, ping, and the initialized notification. The HTTP layer (route.ts)
 * owns transport (auth, POST/GET, JSON responses); this owns the protocol.
 */
import { MCP_TOOLS, MCP_TOOLS_BY_NAME } from "./tools";

/** Protocol version we advertise; we also echo a client's requested version. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "ytauto-cockpit", version: "1.0.0" } as const;

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A notification (no id, or a `notifications/*` method) expects no response. */
export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined || req.method.startsWith("notifications/");
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null for
 * notifications (which the transport answers with 202 + empty body).
 */
export async function handleJsonRpc(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  if (isNotification(req)) return null; // initialized, cancelled, progress, …

  switch (req.method) {
    case "initialize": {
      const requested = (req.params?.protocolVersion as string) || MCP_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "YT-Auto platform control plane. Read intel with get_intel / get_channel_state / " +
          "get_playbook, then act with seed_idea, propose_channel, and create_channel. " +
          "Every mutation is logged as an operator decision.",
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const name = req.params?.name as string;
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      const tool = name ? MCP_TOOLS_BY_NAME.get(name) : undefined;
      if (!tool) return err(id, -32602, `Unknown tool: ${name ?? "(none)"}`);
      try {
        const result = await tool.execute(args);
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        });
      } catch (e) {
        // Tool-level failures are returned as isError content (per MCP), not a
        // JSON-RPC protocol error, so the model can read and recover from them.
        const message = e instanceof Error ? e.message : String(e);
        return ok(id, {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        });
      }
    }
    default:
      return err(id, -32601, `Method not found: ${req.method}`);
  }
}
