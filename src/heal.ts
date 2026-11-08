/**
 * Learning against the live site. One routine, run trigger -> match -> learn, serves three jobs:
 * add (create), recapture (heal), and the tier-3 read. Rescan is the browserless heal.
 */
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { atStep, browserAvailable, PageUnreachable, ProfileInUse, runTrigger, waitReport } from "./browser.js";
import { botWall, type Class, judge, type Observed, pickedShape } from "./classify.js";
import { asText, escapeTemplate, fillTemplate, getAt, setAt, templateRefs, walk } from "./codec.js";
import { acceptedConfirms, recordedConfirms } from "./confirm.js";
import { capOutput, extract } from "./extract.js";
import { buildRequest, MAX_REDIRECTS, ownMatch, REDIRECT, refusal } from "./http.js";
import {
  type Args,
  ASSET_EXT,
  arrayAround,
  asGenerated,
  capturePages,
  checkExamples,
  hashLike,
  learnOperation,
  matches,
  requestMatch,
  UUID,
  unplaced,
} from "./learn.js";
import { sendDerived } from "./lookup.js";

export { unplaced };

import type { NextAction } from "./execute.js";
import { standIn } from "./paging.js";
import { readSealed, SealError, writeSealed } from "./seal.js";
import { besideOrigins, credentialsOf, opUrls, scanSecrets, signInFills } from "./secrets.js";
import {
  CAPTURE_TTL_MS,
  cookieHeaderFor,
  home,
  loadSession,
  mergeCapture,
  parseCookieHeader,
  pruneCaptures,
  recordOrigins,
  type Session,
  safeName,
  siteOf,
} from "./session.js";
import {
  type Match,
  type Operation,
  OperationSchema,
  type Paging,
  type Param,
  type ResponseSpec,
  type Site,
  type Slot,
  type Trigger,
  type Volatile,
} from "./spec.js";
import {
  appendHeal,
  clearStale,
  type HealRecord,
  loadHeals,
  loadSite,
  rememberTier,
  templateHash,
  updateSite,
} from "./store.js";
import type { CaptureResult, Exchange, TriggerStep } from "./types.js";
import { LIMITS, notARead, pagingProblems, readbackProblems, vetShared } from "./vet.js";

export const profileDir = () => join(home(), "profile");

/** One transport try, judged. `ambiguous`: no response came back, so a write may have run. */
export interface Attempt {
  tier: 1 | 2 | 3;
  class: Class;
  reason: string;
  status?: number;
  data?: unknown;
  /** see Judged.nextPage and Judged.hasMore */
  nextPage?: string | number;
  hasMore?: boolean;
  ambiguous?: boolean;
  /** the args may be the problem (data missing, or a bare 403); see Classified.missing */
  missing?: boolean;
  /** picked fields gone from an answer that has the rest (in `data`); see Classified.lost */
  lost?: string[];
  /** the server failed or could not be reached; see Classified.server */
  server?: boolean;
  /** the first answer was a redirect, so the server took the request (a write ran) */
  redirected?: boolean;
  /** a specific `next` for the agent (a local problem, not the site's) */
  hint?: string;
  /** what the caller should know whatever the outcome (a repeat of the write was stopped) */
  note?: string;
  /** why the session a tier-3 run captured could not be saved (TriggerRun.unsaved) */
  unsaved?: string;
  /** nothing reached the site (the browser profile was busy, the tier-2 origin page did not load) */
  unsent?: boolean;
  /** the site answered that it did not apply the write (a clear refusal in a 2xx body) */
  rejected?: boolean;
  /** rate: the wait the server asked for; see Classified.retryAfterMs */
  retryAfterMs?: number;
  /** the step `hint` asks for, when it is not the class's usual one; see CallResult.nextCall */
  step?: NextAction;
}

export const PROFILE_HINT =
  "another api-anything process (an MCP server?) holds the browser profile; it lets go after a few seconds idle: wait, or stop it, then retry once";

/** Fill `{param}` in a trigger. URL parts are percent-encoded; step values are typed as given. */
export function fillTrigger(t: Trigger, args: Args): Trigger {
  const enc = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, encodeURIComponent(asText(v))]));
  const step = (s: TriggerStep): TriggerStep => ({
    ...s,
    ...(s.selector !== undefined ? { selector: fillTemplate(s.selector, args) } : {}),
    ...(s.value !== undefined ? { value: fillTemplate(s.value, s.action === "goto" ? enc : args) } : {}),
  });
  return {
    url: fillTemplate(t.url, enc),
    ...(t.softFrom ? { softFrom: fillTemplate(t.softFrom, enc) } : {}),
    ...(t.steps ? { steps: t.steps.map(step) } : {}),
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Once the steps run, only these may still load: they can't carry a write the way an image ping,
// a link, a GET form, a JSONP script or an iframe can...
const INERT = new Set(["stylesheet", "font", "media"]);

/**
 * ...unless it is the site's own endpoint in disguise (`<link rel=stylesheet href=/api/vote?id=..>`,
 * an <audio> or @font-face pointed at one): same-site, and not a static asset path (no asset
 * extension, or a query carrying an example value). Other sites' CDNs and the site's own
 * .css/.woff2/.mp4 files still load, so the page keeps rendering.
 */
function inertLoad(e: Exchange, site: string | undefined, values: string[]): boolean {
  let u: URL;
  try {
    u = new URL(e.request.url);
  } catch {
    return true; // data:, blob:
  }
  if (!site || siteOf(u.hostname) !== site) return true;
  const query = decodeLoose(u.search, true).toLowerCase();
  return ASSET_EXT.test(u.pathname) && !values.some((v) => v.length >= 3 && query.includes(v.toLowerCase()));
}

/**
 * While learning a write: abort every unsafe request, and once the UI steps run, every request
 * but stylesheets, fonts and media that are really assets (a "Follow" button may send a GET, an
 * upvote may be `new Image().src`). A known write's own match is aborted whatever its method.
 * WebSocket messages the page sends are dropped by the browser layer.
 * `url`: the page the run loads (its site); `args`: the example values.
 * ponytail: also aborts requests the page needs after the click; a narrower matcher would risk
 * letting the write itself through when the match is wrong.
 */
export const writeGuard = (m?: Match, o: { url?: string; args?: Args } = {}) => {
  let site: string | undefined;
  try {
    site = o.url ? siteOf(new URL(o.url).hostname) : undefined;
  } catch {
    /* no site: every inert load passes, as before */
  }
  const values = Object.values(o.args ?? {}).map((v) => asText(v));
  return (e: Exchange, acting: boolean): boolean =>
    !SAFE_METHODS.has(e.request.method.toUpperCase()) ||
    (acting && !(INERT.has(e.resourceType) && inertLoad(e, site, values))) ||
    (!!m && Object.keys(m).length > 0 && matches(m, e.request));
};

/**
 * A read's trigger must not write either: a shared spec that says "read" but clicks a button that
 * POSTs. Once the steps run, unsafe requests other than the op's own are aborted. Every hop of a
 * redirect chain that started with the op's own unsafe request (`via`) is the op's own too, on any
 * origin, as Chrome itself would follow it (a signed read the server checks elsewhere with a 307).
 * The hops of any other chain are judged by their own address: an asset sent on to a write stops.
 * ponytail: that includes a 307 of the op's own read to a write on its own site; the server chose
 * it, and nothing in the spec tells it from a check. `shared`: the spec is someone else's, and an
 * unsafe hop of that chain to another site is aborted, before the steps run too.
 */
const readGuard = (m: Match, shared = false) => {
  const own = (e: Exchange) =>
    !SAFE_METHODS.has(e.request.method.toUpperCase()) && Object.keys(m).length > 0 && matches(m, e.request);
  const site = (e: Exchange) => siteOf(new URL(e.request.url).hostname);
  return (e: Exchange, acting: boolean, via?: Exchange): boolean =>
    e.resourceType !== "websocket" &&
    !SAFE_METHODS.has(e.request.method.toUpperCase()) &&
    // Someone else's spec does not get the 307 exemption off its site, from the first request on: Chrome
    // would send the op's body and headers, a session's values among them, wherever the server pointed.
    ((shared && !!via && own(via) && site(e) !== site(via)) || (acting && !own(e) && !(via && own(via))));
};

const unsafe = (e: Exchange) => e.resourceType !== "websocket" && !SAFE_METHODS.has(e.request.method.toUpperCase());

/** A request as a result names it: method and path, with the host when it is off `site`. Never the query. */
export function requestLabel(e: Exchange, site: string | undefined): string {
  try {
    const u = new URL(e.request.url);
    return `${e.request.method.toUpperCase()} ${siteOf(u.hostname) === site ? "" : u.host}${u.pathname}`;
  } catch {
    return e.request.method.toUpperCase();
  }
}

const siteOfUrl = (url: string) => {
  try {
    return siteOf(new URL(url).hostname);
  } catch {
    return undefined;
  }
};

/**
 * A read being learned (`add`, `capture` without --write): once the steps run, an unsafe request is
 * stopped, since a click that places an order would otherwise place it on each run. It passes when
 * it is the op's own by `--match` (or a hop of that one's redirect), or a GraphQL query that carries
 * its document, which reads by GraphQL's own rules. While the page loads, nothing is stopped.
 */
export const learnGuard = (m?: Match) => {
  const own = (e?: Exchange) => !!e && !!m && Object.keys(m).length > 0 && matches(m, e.request);
  return (e: Exchange, acting: boolean, via?: Exchange): boolean =>
    acting &&
    unsafe(e) &&
    !own(e) &&
    !own(via) &&
    !!notARead({
      request: { method: e.request.method, url: e.request.url, headers: e.request.headers, body: e.request.body },
      slots: [],
      params: [],
    });
};

/**
 * A write's tier-3 run is the page sending it for real, so its own request may leave once: a
 * handler bound twice, or a client that sends again, would perform the write again, and every
 * further request matching the op is aborted. So is the server's redirect of the one that left
 * (`via`: what a hop was redirected from) when it would send the write on: a hop that keeps an
 * unsafe method (307, 308), or leads back to the op's own request. A hop that became a GET of
 * another address (Post/Redirect/Get) passes. Once the steps run, any other unsafe request leaves
 * only when it is one of the companions the op's learning recorded: a redesigned page whose button
 * now deletes the account sends nothing. An op learned before companions were recorded (none listed,
 * not even an empty list) lets them leave. An op with no `match` has no request to count.
 * `stopped`: what was aborted; `left`: the other unsafe requests that left, by `requestLabel`.
 */
const sendOnce = (op: Operation) => {
  const m = op.match;
  const companions = op.trigger.companions;
  const site = siteOfUrl(op.request.url);
  let sent = false;
  const stopped = { repeats: 0, resends: 0, others: new Set<string>() };
  const left = new Set<string>();
  const guard = (e: Exchange, acting: boolean, via?: Exchange): boolean => {
    if (e.resourceType === "websocket" || !Object.keys(m).length) return false;
    const own = matches(m, e.request);
    if (via && matches(m, via.request)) {
      if (!own && SAFE_METHODS.has(e.request.method.toUpperCase())) return false;
      stopped.resends++;
      return true;
    }
    if (!own) {
      if (!acting || !unsafe(e)) return false;
      const recorded = !companions || companions.some((c) => matches(c, e.request));
      (recorded ? left : stopped.others).add(requestLabel(e, site));
      return !recorded;
    }
    if (sent) stopped.repeats++;
    const repeat = sent;
    sent = true;
    return repeat;
  };
  return Object.assign(guard, { stopped, left });
};

/**
 * A write's companions, from its learning runs: the unsafe requests the guard aborted besides the
 * op's own, on the op's site (another site's is stopped at tier 3), each by `requestMatch`, at most
 * LIMITS.companions. `dropped`: how many more there were.
 */
function companionsOf(op: Operation, runs: [CaptureResult, Args][]): { companions: Match[]; dropped: number } {
  const site = siteOfUrl(op.request.url);
  const seen = new Map<string, Match>();
  for (const [run, args] of runs)
    for (const e of run.exchanges) {
      if (!e.aborted || !unsafe(e) || matches(op.match, e.request) || siteOfUrl(e.request.url) !== site) continue;
      const c = requestMatch(e.request, args);
      seen.set(JSON.stringify(c), c);
    }
  const all = [...seen.values()];
  return { companions: all.slice(0, LIMITS.companions), dropped: Math.max(0, all.length - LIMITS.companions) };
}

/** Values of the op's session: refs as the browser just sent them. */
function sessionValuesOf(op: Operation, e: Exchange): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of op.slots) {
    // a session ref's own leaf, or a session hole in a param's templated leaf
    const refs = (
      s.template !== undefined
        ? [...new Set([...(s.ref ? [s.ref] : []), ...templateRefs(s.template)])]
        : s.ref
          ? [s.ref]
          : []
    ).filter((r) => r.startsWith("session:"));
    if (!refs.length) continue;
    let v: unknown;
    try {
      v = getAt(e.request, s.at);
    } catch {
      continue;
    }
    for (const ref of refs) {
      const part = typeof v === "string" && s.template !== undefined ? refPart(s.template, ref, v, s.escape) : v;
      if (typeof part === "string" && part) out[ref.slice(8)] = part;
    }
  }
  return out;
}

