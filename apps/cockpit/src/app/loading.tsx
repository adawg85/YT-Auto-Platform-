import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";

/** Instant navigation skeleton for the portfolio Overview (perf). */
export default function OverviewLoading() {
  return (
    <div>
      <Skeleton w={160} h={22} />
      <div style={{ height: 8 }} />
      <Skeleton w={280} h={14} />
      <div style={{ display: "flex", gap: 8, margin: "20px 0" }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} w={90} h={30} style={{ borderRadius: 8 }} />
        ))}
      </div>
      <div className="kpis">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="kpi">
            <Skeleton w={80} h={12} />
            <div style={{ height: 10 }} />
            <Skeleton w={70} h={24} />
          </div>
        ))}
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-body">
          <SkeletonLines lines={5} />
        </div>
      </div>
    </div>
  );
}
