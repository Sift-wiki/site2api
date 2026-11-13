/**
 * Proof that an operation works: `verify` calls each read with its stored example and its checks,
 * judges every answer pass, fail or inconclusive, and keeps the outcomes per op, which `publish`
 * reads to refuse a spec whose checks fail. A write is never sent: its preflight says whether a
 * call could send it now.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { asText, templateRefs } from "./codec.js";
import { DEADLINE, DeadlineExceeded, within } from "./deadline.js";
import { type CallOptions, type CallResult, call } from "./execute.js";
import { buildRequest } from "./http.js";
import type { Evidence } from "./registry-api.js";
import { cookieValue, home, loadSession, loggedIn, readJson, type Session, safeName, writePrivate } from "./session.js";
import { type Check, type Operation, OperationSchema, type Site } from "./spec.js";
import { loadSite, loadWrites, unconfirmedWrite, updateSite } from "./store.js";

export type Outcome = "pass" | "fail" | "inconclusive";

export interface CaseResult {
  op: string;
  /** "example", or "check <n>" (1-based, in the op's `checks`) */
  case: string;
  expect: Check["expect"];
  outcome: Outcome;
  /** what the answer was: result, empty, input, or the class of a failure */
  got: string;
  args?: Check["args"];
  purpose?: string;
  tier?: number;
  healed?: boolean;
  reason?: string;
  next?: string;
  ms?: number;
  /** when this case began answering this outcome: carried from run to run while it stays the same */
  since?: string;
}

interface OpRecord {
  /** of the op as it was when its cases ran; a changed op has no record */
  hash: string;
  at: string;
  results: CaseResult[];
  /** what learn_site proved with these cases (its holdout and clean replay), for a later publish to send */
  evidence?: Proof;
}

/** The evidence a run proved, kept for an upload made later; the client version is the uploader's own. */
export type Proof = Omit<Partial<Evidence>, "clientVersion" | "healedFrom">;

const recordFile = (site: string) => join(home(), "checks", `${safeName(site)}.json`);

export const loadRecord = (site: string): Record<string, OpRecord> =>
  readJson<Record<string, OpRecord>>(recordFile(site), {});

/**
 * The op's identity for its record: everything but when it was learned, the mark a verify clears and
 * its registry version. In schema order, as an op read from disk is: a heal's candidate is built in
 * another, and is the same op once saved.
 */
export function opHash(op: Operation): string {
  const { learnedAt: _at, unproven: _u, version: _v, ...rest } = OperationSchema.parse(op);
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

const isEmpty = (d: unknown) =>
  d === undefined ||
  d === null ||
  d === "" ||
  (Array.isArray(d) && !d.length) ||
  (typeof d === "object" && !Array.isArray(d) && !Object.keys(d as object).length);

/**
 * A challenge, a sign-in page, a rate limit or a server that failed or could not be reached says
 * nothing about the op: inconclusive, counted neither way.
 */
export function judgeCase(expect: Check["expect"], r: CallResult): { outcome: Outcome; got: string } {
  const got = r.ok ? (isEmpty(r.data) ? "empty" : "result") : r.class === "input" ? "input" : r.class;
  if (!r.ok && (r.class === "blocked" || r.class === "auth" || r.class === "rate" || r.server))
    return { outcome: "inconclusive", got };
  return { outcome: got === expect ? "pass" : "fail", got };
}

/** The op's stored example args, defaults filled; undefined when a required param has neither. */
function exampleArgs(op: Operation): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const p of op.params) {
    const v = p.example ?? p.default;
    if (v !== undefined) out[p.name] = v;
    else if (p.required) return undefined;
  }
  return out;
}

/**
 * Two passing cases that answered differently while their args differ in `params` and in nothing
 * else: what changed the answer was one of those params.
 */
