import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
} from "remotion";
import type { ShortProps } from "@ytauto/core";
import { Captions } from "./Captions";

export const SHORT_FPS = 30;

/** One beat's visual: full-bleed image with a slow Ken Burns zoom. */
const Beat = ({
  imageSrc,
  durationInFrames,
  fallbackColor,
}: {
  imageSrc: string;
  durationInFrames: number;
  fallbackColor: string;
}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, durationInFrames], [1, 1.12], {
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: fallbackColor, overflow: "hidden" }}>
      {imageSrc ? (
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

export const ShortComposition = (props: ShortProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0a", fontFamily: props.brand.font }}>
      {props.beats.map((beat, i) => {
        const from = Math.round(beat.startSec * SHORT_FPS);
        const duration = Math.max(1, Math.round((beat.endSec - beat.startSec) * SHORT_FPS));
        return (
          <Sequence key={i} from={from} durationInFrames={duration} name={`beat-${i}-${beat.type}`}>
            <Beat
              imageSrc={beat.imageSrc}
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
      {props.audioSrc ? <Audio src={props.audioSrc} /> : null}
    </AbsoluteFill>
  );
};
