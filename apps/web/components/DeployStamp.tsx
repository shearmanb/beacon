// Deploy provenance line under the header: "updated <time> ET · railway <id>".
// Server component, zero client JS — the Railway ID is a <details> disclosure
// that expands a one-paragraph recap of the most recent change. Everything is
// sourced from env Railway injects at build/deploy (RAILWAY_DEPLOYMENT_ID,
// RAILWAY_GIT_COMMIT_MESSAGE), so the stamp maintains itself on every deploy —
// no hardcoded date to go stale.

// Module-scope: evaluated when the server bundle loads, i.e. when this deploy's
// web process booted. A supervised web restart re-stamps it — label it honestly.
const STARTED_AT = new Date();

function fmtEt(d: Date): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d) + " ET"
  );
}

/** First meaningful paragraph of the deploy's commit message: the title line,
 *  plus the first body paragraph that isn't trailer metadata. */
function recapFromCommitMessage(msg: string): string | null {
  const paras = msg
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length === 0) return null;
  const title = paras[0]!.split(/\r?\n/)[0]!.trim();
  const body = paras
    .slice(1)
    .find((p) => !/^(co-authored-by|claude-session|signed-off-by)/i.test(p))
    ?.replace(/\s*\r?\n\s*/g, " ");
  return body ? `${title} — ${body}` : title;
}

export function DeployStamp() {
  const deployId = process.env["RAILWAY_DEPLOYMENT_ID"]?.slice(0, 8) ?? "local";
  const recap =
    recapFromCommitMessage(process.env["RAILWAY_GIT_COMMIT_MESSAGE"] ?? "") ??
    "No deploy metadata — running outside Railway (local/dev), so there's no deployment ID or change recap to show.";

  return (
    <details className="faint mono" style={{ textAlign: "right", fontSize: 11, margin: "2px 0 8px" }}>
      <summary
        style={{ cursor: "pointer", listStyle: "none" }}
        title="This build's start time and Railway deployment ID (matches the ID in Railway's deploy list). Click for a recap of the most recent change."
      >
        updated {fmtEt(STARTED_AT)} · railway <span style={{ textDecoration: "underline" }}>{deployId}</span>
      </summary>
      <p style={{ margin: "6px 0 0 auto", maxWidth: 560, textAlign: "left", lineHeight: 1.5 }}>{recap}</p>
    </details>
  );
}
