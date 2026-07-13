/**
 * Keyless YouTube URL helpers. The 11-char video id unlocks the free
 * thumbnail CDN (i.ytimg.com) — used by the intel UI and the #35.3
 * thumbnail-deconstruction pass (no API quota either way).
 * (Same regex as the cockpit's niche-intel panel helper.)
 */
export function youtubeIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(
      url,
    );
  return m?.[1] ?? null;
}

/** The best free thumbnail rendition for a video id (hq = 480x360, always exists). */
export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