/** The text a templated ref holds inside a leaf: the template's other holes match anything. */
function refPart(template: string, ref: string, leaf: string, escape?: "url" | "json"): string | undefined {
  const re = template
    .split(/(\{\{|\}\}|\{[^{}]+\})/)
    .map((p) =>
      p === "{{"
        ? "\\{"
        : p === "}}"
          ? "\\}"
          : p === `{${ref}}`
            ? "(.*?)"
            : /^\{[^{}]+\}$/.test(p)
              ? ".*?"
              : escapeRe(p),
    )
    .join("");
  const m = new RegExp(`^${re}$`, "s").exec(leaf);
  if (!m) return undefined;
  try {
    return escape === "url"
      ? decodeURIComponent(m[1]!)
      : escape === "json"
        ? (JSON.parse(`"${m[1]}"`) as string)
        : m[1];
  } catch {
    return m[1];
  }
}

export interface TriggerRun {
  capture: CaptureResult;
  /** the request matching op.match that answers this run (see pickHit) */
  matched?: Exchange;
  /** the session values this run captured (its cookies are `capture.cookies`), saved or not */
  values?: Record<string, string>;
  /** why the session this run captured, which differs from the stored one, could not be saved */
  unsaved?: string;
  /** the trigger landed on a sign-in page instead of the content */
  loginWall?: string;
  /** a write's own request was sent again by the page this many times, and stopped each time */
  repeats?: number;
  /** a write's own request was answered with a redirect that would have sent it again, and was stopped */
  resends?: number;
  /** a write's other unsafe requests once the steps ran, by `requestLabel`: those stopped, and those that left */
  others?: { stopped: string[]; left: string[] };
}

/**
 * The matching exchange that is this run's answer: one carrying the run's args (a softFrom page
 * fires its own request first) and judged ok (a bot interstitial may precede the real page),
 * the latest on a tie.
 */
function carriesArgs(op: Operation, e: Exchange, args: Args): boolean {
  const cookies = Object.entries(parseCookieHeader(e.request.headers.cookie ?? "")).map(([name, value]) => ({
    name,
    value,
    domain: new URL(e.request.url).hostname,
    path: "/",
    expires: -1,
    secure: false,
    httpOnly: false,
  }));
  const expected = buildRequest(op, args, { cookies, values: sessionValuesOf(op, e) });
  return op.params.every((p) => {
    if (args[p.name] === undefined && p.default === undefined) return !p.required;
    const slots = op.slots.filter(
      (s) =>
        (s.param === p.name || s.template?.includes(`{${p.name}}`)) &&
        !/^header:(referer|origin|cookie)$/i.test(s.at[0]!),
    );
    // a param only a derived slot's lookup takes reaches this request as the value it looked up: not checkable here
    if (!slots.length && op.slots.some((s) => s.from?.slots.some((l) => l.param === p.name))) return true;
    return (
      slots.length > 0 &&
      slots.every((s) => {
        try {
          return asText(getAt(e.request, s.at)) === asText(getAt(expected, s.at));
        } catch {
          return false;
        }
      })
    );
  });
}

function pickHit(op: Operation, hits: Exchange[], args: Args): Exchange | undefined {
  // An answer to another query is never a fallback. Compare the declared parameter positions,
  // including short values and structured args; substring ranking is only a discovery aid.
  const answered = hits.filter((e) => (e.response || e.aborted) && carriesArgs(op, e, args));
  const score = (e: Exchange) => (e.aborted || judgeExchange(op, e)?.class === "ok" ? 1 : 0);
  return answered.reduce<Exchange | undefined>((best, e) => (!best || score(e) >= score(best) ? e : best), undefined);
}

