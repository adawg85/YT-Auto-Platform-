import type { WordTimestamp } from "@ytauto/db";
import type { ShortProps, Shot } from "@ytauto/core";

/**
 * Assemble the Remotion `Short` props from a planned shot list. Shot timing +
 * segmentation live in `planShots` (@ytauto/core, BACKLOG #18 #4); this is a
 * thin mapper: one on-screen image segment per shot, plus the caption word
 * stream (gated by the Production Profile "captions" axis).
 */
export function buildShortProps(args: {
  shots: Shot[];
  imageSrcs: string[]; // one per shot, same order
  words: WordTimestamp[]; // full voiceover stream, for burned-in captions
  audioSrc: string;
  durationSec: number;
  orientation: "portrait" | "landscape";
  brand: { primaryColor: string; font: string };
  /**
   * Burn word-by-word captions into the render (Production Profile #18). When
   * false, the word stream is dropped so the Remotion overlay renders nothing.
   * Defaults true to preserve pre-profile behaviour.
   */
  captions?: boolean;
}): ShortProps {
  const { shots, imageSrcs, words, audioSrc, durationSec, orientation, brand } = args;
  const showCaptions = args.captions ?? true;

  const propsBeats: ShortProps["beats"] = shots.map((shot, i) => ({
    type: shot.type,
    text: shot.text,
    imageSrc: imageSrcs[i] ?? "",
    startSec: shot.startSec,
    endSec: Math.min(shot.endSec, durationSec),
  }));

  return {
    beats: propsBeats,
    captions: showCaptions ? words : [],
    audioSrc,
    durationSec,
    orientation,
    brand,
  };
}
