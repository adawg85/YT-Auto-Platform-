import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * CPU-only server-side render. Assets are served to the render browser over
 * the worker's own /store/* HTTP route (a headless-Chromium page loaded from
 * http:// cannot fetch file:// subresources).
 */
export async function renderShort(
  store: ObjectStore,
  input: RenderInput,
): Promise<{ storageKey: string; renderSec: number }> {
  const started = Date.now();
  const assetBase = `http://localhost:${process.env.PORT ?? process.env.WORKER_PORT ?? "3010"}/store`;
  const work = join(tmpdir(), `ytauto-render-${input.productionId}`);
  await mkdir(work, { recursive: true });

  try {
    const props: ShortProps = {
      ...input.props,
      beats: input.props.beats.map((b, i) => ({
        ...b,
        imageSrc: `${assetBase}/${input.imageKeys[i] ?? ""}`,
      })),
      audioSrc: `${assetBase}/${input.audioKey}`,
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
