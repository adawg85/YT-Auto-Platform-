/**
 * BACKLOG #36 — Claude-app MCP connector endpoint (Streamable HTTP transport).
 *
 * Add this URL as a custom connector in the Claude desktop/mobile app with the
 * bearer token set on /account (MCP_BEARER_TOKEN). Then channel ideation happens
 * in a normal Claude chat grounded in the platform's real intel, and the action
 * tools (seed_idea / propose_channel / create_channel) act on the platform.
 *
 * Auth: guarded by MCP_BEARER_TOKEN (NOT the operator basic-auth password). The
 * middleware exempts /api/mcp from Basic auth; this handler enforces the bearer.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getMergedEnv } from "@/lib/context";
import {
  handleJsonRpc,
  isNotification,
  MCP_PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@/lib/mcp/protocol";

export const runtime = "nodejs"; // DB + secrets + agents — never Edge
export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: { ...CORS_HEADERS, "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}

/**
 * Constant-time-ish bearer check. Returns null on success, or a Response to
 * short-circuit with. A missing MCP_BEARER_TOKEN means the connector isn't set
 * up yet — say so clearly rather than silently 401ing.
 */
async function authorize(req: NextRequest): Promise<NextResponse | null> {
  const env = await getMergedEnv();
  const expected = env.MCP_BEARER_TOKEN?.trim();
  if (!expected) {
    return json(
      {
        error:
          "MCP connector is not configured. Set MCP_BEARER_TOKEN on /account (Claude MCP connector) to enable this endpoint.",
      },
      { status: 503 },
    );
  }
  // Accept the token two ways. Claude's custom-connector dialog has no
  // static-token field (only OAuth or no-auth), so the practical path for a
  // single operator is a no-auth connector with the token in the URL
  // (?key=…). A standard `Authorization: Bearer …` header still works for
  // curl / SDK clients.
  const header = req.headers.get("authorization") ?? "";
  const headerToken = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const queryToken = (req.nextUrl.searchParams.get("key") ?? req.nextUrl.searchParams.get("token") ?? "").trim();
  const token = headerToken || queryToken;
  if (!token || token !== expected) {
    return json(
      { error: "Unauthorized — send Authorization: Bearer <MCP_BEARER_TOKEN>." },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="ytauto-mcp"' } },
    );
  }
  return null;
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * GET serves two callers:
 *  - an MCP client opening the server→client SSE stream (Accept: text/event-stream)
 *    — we hold an idle keep-alive stream open (SDK-compatible; we have no
 *    server-initiated messages);
 *  - a browser/curl hitting the URL — a friendly health check that confirms the
 *    deploy is live and the ?key= token is valid (the operator's one-tap test).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = await authorize(req);
  if (denied) return denied;
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": ytauto mcp stream open\n\n"));
        // no server-initiated messages — leave the stream open for the client
      },
    });
    return new NextResponse(stream, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }
  return json({
    ok: true,
    server: "ytauto-cockpit",
    transport: "streamable-http",
    protocol: MCP_PROTOCOL_VERSION,
    hint: "This is the YT-Auto MCP endpoint. MCP clients POST JSON-RPC here; the token is valid.",
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = await authorize(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, {
      status: 400,
    });
  }

  // A JSON-RPC message MAY be a single object or a batch array.
  const batch = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
  if (batch.length === 0) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Empty batch" } }, {
      status: 400,
    });
  }

  const responses: JsonRpcResponse[] = [];
  for (const msg of batch) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      responses.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      continue;
    }
    const res = await handleJsonRpc(msg);
    if (res) responses.push(res);
  }

  // All messages were notifications/responses → nothing to return (202 Accepted).
  if (responses.length === 0) {
    const allNotifications = batch.every(
      (m) => m && m.jsonrpc === "2.0" && typeof m.method === "string" && isNotification(m),
    );
    return new NextResponse(null, { status: allNotifications ? 202 : 204, headers: CORS_HEADERS });
  }

  // Streamable HTTP: when the client accepts an event stream (the Claude
  // connector and the reference SDK both send `Accept: …text/event-stream`),
  // reply as SSE — one `message` event per JSON-RPC response, then close the
  // stream. Clients that only accept JSON get a plain JSON body instead.
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) {
    const sse = responses.map((r) => `event: message\ndata: ${JSON.stringify(r)}\n\n`).join("");
    return new NextResponse(sse, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }

  return json(Array.isArray(body) ? responses : responses[0]);
}
