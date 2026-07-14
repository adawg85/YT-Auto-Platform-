import { describe, expect, it } from "vitest";
import { MOCK_MP4_BASE64 } from "@ytauto/providers";
import { normalizeClipBuffer } from "../src/footage";

/** The shared trim/normalize contract every beat clip (archival, Pexels, AI)
 * must meet before Remotion <OffthreadVideo> sees it. Uses the providers'
 * embedded 12s mock mp4 as the source. */
describe("normalizeClipBuffer", () => {
  const src = Buffer.from(MOCK_MP4_BASE64, "base64");

  it("trims the 12s fixture to a beat-length mp4 (ftyp header, sane size)", async () => {
    const clip = await normalizeClipBuffer(src, { aspect: "9:16", clipSec: 5, introSkipSec: 0 });
    expect(clip).not.toBeNull();
    expect(clip!.subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(clip!.length).toBeGreaterThan(10_000);
    // trimmed output must be a different (shorter) encode than the source
    expect(clip!.equals(src)).toBe(false);
  });

  it("returns null for a source that can't produce a usable clip", async () => {
    const clip = await normalizeClipBuffer(Buffer.from("not a video"), {
      aspect: "16:9",
      clipSec: 5,
    });
    expect(clip).toBeNull();
  });
});
