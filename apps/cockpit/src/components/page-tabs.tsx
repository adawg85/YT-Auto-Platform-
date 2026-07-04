"use client";
import { useState, type ReactNode } from "react";

export type Tab = { key: string; label: string; badge?: number | string | null; panel: ReactNode };

// Page-level tab strip that runs across the top of the content area (not the
// global nav). Panels are server-rendered and passed in as props.
export function PageTabs({ tabs, initial }: { tabs: Tab[]; initial?: string }) {
  const [active, setActive] = useState(initial ?? tabs[0]?.key);
  return (
    <>
      <div className="ptabs">
        {tabs.map((t) => (
          <button key={t.key} className={t.key === active ? "on" : ""} onClick={() => setActive(t.key)}>
            {t.label}
            {t.badge != null && t.badge !== "" ? <span className="n">{t.badge}</span> : null}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.key} className="tabpanel" hidden={t.key !== active}>
          {t.panel}
        </div>
      ))}
    </>
  );
}