function answersDiffer(op: Operation, params: string[], answers: { args: Record<string, unknown>; data: string }[]) {
  const value = (a: Record<string, unknown>, p: Operation["params"][number]) => asText(a[p.name] ?? p.default ?? "");
  return answers.some((a, i) =>
    answers.slice(i + 1).some((b) => {
      if (a.data === b.data) return false;
      const changed = op.params.filter((p) => value(a.args, p) !== value(b.args, p)).map((p) => p.name);
      return changed.length > 0 && changed.every((n) => params.includes(n));
    }),
  );
}

/**
 * Whether page 2 holds rows and every one was on page 1, as when the server ignored the cursor or
 * page number and answered page 1 again. A page 2 with one new row moves on (Pomerado's rule).
 */
function repeats(first: unknown, second: unknown): boolean {
  const rows = (d: unknown) => (Array.isArray(d) ? d : [d]).map((x) => JSON.stringify(x));
  const seen = new Set(rows(first));
  return rows(second).every((r) => seen.has(r));
}

/** A paged read's page after its example's: it must answer, and not with page 1 again. */
async function nextPageCase(
  op: Operation,
  args: Record<string, unknown>,
  first: CallResult,
  send: (args: Record<string, unknown>) => Promise<CallResult>,
): Promise<CaseResult> {
  const p = op.paging!;
  const base = { op: op.name, case: "next page", expect: "result" as const };
  const number = Number(asText(args[p.param] ?? ""));
  const next = p.next
    ? first.nextPage
    : args[p.param] !== undefined && Number.isInteger(number)
      ? number + 1
      : undefined;
  if (!first.ok || isEmpty(first.data) || next === undefined)
    return {
      ...base,
      outcome: "inconclusive",
      got: "no next page",
      reason: !first.ok
        ? "the example did not answer, so there is no page 1 to go on from"
        : isEmpty(first.data)
          ? "page 1 is empty"
          : p.next
            ? `page 1 answered no next page at ${p.next}: give ${op.name} an example with more than one page, or fix paging.next`
            : `the example sets no page number in ${p.param} to add one to`,
    };
  const r = await send({ ...args, [p.param]: next });
  const j = judgeCase("result", r);
  const one: CaseResult = {
    ...base,
    ...j,
    ...(r.tier ? { tier: r.tier } : {}),
    ...(r.healed ? { healed: true } : {}),
    ms: r.ms,
  };
  // a cursor to an empty page is how some lists end: it shows nothing about the param
  if (j.got === "empty") return { ...one, outcome: "inconclusive", reason: "the next page is empty" };
  if (j.outcome !== "pass") return { ...one, reason: r.reason ?? `answered ${j.got}`, next: r.next };
  if (repeats(first.data, r.data))
    return {
      ...one,
      outcome: "fail",
      got: "page 1 again",
      reason: `${p.param}=${asText(next)} answered page 1's items again: the server does not read ${p.param} where the request puts it`,
    };
  return one;
}

/** How a readback's read did in the same run; "not run" when the readback carries its own read, which verify does not call. */
export type ReadbackOutcome = Outcome | "skipped" | "not run";

/** What a call of a write would meet before its send, with nothing sent. */
export interface Preflight {
  /** the request template fills from the op's example args and the session's values */
  builds: boolean;
  /** why it does not build, or what a call would need first */
  reason?: string;
  next?: string;
  learnedLoggedIn: boolean;
  /** whether the jar holds a live login cookie now, as a call checks before sending a write learned signed in */
  loggedIn: boolean;
  /** the read that proves the write landed, and how its own cases did in this run */
  readback?: { op: string; outcome: ReadbackOutcome };
  /** this op's writes in the ledger that were sent and nothing confirmed landed (accepted, may_have_applied, sending) */
  unconfirmed: number;
  /** every part a send needs is in place and the readback's cases pass */
  ok: boolean;
}

