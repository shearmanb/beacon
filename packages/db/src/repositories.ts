// Repositories — the typed API the worker, migration script, and web app use
// instead of touching tables directly. Grouped onto one store object so callers
// do `store.sites.list()`, `store.state.load(id)`, etc.

import { asc, desc, eq, isNull } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { Alert, ProductMap, ScheduleDefinition } from "@beacon/shared";
import { siteDefinitionSchema, type SiteDefinition, type SiteState } from "@beacon/core";
import * as t from "./schema.js";

type DB = LibSQLDatabase<typeof t.schema>;

export interface SiteRow {
  id: string;
  name: string;
  enabled: boolean;
  sourceKind: string;
  definition: SiteDefinition;
}

export interface ReminderRow {
  id: string;
  date: string;
  time: string | null;
  text: string;
  priority: boolean;
  done: boolean;
}

export interface CommandRow {
  id: number;
  type: string;
  siteId: string | null;
  payload: unknown;
  createdAt: string;
}

function sitesRepo(db: DB) {
  return {
    async list(): Promise<SiteRow[]> {
      const rows = await db.select().from(t.sites);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        sourceKind: r.sourceKind,
        definition: r.definition,
      }));
    },
    async get(id: string): Promise<SiteRow | undefined> {
      const [r] = await db.select().from(t.sites).where(eq(t.sites.id, id));
      if (!r) return undefined;
      return { id: r.id, name: r.name, enabled: r.enabled, sourceKind: r.sourceKind, definition: r.definition };
    },
    /** Validate through Zod, then upsert. Throws on invalid definition. */
    async upsert(input: unknown): Promise<SiteDefinition> {
      const def = siteDefinitionSchema.parse(input);
      const row = {
        id: def.id,
        name: def.name,
        enabled: def.enabled,
        sourceKind: def.source.kind,
        definition: def,
        updatedAt: new Date().toISOString(),
      };
      await db
        .insert(t.sites)
        .values(row)
        .onConflictDoUpdate({ target: t.sites.id, set: row });
      return def;
    },
    async setEnabled(id: string, enabled: boolean): Promise<void> {
      const site = await this.get(id);
      if (!site) return;
      await this.upsert({ ...site.definition, enabled });
    },
  };
}

function stateRepo(db: DB) {
  return {
    /** The SiteState the engine expects as `previousState` (or undefined). */
    async load(siteId: string): Promise<SiteState | undefined> {
      const [r] = await db.select().from(t.siteState).where(eq(t.siteState.siteId, siteId));
      return r?.data;
    },
    async save(siteId: string, state: SiteState): Promise<void> {
      const row = {
        siteId,
        lastChecked: state.lastChecked ?? null,
        productCount: typeof state.productCount === "number" ? state.productCount : null,
        data: state,
        cooldownUntil: (state.cooldownUntil as string | undefined) ?? null,
        cooldownLevel: (state.cooldownLevel as number | undefined) ?? null,
        consecutiveErrors: (state.consecutiveErrors as number | undefined) ?? 0,
        errorAlertSent: state.errorAlertSent === true,
        httpValidators: state.httpValidators ?? null,
      };
      await db
        .insert(t.siteState)
        .values(row)
        .onConflictDoUpdate({ target: t.siteState.siteId, set: row });
    },
    async products(siteId: string): Promise<ProductMap> {
      const state = await this.load(siteId);
      return ((state?.products as ProductMap | undefined) ?? {}) as ProductMap;
    },
  };
}

function historyRepo(db: DB) {
  return {
    async append(siteId: string | null, alerts: Alert[]): Promise<void> {
      if (alerts.length === 0) return;
      const ts = new Date().toISOString();
      await db.insert(t.alertHistory).values(
        alerts.map((a) => ({
          ts,
          siteId,
          type: a.type,
          handle: a.product.handle ?? null,
          title: a.product.title,
          url: a.product.url,
          payload: a.product as unknown,
        })),
      );
    },
    async recent(limit = 100) {
      return db.select().from(t.alertHistory).orderBy(desc(t.alertHistory.id)).limit(limit);
    },
    /** Bulk import historical rows preserving original timestamps (migration). */
    async import(
      rows: Array<{ ts: string; siteId: string | null; type: string; handle: string | null; title: string | null; url: string | null; payload: unknown }>,
    ): Promise<void> {
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        if (chunk.length) await db.insert(t.alertHistory).values(chunk);
      }
    },
    async count(): Promise<number> {
      const rows = await db.select().from(t.alertHistory);
      return rows.length;
    },
  };
}

