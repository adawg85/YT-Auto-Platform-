import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";

/**
 * Instant navigation skeleton (perf, #responsiveness). A `force-dynamic` page
 * blocks on its server render; without a loading state the screen sits frozen
 * until the query waterfall finishes. This shows immediately on navigation so
 * the app feels responsive while the real data streams in.
 */
export default function ChannelLoading() {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
        <Skeleton w={56} h={56} style={{ borderRadius: 12 }} />
        <div style={{ flex: 1 }}>
          <Skeleton w={220} h={22} />
          <div style={{ height: 8 }} />
          <Skeleton w={320} h={14} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} w={90} h={30} style={{ borderRadius: 8 }} />
        ))}
      </div>
      <div className="kpis">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="kpi">
            <Skeleton w={80} h={12} />
            <div style={{ height: 10 }} />
            <Skeleton w={60} h={24} />
          </div>
        ))}
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-body">
          <SkeletonLines lines={6} />
        </div>
      </div>
    </div>
  );
}