/** The final page of a run, when it is a sign-in page the trigger was redirected to. */
export function loginWall(capture: CaptureResult, triggerUrl: string): string | undefined {
  let f: URL;
  let t: URL;
  try {
    f = new URL(capture.finalUrl);
    t = new URL(triggerUrl);
  } catch {
    return undefined;
  }
  if (f.pathname === t.pathname) return undefined;
  const doc = capture.exchanges.filter((e) => e.resourceType === "document" && e.response?.body).at(-1);
  const password = /type=["']?password/i.test(doc?.response?.body ?? "");
  return password || /(log|sign)[-_]?in|\/accounts\/login|\/i\/flow\/login/i.test(f.pathname) ? f.pathname : undefined;
}

/** Run an op's trigger with args in the shared profile and refresh the session from it. */
export async function runOpTrigger(
  site: string,
  op: Operation,
  args: Args,
  o: { intercept?: boolean } = {},
): Promise<TriggerRun> {
  const t = fillTrigger(op.trigger, args);
  const isHit = (e: Exchange) => matches(op.match, e.request);
  // A write's tier-3 run is the UI sending it for real, once; learning or healing one intercepts it.
  const once = !o.intercept && !op.readOnly ? sendOnce(op) : undefined;
  const shared = !!loadSite(site)?.site.shared;
  const intercept = once ?? (o.intercept ? writeGuard(op.match, { url: t.url, args }) : readGuard(op.match, shared));
  // Intercepted, a write's confirm sends nothing, so learning accepts it. For real, only what its
  // learning recorded is accepted, the question asked with this call's values; a read accepts none.
  const confirm = o.intercept ? () => true : once ? recordedConfirms(op.trigger.confirms ?? [], args) : undefined;
  const capture = await runTrigger({ ...t, profileDir: profileDir(), intercept, match: isHit, confirm });
  const hits = capture.exchanges.filter(isHit);
  // a real write's answer is a request that left: a repeat that was stopped answers nothing
  const sent = o.intercept || op.readOnly ? hits : hits.filter((e) => !e.aborted);
  const matched = pickHit(op, sent, args);
  // Session values (a site-wide API key, a guest token) don't depend on the args: refresh them from
  // the op's own request even when the page asked for other args, whose answer is never returned.
  const source = matched ?? hits.find((e) => e.response && e.response.status < 400);
  const values = source ? sessionValuesOf(op, source) : {};
  const captured = source && { from: source.request.url, values };
  let unsaved: string | undefined;
  try {
    mergeCapture(site, capture.cookies, captured);
  } catch (e) {
    // A real write has left by now: a session that could not be saved (a busy lock, a read-only home)
    // must not turn its answer into a failure that reads as unsent and gets it sent again. The site may
    // have rotated it, though: the call says so, and later calls send the stored one.
    if (!once) throw e;
    if (differsFromStored(site, capture.cookies, values)) unsaved = (e as Error).message.split("\n")[0]!;
  }
  const wall = matched?.response ? undefined : loginWall(capture, t.url);
  const { repeats, resends, others } = once?.stopped ?? {};
  const stopped = [...(others ?? [])];
  const left = [...(once?.left ?? [])];
  return {
    capture,
    matched,
    values,
    ...(unsaved ? { unsaved } : {}),
    ...(wall ? { loginWall: wall } : {}),
    ...(repeats ? { repeats } : {}),
    ...(resends ? { resends } : {}),
    ...(stopped.length || left.length ? { others: { stopped, left } } : {}),
  };
}

/** Whether saving a run's cookies and session values would change the stored session; true when it cannot be read. */
function differsFromStored(site: string, cookies: CaptureResult["cookies"], values: Record<string, string>): boolean {
  let s: Session;
  try {
    s = loadSession(site);
  } catch {
    return true;
  }
  const key = (c: { name: string; domain: string; path: string }) => `${c.name}\0${c.domain.toLowerCase()}\0${c.path}`;
  const stored = new Map(s.cookies.map((c) => [key(c), c]));
  const now = Date.now();
  // an expired cookie the store lacks is dropped by the merge, so it changes nothing
  const changes = (c: (typeof cookies)[number]) => {
    const was = stored.get(key(c));
    return was ? was.value !== c.value || was.expires !== c.expires : !(c.expires > 0 && c.expires * 1000 <= now);
  };
  return cookies.some(changes) || Object.entries(values).some(([n, v]) => s.values[n] !== v);
}

/** The page's last load: a redirect's end carries no #fragment, and a reload answers again. */
function lastLoad(capture: CaptureResult): Exchange["response"] {
  const page = capture.finalUrl.split("#")[0];
  return capture.exchanges
    .filter((e) => e.resourceType === "document" && e.response && e.request.url.split("#")[0] === page)
    .at(-1)?.response;
}

/** The trigger page's own failure (a 5xx): its requests never fired, which says nothing about the op. */
export function pageDown(capture: CaptureResult): Attempt | undefined {
  const status = lastLoad(capture)?.status;
  return status !== undefined && status >= 500
    ? { tier: 3, class: "error", status, server: true, reason: `the trigger page answered HTTP ${status}` }
    : undefined;
}

/**
 * Why a trigger run has no request of the op's: what the run saw as its wait ended, and the confirm
 * it dismissed when there was one, since the request may have been waiting on it.
 */
export function firedNothing(op: Operation, capture: CaptureResult): string {
  const no = `the trigger fired no request matching ${JSON.stringify(op.match)} (${waitReport(capture)})`;
  const asked = capture.dialogs?.find((d) => d.type === "confirm" && !d.accepted);
  if (!asked) return no;
  const why = op.readOnly
    ? "a read never confirms"
    : op.trigger.confirms?.length
      ? "it is not one this write's learning recorded"
      : "this write's learning recorded none";
  return `${no}: the page asked to confirm ${atStep(asked.step)} and was told no, since ${why}; nothing is confirmed on the user's behalf`;
}

/** The run ended on a bot challenge that did not solve: its requests never fired, which says nothing about the op. */
export function challengePage(capture: CaptureResult): Attempt | undefined {
  const doc = lastLoad(capture);
  const wall = doc && botWall({ status: doc.status, headers: doc.headers, body: doc.body ?? "" });
  return wall ? { tier: 3, class: "blocked", reason: `the trigger page stayed a bot challenge (${wall})` } : undefined;
}

/** A tier-3 result: the site's own request, answered. */
export function judgeExchange(op: Operation, e: Exchange): Attempt | undefined {
  const r = e.response;
  if (!r) return undefined;
  return {
    tier: 3,
    status: r.status,
    ...judge(op, { status: r.status, headers: r.headers, body: r.body ?? "", url: e.request.url }),
  };
}

/* ------------------------------------------------------------ captures */

export interface CaptureFile extends CaptureResult {
  id: string;
  at: string;
  url: string;
  steps?: TriggerStep[];
  softFrom?: string;
  /** writes were intercepted during this run */
  write?: boolean;
}

const captureFile = (id: string) => join(home(), "captures", `${safeName(id)}.json`);
const captureLabel = (id: string) => `capture:${safeName(id)}`;
let lastId = "";

function saveCapture(
  o: { url: string; steps?: TriggerStep[]; softFrom?: string; write?: boolean },
  r: CaptureResult,
): CaptureFile {
  let id = `c${Date.now().toString(36)}`;
  while (id <= lastId) id = `c${(parseInt(lastId.slice(1), 36) + 1).toString(36)}`;
  lastId = id;
  const file: CaptureFile = {
    id,
    at: new Date().toISOString(),
    url: o.url,
    steps: o.steps,
    softFrom: o.softFrom,
    ...(o.write ? { write: true } : {}),
    ...r,
  };
  writeSealed(captureFile(id), JSON.stringify(file), captureLabel(id));
  pruneCaptures();
  return file;
}

/** Run a page, keep everything it sent under ~/.api-anything/captures/<id>.json (sealed, 0600: it holds cookies). */
export async function capturePage(o: {
  url: string;
  steps?: TriggerStep[];
  softFrom?: string;
  write?: boolean;
  args?: Args;
}): Promise<CaptureFile> {
  const r = await runTrigger({
    url: o.url,
    steps: o.steps,
    softFrom: o.softFrom,
    profileDir: profileDir(),
    intercept: o.write
      ? writeGuard(undefined, { url: o.url, args: o.args })
      : o.steps?.length
        ? learnGuard()
        : undefined,
    confirm: o.write ? () => true : undefined,
  });
  return saveCapture(o, r);
}

/**
 * What a read's learning run stopped (`learnGuard`), by `requestLabel`: on the trigger page's site,
 * which may be the action the steps perform, and on others (an analytics beacon, most often).
 */
export function stoppedIn(run: CaptureResult, url: string): { site: string[]; elsewhere: string[] } {
  const site = siteOfUrl(url);
  const out = { site: [] as string[], elsewhere: [] as string[] };
  for (const e of run.exchanges)
    if (e.aborted) {
      const list = siteOfUrl(e.request.url) === site ? out.site : out.elsewhere;
      const label = requestLabel(e, site);
      if (!list.includes(label)) list.push(label);
    }
  return out;
}

/**
 * What to do about a request a read's learning stopped: --write first, which never sends it. A --match
 * pin sends it for real on each run, so it is offered only for a request that changes nothing: an
 * agent that took the pin for an order placed two real orders.
 */
const pinHint = (method: string, path: string, again = "add it") =>
  `If it is an action (an order, a post, a change), ${again} with --write, which never sends it. ` +
  `Only if it changes nothing (a search the site sends as ${method}), add it with --match method=${method} --match path=${path}: ` +
  `a pinned request is sent for real on each learning run and saved as a read`;

/** Said when a read's learning stopped requests the steps sent on the page's own site: what to do instead. */
export function stoppedHint(labels: string[], again: string): string {
  const [method, path] = labels[0]!.split(" ");
  return (
    `${labels.join(", ")}, sent once the steps ran, ${labels.length > 1 ? "were" : "was"} stopped in the browser: nothing was sent. ` +
    pinHint(method!, path!, again)
  );
}

/** A capture that is missing, past its lifetime, or unreadable; `next` says how to get a fresh one. */
export class CaptureUnavailable extends Error {
  constructor(
    message: string,
    readonly next: string,
    /** a fresh capture is the whole fix (missing, expired); false when `next` carries another step, such as a key */
    readonly recapture = true,
  ) {
    super(message);
  }
}

const RECAPTURE =
  "capture the page again (api-anything capture <url>, or learn_site without captures), then use the new id";

/**
 * A saved capture. It holds the run's cookies and authenticated headers, so one past its 24 h is
 * refused here, not only pruned when the next capture is saved.
 */
export function loadCapture(id: string, now = Date.now()): CaptureFile {
  const file = captureFile(id);
  let c: CaptureFile | undefined;
  try {
    c = readSealed<CaptureFile | undefined>(file, undefined, captureLabel(id), `delete ${file}, then ${RECAPTURE}`);
  } catch (e) {
    if (e instanceof SealError) throw new CaptureUnavailable(e.message, e.next, false);
    throw e;
  }
  if (!c) throw new CaptureUnavailable(`no capture "${id}"`, RECAPTURE);
  const at = Date.parse(c.at) || statSync(file).mtimeMs;
  if (now - at > CAPTURE_TTL_MS) {
    rmSync(file, { force: true });
    throw new CaptureUnavailable(
      `capture "${id}" is from ${new Date(at).toISOString()}, past its 24 h lifetime (it holds the run's cookies), and was deleted`,
      RECAPTURE,
    );
  }
  return c;
}

/* ----------------------------------------------------------------- add */

export interface AddInput {
  site: string;
  op: string;
  /** url may be relative to an existing site's baseUrl; optional with `from` (derived from the capture) */
  trigger?: Trigger;
  examples: [Args] | [Args, Args];
  match?: Match;
  write?: boolean;
  description?: string;
  response?: Partial<Pick<ResponseSpec, "format" | "extract" | "pick" | "html" | "embedded">>;
  /** header names a human confirmed are public constants: kept literal instead of session refs */
  public?: string[];
  /** learn from a saved capture instead of running the trigger; id = the request to learn */
  from?: { capture: CaptureFile; id?: number };
  /** a second saved capture, made with examples[1], for the two-run diff */
  from2?: CaptureFile;
  /** by param name: the values it allows, set on top of what the op had */
  allowed?: Record<string, Pick<Param, "enum" | "min" | "max">>;
  /** a read's paging, set on top of what the op had */
  paging?: Paging;
  fetchImpl?: typeof fetch;
  /** learn_site's: refuse (`NotARead`) a learned request `notARead` refuses, before anything is sent or saved */
  readsOnly?: boolean;
}

/** A request learn_site may not save as a read (`notARead`): nothing was sent and nothing saved. */
export class NotARead extends Error {}

/** What a param says about its values that no capture tells, kept when its op is learned again. */
const KEPT = ["description", "pattern", "hint", "enum", "min", "max"] as const;
type Allowed = Partial<Pick<Param, (typeof KEPT)[number]>>;

export interface AddResult {
  operation: Operation;
  warnings: string[];
  path: string;
  /** the trigger runs, saved as captures (add --from <id> re-learns from them without Chrome) */
  captures: string[];
  /** what a call would have returned, judged on the captured response */
  preview?: { count?: number; first: unknown };
  /** an op of that name existed and was overwritten */
  replaced: boolean;
  /** the op was kept and one thing replaced: its response recipe, or (given alone) its description */
}

/** Put `{name}` back where an example value sits in a literal step (a typed value, a selector). */
function templatize(text: string, args: Args): string {
  let out = escapeTemplate(text);
  for (const [k, v] of Object.entries(args)) {
    const s = asText(v);
    if (s.length >= 3) out = out.split(escapeTemplate(s)).join(`{${k}}`);
  }
  return out;
}

const decodeLoose = (raw: string, plus: boolean) => {
  try {
    return decodeURIComponent(plus ? raw.replace(/\+/g, " ") : raw);
  } catch {
    return raw;
  }
};

/**
 * Put `{name}` back where an example value sits in a captured page URL: the query value under a key
 * named like the param, else every query value and path segment equal to it (however it was
 * encoded: + or %20, any case), else a substring of the path or query. The host stays literal.
 */
export function templatizeUrl(url: string, args: Args): string {
  const hashAt = url.indexOf("#");
  const noHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const qAt = noHash.indexOf("?");
  const base = qAt < 0 ? noHash : noHash.slice(0, qAt);
  const pathAt = base.indexOf("/", base.indexOf("//") + 2);
  const origin = pathAt < 0 ? base : base.slice(0, pathAt);
  let segs = pathAt < 0 ? [] : base.slice(pathAt).split("/");
  let pairs = qAt < 0 ? undefined : noHash.slice(qAt + 1).split("&");
  const lit = (t: string) => escapeTemplate(t);
  segs = segs.map(lit);
  pairs = pairs?.map(lit);
  for (const [k, v] of Object.entries(args)) {
    const want = asText(v).toLowerCase();
    if (want.length < 3) continue;
    const hole = `{${k}}`;
    const valueOf = (p: string) => decodeLoose(p.slice(p.indexOf("=") + 1), true).toLowerCase();
    const keyOf = (p: string) => decodeLoose(p.slice(0, p.indexOf("=")), true).toLowerCase();
    const inQuery = (p: string) => p.includes("=") && valueOf(p) === want;
    const inPath = (seg: string) => decodeLoose(seg, false).toLowerCase() === want;
    // A query key named like the param is its position (?q= on /r/python/search). Otherwise an equal
    // path segment and query value are both taken (/u/nasa?tab=nasa): which one is the arg is unknown.
    const named = pairs?.some((p) => inQuery(p) && keyOf(p) === k.toLowerCase());
    if (pairs?.some(inQuery) || segs.some(inPath)) {
      pairs = pairs?.map((p) =>
        inQuery(p) && (!named || keyOf(p) === k.toLowerCase()) ? `${p.slice(0, p.indexOf("="))}=${hole}` : p,
      );
      if (!named) segs = segs.map((seg) => (inPath(seg) ? hole : seg));
    } else {
      const forms = [
        ...new Set([encodeURIComponent(asText(v)), encodeURIComponent(asText(v)).replace(/%20/g, "+"), asText(v)]),
      ].map((f) => escapeRe(lit(f)));
      const re = new RegExp(forms.join("|"), "gi");
      segs = segs.map((seg) => seg.replace(re, hole));
      pairs = pairs?.map((p) =>
        p.includes("=") ? `${p.slice(0, p.indexOf("=") + 1)}${p.slice(p.indexOf("=") + 1).replace(re, hole)}` : p,
      );
    }
  }
  return `${lit(origin)}${segs.join("/")}${pairs ? `?${pairs.join("&")}` : ""}${lit(hash)}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How a capture was made, as a trigger: `{name}` where the example values sit in its URL and steps. */
export function captureTrigger(c: CaptureFile, args: Args): Trigger {
  const step = (s: TriggerStep): TriggerStep => ({
    ...s,
    ...(s.selector ? { selector: templatize(s.selector, args) } : {}),
    ...(s.value ? { value: s.action === "goto" ? templatizeUrl(s.value, args) : templatize(s.value, args) } : {}),
  });
  return {
    url: templatizeUrl(c.url, args),
    ...(c.softFrom ? { softFrom: c.softFrom } : {}),
    ...(c.steps ? { steps: c.steps.map(step) } : {}),
  };
}

export function putOperation(site: Site, op: Operation): Site {
  const rest = site.operations.filter((o) => o.name !== op.name);
  return { ...site, operations: [...rest, op] };
}

/** learnOperation, but a failure on a page that was a bot wall says so (the recipe or the pick is not the problem). */
function learnOrExplain(
  site: string,
  run: CaptureResult,
  input: Parameters<typeof learnOperation>[0],
): ReturnType<typeof learnOperation> {
  try {
    return learnOperation(input);
  } catch (e) {
    // Only the page's own documents: an ad's or widget's iframe (a reCAPTCHA frame) is not the page.
    const docs = run.exchanges.filter((x) => x.resourceType === "document" && x.response);
    const own = docs.length ? siteOf(new URL(docs[0]!.request.url).hostname) : undefined;
    const doc = docs.filter((x) => siteOf(new URL(x.request.url).hostname) === own).at(-1);
    const wall =
      doc?.response &&
      botWall({ status: doc.response.status, headers: doc.response.headers, body: doc.response.body ?? "" });
    if (wall)
      throw new Error(
        `the page served a bot challenge (${wall}): ask the user to run api-anything login ${site} --window and clear it, then add again (learning said: ${(e as Error).message})`,
      );
    const asked = input.readOnly && run.dialogs?.find((d) => d.type === "confirm" && !d.accepted);
    if (asked)
      throw new Error(
        `${(e as Error).message}. The page asked to confirm ${atStep(asked.step)} and a read never confirms: if what it asks about is a write, add it with --write`,
      );
    throw e;
  }
}

/** The recipe finds data in this body (a non-empty list, or a value). */
function resolves(spec: ResponseSpec, body: string | undefined): boolean {
  if (!body) return false;
  try {
    const d = extract(spec, body);
    return d !== undefined && d !== null && !(Array.isArray(d) && !d.length);
  } catch {
    return false;
  }
}

/** The data the op's recipe reads from an answer, as JSON; undefined when it is no data, or empty. */
function answerOf(op: Operation, r: Observed | undefined): string | undefined {
  if (!r) return undefined;
  const j = judge(op, r);
  if (j.class !== "ok" || j.data === undefined || j.data === null || (Array.isArray(j.data) && !j.data.length))
    return undefined;
  return JSON.stringify(j.data);
}

const observed = (e: Exchange | undefined): Observed | undefined =>
  e?.response
    ? { status: e.response.status, headers: e.response.headers, body: e.response.body ?? "", url: e.request.url }
    : undefined;

/** Both runs answered, through the op's recipe, with the same data, and it is not empty. */
function sameAnswer(op: Operation, run1: Exchange, run2: Exchange | undefined): boolean {
  const one = answerOf(op, observed(run1));
  return one !== undefined && one === answerOf(op, observed(run2));
}

/**
 * The params among `changed` whose value from example 2, sent alone in example 1's args, left the
 * answer as example 1's: one tier-1 read per param, at the site's pace. A probe that does not answer
 * ok says nothing, so its param is not named. Reads only: a write is never sent to learn it.
 */
async function ignoredAlone(
  op: Operation,
  ex1: Args,
  ex2: Args,
  changed: string[],
  run1: Exchange,
  session: Session,
  opts: { site: string; fetchImpl?: typeof fetch },
): Promise<string[]> {
  const one = answerOf(op, observed(run1));
  if (one === undefined) return [];
  const ignored: string[] = [];
  for (const k of changed) {
    try {
      const sent = await sendDerived(op, { ...ex1, [k]: ex2[k] }, session, opts);
      if (answerOf(op, sent) === one) ignored.push(k);
    } catch {
      /* a probe that failed proves nothing */
    }
  }
  return ignored;
}

function previewOf(data: unknown): AddResult["preview"] {
  const first = Array.isArray(data) ? data[0] : data;
  const cut = capOutput(first, 600);
  return { ...(Array.isArray(data) ? { count: data.length } : {}), first: cut.data };
}

type Recipe = NonNullable<AddInput["response"]>;

/** A learned response spec with the caller's recipe on top; an html or embedded recipe sets the format. */
const withRecipe = (learned: ResponseSpec, r: Recipe): ResponseSpec => ({
  ...learned,
  ...r,
  ...(r.html ? { format: "html" as const } : {}),
  ...(r.embedded ? { format: "embedded" as const } : {}),
});

/** Learning's warnings, minus "the response is HTML: add a recipe" when one was given. */
const recipeWarnings = (warnings: string[], r: Recipe) =>
  warnings.filter((w) => !((r.html ?? r.embedded) && w.startsWith("response is HTML")));

/**
 * The end of every add: judge the op on the answer it was learned from (a preview, or a warning that
 * says what to fix), then save it. `again`: the capture a fixed recipe can be tried on.
 */
function saveOperation(
  site: string,
  operation: Operation,
  exchange: Exchange | undefined,
  warnings: string[],
  session: Session,
  again: string | undefined,
): Omit<AddResult, "captures"> {
  let preview: AddResult["preview"];
  const res = exchange?.response;
  if (exchange && res) {
    const j = judge(operation, {
      status: res.status,
      headers: res.headers,
      body: res.body ?? "",
      url: exchange.request.url,
    });
    if (j.class === "ok") preview = previewOf(j.data);
    else if (learnedNothing(j)) {
      // A wall's request is not the op's (heal treats it the same way), and editing the recipe fixes nothing.
      throw new Error(
        `refusing to save ${operation.name}: the captured response is ${j.class}: ${j.reason}, so it was learned from ${j.class === "rate" ? "a throttled answer" : j.class === "error" ? "a server failure" : "a challenge or sign-in page"}, not the op's own answer. ` +
          (j.class === "rate" || j.class === "error"
            ? "Wait a few minutes, then add again"
            : `Ask the user to run api-anything login ${site}${j.class === "blocked" ? " --window and clear the challenge" : ""}, then add again`),
      );
    } else
      warnings.push(
        `on the captured response this op says ${j.class}: ${j.reason}. Fix --extract/--pick/--html/--embedded and re-run add --from ${again} (no browser needed)`,
      );
  }

  const allowed = new Set((operation.public ?? []).map((h) => `$.request.headers.${h}`));
  const secrets = scanSecrets(operation, credentialsOf(besideOrigins(session, opUrls(operation))), allowed).secrets;
  secrets.push(...signInFills(operation.trigger.steps).map((f) => `trigger ${f}`));
  if (secrets.length) throw new Error(`refusing to save a spec containing a credential: ${secrets.join("; ")}`);
  // Re-read under the lock: another add or a heal may have saved this site since we started.
  let replaced = false;
  const path = updateSite(site, (current) => {
    replaced = !!current?.operations.some((o) => o.name === operation.name);
    const fresh = { name: site, baseUrl: new URL(operation.trigger.url).origin, operations: [] };
    return putOperation(current ?? fresh, operation);
  });
  recordOrigins(site, opUrls(operation));
  clearStale(site, operation.name);
  return { operation, warnings, path, ...(preview ? { preview } : {}), replaced };
}

