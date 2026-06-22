// Drains worker commands enqueued by the dashboard. Replaces the old
// "dashboard clears lastChecked in state.json / fights over the config SHA"
// mechanism with a race-free table the worker owns.

import type { BeaconStore, CommandRow } from "@beacon/db";

async function clearLastChecked(store: BeaconStore, siteId: string): Promise<void> {
  const state = await store.state.load(siteId);
  if (state) {
    state.lastChecked = null;
    await store.state.save(siteId, state);
  }
}

export async function applyCommands(store: BeaconStore, commands: CommandRow[]): Promise<void> {
  for (const cmd of commands) {
    if (cmd.type === "run_now") {
      if (cmd.siteId) {
        await clearLastChecked(store, cmd.siteId);
      } else {
        for (const row of await store.sites.list()) await clearLastChecked(store, row.id);
      }
    } else if (cmd.type === "set_imminent") {
      if (!cmd.siteId) continue;
      const site = await store.sites.get(cmd.siteId);
      if (!site) continue;
      const imminent = (cmd.payload as { imminent?: boolean } | null)?.imminent === true;
      await store.sites.upsert({
        ...site.definition,
        imminent,
        imminentSince: imminent ? new Date().toISOString() : null,
        scheduleBeforeImminent: imminent
          ? (site.definition.scheduleBeforeImminent ?? site.definition.schedule ?? null)
          : null,
      });
    }
  }
}