function schedulesRepo(db: DB) {
  return {
    async all(): Promise<Record<string, ScheduleDefinition>> {
      const rows = await db.select().from(t.schedules);
      const out: Record<string, ScheduleDefinition> = {};
      for (const r of rows) out[r.id] = r.definition as ScheduleDefinition;
      return out;
    },
    async upsert(id: string, definition: ScheduleDefinition): Promise<void> {
      await db
        .insert(t.schedules)
        .values({ id, definition })
        .onConflictDoUpdate({ target: t.schedules.id, set: { definition } });
    },
    async remove(id: string): Promise<void> {
      await db.delete(t.schedules).where(eq(t.schedules.id, id));
    },
  };
}

function ignoredRepo(db: DB) {
  return {
    async set(): Promise<Set<string>> {
      const rows = await db.select().from(t.ignoredProducts);
      return new Set(rows.map((r) => r.handle));
    },
    async add(handle: string): Promise<void> {
      await db.insert(t.ignoredProducts).values({ handle }).onConflictDoNothing();
    },
    async remove(handle: string): Promise<void> {
      await db.delete(t.ignoredProducts).where(eq(t.ignoredProducts.handle, handle));
    },
  };
}

function remindersRepo(db: DB) {
  return {
    async list(): Promise<ReminderRow[]> {
      const rows = await db
        .select()
        .from(t.reminders)
        .orderBy(asc(t.reminders.date), asc(t.reminders.time));
      return rows.map((r) => ({
        id: r.id,
        date: r.date,
        time: r.time,
        text: r.text,
        priority: r.priority,
        done: r.done,
      }));
    },
    async add(row: Omit<ReminderRow, "done"> & { done?: boolean }): Promise<void> {
      await db.insert(t.reminders).values({
        id: row.id,
        date: row.date,
        time: row.time ?? null,
        text: row.text,
        priority: row.priority,
        done: row.done ?? false,
        createdAt: new Date().toISOString(),
      });
    },
    async update(id: string, fields: Partial<Pick<ReminderRow, "done" | "priority" | "text">>): Promise<void> {
      await db.update(t.reminders).set(fields).where(eq(t.reminders.id, id));
    },
    async remove(id: string): Promise<void> {
      await db.delete(t.reminders).where(eq(t.reminders.id, id));
    },
  };
}

function commandsRepo(db: DB) {
  return {
    async enqueue(type: string, siteId: string | null = null, payload: unknown = null): Promise<void> {
      await db.insert(t.commands).values({
        type,
        siteId,
        payload,
        createdAt: new Date().toISOString(),
      });
    },
    /** Return pending commands and mark them processed in one go. */
    async drainPending(): Promise<CommandRow[]> {
      const pending = await db.select().from(t.commands).where(isNull(t.commands.processedAt));
      if (pending.length === 0) return [];
      const now = new Date().toISOString();
      for (const c of pending) {
        await db.update(t.commands).set({ processedAt: now }).where(eq(t.commands.id, c.id));
      }
      return pending.map((c) => ({ id: c.id, type: c.type, siteId: c.siteId, payload: c.payload, createdAt: c.createdAt }));
    },
  };
}

function secretsRepo(db: DB) {
  return {
    async all(): Promise<Record<string, string>> {
      const rows = await db.select().from(t.secrets);
      const out: Record<string, string> = {};
      for (const r of rows) out[r.ref] = r.value;
      return out;
    },
    async set(ref: string, value: string): Promise<void> {
      await db
        .insert(t.secrets)
        .values({ ref, value })
        .onConflictDoUpdate({ target: t.secrets.ref, set: { value } });
    },
  };
}

export function buildRepositories(db: DB) {
  return {
    sites: sitesRepo(db),
    state: stateRepo(db),
    history: historyRepo(db),
    schedules: schedulesRepo(db),
    ignored: ignoredRepo(db),
    reminders: remindersRepo(db),
    commands: commandsRepo(db),
    secrets: secretsRepo(db),
  };
}

export type Repositories = ReturnType<typeof buildRepositories>;
