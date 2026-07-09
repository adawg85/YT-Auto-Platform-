/**
 * Image relevance scoring (BACKLOG #18 #4 cut 2). The real scorer uses a vision
 * model; here we only assert the mock LLM routes TASK:image-fit to a passing,
 * schema-valid score so mock/CI runs keep exercising the reference-image path
 * (a passing score ≥ IMAGE_FIT_MIN means references are kept, not rejected).
 */
import { describe, expect, it } from "vitest";
import { generateObject } from "ai";
import { imageFitSchema } from "@ytauto/core";
import { createMockLLMProvider } from "../src/mock/llm";

describe("mock LLM image-fit", () => {
  const llm = createMockLLMProvider();

  it("routes TASK:image-fit to a passing, schema-valid score", async () => {
    const res = await generateObject({
      model: llm.model("cheap"),
      schema: imageFitSchema,
      system: "TASK:image-fit — judge whether the sourced image fits this shot",
      // the mock ignores the (absent) image part and routes on the system TASK tag
      messages: [{ role: "user", content: [{ type: "text", text: "SHOT: a Supermarine Spitfire in flight" }] }],
    });
    expect(res.object.fits).toBe(true);
    expect(res.object.score).toBeGreaterThanOrEqual(5);
    expect(typeof res.object.reason).toBe("string");
  });
});
