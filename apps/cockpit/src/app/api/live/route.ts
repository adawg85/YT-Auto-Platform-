import { sql } from "drizzle-orm";
import { getAppContext } from "@/lib/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Real-time change feed (BACKLOG #17). A Server-Sent Events stream that watches
 * a cheap "activity marker" (max updated_at + row counts across the high-churn
 * tables) and pushes ONLY when something actually changes — so the cockpit
 * updates within ~1s of a real change and does nothing when idle, instead of
 * every tab blind-refreshing on a timer. The client refreshes on each push.
 */
const POLL_MS = 1000;
const KEEPALIVE_EVERY = 20; // ticks → ~20s heartbeat

async function activityMarker(db: Awaited<ReturnType<typeof getAppContext>>["db"]): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT concat_ws('|',
      coalesce(extract(epoch from (SELECT max(updated_at) FROM productions))::bigint::text, '0'),
      (SELECT count(*) FROM productions)::text,
      coalesce(extract(epoch from (SELECT max(updated_at) FROM episodes))::bigint::text, '0'),
      coalesce(extract(epoch from (SELECT max(updated_at) FROM claims))::bigint::text, '0'),
      (SELECT count(*) FROM claims)::text,
      coalesce(extract(epoch from (SELECT max(updated_at) FROM ideas))::bigint::text, '0'),
      (SELECT count(*) FROM ideas)::text,
      coalesce(extract(epoch from (SELECT max(updated_at) FROM publications))::bigint::text, '0'),
      coalesce(extract(epoch from (SELECT max(updated_at) FROM channel_briefings))::bigint::text, '0'),
      coalesce(extract(epoch from (SELECT max(created_at) FROM alerts WHERE status='open'))::bigint::text, '0')
    ) AS marker
  `)) as unknown as { rows?: { marker: string }[] } | { marker: string }[];
  // drizzle/postgres-js returns an array of rows directly
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  return (list[0] as { marker?: string } | undefined)?.marker ?? "";
}

export async function GET(req: Request) {
  const { db } = await getAppContext();
  const encoder = new TextEncoder();
  let last = "";
  let ticks = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* closed */
        }
      };
      // prime the marker so we don't fire on connect
      try {
        last = await activityMarker(db);
      } catch {
        /* ignore */
      }
      enqueue(": connected\n\n");

      const timer = setInterval(async () => {
        try {
          const marker = await activityMarker(db);
          if (marker && marker !== last) {
            last = marker;
            enqueue(`data: ${marker}\n\n`);
          } else if (++ticks % KEEPALIVE_EVERY === 0) {
            enqueue(": ping\n\n");
          }
        } catch {
          /* transient — keep the stream open */
        }
      }, POLL_MS);

      req.signal.addEventListener("abort", () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