export async function addOperation(input: AddInput): Promise<AddResult> {
  const stood = standIn(input.paging, input.examples, input.from, input.from2);
  const i = { ...input, site: safeName(input.site), ...stood };
  const existing = loadSite(i.site)?.site;
  const old = existing?.operations.find((o) => o.name === i.op);
  const ex2 = i.examples[1];
  let ex1 = i.examples[0];
  // An existing op added again from a capture with no --example (a recipe being fixed) is the same
  // learning as any add, with what the command leaves out taken from the stored op: its examples, so
  // its params are never silently dropped; its recipe when no recipe flag is given; its description.
  // The capture must carry the example values where the op takes them.
  const prior = old && i.from && !Object.keys(ex1).length ? old : undefined;
  if (prior?.params.length) {
    const bare = prior.params.filter((p) => p.example === undefined).map((p) => p.name);
    if (bare.length)
      throw new Error(
        `${i.op} has no stored example for ${bare.join(", ")}: pass --example with the values capture ${i.from?.capture.id} was made with`,
      );
    ex1 = Object.fromEntries(prior.params.map((p) => [p.name, p.example as Args[string]]));
  }
  // Before any browser run: learned as a read, a write is sent while learning it, and then on every call.
  if (old && !old.readOnly && !i.write)
    throw new Error(
      `${i.op} is a write: learning it again needs --write${i.from ? ", and a capture made with --write" : ""}`,
    );
  // before any browser run: a too-short or duplicate example would only fail after it
  if (ex1) checkExamples(ex1, "example", ex2);
  if (ex2) checkExamples(ex2, "example 2", ex1);
  // What a param allows, which no capture tells: the stored op's, with the add's own on top. The examples must fit it.
  const allowedOf = (name: string): Allowed => {
    const was = old?.params.find((p) => p.name === name);
    const kept = Object.fromEntries(KEPT.flatMap((k) => (was?.[k] !== undefined ? [[k, was[k]]] : [])));
    return { ...kept, ...i.allowed?.[name] };
  };
  for (const name of Object.keys(i.allowed ?? {}))
    if (!(name in ex1))
      throw new Error(`${name} is no param of ${i.op}; its params are ${Object.keys(ex1).join(", ") || "none"}`);
  for (const name of Object.keys(ex1)) {
    const a = allowedOf(name);
    if (a.min !== undefined && a.max !== undefined && a.min > a.max)
      throw new Error(`${name}'s min ${a.min} is above its max ${a.max}`);
    for (const [label, ex] of [
      ["example", ex1],
      ["example 2", ex2],
    ] as const) {
      const wrong = ex?.[name] !== undefined && refusal(a, asText(ex[name]));
      if (wrong)
        throw new Error(`${label} ${name}=${asText(ex![name])} is not a value ${name} allows: it must be ${wrong}`);
    }
  }
  for (const c of [i.from?.capture, i.from2]) {
    if (i.write && c && !c.write)
      throw new Error(
        `capture ${c.id} ran without --write, so any write in it was already sent; capture again with --write`,
      );
  }
  let trigger = i.trigger ?? (i.from && captureTrigger(i.from.capture, ex1));
  if (!trigger) throw new Error("a trigger url is needed (or --from a capture)");
  if (trigger.url.startsWith("/")) {
    if (!existing) throw new Error(`relative trigger ${trigger.url} needs an existing site; use a full URL`);
    trigger = { ...trigger, url: existing.baseUrl.replace(/\/$/, "") + trigger.url };
  }
  // a cursor is no part of the page's address: it is the site's answer to an earlier page
  const missing = unplaced(trigger, ex1).filter((k) => !(i.paging?.next && k === i.paging.param));

  let run1: CaptureResult;
  let run2: CaptureResult | undefined;
  const captures: string[] = [];
  // what a read's runs stopped and the add goes on without: off the page's site, or beside a pinned --match
  const stops: string[] = [];
  if (i.from) {
    run1 = i.from.capture;
    run2 = i.from2;
    if (!i.write)
      for (const c of [i.from.capture, i.from2])
        if (c && !c.write)
          for (const label of Object.values(stoppedIn(c, c.url)).flat()) if (!stops.includes(label)) stops.push(label);
  } else {
    const run = async (a: Args) => {
      const t = fillTrigger(trigger!, a);
      const r = await runTrigger({
        ...t,
        profileDir: profileDir(),
        intercept: i.write
          ? writeGuard(i.match, { url: t.url, args: a })
          : t.steps?.length
            ? learnGuard(i.match)
            : undefined,
        confirm: i.write ? () => true : undefined,
      });
      const saved = saveCapture({ url: t.url, steps: t.steps, softFrom: t.softFrom, write: i.write }, r);
      captures.push(saved.id);
      if (!i.write) {
        // Before the next run, which would only be stopped again, and before anything is saved.
        const { site, elsewhere } = stoppedIn(r, t.url);
        const pinned = !!i.match && Object.keys(i.match).length > 0;
        if (site.length && !pinned) throw new Error(`${stoppedHint(site, "add it again")}. ${i.op} was not saved`);
        for (const label of [...(pinned ? site : []), ...elsewhere]) if (!stops.includes(label)) stops.push(label);
      }
      return saved;
    };
    run1 = await run(ex1);
    const wall = loginWall(run1, fillTrigger(trigger, ex1).url);
    if (wall)
      throw new Error(
        `the trigger landed on a sign-in page (${wall}): the site needs an account. Ask the user to run: api-anything login ${i.site}; then add again`,
      );
    run2 = await run(ex2 ?? ex1);
  }
  const flags = i.response ?? {};
  const kept = prior?.response;
  const r: Recipe =
    kept && !Object.values(flags).some((x) => x !== undefined)
      ? { extract: kept.extract, pick: kept.pick, html: kept.html, embedded: kept.embedded }
      : flags;
  const spec: ResponseSpec = { format: r.html ? "html" : r.embedded ? "embedded" : "json", ...r };
  const learn = () =>
    learnOrExplain(i.site, run1, {
      exchanges: run1.exchanges,
      pages: capturePages(run1),
      exchanges2: run2?.exchanges,
      examples: run2 ? [ex1, ex2 ?? ex1] : [ex1],
      cookies: (run2 ?? run1).cookies,
      storage: { ...run2?.storage, ...run1.storage },
      match: i.match,
      id: i.from?.id,
      name: i.op,
      trigger,
      readOnly: !i.write,
      loginCookies: existing?.loginCookies,
      guestCookies: loadSession(i.site).guestCookies,
      public: i.public,
      // With a response recipe, the request it resolves on is the answer (not a beacon echoing the page URL).
      ...(r.html || r.embedded || r.extract ? { accepts: (e: Exchange) => resolves(spec, e.response?.body) } : {}),
    });
  let learned: ReturnType<typeof learn>;
  // said when the stored examples do not fit the capture
  const stored = () =>
    `No --example was given, so ${i.op}'s stored ones were used (${Object.entries(ex1)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}): pass --example with the values capture ${i.from?.capture.id} was made with`;
  try {
    learned = learn();
  } catch (e) {
    if (!prior?.params.length) throw e;
    throw new Error(`${(e as Error).message}. ${stored()}`);
  }
  // A stored value may sit in the capture by chance (the op's example user as the viewer of another's
  // page): bound there, the param would fill the wrong place from then on.
  const places = (o: Operation) =>
    o.slots
      .filter((s) => s.param)
      .map((s) => `${s.param} at ${s.at.join(" > ")}`)
      .sort();
  if (prior?.params.length && places(prior).join("; ") !== places(learned.operation).join("; "))
    throw new Error(
      `request ${learned.exchange.id} carries the stored example values in other places (${places(learned.operation).join("; ")}) than ${i.op} takes them (${places(prior).join("; ")}). ${stored()}`,
    );
  // What a --write capture aborted, its guard stopped as a write: that is the evidence, not the
  // method (a POST it let through is a read) and not the name the op is given.
  if (!i.write && learned.exchange.aborted && i.from?.capture.write)
    throw new Error(
      `capture ${i.from.capture.id} was made with --write and intercepted request ${learned.exchange.id} as a write: learning it needs --write`,
    );
  // The same for the second capture: the request the diff read from it, which a replay check may then be sent against.
  if (!i.write && learned.exchange2?.aborted && i.from2?.write)
    throw new Error(
      `capture ${i.from2.id} was made with --write and intercepted request ${learned.exchange2.id} as a write: learning it needs --write`,
    );
  // Without --write, an aborted request is one a read's guard stopped: it never left, so it has no answer to learn.
  if (!i.write && (learned.exchange.aborted || learned.exchange2?.aborted)) {
    const e = learned.exchange.aborted ? learned.exchange : learned.exchange2!;
    const method = e.request.method.toUpperCase();
    throw new Error(
      `request ${e.id} (${requestLabel(e, siteOfUrl(trigger.url))}) was stopped in the browser as a possible write, so it has no answer to learn. ` +
        pinHint(method, `${new URL(e.request.url).pathname}${i.from ? " and --trigger instead of --from" : ""}`),
    );
  }
  const notRead = i.readsOnly && !i.write ? notARead(learned.operation) : undefined;
  if (notRead)
    throw new NotARead(
      `request ${learned.exchange.id} (${learned.operation.request.method} ${learned.operation.request.url.split("?")[0]}) is not a read: ${notRead}`,
    );
  const warnings = recipeWarnings(learned.warnings, r);
  if (stops.length)
    warnings.push(
      `the steps also sent ${stops.join(", ")}, stopped in the browser (nothing was sent): learned without ${stops.length > 1 ? "them" : "it"}`,
    );
  if (missing.length)
    warnings.push(
      `the trigger has no {${missing.join("}, {")}}: tier-3 runs and heals would load the example's page; put the param in --trigger`,
    );
  // Learned again with nothing new said about it, an op keeps what this one capture cannot tell: its
  // description, and a tier an earlier two-run diff raised (--description "" clears the first).
  const description = i.description ?? prior?.description;
  // The confirms a write's runs accepted (intercepted, so nothing was sent), for its tier-3 calls to
  // accept again; a read keeps none. Derived from the runs alone, never carried over.
  const { confirms: _given, companions: _was, ...asTriggered } = learned.operation.trigger;
  const confirms = i.write ? acceptedConfirms(run1, ex1) : [];
  if (i.write && run2 && JSON.stringify(acceptedConfirms(run2, ex2 ?? ex1)) !== JSON.stringify(confirms))
    warnings.push(
      "the page's confirm dialogs differ between the two runs by more than the example values (another question, step or count): a tier-3 call accepts only the ones run 1 saw, asked the same way, and dismisses any other",
    );
  // The other unsafe requests a write's runs sent, which its tier-3 calls let out beside it; any other is stopped.
  // Derived from the runs alone, like the confirms, and kept as an empty list too: absent means learned before this.
  const { companions, dropped } = i.write
    ? companionsOf(learned.operation, [[run1, ex1], ...(run2 ? ([[run2, ex2 ?? ex1]] as [CaptureResult, Args][]) : [])])
    : { companions: undefined, dropped: 0 };
  if (dropped)
    warnings.push(
      `the trigger sent ${dropped} more unsafe requests than the ${LIMITS.companions} recorded as companions: a tier-3 call stops those`,
    );
  // Learned again, an op also keeps what its params allow, and the checks whose args are all still params.
  const params = learned.operation.params.map((p) => ({ ...p, ...allowedOf(p.name) }));
  const checks = old?.checks?.filter((c) => Object.keys(c.args).every((k) => params.some((p) => p.name === k)));
  let operation: Operation = {
    ...learned.operation,
    trigger: { ...asTriggered, ...(confirms.length ? { confirms } : {}), ...(companions ? { companions } : {}) },
    ...(description ? { description } : {}),
    ...(prior && !run2 && prior.minTier > learned.operation.minTier ? { minTier: prior.minTier } : {}),
    response: withRecipe(learned.operation.response, r),
    params,
    ...(checks?.length && !i.write ? { checks } : {}),
    ...(old?.links ? { links: old.links } : {}),
  };
  if (stood) operation = stood.restore(operation);
  // Paging and a readback are the caller's contract too: kept while they still fit the op learned again.
  const paging = i.paging ?? old?.paging;
  if (paging && !i.write) {
    // A cursor is left out for the first page, which is also what verify starts from: a captured
    // cursor is no example (it can expire, or carry the session it was made for).
    const paged: Operation = {
      ...operation,
      paging,
      params: params.map((p) => {
        if (!paging.next || p.name !== paging.param) return p;
        const { example: _captured, ...cursor } = p;
        return { ...cursor, required: false };
      }),
    };
    const problems = pagingProblems(paged);
    if (i.paging && problems.length) throw new Error(`--paging: ${problems.join("; ")}`);
    if (!problems.length) operation = paged;
  }
  if (
    old?.readback &&
    i.write &&
    existing &&
    !readbackProblems(existing, { ...operation, readback: old.readback }).length
  )
    operation = { ...operation, readback: old.readback };
  const session = mergeCapture(
    i.site,
    (run2 ?? run1).cookies,
    { from: learned.operation.request.url, values: learned.sessionValues },
    {
      settings: learned.settings,
      urls: opUrls(learned.operation),
    },
  );

  // Values that differ between two page loads are often session-scoped ids, not per-request
  // signatures. One replay of run 1's template with example 2's args tells them apart.
  if (operation.minTier === 3 && operation.readOnly && run2) {
    try {
      const sent = await sendDerived(operation, ex2 ?? ex1, session, { site: i.site, fetchImpl: i.fetchImpl });
      if (judge(operation, sent).class === "ok") {
        operation = { ...operation, minTier: 1 };
        warnings.push(
          "...but run 1's template replays fine with example 2's args, so those values are session-scoped: minTier 1",
        );
      }
    } catch {
      /* keep minTier 3 */
    }
  }

  // The second run proves its args reach the request, not that the server reads them there. A cursor is
  // the site's answer to an earlier page, not a param to prove: another run's cursor sent with example 1's
  // args proves nothing, and its value must not reach the spec through a reason.
  const cursor = (i.paging ?? old?.paging)?.next ? (i.paging ?? old?.paging)!.param : undefined;
  const changed = Object.keys(ex1).filter(
    (k) => k !== cursor && ex2?.[k] !== undefined && asText(ex2[k]) !== asText(ex1[k]),
  );
  if (ex2 && changed.length && operation.readOnly) {
    const values = (ks: string[]) => ks.map((k) => `${k}=${asText(ex2[k])}`).join(", ");
    let doubted: string[] = [];
    let reason = "";
    if (sameAnswer(operation, learned.exchange, learned.exchange2)) {
      doubted = changed;
      reason = `example 2 (${values(changed)}) was answered with example 1's data`;
    } else if (changed.length > 1 && operation.minTier === 1) {
      // Two answers that differ because one param changed hide another the server ignores (a `page`
      // next to a `q`): each changed param is sent alone in example 1's args, and must change the answer by itself.
      doubted = await ignoredAlone(operation, ex1, ex2, changed, learned.exchange, session, {
        site: i.site,
        fetchImpl: i.fetchImpl,
      });
      if (doubted.length)
        reason = `example 1's args with only ${values(doubted)} from example 2 ${doubted.length > 1 ? "were" : "was"} answered with example 1's data`;
    }
    if (doubted.length) {
      operation = { ...operation, unproven: { params: doubted, reason } };
      warnings.push(
        `${reason}: the server may not read ${doubted.join(", ")} from this request (it may go by a cookie, the IP or the page it was loaded from). ` +
          `If the two examples just have the same answer, add it again with an example 2 whose ${doubted.join(", ")} alone excludes something example 1 returned (another place, a filter value one of its rows fails). ` +
          `Until then publish refuses ${operation.name}`,
      );
    }
  }

  const again = captures[0] ?? i.from?.capture.id;
  const saved = saveOperation(i.site, operation, learned.exchange, warnings, session, again);
  rememberTier(i.site, operation.name, undefined);
  return { ...saved, captures };
}

