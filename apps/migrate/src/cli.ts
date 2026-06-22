// CLI: import the legacy JSON files into a libSQL DB.
//   Local file:  pnpm --filter @beacon/migrate exec tsx src/cli.ts --db file:beacon.db --data /path/to/repo --reset
//   Turso:       ... --db libsql://your-db.turso.io --auth-token <token> --data /path/to/repo --reset
//   (--auth-token also falls back to the BEACON_DB_AUTH_TOKEN env var.)

import { openStore } from "@beacon/db";
import { runImport } from "./import.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const url = arg("db", "file:beacon.db");
const dataDir = arg("data", process.cwd());
const authToken = arg("auth-token", process.env["BEACON_DB_AUTH_TOKEN"] ?? "") || undefined;
const reset = process.argv.includes("--reset");

const store = await openStore({ url, authToken });
try {
  const summary = await runImport(store, dataDir, { reset });
  console.log("Import complete:");
  console.log(JSON.stringify(summary, null, 2));
  if (summary.sitesFailed.length) {
    console.error(`\n${summary.sitesFailed.length} site(s) failed to import — fix before cutover.`);
    process.exitCode = 1;
  }
} finally {
  store.close();
}
