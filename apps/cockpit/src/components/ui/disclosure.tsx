import type { ReactNode } from "react";

/**
 * Progressive disclosure (#20 polish): native <details> with the cockpit's
 * caret style — explanations, advanced fields and long lists live behind one
 * of these instead of sitting on the page. Server-component friendly (no JS).
 */
export function Disclosure({
  summary,
  children,
  defaultOpen,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details className={className ? `disc ${className}` : "disc"} open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="disc-body">{children}</div>
    </details>
  );
}
