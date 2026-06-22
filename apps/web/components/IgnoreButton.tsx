"use client";

import { useTransition } from "react";
import { setIgnore } from "../app/actions";

export function IgnoreButton({ handle, ignored }: { handle: string; ignored: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button className="btn" disabled={pending} onClick={() => start(() => setIgnore(handle, !ignored))}>
      {ignored ? "unignore" : "ignore"}
    </button>
  );
}
