"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Platform-wide live updates (BACKLOG #17). The cockpit is server-rendered and
 * only refetches on navigation/refresh, so background work (research,
 * productions, ideas) looks stale until the operator refreshes. This mounts once
 * in the app shell and periodically `router.refresh()`es — re-runs the current
 * route's server components with fresh data while preserving client state
 * (scroll, open tabs, form inputs). Pauses while the tab is hidden and refreshes
 * immediately on return, so it's cheap and always current.
 */
const INTERVAL_MS = 12_000;

export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const start = () => {
      if (!timer) timer = setInterval(tick, INTERVAL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router]);

  return null;
}
