/**
 * A time limit on synchronous work: reading a site's answer with a spec's regexes and selectors, and
 * testing a call's args against a spec's patterns. A backtracking regex or a slow selector holds the
 * one thread, so no timer fires while it runs; Node's vm timeout ends it from outside. Node only.
 */
import { createContext, Script } from "node:vm";

/**
 * The limits, in ms; a test shortens them.
 * `read`: one answer, classified and extracted. Measured over the bundled html recipes, on a page
 * that is not of the recipe's own shape: under 1 s for 1.2 MiB of 40,000 elements, under 4 s for 6 MiB
 * at the element budget. On a page of its own shape the slowest are Wikiquote's (a `~` inside `:not()`:
 * 1.8 s on 3,600 quote lists) and Hacker News's (a sibling search per item: 0.3 s on 200 stories, where
 * a page has 30). A page built to be slow, or a spec's regex or selector that is, takes minutes with no limit.
 * `args`: one request built from a call's args, each tested against its param's pattern: half a
 * millisecond at most over the bundled specs. The same test runs again wherever the request is
 * rebuilt, so its limit is small.
 */
export const DEADLINE = { read: 5000, args: 500 };

/** Work that ran past its limit and was stopped. The same work takes as long again: no retry, tier or heal helps. */
export class DeadlineExceeded extends Error {}

const sandbox: { work?: () => unknown } = {};
const context = createContext(sandbox);
const script = new Script("work()");

/**
 * `work()`, stopped with `DeadlineExceeded` when it runs past `ms`. What it throws passes through as
 * it is. A stop skips the `finally` blocks of the work it ends, so only work that leaves nothing half
 * done belongs here; the work may itself call `within`.
 */
export function within<T>(work: () => T, ms: number): T {
  const outer = sandbox.work;
  sandbox.work = work;
  try {
    return script.runInContext(context, { timeout: ms, displayErrors: false }) as T;
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT")
      throw new DeadlineExceeded(`it took over ${ms} ms and was stopped`);
    throw e;
  } finally {
    sandbox.work = outer;
  }
}
