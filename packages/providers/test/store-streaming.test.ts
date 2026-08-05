/**
 * ObjectStore streaming contract (2026-08-05 memory review).
 *
 * derive-shorts used to pull a whole long-form master into a Node Buffer
 * (`getBuffer`) before handing it to ffmpeg, and read each cut clip back with
 * `readFile` before uploading. On a 2GB worker that showed up as a ~1.9GB
 * spike — ~95% of the instance limit, and an outright OOM on anything smaller.
 *
 * `put` now takes a `Readable` so those two hops stream. The memory profile
 * itself is not assertable in a unit test, but the contract that makes it
 * possible is: a streamed body must round-trip byte-identically, and the S3
 * backend must REFUSE a stream with no declared length rather than quietly
 * buffering the whole thing to find one (which would reinstate the bug).
 */
import { createReadStream } from "node:fs";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFsObjectStore } from "../src/store/fs";
import { createS3ObjectStore } from "../src/store/s3";

const baseDir = mkdtempSync(join(tmpdir(), "ytauto-store-stream-"));
const store = createFsObjectStore(baseDir);

describe("ObjectStore streaming put", () => {
  it("round-trips a streamed body byte-identically", async () => {
    const body = Buffer.from("part-1 vertical clip bytes");
    await store.put("productions/p1/final.mp4", Readable.from(body), "video/mp4");
    expect(await store.getBuffer("productions/p1/final.mp4")).toEqual(body);
  });

  it("round-trips a file stream, the shape derive-shorts uses", async () => {
    const src = join(baseDir, "part-1.mp4");
    const body = Buffer.alloc(256 * 1024, 7); // bigger than one chunk
    await writeFile(src, body);

    await store.put("productions/p2/final.mp4", createReadStream(src), "video/mp4", {
      contentLength: body.byteLength,
    });

    const got = await store.getBuffer("productions/p2/final.mp4");
    expect(got.byteLength).toBe(body.byteLength);
    expect(got.equals(body)).toBe(true);
  });

  it("still accepts a Buffer body unchanged", async () => {
    const body = Buffer.from("thumbnail bytes");
    await store.put("productions/p3/thumb.png", body, "image/png");
    expect(await store.getBuffer("productions/p3/thumb.png")).toEqual(body);
  });

  it("S3 rejects a streamed body with no contentLength instead of buffering it", async () => {
    const s3 = createS3ObjectStore({
      region: "auto",
      bucket: "test",
      accessKeyId: "x",
      secretAccessKey: "y",
      endpoint: "http://127.0.0.1:1", // never dialled: the guard throws first
    });

    await expect(
      s3.put("productions/p4/final.mp4", Readable.from(Buffer.from("abc")), "video/mp4"),
    ).rejects.toThrow(/requires opts\.contentLength/);
  });
});
