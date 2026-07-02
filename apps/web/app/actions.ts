"use server";

import { revalidatePath } from "next/cache";
import type { ScheduleRule, NormalizedProduct } from "@beacon/shared";
import {
  applyFilters,
  buildAdapterDeps,
  diagnoseSite as coreDiagnoseSite,
  getAdapter,
  hasAdapter,
  parseCampariCards,
  probeSite as coreProbeSite,
  validateSite,
  type DiagnoseReport,
  type ProbeResult,
} from "@beacon/core";
import { getStore } from "../lib/store";
import type { AddResult, PreviewResult } from "../lib/site-forms";

export async function saveSchedule(id: string, label: string, rules: ScheduleRule[]): Promise<void> {
  const store = await getStore();
  const trimmed = id.trim();
  if (!trimmed || rules.length === 0) return;
  await store.schedules.upsert(trimmed, { label: label.trim() || trimmed, rules });
  revalidatePath("/schedules");
  revalidatePath("/");
}

export async function deleteSchedule(id: string): Promise<void> {
  const store = await getStore();
  await store.schedules.remove(id);
  revalidatePath("/schedules");
  revalidatePath("/");
}

export async function runNow(siteId?: string): Promise<void> {
  const store = await getStore();
  await store.commands.enqueue("run_now", siteId ?? null);
  revalidatePath("/");
}

export async function setMonitoring(siteId: string, enabled: boolean): Promise<void> {
  const store = await getStore();
  await store.sites.setEnabled(siteId, enabled);
  revalidatePath("/");
}

export async function setImminent(siteId: string, imminent: boolean): Promise<void> {
  const store = await getStore();
  await store.commands.enqueue("set_imminent", siteId, { imminent });
  revalidatePath("/");
}

export async function setSchedule(siteId: string, schedule: string): Promise<void> {
  const store = await getStore();
  const site = await store.sites.get(siteId);
  if (!site) return;
  await store.sites.upsert({ ...site.definition, schedule });
  revalidatePath("/");
}

/**
 * Set imminent-mode tuning for a site: how often it checks while imminent
 * (imminentIntervalMinutes) and how long imminent stays on before auto-revert
 * (imminentDurationMinutes). Lets a drop be watched at e.g. 1-min cadence over a
 * 90-min window — the worker hot-reloads it on the next loop.
 */
export async function setImminentTuning(
  siteId: string,
  intervalMinutes: number,
  durationMinutes: number,
): Promise<void> {
  const store = await getStore();
  const site = await store.sites.get(siteId);
  if (!site) return;
  if (!(intervalMinutes > 0) || !(durationMinutes > 0)) return;
  await store.sites.upsert({
    ...site.definition,
    imminentIntervalMinutes: intervalMinutes,
    imminentDurationMinutes: durationMinutes,
  });
  revalidatePath("/");
}

/**
 * Edit a site's title-keyword filters (what titles it alerts on) without
 * re-creating the site. Mirrors setSchedule. When the keyword lists actually
 * change, the site's stored state is cleared so the next check re-baselines —
 * otherwise broadening the keywords would flood `new_product` alerts for
 * products that were simply filtered out before (existing T8KE/Jay West bottles
 * suddenly "appearing"). The full definition re-validates via Zod on upsert.
 */
export async function setSiteFilters(
  siteId: string,
  patch: { titleContains?: string[]; titleExcludes?: string[] },
): Promise<void> {
  const store = await getStore();
  const site = await store.sites.get(siteId);
  if (!site) return;
  const prev = site.definition.filters;
  const next = {
    ...prev,
    ...(patch.titleContains !== undefined ? { titleContains: patch.titleContains } : {}),
    ...(patch.titleExcludes !== undefined ? { titleExcludes: patch.titleExcludes } : {}),
  };
  const changed =
    JSON.stringify(prev.titleContains ?? []) !== JSON.stringify(next.titleContains ?? []) ||
    JSON.stringify(prev.titleExcludes ?? []) !== JSON.stringify(next.titleExcludes ?? []);
  if (!changed) return;
  await store.sites.upsert({ ...site.definition, filters: next });
  await store.state.clear(siteId);
  revalidatePath("/");
  revalidatePath("/products");
}

export async function setIgnore(handle: string, ignored: boolean): Promise<void> {
  const store = await getStore();
  if (ignored) await store.ignored.add(handle);
  else await store.ignored.remove(handle);
  revalidatePath("/products");
}

export async function addReminder(input: {
  date: string;
  time: string;
  text: string;
  priority: boolean;
}): Promise<void> {
  const store = await getStore();
  if (!input.date || !input.text.trim()) return;
  await store.reminders.add({
    id: `r_${Date.now()}`,
    date: input.date,
    time: input.time || null,
    text: input.text.trim(),
    priority: input.priority,
  });
  revalidatePath("/reminders");
}

export async function setReminderDone(id: string, done: boolean): Promise<void> {
  const store = await getStore();
  await store.reminders.update(id, { done });
  revalidatePath("/reminders");
}

export async function setReminderPriority(id: string, priority: boolean): Promise<void> {
  const store = await getStore();
  await store.reminders.update(id, { priority });
  revalidatePath("/reminders");
}