/* ---------------------------------------------------------------- rescan */

const CHARSET: Record<Volatile["shape"]["charset"], [string, string]> = {
  // [token chars, chars that must not touch the token]
  digits: ["0-9", "0-9A-Za-z_"],
  hex: ["0-9a-fA-F", "0-9A-Za-z_"],
  base64url: ["A-Za-z0-9_-", "A-Za-z0-9_-"],
  base64: ["A-Za-z0-9+/=", "A-Za-z0-9+/="],
};
const NEAR = 300;

/**
 * Whether text between a token and its anchor (read left to right) keeps them in one group: no
 * bracket closes the group the scan started in, and no `;` ends a statement at that level. Meta's
 * `}),null);__d(` and X's `}},13:e=>{` end the previous module; a `"use strict";` nested inside the
 * anchor's own module does not.
 * ponytail: brackets inside string literals count too; a bundle string holding `}` could mislead it.
 */
function sameGroup(between: string): boolean {
  let depth = 0;
  for (const c of between) {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth < 0) return false;
    } else if (c === ";" && depth === 0) return false;
  }
  return true;
}

/**
 * The token of the recorded shape next to the anchor. The anchor must stand as its own name
 * ("Followers" is not inside "FollowersYouKnow"), and an occurrence in code beats one in prose
 * (a log message "B failed", whitespace next to it). A token in the anchor's own group beats a
 * nearer one across a module boundary; a tie between two tokens is no answer.
 * `strict` (writes, whose validation is a real send): only a token that is the one candidate.
 */
