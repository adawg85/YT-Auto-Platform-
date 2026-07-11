import {
  IconSparkle,
  IconSearch,
  IconCheck,
  IconFileText,
  IconFilm,
  IconEye,
} from "@/components/icons";
import { Disclosure } from "@/components/ui";

const STEPS = [
  { label: "Plan", Icon: IconSparkle },
  { label: "Research", Icon: IconSearch },
  { label: "Fact-check", Icon: IconCheck },
  { label: "Brief", Icon: IconFileText },
  { label: "Produce", Icon: IconFilm },
  { label: "Publish", Icon: IconEye },
];

/**
 * One-line "how this channel works" strip at the top of the Plan tab (#20:
 * was a paragraph — the explanation now sits behind the ⓘ disclosure).
 */
export function PlanGuide({ bar }: { bar: number }) {
  return (
    <div className="pipe-mini">
      {STEPS.map((s, i) => (
        <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {i > 0 && <span aria-hidden>›</span>}
          <span className="s">
            <s.Icon />
            {s.label}
          </span>
        </span>
      ))}
      <Disclosure summary="ⓘ how this works">
        <span className="muted" style={{ fontSize: 12, maxWidth: "60ch", display: "inline-block" }}>
          Each episode is a planned <strong>topic</strong>. The engine gathers sources and verifies
          every fact against your corroboration bar (≥{bar} independent source{bar === 1 ? "" : "s"}){" "}
          <strong>before a single word of script is written</strong> — the script comes later, in
          Production.
        </span>
      </Disclosure>
    </div>
  );
}
