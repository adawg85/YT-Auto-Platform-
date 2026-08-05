/**
 * Chunked YouTube upload (2026-08-05 OOM).
 *
 * The single-shot upload handed the whole store stream to fetch as a request
 * body. That reads as streaming and is not: uploading a 42-minute master took
 * the worker from its ~350MB baseline to ~1.7GB and held it there until Render
 * OOM-killed the 2GB instance ~4m47s in. Inngest recorded the step as "server
 * returned HTTP 502 before the SDK responded" — no step output, because the
 * process was gone. One episode failed to reach YouTube across five attempts.
 *
 * The memory profile is not assertable in a unit test, but the two properties
 * that make it impossible are:
 *   1. every chunk except the last is EXACTLY the configured size — YouTube
 *      rejects a mid-upload chunk that is not a 256KiB multiple;
 *   2. the chunks reassemble to the original bytes, in order, with none
 *      dropped or duplicated (a silent truncation would publish a broken video,
 *      which is the 2026-07-12 shell-video incident this file already guards).
 */
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { UPLOAD_CHUNK_BYTES, chunkStream } from "../src/real/publish";

async function collect(source: AsyncIterable<Buffer>, size: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const c of chunkStream(source, size)) out.push(c);
  return out;
}

describe("chunkStream", () => {
  it("emits exact-size chunks with a short tail, and loses nothing", async () => {
    // 10 pieces of 700B = 7000B through a 1024B chunker: 6 full + a 856B tail
    const pieces = Array.from({ length: 10 }, (_, i) => Buffer.alloc(700, i));
    const chunks = await collect(Readable.from(pieces), 1024);

    expect(chunks.slice(0, -1).every((c) => c.length === 1024)).toBe(true);
    expect(chunks.at(-1)!.length).toBe(7000 - 6 * 1024);
    expect(Buffer.concat(chunks).equals(Buffer.concat(pieces))).toBe(true);
  });

  it("splits a single piece larger than several chunks", async () => {
    // the loop-drain case: one 5000B read must become 4x1024 + 904
    const one = Buffer.alloc(5000, 9);
    const chunks = await collect(Readable.from([one]), 1024);

    expect(chunks.map((c) => c.length)).toEqual([1024, 1024, 1024, 1024, 904]);
    expect(Buffer.concat(chunks).equals(one)).toBe(true);
  });

  it("emits a single short chunk when the whole body is smaller than one chunk", async () => {
    const small = Buffer.from("a short video");
    const chunks = await collect(Readable.from([small]), 1024);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.equals(small)).toBe(true);
  });

  it("emits nothing for an empty stream", async () => {
    expect(await collect(Readable.from([]), 1024)).toHaveLength(0);
  });

  it("emits no tail when the length divides exactly", async () => {
    const exact = Buffer.alloc(2048, 3);
    const chunks = await collect(Readable.from([exact]), 1024);
    expect(chunks.map((c) => c.length)).toEqual([1024, 1024]);
  });

  it("preserves byte order across ragged piece boundaries", async () => {
    // pieces that do not align to the chunk size at any point
    const pieces = [7, 13, 101, 3, 997, 51].map((n, i) => Buffer.alloc(n, i + 1));
    const chunks = await collect(Readable.from(pieces), 64);
    expect(Buffer.concat(chunks).equals(Buffer.concat(pieces))).toBe(true);
    expect(chunks.slice(0, -1).every((c) => c.length === 64)).toBe(true);
  });

  it("uses a chunk size YouTube accepts mid-upload (multiple of 256KiB)", () => {
    expect(UPLOAD_CHUNK_BYTES % (256 * 1024)).toBe(0);
    expect(UPLOAD_CHUNK_BYTES).toBe(8 * 1024 * 1024);
  });

  it("computes contiguous Content-Range windows over a whole file", async () => {
    // mirrors the upload loop's arithmetic: ranges must tile [0, total) exactly
    const total = 5000;
    const chunks = await collect(Readable.from([Buffer.alloc(total, 1)]), 1024);
    let sent = 0;
    const ranges: string[] = [];
    for (const c of chunks) {
      ranges.push(`bytes ${sent}-${sent + c.length - 1}/${total}`);
      sent += c.length;
    }
    expect(sent).toBe(total);
    expect(ranges[0]).toBe("bytes 0-1023/5000");
    expect(ranges.at(-1)).toBe("bytes 4096-4999/5000");
  });
});
