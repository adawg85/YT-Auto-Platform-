"use client";

import type { ReactNode } from "react";

/**
 * Number stepper (#20 polish): −/value/+ replaces bare number inputs so every
 * numeric setting reads as a control with a unit, not a mystery field. With
 * `label` it renders the full labelled row (.steprow). Controlled.
 */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  format,
  label,
  hint,
  name,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** render the value with a unit, e.g. (v) => `${v} wk` */
  format?: (v: number) => string;
  label?: ReactNode;
  hint?: ReactNode;
  name?: string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const control = (
    <span className="stepbox">
      <button type="button" aria-label="Decrease" onClick={() => onChange(clamp(value - step))}>
        −
      </button>
      <span className="v num">{format ? format(value) : value}</span>
      <button type="button" aria-label="Increase" onClick={() => onChange(clamp(value + step))}>
        +
      </button>
      {name && <input type="hidden" name={name} value={value} />}
    </span>
  );
  if (!label) return control;
  return (
    <div className="steprow">
      <span className="t">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </span>
      {control}
    </div>
  );
}
