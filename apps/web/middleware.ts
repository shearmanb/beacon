import { NextResponse, type NextRequest } from "next/server";
import { verifyAuthToken } from "./lib/auth";

// Constant-time-ish string compare (same discipline as lib/auth.ts).
function tokenMatches(presented: string | null, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Single-user gate: everything requires a VALID signed auth cookie except the
// login page. The cookie is an HMAC token (4b) — a forged/hand-typed value no
// longer passes. For a real shared-machine fix, front this with Cloudflare
// Access later.
//
// /api/ops/* additionally accepts `Authorization: Bearer <BEACON_OPS_TOKEN>` —
// the headless surface Claude Code sessions use to inspect prod (status,
// errors, evidence) without a browser cookie. Unset token = header path off
// (cookie still works). API callers get a 401, never a login redirect.
export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const isOpsApi = path.startsWith("/api/ops/");
  if (isOpsApi) {
    const header = req.headers.get("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (tokenMatches(bearer, process.env.BEACON_OPS_TOKEN)) return NextResponse.next();
  }

  const isLogin = path.startsWith("/login");
  const authed = await verifyAuthToken(req.cookies.get("beacon_auth")?.value);
  if (!authed && !isLogin) {
    if (isOpsApi) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
