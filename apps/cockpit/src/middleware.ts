import { NextResponse, type NextRequest } from "next/server";

/**
 * Single-operator HTTP basic auth (v1). Upgrade path: Auth.js with one
 * account if sessions/CSRF ever matter here.
 */
export function middleware(req: NextRequest) {
  const user = process.env.OPERATOR_USER;
  const pass = process.env.OPERATOR_PASS;
  if (!user || !pass) return NextResponse.next(); // auth disabled until configured

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const [u, p] = Buffer.from(header.slice(6), "base64").toString().split(":");
    if (u === user && p === pass) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="ytauto cockpit"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
