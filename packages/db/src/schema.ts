// Drizzle schema (libSQL / SQLite dialect). This replaces the JSON-files-on-
// GitHub datastore. Site state (incl. the product map with firstSeen/prevPrice
// provenance) is stored as columns + a JSON blob; a separate per-product
// analytics table is intentionally deferred until an analytics feature needs it
// (alert_history already captures the time-series).

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import type { SiteDefinition, SiteState } from "@beacon/core";
import type { HttpValidators } from "@beacon/fetch";

export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sourceKind: text("source_kind").notNull(),
  definition: text("definition", { mode: "json" }).notNull().$type<SiteDefinition>(),
  updatedAt: text("updated_at"),
});

export const siteState = sqliteTable("site_state", {
  siteId: text("site_id").primaryKey(),
  lastChecked: text("last_checked"),
  productCount: integer("product_count"),
  // Full SiteState (products map, validators, cooldown, signal/guard flags).
  data: text("data", { mode: "json" }).notNull().$type<SiteState>(),
  cooldownUntil: text("cooldown_until"),
  cooldownLevel: integer("cooldown_level"),
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  errorAlertSent: integer("error_alert_sent", { mode: "boolean" }).notNull().default(false),
  httpValidators: text("http_validators", { mode: "json" }).$type<HttpValidators | null>(),
});

export const alertHistory = sqliteTable("alert_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: text("ts").notNull(),
  siteId: text("site_id"),
  type: text("type").notNull(),
  handle: text("handle"),
  title: text("title"),
  url: text("url"),
  payload: text("payload", { mode: "json" }),
});

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  definition: text("definition", { mode: "json" }).notNull(),
});

export const ignoredProducts = sqliteTable("ignored_products", {
  handle: text("handle").primaryKey(),
});

export const reminders = sqliteTable("reminders", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  time: text("time"),
  text: text("text").notNull(),
  priority: integer("priority", { mode: "boolean" }).notNull().default(false),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at"),
});

// Worker drains these at the top of each loop (Run Now, imminent toggle) — a
// race-free replacement for the old config.json SHA/409 fight.
export const commands = sqliteTable("commands", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  siteId: text("site_id"),
  payload: text("payload", { mode: "json" }),
  createdAt: text("created_at").notNull(),
  processedAt: text("processed_at"),
});

export const secrets = sqliteTable("secrets", {
  ref: text("ref").primaryKey(),
  value: text("value").notNull(),
});

// Small key/value store for operational metadata: the worker heartbeat (2e), the
// "initialized" latch that guards the auto-seed against a lost volume (1b), and
// future flags. Keeping it generic avoids a new table per scalar.
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at"),
});

// Persisted browser identities (2i) so a restart doesn't re-roll a fresh browser
// for every host from the same IP. Rehydrated into @beacon/fetch on boot.
export const hostIdentities = sqliteTable("host_identities", {
  host: text("host").primaryKey(),
  data: text("data", { mode: "json" }).notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const schema = {
  sites,
  siteState,
  alertHistory,
  schedules,
  ignoredProducts,
  reminders,
  commands,
  secrets,
  meta,
  hostIdentities,
};
