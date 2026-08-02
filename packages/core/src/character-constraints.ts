/**
 * Character-constraint preservation (#90).
 *
 * `create_character` distils an operator brief into a canonical appearance
 * paragraph via an LLM, and that distillation compresses concrete proportional/
 * numeric/anatomical constraints ("legs roughly half his total height", "~7.5
 * heads tall", "not dwarfish") into vague adjectives — which is exactly the class
 * of instruction that must survive verbatim, because a diffusion model defaults
 * to squat on a heavy build. These pure helpers let the create/refine path WARN
 * the operator when a measurement-bearing phrase from the brief did not survive
 * into the description, so a silently-dropped constraint is visible before the
 * (billable) sheet is judged. Pure + deterministic so they're unit-tested.
 */

/** A measurement / proportion / ratio signal — the load-bearing kind of clause. */
const MEASURE_RE =
  /\b(\d+(?:\.\d+)?\s*(?:heads?|ft|feet|foot|inch(?:es)?|cm|%)|heads?\s+tall|half|third|thirds|quarter|quarters|two-thirds|three-quarters|proportion\w*|ratio|elongated|leg\s+length|legs?|torso|head-to-body)\b/i;

/** An explicit anatomical negation ("not dwarfish", "rather than squat"). */
const NEG_RE =
  /\b(?:not|never|rather than|instead of|avoid(?:ing)?)\s+(?:a\s+|being\s+|too\s+)?(?:squat|dwarfish|stubby|short-legged|chibi|elongated|stretched|stooped|hunched|lanky)\b/i;

/** Distinctive tokens whose presence in the description proves a clause survived. */
const SIGNAL_RE =
  /\b(\d+(?:\.\d+)?|half|thirds?|quarters?|dwarfish|squat|stubby|short-legged|chibi|elongated|stretched|stooped|hunched|lanky|proportion\w*|ratio|heads?|legs?|torso|foot|feet|inch(?:es)?)\b/gi;

/**
 * The measurement/negation-bearing clauses in a brief — the constraints that
 * must survive distillation verbatim.
 */
export function constraintClauses(brief: string): string[] {
  return brief
    .split(/[.;\n]|,(?=\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && (MEASURE_RE.test(s) || NEG_RE.test(s)));
}

/**
 * Constraint clauses from the brief whose distinctive signals do NOT appear in
 * the distilled description — i.e. the measurements the distiller dropped. Empty
 * when every constraint survived (or the brief had none).
 */
export function droppedConstraintClauses(brief: string, description: string): string[] {
  const desc = description.toLowerCase();
  return constraintClauses(brief).filter((clause) => {
    const signals = (clause.toLowerCase().match(SIGNAL_RE) ?? []).map((s) => s.trim());
    if (signals.length === 0) return false; // nothing distinctive to check — don't cry wolf
    // dropped only if NONE of its distinctive signals survived into the description
    return !signals.some((sig) => desc.includes(sig));
  });
}
