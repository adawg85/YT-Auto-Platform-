/** Shimmering placeholder for async content (replaces blank loading screens). */
export function Skeleton({
  w,
  h = 12,
  className,
  style,
}: {
  w?: number | string;
  h?: number | string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={["skeleton", className].filter(Boolean).join(" ")}
      style={{ width: w ?? "100%", height: h, ...style }}
    />
  );
}

/** A few stacked skeleton lines for text blocks. */
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={`skeleton line${i === lines - 1 ? " sm" : ""}`} />
      ))}
    </div>
  );
}
