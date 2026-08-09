import { describe, expect, it } from "vitest";
import {
  audioAttributionLine,
  audioLicenceDeedUrl,
  audioLicenceTraits,
  normaliseAudioLicence,
  parseLicencePageHtml,
} from "../src/audio-assets";

// #110: the audio library's compliance behaviour is all pure — these tests ARE
// the closeable verification for the licence gate, the attribution generator
// and the enrichment parser.

describe("normaliseAudioLicence", () => {
  it("normalises the common spellings to the platform labels", () => {
    expect(normaliseAudioLicence("cc0")).toBe("CC0");
    expect(normaliseAudioLicence("CC0 1.0")).toBe("CC0");
    expect(normaliseAudioLicence("public domain")).toBe("Public domain");
    expect(normaliseAudioLicence("pdm")).toBe("Public domain");
    expect(normaliseAudioLicence("cc-by")).toBe("CC BY");
    expect(normaliseAudioLicence("CC BY 4.0")).toBe("CC BY 4.0");
    expect(normaliseAudioLicence("by-sa", "3.0")).toBe("CC BY-SA 3.0");
    expect(normaliseAudioLicence("cc by-nc-sa 3.0")).toBe("CC BY-NC-SA 3.0");
    expect(normaliseAudioLicence("Attribution-NonCommercial 4.0")).toBe("CC BY-NC 4.0");
    expect(normaliseAudioLicence("proprietary")).toBe("Proprietary");
  });

  it("reads a deed URL, including the version", () => {
    expect(normaliseAudioLicence("https://creativecommons.org/licenses/by-sa/4.0/")).toBe("CC BY-SA 4.0");
    expect(normaliseAudioLicence("https://creativecommons.org/publicdomain/zero/1.0/")).toBe("CC0");
  });

  it("returns null rather than guessing", () => {
    expect(normaliseAudioLicence("")).toBeNull();
    expect(normaliseAudioLicence("some rights reserved")).toBeNull();
    expect(normaliseAudioLicence(null)).toBeNull();
  });
});

describe("audioLicenceTraits — the monetisation gate", () => {
  it("CC0/PD: commercial, no attribution required", () => {
    for (const l of ["CC0", "public domain"]) {
      const t = audioLicenceTraits(l);
      expect(t).toEqual({ known: true, commercialUse: true, attributionRequired: false, shareAlike: false });
    }
  });

  it("CC BY / BY-SA: commercial, attribution REQUIRED", () => {
    expect(audioLicenceTraits("CC BY 4.0")).toEqual({
      known: true,
      commercialUse: true,
      attributionRequired: true,
      shareAlike: false,
    });
    expect(audioLicenceTraits("cc by-sa 3.0").shareAlike).toBe(true);
    expect(audioLicenceTraits("cc by-sa 3.0").commercialUse).toBe(true);
  });

  it("NC and ND are NEVER commercial-safe — a monetised channel is commercial use", () => {
    for (const l of ["CC BY-NC 4.0", "cc by-nd", "CC BY-NC-SA 3.0", "CC BY-NC-ND 4.0"]) {
      expect(audioLicenceTraits(l).commercialUse).toBe(false);
    }
  });

  it("proprietary and unknown do not assume commercial rights", () => {
    expect(audioLicenceTraits("Proprietary").commercialUse).toBe(false);
    expect(audioLicenceTraits("mystery licence")).toEqual({
      known: false,
      commercialUse: false,
      attributionRequired: false,
      shareAlike: false,
    });
    expect(audioLicenceTraits(null).known).toBe(false);
  });
});

describe("audioAttributionLine — the T.A.S.L. credit", () => {
  it("formats the full credit for a CC BY track", () => {
    const line = audioAttributionLine({
      title: "Dark Ambient 2",
      creator: "strathamer",
      creatorUrl: "https://freesound.org/people/strathamer/",
      sourceUrl: "https://freesound.org/s/415890/",
      licence: "CC BY 4.0",
      modified: true,
    });
    expect(line).toBe(
      '"Dark Ambient 2" by strathamer (https://freesound.org/people/strathamer/), via https://freesound.org/s/415890/, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Modified.',
    );
  });

  it("returns null when nothing is required (CC0 / PD)", () => {
    expect(audioAttributionLine({ title: "T", licence: "CC0" })).toBeNull();
    expect(audioAttributionLine({ title: "T", licence: "Public domain" })).toBeNull();
  });

  it("an explicit licenceUrl wins over the derived deed", () => {
    const line = audioAttributionLine({
      title: "T",
      creator: "c",
      licence: "CC BY-SA 3.0",
      licenceUrl: "https://creativecommons.org/licenses/by-sa/3.0/deed.en",
    });
    expect(line).toContain("https://creativecommons.org/licenses/by-sa/3.0/deed.en");
  });
});

describe("audioLicenceDeedUrl", () => {
  it("derives the deed for CC labels, null otherwise", () => {
    expect(audioLicenceDeedUrl("CC BY 3.0")).toBe("https://creativecommons.org/licenses/by/3.0/");
    expect(audioLicenceDeedUrl("CC0")).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
    expect(audioLicenceDeedUrl("Proprietary")).toBeNull();
    expect(audioLicenceDeedUrl("nonsense")).toBeNull();
  });
});

describe("parseLicencePageHtml — enrichment stays honest", () => {
  it("reads a freesound-style page: og:title 'name by artist' + a CC deed link", () => {
    const html = `
      <html><head>
        <title>Freesound — irrelevant</title>
        <meta property="og:title" content="Dark Ambient 2 by strathamer" />
      </head><body>
        <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
      </body></html>`;
    const r = parseLicencePageHtml(html);
    expect(r.title).toBe("Dark Ambient 2");
    expect(r.creator).toBe("strathamer");
    expect(r.licence).toBe("CC BY 4.0");
    expect(r.licenceVersion).toBe("4.0");
    expect(r.licenceUrl).toBe("https://creativecommons.org/licenses/by/4.0/");
  });

  it("returns nulls when the page carries no signal — never guesses", () => {
    const r = parseLicencePageHtml("<html><body>nothing here</body></html>");
    expect(r).toEqual({ title: null, creator: null, licence: null, licenceVersion: null, licenceUrl: null });
  });

  it("recognises a CC0 zero deed", () => {
    const r = parseLicencePageHtml(
      `<title>Track page</title><a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a>`,
    );
    expect(r.licence).toBe("CC0");
    expect(r.title).toBe("Track page");
  });
});
