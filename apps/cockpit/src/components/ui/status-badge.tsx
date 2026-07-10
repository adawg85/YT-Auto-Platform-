import { Badge } from "./badge";
import { prodStatusLabel } from "@/lib/format";
import { statusKind, KIND_PULSES, KIND_TONE } from "@/lib/status";

/**
 * The one way to render a production status (task #21). Maps every status to
 * the shared live-status language — tone, label, and a pulsing dot whenever
 * the pipeline is actively working — so "is it moving / waiting on me /
 * stopped" reads identically on every page.
 */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const kind = statusKind(status);
  return (
    <Badge tone={KIND_TONE[kind]} dot className={KIND_PULSES[kind] ? "live" : undefined}>
      {label ?? prodStatusLabel(status)}
    </Badge>
  );
}
