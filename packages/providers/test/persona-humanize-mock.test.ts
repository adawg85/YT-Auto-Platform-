import { describe, expect, it } from "vitest";
import { generateObject } from "ai";
import {
  builtImagePromptSchema,
  humanizedScriptSchema,
  personaProposalSchema,
} from "@ytauto/core";
import { createMockLLMProvider } from "../src/mock/llm";

/**
 * BACKLOG #21: the mock LLM's TASK:persona / TASK:humanize / TASK:image-prompt
 * routes must satisfy the same zod schemas the real agents enforce, so the
 * zero-key pipeline exercises the new steps end-to-end.
 */
const llm = createMockLLMProvider();

describe("mock LLM #21 routes", () => {
  it("TASK:persona returns a schema-valid proposal specialised to the niche", async () => {
    const res = await generateObject({
      model: llm.model("frontier"),
      schema: personaProposalSchema,
      system: "TASK:persona — design the writing persona.",
      prompt: [
        "NICHE: deep sea exploration",
        "FACTUALITY MODE: balanced",
        "ARCHETYPE: storyteller (Storyteller — narrative-first)",
      ].join("\n\n"),
    });
    expect(res.object.doc.identity).toContain("deep sea exploration");
    expect(res.object.doc.exemplars.length).toBeGreaterThanOrEqual(1);
  });

  it("TASK:humanize keeps beat count and produces edit notes", async () => {
    const res = await generateObject({
      model: llm.model("agentic"),
      schema: humanizedScriptSchema,
      system: "TASK:humanize — you are the script editor.",
      prompt: [
        "HOOK: Here's the surprising part: nobody checked the gauge.",
        "BEATS:",
        "1. [hook] Here's the surprising part: nobody checked the gauge.",
        "2. [stat] In fact, forty of the fifty aircraft flew anyway.",
        "3. [cta] Follow for more.",
      ].join("\n"),
    });
    expect(res.object.beats).toHaveLength(3);
    expect(res.object.editNotes.length).toBeGreaterThan(0);
    // the mock's spoken-register tweak actually ran
    expect(res.object.beats[0]!.text).toContain("And get this");
  });

  it("TASK:image-prompt returns one prompt per shot with the shared suffix", async () => {
    const res = await generateObject({
      model: llm.model("cheap"),
      schema: builtImagePromptSchema,
      system: "TASK:image-prompt — write FLUX prompts.",
      prompt: [
        "NICHE: aviation history",
        "IMAGE STYLE: archival photography",
        "ART DIRECTION (operator): muted warm tones, period-correct markings",
        "SHOTS:",
        '1. NARRATION: "The gauge read empty." | REFERENCE ENTITY: Supermarine Spitfire | SCENE IDEA: cockpit gauge close-up',
        '2. NARRATION: "It was not." | SCENE IDEA: fuel truck beside the aircraft',
      ].join("\n"),
    });
    expect(res.object.prompts).toHaveLength(2);
    for (const p of res.object.prompts) {
      expect(p.prompt).toContain(res.object.styleSuffix);
      expect(p.prompt.toLowerCase()).toMatch(/light|sun|overcast|tungsten/);
    }
    expect(res.object.styleSuffix).toContain("muted warm tones");
    // subject-first: the reference entity leads shot 1's prompt
    expect(res.object.prompts[0]!.prompt.startsWith("Supermarine Spitfire")).toBe(true);
  });
});

describe("mock LLM factuality-proof route (#20 gap fix)", () => {
  it("passes a clean script and fails a planted unsupported claim", async () => {
    const { factualityProofSchema } = await import("@ytauto/core");
    const clean = await generateObject({
      model: llm.model("agentic"),
      schema: factualityProofSchema,
      system: "TASK:factuality-proof — audit the script.",
      prompt: "HOOK: h\n\nSCRIPT: elaborates only verified facts\n\nVERIFIED FACTS:\n- [established] f1",
    });
    expect(clean.object.pass).toBe(true);
    const planted = await generateObject({
      model: llm.model("agentic"),
      schema: factualityProofSchema,
      system: "TASK:factuality-proof — audit the script.",
      prompt: "HOOK: h\n\nSCRIPT: contains an unsupported-claim marker\n\nVERIFIED FACTS:\n- [established] f1",
    });
    expect(planted.object.pass).toBe(false);
    expect(planted.object.unsupportedClaims.length).toBe(1);
  });
});
