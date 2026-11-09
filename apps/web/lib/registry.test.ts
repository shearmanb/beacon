import { beforeEach, describe, expect, it } from "vitest";
import {
  REGISTRY_HOME,
  _resetRegistryCache,
  buildIndex,
  loadRegistry,
  matchRegistry,
  parseRegistry,
  registryStatus,
  registryUrl,
} from "./registry";

// Lines in the registry's own data.js shape (trimmed fields).
const DATA = `const BARRELS = [
  {id: 1, name: "Sea of Kings", dateDisplay: "February 2025", series: "2415", group: "", nose: "Honey, \\"vanilla\\" cream"},
  {id: 123, name: "EndAlz", series: "N/A", group: "Bourbon BarrALZ / EndAlz", distiller: "MGP"},
  {id: 124, name: "Glaze", series: "N/A", group: "Bourbon BarrALZ / EndAlz"},
  {id: 158, name: "Island in the Sun", series: "27706", group: "Stuff and Whiskey"},
  {id: 163, name: "Cask in Point", series: "", group: "Cask in Point"},
  {id: 172, name: "Wanton Weasel", series: "", group: ""},
  {id: 66, name: "A Show of Hands", series: "", group: ""},
  {id: 67, name: "A Show of Hands", series: "", group: ""},
  {id: 21, name: "Raven III", series: "", group: ""},
];
if (typeof window !== 'undefined') window.BARRELS = BARRELS;
`;

const idx = buildIndex(parseRegistry(DATA));

describe("parseRegistry", () => {
  it("reads id / name / series / group per record line without evaluating the file", () => {
    const e = parseRegistry(DATA);
    expect(e).toHaveLength(9);
    expect(e[0]).toEqual({ id: 1, name: "Sea of Kings", series: "2415", group: "" });
    expect(e[1]!.group).toBe("Bourbon BarrALZ / EndAlz");
  });
});

describe("matchRegistry", () => {
  it("a barrel number equal to one record's series wins", () => {
    expect(matchRegistry('THE REVERIES: 8 Year Single Barrel "Island In The Sun" #27706 Selection', idx)).toBe(158);
  });

  it("an exact quoted name matches, straight or curly quotes, any case", () => {
    expect(matchRegistry('THE REVERIES "Wanton Weasel" 10 Year Single Barrel Rye', idx)).toBe(172);
    expect(matchRegistry("THE REVERIES 10 Year “GLAZE” ENDALZ Single Barrel", idx)).toBe(124);
  });

  it("never links a GROUP name — it spans several barrels", () => {
    expect(matchRegistry('THE REVERIES 8 Year "Cask In Point: Evi-dense"', idx)).toBeNull();
    expect(matchRegistry('THE REVERIES 8 Year "Cask in Point"', idx)).toBeNull();
    // "EndAlz" is both a release and a group name: still refused (the title
    // "Glaze" ENDALZ above resolves through its own quoted name instead).
    expect(matchRegistry('THE REVERIES 8 Year "EndAlz" Selection', idx)).toBeNull();
  });

  it("refuses a name two releases share, a partial name, and an unquoted mention", () => {
    expect(matchRegistry('THE REVERIES "A Show of Hands"', idx)).toBeNull();
    expect(matchRegistry('THE REVERIES "RAVEN" Batch III', idx)).toBeNull();
    expect(matchRegistry("THE REVERIES Wanton Weasel 10 Year", idx)).toBeNull();
  });

  it("a bottle the registry doesn't have yet is null (links to the homepage)", () => {
    expect(matchRegistry('The Reveries: 8 Year "Wake of the Ship" #27440', idx)).toBeNull();
    expect(registryUrl(null)).toBe(REGISTRY_HOME);
    expect(registryUrl(172)).toBe("https://reveriesregistry.com/bottle.html?id=172");
  });
});

describe("loadRegistry (cache + self-healing)", () => {
  beforeEach(() => _resetRegistryCache());
  const ok = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

  it("loads once and serves the index", async () => {
    const got = await loadRegistry(ok(DATA));
    expect(got?.count).toBe(9);
    expect(registryStatus()).toMatchObject({ releases: 9, lastError: null });
  });

  it("a failed first fetch yields null (homepage links) and says why", async () => {
    const fail = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await loadRegistry(fail)).toBeNull();
    expect(registryStatus().lastError).toBe("HTTP 503");
  });
});
