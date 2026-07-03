import { Readable } from "node:stream";
import { NextRequest } from "next/server";
import { getAppContext } from "@/lib/context";

const MIME_BY_EXT: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
};

/**
 * Streams stored assets for cockpit previews, regardless of the store
 * backend (fs or S3) — the store itself never needs a public endpoint.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key } = await params;
  const storageKey = key.join("/");
  const { providers } = getAppContext();
  try {
    const { stream, mimeType } = await providers.store.getStream(storageKey);
    const ext = storageKey.split(".").pop() ?? "";
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-type": mimeType ?? MIME_BY_EXT[ext] ?? "application/octet-stream",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
