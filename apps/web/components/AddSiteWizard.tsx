"use client";

// Add-site wizard + sandbox. Three blocks: (1) probe a URL → auto-detect the
// source recipe and prefill, (2) configure friendly fields per kind, (3) preview
// what the real adapter parses, then save. Preview + save both go through the
// same Zod validation + engine the worker uses, so a green preview is a valid
// config. Friendly fields cover the two auto-probable kinds (shopify_rest,
// http_status) plus shopify_graphql/custom; the html recipe has no adapter yet.

import { useState, useTransition, type ReactNode } from "react";
import type { SourceKind } from "@beacon/core";
import { addSite, previewSite, probeSite } from "../app/actions";
import {
  numOrNull,
  slugify,
  splitList,
  splitNums,
  type AddResult,
  type PreviewResult,
} from "../lib/site-forms";

interface Form {
  name: string;
  id: string;
  idTouched: boolean;
  enabled: boolean;
  schedule: string;
  kind: SourceKind;
  // shopify_rest
  baseUrl: string;
  collectionPath: string;
  // http_status
  statusUrl: string;
  blockedBody: string;
  blockedStatuses: string;
  // shopify_graphql
  gqlDomain: string;
  gqlCollectionId: string;
  gqlTokenRef: string;
  gqlApiVersion: string;
  gqlProductUrl: string;
  // custom
  customExtractorId: string;
  customUrl: string;
  customOptions: string;
  // filters
  titleContains: string;
  titleExcludes: string;
  vendorIs: string;
  availableOnly: boolean;
  minPrice: string;
  maxPrice: string;
  // alerts
  onNew: boolean;
  onRestock: boolean;
  onSoldOut: boolean;
  onSiteReset: boolean;
}