function nearestToken(texts: string[], v: Volatile, strict = false): string | undefined {
  const [chars, bound] = CHARSET[v.shape.charset];
  const re = new RegExp(`(?<![${bound}])[${chars}]{${v.shape.length}}(?![${bound}])`, "g");
  const anchor = new RegExp(`(?<![A-Za-z0-9$])${escapeRe(v.anchor)}(?![A-Za-z0-9$])`, "g");
  const found: { token: string; d: number; same: boolean; prose: boolean }[] = [];
  for (const text of texts) {
    for (const a of text.matchAll(anchor)) {
      const i = a.index;
      const from = Math.max(0, i - NEAR);
      const anchorEnd = i + v.anchor.length;
      const prose = /\s/.test(text[i - 1] ?? "") || /\s/.test(text[anchorEnd] ?? "");
      for (const m of text.slice(from, anchorEnd + NEAR).matchAll(re)) {
        const token = m[0];
        if (v.shape.charset !== "digits" && !hashLike(token)) continue;
        const start = from + m.index;
        const end = start + token.length;
        if (end > i && start < anchorEnd) continue; // overlaps the anchor itself
        const between = end <= i ? text.slice(end, i) : text.slice(anchorEnd, start);
        found.push({ token, d: between.length, same: sameGroup(between), prose });
      }
    }
  }
  const code = found.some((f) => !f.prose) ? found.filter((f) => !f.prose) : found;
  const pool = code.some((f) => f.same) ? code.filter((f) => f.same) : strict ? [] : code;
  if (strict) {
    const distinct = new Set(pool.map((f) => f.token));
    return distinct.size === 1 ? [...distinct][0] : undefined;
  }
  const best = Math.min(...pool.map((f) => f.d));
  const tied = new Set(pool.filter((f) => f.d === best).map((f) => f.token));
  return tied.size === 1 ? [...tied][0] : undefined;
}

/**
 * A page's text and where it ended up, for the rescan. Redirects are taken by hand (as many as a plain fetch would follow) so
 * that `off` is asked about every address before it is fetched: one it rules out is not fetched,
 * and the text is empty.
 */
async function fetchText(
  url: string,
  headers: (url: string) => Record<string, string>,
  fetchImpl: typeof fetch,
  off: (url: string) => boolean,
): Promise<{ text: string; url: string }> {
  try {
    const signal = AbortSignal.timeout(15_000);
    for (let hops = 0; hops <= MAX_REDIRECTS && !off(url); hops++) {
      const r = await fetchImpl(url, { headers: headers(url), redirect: "manual", signal });
      const location = REDIRECT.has(r.status) ? r.headers.get("location") : null;
      if (!location) return { text: r.ok ? await r.text() : "", url };
      await r.body?.cancel();
      url = new URL(location, url).href;
    }
  } catch {
    /* unreachable, or too slow: no clues from it */
  }
  return { text: "", url };
}

