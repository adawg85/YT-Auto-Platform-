import type { ScriptBeat, WordTimestamp } from "@ytauto/db";
import type { ShortProps } from "@ytauto/core";

/**
 * Map beat boundaries onto the voiceover's word-timestamp stream: each beat
 * claims as many words as its text contains, in order. Deterministic; works
 * identically with mock and real TTS timestamps.
 */
export function buildShortProps(args: {
  beats: ScriptBeat[];
  words: WordTimestamp[];
  imageSrcs: string[]; // one per beat, same order
  audioSrc: string;
  durationSec: number;
  orientation: "portrait" | "landscape";
  brand: { primaryColor: string; font: string };
}): ShortProps {
  const { beats, words, imageSrcs, audioSrc, durationSec, orientation, brand } = args;

  const propsBeats: ShortProps["beats"] = [];
  let cursor = 0;
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i]!;
    const wordCount = beat.text.split(/\s+/).filter(Boolean).length;
    const beatWords = words.slice(cursor, cursor + wordCount);
    const startSec = i === 0 ? 0 : (propsBeats[i - 1]!.endSec);
    const isLast = i === beats.length - 1;
    const endSec = isLast
      ? durationSec
      : beatWords.length
        ? beatWords[beatWords.length - 1]!.endSec + 0.05
        : startSec + 1;
    propsBeats.push({
      type: beat.type,
      text: beat.text,
      imageSrc: imageSrcs[i] ?? "",
      startSec,
      endSec: Math.min(endSec, durationSec),
    });
    cursor += wordCount;
  }

  return { beats: propsBeats, captions: words, audioSrc, durationSec, orientation, brand };
}
