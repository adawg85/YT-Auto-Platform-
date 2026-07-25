import { describe, expect, it } from "vitest";
import { aspectForFormat, orientationClause, withOrientation } from "../src/orientation";

describe("withOrientation — every prompt states its own frame shape", () => {
  it("appends the landscape clause to a 16:9 prompt", () => {
    const out = withOrientation("A robed scribe copying by lamplight", "16:9");
    expect(out).toContain("A robed scribe copying by lamplight");
    expect(out).toContain("16:9");
    expect(out).toMatch(/landscape/i);
  });

  it("appends the portrait clause to a 9:16 prompt", () => {
    const out = withOrientation("A robed scribe copying by lamplight", "9:16");
    expect(out).toContain("9:16");
    expect(out).toMatch(/portrait/i);
    expect(out).not.toMatch(/landscape/i);
  });

  it("punctuates cleanly whether or not the prompt ends in a full stop", () => {
    expect(withOrientation("A tall cliff.", "16:9")).toBe(`A tall cliff. ${orientationClause("16:9")}`);
    expect(withOrientation("A tall cliff", "16:9")).toBe(`A tall cliff. ${orientationClause("16:9")}`);
  });

  it("is idempotent — never stacks the clause on re-runs", () => {
    const once = withOrientation("A tall cliff", "16:9");
    const twice = withOrientation(once, "16:9");
    expect(twice).toBe(once);
  });

  it("leaves a prompt that already pins the shape alone", () => {
    const authored = "A tall cliff, wide 16:9 cinematic frame";
    expect(withOrientation(authored, "16:9")).toBe(authored);
    const vertical = "A tall cliff, vertical video for phones";
    expect(withOrientation(vertical, "9:16")).toBe(vertical);
  });

  it("passes an empty prompt through untouched", () => {
    expect(withOrientation("", "16:9")).toBe("");
    expect(withOrientation("   ", "9:16")).toBe("");
  });
});

describe("aspectForFormat", () => {
  it("maps long-form to 16:9 and everything else to 9:16", () => {
    expect(aspectForFormat("long")).toBe("16:9");
    expect(aspectForFormat("short")).toBe("9:16");
    expect(aspectForFormat("both")).toBe("9:16");
    expect(aspectForFormat(null)).toBe("9:16");
  });
});
