import { describe, expect, it } from "vitest";
import { estimateAudioDurationSec } from "../src/audio-duration";

// #110 follow-up: durationSec was null on every registered asset because
// nothing read it off the bytes — these pin the container parsers the ingest
// probe and the lazy backfill share.

function wavFile(byteRate: number, dataBytes: number): Buffer {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8, "latin1");
  b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16); // fmt chunk size
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(2, 22); // stereo
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

/** MPEG1 Layer III frame header @44100: 0xFF 0xFB, bitrate idx in the high nibble. */
function mp3Header(bitrateIdx: number): Buffer {
  return Buffer.from([0xff, 0xfb, (bitrateIdx << 4) | 0x00, 0x00]); // stereo, 44.1kHz
}

describe("estimateAudioDurationSec", () => {
  it("WAV: data bytes / byteRate", () => {
    // 176400 B/s (44.1kHz stereo 16-bit), 1,764,000 data bytes → 10s
    const head = wavFile(176400, 1_764_000);
    expect(estimateAudioDurationSec(head, 1_764_044, "audio/wav")).toBe(10);
  });

  it("MP3 CBR: file size × 8 / bitrate", () => {
    // 128kbps (idx 9): 160,000 bytes → 10s
    const head = Buffer.concat([mp3Header(9), Buffer.alloc(64)]);
    expect(estimateAudioDurationSec(head, 160_000, "audio/mpeg")).toBe(10);
  });

  it("MP3 with an ID3v2 tag still finds the first frame", () => {
    const id3 = Buffer.alloc(10 + 100);
    id3.write("ID3", 0, "latin1");
    id3[9] = 100; // syncsafe size
    const head = Buffer.concat([id3, mp3Header(9), Buffer.alloc(64)]);
    // audio bytes = 160,000 → 10s regardless of the 110-byte tag preamble
    expect(estimateAudioDurationSec(head, 160_000 + 110, "audio/mpeg")).toBe(10);
  });

  it("MP3 VBR: exact from the Xing frame count, ignoring the CBR estimate", () => {
    const frame = Buffer.concat([mp3Header(9), Buffer.alloc(200)]);
    // MPEG1 stereo → Xing sits at frame start + 36
    frame.write("Xing", 36, "latin1");
    frame.writeUInt32BE(0x1, 40); // frames flag
    frame.writeUInt32BE(3830, 44); // 3830 × 1152 / 44100 ≈ 100.05s → 100.0
    expect(estimateAudioDurationSec(frame, 5_000_000, "audio/mpeg")).toBe(100);
  });

  it("FLAC: exact from STREAMINFO samples / sample rate", () => {
    const b = Buffer.alloc(4 + 4 + 34);
    b.write("fLaC", 0, "latin1");
    b[4] = 0x00; // STREAMINFO
    b.writeUIntBE(34, 5, 3);
    const d = 8;
    b[d + 10] = 0x0a; // 44100Hz across 20 bits…
    b[d + 11] = 0xc4;
    b[d + 12] = 0x40;
    b.writeUInt32BE(441_000, d + 14); // 10s of samples
    expect(estimateAudioDurationSec(b, b.length, "audio/flac")).toBe(10);
  });

  it("M4A: mvhd duration / timescale", () => {
    const b = Buffer.alloc(64);
    b.write("mvhd", 8, "latin1");
    b[12] = 0; // version 0
    b.writeUInt32BE(1000, 8 + 16); // timescale
    b.writeUInt32BE(10_000, 8 + 20); // duration → 10s
    expect(estimateAudioDurationSec(b, b.length, "audio/mp4")).toBe(10);
  });

  it("unreadable container → honest null, never a guess", () => {
    expect(estimateAudioDurationSec(Buffer.from("OggS junk that is not parseable"), 1_000_000, "audio/ogg")).toBeNull();
    expect(estimateAudioDurationSec(Buffer.alloc(0), 0, "audio/mpeg")).toBeNull();
  });

  it("wrong mime still parses via magic bytes", () => {
    const head = wavFile(176400, 1_764_000);
    expect(estimateAudioDurationSec(head, 1_764_044, "application/octet-stream")).toBe(10);
  });
});
