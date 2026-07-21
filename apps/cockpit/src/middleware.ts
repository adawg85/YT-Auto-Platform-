import { NextResponse, type NextRequest } from "next/server";

/**
 * Single-operator HTTP basic auth (v1). Upgrade path: Auth.js with one
 * account if sessions/CSRF ever matter here.
 * Edge-runtime safe (atob, not Buffer) so it deploys to Vercel middleware.
 */
export function middleware(req: NextRequest) {
  // BACKLOG #36: the MCP connector endpoint is reached by the Claude app, not a
  // browser, so it can't send operator basic-auth. It guards itself with a
  // dedicated bearer token (MCP_BEARER_TOKEN) inside the route handler — exempt
  // it here so the Basic-auth challenge never blocks the connector handshake.
  if (req.nextUrl.pathname.startsWith("/api/mcp")) return NextResponse.next();

  // GitHub issue webhook (ticket two-way sync): called by GitHub, not a browser,
  // so it can't send operator basic-auth. It verifies its own HMAC signature
  // (GITHUB_WEBHOOK_SECRET) inside the route handler — exempt it here.
  if (req.nextUrl.pathname.startsWith("/api/github/")) return NextResponse.next();

  const user = process.env.OPERATOR_USER;
  const pass = process.env.OPERATOR_PASS;
  if (!user || !pass) return NextResponse.next(); // auth disabled until configured

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const sep = decoded.indexOf(":");
      const u = decoded.slice(0, sep);
      const p = decoded.slice(sep + 1);
      if (u === user && p === pass) return NextResponse.next();
    } catch {
      // fall through to 401
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="ytauto cockpit"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