/**
 * Browserless heal: fetch the trigger document and the scripts it references, and swap in the
 * token of each volatile's shape nearest its anchor. Undefined when nothing new was found.
 * For a write, no address that is the write itself is fetched, at first or after a redirect (a GET
 * vote link is its own trigger): a plain fetch would perform it, with nothing to intercept it. The
 * rescan then finds nothing, and the recapture, which intercepts, does the work.
 */
export async function rescan(
  site: string,
  op: Operation,
  args: Args,
  fetchImpl: typeof fetch = fetch,
): Promise<{ operation: Operation; diff: string } | undefined> {
  if (!op.volatile.length) return undefined;
  const session = loadSession(site);
  const url = fillTrigger(op.trigger, args).url;
  const headers = (u: string) => {
    const h: Record<string, string> = {};
    const ua = op.request.headers["user-agent"];
    const cookie = cookieHeaderFor(session.cookies, u);
    if (ua) h["user-agent"] = ua;
    if (cookie) h.cookie = cookie;
    return h;
  };
  const theWrite = (u: string) => !op.readOnly && matches(ownMatch(op), { method: "GET", url: u, headers: {} });
  const { text: doc, url: docUrl } = await fetchText(url, headers, fetchImpl, theWrite);
  if (!doc) return undefined;
  // relative to the document's final URL: a redirect (a locale prefix) moves where "../static" points
  const refs = [
    ...doc.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ...doc.matchAll(/<link\b[^>]*\bhref=["']([^"']+\.m?js(?:\?[^"']*)?)["']/gi),
  ].map((m) => new URL(m[1]!, docUrl).href);
  // ponytail: only scripts the document references directly; ids in lazily loaded chunks need recapture.
  const scripts = await Promise.all(
    [...new Set(refs)].slice(0, 40).map(async (s) => (await fetchText(s, headers, fetchImpl, theWrite)).text),
  );
  const texts = [doc, ...scripts];

  const types = new Map(walk(op.request).map((l) => [JSON.stringify(l.at), l.type]));
  let request = op.request;
  const changes: string[] = [];
  for (const v of op.volatile) {
    const old = asText(getAt(op.request, v.at));
    const token = nearestToken(texts, v, !op.readOnly);
    if (!token || token === old) continue;
    const numeric = types.get(JSON.stringify(v.at)) === "number";
    request = setAt(request, v.at, numeric ? BigInt(token) : token);
    changes.push(`${v.at.join(" > ")}: ${old} -> ${token}`);
  }
  return changes.length ? { operation: { ...op, request }, diff: changes.join("; ") } : undefined;
}

/* -------------------------------------------------------------- recapture */

/** The wire template with these args filled in, so the example values an op was learned with don't count as a change. */
function template(op: Operation, args: Args): string {
  let req = op.request;
  try {
    // one seed for both sides: generated values are no change
    req = buildRequest(op, args, { cookies: [], values: {} }, "");
  } catch {
    /* compare raw */
  }
  return JSON.stringify([req, op.slots, op.volatile]);
}

/** The op's request with each slot's `{param}` or ref template in its place: a change shows those, not values. */
function placeholders(op: Operation): Operation["request"] {
  let req = op.request;
  for (const s of op.slots) {
    try {
      req = setAt(req, s.at, s.template ?? `{${s.param ?? s.ref ?? (s.path ? `lookup:${s.path}` : s.gen)}}`);
    } catch {
      /* position gone; the leaf shows as it is */
    }
  }
  return req;
}

const MAX_CHANGES = 12;
const shown = (v: string) => JSON.stringify(v.length > 80 ? `${v.slice(0, 77)}...` : v);

/**
 * What changed in the wire template from `a` to `b`, one line each: the method, origin and path, then
 * every query, header, form and body leaf added, removed or changed (`header:x-app-version: "1" -> "2"`).
 */
