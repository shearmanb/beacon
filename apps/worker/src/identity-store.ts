// Bridges @beacon/fetch's in-memory host-identity cache to the datastore (2i),
// so a restart rehydrates the browser identities it was already using per host
// instead of re-rolling fresh ones (a fresh browser from the same IP is itself a
// bot tell). Kept here (not in @beacon/fetch) so the fetch layer stays DB-free.

import { exportIdentities, importIdentities } from "@beacon/fetch";
import type { BeaconStore } from "@beacon/db";

/** Load persisted identities into the live cache (best-effort; called on boot). */
export async function rehydrateIdentities(store: BeaconStore): Promise<void> {
  const rows = await store.identities.all();
  importIdentities(rows);
}

/** Snapshot the live identities back to the datastore (best-effort). */
export async function persistIdentities(store: BeaconStore): Promise<void> {
  const snapshot = exportIdentities();
  if (snapshot.length) await store.identities.save(snapshot);
}
