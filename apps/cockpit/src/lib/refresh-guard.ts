"use client";

import { useEffect } from "react";

/**
 * Live-refresh guard (2026-07-16). The platform-wide <LiveRefresh> calls
 * router.refresh() on every SSE push (~1s during active backend work) and on a
 * 20s backstop. On this app a refresh re-runs the async server page through its
 * loading.tsx and REMOUNTS the tab panels (see components/page-tabs.tsx) — which
 * re-initialises every form's useState from server props. That silently wipes an
 * operator's in-progress edits (the "Save profile reverts my dropdowns" bug).
 *
 * A form with unsaved changes holds this guard; LiveRefresh skips refreshing
 * while any hold is active, then fires one catch-up refresh once the last hold
 * releases (on save or discard). Module-level state is fine — it's client-only
 * and there is a single LiveRefresh mounted per document.
 */
let holds = 0;
const releaseListeners = new Set<() => void>();

/** Acquire a hold; returns an idempotent release fn. */
export function acquireRefreshHold(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds === 0) releaseListeners.forEach((l) => l());
  };
}

/** True while any form is holding refresh (has unsaved edits / is focused). */
export function isRefreshHeld(): boolean {
  return holds > 0;
}

/** Subscribe to "all holds released" so LiveRefresh can catch up. */
export function onRefreshReleased(cb: () => void): () => void {
  releaseListeners.add(cb);
  return () => releaseListeners.delete(cb);
}

/**
 * Hold live-refresh while `active` is true (typically: the form is dirty or
 * focused). Releases automatically on unmount or when `active` goes false.
 */
export function useRefreshHold(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const release = acquireRefreshHold();
    return release;
  }, [active]);
}