const KINDS: { value: SourceKind; label: string }[] = [
  { value: "shopify_rest", label: "Shopify (products.json)" },
  { value: "http_status", label: "Status monitor (page state)" },
  { value: "shopify_graphql", label: "Shopify Storefront (GraphQL)" },
  { value: "custom", label: "Custom extractor" },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function buildDefinition(f: Form): Record<string, unknown> {
  let source: Record<string, unknown>;
  switch (f.kind) {
    case "shopify_rest":
      source = {
        kind: "shopify_rest",
        baseUrl: f.baseUrl.trim(),
        ...(f.collectionPath.trim() ? { collectionPath: f.collectionPath.trim() } : {}),
        conditionalGet: true,
      };
      break;
    case "http_status":
      source = {
        kind: "http_status",
        url: f.statusUrl.trim(),
        blockedWhen: { bodyMatchesAny: splitList(f.blockedBody), httpStatusIn: splitNums(f.blockedStatuses) },
      };
      break;
    case "shopify_graphql":
      source = {
        kind: "shopify_graphql",
        domain: f.gqlDomain.trim(),
        collectionId: f.gqlCollectionId.trim(),
        accessTokenRef: f.gqlTokenRef.trim(),
        apiVersion: f.gqlApiVersion.trim() || "2025-01",
        ...(f.gqlProductUrl.trim() ? { productUrl: f.gqlProductUrl.trim() } : {}),
      };
      break;
    case "custom": {
      const raw = f.customOptions.trim();
      const options = raw ? (JSON.parse(raw) as unknown) : undefined; // may throw → caught by caller
      source = {
        kind: "custom",
        extractorId: f.customExtractorId.trim(),
        url: f.customUrl.trim(),
        ...(options !== undefined ? { options } : {}),
      };
      break;
    }
    default:
      throw new Error(`Unsupported source kind: ${String(f.kind)}`);
  }
  return {
    id: f.id.trim(),
    name: f.name.trim(),
    enabled: f.enabled,
    ...(f.schedule ? { schedule: f.schedule } : {}),
    alerts: { onNew: f.onNew, onRestock: f.onRestock, onSoldOut: f.onSoldOut, onSiteReset: f.onSiteReset },
    filters: {
      titleContains: splitList(f.titleContains),
      titleExcludes: splitList(f.titleExcludes),
      vendorIs: splitList(f.vendorIs),
      availableOnly: f.availableOnly,
      minPriceDollars: numOrNull(f.minPrice),
      maxPriceDollars: numOrNull(f.maxPrice),
    },
    source,
  };
}

export function AddSiteWizard({
  scheduleOptions,
  extractors,
}: {
  scheduleOptions: { value: string; label: string }[];
  extractors: string[];
}) {
  const [f, setF] = useState<Form>({
    name: "",
    id: "",
    idTouched: false,
    enabled: true,
    schedule: "20",
    kind: "shopify_rest",
    baseUrl: "",
    collectionPath: "",
    statusUrl: "",
    blockedBody: "sqs-pw-form, coming soon, enter password",
    blockedStatuses: "401, 403",
    gqlDomain: "",
    gqlCollectionId: "",
    gqlTokenRef: "",
    gqlApiVersion: "2025-01",
    gqlProductUrl: "",
    customExtractorId: extractors[0] ?? "",
    customUrl: "",
    customOptions: "",
    titleContains: "",
    titleExcludes: "",
    vendorIs: "",
    availableOnly: false,
    minPrice: "",
    maxPrice: "",
    onNew: true,
    onRestock: true,
    onSoldOut: false,
    onSiteReset: true,
  });

  function update<K extends keyof Form>(key: K, value: Form[K]): void {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  const [probeUrl, setProbeUrl] = useState("");
  const [probeMsg, setProbeMsg] = useState<{ err: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [saved, setSaved] = useState<AddResult | null>(null);
  const [pending, start] = useTransition();

  function doProbe(): void {
    setProbeMsg(null);
    setSaved(null);
    start(async () => {
      const r = await probeSite(probeUrl);
      if (r.error) {
        setProbeMsg({ err: true, text: r.error });
        return;
      }
      setProbeMsg({ err: false, text: r.detail });
      setF((prev) => {
        const next = { ...prev };
        if (r.name && !prev.name) {
          next.name = r.name;
          if (!prev.idTouched) next.id = slugify(r.name);
        }
        if (r.kind) next.kind = r.kind;
        const src = r.source;
        if (src?.kind === "shopify_rest") {
          next.baseUrl = src.baseUrl;
          next.collectionPath = src.collectionPath ?? "";
        } else if (src?.kind === "http_status") {
          next.statusUrl = src.url;
          next.blockedBody = src.blockedWhen.bodyMatchesAny.join(", ");
          next.blockedStatuses = src.blockedWhen.httpStatusIn.join(", ");
        }
        return next;
      });
    });
  }

  function withDefinition(run: (def: Record<string, unknown>) => void): void {
    setSaved(null);
    let def: Record<string, unknown>;
    try {
      def = buildDefinition(f);
    } catch (e) {
      setPreview({ ok: false, error: `Custom options must be valid JSON: ${(e as Error).message}` });
      return;
    }
    run(def);
  }

  function doPreview(): void {
    setPreview(null);
    withDefinition((def) => start(async () => setPreview(await previewSite(def))));
  }

  function doSave(): void {
    withDefinition((def) => start(async () => setSaved(await addSite(def))));
  }

  return (
    <>
      <div className="card wizard-step">
        <h3>1 · Probe a URL (optional)</h3>
        <div className="filters">
          <input
            className="in"
            style={{ flex: 1, minWidth: 260 }}
            placeholder="https://store.com/collections/whiskey"
            value={probeUrl}
            onChange={(e) => setProbeUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && probeUrl.trim() && doProbe()}
          />
          <button className="btn" disabled={pending || !probeUrl.trim()} onClick={doProbe}>
            Probe
          </button>
        </div>
        {probeMsg && <div className={`preview-note ${probeMsg.err ? "err" : "ok"}`}>{probeMsg.text}</div>}
      </div>

      <div className="card wizard-step">
        <h3>2 · Configure</h3>
        <div className="form-cols">
          <Field label="Name">
            <input
              className="in"
              value={f.name}
              onChange={(e) => {
                const name = e.target.value;
                setF((prev) => ({ ...prev, name, id: prev.idTouched ? prev.id : slugify(name) }));
              }}
            />
          </Field>
          <Field label="Id (unique)">
            <input
              className="in"
              value={f.id}
              onChange={(e) => setF((prev) => ({ ...prev, id: e.target.value, idTouched: true }))}
            />
          </Field>
          <Field label="Schedule">
            <select className="in" value={f.schedule} onChange={(e) => update("schedule", e.target.value)}>
              {scheduleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Monitoring">
            <label className="check">
              <input type="checkbox" checked={f.enabled} onChange={(e) => update("enabled", e.target.checked)} /> enabled
            </label>
          </Field>
        </div>

        <Field label="Source kind">
          <select className="in" value={f.kind} onChange={(e) => update("kind", e.target.value as SourceKind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>

        {f.kind === "shopify_rest" && (
          <div className="form-cols">
            <Field label="Base URL" hint="Store root, e.g. https://sharedpour.com">
              <input className="in" value={f.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} />
            </Field>
            <Field label="Collection path (optional)" hint="e.g. collections/t8ke — blank = whole store">
              <input className="in" value={f.collectionPath} onChange={(e) => update("collectionPath", e.target.value)} />
            </Field>
          </div>
        )}

        {f.kind === "http_status" && (
          <div className="form-cols">
            <Field label="Page URL">
              <input className="in" value={f.statusUrl} onChange={(e) => update("statusUrl", e.target.value)} />
            </Field>
            <Field label="Blocked body signals" hint="comma-separated; any match = blocked">
              <input className="in" value={f.blockedBody} onChange={(e) => update("blockedBody", e.target.value)} />
            </Field>
            <Field label="Blocked HTTP statuses" hint="comma-separated, e.g. 401, 403">
              <input className="in" value={f.blockedStatuses} onChange={(e) => update("blockedStatuses", e.target.value)} />
            </Field>
          </div>
        )}

        {f.kind === "shopify_graphql" && (
          <>
            <div className="form-cols">
              <Field label="Domain" hint="e.g. shared-pour.myshopify.com">
                <input className="in" value={f.gqlDomain} onChange={(e) => update("gqlDomain", e.target.value)} />
              </Field>
              <Field label="Collection ID">
                <input className="in" value={f.gqlCollectionId} onChange={(e) => update("gqlCollectionId", e.target.value)} />
              </Field>
              <Field label="Access token ref" hint="key in the secrets table — never an inline token">
                <input className="in" value={f.gqlTokenRef} onChange={(e) => update("gqlTokenRef", e.target.value)} />
              </Field>
              <Field label="API version">
                <input className="in" value={f.gqlApiVersion} onChange={(e) => update("gqlApiVersion", e.target.value)} />
              </Field>
              <Field label="Product URL (optional)">
                <input className="in" value={f.gqlProductUrl} onChange={(e) => update("gqlProductUrl", e.target.value)} />
              </Field>
            </div>
            <p className="hint">
              The token referenced above must already exist in the secrets table — this form doesn’t manage secrets.
            </p>
          </>
        )}

        {f.kind === "custom" && (
          <div className="form-cols">
            <Field label="Extractor">
              <select className="in" value={f.customExtractorId} onChange={(e) => update("customExtractorId", e.target.value)}>
                {extractors.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
                {extractors.length === 0 && <option value="">(none registered)</option>}
              </select>
            </Field>
            <Field label="URL">
              <input className="in" value={f.customUrl} onChange={(e) => update("customUrl", e.target.value)} />
            </Field>
            <Field label="Options (JSON, optional)" hint='e.g. {"useCollectionSchema": true}'>
              <input className="in" value={f.customOptions} onChange={(e) => update("customOptions", e.target.value)} />
            </Field>
          </div>
        )}

        <details className="adv">
          <summary>Filters &amp; alerts</summary>
          <div className="form-cols" style={{ marginTop: 10 }}>
            <Field label="Title contains" hint="comma-separated">
              <input className="in" value={f.titleContains} onChange={(e) => update("titleContains", e.target.value)} />
            </Field>
            <Field label="Title excludes" hint="comma-separated">
              <input className="in" value={f.titleExcludes} onChange={(e) => update("titleExcludes", e.target.value)} />
            </Field>
            <Field label="Vendor is" hint="comma-separated">
              <input className="in" value={f.vendorIs} onChange={(e) => update("vendorIs", e.target.value)} />
            </Field>
            <Field label="Min price $">
              <input className="in" value={f.minPrice} onChange={(e) => update("minPrice", e.target.value)} />
            </Field>
            <Field label="Max price $">
              <input className="in" value={f.maxPrice} onChange={(e) => update("maxPrice", e.target.value)} />
            </Field>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", marginTop: 8 }}>
            <label className="check">
              <input type="checkbox" checked={f.availableOnly} onChange={(e) => update("availableOnly", e.target.checked)} /> available only
            </label>
            <label className="check">
              <input type="checkbox" checked={f.onNew} onChange={(e) => update("onNew", e.target.checked)} /> alert: new
            </label>
            <label className="check">
              <input type="checkbox" checked={f.onRestock} onChange={(e) => update("onRestock", e.target.checked)} /> restock
            </label>
            <label className="check">
              <input type="checkbox" checked={f.onSoldOut} onChange={(e) => update("onSoldOut", e.target.checked)} /> sold out
            </label>
            <label className="check">
              <input type="checkbox" checked={f.onSiteReset} onChange={(e) => update("onSiteReset", e.target.checked)} /> site reset
            </label>
          </div>
        </details>
      </div>

      <div className="card wizard-step">
        <h3>3 · Preview &amp; save</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" disabled={pending} onClick={doPreview}>
            {pending ? "…" : "Preview"}
          </button>
          <button className="btn on" disabled={pending} onClick={doSave}>
            Save site
          </button>
        </div>

        {preview && <PreviewPanel preview={preview} />}

        {saved &&
          (saved.ok ? (
            <div className="preview-note ok" style={{ marginTop: 10 }}>
              Saved “{saved.id}”. <a href="/">Go to dashboard →</a>
            </div>
          ) : (
            <div className="preview-note err" style={{ marginTop: 10 }}>
              {saved.error}
            </div>
          ))}
      </div>
    </>
  );
}

function PreviewPanel({ preview }: { preview: PreviewResult }) {
  if (!preview.ok) {
    return (
      <div className="preview-note err" style={{ marginTop: 10 }}>
        {preview.error}
      </div>
    );
  }
  if (preview.mode === "signal") {
    return (
      <div className={`preview-note ${preview.blocked ? "err" : "ok"}`} style={{ marginTop: 10 }}>
        {preview.detail}
      </div>
    );
  }
  const noneAfterFilters = preview.filteredCount === 0 && preview.rawCount > 0;
  return (
    <div style={{ marginTop: 10 }}>
      <div className={`preview-note ${noneAfterFilters ? "err" : "ok"}`}>
        Fetched <b>{preview.rawCount}</b> product{preview.rawCount === 1 ? "" : "s"}, <b>{preview.filteredCount}</b> after
        filters{noneAfterFilters ? " — nothing passes your current filters." : "."}
        {preview.detail ? ` ${preview.detail}` : ""}
      </div>
      {preview.sample.length > 0 && (
        <table className="ptable" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Product</th>
              <th>Price</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {preview.sample.map((p, i) => (
              <tr key={`${p.url}:${i}`}>
                <td>
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {p.title}
                  </a>
                  {p.vendor && <span className="faint"> · {p.vendor}</span>}
                </td>
                <td className="mono">{p.minPrice != null ? `$${p.minPrice.toFixed(2)}` : "—"}</td>
                <td>
                  <span className={`pill ${p.available ? "yes" : "no"}`}>{p.available ? "in stock" : "sold out"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
