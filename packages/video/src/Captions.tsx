import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadPlayfair } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as loadRobotoSlab } from "@remotion/google-fonts/RobotoSlab";
import type { ShortProps } from "@ytauto/core";
import { resolveCaptionStyle, applyCasing, emphasizedWordIndices } from "@ytauto/core";

type Caption = ShortProps["captions"][number];
type CaptionStyleProp = ShortProps["captionStyle"];

// #72: load a serif + slab deterministically (like Inter in the composition) so
// typeface: serif/slab render on Lambda instead of degrading to a system font.
const { fontFamily: serifFamily } = loadPlayfair();
const { fontFamily: slabFamily } = loadRobotoSlab();

/** Group word timestamps into caption "pages" of up to `size` words. */
export function paginate(captions: Caption[], size = 4): Caption[][] {
  const pages: Caption[][] = [];
  for (let i = 0; i < captions.length; i += size) {
    pages.push(captions.slice(i, i + size));
  }
  return pages;
}

/**
 * TikTok-style captions: pages of 3-4 words, active word highlighted, synced to
 * word-level TTS timestamps. #72: position/casing/typeface/weight/outline +
 * per-phrase emphasis colour are operator-configurable via `style`; unset
 * reproduces the prior hardcoded lower-third look exactly.
 */
export const Captions = ({
  captions,
  accentColor,
  style,
}: {
  captions: Caption[];
  accentColor: string;
  style?: CaptionStyleProp;
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const tSec = frame / fps;
  const landscape = width > height;
  const base = landscape
    ? { margin: 90, maxWidth: 1500, fontSize: 56 }
    : { margin: 340, maxWidth: 900, fontSize: 72 };

  const cs = resolveCaptionStyle(style ?? null);
  const emphasisColor = cs.emphasisColor ?? accentColor;
  // emphasis is matched over the FULL word stream so a phrase spanning a page
  // boundary still colours; SIZE must match paginate's default.
  const SIZE = 4;
  const emphasized = emphasizedWordIndices(captions, cs.emphasisPhrases);

  const fontFamily =
    cs.typeface === "serif" ? serifFamily : cs.typeface === "slab" ? slabFamily : undefined; // sans → inherit brand font

  // #72: position → flex alignment + which margin edge to lift off.
  const justify =
    cs.position === "center" ? "center" : cs.position === "upper-third" ? "flex-start" : "flex-end";
  const marginStyle =
    cs.position === "center"
      ? {}
      : cs.position === "upper-third"
        ? { marginTop: base.margin }
        : { marginBottom: base.margin };

  const pages = paginate(captions, SIZE);
  const pageIdx = pages.findIndex((p) => {
    const first = p[0]!;
    const last = p[p.length - 1]!;
    return tSec >= first.startSec && tSec <= last.endSec + 0.25;
  });
  if (pageIdx < 0) return null;
  const page = pages[pageIdx]!;
  const pageBase = pageIdx * SIZE;

  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: "center" }}>
      <div
        style={{
          ...marginStyle,
          maxWidth: base.maxWidth,
          textAlign: "center",
          fontSize: base.fontSize,
          fontWeight: cs.weight,
          lineHeight: 1.25,
          color: "white",
          textShadow: "0 4px 24px rgba(0,0,0,0.9)",
          ...(cs.outline ? { WebkitTextStroke: "2px rgba(0,0,0,0.85)" } : {}),
          ...(fontFamily ? { fontFamily } : {}),
          padding: "0 40px",
        }}
      >
        {page.map((w, i) => {
          const active = tSec >= w.startSec && tSec <= w.endSec + 0.05;
          const isEmphasised = emphasized.has(pageBase + i);
          // emphasis colour wins as a persistent phrase highlight; the active
          // word still scales, and (when not emphasised) takes the accent colour.
          const color = isEmphasised ? emphasisColor : active ? accentColor : "white";
          return (
            <span
              key={i}
              style={{
                color,
                transform: active ? "scale(1.06)" : undefined,
                display: "inline-block",
                marginRight: 18,
              }}
            >
              {applyCasing(w.word, cs.casing, i === 0)}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
