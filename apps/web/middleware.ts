import { NextResponse, type NextRequest } from "next/server";
import { verifyAuthToken } from "./lib/auth";

// Single-user gate: everything requires a VALID signed auth cookie except the
// login page. The cookie is an HMAC token (4b) — a forged/hand-typed value no
// longer passes. For a real shared-machine fix, front this with Cloudflare
// Access later.
export async function middleware(req: NextRequest) {
  const isLogin = req.nextUrl.pathname.startsWith("/login");
  const authed = await verifyAuthToken(req.cookies.get("beacon_auth")?.value);
  if (!authed && !isLogin) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
