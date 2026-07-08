"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Live plan/research updates (BACKLOG #17). The research runs async in the
 * worker, which can't revalidate the cockpit — so the Plan tab polls itself.
 * Polls `router.refresh()` (re-runs the force-dynamic server component) while
 * any episode is actively researching, plus a window right after "Plan /
 * research now" is clicked to cover the gap before the planner has created
 * episodes. Shows a live "researching…" chip so it never looks stuck.
 */
export function PlanLive({
  action,
  activeCount,
}: {
  action: () => Promise<void>;
  activeCount: number;
}) {
  const router = useRouter();
  const [kick, setKick] = useState(false);
  const polling = activeCount > 0 || kick;

  useEffect(() => {
    if (!polling) return;
    const iv = setInterval(() => router.refresh(), 4000);
    // stop the post-click window after 2.5 min if nothing is progressing
    const stop = kick ? setTimeout(() => setKick(false), 150_000) : undefined;
    return () => {
      clearInterval(iv);
      if (stop) clearTimeout(stop);
    };
  }, [polling, kick, router]);

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <form action={action} onSubmit={() => setKick(true)}>
        <button type="submit" className="btn">
          Plan / research now
        </button>
      </form>
      {polling && (
        <span className="chip warn live">
          <span className="d" />
          Researching{activeCount > 0 ? ` · ${activeCount} in progress` : "…"} · updates live
        </span>
      )}
    </div>
  );
}
