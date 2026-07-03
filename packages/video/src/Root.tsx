import { Composition } from "remotion";
import type { ShortProps } from "@ytauto/core";
import { ShortComposition, SHORT_FPS } from "./ShortComposition";

const demoProps: ShortProps = {
  beats: [
    {
      type: "hook",
      text: "Ever wondered why airplane windows are round?",
      imageSrc: "",
      startSec: 0,
      endSec: 2.5,
    },
    {
      type: "insight",
      text: "Square corners concentrate stress until the fuselage cracks.",
      imageSrc: "",
      startSec: 2.5,
      endSec: 6,
    },
  ],
  captions: [
    { word: "Ever", startSec: 0.2, endSec: 0.5 },
    { word: "wondered", startSec: 0.5, endSec: 0.9 },
    { word: "why", startSec: 0.9, endSec: 1.2 },
    { word: "airplane", startSec: 1.2, endSec: 1.7 },
    { word: "windows", startSec: 1.7, endSec: 2.1 },
    { word: "are", startSec: 2.1, endSec: 2.3 },
    { word: "round", startSec: 2.3, endSec: 2.6 },
  ],
  audioSrc: "",
  durationSec: 6,
  brand: { primaryColor: "#38bdf8", font: "Inter" },
};

export const RemotionRoot = () => {
  return (
    <Composition
      id="Short"
      component={ShortComposition}
      width={1080}
      height={1920}
      fps={SHORT_FPS}
      durationInFrames={SHORT_FPS * 6}
      defaultProps={demoProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(1, Math.ceil(props.durationSec * SHORT_FPS)),
      })}
    />
  );
};
