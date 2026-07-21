import { describe, expect, it } from "vitest";
import {
  keywordPosition,
  reviewSlateDeterministic,
  slateVerdict,
  structuralClusters,
  titleShape,
  titleSimilarity,
  type SlateIdea,
} from "../src/slate-review";

const idea = (title: string, angle = ""): SlateIdea => ({ title, angle });

describe("slate reviewer — deterministic core (ticket 01KY2BJ9…)", () => {
  it("clusters repeated title shapes (the '5 of 28 same shape' case)", () => {
    // five "X found at location, changes everything" titles among clean ones
    const slate: SlateIdea[] = [
      idea("A scroll was found at Qumran and it changes everything"),
      idea("The Book of Enoch explained"),
      idea("A codex was discovered in Egypt and it rewrites history"),
      idea("What Tertullian actually wrote"),
      idea("A manuscript was unearthed in Syria and it changes everything"),
      idea("Fragments were dug up at Nag Hammadi and they change history"),
      idea("A tablet was recovered in Iraq and it rewrites the record"),
    ];
    const clusters = structuralClusters(slate);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0]!.indices.length).toBeGreaterThanOrEqual(3);
  });

  it("titleShape distinguishes discovery-narrative from a plain claim", () => {
    expect(titleShape("A scroll was found at Qumran and it changes everything")).toContain("disc:1");
    expect(titleShape("The Book of Enoch explained")).toContain("disc:0");
  });

  it("BLOCKS a near-duplicate within the slate and against the backlog", () => {
    const slate = [idea("The Book of Enoch predates Christianity"), idea("Enoch predates Christianity, the Book of")];
    const within = reviewSlateDeterministic(slate);
    expect(within.blockingFindings.some((f) => f.rule === "intra_slate_duplicate")).toBe(true);

    const vsBacklog = reviewSlateDeterministic([idea("The lost Book of Enoch and the watchers")], {
      existingTitles: ["The Book of Enoch and the watchers, lost"],
    });
    expect(vsBacklog.blockingFindings.some((f) => f.rule === "backlog_duplicate")).toBe(true);
  });

  it("flags keyword burial and missing search term (multi-word terms, ticket 01KY3B8N…)", () => {
    const terms = ["book of enoch", "enoch", "qumran"];
    const kp1 = keywordPosition("The Book of Enoch Names the Angels", terms);
    expect(kp1.present).toBe(true);
    expect(kp1.frontLoaded).toBe(true); // "book of enoch" starts at word 2
    const kp2 = keywordPosition("Egyptian farmers dug up the Book of Enoch last year", terms);
    expect(kp2.present).toBe(true);
    expect(kp2.frontLoaded).toBe(false); // buried deep in the title
    const kp3 = keywordPosition("Tertullian argued about scripture", terms);
    expect(kp3.present).toBe(false);
  });

  it("keyword checks are skipped when no searchTerms are set (no niche-phrase noise)", () => {
    const r = reviewSlateDeterministic([idea("Tertullian argued about scripture")], {}); // no searchTerms
    expect(r.advisoryFindings.some((f) => f.rule === "keyword_missing")).toBe(false);
  });

  it("suppresses cross-slate clustering when titleTemplates are declared", () => {
    const clustered: SlateIdea[] = Array.from({ length: 5 }, (_, i) =>
      idea(`A scroll was found at site ${i} and it changes everything`),
    );
    const without = reviewSlateDeterministic(clustered, {});
    expect(without.advisoryFindings.some((f) => f.rule === "structural_clustering")).toBe(true);
    const withTemplates = reviewSlateDeterministic(clustered, { titleTemplatesDeclared: true });
    expect(withTemplates.advisoryFindings.some((f) => f.rule === "structural_clustering")).toBe(false);
  });

  it("advises on overclaim verbs", () => {
    const r = reviewSlateDeterministic([idea("This scroll proved the text predates Christianity")]);
    expect(r.advisoryFindings.some((f) => f.rule === "overclaim_verb")).toBe(true);
  });

  it("titleSimilarity is high for reordered same words, low for different", () => {
    expect(titleSimilarity("the book of enoch", "book of the enoch")).toBeGreaterThan(0.7);
    expect(titleSimilarity("the book of enoch", "roman military tactics")).toBeLessThan(0.2);
  });

  it("verdict: block when a duplicate, advise when only craft findings, pass when clean", () => {
    expect(slateVerdict(reviewSlateDeterministic([idea("A"), idea("A")]))).toBe("block");
    const advise = reviewSlateDeterministic([idea("Farmers dug up something")], { searchTerms: ["book of enoch"] });
    expect(slateVerdict(advise)).toBe("advise");
    expect(slateVerdict(reviewSlateDeterministic([idea("The Book of Enoch and its origins")], { searchTerms: ["book of enoch"] }))).toBe("pass");
  });
});
