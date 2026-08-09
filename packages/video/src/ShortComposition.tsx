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
// Deep import the PURE production-profile module (not the @ytauto/core barrel,
// which transitively pulls the DB layer / `postgres` into the browser bundle and
// breaks the Remotion Lambda site build — see docs/LAMBDA.md).
import { stillMotionTransform } from "@ytauto/core/production-profile";
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
  stillMotion,
  fadeInFrames = 0,
}: {
  imageSrc: string;
  videoSrc?: string;
  durationInFrames: number;
  fallbackColor: string;
  /** #73: resolved Ken-Burns for this still (absent → prior slow_push @ 0.12). */
  stillMotion?: { kind: "none" | "slow_push" | "slow_pull" | "drift"; amount: number };
  /** #73: frames over which this beat fades in for a dissolve crossfade (0 = cut). */
  fadeInFrames?: number;
}) => {
  const frame = useCurrentFrame();
  // #73: progress through the hold, 0..1. The transform helper (shared with the
  // estimate) makes slow_push @ 0.12 identical to the prior hardcoded 1→1.12 zoom.
  const frac = interpolate(frame, [0, Math.max(1, durationInFrames)], [0, 1], {
    extrapolateRight: "clamp",
  });
  const kb = stillMotionTransform(stillMotion?.kind ?? "slow_push", stillMotion?.amount ?? 0.12, frac);
  // #73: dissolve — the overlapping window at the head of the beat fades in over
  // the previous beat (which still renders underneath). 0 fadeInFrames = hard cut.
  const opacity =
    fadeInFrames > 0
      ? interpolate(frame, [0, fadeInFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
      : 1;
  return (
    <AbsoluteFill style={{ backgroundColor: fadeInFrames > 0 ? "transparent" : fallbackColor, overflow: "hidden", opacity }}>
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
            transform: `scale(${kb.scale}) translate(${kb.translateXPct}%, ${kb.translateYPct}%)`,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

/**
 * #72: a typeset QUOTE CARD — centred text on a near-black ground, held for the
 * beat's duration, with optional attribution. The section-boundary device the
 * lane-leading format uses (a quote, a verse reference). Rendered in place of the
 * beat's image when the beat carries `quoteCard`.
 */
const QuoteCard = ({
  text,
  attribution,
  landscape,
}: {
  text: string;
  attribution?: string | null;
  landscape: boolean;
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0a", justifyContent: "center", alignItems: "center", padding: landscape ? "0 12%" : "0 8%" }}>
      <div style={{ textAlign: "center", maxWidth: landscape ? 1400 : 900 }}>
        <div
          style={{
            fontSize: landscape ? 64 : 76,
            fontWeight: 600,
            lineHeight: 1.3,
            color: "white",
            textShadow: "0 4px 24px rgba(0,0,0,0.6)",
          }}
        >
          {text}
        </div>
        {attribution ? (
          <div style={{ marginTop: 40, fontSize: landscape ? 32 : 40, fontWeight: 400, color: "rgba(255,255,255,0.7)", letterSpacing: 2, textTransform: "uppercase" }}>
            {attribution}
          </div>
        ) : null}
      </div>
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
  const { width, height } = useVideoConfig();
  const landscape = width > height;
  // #73: still-image Ken-Burns + transition, resolved from the Production Profile
  // upstream. Absent → the renderer's prior default (slow_push @ 0.12, hard cuts),
  // so an unmigrated production renders exactly as before.
  const motion = props.stillMotion;
  const dissolveFrames =
    motion && motion.transition === "dissolve" ? Math.round((motion.transitionMs / 1000) * SHORT_FPS) : 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0a", fontFamily: brandFontFamily(props.brand.font) }}>
      {props.beats.map((beat, i) => {
        const from = Math.round(beat.startSec * SHORT_FPS);
        const duration = Math.max(1, Math.round((beat.endSec - beat.startSec) * SHORT_FPS));
        // #73: for a dissolve, start each beat (after the first) `dissolveFrames`
        // early so it overlaps — and fades in over — the previous beat, which is
        // still on-screen underneath. A hard cut (dissolveFrames 0) is unchanged.
        const fadeIn = i > 0 ? Math.min(dissolveFrames, Math.max(0, from)) : 0;
        const seqFrom = from - fadeIn;
        return (
          <Sequence key={i} from={seqFrom} durationInFrames={duration + fadeIn} name={`beat-${i}-${beat.type}`}>
            {beat.quoteCard ? (
              // #72: a quote-card beat renders typeset text on a plain ground
              // instead of an image — no Ken-Burns, no dissolve.
              <QuoteCard text={beat.quoteCard.text} attribution={beat.quoteCard.attribution} landscape={landscape} />
            ) : (
              <Beat
                imageSrc={beat.imageSrc}
                videoSrc={beat.videoSrc}
                durationInFrames={duration + fadeIn}
                fallbackColor="#111827"
                // #114: per-beat Ken-Burns (rate × hold, direction by parity)
                // wins over the global axis; old props without it are unchanged.
                stillMotion={beat.stillMotion ?? (motion ? { kind: motion.kind, amount: motion.amount } : undefined)}
                fadeInFrames={fadeIn}
              />
            )}
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
      <Captions captions={props.captions} accentColor={props.brand.primaryColor} style={props.captionStyle} />
      {props.musicSrc && (props.musicVolume ?? 0) > 0 ? (
        <MusicBed src={props.musicSrc} volume={props.musicVolume!} />
      ) : null}
      {props.audioSrc ? <Audio src={props.audioSrc} volume={props.voiceVolume ?? 1} /> : null}
    </AbsoluteFill>
  );
};
