import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { channels } from "@ytauto/db";
import { channelTokenName, setSecret } from "@ytauto/core";
import { getAppContext, getMergedEnv, invalidateProviderCache } from "@/lib/context";

/**
 * OAuth callback: exchange the code, store the refresh token encrypted
 * (scoped to the channel), and record which YouTube channel is connected.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const channelId = req.nextUrl.searchParams.get("state");
  const oauthError = req.nextUrl.searchParams.get("error");

  const back = (msg: string, ok = false) =>
    NextResponse.redirect(
      new URL(
        `/channels/${channelId ?? ""}?${ok ? "connected" : "error"}=${encodeURIComponent(msg)}`,
        req.nextUrl.origin,
      ),
    );

  if (oauthError) return back(`Google returned: ${oauthError}`);
  if (!code || !channelId) return back("Missing code/state in OAuth callback");

  const env = await getMergedEnv();
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) return back("OAuth client not configured");

  // 1) exchange code → tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      redirect_uri: `${req.nextUrl.origin}/api/oauth/youtube/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return back(`Token exchange failed (${tokenRes.status})`);
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
  if (!tokens.refresh_token) {
    return back("Google returned no refresh token — remove the app's access at myaccount.google.com/permissions and retry");
  }

  // 2) identify the connected YouTube channel
  let youtubeChannelId: string | null = null;
  const chRes = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true",
    { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  );
  if (chRes.ok) {
    const json = (await chRes.json()) as { items?: { id: string }[] };
    youtubeChannelId = json.items?.[0]?.id ?? null;
  }

  // 3) store refresh token encrypted, scoped to this platform channel
  const { db } = await getAppContext();
  await setSecret(db, channelTokenName(channelId), tokens.refresh_token);
  await db
    .update(channels)
    .set({ youtubeChannelId, oauthTokenRef: channelTokenName(channelId) })
    .where(eq(channels.id, channelId));
  invalidateProviderCache();

  return back("YouTube channel connected", true);
}
