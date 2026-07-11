"use client";

import type { ReactNode } from "react";

/**
 * Toggle switch (#20 polish): the toggle-first replacement for bare checkboxes.
 * With `label` it renders the full labelled row (.swrow); without, just the
 * control. Controlled: parent owns the state. When `name` is set a hidden
 * input carries the value for form posts ("on" when checked, absent when not
 * — matching native checkbox semantics).
 */
export function Switch({
  checked,
  onChange,
  label,
  hint,
  name,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  name?: string;
  disabled?: boolean;
}) {
  const control = (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={`switch${checked ? " on" : ""}`}
        onClick={() => onChange(!checked)}
      />
      {name && checked && <input type="hidden" name={name} value="on" />}
    </>
  );
  if (!label) return control;
  return (
    <div className="swrow">
      {control}
      <span className="t">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </span>
    </div>
  );
}
