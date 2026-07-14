/**
 * A URL the image vendors can fetch for a stored image: presigned when the
 * store supports it, else an inline data: URL (Node fetch and the Google
 * adapter both consume data: URLs). Mock SVGs return null — real vendors
 * reject SVG inputs.
 *
 * Shared by the Style tab (character refine / test scenes) and the Settings
 * tab (logo/banner reference injection, 2026-07-14 operator ask). Lives here
 * because "use server" files may only export actions.
 */
export async function referenceUrlFor(
  store: { presignGet?: (key: string, ttlSec: number) => Promise<string>; getBuffer: (key: string) => Promise<Buffer> },
  imageKey: string,
  mimeType: string,
): Promise<string | null> {
  if (mimeType.includes("svg")) return null;
  if (store.presignGet) return store.presignGet(imageKey, 3600);
  const buf = await store.getBuffer(imageKey);
  return `data:${mimeType};base64,${buf.toString("base64")}`;
}
