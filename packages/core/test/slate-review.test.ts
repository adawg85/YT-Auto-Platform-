import { describe, expect, it } from "vitest";
import {
  isProhibitionFamily,
  keywordPosition,
  normSlateTitle,
  partitionAcceptedFindings,
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

  it("producibility: flags live-action ideas on a faceless generative channel (#54)", () => {
    const slate: SlateIdea[] = [
      idea("Come Peek Inside Our Kids' Chemistry Lab!", "POV lab tour — a warm host shows the gear"),
      idea("Assembling a simple take-home kit", "the host walks through building a kit at home"),
      idea("What is an atom?", "a clear stick-figure explainer of atomic structure"),
    ];
    const faceless = reviewSlateDeterministic(slate, { visualMode: "ai_images" });
    const finding = faceless.advisoryFindings.find((f) => f.rule === "producibility_live_action");
    expect(finding).toBeDefined();
    // ideas 0 and 1 are unproducible; idea 2 is fine
    expect(finding!.evidence).toContain("0");
    expect(finding!.evidence).toContain("1");
    expect(finding!.evidence).not.toMatch(/\b2\b/);
  });

  it("producibility: live-action check is scoped to faceless modes, not real_footage", () => {
    const slate = [idea("Behind the scenes in our lab", "the host shows the gear")];
    expect(
      reviewSlateDeterministic(slate, { visualMode: "real_footage" }).advisoryFindings.some(
        (f) => f.rule === "producibility_live_action",
      ),
    ).toBe(false);
    // ai_video is faceless → the same slate IS flagged
    expect(
      reviewSlateDeterministic(slate, { visualMode: "ai_video" }).advisoryFindings.some(
        (f) => f.rule === "producibility_live_action",
      ),
    ).toBe(true);
  });

  it("producibility: flags rap/song/chant formats on any channel (TTS can't sing, #54)", () => {
    const slate = [
      idea("Periodic Table Rap — Meet the Element Crew!", "a rap with simple choreography"),
      idea("Sing-along: the noble gases", "a catchy song about argon and neon"),
      idea("The story of the periodic table", "a straight narrated history"),
    ];
    // no visualMode → live-action check skipped, but the audio-format check still runs
    const r = reviewSlateDeterministic(slate, {});
    const finding = r.advisoryFindings.find((f) => f.rule === "producibility_audio_format");
    expect(finding).toBeDefined();
    expect(finding!.evidence).toContain("0");
    expect(finding!.evidence).toContain("1");
  });

  it("producibility: a producible faceless slate raises no producibility findings", () => {
    const slate = [idea("What is entropy?", "a stick-figure explainer"), idea("Why ice floats", "animated molecular view")];
    const r = reviewSlateDeterministic(slate, { visualMode: "ai_images" });
    expect(r.advisoryFindings.some((f) => f.rule.startsWith("producibility_"))).toBe(false);
  });

  it("producibility: flags comment CTAs on a Made-for-Kids channel (#53, comments disabled)", () => {
    const slate = [
      idea("Pick your element personality!", "invite kids to pick their favourite in the comments"),
      idea("What is a molecule?", "a clean stick-figure explainer"),
    ];
    const mfk = reviewSlateDeterministic(slate, { madeForKids: true });
    const finding = mfk.advisoryFindings.find((f) => f.rule === "producibility_comment_cta");
    expect(finding).toBeDefined();
    expect(finding!.evidence).toContain("0");
    // the same slate on a non-MFK channel raises no comment-CTA finding
    expect(reviewSlateDeterministic(slate, { madeForKids: false }).advisoryFindings.some((f) => f.rule === "producibility_comment_cta")).toBe(false);
    expect(reviewSlateDeterministic(slate, {}).advisoryFindings.some((f) => f.rule === "producibility_comment_cta")).toBe(false);
  });

  it("#107: a near-duplicate title on a publish-group sibling ADVISES, never blocks", () => {
    const slate = [idea("The Mountain the Watchers Named for a Curse"), idea("Roman military tactics explained")];
    const r = reviewSlateDeterministic(slate, {
      siblingTitles: [{ title: "The Mountain the Watchers Named a Curse", channelName: "The Lost Books" }],
    });
    const finding = r.advisoryFindings.find((f) => f.rule === "sibling_title_conflict");
    expect(finding).toBeDefined();
    expect(finding!.evidence).toContain("The Lost Books");
    expect(finding!.evidence).toMatch(/SAME YouTube channel/);
    // titles-only by operator decision — substance overlap is intended, so no block
    expect(r.blockingFindings.some((f) => f.rule === "sibling_title_conflict")).toBe(false);
    // an unrelated title raises nothing
    expect(
      reviewSlateDeterministic(slate, { siblingTitles: [{ title: "Completely different subject", channelName: "X" }] })
        .advisoryFindings.some((f) => f.rule === "sibling_title_conflict"),
    ).toBe(false);
  });

  it("#109: an accepted block moves to accepted with its reason; others stay active", () => {
    const findings = [
      { rule: "forbidden_topic", evidence: `idea 0 ("The B-17 That Flew Home"): matches forbidden topic F4.` },
      { rule: "forbidden_topic", evidence: `idea 9 ("The F-106 That Landed Itself"): falls under F4.` },
      { rule: "backlog_duplicate", evidence: `Title 2 ("The B-17 That Flew Home") is 90% similar to an existing idea.` },
    ];
    const { active, accepted } = partitionAcceptedFindings(findings, [
      { rule: "forbidden_topic", titleNorm: normSlateTitle("The B-17 That Flew Home"), reason: "single-incident story, operator reviewed" },
    ]);
    // same title + same rule → accepted, with the reason carried
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.finding.evidence).toContain("B-17");
    expect(accepted[0]!.reason).toContain("operator reviewed");
    // a different title under the same rule, and the same title under a DIFFERENT
    // rule, both stay blocking — the acceptance is (rule + title)-specific
    expect(active).toHaveLength(2);
    expect(active.some((f) => f.rule === "backlog_duplicate")).toBe(true);
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

describe("isProhibitionFamily (#113)", () => {
  it("reads NEVER SHIP / BANNED / do-not entries as constraints, not templates", () => {
    expect(isProhibitionFamily({ name: "BANNED - outcome promise", pattern: "NEVER SHIP: a hook promising a guaranteed outcome" })).toBe(true);
    expect(isProhibitionFamily({ name: "guardrail", pattern: "Do not open with a question" })).toBe(true);
    expect(isProhibitionFamily({ name: "x", pattern: "Avoid second-person accusations in titles" })).toBe(true);
  });

  it("does not flag ordinary affirmative families", () => {
    expect(isProhibitionFamily({ name: "Dual-intent", pattern: "a curiosity gap that pays off for both the casual and the expert viewer" })).toBe(false);
    expect(isProhibitionFamily({ name: "Keyword-first inversion", pattern: "search term, pipe, then the inversion" })).toBe(false);
    expect(isProhibitionFamily({ name: "STRICT formula", pattern: "named subject + specific claim + year" })).toBe(false);
  });
});
