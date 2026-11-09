"use client";

// A page section whose header is the toggle: "▸ TARGET BOTTLES ───── 12".
// Native <details>, so it works before hydration and needs no JS to open; the
// open/closed choice is remembered per browser (localStorage, guarded — a
// private window or blocked storage just falls back to `defaultOpen`).
// Used on /unicorn for Target bottles and Watch terms.

import { useEffect, useState, type ReactNode } from "react";

const KEY = (id: string) => `beacon.section.${id}`;

export function Collapsible({
  id,
  title,
  meta,
  defaultOpen = true,
  children,
}: {
  /** Stable id for the remembered state. */
  id: string;
  title: ReactNode;
  /** Right-hand count / note on the header line. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Restore after mount (SSR and the first client render both use defaultOpen).
  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY(id));
      if (v === "1" || v === "0") setOpen(v === "1");
    } catch {
      /* storage blocked — keep the default */
    }
  }, [id]);

  return (
    <details
      className="collapsible"
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        if (now === open) return;
        setOpen(now);
        try {
          localStorage.setItem(KEY(id), now ? "1" : "0");
        } catch {
          /* storage blocked — the toggle still works for this visit */
        }
      }}
    >
      <summary className="sect-hd" title={open ? "Click to collapse" : "Click to expand"}>
        <span className="caret" aria-hidden>
          ▸
        </span>
        <h2>{title}</h2>
        <span className="rule" />
        {meta != null && (
          <span className="muted mono" style={{ fontSize: 12 }}>
            {meta}
          </span>
        )}
      </summary>
      {children}
    </details>
  );
}
