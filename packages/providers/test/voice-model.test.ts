import { afterEach, describe, expect, it } from "vitest";
import { estimateWords, resolveElevenModel, ELEVEN_MODELS } from "../src/real/voice";

describe("resolveElevenModel (ElevenLabs TTS model selection)", () => {
  afterEach(() => {
    delete process.env.ELEVENLABS_MODEL_ID;
  });

  it("maps friendly names to ids + prices; v3/multilingual cost ~2x turbo/flash", () => {
    expect(resolveElevenModel("turbo_v2_5")).toEqual({ id: "eleven_turbo_v2_5", pricePerKChar: 0.05 });
    expect(resolveElevenModel("flash_v2_5").pricePerKChar).toBe(0.05);
    expect(resolveElevenModel("v3")).toEqual({ id: "eleven_v3", pricePerKChar: 0.1 });
    expect(resolveElevenModel("multilingual_v2").pricePerKChar).toBe(0.1);
    // v3 is ~2x the cheap tier
    expect(ELEVEN_MODELS.v3.pricePerKChar / ELEVEN_MODELS.turbo_v2_5.pricePerKChar).toBe(2);
  });

  it("defaults to turbo v2.5 when unset or unknown", () => {
    expect(resolveElevenModel()).toEqual({ id: "eleven_turbo_v2_5", pricePerKChar: 0.05 });
    expect(resolveElevenModel("nonsense")).toEqual({ id: "eleven_turbo_v2_5", pricePerKChar: 0.05 });
  });

  it("a friendly model wins over the ELEVENLABS_MODEL_ID env override", () => {
    process.env.ELEVENLABS_MODEL_ID = "eleven_custom";
    expect(resolveElevenModel("v3").id).toBe("eleven_v3");
    // env only applies when no friendly model is given
    expect(resolveElevenModel().id).toBe("eleven_custom");
  });
});

describe("estimateWords (alignment fallback for models that return none)", () => {
  it("produces contiguous even-spaced word timings", () => {
    const words = estimateWords("the quick brown fox");
    expect(words.map((w) => w.word)).toEqual(["the", "quick", "brown", "fox"]);
    expect(words[0]).toEqual({ word: "the", startSec: 0, endSec: 0.4 });
    // contiguous
    expect(words[1]!.startSec).toBeCloseTo(words[0]!.endSec, 5);
    expect(estimateWords("   ")).toEqual([]);
  });
});
