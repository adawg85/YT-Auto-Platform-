import {
  IconSparkle,
  IconSearch,
  IconCheck,
  IconFileText,
  IconFilm,
  IconEye,
  IconChevronRight,
} from "@/components/icons";

const STEPS = [
  { label: "Plan", Icon: IconSparkle, hint: "topics" },
  { label: "Research", Icon: IconSearch, hint: "gather sources" },
  { label: "Fact-check", Icon: IconCheck, hint: "verify each fact" },
  { label: "Brief", Icon: IconFileText, hint: "verified outline" },
  { label: "Produce", Icon: IconFilm, hint: "write script + video" },
  { label: "Publish", Icon: IconEye, hint: "" },
];

/**
 * Slim "how this channel works" strip at the top of the Plan tab. Closes the
 * mental-model gap: an episode is a planned topic, every fact is checked before
 * any script is written, and the script itself comes later (in Production).
 */
export function PlanGuide({ bar }: { bar: number }) {
  return (
    <div className="panel plan-guide">
      <div className="panel-body">
        <ol className="pipeline">
          {STEPS.map((s, i) => (
            <li key={s.label}>
              <span className="step">
                <span className="ic">
                  <s.Icon />
                </span>
                <span className="lab">
                  {s.label}
                  {s.hint && <small>{s.hint}</small>}
                </span>
              </span>
              {i < STEPS.length - 1 && (
                <span className="sep" aria-hidden>
                  <IconChevronRight />
                </span>
              )}
            </li>
          ))}
        </ol>
        <p className="muted" style={{ margin: "10px 0 0", fontSize: 12.5 }}>
          Each episode is a planned <strong>topic</strong>. The engine gathers sources and verifies
          every fact against your corroboration bar (≥{bar} independent sources) <strong>before a
          single word of script is written</strong> — so the video is built only from checked facts.
          The script itself is written later, in Production.
        </p>
      </div>
    </div>
  );
}
