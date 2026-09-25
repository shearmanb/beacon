"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_MAX_AGE_S, configuredPassword, issueAuthToken } from "../../lib/auth";

export async function login(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const expected = configuredPassword();
  if (!expected) redirect("/login?error=unset");
  if (password === expected) {
    // Store a signed token, not a forgeable static flag (4b).
    cookies().set("beacon_auth", await issueAuthToken(), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: AUTH_MAX_AGE_S,
    });
    redirect("/");
  }
  redirect("/login?error=1");
}