export interface Verified {
  results: (CaseResult | { op: string; skipped: string } | { op: string; preflight: Preflight })[];
  /** ops whose `unproven` mark this run cleared: their cases answered differently for different args */
  proven: string[];
  /** ops whose record now has a failing case, and had none before this run (or no record) */
  newlyFailing: string[];
  /** ops whose record had a failing case before this run, and now has a record with none */
  recovered: string[];
  /** per op with a failing case: when its earliest failing case began failing */
  failingSince: Record<string, string>;
}

/**
 * One run of an op's cases. `plan`: the hash of the op the cases were chosen from. `from`: per call,
 * the hash of the op its answer came from, as the call last reported it; none for a call that sent
 * nothing because the site cools down.
 */
type Ran = { results: CaseResult[]; plan: string; from: (string | undefined)[]; proven: boolean };
type Run = Ran | { skipped: string };

async function runCases(name: string, op: Operation, opts: CallOptions): Promise<Run> {
  const example = exampleArgs(op);
  const cases: [string, Record<string, unknown>, Check["expect"], Check?][] = [
    ...(example ? [["example", example, "result"] as [string, Record<string, unknown>, Check["expect"]]] : []),
    ...(op.checks ?? []).map((c, i): [string, Record<string, unknown>, Check["expect"], Check] => [
      `check ${i + 1}`,
      c.args,
      c.expect,
      c,
    ]),
  ];
  if (!cases.length) {
    const missing = op.params.filter((p) => p.required && p.example === undefined && p.default === undefined);
    return { skipped: `no example for ${missing.map((p) => p.name).join(", ")}, and no checks` };
  }
  const answers: { args: Record<string, unknown>; data: string }[] = [];
  const results: CaseResult[] = [];
  const from: (string | undefined)[] = [];
  const send = async (args: Record<string, unknown>) => {
    let last: string | undefined;
    const r = await call(name, op.name, args, {
      ...opts,
      onAnswered: (o) => {
        last = opHash(o);
      },
    });
    from.push(r.cooling ? undefined : last);
    return r;
  };
  for (const [label, args, expect, check] of cases) {
    const r = await send(args);
    const j = judgeCase(expect, r);
    if (j.outcome === "pass" && (j.got === "result" || j.got === "empty"))
      answers.push({ args, data: JSON.stringify(r.data ?? null) });
    // A no-results page with no list to find empty (a message where the list was) reads as a selector
    // that matched nothing: the recipe can name the message.
    const unnamed =
      expect === "empty" &&
      j.outcome === "fail" &&
      (j.got === "input" || j.got === "drift") &&
      op.response.html &&
      !op.response.html.empty
        ? `; if the page says there are no results in an element of its own, add ${op.name} again with the same --html recipe plus "empty": "<css of that element>"`
        : "";
    results.push({
      op: op.name,
      case: label,
      expect,
      ...j,
      ...(check ? { args: check.args, ...(check.purpose ? { purpose: check.purpose } : {}) } : {}),
      ...(r.tier ? { tier: r.tier } : {}),
      ...(r.healed ? { healed: true } : {}),
      ...(j.outcome !== "pass"
        ? { reason: `${r.reason ?? `answered ${j.got}, expected ${expect}`}${unnamed}`, next: r.next }
        : {}),
      ms: r.ms,
    });
    if (op.paging && label === "example") results.push(await nextPageCase(op, args, r, send));
  }
  return { results, plan: opHash(op), from, proven: !!op.unproven && answersDiffer(op, op.unproven.params, answers) };
}

/**
 * Whether `run`'s cases were chosen from `op` as it is saved now, and every one that was sent answered
 * from it. A case the cool-down refused is no version, so it mixes nothing.
 */
const clean = (op: Operation, run: Run): run is Ran =>
  "from" in run && run.plan === opHash(op) && run.from.every((h) => h === undefined || h === opHash(op));

/** Whether any of `run`'s cases was sent: one the cool-down refused was not. */
const sent = (run: Run | undefined): run is Ran => !!run && "from" in run && run.from.some((h) => h !== undefined);

