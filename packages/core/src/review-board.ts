/**
 * Multi-checker pre-publish review board (build #5.2). Because mature (T2+)
 * channels have no per-video human gate, a stack of AI checkers must pass
 * before a production can proceed to render/publish. This module is the pure
 * part: checker schemas + the verdict fold. The checker agents live in
 * @ytauto/agents; the pipeline wires them in after the variation check with
 * the same hard-fail → on_hold + evidence-row mechanism as factuality.
 */
import { z } from "zod";

/** compliance / alignment / safety checkers share one output shape */
export const boardCheckSchema = z.object({
  pass: z.boolean(),
  reason: z.string(),
  issues: z.array(z.string()),
});
export type BoardCheck = z.infer<typeof boardCheckSchema>;

/** the quality checker also predicts retention from pattern-store priors */
export const boardQualitySchema = z.object({
  pass: z.boolean(),
  predictedRetention: z.number(),
  reason: z.string(),
});
export type BoardQualityCheck = z.infer<typeof boardQualitySchema>;

export type BoardCheckerName = "compliance" | "alignment" | "safety" | "quality";

export type BoardCheckerResult = {
  checker: BoardCheckerName;
  /** hard checkers block on fail; advisory checkers only warn */
  severity: "hard" | "advisory";
  pass: boolean;
  reason: string;
  issues: string[];
};

/** Which checkers may block a production. Quality is advisory-only: a weak
 * retention prediction is a signal for the operator/experiment layer, not a
 * reason to hold a factually-sound, compliant video. */
export const BOARD_SEVERITY: Record<BoardCheckerName, "hard" | "advisory"> = {
  compliance: "hard",
  alignment: "hard",
  safety: "hard",
  quality: "advisory",
};

export function boardVerdict(results: BoardCheckerResult[]): {
  blocked: boolean;
  reason: string | null;
} {
  const hardFails = results.filter((r) => !r.pass && r.severity === "hard");
  if (hardFails.length === 0) return { blocked: false, reason: null };
  return {
    blocked: true,
    reason: hardFails.map((r) => `${r.checker}: ${r.reason}`).join("; "),
  };
}
