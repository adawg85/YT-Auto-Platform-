import { describe, expect, it } from "vitest";
import { describeGenerationFailure, isSchemaFailure } from "../src/generation-failure";

/** The exact error the operator was shown, with nothing else to go on. */
const bare = Object.assign(new Error("No object generated: response did not match schema."), {
  name: "AI_NoObjectGeneratedError",
});

describe("describeGenerationFailure (#102) — name the agent, model and failure mode", () => {
  it("the reported message becomes actionable", () => {
    const f = describeGenerationFailure("scriptwriter", "qwen-max", bare);
    // the three things the operator could not see
    expect(f.message).toContain("scriptwriter");
    expect(f.message).toContain("qwen-max");
    expect(f.kind).toBe("schema");
    // and it says what to do
    expect(f.message).toMatch(/re-?run|retry/i);
  });

  it("distinguishes TRUNCATION from a shape mismatch — they need opposite responses", () => {
    const cut = Object.assign(new Error("No object generated: response did not match schema."), {
      name: "AI_NoObjectGeneratedError",
      finishReason: "length",
      text: "x".repeat(31_000),
    });
    const f = describeGenerationFailure("scriptwriter", "claude-sonnet", cut);
    expect(f.kind).toBe("truncated");
    // retrying a truncation at the same cap just repeats it
    expect(f.retryable).toBe(false);
    expect(f.message).toMatch(/cut off/i);
    expect(f.message).toContain("31,000");
    expect(f.message).toMatch(/output limit|output cap/i);
  });

  it("a complete-but-wrong-shape response IS worth retrying", () => {
    const mismatch = Object.assign(new Error("response did not match schema"), {
      name: "AI_NoObjectGeneratedError",
      finishReason: "stop",
      text: '{"hook":"…"}',
    });
    const f = describeGenerationFailure("beat_builder", "gpt-4o", mismatch);
    expect(f.kind).toBe("schema");
    expect(f.retryable).toBe(true);
    expect(f.outputChars).toBe('{"hook":"…"}'.length);
  });

  it("passes an unrelated failure through without pretending to diagnose it", () => {
    const other = new Error("fetch failed: ECONNRESET");
    const f = describeGenerationFailure("scriptwriter", "qwen-max", other);
    expect(f.kind).toBe("other");
    expect(f.retryable).toBe(false);
    expect(f.message).toContain("ECONNRESET");
    expect(f.message).toContain("scriptwriter");
  });

  it("recognises the failure by name OR message, so an SDK bump can't mute it", () => {
    expect(isSchemaFailure(bare)).toBe(true);
    expect(isSchemaFailure(new Error("No object generated: response did not match schema."))).toBe(true);
    expect(isSchemaFailure({ name: "AI_NoObjectGeneratedError" })).toBe(true);
    expect(isSchemaFailure(new Error("rate limited"))).toBe(false);
  });

  it("survives a non-Error throw", () => {
    const f = describeGenerationFailure("scriptwriter", "m", "something odd");
    expect(f.kind).toBe("other");
    expect(f.message).toContain("something odd");
  });
});
