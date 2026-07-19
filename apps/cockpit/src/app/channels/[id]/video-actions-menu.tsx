"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { retireProductionAction, deleteVideoAction } from "../../actions";
import { IconMore } from "@/components/icons";

/**
 * Per-row action menu on the channel Videos tab (2026-07-19 operator asks). A
 * published video's row links to its analytics page, so there was no way back
 * to the production from the list — this ⋯ menu adds "Reopen production", a
 * "View analytics" shortcut, and Retire / Delete. Delete removes the live
 * YouTube upload (when there is one) and archives; Retire only archives in the
 * tool. Closes on outside-click / Escape.
 */
export function VideoActionsMenu({
  productionId,
  channelId,
  pubId,
  isLive,
}: {
  productionId: string;
  channelId: string;
  pubId: string | null;
  /** true when a live YouTube upload exists (Delete will remove it) */
  isLive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

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

  const run = (fn: () => Promise<{ error?: string }>) =>
    startTransition(async () => {
      setError(null);
      const res = await fn();
      if (res?.error) setError(res.error);
      else {
        setOpen(false);
        router.refresh();
      }
    });

  const retire = () => {
    if (!confirm("Retire this video? It’s removed from your Videos list but stays live on YouTube (if published). You can’t easily un-retire it here.")) return;
    run(() => retireProductionAction(productionId));
  };
  const del = () => {
    const msg = isLive
      ? "Delete this video? This permanently DELETES the live video on YouTube (views/comments are lost) and archives it here. This cannot be undone."
      : "Delete this video? It’s archived and removed from your Videos list.";
    if (!confirm(msg)) return;
    run(() => deleteVideoAction(productionId));
  };

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
        <div role="menu" style={MENU}>
          <Link role="menuitem" href={`/productions/${productionId}`} onClick={() => setOpen(false)} style={ITEM}>
            Reopen production
          </Link>
          {pubId && (
            <Link role="menuitem" href={`/channels/${channelId}/videos/${pubId}`} onClick={() => setOpen(false)} style={ITEM}>
              View analytics
            </Link>
          )}
          <div style={{ height: 1, background: "var(--border)", margin: "5px 4px" }} />
          <button type="button" role="menuitem" disabled={pending} onClick={retire} style={ITEM_BTN}>
            Retire (archive in tool)
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={del}
            style={{ ...ITEM_BTN, color: "var(--danger, #dc2626)" }}
          >
            {isLive ? "Delete (remove from YouTube)" : "Delete"}
          </button>
          {error && (
            <div className="err" style={{ padding: "4px 10px", fontSize: 11.5 }}>{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

const MENU: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  right: 0,
  minWidth: 210,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  boxShadow: "var(--shadow-lg)",
  padding: 6,
  zIndex: 30,
};
const ITEM: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 7,
  fontSize: 13.5,
  fontWeight: 500,
  color: "var(--text)",
};
const ITEM_BTN: React.CSSProperties = {
  ...ITEM,
  width: "100%",
  background: "none",
  border: "none",
  textAlign: "left",
  cursor: "pointer",
};