/** Each case's `since`: the record's, while its case of the same label answered the same outcome; else now. */
function dated(prev: OpRecord | undefined, results: CaseResult[], at: string): CaseResult[] {
  return results.map((r) => {
    const was = prev?.results.find((p) => p.case === r.case);
    return { ...r, since: was && was.outcome === r.outcome ? (was.since ?? prev!.at) : at };
  });
}

const failing = (rec: OpRecord | undefined) => !!rec?.results.some((r) => r.outcome === "fail");

const sessionOrNone = (site: string): Session | undefined => {
  try {
    return loadSession(site);
  } catch {
    return undefined;
  }
};

/**
 * A read learned signed in, with no login on record for the site (no login saved a source, and the
 * jar holds no live login cookie): a call would answer auth without a re-import to fall back on.
 */
const needsLogin = (site: Site, op: Operation, s: Session | undefined) =>
  op.learnedLoggedIn && !!s && !s.source && !loggedIn(s.cookies, site.loginCookies, s.guestCookies);

/**
 * What a call of the write would meet before its send: whether its template fills from its example
 * args and the session (a `session:` value a trigger run has not captured, a cookie no login put in
 * the jar), the login state a signed-in write is refused without, and how its readback's own cases
 * did. Nothing is sent, and the built request is not kept: it holds the session's values.
 */
function preflight(site: Site, op: Operation, s: Session | undefined, readback: Preflight["readback"]): Preflight {
  const session = s ?? { cookies: [], values: {} };
  const problems: string[] = [];
  const nexts: string[] = [];
  const refs = new Set(
    op.slots.flatMap((sl) => [
      ...(sl.ref ? [sl.ref] : []),
      ...(sl.template !== undefined ? templateRefs(sl.template) : []),
    ]),
  );
  const host = new URL(op.request.url).hostname.toLowerCase();
  for (const ref of refs) {
    const key = ref.slice(ref.indexOf(":") + 1);
    if (ref.startsWith("cookie:")) {
      if (cookieValue(session.cookies, key, op.request.url) === undefined) {
        problems.push(`cookie ${key} is not in the jar`);
        nexts.push(`api-anything login ${site.name}`);
      }
    } else {
      const bound = session.valueHosts?.[key];
      if (session.values[key] === undefined || (bound !== undefined && bound !== host)) {
        problems.push(`session value ${key} has not been captured`);
        nexts.push(`needs a trigger run: a tier-3 call of a read on ${site.name} captures it`);
      }
    }
  }
  const example = exampleArgs(op);
  let builds = false;
  if (!example) {
    const missing = op.params.filter((p) => p.required && p.example === undefined && p.default === undefined);
    problems.push(`no example for ${missing.map((p) => p.name).join(", ")}`);
  } else {
    try {
      within(() => buildRequest(op, example, session), DEADLINE.args);
      builds = true;
    } catch (e) {
      problems.push(
        e instanceof DeadlineExceeded
          ? `the example args were not tested against the patterns: ${e.message}`
          : (e as Error).message,
      );
    }
  }
  const signedIn = loggedIn(session.cookies, site.loginCookies);
  if (op.learnedLoggedIn && !signedIn) {
    problems.push(
      "learned signed in, and the jar holds no live login cookie: a call re-imports the browser's first, and sends nothing without one",
    );
    nexts.push(`api-anything login ${site.name}`);
  }
  if (readback && readback.outcome !== "pass")
    problems.push(
      `its readback ${readback.op} answered ${readback.outcome}, so a call could not prove the write landed`,
    );
  if (!s) problems.push("the session file cannot be read");
  return {
    builds,
    ...(problems.length ? { reason: problems.join("; ") } : {}),
    ...(nexts.length ? { next: [...new Set(nexts)].join("; ") } : {}),
    learnedLoggedIn: op.learnedLoggedIn,
    loggedIn: signedIn,
    ...(readback ? { readback } : {}),
    unconfirmed: loadWrites({ site: site.name, op: op.name }).filter(unconfirmedWrite).length,
    ok: builds && !problems.length,
  };
}