/**
 * 🩺 Block diagnosis: exercise the site's channels step-by-step FROM THIS SERVER
 * (the dashboard shares Railway's egress IP with the worker) and report a
 * plain-English verdict — the one-click answer to "is Railway's IP blocked, or
 * is the site actually down?".
 */
export async function diagnoseSite(siteId: string): Promise<DiagnoseReport | { error: string }> {
  const store = await getStore();
  const site = await store.sites.get(siteId);
  if (!site) return { error: `Unknown site "${siteId}".` };
  try {
    const deps = buildAdapterDeps(await store.secrets.all());
    return await coreDiagnoseSite(site.definition, deps);
  } catch (err) {
    return { error: `Diagnosis failed: ${(err as Error).message}` };
  }
}

// ── Add-site flow + sandbox ──────────────────────────────────────────────────

/** Probe a URL and suggest a source recipe (thin wrapper over the core probe). */
export async function probeSite(url: string): Promise<ProbeResult> {
  return coreProbeSite(url);
}

/**
 * Run a candidate definition through the real adapter (prev=undefined) and
 * report what it would track — the sandbox preview. Validates via the same Zod
 * schema the worker uses, so a passing preview is a passing config.
 */
export async function previewSite(input: unknown): Promise<PreviewResult> {
  const parsed = validateSite(input);
  if (!parsed.ok) return { ok: false, error: parsed.error ?? "Invalid site definition" };
  const def = parsed.site!;
  if (!hasAdapter(def.source.kind)) {
    return { ok: false, error: `No adapter implemented for "${def.source.kind}" (the html recipe is declarative-only and not wired up yet).` };
  }
  try {
    const store = await getStore();
    const deps = buildAdapterDeps(await store.secrets.all());
    const adapter = getAdapter(def.source.kind);
    const result = await adapter.fetch(def, {}, deps);
    if (result.kind === "signal") {
      const blocked = result.signal.kind === "blocked";
      return {
        ok: true,
        mode: "signal",
        blocked,
        detail: blocked
          ? result.signal.reason ?? "Blocked (password wall / coming-soon / 401-403)."
          : "Page is open (reachable, not blocked). No site_reset would fire right now.",
      };
    }
    if (result.kind === "not_modified") {
      return { ok: true, mode: "products", rawCount: 0, filteredCount: 0, sample: [], detail: "Source returned 304 Not Modified — nothing to preview." };
    }
    const raw: NormalizedProduct[] = result.products;
    const filtered = applyFilters(raw, def.filters);
    return {
      ok: true,
      mode: "products",
      rawCount: raw.length,
      filteredCount: filtered.length,
      sample: filtered.slice(0, 50).map((p) => ({
        title: p.title,
        available: p.available,
        minPrice: p.minPrice ?? null,
        url: p.url,
        vendor: p.vendor ?? null,
      })),
    };
  } catch (err) {
    return { ok: false, error: `Fetch / parse failed: ${(err as Error).message}` };
  }
}

/**
 * Campari card parser sandbox — runs the pure `parseCampariCards` on pasted HTML
 * (no fetch). Campari sites (Wild Turkey, Russell's Reserve) 403 datacenter IPs,
 * so the live URL preview can't reach them; this lets you validate the parser
 * against a real page's source offline. Same code path the worker's custom
 * `campari_v1` extractor uses, minus the network.
 */
export async function previewCampariHtml(
  html: string,
  baseUrl: string,
  useCollectionSchema: boolean,
): Promise<PreviewResult> {
  if (!html.trim()) return { ok: false, error: "Paste some page HTML first." };
  try {
    const products = parseCampariCards(html, {
      baseUrl: baseUrl.trim() || "https://example.com",
      useCollectionSchema,
    });
    const buyable = products.filter((p) => p.available).length;
    return {
      ok: true,
      mode: "products",
      rawCount: products.length,
      filteredCount: products.length,
      detail: `Parsed ${products.length} product card${products.length === 1 ? "" : "s"} (${buyable} buyable). Site filters are applied later by the pipeline.`,
      sample: products.slice(0, 50).map((p) => ({
        title: p.title,
        available: p.available,
        minPrice: p.minPrice ?? null,
        url: p.url,
        vendor: p.vendor ?? null,
      })),
    };
  } catch (err) {
    return { ok: false, error: `Parse failed: ${(err as Error).message}` };
  }
}

/** Validate + persist a new site. Refuses to clobber an existing id. */
export async function addSite(input: unknown): Promise<AddResult> {
  const parsed = validateSite(input);
  if (!parsed.ok) return { ok: false, error: parsed.error ?? "Invalid site definition" };
  const def = parsed.site!;
  const store = await getStore();
  if (await store.sites.get(def.id)) {
    return { ok: false, error: `A site with id "${def.id}" already exists — choose a different id.` };
  }
  await store.sites.upsert(def);
  revalidatePath("/");
  revalidatePath("/products");
  return { ok: true, id: def.id };
}

export async function removeReminder(id: string): Promise<void> {
  const store = await getStore();
  await store.reminders.remove(id);
  revalidatePath("/reminders");
}
