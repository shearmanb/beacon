// "📖 registry" — a Reveries bottle's page on The Reveries Registry when the
// registry has it, else the registry homepage (lib/registry.ts decides, and
// never guesses). Server- and client-safe: plain markup, no hooks.

export interface RegistryRef {
  url: string;
  /** true = this bottle's own registry page; false = the registry homepage. */
  exact: boolean;
}

export function RegistryLink({ r }: { r: RegistryRef | null | undefined }) {
  if (!r) return null;
  return (
    <a
      className={`reg-link ${r.exact ? "exact" : ""}`}
      href={r.url}
      target="_blank"
      rel="noreferrer"
      title={
        r.exact
          ? "This bottle's page on The Reveries Registry (fan-made archive of every Reveries release)"
          : "Not in The Reveries Registry yet — opens the registry so you can search it"
      }
    >
      📖 {r.exact ? "registry" : "registry ?"}
    </a>
  );
}