/** How a read's own cases did in this run, for the write it is the readback of. */
function readbackOutcome(run: Run | undefined): ReadbackOutcome {
  if (!run) return "not run";
  if ("skipped" in run) return "skipped";
  if (run.results.some((r) => r.outcome === "fail")) return "fail";
  return run.results.every((r) => r.outcome === "pass") ? "pass" : "inconclusive";
}

/**
 * Run every read's example and checks, record the outcomes, and clear `unproven` where the answers
 * differ. Both only for an op whose cases were chosen from the version saved when verify ends and
 * whose every case that was sent answered from it: an op saved meanwhile by anything else (an `add`
 * in another process) gets neither, and loses the record it had. An op none of whose cases was sent
 * (the site cools down) keeps its record as it was, unless an earlier run of them answered unproved.
 * A read that drifted heals even while marked stale: verify is the explicit check, so the mark is no
 * reason to leave it broken (the stored template is still what is sent first). A read learned signed
 * in is skipped while no login is on record, and a write gets a `preflight` in place of a call.
 */
export async function verifySite(name: string, opts: CallOptions = {}): Promise<Verified> {
  const site = loadSite(name)?.site;
  if (!site) throw new Error(`no site "${name}"`);
  opts = { ...opts, ignoreStale: true };
  const session = sessionOrNone(name);
  const runs = new Map<string, Run>();
  for (const op of site.operations) {
    if (!op.readOnly) continue;
    if (needsLogin(site, op, session))
      runs.set(op.name, {
        skipped: `needs login: ${op.name} was learned signed in, and no login is on record for ${name}: api-anything login ${name}`,
      });
    else runs.set(op.name, await runCases(name, op, opts));
  }
  // Cases that answered from another version than the one saved now (a heal part way through them,
  // or a save between them), or that were chosen from another (whose own checks may differ), prove no
  // one version: they all run once more, on the op as it is now, and that run is the one judged.
  const then = loadSite(name)?.site ?? site;
  /** ops whose first run answered and proved no one version: a rerun the cool-down refuses keeps no record for them */
  const unproved = new Set<string>();
  for (const [n, run] of runs) {
    const op = then.operations.find((o) => o.name === n);
    if (!op?.readOnly || !("from" in run) || clean(op, run)) continue;
    if (sent(run)) unproved.add(n);
    runs.set(n, await runCases(name, op, opts));
  }
  const proven: string[] = [];
  if ([...runs.values()].some((r) => "proven" in r && r.proven))
    updateSite(name, (cur) => {
      if (!cur) throw new Error(`site "${name}" disappeared during verify`);
      return {
        ...cur,
        operations: cur.operations.map((o) => {
          const run = runs.get(o.name);
          if (!o.unproven || !sent(run) || !clean(o, run) || !run.proven) return o;
          proven.push(o.name);
          const { unproven: _, ...rest } = o;
          return rest;
        }),
      };
    });
  const now = loadSite(name)?.site ?? site;
  const record = loadRecord(name);
  const before = { ...record };
  const at = new Date().toISOString();
  for (const op of now.operations) {
    const run = runs.get(op.name);
    if (!sent(run)) {
      if (unproved.has(op.name)) delete record[op.name];
      continue;
    }
    if (clean(op, run)) record[op.name] = { hash: opHash(op), at, results: dated(before[op.name], run.results, at) };
    // a run that answered and proved no one version leaves no record, not an older one standing
    else delete record[op.name];
  }
  for (const k of Object.keys(record)) if (!now.operations.some((o) => o.name === k)) delete record[k];
  writePrivate(recordFile(name), JSON.stringify(record, null, 1));
  const newlyFailing: string[] = [];
  const recovered: string[] = [];
  const failingSince: Record<string, string> = {};
  for (const op of now.operations) {
    const was = failing(before[op.name]);
    const is = failing(record[op.name]);
    if (is && !was) newlyFailing.push(op.name);
    if (was && !is && record[op.name]) recovered.push(op.name);
    if (is)
      failingSince[op.name] = record[op.name]!.results.filter((r) => r.outcome === "fail")
        .map((r) => r.since ?? at)
        .sort()[0]!;
  }
  // the reads may have refreshed it (a re-import, a cookie or a captured value): preflight what a write would send now
  const current = sessionOrNone(name);
  const results = site.operations.flatMap((o): Verified["results"] => {
    if (!o.readOnly) {
      const rb = o.readback;
      const readback = rb
        ? "op" in rb
          ? { op: rb.op, outcome: readbackOutcome(runs.get(rb.op)) }
          : { op: rb.read.name, outcome: "not run" as const }
        : undefined;
      return [{ op: o.name, preflight: preflight(now, o, current, readback) }];
    }
    const run = runs.get(o.name);
    if (!run) return [];
    if ("skipped" in run) return [{ op: o.name, skipped: run.skipped }];
    // the recorded cases carry `since`; a run that left no record is reported as it ran
    return record[o.name]?.at === at ? record[o.name]!.results : run.results;
  });
  return { results, proven, newlyFailing, recovered, failingSince };
}

