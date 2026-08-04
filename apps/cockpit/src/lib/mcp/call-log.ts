/**
 * #88 — the server-side RECEIPT for MCP traffic.
 *
 * Ticket 01KYVE4AAY… reported four tools failing with a bare `No approval
 * received` while their siblings succeeded, and could not resolve its own key
 * question: is the Claude app refusing to call us, or are we rejecting? That
 * string appears nowhere in this repo, and the failing set grew to include
 * `get_production` — which has been advertised `readOnlyHint: true` all along —
 * so the tool-annotation theory is dead and the remaining theories (host-side
 * consent, session age, cumulative call count, payload size) are all
 * indistinguishable from the client.
 *
 * A receipt makes them distinguishable. Make the failing call, then read
 * `get_diagnostics().mcpCalls`:
 *  - no row for that tool at that time → the request never arrived; the fault is
 *    entirely host-side and nothing in this repo can fix it;
 *  - a row with `ok: true` → we ran it and answered; the reply was lost in
 *    transit (still host/transport-side, but a different bug);
 *  - a row with `ok: false` → it IS ours, and `error` names it.
 *
 * Recording NEVER changes the outcome of a call: every write is wrapped so a
 * logging failure (missing table before the migration deploys, DB blip) is
 * swallowed. A diagnostic that can break the thing it observes is worse than no
 * diagnostic.
 *
 * Privacy/size: argument CONTENT is never stored — only its byte size, which is
 * what a payload-limit theory needs (`author_script`'s arguments are an entire
 * script; `get_channel_analytics`'s are two scalars).
 */
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { alerts, mcpCallLog } from "@ytauto/db";
import { getAppContext } from "@/lib/context";

/** How long a receipt is worth keeping. Pruned on the rare (reconnect) calls. */
const RETENTION_DAYS = 7;
/** Default page size for the diagnostics read-back. */
const RECENT_LIMIT = 40;

export type McpCallRecord = {
  method: string;
  tool?: string | null;
  ok: boolean;
  error?: string | null;
  durationMs?: number | null;
  argsBytes?: number | null;
  /** #99: who called, and what they touched */
  caller?: McpCaller | null;
  targetChannelId?: string | null;
  targetProductionId?: string | null;
};

/**
 * #99: the identity of one MCP client, derived per request. There is no session
 * state to hang this off — each JSON-RPC call is its own HTTP request — so the
 * id is a stable DERIVATION of what the request itself reveals: the client's
 * self-reported name/version from the initialize handshake plus a hash of the
 * source address. Two calls from the same app on the same network share an id;
 * a different app, or the same app from elsewhere, does not.
 *
 * It is deliberately NOT an authentication claim (a client controls its own
 * clientInfo). It is an ATTRIBUTION signal: enough to say "these five calls came
 * from something that is not the client you are using right now", which is
 * exactly the question the operator could not answer.
 */
export type McpCaller = {
  clientName: string | null;
  clientVersion: string | null;
  /** raw source address — hashed on the way in, never stored */
  ip: string | null;
};

/** Salted, truncated hash — an identifier, not a recoverable address. */
function hashed(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 16);
}

/**
 * Stable per-client id. The salt keeps the hash from being a lookup table for
 * common IPs; it falls back to a constant so a missing env can never break
 * recording (a diagnostic must not fail the thing it observes).
 */
export function callerIdentity(caller: McpCaller | null | undefined): {
  clientId: string | null;
  clientName: string | null;
  clientVersion: string | null;
  ipHash: string | null;
} {
  if (!caller) return { clientId: null, clientName: null, clientVersion: null, ipHash: null };
  const salt = process.env.MCP_CLIENT_ID_SALT ?? "ytauto-mcp";
  const ipHash = caller.ip ? hashed(caller.ip, salt) : null;
  const name = caller.clientName?.trim() || null;
  const version = caller.clientVersion?.trim() || null;
  const material = [name ?? "unknown-client", version ?? "unknown-version", ipHash ?? "unknown-origin"].join("|");
  return { clientId: hashed(material, salt), clientName: name, clientVersion: version, ipHash };
}

/**
 * #99: tools that SPEND money or reach an external write surface. A call to one
 * of these from a client the platform has never seen before is the event worth
 * waking the operator for — the reported incident was two regenerate_thumbnail
 * calls and a refine_thumbnail, each billable, sitting silently in a receipt
 * list the operator would only read by accident.
 */
export const MCP_SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
  "author_script",
  "create_channel",
  "set_channel_config",
  "set_channel_strategy",
  "regenerate_thumbnail",
  "refine_thumbnail",
  "regenerate_shot",
  "edit_shot_prompts",
  "generate_test_scene",
  "refine_test_scene",
  "generate_brand_art",
  "generate_music",
  "create_character",
  "refine_character",
  "release_publication",
  "set_publication_metadata",
  "set_publication_schedule",
  "set_video_thumbnail",
  "retire_production",
  "correct_published_production",
  "force_forward",
  "retry_production",
  "resume_production",
  "halt_production",
]);

/**
 * Byte size of a call's arguments, without retaining them. Returns null when the
 * arguments can't be serialized (a cycle) — absence is honest, 0 would be a lie.
 */
export function mcpArgsBytes(args: unknown): number | null {
  try {
    const json = JSON.stringify(args ?? {});
    if (typeof json !== "string") return null;
    return Buffer.byteLength(json, "utf8");
  } catch {
    return null;
  }
}

