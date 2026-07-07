import type { ReactNode } from "react";

/** Simple bordered surface with padding (replaces ad-hoc `.card`). */
export function Card({ children, className, style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={["card", className].filter(Boolean).join(" ")} style={style}>
      {children}
    </div>
  );
}

/** Panel = titled surface with a header row and a body (replaces `.panel`). */
export function Panel({
  title,
  action,
  flush,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  flush?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={["panel", className].filter(Boolean).join(" ")}>
      {(title || action) && (
        <div className="panel-head">
          {typeof title === "string" ? <h3>{title}</h3> : title}
          {action}
        </div>
      )}
      <div className={flush ? "panel-body flush" : "panel-body"}>{children}</div>
    </div>
  );
}