/**
 * Keeps cases that ran outside verify as the op's record, as verify would: learn_site's holdout call is
 * its check's case, so what it learned publishes without a verify of its own, with what it proved.
 */
export function recordCases(site: string, op: Operation, results: CaseResult[], evidence?: Proof): void {
  const record = loadRecord(site);
  const at = new Date().toISOString();
  record[op.name] = {
    hash: opHash(op),
    at,
    results: dated(record[op.name], results, at),
    ...(evidence ? { evidence } : {}),
  };
  writePrivate(recordFile(site), JSON.stringify(record, null, 1));
}

/** The evidence kept with the op's record, while the record is of this version of it. */
export function proofOf(site: string, op: Operation): Proof | undefined {
  const rec = loadRecord(site)[op.name];
  return rec && rec.hash === opHash(op) ? rec.evidence : undefined;
}

export interface Gate {
  errors: string[];
  /** each op's failing cases on its current version: what refuses even a share that needs no `verify` (shareOps) */
  failed: Map<string, string[]>;
  /** the record's cases for every op, current ones only, for the publish preview */
  rows: { op: string; verified?: string; results: CaseResult[] }[];
}

const label = (r: CaseResult) =>
  `${r.case}${
    r.args
      ? ` (${Object.entries(r.args)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")})`
      : ""
  }`;

/**
 * What `publish` asks of each op beyond the shared rules (which refuse an `unproven` mark): for an op
 * with checks, a record of them on this version of it with no case failing. Every counted case must
 * pass; an inconclusive one is shown and counted neither way.
 */
export function gate(site: Site): Gate {
  const record = loadRecord(site.name);
  const errors: string[] = [];
  const failed: Gate["failed"] = new Map();
  const rows: Gate["rows"] = [];
  for (const op of site.operations) {
    const rec = record[op.name];
    const current = rec && rec.hash === opHash(op) ? rec : undefined;
    if (op.checks?.length && !current)
      errors.push(`${op.name}: its checks have not run on this version of it: api-anything verify ${site.name}`);
    const fails = (current?.results ?? [])
      .filter((r) => r.outcome === "fail")
      .map((r) => `${op.name}: ${label(r)} expects ${r.expect}, and answered ${r.got}`);
    if (fails.length) failed.set(op.name, fails);
    errors.push(...fails);
    rows.push({ op: op.name, ...(current ? { verified: current.at } : {}), results: current?.results ?? [] });
  }
  return { errors, failed, rows };
}
