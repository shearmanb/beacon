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
import {
  matchLots,
  descriptionCoverage,
  parseUnicornListing,
  parseUnicornScanState,
  validateUnicornConfig,
  UNICORN_CONFIG_META_KEY,
  UNICORN_STATE_META_KEY,
  unicornTermSchema,
  type UnicornConfig,
} from "@beacon/core";
import { getStore } from "../lib/store";
import type { AddResult, PreviewResult } from "../lib/site-forms";
import type { UnicornActionResult, UnicornPreviewResult } from "../lib/unicorn-forms";

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

/**
 * Edit a site's source recipe as JSON (4c): the escape hatch so source-level
 * fixes (new fallback, changed collection path, swapped URL) are a form edit,
 * not a code deploy. Validated through the same Zod schema the worker uses.
 * A material change clears stored state so the next check re-baselines silently
 * (startup quiet mode) instead of flooding new_product alerts.
 */
export async function updateSiteSource(siteId: string, sourceJson: string): Promise<{ ok: boolean; error?: string }> {
  const store = await getStore();
  const site = await store.sites.get(siteId);
  if (!site) return { ok: false, error: `Unknown site "${siteId}".` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceJson);
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
  }
  const candidate = validateSite({ ...site.definition, source: parsed });
  if (!candidate.ok) return { ok: false, error: candidate.error ?? "Invalid source definition" };
  if (JSON.stringify(candidate.site!.source) === JSON.stringify(site.definition.source)) return { ok: true };
  await store.sites.upsert(candidate.site!);
  await store.state.clear(siteId);
  revalidatePath("/");
  revalidatePath("/products");
  return { ok: true };
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
  // Whole body guarded + a hard wall-clock budget: a tar-pitted host must end
  // as a visible "timed out" step, never a silently-dead server action. Every
  // run is logged so the Railway deploy logs keep a durable record ([diagnose]).
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), 45_000);
  try {
    const store = await getStore();
    const site = await store.sites.get(siteId);
    if (!site) return { error: `Unknown site "${siteId}".` };
    const deps = buildAdapterDeps(await store.secrets.all());
    // Hand diagnosis the stored lastError so it can retest the exact request
    // the checker died on (a page-1 probe alone misses deep-pagination blocks).
    const state = await store.state.load(siteId);
    const report = await coreDiagnoseSite(
      site.definition,
      { ...deps, signal: controller.signal },
      { lastError: state?.["lastError"] as string | undefined },
    );
    console.log(
      `[diagnose] ${siteId} blocked=${report.blocked}\n` +
        report.steps.map((s) => `[diagnose]   ${s.ok ? "✔" : "✘"} ${s.label}: ${s.detail}`).join("\n") +
        `\n[diagnose]   verdict: ${report.verdict}`,
    );
    return report;
  } catch (err) {
    const msg = controller.signal.aborted
      ? "Timed out after 45s — the host is stalling connections from this server (itself a bot-mitigation tell)."
      : (err as Error).message;
    console.error(`[diagnose] ${siteId} FAILED: ${msg}`);
    return { error: `Diagnosis failed: ${msg}` };
  } finally {
    clearTimeout(budget);
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

// ── Unicorn Auctions watcher (isolated module — meta-table storage only) ─────

/**
 * Merge a patch onto the stored Unicorn config and re-validate through the same
 * Zod schema the worker job uses. Also how the module is first enabled: an
 * empty patch on an empty store persists the defaults. Term edits deliberately
 * do NOT reset scan state — a newly added term's existing matches surface as
 * new-match alerts on the next scan (that's the point of adding it).
 */
export async function updateUnicornConfig(patch: Record<string, unknown>): Promise<UnicornActionResult> {
  const store = await getStore();
  const raw = await store.meta.get(UNICORN_CONFIG_META_KEY);
  let existing: Record<string, unknown> = {};
  if (raw) {
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* corrupt stored config — the patch becomes the new base */
    }
  }
  const validated = validateUnicornConfig({ ...existing, ...patch });
  if (!validated.ok) return { ok: false, error: validated.error ?? "Invalid config" };
  await store.meta.set(UNICORN_CONFIG_META_KEY, JSON.stringify(validated.config));
  revalidatePath("/unicorn");
  return { ok: true };
}

/** "Scan now": flag the scan state; the worker's next ~60s loop picks it up. */
export async function requestUnicornScan(): Promise<void> {
  const store = await getStore();
  const state = parseUnicornScanState(await store.meta.get(UNICORN_STATE_META_KEY));
  await store.meta.set(UNICORN_STATE_META_KEY, JSON.stringify({ ...state, forceScanRequested: true }));
  revalidatePath("/unicorn");
}

/**
 * Paste-payload sandbox: run the pure listing parser + term matcher on a copied
 * response body (DevTools → Network), no fetch. This is how the real listing
 * format/path get validated offline — unicornauctions.com may block datacenter
 * IPs, and dev sandboxes can't reach it either.
 */
export async function previewUnicornListing(
  body: string,
  format: UnicornConfig["format"],
  baseUrl: string,
  terms: unknown[],
): Promise<UnicornPreviewResult> {
  if (!body.trim()) return { ok: false, error: "Paste a listing payload first." };
  const parsedTerms = terms.flatMap((t) => {
    const r = unicornTermSchema.safeParse(t);
    return r.success ? [r.data] : [];
  });
  try {
    const page = parseUnicornListing(body, { format, baseUrl: baseUrl.trim() || "https://www.unicornauctions.com" });
    const matches = matchLots(page.lots, parsedTerms);
    return {
      ok: true,
      rawCount: page.lots.length,
      matchedCount: matches.length,
      descCoveragePct: Math.round(descriptionCoverage(page.lots) * 100),
      hasMore: page.hasMore,
      sample: (matches.length > 0 ? matches : page.lots.slice(0, 25).map((lot) => ({ lot, matchedTerms: [] as string[] })))
        .slice(0, 50)
        .map((m) => ({
          title: m.lot.title,
          url: m.lot.url,
          currentBidDollars: m.lot.currentBidDollars,
          matchedTerms: m.matchedTerms,
        })),
    };
  } catch (err) {
    return { ok: false, error: `Parse failed: ${(err as Error).message}` };
  }
}
