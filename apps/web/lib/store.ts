// Server-only datastore accessor. The dashboard and worker share the same
// libSQL DB (BEACON_DB_URL / Turso in prod, a local file in dev). One cached
// connection per server process.

import { openStore, type BeaconStore } from "@beacon/db";

let storePromise: Promise<BeaconStore> | null = null;

export function getStore(): Promise<BeaconStore> {
  if (!storePromise) {
    storePromise = openStore({
      url: process.env.BEACON_DB_URL ?? "file:beacon.db",
      authToken: process.env.BEACON_DB_AUTH_TOKEN,
    });
  }
  return storePromise;
}
