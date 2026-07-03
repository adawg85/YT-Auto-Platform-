import { NextResponse, type NextRequest } from "next/server";

/**
 * Single-operator HTTP basic auth (v1). Upgrade path: Auth.js with one
 * account if sessions/CSRF ever matter here.
 * Edge-runtime safe (atob, not Buffer) so it deploys to Vercel middleware.
 */
export function middleware(req: NextRequest) {
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
