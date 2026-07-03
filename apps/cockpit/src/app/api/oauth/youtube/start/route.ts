import { NextRequest, NextResponse } from "next/server";
import { getMergedEnv } from "@/lib/context";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
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
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL(`/channels/${channelId}?error=Set+the+YouTube+OAuth+client+ID+and+secret+on+the+Account+page+first`, req.nextUrl.origin),
    );
  }

  const redirectUri = `${req.nextUrl.origin}/api/oauth/youtube/callback`;
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
