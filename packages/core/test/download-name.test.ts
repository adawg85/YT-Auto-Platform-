/**
 * Download filenames (2026-08-05). The cockpit gained a "Download video"
 * button so a rendered master can be pulled BEFORE publish — added because a
 * 42-minute episode rendered fine but could not be uploaded, and there was no
 * way to get the finished file out of the platform.
 *
 * The name is built from the episode title and reaches a Content-Disposition
 * header, so the slugify step is the thing worth pinning: real titles carry
 * `|`, `:`, smart quotes and non-ASCII, and a raw title in that header is at
 * best an unopenable file and at worst header injection.
 */
import { describe, expect, it } from "vitest";
import { downloadName } from "../src/publish";

describe("downloadName", () => {
  it("slugifies a real episode title", () => {
    expect(downloadName("When You Stop Being the Good One, Everything Changes | Carl Jung", "01KYRB")).toBe(
      "when-you-stop-being-the-good-one-everything-changes-carl-jung.mp4",
    );
  });

  it("drops smart quotes rather than turning them into separators", () => {
    // “Don’t” must not become "don-t"
    expect(downloadName("Don’t Look Back", "p1")).toBe("dont-look-back.mp4");
  });

  it("strips characters that break Content-Disposition or the filesystem", () => {
    const name = downloadName('A/B: "test" \\ <x> \r\n | y', "p1");
    expect(name).not.toMatch(/[/\\"\r\n<>:|]/);
    expect(name.endsWith(".mp4")).toBe(true);
  });

  it("falls back to the production id when the title yields nothing", () => {
    expect(downloadName("", "01KYRBCPPP")).toBe("01KYRBCPPP.mp4");
    expect(downloadName(null, "01KYRBCPPP")).toBe("01KYRBCPPP.mp4");
    expect(downloadName(undefined, "01KYRBCPPP")).toBe("01KYRBCPPP.mp4");
    // a title of only punctuation slugifies to empty — still must not be ".mp4"
    expect(downloadName("!!! ??? ---", "01KYRBCPPP")).toBe("01KYRBCPPP.mp4");
  });

  it("caps length and never ends on a separator", () => {
    const name = downloadName("word ".repeat(60), "p1");
    expect(name.length).toBeLessThanOrEqual(80 + ".mp4".length);
    expect(name).not.toMatch(/-\.mp4$/);
  });

  it("honours the extension for non-video assets", () => {
    expect(downloadName("My Episode", "p1", "mp3")).toBe("my-episode.mp3");
  });

  it("handles a non-ASCII title without emitting a leading separator", () => {
    expect(downloadName("日本語 title", "p1")).toBe("title.mp4");
  });
});
