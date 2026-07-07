import type { ReactNode } from "react";

/**
 * Data table wrapper. The `overflow-x` wrapper satisfies the responsive
 * table-handling rule (tables scroll instead of breaking the layout on narrow
 * viewports). Use with the existing `<thead>/<tbody>` markup.
 */
export function DataTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div style={{ overflowX: "auto", width: "100%" }}>
      <table className={["data", className].filter(Boolean).join(" ")}>{children}</table>
    </div>
  );
}
