export interface WorkerEnv {
  dbUrl: string;
  dbAuthToken?: string;
  discordWebhook?: string;
  healthcheckUrl?: string;
  /** Compute + log alerts but send nothing and persist nothing (cutover dry-run). */
  dryRun: boolean;
}

export function loadEnv(): WorkerEnv {
  const dbUrl = process.env["BEACON_DB_URL"] ?? process.env["DATABASE_URL"];
  if (!dbUrl) throw new Error("BEACON_DB_URL (or DATABASE_URL) is required");
  return {
    dbUrl,
    dbAuthToken: process.env["BEACON_DB_AUTH_TOKEN"],
    discordWebhook: process.env["DISCORD_WEBHOOK_URL"],
    healthcheckUrl: process.env["HEALTHCHECK_URL"],
    dryRun: process.env["BEACON_DRY_RUN"] === "1",
  };
}
