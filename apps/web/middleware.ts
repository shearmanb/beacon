import { NextResponse, type NextRequest } from "next/server";

// Single-user gate: everything requires the auth cookie except the login page.
// (Replaces the old hardcoded-password-in-public-HTML scheme. For a real
// shared-machine fix, front this with Cloudflare Access later.)
export function middleware(req: NextRequest) {
  const authed = req.cookies.get("beacon_auth")?.value === "1";
  const isLogin = req.nextUrl.pathname.startsWith("/login");
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
