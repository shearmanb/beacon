// vABC limited-availability list watcher — ISOLATED daily side-job (Unicorn
// pattern). Once a day it reads abc.virginia.gov/products/limited-availability,
// diffs the bottle codes against the last good read, and posts ONE Discord
// embed listing additions and removals.
//
// Built so it can't fail silently:
//   • Never runs on a bad read. A Cloudflare challenge, an HTTP error, or a
//     page the parser no longer recognizes is a FAILED check, never a diff. The
//     baseline only moves on a good read, so a blocked day can't report
//     "everything removed" and a recovery can't report "everything added".
//   • A mass shrink (> half the list) is held until the next read agrees.
//   • A failed check retries in ~3 h instead of waiting a day. After 3 failures
//     in a row it sends one Discord warning, then an all-clear when reads work again.
//   • State in one meta blob (vabc_state), included in the off-box backup.
//     Failures never touch site tracking (no site_error, systemic, breakers).
//   • The stamp is written BEFORE the fetch, so a crash-looping worker still
//     tries at most once per interval.

import { HttpError, httpGet } from "@beacon/fetch";
import {
  VABC_CHANGES_CAP,
  VABC_SITE_ID,
  VABC_STATE_META_KEY,
  VABC_URL,
  diffVabc,
  formatVabcChange,
  judgeVabcRead,
  looksLikeBotChallenge,
  parseVabcPage,
  parseVabcState,
  type VabcState,
} from "@beacon/core";
import { jitter, type Alert } from "@beacon/shared";
import type { RunContext } from "./run.js";

const CHECK_INTERVAL_MS = 24 * 3_600_000;
const CHECK_JITTER_MS = 2 * 3_600_000; // 22–26 h: no metronome signature
const RETRY_INTERVAL_MS = 3 * 3_600_000;
const RETRY_JITTER_MS = 30 * 60_000;
const CHECK_BUDGET_MS = 60_000;
const ERROR_ALERT_AFTER = 3; // consecutive failed checks (~9 h of retries)
const CHANNEL_NAME = "vABC Limited List";

export interface VabcCheckOverrides {
  fetchImpl?: (url: string, opts: { signal: AbortSignal }) => Promise<string>;
  budgetMs?: number;
}

export interface VabcCheckOutcome {
  ran: boolean;
  added: number;
  removed: number;
  error?: string;
}

function describeFailure(err: unknown, aborted: boolean): string {
  if (aborted) return `Timed out after ${CHECK_BUDGET_MS / 1000}s`;
  if (err instanceof HttpError && (err.statusCode === 403 || err.statusCode === 503)) {
    return `Blocked by vABC's Cloudflare bot check (HTTP ${err.statusCode}) — this server's requests are being challenged.`;
  }
  return (err as Error).message;
}

async function send(ctx: RunContext, alert: Alert): Promise<void> {
  const log = ctx.log ?? (() => {});
  try {
    await ctx.store.history.append(VABC_SITE_ID, [alert]);
  } catch (err) {
    log(`[vabc] history append failed (continuing): ${(err as Error).message}`);
  }
  if (!ctx.channel || alert.quiet) return;
  try {
    await ctx.channel.send(CHANNEL_NAME, alert);
  } catch (err) {
    log(`[vabc] Discord error (continuing): ${(err as Error).message}`);
  }
}

