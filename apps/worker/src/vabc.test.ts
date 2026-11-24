import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type BeaconStore } from "@beacon/db";
import { HttpError } from "@beacon/fetch";
import { VABC_STATE_META_KEY, parseVabcState } from "@beacon/core";
import type { Alert } from "@beacon/shared";
import { maybeCheckVabc, type VabcCheckOverrides } from "./vabc.js";
import type { RunContext } from "./run.js";

let store: BeaconStore;
let sent: Alert[];

beforeEach(async () => {
  store = await openStore({ url: ":memory:" });
  sent = [];
});
afterEach(() => {
  store.close();
});

function ctx(): RunContext {
  return {
    store,
    dryRun: false,
    log: () => {},
    channel: { name: "test", send: async (_site: string, alert: Alert) => void sent.push(alert) },
  };
}

const bottles = (codes: string[]): string =>
  `<h3>Limited Availability Products | One Bottle Per Person</h3>
   <strong>Updated:&nbsp; 11.23.26</strong>
   <ul>${codes.map((c) => `<li><a href="/products/bourbon/b-${c}">Bottle ${c} 750ml</a> | ${c}</li>`).join("")}</ul>`;
const CODES = ["100001", "100002", "100003", "100004", "100005", "100006", "100007", "100008"];
const serve = (html: string): VabcCheckOverrides => ({ fetchImpl: async () => html });
const fail = (err: Error): VabcCheckOverrides => ({
  fetchImpl: async () => {
    throw err;
  },
});
const CF = `<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>`;

async function state() {
  return parseVabcState(await store.meta.get(VABC_STATE_META_KEY));
}
/** Make the next call due immediately. */
async function force() {
  await store.meta.set(VABC_STATE_META_KEY, JSON.stringify({ ...(await state()), forceCheckRequested: true }));
}

describe("maybeCheckVabc", () => {
  it("baselines quietly on the first read, then alerts additions and removals in one embed", async () => {
    let out = await maybeCheckVabc(ctx(), serve(bottles(CODES)));
    expect(out).toMatchObject({ ran: true, added: 0, removed: 0 });
    expect(sent).toHaveLength(0); // baseline never pages Discord
    expect((await state()).items).toHaveLength(8);

    // Not due again for ~a day.
    expect((await maybeCheckVabc(ctx(), serve(bottles(CODES)))).ran).toBe(false);

    await force();
    out = await maybeCheckVabc(ctx(), serve(bottles([...CODES.filter((c) => c !== "100003"), "200001"])));
    expect(out).toMatchObject({ ran: true, added: 1, removed: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("site_changed");
    expect(sent[0]!.product.note).toContain("Bottle 200001 750ml");
    expect(sent[0]!.product.note).toContain("➖ Removed (1)");
    const s = await state();
    expect(s.changes).toHaveLength(1);
    expect(s.changes[0]!.added[0]!.code).toBe("200001");
  });

  it("an unchanged list sends nothing", async () => {
    await maybeCheckVabc(ctx(), serve(bottles(CODES)));
    await force();
    const out = await maybeCheckVabc(ctx(), serve(bottles(CODES)));
    expect(out).toMatchObject({ ran: true, added: 0, removed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("a Cloudflare challenge is a failure, never a 'everything removed' diff — and the baseline survives", async () => {
    await maybeCheckVabc(ctx(), serve(bottles(CODES)));
    await force();
    const out = await maybeCheckVabc(ctx(), serve(CF));
    expect(out.error).toMatch(/Cloudflare/);
    expect(sent).toHaveLength(0);
    const s = await state();
    expect(s.items).toHaveLength(8);
    expect(s.consecutiveFailures).toBe(1);
    // Retry is scheduled in hours, not a day.
    expect(Date.parse(s.nextDueAt!) - Date.now()).toBeLessThan(4 * 3_600_000);
  });

  it("warns once after 3 failures, then posts an all-clear plus the changes on recovery", async () => {
    await maybeCheckVabc(ctx(), serve(bottles(CODES)));
    for (let i = 0; i < 4; i++) {
      await force();
      await maybeCheckVabc(ctx(), fail(new HttpError(403, "https://www.abc.virginia.gov/x")));
    }
    expect(sent.map((a) => a.type)).toEqual(["site_error"]); // once, not per failure
    expect(sent[0]!.product.note).toMatch(/failed 3 times in a row/);

    await force();
    await maybeCheckVabc(ctx(), serve(bottles([...CODES, "300001"])));
    expect(sent.map((a) => a.type)).toEqual(["site_error", "site_recovered", "site_changed"]);
    const s = await state();
    expect(s.errorAlerted).toBe(false);
    expect(s.consecutiveFailures).toBe(0);
  });

  it("a page the parser no longer recognizes is a failure (structure drift), not a diff", async () => {
    await maybeCheckVabc(ctx(), serve(bottles(CODES)));
    await force();
    const out = await maybeCheckVabc(ctx(), serve("<html><h3>Limited Availability</h3><p>redesigned</p></html>"));
    expect(out.error).toMatch(/layout probably changed/);
    expect((await state()).items).toHaveLength(8);
  });

  it("holds a mass shrink until a second read confirms it", async () => {
    const many = Array.from({ length: 30 }, (_, k) => String(400000 + k));
    await maybeCheckVabc(ctx(), serve(bottles(many)));
    const shrunk = bottles(many.slice(0, 8));
    await force();
    let out = await maybeCheckVabc(ctx(), serve(shrunk));
    expect(out.error).toMatch(/holding/);
    expect(sent).toHaveLength(0);
    expect((await state()).items).toHaveLength(30);

    await force();
    out = await maybeCheckVabc(ctx(), serve(shrunk));
    expect(out).toMatchObject({ added: 0, removed: 22 });
    expect(sent).toHaveLength(1);
  });

  it("respects dry-run and the VABC_WATCH=off kill switch", async () => {
    expect((await maybeCheckVabc({ ...ctx(), dryRun: true }, serve(bottles(CODES)))).ran).toBe(false);
    process.env.VABC_WATCH = "off";
    try {
      expect((await maybeCheckVabc(ctx(), serve(bottles(CODES)))).ran).toBe(false);
    } finally {
      delete process.env.VABC_WATCH;
    }
  });
});
