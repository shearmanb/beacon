// Entry point. Opens the datastore, wires the Discord channel, and starts the
// loop. Env: BEACON_DB_URL (libSQL/Turso), BEACON_DB_AUTH_TOKEN, optional
// DISCORD_WEBHOOK_URL, HEALTHCHECK_URL, BEACON_DRY_RUN=1.

import { openStore } from "@beacon/db";
import { DiscordChannel } from "@beacon/notify";
import { loadEnv } from "./env.js";
import { startLoop } from "./loop.js";

const env = loadEnv();
const store = await openStore({ url: env.dbUrl, authToken: env.dbAuthToken });
const channel = env.discordWebhook ? new DiscordChannel(env.discordWebhook) : undefined;

console.log(
  `[startup] Beacon worker online — DB ${env.dbUrl.split(":")[0]}:…${env.dryRun ? " (DRY RUN)" : ""}` +
    `${channel ? "" : " (no Discord webhook configured)"}`,
);

await startLoop(
  { store, channel, dryRun: env.dryRun, log: (m) => console.log(m) },
  { healthcheckUrl: env.healthcheckUrl },
);
