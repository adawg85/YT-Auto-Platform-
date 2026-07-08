"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Platform-wide real-time updates (BACKLOG #17). Subscribes to the /api/live
 * Server-Sent Events stream, which pushes only when the backend actually
 * changes — so the cockpit refreshes within ~1s of a real change (research
 * finishing, a production advancing, an idea landing) and does nothing when
 * idle. router.refresh() re-fetches server data while preserving client state
 * (scroll, open tabs, inputs). Pauses while the tab is hidden; a slow poll is
 * kept as a backstop if SSE ever drops.
 */
const BACKSTOP_MS = 20_000;

export function LiveRefresh() {
  const router = useRouter();

  useEffect(() => {
    let es: EventSource | null = null;
    let backstop: ReturnType<typeof setInterval> | undefined;

    const openStream = () => {
      if (es || document.visibilityState !== "visible") return;
      es = new EventSource("/api/live");
      es.onmessage = () => router.refresh();
      // onerror: EventSource auto-reconnects; the backstop covers any gap.
    };
    const closeStream = () => {
      es?.close();
      es = null;
    };

    // backstop poll only fires when SSE isn't connected and the tab is visible
    backstop = setInterval(() => {
      if (document.visibilityState === "visible" && (!es || es.readyState !== EventSource.OPEN)) {
        router.refresh();
      }
    }, BACKSTOP_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        openStream();
        router.refresh();
      } else {
        closeStream();
      }
    };

    openStream();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (backstop) clearInterval(backstop);
      closeStream();
    };
  }, [router]);

  return null;
}
