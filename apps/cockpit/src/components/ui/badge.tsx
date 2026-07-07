import type { ReactNode } from "react";

export type Tone = "neutral" | "good" | "warn" | "crit" | "accent";

const toneClass: Record<Tone, string> = {
  neutral: "",
  good: "good",
  warn: "warn",
  crit: "crit",
  accent: "acc",
};

/**
 * Status pill. Replaces both the polished `.chip` and the legacy `.badge`
 * vocabularies with one component so every status reads the same everywhere.
 */
export function Badge({
  tone = "neutral",
  dot,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={["chip", toneClass[tone], className].filter(Boolean).join(" ")}>
      {dot ? <span className="d" /> : null}
      {children}
    </span>
  );
}
