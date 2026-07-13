import { describe, expect, it } from "vitest";
import {
  computeChannelMaturity,
  isVideoMatured,
  maturityWindowDays,
  playbookPromptBlock,
  retroDue,
  validateRetroProposal,
  MIN_ADOPTION_EVIDENCE,
  PLAYBOOK_PROMPT_CAP,
} from "../src/learning";

const days = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("performance windows (#21.6)", () => {
  it("shorts retention matures at 14d, views at 28d; long-form slower", () => {
    expect(maturityWindowDays("short", "retention")).toBe(14);
    expect(maturityWindowDays("short", "views")).toBe(28);
    expect(maturityWindowDays("long", "retention")).toBe(21);
    expect(maturityWindowDays("long", "views")).toBe(42);
  });

  it("a hot day-one video is NOT matured", () => {
    expect(isVideoMatured(days(1), "short", "retention")).toBe(false);
    expect(isVideoMatured(days(15), "short", "retention")).toBe(true);
    expect(isVideoMatured(days(15), "long", "retention")).toBe(false);
  });
});

describe("channel maturity phases (#21.6)", () => {
  it("warming until 12 matured AND 8 weeks of publishing", () => {
    expect(
      computeChannelMaturity({ firstPublishedAt: days(30), maturedCount: 20 }),
    ).toBe("warming"); // only ~4 weeks old
    expect(
      computeChannelMaturity({ firstPublishedAt: days(70), maturedCount: 11 }),
    ).toBe("warming"); // not enough matured videos
    expect(
      computeChannelMaturity({ firstPublishedAt: days(70), maturedCount: 12 }),
    ).toBe("establishing");
    expect(
      computeChannelMaturity({ firstPublishedAt: days(200), maturedCount: 25 }),
    ).toBe("established");
  });

  it("no publishes yet → warming; operator override always wins", () => {
    expect(computeChannelMaturity({ firstPublishedAt: null, maturedCount: 0 })).toBe("warming");
    expect(
      computeChannelMaturity({
        firstPublishedAt: days(1),
        maturedCount: 0,
        override: "established",
      }),
    ).toBe("established");
    expect(
      computeChannelMaturity({
        firstPublishedAt: days(1),
        maturedCount: 0,
        override: "nonsense",
      }),
    ).toBe("warming"); // invalid override ignored
  });
});

describe("retroDue cadence", () => {
  it("warming is observe-only; established runs every 14d, establishing 28d", () => {
    expect(retroDue("warming", null)).toEqual({ due: true, observeOnly: true });
    expect(retroDue("established", days(15)).due).toBe(true);
    expect(retroDue("established", days(10)).due).toBe(false);
    expect(retroDue("establishing", days(15)).due).toBe(false);
    expect(retroDue("establishing", days(29)).due).toBe(true);
  });
});

describe("playbookPromptBlock", () => {
  it("returns null when empty, caps at the prompt cap by confidence", () => {
    expect(playbookPromptBlock([])).toBeNull();
    const entries = Array.from({ length: 10 }, (_, i) => ({
      scope: "hook",
      directive: `directive ${i}`,
      why: `why ${i}`,
      confidence: i / 10,
    }));
    const block = playbookPromptBlock(entries)!;
    expect(block).toContain("CHANNEL PLAYBOOK");
    expect(block.match(/^- \[/gm)).toHaveLength(PLAYBOOK_PROMPT_CAP);
    expect(block).toContain("directive 9"); // highest confidence made the cut
    expect(block).not.toContain("directive 0");
  });
});

describe("validateRetroProposal honesty guards (#21.5)", () => {
  const base = { retirements: [], experimentCandidates: [], observations: "obs" };

  it("rejects adoptions with fewer than 3 matured-evidence videos", () => {
    const out = validateRetroProposal(
      {
        ...base,
        adoptions: [
          {
            directive: "d",
            scope: "hook",
            why: "w",
            evidenceVideoIds: ["a", "b", "UNMATURED"],
            confidence: 0.9,
          },
        ],
      },
      new Set(["a", "b"]), // only 2 of the cited ids are matured
      new Set(),
    );
    expect(out.adoptions).toHaveLength(0);
    expect(MIN_ADOPTION_EVIDENCE).toBe(3);
  });

  it("keeps valid adoptions, dedupes evidence ids, clamps confidence", () => {
    const out = validateRetroProposal(
      {
        ...base,
        adoptions: [
          {
            directive: "d",
            scope: "hook",
            why: "w",
            evidenceVideoIds: ["a", "a", "b", "c"],
            confidence: 7,
          },
        ],
      },
      new Set(["a", "b", "c"]),
      new Set(),
    );
    expect(out.adoptions).toHaveLength(1);
    expect(out.adoptions[0]!.evidenceVideoIds).toEqual(["a", "b", "c"]);
    expect(out.adoptions[0]!.confidence).toBe(1);
  });

  it("drops retirements pointing at unknown playbook ids", () => {
    const out = validateRetroProposal(
      { ...base, adoptions: [], retirements: [{ playbookId: "ghost", why: "w" }] },
      new Set(),
      new Set(["real-id"]),
    );
    expect(out.retirements).toHaveLength(0);
  });
});
