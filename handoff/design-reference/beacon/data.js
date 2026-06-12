// Beacon mock data — drawn from the real app's screenshots
window.BEACON_DATA = {
  sites: [
    { id: "sp-t8ke", revStock: 0, name: "SharedPour T8KE", health: "ok", lastChecked: "6:39 PM", nextIn: 9, products: 34, inStock: 34, schedule: "Working Hours Heavy", scheduleDetail: "5m 9–6 · 20m 6–10 · 120m 10–9", monitoring: true, imminent: false, autoOff: 20, lastChange: "2h ago", interval: "20m", checks: [55, 35, 15], found: [], fails: [] },
    { id: "sp-rev", revStock: 0, name: "SharedPour The Reveries", health: "ok", lastChecked: "6:40 PM", nextIn: 10, products: 0, inStock: 0, schedule: "Working Hours Heavy", scheduleDetail: "5m 9–6 · 20m 6–10 · 120m 10–9", monitoring: true, imminent: false, autoOff: 20, lastChange: "3d ago", interval: "20m", checks: [56, 36, 16], found: [], fails: [] },
    { id: "fountain", revStock: 1, name: "Fountain Inn DC", health: "ok", lastChecked: "6:40 PM", nextIn: 10, products: 3, inStock: 1, schedule: "Working Hours Heavy", scheduleDetail: "5m 9–6 · 20m 6–10 · 120m 10–9", monitoring: true, imminent: false, autoOff: 20, lastChange: "41m ago", interval: "20m", checks: [61, 41, 21, 1], found: [41], fails: [] },
    { id: "concierge", revStock: 0, name: "Bourbon Concierge", health: "ok", lastChecked: "6:40 PM", nextIn: 10, products: 9, inStock: 0, schedule: "Working Hours Heavy", scheduleDetail: "5m 9–6 · 20m 6–10 · 120m 10–9", monitoring: true, imminent: false, autoOff: 20, lastChange: "1d ago", interval: "20m", checks: [50, 30, 10], found: [], fails: [] },
    { id: "rev-status", revStock: 0, name: "The Reveries Site Status", health: "warn", lastChecked: "6:31 PM", nextIn: 0, products: 0, inStock: 0, schedule: "15 min", scheduleDetail: "every 15 min, flat", monitoring: true, imminent: false, autoOff: 20, lastChange: "—", interval: "15m", checks: [55, 40, 25, 10], found: [], fails: [10] },
    { id: "rev-shop", revStock: 0, name: "The Reveries Official Shop", health: "ok", lastChecked: "6:36 PM", nextIn: 1, products: 3, inStock: 0, schedule: "15 min", scheduleDetail: "every 15 min, flat", monitoring: true, imminent: true, autoOff: 20, lastChange: "6h ago", interval: "15m", checks: [59, 44, 29, 14], found: [], fails: [] }
  ],
  scheduleOptions: ["Working Hours Heavy", "15 min", "30 min", "Hourly", "Overnight Light"],
  reveries: [
    { name: "The Reveries: 8 Year Single Barrel — The Fountain Inn", site: "Fountain Inn DC", price: 80, stock: true },
    { name: "Reveries: The Raven — Batch V", site: "Fountain Inn DC", price: 170, stock: false },
    { name: "10 Year Single Barrel \u201CArrivals\u201D T8ke Reserve Cask", site: "Reveries Official Shop", price: 119.99, stock: false },
    { name: "7 Year #27454 \u201CGAMBIT\u201D T8KE Select", site: "Reveries Official Shop", price: 79.99, stock: false },
    { name: "\u201CRAVEN\u201D Rare Release Batch V (2026)", site: "Bourbon Concierge", price: 159.99, stock: false },
    { name: "\u201C007\u201D 7 Year Single Barrel Barrel Strength", site: "Bourbon Concierge", price: 79.99, stock: false },
    { name: "16 Year \u201CBourbon Concierge\u201D Single Barrel — 126.2pf", site: "Bourbon Concierge", price: 329, stock: false },
    { name: "\u201CEnclave\u201D 17 Year Single Barrel Barrel Strength", site: "Bourbon Concierge", price: 399.99, stock: false },
    { name: "\u201CThe Bones\u201D 15 Year Single Barrel", site: "Bourbon Concierge", price: 329.99, stock: false },
    { name: "\u201CTime Rots\u201D 15 Year Single Barrel", site: "Bourbon Concierge", price: 329.99, stock: false },
    { name: "17 Year \u201CFaden's Finest\u201D — 129.7pf", site: "Bourbon Concierge", price: 399, stock: false },
    { name: "THE DEEP — French Oak Finish (Tide #1)", site: "Bourbon Concierge", price: 129.99, stock: false },
    { name: "Behemoth 14 Year Single Barrel (#25711)", site: "Bourbon Concierge", price: 289, stock: false }
  ],
  products: [
    { name: "Peerless Single Barrel Barrel Strength Rye T8KE r/Bourbon Private Select (2026)", site: "SharedPour T8KE", price: 119.99, stock: true, rev: false, isNew: true },
    { name: "T8KE x Hazelbaker 7 Year Double Oaked Bottled In Bond Exclusive Batch", site: "SharedPour T8KE", price: 69.99, stock: true, rev: false },
    { name: "Blackwood Bourbon Single Barrel Barrel Proof T8KE Select", site: "SharedPour T8KE", price: 179.99, stock: true, rev: false },
    { name: "Peerless Single Barrel Barrel Strength Bourbon T8KE Private Select #190809107", site: "SharedPour T8KE", price: 119.99, stock: true, rev: false },
    { name: "WhistlePig Piggyback Rye Single Barrel 38792 Cask Strength", site: "SharedPour T8KE", price: 62.99, stock: true, rev: false, delta: -7 },
    { name: "Reveries: The Raven — Batch V", site: "Fountain Inn DC", price: 170, stock: false, rev: true },
    { name: "The Reveries: 8 Year Single Barrel — The Fountain Inn", site: "Fountain Inn DC", price: 80, stock: true, rev: true, isNew: true },
    { name: "Reveries \u201CTHE DEEP\u201D", site: "Fountain Inn DC", price: 129, stock: false, rev: true },
    { name: "10 Year Single Barrel \u201CArrivals\u201D T8ke Reserve Cask", site: "Reveries Official Shop", price: 119.99, stock: false, rev: true },
    { name: "\u201CEnclave\u201D 17 Year Single Barrel Barrel Strength", site: "Bourbon Concierge", price: 399.99, stock: false, rev: true },
    { name: "Old Carter Batch 12 Straight Bourbon", site: "Bourbon Concierge", price: 249.99, stock: false, rev: false },
    { name: "Found North Batch 11 Cask Strength", site: "SharedPour T8KE", price: 224.99, stock: true, rev: false, delta: 15 }
  ],
  reminders: [
    { date: "JUN 14", d: 3, label: "Raven Batch VI drop — Official Shop", priority: true, done: false, link: { site: "rev-shop", name: "Official Shop" } },
    { date: "JUN 18", d: 7, label: "Fountain Inn allocation list opens", priority: false, done: false, link: { site: "fountain", name: "Fountain Inn DC" } },
    { date: "JUL 02", d: 21, label: "Enclave 18yr pre-sale (rumored)", priority: false, done: false },
    { date: "JUN 12", d: 1, label: "SharedPour lottery entry closes", priority: false, done: false },
    { date: "JUN 05", d: -6, label: "Lottery Bottle", priority: false, done: true }
  ],
  pending: [
    { name: "The Reveries: 8 Year SiB — Fountain Inn", retailer: "Fountain Inn DC", cost: 80, ordered: "JUN 11", eta: "ships ~JUN 16", status: "ordered" },
    { name: "T8KE x Hazelbaker 7yr BiB", retailer: "SharedPour", cost: 69.99, ordered: "JUN 08", eta: "label created", status: "shipped" }
  ],
  collection: [
    { name: "Reveries: The Raven — Batch IV", proof: "118.4", acquired: "2025", paid: 165 },
    { name: "Reveries \u201CTime Rots\u201D 15 Year", proof: "127.7", acquired: "2025", paid: 329.99 },
    { name: "T8KE Peerless Rye Private Select", proof: "108.6", acquired: "2026", paid: 119.99 },
    { name: "Found North Batch 9", proof: "117.8", acquired: "2024", paid: 209.99 },
    { name: "Old Carter Batch 11", proof: "116.05", acquired: "2024", paid: 239.99 },
    { name: "Reveries \u201CGAMBIT\u201D 7 Year", proof: "121.3", acquired: "2026", paid: 79.99 }
  ]
};
