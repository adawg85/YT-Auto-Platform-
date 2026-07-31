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
  const { providers } = await getAppContext();
  try {
    const { stream, mimeType } = await providers.store.getStream(storageKey);
    const ext = storageKey.split(".").pop() ?? "";
    const headers: Record<string, string> = {
      "content-type": mimeType ?? MIME_BY_EXT[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
    };
    // `?download=1` forces a save-as instead of inline display — the robust,
    // cross-browser (incl. mobile) path, since the <a download> attribute alone is
    // unreliable on some mobile browsers. An optional `filename` names the saved
    // file; otherwise the storage-key basename is used.
    if (_req.nextUrl.searchParams.get("download") != null) {
      const raw = _req.nextUrl.searchParams.get("filename") || storageKey.split("/").pop() || "download";
      // strip path separators + quotes so the header can't be broken/spoofed
      const safe = raw.replace(/[/\\"\r\n]/g, "_").slice(0, 200);
      headers["content-disposition"] = `attachment; filename="${safe}"`;
    }
    return new Response(Readable.toWeb(stream) as ReadableStream, { headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
