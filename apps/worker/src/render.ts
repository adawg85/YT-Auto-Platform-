import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { ShortProps } from "@ytauto/core";
import type { ObjectStore } from "@ytauto/providers";

let bundlePromise: Promise<string> | undefined;

/** Bundle the Remotion project once per process; reuse across renders. */
function getBundle(): Promise<string> {
  bundlePromise ??= (async () => {
    const entry = fileURLToPath(import.meta.resolve("@ytauto/video/entry"));
    return bundle({ entryPoint: entry });
  })();
  return bundlePromise;
}

export type RenderInput = {
  productionId: string;
  props: ShortProps; // imageSrc/audioSrc hold storage KEYS at this point
  imageKeys: string[];
  audioKey: string;
};

/**
 * CPU-only server-side render: download assets from the store to a tmp dir,
 * point the composition at file:// URLs, render H.264, upload final.mp4.
 */
export async function renderShort(
  store: ObjectStore,
  input: RenderInput,
): Promise<{ storageKey: string; renderSec: number }> {
  const started = Date.now();
  const work = join(tmpdir(), `ytauto-render-${input.productionId}`);
  await mkdir(work, { recursive: true });

  try {
    // materialize assets locally
    const localImage = async (key: string, i: number) => {
      const ext = key.split(".").pop() ?? "png";
      const path = join(work, `beat-${i}.${ext}`);
      await writeFile(path, await store.getBuffer(key));
      return pathToFileURL(path).href;
    };
    const imageUrls = await Promise.all(input.imageKeys.map(localImage));
    const audioExt = input.audioKey.split(".").pop() ?? "wav";
    const audioPath = join(work, `voiceover.${audioExt}`);
    await writeFile(audioPath, await store.getBuffer(input.audioKey));

    const props: ShortProps = {
      ...input.props,
      beats: input.props.beats.map((b, i) => ({ ...b, imageSrc: imageUrls[i] ?? "" })),
      audioSrc: pathToFileURL(audioPath).href,
    };

    const serveUrl = await getBundle();
    const composition = await selectComposition({
      serveUrl,
      id: "Short",
      inputProps: props,
      browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE,
    });

    const outPath = join(work, "final.mp4");
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outPath,
      inputProps: props,
      browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE,
      concurrency: Number(process.env.REMOTION_CONCURRENCY ?? "2"),
      chromiumOptions: { gl: "swangle" },
    });

    const storageKey = `productions/${input.productionId}/final.mp4`;
    await store.put(storageKey, await readFile(outPath), "video/mp4");
    return { storageKey, renderSec: (Date.now() - started) / 1000 };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
