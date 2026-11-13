/**
 * What a call tells the registry (docs/REGISTRY.md "Maintenance by the crowd"), and the work it starts
 * there: a report of how a registry version did, a healed version shared back, a bundled site upgraded.
 * All of it only when settings allow sharing, in the background, and dropped on any error: never a
 * reason for a call to wait or fail. The CLI settles it before exit; the MCP server flushes every few seconds.
 */
import type { CallResult } from "./execute.js";
import { loadSettings } from "./identity.js";
import { registryRequest, upgradeBundled } from "./registry.js";
import type { Outcome, Report } from "./registry-api.js";
import type { Operation } from "./spec.js";

const queue: Report[] = [];
const MAX_QUEUE = 1000;
const BATCH = 50;
const pending = new Set<Promise<unknown>>();
/** aborted when the process stops waiting for background work, so no fetch holds it open */
let stopper = new AbortController();

/** A call's class as a report's outcome; a call refused before anything was sent reports nothing. */
export function outcomeOf(c: CallResult["class"]): Outcome | undefined {
  if (c === "ok") return "ok";
  if (c === "drift" || c === "error") return "fail";
  if (c === "auth" || c === "blocked" || c === "rate" || c === "input") return c;
  return undefined;
}

export function queueReport(r: Report): void {
  if (queue.length < MAX_QUEUE) queue.push(r);
}

/** Run `task` in the background: a failure is dropped, and `settle` waits for it. */
export function background(task: (signal: AbortSignal) => Promise<unknown>): void {
  const signal = stopper.signal;
  const p: Promise<unknown> = Promise.resolve()
    .then(() => task(signal))
    .catch(() => undefined)
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Send what is queued, signed, in batches; with sharing off it is dropped unsent. */
export async function flushReports(signal = stopper.signal): Promise<void> {
  const all = queue.splice(0);
  if (!all.length || !loadSettings().share) return;
  for (let i = 0; i < all.length; i += BATCH)
    await registryRequest("/v1/reports", {
      method: "POST",
      body: { reports: all.slice(i, i + BATCH) },
      signed: true,
      timeoutMs: 10_000,
      signal,
    }).catch(() => undefined);
}

/** Wait for the background work, then flush, for at most `ms`; what is left then is stopped. */
export async function settle(ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let finished = false;
  const done = (async () => {
    while (pending.size) await Promise.all(pending);
    await flushReports();
  })().finally(() => {
    finished = true;
  });
  await Promise.race([done, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
  // a flush in flight has already emptied the queue, and is no pending task: stop it too
  if (!finished) {
    stopper.abort();
    stopper = new AbortController();
    queue.length = 0;
  }
}

/** How long `shutdown` gives background work (a bundled site's upgrade, queued reports) before stopping it. */
export const SHUTDOWN_MS = 2_000;

/**
 * Let a library caller's process exit: background registry work gets up to `SHUTDOWN_MS` to finish
 * and flush queued reports, then whatever is still in flight is aborted, and the browser is closed.
 */
export async function shutdown(): Promise<void> {
  try {
    await settle(SHUTDOWN_MS);
  } finally {
    const { closeBrowser } = await import("./browser.js");
    await closeBrowser();
  }
}

/**
 * After a call of `op` (its spec as the call found it). A healed op is reported as a failure of the
 * version it was, whose stored request drifted, and its repair is shared back (share.ts healBack).
 * `args`: the call's own, which a heal learned from and its heal-back must not share a copy of.
 */
export function afterCall(
  site: string,
  op: Operation,
  source: "user" | "registry" | "bundled",
  r: CallResult,
  o: { fetchImpl?: typeof fetch; minIntervalMs?: number; args?: Record<string, unknown> } = {},
): void {
  try {
    if (!loadSettings().share) return;
    const version = op.version;
    if (version) {
      const outcome = r.healed ? "fail" : outcomeOf(r.class);
      if (outcome) queueReport({ hash: version.hash, outcome, ...(r.tier ? { tier: r.tier } : {}), ms: r.ms });
      if (r.healed)
        background(async (signal) => {
          const { healBack } = await import("./share.js");
          await healBack(site, op.name, version.hash, {
            ...o,
            fetchImpl: withSignal(o.fetchImpl ?? fetch, signal),
            signal,
          });
        });
    } else if (source === "bundled" && outcomeOf(r.class)) background((signal) => upgradeBundled(site, { signal }));
  } catch {
    // ponytail: a report lost to an unreadable settings file is a report lost, never the call's answer
  }
}

/** `f`, stopped with `signal` too. */
export const withSignal =
  (f: typeof fetch, signal: AbortSignal): typeof fetch =>
  (input, init) =>
    f(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
