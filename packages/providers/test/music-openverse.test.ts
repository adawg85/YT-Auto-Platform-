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
    // #110 reopen: a known-length body STREAMS to the store (memory stays flat,
    // duration stops being the limiter) — not a whole-file Buffer
    expect(store.put).toHaveBeenCalledWith(
      "channels/c/music/t.mp3",
      expect.objectContaining({ pipe: expect.any(Function) }),
      "audio/mpeg",
      { contentLength: 4096 },
    );
  });

  it("#110: a body with NO content-length falls back to the buffered path", async () => {
    const body = new Uint8Array(4096).fill(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const r = new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } });
        r.headers.delete("content-length");
        return r;
      }),
    );
    const store = fakeStore();
    const provider = createOpenverseMusicProvider(store);
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "k" });
    expect(res).toEqual({ ok: true, storageKey: "k.mp3", mimeType: "audio/mpeg" });
    expect(store.put).toHaveBeenCalledWith("k.mp3", expect.any(Buffer), "audio/mpeg");
  });

  // #110 follow-up ("durationSec is null on every registered asset"): both
  // import paths probe the container header on the way past.
  it("probes durationSec on the buffered path (CBR mp3: bytes×8/bitrate)", async () => {
    const mp3 = new Uint8Array(160_000).fill(1); // 128kbps CBR → 10s
    mp3.set([0xff, 0xfb, 0x90, 0x00], 0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const r = new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg" } });
        r.headers.delete("content-length");
        return r;
      }),
    );
    const provider = createOpenverseMusicProvider(fakeStore());
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "k" });
    expect(res).toMatchObject({ ok: true, durationSec: 10 });
  });

  it("probes durationSec on the streamed path (head teed while the store consumes)", async () => {
    const mp3 = new Uint8Array(160_000).fill(1);
    mp3.set([0xff, 0xfb, 0x90, 0x00], 0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(mp3.length) } })),
    );
    // the real stores consume the stream — the tee only sees bytes that flow
    const store = fakeStore({
      put: vi.fn(async (_k: string, body: Buffer | Readable) => {
        for await (const chunk of body as Readable) void chunk;
      }),
    });
    const provider = createOpenverseMusicProvider(store);
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "k" });
    expect(res).toMatchObject({ ok: true, storageKey: "k.mp3", durationSec: 10 });
  });

  it("#110: a stalled stream reports a timeout with the host, not a storage error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse(4096)));
    const store = fakeStore({
      put: vi.fn(async () => {
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      }),
    });
    const provider = createOpenverseMusicProvider(store);
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "k" });
    expect(res).toEqual({ ok: false, reason: "timed out after 120s fetching cdn.freesound.org" });
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

  it("distinguishes a storage failure from a download failure (stream path)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse(4096)));
    const store = fakeStore({
      put: vi.fn(async () => {
        throw new Error("S3 credentials expired");
      }),
    });
    const provider = createOpenverseMusicProvider(store);
    const res = await provider.importTrack({ audioUrl: FREESOUND_URL, storageKeyBase: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("download stream failed mid-transfer, or storing failed (S3 credentials expired)");
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

describe("search (#110 reopen — music category + duration filter)", () => {
  const ovResult = (id: string, durationMs: number) => ({
    id,
    title: `t-${id}`,
    url: `https://cdn.freesound.org/previews/${id}.mp3`,
    foreign_landing_url: `https://freesound.org/s/${id}/`,
    creator: "c",
    license: "cc0",
    duration: durationMs,
  });
  const jsonResponse = (results: unknown[]) =>
    new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });

  it("asks Openverse for MUSIC of usable length, and keeps the licence filter on every branch", async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse([ovResult("a", 349_000)]));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenverseMusicProvider(fakeStore());
    const tracks = await provider.search("dark ambient", { minDurationSec: 150 });
    expect(tracks).toHaveLength(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("category=music");
    expect(url).toContain("length=medium,long");
    expect(url).toContain("license=cc0,pdm,by,by-sa"); // NC/ND never come back
  });

  it("falls back to a looser query when the music-only result set is empty", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("category=music") ? jsonResponse([]) : jsonResponse([ovResult("b", 200_000)]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenverseMusicProvider(fakeStore());
    const tracks = await provider.search("obscure niche query", { minDurationSec: 150 });
    expect(tracks).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.every(([u]) => (u as string).includes("license=cc0,pdm,by,by-sa"))).toBe(true);
  });

  it("drops tracks under minDurationSec client-side — the 29s loop trap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([ovResult("short", 29_000), ovResult("long", 349_000)])),
    );
    const provider = createOpenverseMusicProvider(fakeStore());
    const tracks = await provider.search("dark ambient", { minDurationSec: 150 });
    expect(tracks.map((t) => t.id)).toEqual(["long"]);
  });

  it("minDurationSec 0 disables the length filtering entirely", async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse([ovResult("short", 29_000)]));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenverseMusicProvider(fakeStore());
    const tracks = await provider.search("stinger", { minDurationSec: 0 });
    expect(tracks).toHaveLength(1);
    expect(fetchMock.mock.calls[0]![0]).not.toContain("length=");
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

  it("#110: reports the FULL file size from a 206's content-range — reachability, not a download guarantee", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(1024), {
            status: 206,
            headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-1023/9876543" },
          }),
      ),
    );
    const provider = createOpenverseMusicProvider(fakeStore());
    const res = await provider.probeDownload!(FREESOUND_URL);
    expect(res.ok).toBe(true);
    expect(res.sizeBytes).toBe(9876543);
    expect(res.detail).toContain("9.4MB full file");
  });

  it("reports the blocking status so search can warn before an import", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    const provider = createOpenverseMusicProvider(fakeStore());
    const res = await provider.probeDownload!(FREESOUND_URL);
    expect(res).toEqual({ ok: false, detail: "HTTP 403 from cdn.freesound.org" });
  });
});
