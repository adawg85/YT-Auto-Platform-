import type { ReactNode } from "react";

/** Guidance for empty screens (never leave a blank white void). */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  // Reuses main's `.placeholder` treatment so empty states look identical everywhere.
  return (
    <div className="placeholder">
      {icon ? <div className="pic">{icon}</div> : null}
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}
