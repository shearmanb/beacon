# Handoff: Beacon — Bourbon Stock Monitor UI Redesign

## Overview
Beacon is a personal dashboard that monitors bourbon retail sites and alerts the owner (via Discord) when bottles come in stock. This handoff covers a **full UI redesign**: a mission-control aesthetic, 10 selectable brand-inspired color themes, redesigned site-health cards with a check-history timeline, a hero section for the owner's favorite brand (Reveries / T8KE), a refined products table, and two side rails (drop reminders; pending orders + collection).

## About the Design Files
These files are **design references created in HTML** — prototypes showing intended look and behavior, not production code to copy directly. Recreate the designs in the target codebase's existing environment and patterns. The prototype uses React 18 + Babel-in-browser purely as a mockup vehicle. All data in `data.js` is mock data shaped to match the real app's domain — wire to real backend equivalents.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and interactions are final design intent — recreate precisely. Exact values live in `theme.css` (palettes), `ui.css` (components), `brand.css` (per-theme flourishes).

## File map (in this bundle, under `design-reference/`)
- `Beacon Redesign.html` — entry point: font loading + script order
- `beacon/theme.css` — CSS custom-property theme system + base layout/utilities
- `beacon/ui.css` — component styles + compact-density overrides + mobile
- `beacon/brand.css` — per-theme brand flourishes, scoped by `[data-theme="…"]`
- `beacon/data.js` — mock data (`window.BEACON_DATA`)
- `beacon/parts.jsx` — Dot, CheckTimeline, Chip, Switch, SectionHead, ReveriesSection, ProductsSection
- `beacon/sites.jsx` — SitesSection, SiteCard, SitePill (mini mode)
- `beacon/rails.jsx` — LeftRail (reminders), RightRail (pending/collection)
- `beacon/app.jsx` — Header, GlanceStrip (mobile), App shell, theme switching
- `beacon/tweaks-panel.jsx` — review tooling; **do not port**

## Screenshots (`../screenshots/`)
- `01`–`10` — one per color theme (reveries, wildturkey, jackdaniels, heavenhill, willett, weller, makersmark wax header, michters, flightdeck, flightpath), Sites section in detailed view
- `11`–`13` — Sites view modes: mini pills / compact / detailed
- `14`–`15` — Reveries hero grid · products table (NEW badge, price deltas, chips)
- `16`–`18` — reminders rail · pending rail with status stepper · collection tab
- `19` — the "? guide" tile-legend modal
- Captured at ~915px (single-column responsive). Desktop = the 3-column grid in the Layout section below.

## Theme System (the centerpiece)
Everything is painted from ~16 CSS custom properties set on `:root`, selected by `data-theme` on `<html>`. Theme choice is user-selectable at runtime (header dropdown) and persisted (localStorage in the prototype). Variables:

```
--bg --bg2          page + rail backgrounds
--panel --panel2    card surfaces
--line --line2      hairline + stronger borders
--text --muted --faint    3-step text hierarchy
--accent --accent-dim     brand signal color + ~10% alpha wash
--rev --rev-dim           secondary (Reveries) brand color + wash
--ok --warn --err         status colors (darkened per-theme on light themes for contrast)
--display                 per-theme display font (wordmark + section headers)
--mono --sans             IBM Plex Mono (all data) + IBM Plex Sans (body)
```

Base layout/component CSS references **only** these variables. Brand personality lives entirely in `brand.css` as `[data-theme="…"]` override blocks. **Keep this separation** — adding a theme = one palette block in `theme.css` + an optional flourish block in `brand.css`.

