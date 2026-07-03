import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { ShortProps } from "@ytauto/core";

type Caption = ShortProps["captions"][number];

/** Group word timestamps into caption "pages" of up to `size` words. */
export function paginate(captions: Caption[], size = 4): Caption[][] {
  const pages: Caption[][] = [];
  for (let i = 0; i < captions.length; i += size) {
    pages.push(captions.slice(i, i + size));
  }
  return pages;
}

/**
 * TikTok-style captions: pages of 3-4 words, active word highlighted in the
 * brand accent color, synced to word-level TTS timestamps.
 */
export const Captions = ({
  captions,
  accentColor,
}: {
  captions: Caption[];
  accentColor: string;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tSec = frame / fps;

  const pages = paginate(captions);
  const page = pages.find((p) => {
    const first = p[0]!;
    const last = p[p.length - 1]!;
    return tSec >= first.startSec && tSec <= last.endSec + 0.25;
  });
  if (!page) return null;

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center" }}>
      <div
        style={{
          marginBottom: 340,
          maxWidth: 900,
          textAlign: "center",
          fontSize: 72,
          fontWeight: 800,
          lineHeight: 1.25,
          color: "white",
          textShadow: "0 4px 24px rgba(0,0,0,0.9)",
          padding: "0 40px",
        }}
      >
        {page.map((w, i) => {
          const active = tSec >= w.startSec && tSec <= w.endSec + 0.05;
          return (
            <span
              key={i}
              style={{
                color: active ? accentColor : "white",
                transform: active ? "scale(1.06)" : undefined,
                display: "inline-block",
                marginRight: 18,
              }}
            >
              {w.word}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
