"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { StatusSummary } from "@/lib/status";

/**
 * System-status strip (task #21): "N in production · N scheduled · N need
 * you · N failed" — the always-visible answer to "is anything moving, is
 * anything stuck". Render-style status language.
 *
 * `StatusStrip` is the presentational strip (server-safe). `SystemStatus`
 * is the self-updating topbar variant: it polls /api/status/summary on a
 * slow interval while the tab is visible (the SSE feed already refreshes
 * server components; the topbar lives in the client shell, so it fetches
 * its own numbers).
 */

export function StatusStrip({ summary, showIdle = false }: { summary: StatusSummary; showIdle?: boolean }) {
  const segs = [
    {
      n: summary.working,
      label: "in production",
      cls: "chip acc live",
      href: null as string | null,
    },
    { n: summary.scheduled, label: "scheduled", cls: "chip acc", href: null },
    { n: summary.waiting, label: summary.waiting === 1 ? "needs you" : "need you", cls: "chip warn", href: "/gates" },
    { n: summary.failed, label: "failed", cls: "chip crit", href: "/gates" },
  ].filter((s) => s.n > 0);

  if (segs.length === 0) {
    return showIdle ? (
      <span className="sysstatus">
        <span className="chip">
          <span className="d" />
          All quiet — nothing in flight
        </span>
      </span>
    ) : null;
  }

  return (
    <span className="sysstatus">
      {segs.map((s) =>
        s.href ? (
          <Link key={s.label} href={s.href} className={s.cls}>
            <span className="d" />
            {s.n} {s.label}
          </Link>
        ) : (
          <span key={s.label} className={s.cls}>
            <span className="d" />
            {s.n} {s.label}
          </span>
        ),
      )}
    </span>
  );
}

const POLL_MS = 15_000;

export function SystemStatus() {
  const [summary, setSummary] = useState<StatusSummary | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/status/summary", { cache: "no-store" });
        if (res.ok && !stop) setSummary(await res.json());
      } catch {
        /* transient — keep the last numbers */
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      stop = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  if (!summary) return null;
  return <StatusStrip summary={summary} />;
}
