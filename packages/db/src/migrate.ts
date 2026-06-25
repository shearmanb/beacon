// Schema bootstrap. Kept as idempotent CREATE TABLE IF NOT EXISTS statements
// (rather than a drizzle-kit migration pipeline) so opening a store is
// self-contained — no separate migrate step, no generated SQL to keep in sync
// for this small schema. Must stay aligned with schema.ts.

import type { Client } from "@libsql/client";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    source_kind TEXT NOT NULL,
    definition TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS site_state (
    site_id TEXT PRIMARY KEY,
    last_checked TEXT,
    product_count INTEGER,
    data TEXT NOT NULL,
    cooldown_until TEXT,
    cooldown_level INTEGER,
    consecutive_errors INTEGER NOT NULL DEFAULT 0,
    error_alert_sent INTEGER NOT NULL DEFAULT 0,
    http_validators TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    site_id TEXT,
    type TEXT NOT NULL,
    handle TEXT,
    title TEXT,
    url TEXT,
    payload TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS alert_history_ts ON alert_history (ts)`,
  `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    definition TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ignored_products (
    handle TEXT PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    time TEXT,
    text TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    site_id TEXT,
    payload TEXT,
    created_at TEXT NOT NULL,
    processed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS commands_pending ON commands (processed_at)`,
  `CREATE TABLE IF NOT EXISTS secrets (
    ref TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS host_identities (
    host TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
];

export async function initSchema(client: Client): Promise<void> {
  for (const sql of STATEMENTS) {
    await client.execute(sql);
  }
}