/** Append one receipt. Best-effort: never throws, never blocks the call's result. */
export async function recordMcpCall(rec: McpCallRecord): Promise<void> {
  try {
    const { db } = await getAppContext();
    const who = callerIdentity(rec.caller);
    // #99: is this a client we have NEVER seen doing something billable? Decide
    // BEFORE inserting, or the row we just wrote makes every client look known.
    const sensitive = !!rec.tool && MCP_SENSITIVE_TOOLS.has(rec.tool);
    let firstSeen = false;
    if (sensitive && who.clientId) {
      const [prior] = await db
        .select({ n: sql<number>`count(*)` })
        .from(mcpCallLog)
        .where(eq(mcpCallLog.clientId, who.clientId))
        .limit(1);
      firstSeen = Number(prior?.n ?? 0) === 0;
    }
    await db.insert(mcpCallLog).values({
      id: ulid(),
      method: rec.method,
      tool: rec.tool ?? null,
      ok: rec.ok,
      // keep the message readable in a diagnostics dump, not a stack dump
      error: rec.error ? rec.error.slice(0, 500) : null,
      durationMs: rec.durationMs ?? null,
      argsBytes: rec.argsBytes ?? null,
      clientId: who.clientId,
      clientName: who.clientName,
      clientVersion: who.clientVersion,
      ipHash: who.ipHash,
      targetChannelId: rec.targetChannelId ?? null,
      targetProductionId: rec.targetProductionId ?? null,
    });
    if (firstSeen) {
      await db.insert(alerts).values({
        id: ulid(),
        channelId: rec.targetChannelId ?? null,
        kind: "capacity",
        severity: "critical",
        message:
          `UNRECOGNISED MCP CLIENT ran a billable/publishing tool: ${rec.tool} ` +
          `(client ${who.clientId}${who.clientName ? ` "${who.clientName}${who.clientVersion ? ` ${who.clientVersion}` : ""}"` : ""}, origin ${who.ipHash ?? "unknown"})` +
          `${rec.targetChannelId ? `, channel ${rec.targetChannelId}` : ""}` +
          `${rec.targetProductionId ? `, production ${rec.targetProductionId}` : ""}. ` +
          `If this was not you, ROTATE MCP_BEARER_TOKEN on /account immediately — that invalidates the old connector URL.`,
      });
    }
  } catch {
    // Swallowed by design — see the file header.
  }
}

/**
 * Prune old receipts. Called only from the connector-handshake methods
 * (initialize / tools/list), which happen once per reconnect — so retention is
 * enforced without putting a DELETE on the hot per-call path.
 */
export async function pruneMcpCallLog(): Promise<void> {
  try {
    const { db } = await getAppContext();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await db.delete(mcpCallLog).where(lt(mcpCallLog.createdAt, cutoff));
  } catch {
    // Best-effort, same as recording.
  }
}

/**
 * Read back the most recent receipts, newest first — the operator-facing half of
 * the diagnostic (surfaced by get_diagnostics).
 */
export async function recentMcpCalls(limit = RECENT_LIMIT): Promise<
  Array<{
    tool: string | null;
    method: string;
    ok: boolean;
    error: string | null;
    durationMs: number | null;
    argsBytes: number | null;
    at: Date;
    clientId: string | null;
    clientName: string | null;
    clientVersion: string | null;
    ipHash: string | null;
    targetChannelId: string | null;
    targetProductionId: string | null;
  }>
> {
  try {
    const { db } = await getAppContext();
    const rows = await db
      .select()
      .from(mcpCallLog)
      .orderBy(desc(mcpCallLog.createdAt))
      .limit(Math.max(1, Math.min(200, limit)));
    return rows.map((r) => ({
      tool: r.tool,
      method: r.method,
      ok: r.ok,
      error: r.error,
      durationMs: r.durationMs,
      argsBytes: r.argsBytes,
      at: r.createdAt,
      // #99: attribution — who ran it and what it touched
      clientId: r.clientId,
      clientName: r.clientName,
      clientVersion: r.clientVersion,
      ipHash: r.ipHash,
      targetChannelId: r.targetChannelId,
      targetProductionId: r.targetProductionId,
    }));
  } catch {
    return [];
  }
}

/**
 * #99: distinct MCP clients seen in the retention window, newest activity first.
 * The operator's real question is "is there a client here that isn't me?" — a
 * per-call list can't answer that, a roster can. Anything unexpected in this
 * list means the connector URL should be treated as leaked and the token rotated.
 */
export async function recentMcpClients(): Promise<
  Array<{
    clientId: string | null;
    clientName: string | null;
    clientVersion: string | null;
    ipHash: string | null;
    calls: number;
    sensitiveCalls: number;
    firstSeen: Date | null;
    lastSeen: Date | null;
  }>
> {
  try {
    const { db } = await getAppContext();
    const rows = await db
      .select({
        clientId: mcpCallLog.clientId,
        clientName: mcpCallLog.clientName,
        clientVersion: mcpCallLog.clientVersion,
        ipHash: mcpCallLog.ipHash,
        calls: sql<number>`count(*)`,
        sensitiveCalls: sql<number>`count(case when ${mcpCallLog.tool} = any(${sql.raw(
          `ARRAY[${[...MCP_SENSITIVE_TOOLS].map((t) => `'${t}'`).join(",")}]`,
        )}) then 1 end)`,
        firstSeen: sql<Date>`min(${mcpCallLog.createdAt})`,
        lastSeen: sql<Date>`max(${mcpCallLog.createdAt})`,
      })
      .from(mcpCallLog)
      .groupBy(mcpCallLog.clientId, mcpCallLog.clientName, mcpCallLog.clientVersion, mcpCallLog.ipHash);
    return rows
      .map((r) => ({ ...r, calls: Number(r.calls ?? 0), sensitiveCalls: Number(r.sensitiveCalls ?? 0) }))
      .sort((a, b) => new Date(b.lastSeen ?? 0).getTime() - new Date(a.lastSeen ?? 0).getTime());
  } catch {
    return [];
  }
}
