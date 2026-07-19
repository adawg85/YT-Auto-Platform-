import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import type { ShortProps } from "@ytauto/core";
import { Captions } from "./Captions";

// Deterministic default font (BACKLOG #18 Lambda): the Lambda runtime ships
// only Noto system fonts, so the default "Inter" brand must be loaded, not
// assumed. Also makes local/Docker renders match. Non-Inter brand fonts keep
// their existing degrade-to-system-fallback behavior.
const { fontFamily: interFontFamily } = loadFont();

/** The brand font, with the loaded Inter as the guaranteed fallback. */
export const brandFontFamily = (font: string) =>
  font === "Inter" ? interFontFamily : `${font}, ${interFontFamily}`;

export const SHORT_FPS = 30;

/**
 * One beat's visual: real archival footage (muted, full-bleed) when present
 * (BACKLOG #26), else a full-bleed image with a slow Ken Burns zoom. The clip
 * is pre-trimmed to the beat length server-side, so it just plays from 0.
 */
const Beat = ({
  imageSrc,
  videoSrc,
  durationInFrames,
  fallbackColor,
}: {
  imageSrc: string;
  videoSrc?: string;
  durationInFrames: number;
  fallbackColor: string;
}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, durationInFrames], [1, 1.12], {
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: fallbackColor, overflow: "hidden" }}>
      {videoSrc ? (
        <OffthreadVideo
          src={videoSrc}
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : imageSrc ? (
        <Img
          src={imageSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `scale(${scale})`,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

/**
 * Ducked background-music bed (Production Profile "music" axis). Sits UNDER the
 * full-volume voiceover at a low constant level, looped to fill the render, and
 * faded in/out at the edges so it never starts or stops abruptly.
 */
const MusicBed = ({ src, volume }: { src: string; volume: number }) => {
  const { durationInFrames, fps } = useVideoConfig();
  const fadeFrames = Math.min(fps, Math.floor(durationInFrames / 8)); // ≤1s in/out
  return (
    <Audio
      src={src}
      loop
      volume={(f) =>
        Math.max(
          0,
          volume *
            Math.min(1, f / Math.max(1, fadeFrames), (durationInFrames - f) / Math.max(1, fadeFrames)),
        )
      }
    />
  );
};

export const ShortComposition = (props: ShortProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0a", fontFamily: brandFontFamily(props.brand.font) }}>
      {props.beats.map((beat, i) => {
        const from = Math.round(beat.startSec * SHORT_FPS);
        const duration = Math.max(1, Math.round((beat.endSec - beat.startSec) * SHORT_FPS));
        return (
          <Sequence key={i} from={from} durationInFrames={duration} name={`beat-${i}-${beat.type}`}>
            <Beat
              imageSrc={beat.imageSrc}
              videoSrc={beat.videoSrc}
              durationInFrames={duration}
              fallbackColor="#111827"
            />
          </Sequence>
        );
      })}
      {/* subtle bottom gradient so captions stay readable */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.0) 30%)",
        }}
      />
      <Captions captions={props.captions} accentColor={props.brand.primaryColor} />
      {props.musicSrc && (props.musicVolume ?? 0) > 0 ? (
        <MusicBed src={props.musicSrc} volume={props.musicVolume!} />
      ) : null}
      {props.audioSrc ? <Audio src={props.audioSrc} volume={props.voiceVolume ?? 1} /> : null}
    </AbsoluteFill>
  );
};
