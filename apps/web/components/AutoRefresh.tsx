"use client";

// Keeps a left-open tab live. The pages are force-dynamic (fresh on navigation),
// but never update on their own — this refetches server data every ~2 min via
// router.refresh(), which re-renders server components in place (no full reload).
// Mounted once in the root layout so every page stays current.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const REFRESH_MS = 120_000;

export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
