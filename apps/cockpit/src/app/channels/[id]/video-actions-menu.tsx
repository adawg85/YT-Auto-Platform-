"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconMore } from "@/components/icons";

/**
 * Per-row action menu on the channel Videos tab (2026-07-19 operator ask). A
 * published video's row links to its analytics page, so there was no way to get
 * back to the production from the list — this ⋯ menu adds "Reopen production"
 * (lands on the production page, where the shots + "Make a corrected copy" panel
 * live) and a shortcut to the analytics view. Closes on outside-click / Escape.
 */
export function VideoActionsMenu({
  productionId,
  channelId,
  pubId,
}: {
  productionId: string;
  channelId: string;
  pubId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        className="btn ghost sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Video actions"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{ padding: "4px 8px" }}
      >
        <IconMore />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 190,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "var(--shadow-lg)",
            padding: 6,
            zIndex: 30,
          }}
        >
          <Link
            role="menuitem"
            href={`/productions/${productionId}`}
            onClick={() => setOpen(false)}
            style={menuItemStyle}
          >
            Reopen production
          </Link>
          {pubId && (
            <Link
              role="menuitem"
              href={`/channels/${channelId}/videos/${pubId}`}
              onClick={() => setOpen(false)}
              style={menuItemStyle}
            >
              View analytics
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 7,
  fontSize: 13.5,
  fontWeight: 500,
  color: "var(--text)",
};
