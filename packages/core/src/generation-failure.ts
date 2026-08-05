/**
 * #102 — make a structured-output failure actionable.
 *
 * A scriptwriter run failed and the operator was told, in full:
 *
 *     "No object generated: response did not match schema."
 *
 * That names neither the agent, nor the model, nor the field, nor whether the
 * model was cut off mid-JSON — and three different agents run around that point
 * in the pipeline, so it doesn't even say which one rejected. There is nothing
 * to act on.
 *
 * The information all exists at the throw site: `runAgent` knows the agent name
 * and routed model, and the AI SDK's NoObjectGeneratedError carries the raw text,
 * the finish reason and the token usage. This turns that into a sentence that
 * distinguishes the two failure modes an operator would treat differently:
 *
 *  - TRUNCATION (finishReason "length") — the model ran out of output budget
 *    mid-JSON. Retrying rarely helps; the token cap or the requested length is
 *    the problem.
 *  - SHAPE MISMATCH — the model returned complete JSON that doesn't satisfy the
 *    schema. This class is genuinely flaky and usually clears on a retry.
 *
 * Pure and duck-typed: it reads properties off whatever was thrown rather than
 * importing the SDK's error class, so an SDK version bump can't silently turn a
 * useful message back into a bare one.
 */

export type GenerationFailure = {
  agent: string;
  model: string;
  /** "truncated" | "schema" | "other" — what actually went wrong */
  kind: "truncated" | "schema" | "other";
  /** true when a retry is worth attempting automatically */
  retryable: boolean;
  /** the operator-facing sentence */
  message: string;
  /** characters of model output received, when the error carried them */
  outputChars: number | null;
  finishReason: string | null;
};

/** Best-effort read of a property off an unknown thrown value. */
function prop(err: unknown, key: string): unknown {
  if (!err || typeof err !== "object") return undefined;
  return (err as Record<string, unknown>)[key];
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** Is this the SDK's "couldn't produce a valid object" failure? */
export function isSchemaFailure(err: unknown): boolean {
  const name = asString(prop(err, "name")) ?? "";
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    name === "AI_NoObjectGeneratedError" ||
    /no object generated|did not match schema|response did not match/i.test(msg)
  );
}

export function describeGenerationFailure(
  agent: string,
  model: string,
  err: unknown,
): GenerationFailure {
  const raw = err instanceof Error ? err.message : String(err ?? "unknown error");
  const text = asString(prop(err, "text"));
  const outputChars = text ? text.length : null;
  const finishReason = asString(prop(err, "finishReason"));
  const schemaish = isSchemaFailure(err);
  // the SDK sets finishReason "length" when the model hit the output cap — the
  // JSON is then simply incomplete, and a retry at the same cap repeats it
  const truncated = schemaish && finishReason === "length";
  const kind: GenerationFailure["kind"] = truncated ? "truncated" : schemaish ? "schema" : "other";

  const where = `${agent} (${model})`;
  let message: string;
  if (truncated) {
    message =
      `${where} was CUT OFF mid-JSON — the model hit its output limit` +
      (outputChars != null ? ` after ${outputChars.toLocaleString()} characters` : "") +
      `, so the partial response could not satisfy its schema. This is a budget problem, not a flaky one: ` +
      `retrying at the same limit will repeat it. Shorten what the agent is asked to produce (a lower targetLengthSec / fewer beats) or raise its output cap.`;
  } else if (schemaish) {
    message =
      `${where} returned output that did not match its schema` +
      (outputChars != null ? ` (${outputChars.toLocaleString()} characters received` : "") +
      (outputChars != null ? `, finish reason ${finishReason ?? "unknown"})` : "") +
      `. The response was complete but the wrong shape — a known-flaky failure for structured output, which usually clears on a re-run. ` +
      `If it repeats on the same idea, the prompt and schema have genuinely diverged and the agent needs a fix.`;
  } else {
    message = `${where} failed: ${raw}`;
  }

  return {
    agent,
    model,
    kind,
    // a shape mismatch is worth retrying; a truncation is not
    retryable: kind === "schema",
    message,
    outputChars,
    finishReason,
  };
}
