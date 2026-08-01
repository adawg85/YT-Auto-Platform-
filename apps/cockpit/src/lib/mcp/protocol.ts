/**
 * BACKLOG #36 — minimal, spec-compliant MCP server over JSON-RPC 2.0.
 *
 * Hand-rolled (no @modelcontextprotocol/sdk dependency) so the cockpit bundle
 * stays lean and there's zero install/build risk. It implements exactly the
 * Streamable-HTTP surface a remote connector needs: initialize, tools/list,
 * tools/call, ping, and the initialized notification. The HTTP layer (route.ts)
 * owns transport (auth, POST/GET, JSON responses); this owns the protocol.
 */
import { MCP_TOOLS, MCP_TOOLS_BY_NAME, READ_ONLY_TOOLS } from "./tools";
import { mcpArgsBytes, pruneMcpCallLog, recordMcpCall } from "./call-log";

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
      // #88: a handshake receipt is the only server-side proof that a connector
      // RECONNECT actually happened — the step every ticket resolution asks the
      // operator to perform, and the one nobody could confirm afterwards.
      // Handshakes are rare, so this is also where retention gets enforced.
      await recordMcpCall({ method: req.method, tool: null, ok: true });
      await pruneMcpCallLog();
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
      // #88: records WHEN the client last re-read the tool list — the difference
      // between "the fix isn't deployed" and "your cached tool list is stale".
      await recordMcpCall({ method: req.method, tool: null, ok: true });
      return ok(id, {
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          // readOnlyHint lets the Claude app auto-surface pure reads without a
          // per-call approval prompt; mutating tools omit it so they still gate.
          annotations: { readOnlyHint: READ_ONLY_TOOLS.has(t.name) },
        })),
      });
    case "tools/call": {
      const name = req.params?.name as string;
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      // #88: measure and RECORD every call that reaches us. The ticket's open
      // question — is `No approval received` the app refusing to call us, or us
      // rejecting? — is only answerable with a server-side receipt. The write is
      // awaited (one small insert) rather than fired-and-forgotten, because a
      // serverless freeze right after the response is exactly the case the
      // receipt has to survive; it can never FAIL the call (see call-log.ts).
      const startedAt = Date.now();
      const argsBytes = mcpArgsBytes(args);
      const tool = name ? MCP_TOOLS_BY_NAME.get(name) : undefined;
      if (!tool) {
        const message = `Unknown tool: ${name ?? "(none)"}`;
        await recordMcpCall({ method: req.method, tool: name ?? null, ok: false, error: message, argsBytes, durationMs: Date.now() - startedAt });
        return err(id, -32602, message);
      }
      try {
        const result = await tool.execute(args);
        await recordMcpCall({ method: req.method, tool: name, ok: true, argsBytes, durationMs: Date.now() - startedAt });
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        });
      } catch (e) {
        // Tool-level failures are returned as isError content (per MCP), not a
        // JSON-RPC protocol error, so the model can read and recover from them.
        const message = e instanceof Error ? e.message : String(e);
        await recordMcpCall({ method: req.method, tool: name, ok: false, error: message, argsBytes, durationMs: Date.now() - startedAt });
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
