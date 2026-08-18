import { describe, expect, it } from "vitest";
import {
  findGuideSection,
  guideSectionIndex,
  guideSectionKey,
  guideSections,
} from "../src/guide-sections";

// A miniature of the real guide's shape: a titled preamble, headings that carry
// long parenthetical provenance, and a `###` subheading that must NOT split.
const GUIDE = [
  "# Operating the YT-Auto platform (MCP guide)",
  "",
  "You author the creative; the platform executes.",
  "",
  "## Shots & motion — how many images, and which ones move (ticket 01KY25DN…)",
  "BEFORE any call in this section, read get_guide(section:'actions').",
  "",
  "### Sub-heading that must not split",
  "still the shots section",
  "",
  "## Action consequences — what each call discards, bills, and how to undo it",
  "Before any state-changing call, be able to state three things.",
  "",
  "## Gotchas",
  "Legacy channels may have no charter.",
].join("\n");

describe("guideSectionKey (#129)", () => {
  it("drops the em-dash provenance the guide headings carry", () => {
    expect(guideSectionKey("Action consequences — what each call discards, bills, and how to undo it")).toBe(
      "action-consequences",
    );
    expect(guideSectionKey("Shots & motion — how many images (ticket 01KY25DN…)")).toBe("shots-motion");
  });

  it("drops a parenthetical even without a dash", () => {
    expect(guideSectionKey("Channel strategy document (#61 — durable planning memory)")).toBe(
      "channel-strategy-document",
    );
  });
});

describe("guideSections (#129)", () => {
  it("splits on ## only — a ### subheading stays inside its section", () => {
    const keys = guideSections(GUIDE).map((s) => s.key);
    expect(keys).toEqual(["overview", "shots-motion", "action-consequences", "gotchas"]);
    const shots = guideSections(GUIDE).find((s) => s.key === "shots-motion");
    expect(shots?.body).toContain("Sub-heading that must not split");
    expect(shots?.body).not.toContain("Before any state-changing call");
  });

  it("keeps the preamble addressable as 'overview' and includes each heading in its body", () => {
    const [first] = guideSections(GUIDE);
    expect(first?.key).toBe("overview");
    expect(first?.body).toContain("You author the creative");
    const actions = guideSections(GUIDE).find((s) => s.key === "action-consequences");
    expect(actions?.body.startsWith("## Action consequences")).toBe(true);
  });

  it("indexes every section for the bare get_guide() response", () => {
    expect(guideSectionIndex(GUIDE).map((s) => s.key)).toContain("action-consequences");
  });
});

describe("findGuideSection (#129)", () => {
  it("resolves the exact key, a prefix, and a heading substring", () => {
    expect(findGuideSection(GUIDE, "action-consequences")?.key).toBe("action-consequences");
    expect(findGuideSection(GUIDE, "actions")?.key).toBe("action-consequences"); // the documented argument
    expect(findGuideSection(GUIDE, "Action")?.key).toBe("action-consequences");
    expect(findGuideSection(GUIDE, "discards")?.key).toBe("action-consequences");
  });

  it("returns null rather than guessing, so the tool can answer with the index", () => {
    expect(findGuideSection(GUIDE, "voiceover-recording-booth")).toBeNull();
    expect(findGuideSection(GUIDE, "   ")).toBeNull();
  });
});
