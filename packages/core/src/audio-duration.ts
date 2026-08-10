/**
 * #110 follow-up ("durationSec is null on every registered asset"): estimate a
 * track's duration from its container header — the one T.A.S.L.-adjacent field
 * that is NOT discoverable from the source page, because it lives in the bytes.
 * Pure function over the file's HEAD (first ~256KB is plenty) plus the total
 * byte count, so both ingest paths (the streamed MCP fetch and the cockpit
 * upload) and the lazy backfill of existing rows share one implementation.
 *
 * Honest nulls: a container we can't read (ogg/webm — their duration lives at
 * the END of the file) returns null rather than a guess; `list_audio_assets`'
 * minDurationSec filter treats null as unknown, and the operator can still set
 * the field via patch_audio_asset.
 */

const MAX_SANE_SEC = 24 * 60 * 60; // beyond a day is a parse error, not a track

function u32be(b: Buffer, off: number): number {
  return b.length >= off + 4 ? b.readUInt32BE(off) : 0;
}

/** WAV: byteRate lives in the fmt chunk; duration = data bytes / byteRate. */
function wavDuration(head: Buffer, totalBytes: number): number | null {
  if (head.length < 44 || head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") {
    return null;
  }
  let off = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (off + 8 <= head.length) {
    const id = head.toString("latin1", off, off + 4);
    const size = head.readUInt32LE(off + 4);
    if (id === "fmt " && off + 16 + 4 <= head.length) byteRate = head.readUInt32LE(off + 16);
    if (id === "data") {
      // a streamed/placeholder size (0 or 0xFFFFFFFF) → fall back to file size
      dataBytes = size > 0 && size !== 0xffffffff ? size : Math.max(totalBytes - (off + 8), 0);
      break;
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!byteRate) return null;
  if (!dataBytes) dataBytes = Math.max(totalBytes - 44, 0);
  return dataBytes / byteRate;
}

/** FLAC: STREAMINFO carries exact total samples + sample rate. */
function flacDuration(head: Buffer): number | null {
  if (head.length < 4 + 4 + 34 || head.toString("latin1", 0, 4) !== "fLaC") return null;
  // first metadata block must be STREAMINFO (type 0)
  if ((head[4]! & 0x7f) !== 0) return null;
  const d = 8; // STREAMINFO data start
  const sampleRate = (head[d + 10]! << 12) | (head[d + 11]! << 4) | (head[d + 12]! >> 4);
  const totalSamples = (head[d + 13]! & 0x0f) * 2 ** 32 + u32be(head, d + 14);
  if (!sampleRate || !totalSamples) return null;
  return totalSamples / sampleRate;
}

/** MP4/M4A: the mvhd atom (duration/timescale) usually sits in the head. */
function mp4Duration(head: Buffer): number | null {
  const p = head.indexOf("mvhd", 0, "latin1");
  if (p < 0 || p + 32 > head.length) return null;
  const version = head[p + 4];
  if (version === 0) {
    const timescale = u32be(head, p + 16);
    const duration = u32be(head, p + 20);
    return timescale ? duration / timescale : null;
  }
  if (version === 1 && p + 36 <= head.length) {
    const timescale = u32be(head, p + 24);
    const duration = u32be(head, p + 28) * 2 ** 32 + u32be(head, p + 32);
    return timescale ? duration / timescale : null;
  }
  return null;
}

const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};

/**
 * MP3: exact from a Xing/Info/VBRI frame-count header when present (VBR files
 * carry one); otherwise the CBR estimate audioBytes*8/bitrate — accurate for
 * constant-bitrate files, which is what music libraries serve.
 */
function mp3Duration(head: Buffer, totalBytes: number): number | null {
  let off = 0;
  if (head.toString("latin1", 0, 3) === "ID3" && head.length > 10) {
    const size = ((head[6]! & 0x7f) << 21) | ((head[7]! & 0x7f) << 14) | ((head[8]! & 0x7f) << 7) | (head[9]! & 0x7f);
    off = 10 + size;
  }
  // find the first frame sync within the head
  while (off + 4 < head.length && !(head[off] === 0xff && (head[off + 1]! & 0xe0) === 0xe0)) off++;
  if (off + 40 > head.length) return null;
  const b1 = head[off + 1]!;
  const b2 = head[off + 2]!;
  const b3 = head[off + 3]!;
  const versionBits = (b1 >> 3) & 3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (b1 >> 1) & 3; // 1=Layer III
  const sampleRates = MP3_SAMPLE_RATES[versionBits];
  const sampleRate = sampleRates?.[(b2 >> 2) & 3];
  if (!sampleRate || layerBits === 0) return null;
  const isV1 = versionBits === 3;
  const samplesPerFrame = layerBits === 3 ? 384 : layerBits === 2 ? 1152 : isV1 ? 1152 : 576;
  const mono = ((b3 >> 6) & 3) === 3;
  // Xing/Info sits after the side info; VBRI is fixed at +36
  const xingOff = off + 4 + (isV1 ? (mono ? 17 : 32) : mono ? 9 : 17);
  if (xingOff + 16 <= head.length) {
    const tag = head.toString("latin1", xingOff, xingOff + 4);
    if ((tag === "Xing" || tag === "Info") && (u32be(head, xingOff + 4) & 0x1) !== 0) {
      const frames = u32be(head, xingOff + 8);
      if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
    }
  }
  if (head.toString("latin1", off + 36, off + 40) === "VBRI") {
    const frames = u32be(head, off + 36 + 14);
    if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
  }
  // CBR estimate
  const bitrateIdx = b2 >> 4;
  const bitrateKbps = (isV1 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[bitrateIdx];
  if (!bitrateKbps || totalBytes <= off) return null;
  return ((totalBytes - off) * 8) / (bitrateKbps * 1000);
}

/**
 * Estimate a track's duration in seconds from its head bytes + total size.
 * Tries the container the mime type suggests first, then every parser — the
 * browser-reported mime is unreliable, the magic bytes are not.
 */
export function estimateAudioDurationSec(
  head: Buffer,
  totalBytes: number,
  mimeType?: string | null,
): number | null {
  const mime = (mimeType ?? "").toLowerCase();
  const parsers: Array<(h: Buffer, t: number) => number | null> = [];
  if (mime.includes("wav")) parsers.push(wavDuration);
  if (mime.includes("flac")) parsers.push((h) => flacDuration(h));
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) parsers.push((h) => mp4Duration(h));
  if (mime.includes("mpeg") || mime.includes("mp3")) parsers.push(mp3Duration);
  parsers.push(wavDuration, (h) => flacDuration(h), (h) => mp4Duration(h), mp3Duration);
  for (const parse of parsers) {
    const sec = parse(head, totalBytes);
    if (sec != null && Number.isFinite(sec) && sec > 0 && sec < MAX_SANE_SEC) {
      return Math.round(sec * 10) / 10;
    }
  }
  return null;
}

/** How much head we need for any of the parsers (ID3 tags can be large —
 * embedded cover art regularly pushes the first frame past 100KB). */
export const AUDIO_DURATION_HEAD_BYTES = 512 * 1024;
