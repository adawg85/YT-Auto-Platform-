import { NextRequest, NextResponse } from "next/server";
import { getMergedEnv } from "@/lib/context";

/**
 * The public origin to build absolute OAuth URLs from. Behind a reverse proxy
 * (Caddy → cockpit:3000), Next resolves req.nextUrl.origin to the internal
 * bind (https://localhost:3000), which breaks the Google redirect_uri match.
 * Set PUBLIC_BASE_URL (e.g. https://commongroundsocial.com.au) to pin it.
 */
function publicOrigin(env: Record<string, string | undefined>, req: NextRequest): string {
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  return base || req.nextUrl.origin;
}

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  // force-ssl is required for videos.update (Release-to-public) and
  // thumbnails.set — upload alone can insert but never modify.
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
].join(" ");

/**
 * Kick off the per-channel YouTube OAuth flow. Requires YOUTUBE_CLIENT_ID /
 * YOUTUBE_CLIENT_SECRET (env or account page). The refresh token lands
 * encrypted in the secrets table, scoped to the channel in `state`.
 */
export async function GET(req: NextRequest) {
  const channelId = req.nextUrl.searchParams.get("channelId");
  if (!channelId) return new NextResponse("channelId required", { status: 400 });

  const env = await getMergedEnv();
  const origin = publicOrigin(env, req);
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL(`/channels/${channelId}?error=Set+the+YouTube+OAuth+client+ID+and+secret+on+the+Account+page+first`, origin),
    );
  }

  const redirectUri = `${origin}/api/oauth/youtube/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.YOUTUBE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent"); // force a refresh token every time
  url.searchParams.set("state", channelId);
  return NextResponse.redirect(url);
}
