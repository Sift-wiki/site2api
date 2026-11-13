/**
 * A call with no cookies and no session values, over plain HTTP only: whether an operation is public.
 * learnsite.ts's clean replay asks it before an op is shared automatically, and background verification
 * asks it of someone else's candidate, so neither ever sends the user's sessions.
 */
import { type Class, judge } from "./classify.js";
import { DEADLINE, DeadlineExceeded, within } from "./deadline.js";
import { withDefaults } from "./http.js";
import { LookupFailed, sendDerived } from "./lookup.js";
import type { Session } from "./session.js";
import type { Operation } from "./spec.js";

export interface CleanResult {
  class: Class;
  reason: string;
  data?: unknown;
  status?: number;
  ms: number;
}

export async function cleanCall(
  op: Operation,
  args: Record<string, unknown>,
  o: {
    site: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    minIntervalMs?: number;
    /** someone else's op (background verification): only https to public addresses, every redirect hop too (`SendOptions.publicOnly`) */
    publicOnly?: boolean;
  },
): Promise<CleanResult> {
  const t0 = performance.now();
  if (!op.readOnly) return { class: "input", reason: "a write is never replayed", ms: 0 };
  const empty: Session = { cookies: [], values: {} };
  try {
    const r = await sendDerived(op, withDefaults(op, args), empty, {
      site: o.site,
      fetchImpl: o.fetchImpl,
      timeoutMs: o.timeoutMs ?? 20_000,
      minIntervalMs: o.minIntervalMs,
      publicOnly: o.publicOnly,
    });
    let j: ReturnType<typeof judge>;
    try {
      j = within(() => judge(op, r), DEADLINE.read);
    } catch (e) {
      // the same answer takes as long again: error, never a drift
      if (!(e instanceof DeadlineExceeded)) throw e;
      return { class: "error", reason: `the answer was not read: ${e.message}`, status: r.status, ms: r.ms };
    }
    return {
      class: j.class,
      reason: j.reason,
      ...(j.data !== undefined ? { data: j.data } : {}),
      status: r.status,
      ms: r.ms,
    };
  } catch (e) {
    if (e instanceof LookupFailed)
      return {
        class: e.judged.class,
        reason: e.judged.reason,
        status: e.judged.status,
        ms: Math.round(performance.now() - t0),
      };
    return { class: "error", reason: (e as Error).message.split("\n")[0]!, ms: Math.round(performance.now() - t0) };
  }
}
