// Opens a Beacon datastore: a libSQL client (local file in dev/tests, Turso URL
// in prod), the drizzle instance, schema bootstrap, and the typed repositories.
// Both the worker and the web app open one of these and share the same DB.

import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { initSchema } from "./migrate.js";
import { buildRepositories, type Repositories } from "./repositories.js";
import { schema } from "./schema.js";

export interface OpenStoreOptions {
  /** libSQL URL — e.g. "file:beacon.db", ":memory:", or a Turso "libsql://..." URL. */
  url: string;
  authToken?: string;
}

export interface BeaconStore extends Repositories {
  db: LibSQLDatabase<typeof schema>;
  client: Client;
  close(): void;
}

export async function openStore(options: OpenStoreOptions): Promise<BeaconStore> {
  const client = createClient({ url: options.url, authToken: options.authToken });
  // A local file DB is opened by both the worker and the web app at once. WAL +
  // a busy timeout let concurrent readers/writers coexist instead of
  // intermittently throwing "database is locked". Not applicable to Turso
  // (remote, server-managed) or :memory: (unshared), so file: URLs only.
  if (options.url.startsWith("file:")) {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 5000");
  }
  await initSchema(client);
  const db = drizzle(client, { schema });
  const repos = buildRepositories(db);
  return {
    ...repos,
    db,
    client,
    close: () => client.close(),
  };
}
