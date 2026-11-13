/**
 * Derived slots (DESIGN.md "Request template"): the lookup a call sends before the op's own request
 * at tiers 1 and 2, whose JSON answer holds the value (a slug's numeric id).
 */
import { BudgetSpent } from "./budget.js";
import { type Class, judge, type Observed } from "./classify.js";
import { asText, setAt, walk } from "./codec.js";
import { DEADLINE, DeadlineExceeded, within } from "./deadline.js";
import { AddressRefused, ReadWrites, RedirectRefused, type SendOptions, type Sent, send } from "./http.js";
import type { Session } from "./session.js";
import type { Lookup, Operation } from "./spec.js";
import { DERIVED_VALUE, graphqlDocuments, writesGraphql } from "./vet.js";

/** What a lookup that did not answer with its value said; the op's own request was never sent. */
export interface LookupJudged {
  class: Class;
  reason: string;
  status?: number;
  missing?: boolean;
  server?: boolean;
  retryAfterMs?: number;
}

/** A lookup that did not answer with its value: nothing of the op's own request was sent. */
export class LookupFailed extends Error {
  constructor(
    readonly judged: LookupJudged,
    cause?: unknown,
  ) {
    super(judged.reason, cause === undefined ? undefined : { cause });
  }
}

/** A lookup as the read it is sent as: the op's params, so its args are checked alike, and nothing else of the op. */
export function lookupOp(op: Operation, from: Lookup, path?: string): Operation {
  return {
    name: `${op.name}.lookup`,
    request: from.request,
    slots: from.slots,
    volatile: [],
    trigger: op.trigger,
    match: {},
    response: { format: "json", ...(path ? { extract: path } : {}) },
    params: op.params,
    readOnly: true,
    minTier: 1,
    learnedLoggedIn: op.learnedLoggedIn,
  };
}

/** The lookups an op sends, one per distinct request. */
export const lookupsOf = (op: Pick<Operation, "slots">): Lookup[] => [
  ...new Map(op.slots.flatMap((s) => (s.from ? [[JSON.stringify(s.from), s.from] as const] : []))).values(),
];

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/**
 * The op with each derived leaf set from its lookup's answer and its derived slots gone, so the rest
 * of the send treats it as any op; the op itself when it has none. `fetchOne` sends a lookup at the
 * call's tier. Throws `LookupFailed`, or `AddressRefused` and `ReadWrites` as the op's own send would.
 */
export async function derive(op: Operation, fetchOne: (lookup: Operation) => Promise<Observed>): Promise<Operation> {
  if (!op.slots.some((s) => s.from)) return op;
  const answers = new Map<string, Observed>();
  const types = new Map(walk(op.request).map((l) => [JSON.stringify(l.at), l.type]));
  let request = op.request;
  for (const slot of op.slots) {
    if (!slot.from || !slot.path) continue;
    const k = JSON.stringify(slot.from);
    const l = lookupOp(op, slot.from, slot.path);
    const where = `the lookup ${l.request.method} ${pathOf(l.request.url)} for ${slot.at.join(" > ")}`;
    let r = answers.get(k);
    if (!r) {
      try {
        r = await fetchOne(l);
      } catch (e) {
        if (e instanceof AddressRefused || e instanceof BudgetSpent || e instanceof ReadWrites) throw e;
        const reason = `${where}: ${(e as Error).message.split("\n")[0]}`;
        throw new LookupFailed(
          { class: "error", reason, ...(e instanceof RedirectRefused ? {} : { server: true }) },
          e,
        );
      }
      answers.set(k, r);
    }
    let j: ReturnType<typeof judge>;
    try {
      j = within(() => judge(l, r), DEADLINE.read);
    } catch (e) {
      if (!(e instanceof DeadlineExceeded)) throw e;
      throw new LookupFailed({ class: "error", reason: `${where}: the answer was not read: ${e.message}` }, e);
    }
    const v = j.data;
    if (j.class === "ok" && (v === undefined || v === null || v === "" || typeof v === "object"))
      throw new LookupFailed({ class: "drift", missing: true, reason: `${where}: no value at ${slot.path}` });
    if (j.class !== "ok")
      throw new LookupFailed({
        class: j.class,
        reason: `${where}: ${j.reason}`,
        status: r.status,
        ...(j.missing ? { missing: true } : {}),
        ...(j.server ? { server: true } : {}),
        ...(j.retryAfterMs !== undefined ? { retryAfterMs: j.retryAfterMs } : {}),
      });
    if (!DERIVED_VALUE.test(asText(v)))
      throw new LookupFailed({ class: "error", reason: `${where}: the value at ${slot.path} is not an identifier` });
    const type = slot.at.at(-1)!.startsWith("json:") ? types.get(JSON.stringify(slot.at)) : "string";
    // a JSON leaf keeps its type: an id past 2^53 comes back as its digits, and goes out as a number again
    const value =
      type === "string" ? asText(v) : type === "number" && typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : v;
    request = setAt(request, slot.at, value);
  }
  // the spec's rules see only the static document; a looked-up value must not turn a read into a mutation
  if (op.readOnly && graphqlDocuments(request).some(writesGraphql))
    throw new LookupFailed({ class: "error", reason: `a looked-up value made ${op.name} a GraphQL mutation` });
  return { ...op, request, slots: op.slots.filter((s) => !s.from) };
}

/** `send`, each lookup first: sent by `send` too, with the same session and options. */
export async function sendDerived(
  op: Operation,
  args: Record<string, unknown>,
  session: Session,
  opts: SendOptions,
): Promise<Sent> {
  const filled = await derive(op, (l) => send(l, args, session, opts));
  return send(filled, args, session, opts);
}
