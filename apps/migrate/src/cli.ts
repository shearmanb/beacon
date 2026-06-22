// CLI: import the legacy JSON files into a libSQL DB.
//   pnpm --filter @beacon/migrate import -- --db file:beacon.db --data /path/to/repo --reset

import { openStore } from "@beacon/db";
import { runImport } from "./import.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const url = arg("db", "file:beacon.db");
const dataDir = arg("data", process.cwd());
const reset = process.argv.includes("--reset");

const store = await openStore({ url });
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
