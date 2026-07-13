"use client";
import { useEffect, useState, type ReactNode } from "react";

/** #23.4: optional tab grouping — a small colored dot cues which family a tab
 * belongs to (monitoring = accent, production = good, settings = muted). */
export type TabGroup = "monitoring" | "production" | "settings";

export type Tab = {
  key: string;
  label: string;
  badge?: number | string | null;
  group?: TabGroup;
  panel: ReactNode;
};

const GROUP_DOT: Record<TabGroup, string> = {
  monitoring: "var(--accent)",
  production: "var(--good)",
  settings: "var(--muted)",
};

// Page-level tab strip that runs across the top of the content area (not the
// global nav). Panels are server-rendered and passed in as props.
//
// The active tab is persisted in the URL query (?tab=) via history.replaceState
// — NOT ephemeral state alone. A router.refresh() (live-refresh SSE, or a
// schedule drag-drop) re-runs the async server page, shows the loading
// skeleton, and REMOUNTS this component; without URL persistence the tab reset
// to the first one (the "drag flicked me back to Overview" bug). Reading the
// URL on mount restores it, and tabs become deep-linkable. window/history are
// touched only in effects/handlers, so there's no useSearchParams Suspense
// requirement and it works on any (static or dynamic) page.
export function PageTabs({ tabs, initial, param = "tab" }: { tabs: Tab[]; initial?: string; param?: string }) {
  const [active, setActive] = useState(initial ?? tabs[0]?.key);

  // restore from the URL on (re)mount — survives refresh/remount
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get(param);
    if (fromUrl && tabs.some((t) => t.key === fromUrl)) setActive(fromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function select(key: string) {
    setActive(key);
    const url = new URL(window.location.href);
    url.searchParams.set(param, key);
    window.history.replaceState(null, "", url.toString());
  }

  return (
    <>
      <div className="ptabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === active}
            className={t.key === active ? "on" : ""}
            onClick={() => select(t.key)}
          >
            {t.group ? <span className="gdot" style={{ background: GROUP_DOT[t.group] }} /> : null}
            {t.label}
            {t.badge != null && t.badge !== "" ? <span className="n">{t.badge}</span> : null}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.key} className="tabpanel" role="tabpanel" hidden={t.key !== active}>
          {t.panel}
        </div>
      ))}
    </>
  );
}
