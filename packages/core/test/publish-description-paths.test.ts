import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * #131 regression guard: every path that writes a description to YouTube must
 * assemble it through `assemblePublishDescription`.
 *
 * That is what its own doc comment promises ("any path that writes a
 * description to YouTube goes through here so they can't be edited away") — but
 * nothing enforced it, and the derived-clip publisher (`publish-clip.ts`)
 * quietly hand-rolled its own description for months. Derived Shorts therefore
 * shipped with NO image credits and NO music credit at all: a licence breach on
 * a CC-BY bed track, and — for a Content-ID-registered library track — a claim
 * the operator could never release, because the credit that entitles the
 * release was never in the description.
 *
 * The AI-content disclosure is the tell. It is non-optional furniture that only
 * the shared builder is allowed to emit, so a second copy of that literal in the
 * tree means some path is building a description by hand and has almost
 * certainly dropped the credits with it.
 */
const DISCLOSURE = "This video contains AI-generated content.";

/** repo root, from packages/core/test */
const ROOT = new URL("../../../", import.meta.url).pathname;

function grepDisclosure(): string[] {
  let out = "";
  try {
    out = execFileSync(
      "grep",
      ["-rl", "--include=*.ts", "--include=*.tsx", DISCLOSURE, "apps", "packages"],
      { cwd: ROOT, encoding: "utf8" },
    );
  } catch (err) {
    // grep exits 1 when there are no matches at all — that is not a failure here
    const e = err as { status?: number; stdout?: string };
    if (e.status !== 1) throw err;
    out = e.stdout ?? "";
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => !f.includes("node_modules"));
}

describe("#131 every published description goes through the shared builder", () => {
  it("the AI-content disclosure literal lives ONLY in publish-credits (and its tests)", () => {
    const offenders = grepDisclosure().filter(
      (f) => !f.endsWith("packages/core/src/publish-credits.ts") && !f.startsWith("packages/core/test/"),
    );
    expect(
      offenders,
      `These files build a publish description by hand instead of calling assemblePublishDescription, ` +
        `which means they also skip imageCreditLines/musicCreditLines — the exact defect #131 found in ` +
        `publish-clip.ts. Assemble through packages/core/src/publish-credits.ts instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the guard can actually see the source tree (so a green result means something)", () => {
    // a grep that silently matched nothing would make the assertion above vacuous
    expect(grepDisclosure()).toContain("packages/core/src/publish-credits.ts");
  });
});
