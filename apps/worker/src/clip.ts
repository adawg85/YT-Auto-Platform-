import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";

const run = promisify(execFile);

const CLIP_SEC = 60;
const MAX_CLIPS = 10;
// drawtext needs a real font file. Windows Arial Bold by default; override with
// CLIP_FONTFILE on other OSes. The colon is escaped for the filter parser.
const FONT = process.env.CLIP_FONTFILE ?? "C\\:/Windows/Fonts/arialbd.ttf";

/**
 * Literal long→Shorts clipping (BACKLOG #6). Cut a (landscape) master render
 * into vertical 9:16 clips of <=60s — blurred-pad background so nothing is
 * cropped away — each stamped "Part N" at the top. Returns one file path per
 * clip. Pure ffmpeg; no re-scripting.
 */
export async function clipToVerticalShorts(
  inputPath: string,
  durationSec: number,
  outDir: string,
): Promise<string[]> {
  const count = Math.min(MAX_CLIPS, Math.max(1, Math.ceil(durationSec / CLIP_SEC)));
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const out = join(outDir, `part-${i + 1}.mp4`);
    const filter =
      "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20[bg];" +
      "[0:v]scale=1080:-2[fg];" +
      "[bg][fg]overlay=(W-w)/2:(H-h)/2," +
      `drawtext=fontfile='${FONT}':text='Part ${i + 1}':fontcolor=white:fontsize=80:borderw=5:bordercolor=black:x=(w-text_w)/2:y=140[v]`;
    await run(
      ffmpegPath as unknown as string,
      [
        "-y",
        "-ss", String(i * CLIP_SEC),
        "-t", String(CLIP_SEC),
        "-i", inputPath,
        "-filter_complex", filter,
        "-map", "[v]",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-c:a", "aac",
        "-movflags", "+faststart",
        out,
      ],
      { maxBuffer: 1024 * 1024 * 64 },
    );
    paths.push(out);
  }
  return paths;
}
