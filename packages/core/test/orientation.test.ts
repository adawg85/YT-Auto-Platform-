import { describe, expect, it } from "vitest";
import { isLongForm, orientationClause, videoAspect, withOrientation } from "../src/orientation";

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

describe("videoAspect / isLongForm — one rule for the whole platform", () => {
  it('treats contentFormat "both" with a long target as LONG-FORM (the portrait bug)', () => {
    // The Lost Books: contentFormat "both", targetLengthSec 1380. The cockpit used
    // to test contentFormat === "long" only, so regenerated shots came back 9:16.
    const lostBooks = { contentFormat: "both", targetLengthSec: 1380 };
    expect(isLongForm(lostBooks)).toBe(true);
    expect(videoAspect(lostBooks)).toBe("16:9");
  });

  it("keeps genuine Shorts vertical", () => {
    expect(videoAspect({ contentFormat: "short", targetLengthSec: 45 })).toBe("9:16");
    expect(videoAspect({ contentFormat: "both", targetLengthSec: 45 })).toBe("9:16");
    expect(videoAspect({})).toBe("9:16");
  });

  it("explicit long-form is always 16:9, even with a short target", () => {
    expect(videoAspect({ contentFormat: "long", targetLengthSec: 30 })).toBe("16:9");
  });

  it("an EXPLICIT profile orientation overrides the derived rule either way", () => {
    // a Shorts-shaped channel forced to landscape
    expect(videoAspect({ contentFormat: "short", targetLengthSec: 45, orientation: "landscape" })).toBe("16:9");
    // a long-form channel forced to portrait
    expect(videoAspect({ contentFormat: "long", targetLengthSec: 1380, orientation: "portrait" })).toBe("9:16");
    // "auto" falls back to the derivation
    expect(videoAspect({ contentFormat: "both", targetLengthSec: 1380, orientation: "auto" })).toBe("16:9");
  });
});
