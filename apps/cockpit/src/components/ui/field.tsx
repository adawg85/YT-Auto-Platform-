import type { ComponentProps, ReactNode } from "react";

/** Labelled form field. Wrap any input; the label + hint are consistent. */
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label>
      {label}
      {hint ? <span className="muted"> {hint}</span> : null}
      {children}
    </label>
  );
}

export function Input(props: ComponentProps<"input">) {
  return <input type="text" {...props} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea {...props} />;
}

export function Select(props: ComponentProps<"select">) {
  return <select {...props} />;
}
