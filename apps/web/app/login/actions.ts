"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function login(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const expected = process.env.BEACON_DASH_PASSWORD ?? "beam";
  if (password === expected) {
    cookies().set("beacon_auth", "1", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    redirect("/");
  }
  redirect("/login?error=1");
}