When switching themes, add a `.theme-swap` class to `<html>` for two frames (kills transitions so resolved colors don't visually freeze mid-interpolation), then remove it.

### Theme roster (10)
| id | Inspiration | Base | Accent / signature flourish | Display font |
|---|---|---|---|---|
| `reveries` | Reveries/T8KE Raven | near-black `#070605` | antique gold `#dcb45e`; gold-foil gradient wordmark, double gold rules, diamond ticks | IM Fell English SC (antique engraved smallcaps) |
| `wildturkey` | WT 101 / Rare Breed | charcoal `#141416` | 101-red `#cf2733` top banner + buttons; 80s gold-foil gradient wordmark | Bebas Neue (101 condensed block caps) |
| `jackdaniels` | Classic black label | black `#0d0d0c` | white pinstripe double-frames on every card (2px outer + inset line `#efece0`); gold `#c9a356` only as small touches | Pinyon Script wordmark, Rye section headers |
| `heavenhill` | Heritage 17/20yr | navy `#0a1230` | gold foil `#e0bb66`, double gold rules | Cinzel (Trajan-style foil caps) |
| `willett` | Willett pot still | gallery white `#fbfbf8` | purple-top `#5e3a8c` + green-top `#20764a` as literal 4px card top-caps; italic serif headers | Bodoni Moda italic |
| `weller` | Weller rainbow line | cream `#f7f1e0` | 5-color header stripe; sections color-coded Sites=green `#2c7a3f`, Reveries=orange `#d97a1f`, Products=blue `#2456a8` | Besley (Clarendon label slab) |
| `makersmark` | Maker's red wax | cream `#f7f1e3` | red wax `#c02227` dripping from header top (layered radial-gradients); italic serif | IM Fell DW Pica italic (hand-cut label serif) |
| `michters` | US★1 label | buff `#efe4c4` | shield red `#9e1b1b` + gold `#a87b2f`; ★ before section headers; double-inset label borders | Marcellus (US★1 roman) |
| `flightdeck` | mission control | blue-black `#090d13` | cyan `#58c4dd` | IBM Plex Mono |
| `flightpath` | purple ops variant | `#0c0a14` | violet `#a78bfa` | IBM Plex Mono |

## Layout
**Desktop ≥1100px:** CSS grid `264px | 1fr | 296px` (left rail / main / right rail). Rails are `position: sticky; top: 0; height: 100vh; overflow-y: auto`, `--bg2` background, hairline border. Main column `padding: 0 24px 64px`. Header is sticky inside the main column.

**Mobile <1100px:** single column; rails stack below main. A **sticky glance strip** appears at the very top: `● 5/6 sites · 7 in stock · synced 6:50 PM` (the at-a-glance answer to "anything in stock? sites healthy?").

**Compact density** is a global toggle (`data-density="compact"` on `<html>`) that tightens padding, gaps, fonts, and grid track sizes throughout. Persisted.

## Sections & Components

### Header
Wordmark (`▲ BEACON` + version badge), then live stats (sites healthy / tracked / in-stock / last sync), then actions: **Run now**, **Schedules**, **Token**, **Webhook**, and the **theme dropdown** (all 10 themes). All four buttons stay visible per owner request.

### Sites (top priority section)
Grid of site cards. **Three view modes** (segmented control, persisted) + **collapse-all** + a **"? guide"** button that opens a legend modal explaining every tile element (port this — it's the user manual for the tile):
- **mini** / **collapsed** → `SitePill`: health dot, name, in-stock fraction, gold `R·N` badge = Reveries bottles in stock at that site, IMM badge, and far right `↻ 20m` = **current check cadence**.
- **compact** → flat card: single header row (dot · name · labeled STOCK x/y · labeled NEXT countdown · MON/IMM badges), check timeline, one meta line, expandable settings (▾).
- **detailed** (default) → same + settings always visible. MON/IMM badges hide here (the switches show state instead — no duplication).

**Site cards are intentionally FLAT and dense** — the whole card is: header row · timeline · meta line · (one settings row). Padding 7px 10px, grid tracks ~260px. Do not let them grow back.

**Meta line** (under timeline, one line): left = tally `4✓ 1◆ 0✗` (checks/finds/fails last hour); right = `every 20m · 6:39 PM · find 2h ago` (current cadence · last check · time since last stock change). Quick-cadence override shows amber `every 5m⚡`.

**Settings row** (single wrapping row): schedule select · MON switch · IMM switch · labeled AUTO-OFF minutes input · **⚡QUICK quick-cadence input** (enter minutes, Enter applies — a temporary flat-interval override of the schedule; while active renders as `⚡5m ✕` revert button).

### Check Timeline (replaces the old EKG/heartbeat — KEY redesign)
Per-site horizontal track spanning the **last 60 minutes**. Renders: a thin tick for **every check**, a **green diamond** where a new bottle was found, a **red ring** where a check failed, and a **"now" dot** at the right edge that **pulses while a live check is running**. Below it a legend reads `N checks · N found · N failed`. Position math: `left% = (60 − minutesAgo) / 60 * 100`. Data per site: `checks[]`, `found[]`, `fails[]` (arrays of minutes-ago). This is a health/history readout, not decoration — far more useful than the old animated pulse.

The prototype simulates a live check sweeping a random site every ~8s (the `ekgOn` prop / "Live check simulation" toggle). In production this state comes from the real monitor: mark a site "checking" while its fetch is in flight.

### Reveries · Jay West (hero section — owner's favorite brand)
Bigger card treatment. **In-stock bottles sort first and render large with a green signal glow.** Sold-out bottles are dimmed and **capped at ~one row (6) with a "▾ show all N sold out" expander** (per owner request). Each card: bottle-image placeholder (wire to real product images), stock/sold-out chip, name, site, price. Cards were sized down a touch in the last pass (min track ~178px). The in-stock cards get the theme's `--accent`/`--ok` framing depending on theme.

### All Products (table)
Refined table, `--mono` data. Columns: thumb · Product · Site · Price · Status · (ignore). Features:
- **Sortable columns** — click any header, toggles ▴/▾ (name/site/price/status).
- **NEW badge** on products first seen in last 24h (`isNew`).
- **Price-change indicator** — `↓$7` green for a drop, `↑$15` red for a hike (`delta` field, signed).
- Reveries rows carry a gold "Reveries" chip. Row hover reveals an "Ignore" action. Status chips: green "In stock" / faint "Sold out".

### Left Rail — Drop Reminders
Add form (date + time + text). List **auto-sorts by date; done items sink to bottom**. Countdown chip `T-Nd` turns **amber within 48h**. A reminder can **link to a site** → shows a `↗ <site>` button that smooth-scrolls to the Sites section. Click a row to toggle done (strikethrough + dim). Priority reminders get an accent left-border.

### Right Rail — Pending / Collection (tabbed)
- **Pending** tab: add form + cards. Each card has a **3-step status stepper — Ordered → Shipped → Delivered (tap to advance)**. At Delivered, a **"✓ Add to collection" button moves the bottle out of pending and into the Collection list**.
- **Collection** tab: currently a summary list (name · proof · year) + est. invested total. **My Collection is intentionally deferred** — the owner paused the full build-out. Leave the tab as the placeholder home; the full section (search/sort, price paid/est value, open/sealed, photos) is a future task.

## What NOT to build yet
- Full **My Collection** management view (deferred by owner).
- `tweaks-panel.jsx` and the `useTweaks` plumbing — mockup-only.

## Fonts
Google Fonts: IBM Plex Mono, IBM Plex Sans, Bebas Neue, Besley, Bodoni Moda, Cinzel, IM Fell English SC, IM Fell DW Pica, Marcellus, Pinyon Script, Rye. (See `<head>` of `Beacon Redesign.html` for exact weights/axes.) Self-host in production. NOTE: Bebas Neue, IM Fell (both cuts), and Marcellus ship regular-400 only — the brand.css overrides already set `font-weight: 400` where those are used; don't faux-bold them.

## Suggested build order
1. Theme system (CSS variables + `data-theme` switch + persistence) — everything depends on it.
2. Layout shell (3-col grid → responsive single-col + glance strip).
3. Sites section + SiteCard + view modes + **CheckTimeline** (wire to real monitor state).
4. Products table (sort + badges).
5. Reveries hero (real product images).
6. Rails (reminders logic; pending stepper).
7. `brand.css` flourishes per theme — layer last, verify contrast on the 4 light themes (willett/weller/makersmark/michters).