/** Run at most one check per interval; never throws. */
export async function maybeCheckVabc(ctx: RunContext, over: VabcCheckOverrides = {}): Promise<VabcCheckOutcome> {
  const { store, dryRun, log = () => {} } = ctx;
  const none: VabcCheckOutcome = { ran: false, added: 0, removed: 0 };
  if (dryRun || process.env.VABC_WATCH === "off") return none;

  const state = parseVabcState(await store.meta.get(VABC_STATE_META_KEY));
  const due =
    state.forceCheckRequested || !state.nextDueAt || Date.now() >= Date.parse(state.nextDueAt);
  if (!due) return none;

  // Stamp before fetching. Assume a failure (short retry); success pushes it out a day.
  const now = new Date().toISOString();
  const stamped: VabcState = {
    ...state,
    lastAttemptAt: now,
    nextDueAt: new Date(Date.now() + jitter(RETRY_INTERVAL_MS, RETRY_JITTER_MS)).toISOString(),
    forceCheckRequested: false,
  };
  await store.meta.set(VABC_STATE_META_KEY, JSON.stringify(stamped));

  const controller = new AbortController();
  const budgetMs = over.budgetMs ?? CHECK_BUDGET_MS;
  const budget = setTimeout(() => controller.abort(), budgetMs);
  try {
    const get = over.fetchImpl ?? ((url, opts) => httpGet(url, { kind: "document", signal: opts.signal }));
    const html = await get(VABC_URL, { signal: controller.signal });
    if (looksLikeBotChallenge(html)) {
      throw new Error("Blocked by vABC's Cloudflare bot check (challenge page served) — no list in the response.");
    }
    const page = parseVabcPage(html);
    const verdict = judgeVabcRead(stamped.items, page, stamped.pendingFingerprint);
    if (verdict.kind === "invalid") throw new Error(verdict.reason);
    if (verdict.kind === "hold") {
      // A real read that looks alarming — not a failure, just unconfirmed.
      log(`[vabc] ${verdict.reason}`);
      await store.meta.set(
        VABC_STATE_META_KEY,
        JSON.stringify({ ...stamped, pendingFingerprint: verdict.fingerprint, lastError: verdict.reason }),
      );
      return { ran: true, added: 0, removed: 0, error: verdict.reason };
    }

    const firstRead = stamped.lastSuccessAt === null && stamped.items.length === 0;
    const { added, removed } = firstRead ? { added: [], removed: [] } : diffVabc(stamped.items, page.items);
    const changed = added.length > 0 || removed.length > 0;

    if (stamped.errorAlerted) {
      await send(ctx, {
        type: "site_recovered",
        product: {
          title: CHANNEL_NAME,
          url: VABC_URL,
          note: `The vABC list is readable again after ${stamped.consecutiveFailures} failed check(s)${changed ? " — changes since the last good read follow." : " — no changes since the last good read."}`,
        },
      });
    }
    if (firstRead) {
      // Rule 3: baselines are history-only, never Discord.
      await send(ctx, {
        type: "baseline",
        quiet: true,
        product: {
          title: CHANNEL_NAME,
          url: VABC_URL,
          note: `First read: ${page.items.length} bottles baselined (vABC stamp ${page.updatedLabel ?? "n/a"}). Additions and removals alert from the next read.`,
        },
      });
    } else if (changed) {
      await send(ctx, {
        type: "site_changed",
        product: {
          title: CHANNEL_NAME,
          url: VABC_URL,
          note: formatVabcChange({ added, removed, updatedLabel: page.updatedLabel }),
        },
      });
    }

    const next: VabcState = {
      ...stamped,
      nextDueAt: new Date(Date.now() + jitter(CHECK_INTERVAL_MS, CHECK_JITTER_MS)).toISOString(),
      lastSuccessAt: now,
      lastError: null,
      consecutiveFailures: 0,
      errorAlerted: false,
      pendingFingerprint: null,
      items: page.items,
      updatedLabel: page.updatedLabel,
      changes: changed
        ? [{ at: now, added, removed, updatedLabel: page.updatedLabel }, ...stamped.changes].slice(0, VABC_CHANGES_CAP)
        : stamped.changes,
    };
    await store.meta.set(VABC_STATE_META_KEY, JSON.stringify(next));
    log(
      `[vabc] Check done: ${page.items.length} bottles` +
        (firstRead ? " (baselined)" : `, +${added.length} / -${removed.length}`) +
        ` (stamp ${page.updatedLabel ?? "n/a"}).`,
    );
    return { ran: true, added: added.length, removed: removed.length };
  } catch (err) {
    const msg = describeFailure(err, controller.signal.aborted);
    const failures = stamped.consecutiveFailures + 1;
    let errorAlerted = stamped.errorAlerted;
    log(`[vabc] Check failed (${failures} in a row): ${msg}`);
    if (failures >= ERROR_ALERT_AFTER && !errorAlerted) {
      errorAlerted = true;
      const since = stamped.lastSuccessAt ? `last good read ${stamped.lastSuccessAt.slice(0, 10)}` : "it has never read the list successfully";
      await send(ctx, {
        type: "site_error",
        product: {
          title: `${CHANNEL_NAME} watcher`,
          url: VABC_URL,
          note:
            `The vABC list check has failed ${failures} times in a row (${since}). Latest: ${msg}\n` +
            `Additions/removals are NOT being tracked until this clears. It keeps retrying every ~3 h ` +
            `and will post an all-clear. Site tracking is unaffected. Status on /vabc.`,
        },
      });
    }
    try {
      await store.meta.set(
        VABC_STATE_META_KEY,
        JSON.stringify({ ...stamped, lastError: msg, consecutiveFailures: failures, errorAlerted }),
      );
    } catch (e) {
      log(`[vabc] state save failed after error (continuing): ${(e as Error).message}`);
    }
    return { ran: true, added: 0, removed: 0, error: msg };
  } finally {
    clearTimeout(budget);
  }
}
