/**
 * YouTube id parsing (2026-08-05), for the manual-publish control.
 *
 * When an upload has to be done by hand — an unverified channel, or a worker
 * that died mid-upload — the operator pastes whatever YouTube gave them and the
 * platform reattaches the record. Getting this wrong is not cosmetic: storing a
 * mis-parsed id produces a publication row that reconcile_publications later
 * reports as `missing_on_youtube`, which is exactly the phantom-record state
 * this platform already has scar tissue about. So rejecting a doubtful input is
 * strictly better than guessing at one.
 */
import { describe, expect, it } from "vitest";
import { parseYouTubeVideoId } from "../src/publish";

const ID = "jreAKQCsl68";

describe("parseYouTubeVideoId", () => {
  it("accepts a bare id", () => {
    expect(parseYouTubeVideoId(ID)).toBe(ID);
    expect(parseYouTubeVideoId(`  ${ID}  `)).toBe(ID);
  });

  it("accepts the formats YouTube actually hands you", () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `http://www.youtube.com/watch?v=${ID}`,
      `www.youtube.com/watch?v=${ID}`,
      `youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://youtu.be/${ID}?t=42`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/live/${ID}`,
      `https://www.youtube.com/v/${ID}`,
    ]) {
      expect(parseYouTubeVideoId(url), url).toBe(ID);
    }
  });

  it("keeps the id when extra query params ride along", () => {
    // the share sheet adds these constantly
    expect(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${ID}&list=PLabc&index=2&t=10s`)).toBe(ID);
  });

  it("rejects anything that is not confidently a video id", () => {
    for (const bad of [
      "",
      "   ",
      "not a url",
      "https://vimeo.com/123456",
      "https://www.youtube.com/@somechannel",
      "https://www.youtube.com/playlist?list=PLabc",
      "https://www.youtube.com/watch?v=tooshort",
      "https://www.youtube.com/watch?v=waaaaaaaaytoolong",
      "https://youtu.be/short",
      "https://example.com/watch?v=jreAKQCsl68",
      "javascript:alert(1)",
    ]) {
      expect(parseYouTubeVideoId(bad), bad).toBeNull();
    }
  });

  it("does not mistake a channel handle for an id", () => {
    // 11 chars of the right alphabet in a path segment we don't trust
    expect(parseYouTubeVideoId("https://www.youtube.com/c/abcdefghijk")).toBeNull();
  });
});
