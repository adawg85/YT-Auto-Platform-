import { describe, expect, it } from "vitest";
import { generateObject } from "ai";
import { repairedScriptSchema } from "@ytauto/core";
import { createMockLLMProvider } from "../src/mock/llm";

/**
 * Scripting-loop incident FIX 2: the mock LLM's TASK:script-repair route must
 * satisfy the same zod schema the real agent enforces, preserve the beat
 * count, and strip the planted "unsupported-claim" marker while returning all
 * other beats verbatim — so the planted-marker e2e story converges through the
 * proof → repair → proof loop with zero keys.
 */
const llm = createMockLLMProvider();

const PROMPT = [
  "FACTUALITY MODE: balanced",
  "UNSUPPORTED CLAIMS (rewrite ONLY the sentences containing these):\n- planted unsupported-claim test marker (asserts a fact that is not in the VERIFIED FACTS list)",
  "VERIFIED FACTS (the only facts you may ground a claim in):\n- [established] The Concorde entered service in 1976.",
  [
    "HOOK: The Concorde story nobody tells.",
    "BEATS:",
    "1. [hook] The Concorde story nobody tells.",
    "2. [stat] The Concorde entered service in 1976 and this beat has an unsupported-claim planted in it.",
    "3. [insight] Crossing the Atlantic took about three and a half hours.",
    "4. [cta] Follow for the next episode.",
  ].join("\n"),
].join("\n\n");

describe("mock LLM TASK:script-repair route", () => {
  it("is schema-valid, preserves beat count, and strips only the planted marker", async () => {
    const res = await generateObject({
      model: llm.model("agentic"),
      schema: repairedScriptSchema,
      system: "TASK:script-repair — You are a surgical fact editor.",
      prompt: PROMPT,
    });
    // same-count contract
    expect(res.object.beats).toHaveLength(4);
    // the marker is gone from the flagged beat, rest of the sentence survives
    expect(res.object.beats[1]!.text).not.toMatch(/unsupported-claim/i);
    expect(res.object.beats[1]!.text).toContain("The Concorde entered service in 1976");
    // untouched beats come back verbatim
    expect(res.object.beats[0]!.text).toBe("The Concorde story nobody tells.");
    expect(res.object.beats[2]!.text).toBe(
      "Crossing the Atlantic took about three and a half hours.",
    );
    expect(res.object.beats[3]!.text).toBe("Follow for the next episode.");
    expect(res.object.hookText).toBe("The Concorde story nobody tells.");
    // verbatim echoes double as the routing proof: had "TASK:script-repair"
    // fallen through to the TASK:script route (substring collision), the mock
    // would have invented its own canned beats instead of echoing these.
  });
});
