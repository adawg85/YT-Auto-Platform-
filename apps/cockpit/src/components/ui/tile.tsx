"use client";

import type { ReactNode } from "react";
import { IconCheck } from "../icons";

/**
 * Tile picker (#20 polish) — the Profile-tab selection pattern promoted to a
 * shared primitive: an icon-art card the operator picks instead of a raw
 * select/segmented control. Controlled: parent owns the selection.
 */
export function TileGroup({ children }: { children: ReactNode }) {
  return (
    <div className="tiles" role="radiogroup">
      {children}
    </div>
  );
}

export function Tile({
  selected,
  onSelect,
  title,
  subtitle,
  art,
  wide,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** small icon art rendered in the accent square; omit for text-only tiles */
  art?: ReactNode;
  wide?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      className={`tile${selected ? " on" : ""}${wide ? " wide" : ""}`}
      onClick={onSelect}
    >
      <span className="ck">
        <IconCheck />
      </span>
      {art && <span className="art">{art}</span>}
      <span className="tl">{title}</span>
      {subtitle && <span className="ts">{subtitle}</span>}
    </button>
  );
}