export function templateChanges(a: Operation, b: Operation): string[] {
  const [ra, rb] = [placeholders(a), placeholders(b)];
  const out: string[] = [];
  if (ra.method !== rb.method) out.push(`method: ${ra.method} -> ${rb.method}`);
  const parts = (url: string) => /^([^:/?#]+:\/\/[^/?#]*)([^?#]*)/.exec(url) ?? ["", url, ""];
  const [, oa = "", pa = ""] = parts(ra.url);
  const [, ob = "", pb = ""] = parts(rb.url);
  if (oa !== ob) out.push(`origin: ${oa} -> ${ob}`);
  if (pa !== pb) out.push(`path: ${pa} -> ${pb}`);
  // a JSON body's own leaves say more than the whole text; path segments are said above
  const leaves = (req: Operation["request"]) =>
    new Map(
      walk(req)
        .filter((l) => !l.container && !l.at[0]!.startsWith("path:"))
        .map((l) => [l.at.join(" > "), l.value]),
    );
  const [la, lb] = [leaves(ra), leaves(rb)];
  for (const [at, v] of la) {
    if (!lb.has(at)) out.push(`${at}: removed (was ${shown(v)})`);
    else if (lb.get(at) !== v) out.push(`${at}: ${shown(v)} -> ${shown(lb.get(at)!)}`);
  }
  for (const [at, v] of lb) if (!la.has(at)) out.push(`${at}: added ${shown(v)}`);
  if (!out.length) out.push("the request reads the same: only how a param is filled changed");
  return out.length > MAX_CHANGES
    ? [...out.slice(0, MAX_CHANGES - 1), `and ${out.length - MAX_CHANGES + 1} more`]
    : out;
}

export type HealResult =
  | {
      outcome: "healed";
      strategy: "rescan" | "recapture";
      operation: Operation;
      attempt: Attempt;
      /** what changed in the template; see templateChanges */
      changes: string[];
    }
  | {
      outcome: "identical" | "failed";
      reason: string;
      /** the last validation replay, if one ran */
      attempt?: Attempt;
      /** reads: the site's own response from the recapture run (the tier-3 answer) */
      fallback?: Attempt;
      /**
       * nothing was learned about the op: the site throttled or challenged the check, the session
       * is logged out, or the browser could not start. Not a reason to mark the op stale.
       */
      transient?: boolean;
    };

// A check answered with these, or with the server's own failure, says nothing about the candidate:
// stop, and don't spend a browser run on it.
const STOP: ReadonlySet<Class> = new Set(["rate", "blocked", "auth"]);
export const learnedNothing = (a: Pick<Attempt, "class" | "server">) => STOP.has(a.class) || !!a.server;

function saveHealed(
  site: string,
  before: Operation,
  op: Operation,
  strategy: "rescan" | "recapture",
  attempt: Attempt,
): HealResult {
  const allowed = new Set((op.public ?? []).map((h) => `$.request.headers.${h}`));
  const secrets = scanSecrets(op, credentialsOf(besideOrigins(loadSession(site), opUrls(op))), allowed).secrets;
  if (secrets.length)
    return {
      outcome: "failed",
      reason: `refusing to save a healed spec containing a credential: ${secrets.join("; ")}`,
    };
  // a healed op is no longer the registry version it was; the heal-back (share.ts) may upload it as a new one
  const { version: _v, ...healed } = op;
  updateSite(site, (current) => {
    if (!current) throw new Error(`site "${site}" disappeared during heal`);
    return putOperation(current, healed);
  });
  recordOrigins(site, opUrls(op));
  const changes = templateChanges(before, op);
  appendHeal({
    site,
    op: op.name,
    strategy,
    diff: changes.join("; "),
    changes,
    previous: before,
    saved: templateHash(healed),
  });
  clearStale(site, op.name);
  return { outcome: "healed", strategy, operation: op, attempt, changes };
}

/**
 * Put back the op as it was before its last heal that is not reverted yet, from heals.jsonl. Refused
 * when no heal kept it, or when the op changed since (learned again, edited): that is newer work. A
 * pulled spec's user copy keeps its `shared` record, and the op gets back the registry version it was.
 */
export function revertHeal(siteName: string, name: string): { site: string; reverted: HealRecord; changes: string[] } {
  const r = loadSite(siteName);
  if (!r) throw new Error(`no site "${siteName}"`);
  const site = r.site.name;
  const current = r.site.operations.find((o) => o.name === name);
  if (!current) throw new Error(`no operation "${name}" on ${site}`);
  // a revert takes back the newest heal it finds; a second one, the heal before that
  const open: HealRecord[] = [];
  for (const h of loadHeals(site)) if (h.op === name) h.strategy === "revert" ? open.pop() : open.push(h);
  const last = open.at(-1);
  if (!last) throw new Error(`${name} on ${site} has no heal to revert`);
  if (!last.previous) throw new Error(`the last heal of ${name} (${last.at}) was logged without the op as it was`);
  if (last.saved && last.saved !== templateHash(current))
    throw new Error(
      `${name} changed after its last heal (${last.at}): learned again or edited, so reverting would undo that; nothing changed`,
    );
  const previous = OperationSchema.parse(last.previous);
  const swap = (s: Site): Site => ({ ...s, operations: s.operations.map((o) => (o.name === name ? previous : o)) });
  if (r.site.shared) {
    const { errors } = vetShared(swap(r.site));
    if (errors.length) throw new Error(`the op as it was fails today's shared rules: ${errors.join("; ")}`);
  }
  updateSite(site, (cur) => swap(cur ?? r.site));
  const changes = templateChanges(current, previous);
  appendHeal({
    site,
    op: name,
    strategy: "revert",
    diff: changes.join("; "),
    changes,
    previous: current,
    saved: templateHash(previous),
  });
  clearStale(site, name);
  return { site, reverted: last, changes };
}

const withDefaults = (op: Operation, args: Args): Args => {
  const out: Args = {};
  for (const p of op.params) {
    const v = args[p.name] ?? p.default;
    if (v !== undefined) out[p.name] = v;
  }
  return out;
};

/** Args the learner can locate: every param present, values distinct and 3+ chars. */
function learnable(op: Operation, a: Args): boolean {
  if (op.params.some((p) => a[p.name] === undefined)) return false;
  try {
    checkExamples(a, "args");
    return true;
  } catch {
    return false;
  }
}

/**
 * Rescan, then recapture; a candidate is saved only after `validate` (a replay) says ok.
 * A write's validation is the write itself, so a write gets exactly one validation in total.
 * Recapture learns from the call's args (defaults filled) when they can be located, else from the
 * op's examples, so a short arg ("page=2") or an omitted optional one never loses a slot.
 */
export async function healOperation(
  site: string,
  op: Operation,
  args: Args,
  o: {
    validate: (candidate: Operation) => Promise<Attempt>;
    fetchImpl?: typeof fetch;
    loginCookies?: string[];
    browser?: boolean;
  },
): Promise<HealResult> {
  let budget = op.readOnly ? 2 : 1;
  let last: Attempt | undefined;
  const callArgs = withDefaults(op, args);

  // A rescan sends a token it found in the site's own pages to the op's request URL before any check
  // runs, so someone else's spec, which chose that URL, heals by recapture only.
  const scanned = loadSite(site)?.site.shared
    ? undefined
    : await rescan(site, op, callArgs, o.fetchImpl).catch(() => undefined);
  const swapped = scanned ? `rescan swapped ${scanned.diff}, replay said ${"%s"}` : "";
  if (scanned) {
    budget--;
    last = await o.validate(scanned.operation);
    if (last.class === "ok") return saveHealed(site, op, scanned.operation, "rescan", last);
    if (learnedNothing(last))
      return { outcome: "failed", attempt: last, transient: true, reason: swapped.replace("%s", last.reason) };
    if (!budget) return { outcome: "failed", attempt: last, reason: swapped.replace("%s", last.reason) };
  }
  const tried = scanned ? swapped.replace("%s", last!.reason) : "rescan found nothing new";
  if (o.browser === false)
    return {
      outcome: "failed",
      attempt: last,
      reason: `${tried}; recapture needs the browser, which this call does not run (maxTier 1, or an unconfirmed operation an agent pulled)`,
    };
  // nothing was learned about the op: once a browser is installed, the next call heals
  if (!browserAvailable())
    return {
      outcome: "failed",
      attempt: last,
      transient: true,
      reason: `${tried}; recapture needs a Chromium browser (Google Chrome, Brave, Edge or Chromium)`,
    };

  const examples = withDefaults(
    op,
    Object.fromEntries(op.params.flatMap((p) => (p.example !== undefined ? [[p.name, p.example]] : []))),
  );
  const learnArgs = learnable(op, callArgs) || !learnable(op, examples) ? callArgs : examples;
  let run: TriggerRun;
  try {
    run = await runOpTrigger(site, op, learnArgs, { intercept: !op.readOnly });
  } catch (e) {
    const reason = `the browser run failed: ${(e as Error).message.split("\n")[0]}`;
    // another process holds the profile: nothing about the op was learned
    if (e instanceof ProfileInUse)
      return {
        outcome: "failed",
        attempt: { tier: 3, class: "error", reason, hint: PROFILE_HINT },
        transient: true,
        reason,
      };
    // the page did not load: nothing it would have sent was seen
    if (e instanceof PageUnreachable)
      return { outcome: "failed", attempt: { tier: 3, class: "error", reason, server: true }, transient: true, reason };
    return { outcome: "failed", attempt: last, reason };
  }
  const wall = run.matched ? undefined : challengePage(run.capture);
  if (wall) return { outcome: "failed", attempt: wall, transient: true, reason: wall.reason };
  if (!run.matched && run.loginWall) {
    return {
      outcome: "failed",
      transient: true,
      attempt: { tier: 3, class: "auth", reason: `the trigger landed on a sign-in page (${run.loginWall})` },
      reason: `the trigger landed on a sign-in page (${run.loginWall})`,
    };
  }
  if (!run.capture.exchanges.some((e) => matches(op.match, e.request))) {
    const down = pageDown(run.capture);
    if (down) return { outcome: "failed", attempt: down, transient: true, reason: down.reason };
    return {
      outcome: "failed",
      attempt: last,
      reason: firedNothing(op, run.capture),
    };
  }
  const seen = run.matched && judgeExchange(op, run.matched);
  if (seen && learnedNothing(seen))
    return {
      outcome: "failed",
      attempt: seen,
      transient: true,
      reason: `the site's own request says ${seen.class}: ${seen.reason}`,
    };
  // The site's own answer is this call's answer only when the trigger ran with this call's args.
  const fallback = op.readOnly && learnArgs === callArgs && run.matched ? judgeExchange(op, run.matched) : undefined;
  let fresh: Operation;
  let sessionValues: Record<string, string>;
  let settings: string[];
  // Where the op fills each param: a place the page filled with its own value can keep it (learn's paramSlots).
  const was = walk(op.request);
  const wasThere = new Map(was.map((l) => [JSON.stringify(l.at), l]));
  const own = op.slots.filter((slot) => slot.param || slot.template);
  const placed = new Set(own.map((slot) => JSON.stringify(slot.at)));
  const established = own.flatMap((slot) => {
    const leaf = wasThere.get(JSON.stringify(slot.at));
    if (!leaf) return [];
    const pattern = op.params.find((p) => p.name === slot.param)?.pattern;
    const around = arrayAround(was, slot.at, placed);
    return [
      {
        slot,
        type: leaf.type,
        value: leaf.value,
        ...(pattern !== undefined ? { pattern } : {}),
        ...(around !== undefined ? { around } : {}),
      },
    ];
  });
  try {
    ({
      operation: fresh,
      sessionValues,
      settings,
    } = learnOperation({
      exchanges: run.capture.exchanges,
      pages: capturePages(run.capture),
      examples: [learnArgs],
      cookies: run.capture.cookies,
      storage: run.capture.storage,
      match: op.match,
      name: op.name,
      trigger: op.trigger,
      readOnly: op.readOnly,
      loginCookies: o.loginCookies,
      guestCookies: loadSession(site).guestCookies,
      public: op.public,
      established,
      derived: op.slots.flatMap((s) => (s.from && s.path ? [{ at: s.at, path: s.path }] : [])),
    }));
  } catch (e) {
    return { outcome: "failed", attempt: last, fallback, reason: `re-learning failed: ${(e as Error).message}` };
  }
  // One run cannot show the page makes a value: a gen place that still holds a UUID, or that a ref took, stays one.
  const gens = op.slots.flatMap((s) => {
    const there = fresh.slots.find((f) => JSON.stringify(f.at) === JSON.stringify(s.at));
    if (!s.gen || there?.param !== undefined || there?.template !== undefined) return [];
    try {
      return there?.ref || UUID.test(asText(getAt(fresh.request, s.at))) ? [s.at] : [];
    } catch {
      return []; // the place is gone
    }
  });
  if (gens.length) {
    fresh = { ...fresh, ...asGenerated(fresh, gens, sessionValues) };
    settings = settings.filter((n) => n in sessionValues);
  }
  // A deploy that adds an auth/anti-bot header: its value is needed to validate (and later send) the candidate.
  mergeCapture(site, [], { from: fresh.request.url, values: sessionValues }, { settings, urls: opUrls(fresh) });
  // An arg equal to a constant the old template had there ("search" in /api/search) is not a param position.
  const oldLeaves = new Map(walk(op.request).map((l) => [JSON.stringify(l.at), l.value.toLowerCase()]));
  const oldSlots = new Set(op.slots.map((sl) => JSON.stringify(sl.at)));
  fresh = {
    ...fresh,
    slots: fresh.slots.filter((sl) => {
      if (!sl.param) return true;
      const k = JSON.stringify(sl.at);
      if (oldSlots.has(k)) return true;
      const now = asText(getAt(fresh.request, sl.at)).toLowerCase();
      return oldLeaves.get(k) !== now;
    }),
  };
  // The interface (params, trigger, match, what to extract) is the caller's contract; only the wire template heals.
  const pinned = pickedShape(op.response);
  const candidate: Operation = {
    ...fresh,
    description: op.description,
    params: op.params,
    trigger: op.trigger,
    match: op.match,
    readOnly: op.readOnly,
    ...(op.public ? { public: op.public } : {}),
    ...(op.checks ? { checks: op.checks } : {}),
    ...(op.paging ? { paging: op.paging } : {}),
    ...(op.links ? { links: op.links } : {}),
    ...(op.readback ? { readback: op.readback } : {}),
    ...(op.unproven ? { unproven: op.unproven } : {}),
    minTier: Math.max(op.minTier, fresh.minTier) as Operation["minTier"],
    response: {
      ...fresh.response,
      // the picked fields' learned types are the recipe's too: a candidate whose answer lacks one fails its replay
      ...(pinned ? { shape: { ...fresh.response.shape, ...pinned } } : {}),
      format: op.response.format,
      extract: op.response.extract,
      pick: op.response.pick,
      html: op.response.html,
      embedded: op.response.embedded,
    },
  };
  const lost = [...new Set(op.slots.flatMap((s) => (s.param ? [s.param] : [])))].filter(
    (p) => !candidate.slots.some((s) => s.param === p),
  );
  if (lost.length)
    return {
      outcome: "failed",
      attempt: last,
      fallback,
      reason: `re-learning found no place for ${lost.join(", ")}; not saved`,
    };
  // A moved parameter can heal; an inferred suffix/prefix is not proof of the caller's meaning.
  // Credential names may change during a repair without changing parameter encoding.
  const encoding = (s: Slot) =>
    JSON.stringify([s.template?.replace(/\{(?:cookie|session):[^{}]+\}/g, "{credential}"), s.escape]);
  const changedParam = candidate.slots.find(
    (s) =>
      s.param &&
      !/^header:(referer|origin|cookie)$/i.test(s.at[0]!) &&
      !op.slots.some((old) => old.param === s.param && encoding(old) === encoding(s)),
  );
  if (changedParam)
    return {
      outcome: "failed",
      attempt: last,
      fallback,
      reason: `re-learning changed the encoding of ${changedParam.param}; re-add the operation to confirm it`,
    };
  if (template(candidate, learnArgs) === template(op, learnArgs)) {
    return { outcome: "identical", fallback, reason: "re-learning produced a byte-identical template" };
  }
  last = await o.validate(candidate);
  if (last.class === "ok") return saveHealed(site, op, candidate, "recapture", last);
  return {
    outcome: "failed",
    attempt: last,
    fallback,
    ...(learnedNothing(last) ? { transient: true } : {}),
    reason: `recaptured template failed replay: ${last.reason}`,
  };
}
