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
import { ulid } from "ulid";
import { desc, lt } from "drizzle-orm";
import { mcpCallLog } from "@ytauto/db";
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
};

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
    await db.insert(mcpCallLog).values({
      id: ulid(),
      method: rec.method,
      tool: rec.tool ?? null,
      ok: rec.ok,
      // keep the message readable in a diagnostics dump, not a stack dump
      error: rec.error ? rec.error.slice(0, 500) : null,
      durationMs: rec.durationMs ?? null,
      argsBytes: rec.argsBytes ?? null,
    });
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
    }));
  } catch {
    return [];
  }
}
