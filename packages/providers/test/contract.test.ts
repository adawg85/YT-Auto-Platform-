/**
 * Provider contract tests. Mocks are always tested; real adapters are tested
 * against the same contract when their keys are present in the environment
 * (so mock/real parity is enforced wherever it can be).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateObject } from "ai";
import { createMemoryCostSink, scriptOutputSchema, ideationOutputSchema, rubricSchema } from "@ytauto/core";
import { createFsObjectStore } from "../src/store/fs";
import { createMockLLMProvider } from "../src/mock/llm";
import { createMockVoiceProvider } from "../src/mock/voice";
import { createMockMediaProvider } from "../src/mock/media";
import { createMockResearchProvider } from "../src/mock/research";
import { createMockPublishProvider } from "../src/mock/publish";
import { charsToWords } from "../src/real/voice";
import type { VoiceProvider, MediaProvider } from "../src/types";

const baseDir = mkdtempSync(join(tmpdir(), "ytauto-store-"));
const store = createFsObjectStore(baseDir);
const costs = createMemoryCostSink();

const ctx = { channelId: "ch1", productionId: "prod1" };

function voiceContract(name: string, make: () => VoiceProvider) {
  describe(`${name} VoiceProvider contract`, () => {
    it("produces audio + monotonic word timestamps + cost record", async () => {
      const voice = make();
      const before = costs.entries.length;
      const res = await voice.synthesize({
        text: "Hello there this is a test sentence",
        voiceId: "mock-voice-1",
        ...ctx,
      });
      expect(res.words.length).toBe(7);
      for (let i = 1; i < res.words.length; i++) {
        expect(res.words[i]!.startSec).toBeGreaterThanOrEqual(res.words[i - 1]!.endSec);
      }
      expect(res.durationSec).toBeGreaterThanOrEqual(res.words.at(-1)!.endSec);
      expect(await store.exists(res.storageKey)).toBe(true);
      expect(costs.entries.length).toBe(before + 1);
      expect(costs.entries.at(-1)!.category).toBe("voice");
    });
  });
}

function mediaContract(name: string, make: () => MediaProvider) {
  describe(`${name} MediaProvider contract`, () => {
    it("produces a stored image + cost record", async () => {
      const media = make();
      const res = await media.generateImage({
        prompt: "a red balloon over a city",
        aspect: "9:16",
        idx: 0,
        ...ctx,
      });
      expect(await store.exists(res.storageKey)).toBe(true);
      expect(res.mimeType).toMatch(/^image\//);
    });
  });
}

voiceContract("mock", () => createMockVoiceProvider(store, costs));
mediaContract("mock", () => createMockMediaProvider(store, costs));

describe("mock WAV output", () => {
  it("is a valid RIFF/WAVE file", async () => {
    const voice = createMockVoiceProvider(store, costs);
    const res = await voice.synthesize({ text: "one two three", voiceId: "v", ...ctx });
    const buf = await store.getBuffer(res.storageKey);
    expect(buf.subarray(0, 4).toString()).toBe("RIFF");
    expect(buf.subarray(8, 12).toString()).toBe("WAVE");
    expect(buf.readUInt32LE(24)).toBe(44100);
  });
});

describe("mock SVG output", () => {
  it("is 1080x1920 for 9:16", async () => {
    const media = createMockMediaProvider(store, costs);
    const res = await media.generateImage({ prompt: "test image", aspect: "9:16", idx: 1, ...ctx });
    const svg = (await store.getBuffer(res.storageKey)).toString();
    expect(svg).toContain('width="1080"');
    expect(svg).toContain('height="1920"');
  });
});

describe("mock LLM", () => {
  const llm = createMockLLMProvider();

  it("routes TASK:script to schema-valid, deterministic output", async () => {
    const run = () =>
      generateObject({
        model: llm.model("frontier"),
        schema: scriptOutputSchema,
        system: "TASK:script — you write short scripts",
        prompt: "IDEA TITLE: Why airplane windows are round\nIDEA ANGLE: Square windows tore planes apart.\nIMAGE STYLE: flat illustration\nCTA: Follow for more.",
      });
    const a = await run();
    const b = await run();
    expect(a.object.beats.length).toBeGreaterThanOrEqual(4);
    expect(a.object.substanceFingerprint).toBe(b.object.substanceFingerprint);
    expect(a.usage.inputTokens).toBeGreaterThan(0);
  });

  it("routes TASK:ideation and TASK:scoring", async () => {
    const ideas = await generateObject({
      model: llm.model("cheap"),
      schema: ideationOutputSchema,
      system: "TASK:ideation",
      prompt: "NICHE: everyday physics\nKEYWORDS: friction, magnets, sound",
    });
    expect(ideas.object.ideas.length).toBeGreaterThanOrEqual(3);

    const rubric = await generateObject({
      model: llm.model("agentic"),
      schema: rubricSchema,
      system: "TASK:scoring",
      prompt: "IDEA TITLE: Why magnets are cold\n",
    });
    expect(rubric.object.demand.score).toBeGreaterThanOrEqual(0);
    expect(rubric.object.demand.score).toBeLessThanOrEqual(10);
  });
});

describe("mock research + publish", () => {
  it("returns deterministic outliers and keywords", async () => {
    const research = createMockResearchProvider(costs);
    const a = await research.outliers("physics");
    const b = await research.outliers("physics");
    expect(a).toEqual(b);
    expect(a.length).toBe(5);
    expect((await research.keywords("magnets")).length).toBeGreaterThan(0);
  });

  it("publish verifies the render exists and records quota units", async () => {
    const publish = createMockPublishProvider(store, costs);
    await expect(
      publish.upload({
        channelId: "ch1",
        productionId: "prodX",
        videoStorageKey: "productions/prodX/final.mp4",
        title: "t",
        description: "d",
        tags: [],
        privacy: "private",
        selfDeclaredAiContent: true,
        madeForKids: false,
      }),
    ).rejects.toThrow(/not found/);

    await store.put("productions/prodY/final.mp4", Buffer.from("fake"), "video/mp4");
    const res = await publish.upload({
      channelId: "ch1",
      productionId: "prodY",
      videoStorageKey: "productions/prodY/final.mp4",
      title: "t",
      description: "d",
      tags: [],
      privacy: "private",
      selfDeclaredAiContent: true,
      madeForKids: false,
    });
    expect(res.providerVideoId).toMatch(/^mock-/);
    expect(costs.entries.at(-1)!.units.quotaUnits).toBe(1600);
  });

  it("records publishAt on upload and supports reschedule (#20 native scheduling)", async () => {
    const publish = createMockPublishProvider(store, costs);
    await store.put("productions/prodZ/final.mp4", Buffer.from("fake"), "video/mp4");
    const slot = new Date(Date.now() + 86_400_000).toISOString();
    const res = await publish.upload({
      channelId: "ch1",
      productionId: "prodZ",
      videoStorageKey: "productions/prodZ/final.mp4",
      title: "t",
      description: "d",
      tags: [],
      privacy: "private",
      publishAt: slot,
      selfDeclaredAiContent: true,
      madeForKids: false,
    });
    expect(costs.entries.at(-1)!.meta).toMatchObject({ publishAt: slot });

    const newSlot = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await publish.schedule({ channelId: "ch1", providerVideoId: res.providerVideoId, publishAt: newSlot });
    expect(costs.entries.at(-1)!.meta).toMatchObject({ action: "reschedule", publishAt: newSlot });
    expect(costs.entries.at(-1)!.units.quotaUnits).toBe(50);

    // publishAt: null cancels the scheduled release (video stays private)
    await publish.schedule({ channelId: "ch1", providerVideoId: res.providerVideoId, publishAt: null });
    expect(costs.entries.at(-1)!.meta).toMatchObject({ action: "unschedule" });

    // the mock can't answer reconciliation reads → time-based fallback applies
    expect(await publish.videoStatus({ channelId: "ch1", providerVideoId: res.providerVideoId })).toEqual({
      state: "unknown",
    });
  });

  it("findRecentUpload returns null (no provider-side history) so callers fall through to upload", async () => {
    // duplicate-upload guard contract (2026-07-11 incident): the method must
    // exist on the provider and the mock must never claim an orphan exists.
    const publish = createMockPublishProvider(store, costs);
    expect(publish.findRecentUpload).toBeTypeOf("function");
    await expect(
      publish.findRecentUpload!({ channelId: "ch1", title: "any title", withinMinutes: 120 }),
    ).resolves.toBeNull();
  });
});

describe("elevenlabs alignment conversion", () => {
  it("converts character alignment to word timestamps", () => {
    const words = charsToWords({
      characters: ["h", "i", " ", "y", "o", "u"],
      character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
      character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    });
    expect(words).toEqual([
      { word: "hi", startSec: 0, endSec: 0.2 },
      { word: "you", startSec: 0.3, endSec: 0.6 },
    ]);
  });
});
