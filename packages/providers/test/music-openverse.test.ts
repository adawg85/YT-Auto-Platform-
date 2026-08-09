import { afterEach, describe, expect, it, vi } from "vitest";
import type { Readable } from "node:stream";
import {
  createOpenverseMusicProvider,
  describeFetchFailure,
  downloadHeaders,
  hostOf,
} from "../src/real/music-openverse";
import type { ObjectStore } from "../src/types";

// #110: every set_music_bed(addOpenverseTrack) failed with a generic
// "Couldn't download that track — try another", hiding a systemic
// cdn.freesound.org block behind a per-asset-looking message. These tests pin
// the two halves of the fix: the download goes out browser-shaped (undici's
// default `user-agent: node` is what media CDNs 403), and every failure mode
// names the host + actual cause instead of collapsing to null.

const FREESOUND_URL = "https://cdn.freesound.org/previews/157/157133_1038806-hq.mp3";

function fakeStore(overrides: Partial<ObjectStore> = {}): ObjectStore {
  return {
    put: vi.fn(async () => {}),
    getBuffer: vi.fn(async () => Buffer.alloc(0)),
    getStream: vi.fn(async () => ({ stream: null as unknown as Readable })),
    exists: vi.fn(async () => false),
    ...overrides,
  };
}

function audioResponse(bytes: number, contentType = "audio/mpeg"): Response {
  return new Response(new Uint8Array(bytes).fill(1), {
    status: 200,
    headers: { "content-type": contentType, "content-length": String(bytes) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadHeaders", () => {
  it("sends a browser-like user-agent, never undici's default", () => {
    const h = downloadHeaders(FREESOUND_URL);
    expect(h["user-agent"]).toMatch(/^Mozilla\/5\.0/);
    expect(h.accept).toContain("audio/");
  });

  it("adds a freesound referer for freesound hosts only", () => {
    expect(downloadHeaders(FREESOUND_URL).referer).toBe("https://freesound.org/");
    expect(downloadHeaders("https://upload.wikimedia.org/track.ogg").referer).toBeUndefined();
  });
});

describe("describeFetchFailure", () => {
  it("names a timeout with the host", () => {
    const err = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    expect(describeFetchFailure("cdn.freesound.org", err, 30)).toBe(
      "timed out after 30s fetching cdn.freesound.org",
    );
  });

  it("surfaces undici's cause code (DNS/refused) with the host", () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(describeFetchFailure("cdn.freesound.org", err, 30)).toBe(
      "network error fetching cdn.freesound.org (ENOTFOUND)",
    );
  });

  it("falls back to the message when there is no cause", () => {
    expect(describeFetchFailure("h", new Error("boom"), 30)).toContain("boom");
  });
});

describe("hostOf", () => {
  it("extracts the hostname and tolerates junk", () => {
    expect(hostOf(FREESOUND_URL)).toBe("cdn.freesound.org");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("importTrack", () => {
  it("downloads with browser headers and stores the file", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => audioResponse(4096));
    vi.stubGlobal("fetch", fetchMock);
    const store = fakeStore();
    const provider = createOpenverseMusicProvider(store);
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "channels/c/music/t" });
    expect(res).toEqual({ ok: true, storageKey: "channels/c/music/t.mp3", mimeType: "audio/mpeg" });
    const [url, init = {}] = fetchMock.mock.calls[0]!;
    expect(url).toBe(FREESOUND_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/^Mozilla\/5\.0/);
    expect(headers.referer).toBe("https://freesound.org/");
    expect(init.redirect).toBe("follow");
    expect(store.put).toHaveBeenCalledWith("channels/c/music/t.mp3", expect.any(Buffer), "audio/mpeg");
  });

  it("reports the HTTP status and host on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    const provider = createOpenverseMusicProvider(fakeStore());
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "k" });
    expect(res).toEqual({ ok: false, reason: "HTTP 403 from cdn.freesound.org" });
  });

  it("reports a network failure with the host, not a generic null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }),
    );
    const provider = createOpenverseMusicProvider(fakeStore());
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "k" });
    expect(res).toEqual({ ok: false, reason: "network error fetching cdn.freesound.org (ECONNREFUSED)" });
  });

  it("flags a too-small body as not-an-audio-file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse(100)));
    const provider = createOpenverseMusicProvider(fakeStore());
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("cdn.freesound.org returned 100 bytes — not an audio file");
  });

  it("distinguishes a storage failure from a download failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse(4096)));
    const store = fakeStore({
      put: vi.fn(async () => {
        throw new Error("S3 credentials expired");
      }),
    });
    const provider = createOpenverseMusicProvider(store);
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("downloaded fine but storing failed (S3 credentials expired)");
  });

  it("rejects a declared-oversize file before downloading the body", async () => {
    const big = new Response("x", {
      status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": String(200 * 1024 * 1024) },
    });
    vi.stubGlobal("fetch", vi.fn(async () => big));
    const provider = createOpenverseMusicProvider(fakeStore());
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("file is 200MB, over the 60MB cap (cdn.freesound.org)");
  });

  it("picks the extension from the content-type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse(4096, "audio/ogg")));
    const provider = createOpenverseMusicProvider(fakeStore());
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "k" });
    expect(res).toEqual({ ok: true, storageKey: "k.ogg", mimeType: "audio/ogg" });
  });
});

describe("probeDownload", () => {
  it("range-GETs with the same browser headers and reports ok", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => audioResponse(1024));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenverseMusicProvider(fakeStore());
    const res = await provider.probeDownload!(FREESOUND_URL);
    expect(res).toEqual({ ok: true, detail: "HTTP 200 from cdn.freesound.org" });
    const [, init = {}] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.range).toBe("bytes=0-1023");
    expect(headers["user-agent"]).toMatch(/^Mozilla\/5\.0/);
  });

  it("reports the blocking status so search can warn before an import", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    const provider = createOpenverseMusicProvider(fakeStore());
    const res = await provider.probeDownload!(FREESOUND_URL);
    expect(res).toEqual({ ok: false, detail: "HTTP 403 from cdn.freesound.org" });
  });
});
