/**
 * call(): the execution ladder (DESIGN.md "Execution ladder"), the classifier-driven actions,
 * the heal-loop guards, and the write rules. Always sends the stored template first; healing is
 * reactive only.
 */
import { randomBytes } from "node:crypto";
import {
  browserAvailable,
  type PageFetchResult,
  PageUnreachable,
  ProfileInUse,
  pageFetch,
  profileCookies,
} from "./browser.js";
import { type Class, judge } from "./classify.js";
import { asText, fillTemplate } from "./codec.js";
import { getPath } from "./extract.js";
import {
  type Attempt,
  challengePage,
  fillTrigger,
  firedNothing,
  type HealResult,
  healOperation,
  judgeExchange,
  learnedNothing,
  PROFILE_HINT,
  pageDown,
  profileDir,
  runOpTrigger,
  type TriggerRun,
  templateChanges,
} from "./heal.js";
import {
  AddressRefused,
  BadHeader,
  buildRequest,
  holdsRef,
  nextHop,
  pace,
  RedirectRefused,
  refusePrivate,
  refusePrivateHop,
  type Sent,
  unknownArgs,
  withDefaults,
} from "./http.js";
import { loadSettings } from "./identity.js";
import { derive, LookupFailed, sendDerived } from "./lookup.js";
import { type ResultCursor, type ResultView, resultView, viewProblem } from "./results.js";
import { redact } from "./secrets.js";
import {
  boundSession,
  dropUnbound,
  loadSession,
  loggedIn,
  mergeCapture,
  type Session,
  saveSession,
  sessionFile,
  withLock,
} from "./session.js";
import { type Operation, readbackName, type Site } from "./spec.js";
import {
  appendCall,
  BLOCKED_COOL_MS,
  beginWrite,
  type CoolDown,
  clearCoolDown,
  coolDown,
  cooling,
  lastHealAt,
  loadSite,
  markStale,
  PACE_JITTER,
  RATE_COOL_MS,
  type Resolved,
  rememberedTier,
  rememberTier,
  settleWrite,
  staleMark,
  type WriteGate,
  type WriteStatus,
} from "./store.js";
import type { StoredCookie } from "./types.js";
import { proofOp } from "./vet.js";

export type Tier = 1 | 2 | 3;

export interface CallOptions {
  /**
   * Call installed operations only: no learning/healing, registry traffic, reports, background work,
   * or everyday-browser cookie import. Specs stay unchanged; auth and drift point to CLI commands.
   * Keeps the transport ladder, own-profile sessions, ledger/readback and local call state.
   * Pacing cannot be lowered below one second, including jitter.
   */
  callOnly?: boolean;
  /** Shape the classified, extracted answer, never the site's arguments or stored recipe. */
  view?: ResultView;
  /** required for any readOnly:false op, at every entry point */
  allowWrites?: boolean;
  /**
   * send a write even though the same one (same args) was sent within the last 10 minutes and may
   * have gone through; only when the user checked the site and wants it sent again
   */
  again?: boolean;
  /**
   * a write's caller-chosen key: a repeat with the same key, while the first may have gone through,
   * returns that call's record instead of sending. It replaces the args check: calls with different
   * keys are different writes
   */
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
  /** highest transport tier to use (default 3); 1 also means no browser at all, so no recapture or cookie refresh */
  maxTier?: Tier;
  /** per-site gap between requests, ±30%, at every tier (default 1000) */
  minIntervalMs?: number;
  timeoutMs?: number;
  /**
   * @internal `verify`'s, no option of the CLI or MCP: told of the op the call's answer comes from, the
   * one it resolved (before its args are checked) and then a heal's or a registry version that answered
   * in its place, so a record names only the version that answered
   */
  onAnswered?: (op: Operation) => void;
  /** send even while the site cools down after a rate limit or a block (CLI --force); only when the user asks. Succeeding ends it */
  ignoreCoolDown?: boolean;
  /**
   * @internal `verify`'s: heal a read that drifted even while it is marked stale or healed minutes ago,
   * as `api-anything heal` does. The stored template is still sent first; only the guard is skipped
   */
  ignoreStale?: boolean;
}

export type { WriteStatus };

/**
 * Whether to send the same call again. `safe`: now, once. `after_wait`: after `retryAfterMs`, or a
 * few minutes without it. `after_fix`: once the `nextCall` step is done. `no`: not as it is: a write
 * that went through or may have (check the site first), or a call that would meet the same answer.
 */
export type Retry = "no" | "safe" | "after_wait" | "after_fix";

export type NextAction =
  | "retry"
  | "login"
  | "sign_in_browser"
  | "heal"
  | "relearn"
  | "fix_args"
  | "list_sites"
  | "check_site"
  | "allow_writes"
  | "raise_tier"
  | "install_browser"
  | "report";

/** The one step `next` describes, for a program: the CLI and MCP each name it in their own terms. */
export interface NextCall {
  action: NextAction;
  site?: string;
  op?: string;
  /** login: a visible window, for a challenge or a sign-in the user clears by hand */
  mode?: "window";
  /** raise_tier: the tier the call needs */
  tier?: Tier;
  /**
   * sign_in_browser: the everyday browser profile the session is imported from ("Chrome/Profile 1"),
   * where the user signs in again by hand. A re-import from it brought back the same login cookies, so
   * `login` would only import them once more; the call re-imports by itself on the retry.
   */
  profile?: string;
}

export interface CallResult {
  ok: boolean;
  /** `duplicate`: a write refused because the same one may already have gone through */
  class: Class | "refused" | "duplicate";
  /** extracted, picked, capped */
  data?: unknown;
  truncated?: string;
  resultId?: string;
  /** Local continuation of this answer, not the site's nextPage. */
  more?: ResultCursor;
  /**
   * reads with `paging.next` only: the value to pass as the op's paging param for the next page,
   * as the site's answer gave it
   */
  nextPage?: string | number;
  /** true with nextPage; false when the site's answer says this is the last page; absent when it says neither */
  hasMore?: boolean;
  tier?: Tier;
  healed?: boolean;
  /**
   * with healed: how, and what changed in the request template, one line each, with `{param}` and
   * cookie:/session: refs in place of values. `registry`: the registry's newer version of the op.
   * A rescan or recapture is undone with `api-anything revert <site> <op>`
   */
  heal?: { strategy: "rescan" | "recapture" | "registry"; changes: string[] };
  ms: number;
  reason?: string;
  /** what to do about a failure; follow it at most once */
  next?: string;
  /**
   * writes only, ok or not: `not_sent` nothing left; `not_applied` the site answered that it did not
   * run it; `accepted` a 2xx judged ok (proof the site took it, not that it took effect);
   * `may_have_applied` anything else that may have reached the site; `applied` the op's readback
   * found it after it was sent (always ok)
   */
  write?: WriteStatus;
  /** failures only; never `safe` or `after_wait` for a write that is accepted or may_have_applied */
  retry?: Retry;
  /** the wait the site asked for (Retry-After) */
  retryAfterMs?: number;
  /** failures only: `next` as data */
  nextCall?: NextCall;
  /** the server failed or could not be reached: the answer says nothing about the request or the args */
  server?: true;
  /** the site cools down after a rate limit or block: nothing was sent, so no version of the op answered */
  cooling?: true;
}

type Result = Omit<CallResult, "ms">;

const HEAL_GUARD_MS = 10 * 60_000;
/** A call-only call's least interval: its shortest jittered gap between two sends is still a second. */
const CALL_ONLY_INTERVAL_MS = 1000 / (1 - PACE_JITTER);
// A write is retried only when the server certainly did not run it; timeouts and 5xx are ambiguous.
const NOT_EXECUTED = new Set([400, 401, 403, 404]);
/**
 * Certainly not run: a 400/401/403/404 answered to the request itself. After a redirect
 * (Post/Redirect/Get) it ran. At tier 3 the page sent it and the answer judged may be a redirect's
 * follow-up, with nothing to tell the two apart: never proof.
 */
const notRun = (a?: Attempt) => a?.status !== undefined && NOT_EXECUTED.has(a.status) && !a.redirected && a.tier !== 3;

interface Ctx {
  site: string;
  args: Record<string, unknown>;
  opts: CallOptions;
  maxTier: Tier;
  /** every attempt this call made, in order: what a write did is read from them */
  log: Attempt[];
  /** the site's `shared` record: someone else wrote this spec (pulled, or a bundled one upgraded from the registry) */
  shared?: Site["shared"];
  /** `unconfirmed`: no browser run in the user's profile for it (tier 3, a recapture, a cookie refresh) */
  unconfirmed?: boolean;
  /** every cookie a tier-1 redirect chain set: one sent on the next hop can be rotated out before the call ends */
  seen?: StoredCookie[];
  /** the seed of the op's gen slots: one per call, so the call's own retries send the same values */
  gen: string;
}

/**
 * An unreviewed candidate an agent pulled: nobody but its uploader has seen it work, and page text may
 * have steered the agent to it. It runs at tiers 1 and 2 only, never as a trigger run in the user's
 * browser profile, whose steps click what the spec says with the user's sessions aboard. A human's pull
 * (no `by: "agent"`) is the consent that lifts it, as for an agent pull's writes.
 */
const unconfirmed = (site: Site, op: Operation) => site.shared?.by === "agent" && op.version?.status === "candidate";

/**
 * A call's starting tier and its cap. A remembered escalation is a speed hint, not a requirement:
 * under a lower cap, the call starts at the op's own tier.
 */
export function callTiers(site: Site, op: Operation, maxTier: Tier = 3, remembered?: Tier) {
  const cap = unconfirmed(site, op) ? (Math.min(maxTier, 2) as Tier) : maxTier;
  const tier = Math.max(op.minTier, remembered !== undefined && remembered <= cap ? remembered : 1) as Tier;
  return { tier, maxTier: cap };
}

/** The answer to a call of an `unconfirmed` op that needs tier 3. */
const needsHuman = (site: string, notes: string[]): Result => ({
  ok: false,
  class: "blocked",
  tier: 3,
  reason: [
    ...notes,
    "needs tier 3 (the site's own page in the browser), and this is an unconfirmed operation an agent pulled: it never runs in the user's browser profile",
  ].join("; "),
  next: `the operation is unconfirmed and needs the browser: do not retry. A human can allow it: ask the user to look at the site's operations and, if they trust them, run in a terminal: api-anything pull ${site}`,
  nextCall: { action: "report" },
  retry: "after_fix",
});

/** The answer to a call that needs a tier above its cap; an `unconfirmed` op's tier 3 needs a human, not a cap. */
export function tierBlocked(
  site: Site,
  op: Operation,
  tiers: ReturnType<typeof callTiers>,
  requestedMaxTier: Tier = 3,
  notes: string[] = [],
): Result {
  const { tier, maxTier } = tiers;
  if (unconfirmed(site, op) && tier === 3 && requestedMaxTier >= 3) return needsHuman(site.name, notes);
  return {
    ok: false,
    class: "blocked",
    tier,
    reason: [...notes, `needs tier ${tier}, capped at ${maxTier}`].join("; "),
    next: `allow a higher tier (--max-tier ${tier})`,
    nextCall: { action: "raise_tier", tier },
  };
}

/** Old write specs can send unbounded side effects at tier 3; call-only approval cannot cover those. */
export function callOnlyWriteRefusal(site: string, op: Operation, tier: Tier): Result | undefined {
  if (op.readOnly || tier !== 3) return undefined;
  const missing = [
    ...(op.trigger.companions === undefined ? ["no recorded companions list"] : []),
    ...(!Object.keys(op.match).length ? ["an empty match"] : []),
  ];
  if (!missing.length) return undefined;
  return {
    ok: false,
    class: "refused",
    tier,
    reason: `tier-3 write has ${missing.join(" and ")}; nothing was sent`,
    next: `ask the user to re-learn the write with the CLI: api-anything add ${site} ${op.name} ... --write`,
    nextCall: { action: "relearn" },
  };
}

const NO_SESSION: Session = { cookies: [], values: {} };

/** The answer when the site's session file cannot be read: nothing is sent. */
export const badSession = (site: string, e: unknown): Result => ({
  ok: false,
  class: "error",
  reason: (e as Error).message,
  next: `delete ${sessionFile(site)}, then ask the user to run api-anything login ${site} if the site needs an account`,
  nextCall: { action: "report" },
  retry: "after_fix",
});

/** The answer when the args, or a session value, cannot go into the request: nothing is sent. */
export function unsendable(site: string, op: Operation, e: unknown): Result {
  const next =
    e instanceof BadHeader
      ? `nothing was sent. Check the args; if the value is the session's, ask the user to run: api-anything login ${site}`
      : nextFor("input", site, op);
  return { ok: false, class: "input", reason: (e as Error).message, next };
}

/**
 * Whether this op goes without the user's cookies and session values: a request that is no GET or HEAD,
 * of a spec an agent pulled (page text may have steered it there), may change something whatever the
 * spec says it is. A human's pull and a bundled spec upgraded from the registry keep them: the registry
 * serves no such op to anyone but its uploader until a maintainer reviewed it (a POST read, a slot
 * holding a cookie or session ref), and the seeded POST reads need theirs (airbnb search).
 */
export function bareCall(site: Pick<Site, "shared">, op: Operation): boolean {
  // An unreviewed candidate is a public read by the registry's rules, so it needs no session; and a
  // GET can do harm with the user's cookies too (a one-click account action), whoever pulled it.
  if (site.shared && op.version?.status === "candidate") return true;
  if (site.shared?.by !== "agent") return false;
  const method = op.request.method.toUpperCase();
  return method !== "GET" && method !== "HEAD";
}

/** The session a call of `op` may send (none when `bareCall`), filtered in memory: no file is written. */
export function callSession(site: Pick<Site, "shared">, op: Operation, session: Session, theirs = false): Session {
  if (bareCall(site, op)) return NO_SESSION;
  return theirs ? boundSession(session) : session;
}

/** Headers a browser computes per request about itself: Node's fetch carrying them is not Chrome's TLS. */
const IDENTITY = /^(user-agent|sec-ch-ua.*|sec-fetch-.*)$/;

/**
 * The op without the browser's identity headers, when its request carries one that no slot or volatile
 * fills; else undefined. Some walls (Hacker News's "Sorry") refuse a client that claims Chrome but is not
 * it, and which combination trips one differs by site, so all of them go.
 */
function withoutIdentity(op: Operation): Operation | undefined {
  const names = Object.keys(op.request.headers).filter((h) => IDENTITY.test(h));
  const filled = [...op.slots, ...op.volatile].some((s) => {
    const at = s.at[0]!.toLowerCase();
    return at.startsWith("header:") && IDENTITY.test(at.slice(7));
  });
  if (!names.length || filled) return undefined;
  const headers = Object.fromEntries(Object.entries(op.request.headers).filter(([h]) => !IDENTITY.test(h)));
  return { ...op, request: { ...op.request, headers } };
}

/** What one attempt did to a write. */
const statusOf = (a: Attempt): WriteStatus =>
  a.unsent ? "not_sent" : a.class === "ok" ? "accepted" : a.rejected || notRun(a) ? "not_applied" : "may_have_applied";

/** What a call's attempts did to a write: the most that any of them may have done. */
function writeStatus(log: Attempt[]): WriteStatus {
  const seen = new Set(log.map(statusOf));
  for (const s of ["accepted", "may_have_applied", "not_applied"] as const) if (seen.has(s)) return s;
  return "not_sent";
}

/** The step an attempt's own facts ask for, before the class's usual one. */
export function stepOf(a: Attempt): Partial<Result> {
  const wait = a.retryAfterMs !== undefined ? { retryAfterMs: a.retryAfterMs } : {};
  if (a.hint === PROFILE_HINT) return { ...wait, nextCall: { action: "retry" }, retry: "after_wait" };
  // refused to this network or region: no tier, login or wait changes that
  if (a.class === "blocked" && a.status === 451) return { nextCall: { action: "report" }, retry: "no" };
  if (a.step) return { ...wait, nextCall: { action: a.step } };
  // refused for its args; a refusal that says the session is gone or names a limit keeps its class's step
  if (a.rejected && a.class === "error") return { ...wait, nextCall: { action: "fix_args" } };
  return wait;
}

const DEFAULT_STEP: Record<CallResult["class"], NextCall | undefined> = {
  ok: undefined,
  refused: { action: "allow_writes" },
  duplicate: { action: "check_site" },
  input: { action: "fix_args" },
  auth: { action: "login" },
  rate: { action: "retry" },
  blocked: { action: "login", mode: "window" },
  drift: { action: "heal" },
  error: { action: "retry" },
};

/**
 * The structured fields every result carries, filled from its class and what was sent where the
 * code that built it did not say: one place keeps them consistent (test/execute.test.ts's table).
 * A write that went through or may have gets retry "no" and check_site, whatever else was said.
 */
export function finish(r: Result, op: Operation | undefined, site: string | undefined, log: Attempt[]): Result {
  const out: Result = { ...r };
  if (op && !op.readOnly) out.write = r.write ?? writeStatus(log);
  if (r.ok) {
    delete out.retry;
    delete out.nextCall;
    return out;
  }
  // a duplicate is held back because the first one may have run: the same answer
  const ran = out.write === "accepted" || out.write === "may_have_applied" || r.class === "duplicate";
  let step: NextCall | undefined = ran ? { action: "check_site" } : (r.nextCall ?? DEFAULT_STEP[r.class]);
  if (step?.action === "heal" && op && !op.readOnly) step = { action: "relearn" };
  if (step)
    out.nextCall = {
      ...step,
      ...(site && step.action !== "list_sites" ? { site, ...(op ? { op: op.name } : {}) } : {}),
    };
  const a = out.nextCall?.action;
  out.retry = ran
    ? "no"
    : (r.retry ??
      (a === "retry"
        ? r.class === "rate"
          ? "after_wait"
          : "safe"
        : a === "check_site" || a === "report" || a === undefined
          ? "no"
          : "after_fix"));
  return out;
}

const REGION =
  "the site says this is not available from this network or region (HTTP 451): do not retry; tell the user";

/** `signIn`: how the user signs in again, when it is not `api-anything login` (`reimportIfBrowser`) */
function nextFor(
  c: CallResult["class"],
  site: string,
  op: Operation,
  a?: Attempt,
  signIn = `run: api-anything login ${site}`,
): string | undefined {
  if (c === "ok") return undefined;
  if (c === "refused")
    return "only if the user asked for this write: rerun with --allow-writes (MCP: start the server with --allow-writes)";
  if (a?.hint) return a.hint;
  // A write the server may have run: never invite a second send.
  const ran = !op.readOnly && a !== undefined && statusOf(a) === "may_have_applied";
  if (ran && c !== "drift" && c !== "auth") return "the write may have gone through: check the site before any retry";
  if (a?.rejected && c === "error")
    return `the site refused the write, so it did not run: read reason, check the args against: api-anything ops ${site}; do not send it again unchanged`;
  switch (c) {
    case "auth":
      return `ask the user to ${signIn}; then ${ran ? "check the site, and retry only if the write is not there" : "retry once"}`;
    case "rate":
      return a?.retryAfterMs !== undefined
        ? "rate limited: do not retry before retryAfterMs (the time in reason)"
        : "rate limited: do not retry now; wait a few minutes";
    case "blocked":
      if (a?.status === 451) return REGION;
      if (a?.missing)
        return `the site refuses requests from this machine or network (a 403 with no challenge or sign-in to clear): do not retry as it is; a window may show why: ask the user to run api-anything login ${site} --window, then retry once`;
      return `the site is challenging automated requests: ask the user to run api-anything login ${site} --window and clear the challenge in the window, then retry once`;
    case "drift":
      if (!op.readOnly)
        return `${ran ? "the write may have run: check the site first, then " : ""}re-learn it with api-anything add ${site} ${op.name} ... --write`;
      return `api-anything heal ${site} ${op.name}; if that fails, re-learn it with api-anything add ${site} ${op.name} ...`;
    case "input":
      return `check the args against: api-anything ops ${site}`;
    default:
      return "retry once; if it fails the same way, stop and report the reason";
  }
}

function success(a: Attempt, extra: Partial<Result> = {}): Result {
  return {
    ok: true,
    class: "ok",
    tier: a.tier,
    data: a.data,
    ...(a.nextPage !== undefined ? { nextPage: a.nextPage } : {}),
    ...(a.hasMore !== undefined ? { hasMore: a.hasMore } : {}),
    ...extra,
  };
}

/** The op's stored example args, with defaults; undefined when a required param has none. */
function exampleArgs(op: Operation): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const p of op.params) {
    const v = p.example ?? p.default;
    if (v !== undefined) out[p.name] = v;
    else if (p.required) return undefined;
  }
  return out;
}

const sameArgs = (a: Record<string, unknown>, b: Record<string, unknown>, op: Operation) =>
  op.params.every((p) => asText(a[p.name] ?? p.default ?? "") === asText(b[p.name] ?? p.default ?? ""));

/** Never throws: a browser that fails to launch or a page that fails to load is a failed heal. */
const safeHeal = (p: Promise<HealResult>): Promise<HealResult> =>
  p.catch((e: Error) => ({ outcome: "failed" as const, reason: `heal crashed: ${e.message.split("\n")[0]}` }));

/** The other unsafe requests a write's tier-3 run sent or stopped, named whatever the outcome. */
function othersNote(op: Operation, o: TriggerRun["others"]): string | undefined {
  if (!o) return undefined;
  const them = (l: string[]) => l.join(", ");
  const out: string[] = [];
  if (o.stopped.length)
    out.push(
      `the page also tried to send ${them(o.stopped)}, which this write's learning did not see the trigger send: stopped in the browser, nothing of it was sent. If the page changed, look at it before you learn it again with add --write`,
    );
  if (o.left.length)
    out.push(
      op.trigger.companions
        ? `the page also sent ${them(o.left)}, as it did when this write was learned`
        : `the page also sent ${them(o.left)}: ${op.name} was learned before api-anything recorded what else a write's trigger sends, so nothing else was stopped; learn it again with add --write to stop any request it did not send then`,
    );
  return out.join("; ");
}

/** What to do about a write whose redirect was not followed, since that would have sent it again. */
const sentOnce = (site: string, op: Operation) =>
  `the write was sent once and may have run: check the site first. Do not retry: the site answered it with a redirect that would send it a second time, which was not followed; if the operation moved, learn it at its new address: api-anything add ${site} ${op.name} ... --write`;

const sessionOrNone = (site: string): Session | undefined => {
  try {
    return loadSession(site);
  } catch {
    return undefined;
  }
};

/**
 * `text` without the live values of any of `sessions`; see `redact`. One pass over their union: a
 * pass per session would check each only after its own replacements, and a later one can expose
 * an earlier one's value.
 */
const hide = (text: string, sessions: (Pick<Session, "cookies" | "values"> | undefined)[], cut = false) => {
  const all = sessions.filter((s) => s !== undefined);
  const union = {
    cookies: all.flatMap((s) => s.cookies),
    values: Object.fromEntries(all.flatMap((s, i) => Object.entries(s.values).map(([k, v]) => [`${i}:${k}`, v]))),
  };
  return redact(text, union, { cut });
};

/**
 * One try at a tier, logged for the call's write status. A reason quotes the response, which can
 * echo a credential (a 401 naming the token it refused): redacted against the jar as it was before
 * the send and after it (a rotated cookie), and against every cookie a redirect set along the way (one
 * sent on the next hop, then rotated again), with the snippet's cut end treated as cut.
 */
async function attempt(ctx: Ctx, op: Operation, tier: Tier): Promise<Attempt> {
  const before = sessionOrNone(ctx.site);
  const a = await tryTier(ctx, op, tier);
  ctx.log.push(a);
  const seen = { cookies: ctx.seen ?? [], values: {} };
  return { ...a, reason: hide(a.reason, [before, sessionOrNone(ctx.site), seen], true) };
}

async function tryTier(ctx: Ctx, op: Operation, tier: Tier): Promise<Attempt> {
  try {
    if (tier === 3) {
      // For a write this is the UI sending it: the one attempt.
      await pace(ctx.site, ctx.opts.minIntervalMs);
      const run = await runOpTrigger(ctx.site, op, ctx.args);
      const judged = run.matched && judgeExchange(op, run.matched);
      // The page is told nothing of a redirect that was stopped, its status included: this is the answer.
      const resent: Attempt | undefined = run.resends
        ? {
            tier,
            class: "error",
            reason: "the site answered this write with a redirect that would send it again: stopped in the browser",
            ambiguous: true,
            hint: sentOnce(ctx.site, op),
          }
        : undefined;
      const a: Attempt =
        judged ||
        resent ||
        challengePage(run.capture) ||
        (run.loginWall
          ? { tier, class: "auth", reason: `the trigger landed on a sign-in page (${run.loginWall})` }
          : (pageDown(run.capture) ?? {
              tier,
              class: "drift",
              reason: firedNothing(op, run.capture),
              // a write's confirm told no: the page's handler stopped there, and its request never left
              ...(!op.readOnly && run.capture.dialogs?.some((d) => d.type === "confirm" && !d.accepted)
                ? { unsent: true }
                : {}),
            }));
      const notes = [
        run.repeats &&
          `the page sent this write ${run.repeats + 1} times: ${run.repeats === 1 ? "the repeat was" : `${run.repeats} repeats were`} stopped in the browser`,
        othersNote(op, run.others),
      ].filter(Boolean);
      return notes.length ? { ...a, note: notes.join("; ") } : a;
    }
    const none = bareCall(ctx, op);
    const session = none ? NO_SESSION : loadSession(ctx.site);
    let r: Sent | PageFetchResult;
    if (tier === 1) {
      const sent = await sendDerived(op, ctx.args, session, {
        site: ctx.site,
        fetchImpl: ctx.opts.fetchImpl,
        timeoutMs: ctx.opts.timeoutMs,
        minIntervalMs: ctx.opts.minIntervalMs,
        // someone else's spec sends only to public addresses; tiers 2 and 3 are the browser's, out of this guard's reach
        publicOnly: !!ctx.shared,
        gen: ctx.gen,
      });
      // A rotating cookie (a rolling session, __cf_bm) must ride on the next call.
      if (sent.setCookies) {
        ctx.seen = [...(ctx.seen ?? []), ...sent.setCookies];
        try {
          mergeCapture(ctx.site, sent.setCookies);
        } catch {
          /* a read-only home still answers this call */
        }
      }
      r = sent;
    } else {
      const viaPage = async (o: Operation) => {
        const req = buildRequest(o, ctx.args, session, ctx.gen);
        // someone else's spec: the page's fetch goes only to public addresses, as tier 1 does (tier 3 is not covered)
        if (ctx.shared) await refusePrivate(o, req.url);
        const { cookie: _jar, ...headers } = req.headers; // the page sends the profile's own cookies
        return pageFetch({
          origin: new URL(req.url).origin,
          url: req.url,
          method: req.method,
          headers,
          body: req.body,
          profileDir: profileDir(),
          timeoutMs: ctx.opts.timeoutMs,
          retryOnNavigation: o.readOnly,
          // the page's own cookies, unless they may not go (`bare`)
          ...(none ? { credentials: "omit" as const } : {}),
          pace: () => pace(ctx.site, ctx.opts.minIntervalMs),
          // tier 1's policy, one hop at a time: a page's own fetch() would follow with everything aboard
          redirect: async (from, status, location, taken) => {
            const next = nextHop(o, session, from, status, location, taken);
            if (ctx.shared) await refusePrivateHop(next, status);
            return next;
          },
        });
      };
      r = await viaPage(await derive(op, viaPage));
    }
    const j = judge(op, r);
    const hint = j.unfinished
      ? `the site wants a page finished first (consent, terms, or verify it's you): ask the user to open ${j.unfinished} in their browser and finish it, then run api-anything login ${ctx.site}; then retry once`
      : undefined;
    return {
      tier,
      status: r.status,
      ...(r.redirected ? { redirected: true } : {}),
      ...j,
      ...(hint ? { hint, step: "login" as const } : {}),
    };
  } catch (thrown) {
    const e = thrown instanceof LookupFailed && thrown.cause instanceof ProfileInUse ? thrown.cause : thrown;
    // a derived slot's lookup did not give its value: the op's own request never left
    if (e instanceof LookupFailed) return { tier, ...e.judged, unsent: true };
    // nothing was sent when the browser could not start
    if (e instanceof ProfileInUse) return { tier, class: "error", reason: e.message, hint: PROFILE_HINT, unsent: true };
    // someone else's spec names an address on this machine or the local network: nothing was sent, and no tier sends it
    if (e instanceof AddressRefused)
      return {
        tier,
        class: "error",
        reason: e.message,
        unsent: true,
        hint: "do not retry: the spec someone else wrote sends to an address that is not public; tell the user, and learn the site again with learn_site",
        step: "report",
      };
    if (e instanceof RedirectRefused) {
      // The redirect is the site's answer, so a retry meets it again; the request it answered was sent.
      const add = `api-anything add ${ctx.site} ${op.name} ...${op.readOnly ? "" : " --write"}`;
      if (e.kind === "again")
        return {
          tier,
          class: "error",
          reason: e.message,
          ambiguous: true,
          hint: sentOnce(ctx.site, op),
          step: "check_site",
        };
      const why = e.kind
        ? `the site's redirects for this request do not end (a loop, or a chain past the limit); learn the operation again from the page that uses it, at the address the site now answers from: ${add}`
        : op.readOnly
          ? `the site sends this request on to another origin, which was not followed; re-learn it with ${add} if the site moved there`
          : `re-learn it with ${add} if the site moved there`;
      const hint = op.readOnly
        ? `do not retry: ${why}`
        : `the write may have run: check the site first. Do not retry: ${why}`;
      return { tier, class: "error", reason: e.message, ambiguous: true, hint, step: "relearn" };
    }
    const reason = (e as Error).message.split("\n")[0]!;
    // The site answered with more header bytes than Node's fetch reads (16 KB; YouTube sends ~19 KB):
    // a browser reads them, so a read climbs as from a block. A write did reach the site: never resent.
    if (tier === 1 && op.readOnly && /UND_ERR_HEADERS_OVERFLOW/.test(reason))
      return { tier, class: "blocked", reason: `the answer's headers are too large for plain HTTP (${reason})` };
    // No answer (a timeout, a reset, a page that did not load) teaches nothing about the request; a
    // trigger step that failed (its button is gone) does.
    return {
      tier,
      class: "error",
      reason,
      ambiguous: true,
      ...(tier < 3 || e instanceof PageUnreachable ? { server: true } : {}),
      // tier 2 fetches from the site's origin page: when that did not load, the request never left
      ...(tier === 2 && e instanceof PageUnreachable ? { unsent: true } : {}),
    };
  }
}

/**
 * Replace the jar with the profile's cookies. True when that changes the request this tier sends:
 * a tier-2 page sends the profile's own cookies, so there the jar only fills `cookie:` refs.
 */
async function refreshCookies(ctx: Ctx, op: Operation, tier: Tier): Promise<boolean> {
  if (!browserAvailable()) return false;
  let fresh: StoredCookie[];
  try {
    fresh = await profileCookies({ url: op.request.url, profileDir: profileDir() });
  } catch {
    return false;
  }
  const swap = () => {
    const s = loadSession(ctx.site);
    const sent = (cookies: StoredCookie[]) => {
      try {
        const req = buildRequest(op, ctx.args, { ...s, cookies }, ctx.gen);
        if (tier > 1) delete req.headers.cookie;
        return JSON.stringify(req);
      } catch {
        return undefined; // a cookie: ref with nowhere to go; the retry reports it like any failed attempt
      }
    };
    const before = sent(s.cookies);
    saveSession(ctx.site, { ...s, cookies: fresh });
    return sent(fresh) !== before;
  };
  try {
    return withLock(sessionFile(ctx.site), swap);
  } catch {
    return false; // a full disk, an unreadable session file: nothing refreshed, and the call keeps its own answer
  }
}

/** The version that answered in place of a drifted one worked: its report, beside the old one's failure. */
async function queueOk(hash: string, a: Attempt): Promise<void> {
  try {
    if (loadSettings().share) {
      const { queueReport } = await import("./report.js");
      queueReport({ hash, outcome: "ok", tier: a.tier });
    }
  } catch {
    // a lost report, never a lost answer
  }
}

async function onDrift(ctx: Ctx, site: Site, op: Operation, a: Attempt): Promise<Result> {
  const fail = (b: Attempt, extra: Partial<Result> = {}): Result => ({
    ok: false,
    class: b.class,
    tier: b.tier,
    reason: b.reason,
    next: nextFor(b.class, ctx.site, op, b),
    ...stepOf(b),
    ...(b.server ? { server: true as const } : {}),
    ...extra,
  });

  // An op learned signed in, called with no login cookie: the site hides the data from guests; it did not move.
  if (a.missing && op.learnedLoggedIn && !loggedIn(loadSession(ctx.site).cookies, site.loginCookies)) {
    return fail(
      { ...a, class: "auth" },
      { reason: `${a.reason}; the op was learned signed in and the session has no login cookie` },
    );
  }

  // Everything below sends again or heals, and a call-only call does neither.
  if (ctx.opts.callOnly)
    return fail(
      a,
      op.readOnly
        ? { next: `ask the user to run: api-anything heal ${ctx.site} ${op.name}`, nextCall: { action: "heal" } }
        : {},
    );

  // A server that sometimes answers without the data (Google's fallback page, issue #21) answers a second
  // try: before the args are blamed or a browser heals, the same request goes once more.
  if (a.missing && op.readOnly && a.tier < 3) {
    const again = await attempt(ctx, op, a.tier);
    if (again.class === "ok")
      return success(again, { reason: `the first answer had no data (${a.reason}); a second try did` });
    if (learnedNothing(again)) return fail(again);
  }

  // "No such user" and "no results" look exactly like a moved extract path. If the example args
  // still return data through the same template, nothing drifted: the args are the problem.
  const examples = exampleArgs(op);
  /** the op's own example args got no data either: the args are not the problem */
  let examplesFail = false;
  const lost = a.lost?.join(", ");
  // no example args to tell a field the site dropped from one these args have no value for: fail loudly
  if (lost && op.readOnly && !examples) examplesFail = true;
  if (a.missing && op.readOnly && examples) {
    if (sameArgs(examples, ctx.args, op)) examplesFail = true;
    else {
      const b = await attempt({ ...ctx, args: examples }, op, a.tier);
      if (b.class === "ok" && lost)
        return success(a, {
          reason: `the answer for these args has no ${lost} (${a.reason}); the example args' answer does, so the operation works`,
        });
      if (b.class === "ok") {
        return fail(
          { ...a, class: "input" },
          {
            reason: `no results for these args (${a.reason}); the example args still return data, so the operation works`,
            next: `check the args against: api-anything ops ${ctx.site}; do not heal or re-add`,
          },
        );
      }
      // throttled, challenged or a server failure while checking: stop, don't spend a heal (a browser run) against it
      if (learnedNothing(b)) return fail(b);
      examplesFail = true;
    }
  }
  // the site no longer sends a picked field, for any args: the call fails, naming it, rather than answer without it
  const dropped = (b: Attempt): Partial<Result> =>
    b.lost && examplesFail
      ? {
          next: `if the site still shows ${b.lost.join(", ")}, re-learn the response recipe with a new --pick (or --extract): api-anything add ${ctx.site} ${op.name} ... --pick <fields> (api-anything capture <trigger url> shows the response); if it is gone for good, drop it from the pick`,
          nextCall: { action: "relearn" },
        }
      : {};

  // Another install may have repaired this version already, or it degraded and the registry serves the next
  // best: that version is one request, a heal is a browser run.
  if (op.readOnly && op.version) {
    const { adopt, servedNow } = await import("./registry.js");
    const next = await servedNow(ctx.site, op).catch(() => undefined);
    // at the tier the replacement asks for, if the caller allows it: attempt() itself climbs no tier
    const tier = Math.max(a.tier, next?.minTier ?? 1) as Tier;
    if (next?.version && tier <= ctx.maxTier && (tier === 1 || browserAvailable())) {
      const b = await attempt(ctx, next, tier);
      if (b.class === "ok") {
        adopt(ctx.site, op, next);
        ctx.opts.onAnswered?.(next);
        await queueOk(next.version.hash, b);
        return success(b, {
          healed: true,
          heal: { strategy: "registry", changes: templateChanges(op, next) },
          reason: `${a.reason}; the registry now serves another version of ${op.name}, and it answered`,
        });
      }
    }
  }

  let guard: string | undefined;
  // verify is the explicit check: its drift heals (and a heal that saves clears the mark)
  const stale = ctx.opts.ignoreStale ? undefined : staleMark(ctx.site, op.name);
  const healedAt = ctx.opts.ignoreStale ? undefined : lastHealAt(ctx.site, op.name);
  if (stale) guard = `stale until ${new Date(stale.until).toISOString()}: ${stale.reason}`;
  else if (healedAt !== undefined && Date.now() - healedAt < HEAL_GUARD_MS) {
    const reason = `drifted again within 10 min of a heal (${a.reason})`;
    markStale(ctx.site, op.name, reason);
    guard = `marked stale: ${reason}`;
  }
  if (guard) {
    // Not re-healed. A read can still get its answer from the site's own frontend.
    if (op.readOnly && a.tier < 3 && ctx.maxTier >= 3 && stale?.tier3 !== false && browserAvailable()) {
      const b = await attempt(ctx, op, 3);
      if (b.class === "ok") return success(b, { reason: guard });
      // the site's own request doesn't answer either: stop paying a browser run per call (a challenge,
      // a limit or a sign-in page says nothing about that)
      if (!b.hint && !learnedNothing(b))
        markStale(ctx.site, op.name, stale?.reason ?? guard, undefined, undefined, { tier3: false });
    }
    // `heal` refuses writes: a stale write is re-learned
    const next = op.readOnly
      ? `wait for the stale mark to expire, or force it: api-anything heal ${ctx.site} ${op.name}`
      : `wait for the stale mark to expire, or re-learn it: api-anything add ${ctx.site} ${op.name} ... --write`;
    return fail(a, { reason: `${a.reason}; ${guard}`, next });
  }

  // A candidate is validated by replaying it; at tier 3 the site's own request would answer instead, validating nothing.
  const h = await safeHeal(
    healOperation(ctx.site, op, ctx.args, {
      validate: (candidate) => attempt(ctx, candidate, Math.min(a.tier, 2) as Tier),
      fetchImpl: ctx.opts.fetchImpl,
      loginCookies: site.loginCookies,
      // a recapture runs the trigger in the user's profile
      browser: ctx.maxTier > 1 && !ctx.unconfirmed,
    }),
  );
  if (h.outcome === "healed") {
    ctx.opts.onAnswered?.(h.operation);
    return success(h.attempt, { healed: true, heal: { strategy: h.strategy, changes: h.changes } });
  }
  // Throttled, challenged, logged out, or no browser: nothing was learned about the op, so it is not stale.
  if (h.outcome === "failed" && h.transient) {
    // the replay that would have saved a candidate got no answer, but the site's own request did: that is the tier-3 read
    if (h.fallback?.class === "ok" && ctx.maxTier >= 3)
      return success(h.fallback, { reason: `heal stopped (${h.reason}); answered by the site's own request` });
    const b = h.attempt ?? a;
    return fail(b, { reason: `${a.reason}; heal stopped: ${h.reason}` });
  }
  // A heal that tried everything and failed would fail the same way on the next call: don't rerun the browser each time.
  if (h.outcome === "failed" && ctx.maxTier > 1)
    markStale(ctx.site, op.name, `heal failed: ${h.reason}`, undefined, undefined, {
      tier3: h.fallback?.class === "ok",
    });
  // The template can't be replayed, but the site's own request answered: that is the tier-3 read.
  if (h.fallback?.class === "ok" && ctx.maxTier >= 3)
    return success(h.fallback, { reason: `heal failed (${h.reason}); answered by the site's own request` });
  if (h.outcome === "identical") {
    if (examplesFail) {
      // Same request, and even the examples get no data: the response recipe drifted (a renamed field), or the site is down.
      return fail(
        { ...a, class: "drift" },
        {
          reason: `the site takes the same request but its response lacks the data (${a.reason}), for the op's example args too`,
          next: `if the site works in a browser, re-learn the response recipe: api-anything add ${ctx.site} ${op.name} ... --extract <path> (api-anything capture <trigger url> shows the response); otherwise report it`,
          nextCall: { action: "relearn" },
          ...dropped(a),
        },
      );
    }
    return fail(
      { ...a, class: "input" },
      {
        reason: `not drift: re-learning gave a byte-identical template (${a.reason})`,
        next: `check the args against api-anything ops ${ctx.site}; if the site needs an account, ask the user to run api-anything login ${ctx.site}`,
      },
    );
  }
  const b = h.attempt ?? h.fallback ?? a;
  return fail(b, { reason: `${b.reason}; heal failed: ${h.reason}`, ...dropped(b) });
}

/** The site and op a call names, from local files only, or the failure a call answers without sending. */
export function resolveCall(
  siteName: string,
  opName: string,
): { site: Site; op: Operation; theirs: boolean; source: Resolved["source"] } | Result {
  let r: ReturnType<typeof loadSite>;
  try {
    r = loadSite(siteName);
  } catch (e) {
    const bad = /invalid site name/.test((e as Error).message);
    return {
      ok: false,
      class: bad ? "input" : "error",
      reason: (e as Error).message.split("\n")[0],
      next: bad ? "api-anything sites lists what exists" : "fix or delete that spec file, then retry once",
      // a broken file on this machine: the user fixes it, then the call works
      ...(bad ? { nextCall: { action: "list_sites" } } : { nextCall: { action: "report" }, retry: "after_fix" }),
    };
  }
  if (!r)
    return {
      ok: false,
      class: "input",
      reason: `no site "${siteName}"`,
      next: `api-anything sites lists what exists; api-anything pull ${siteName} fetches it if someone shared it`,
      nextCall: { action: "list_sites" },
    };
  const op = r.site.operations.find((o) => o.name === opName);
  if (!op)
    return {
      ok: false,
      class: "input",
      reason: `no operation "${opName}" on ${r.site.name}`,
      next: `api-anything ops ${r.site.name}`,
      // the site is known though the op is not: the step lists its ops
      nextCall: { action: "fix_args", site: r.site.name },
    };
  // someone else's: pulled, bundled, or a heal's copy of a pulled one
  return { site: r.site, op, theirs: r.source !== "user" || !!r.site.shared, source: r.source };
}

/**
 * A write's readback: the op's read, run once after the write was sent. It is a read, never a
 * resend. Finding the write makes the result `applied` (and ok, whatever its own answer was); not
 * finding it, or a read that fails, changes nothing but `reason`: the site may show it later.
 * A read the op carries (a shared write's) runs as a proof: under the write's own version, so with
 * the trust its spec has, and leaving nothing behind (no remembered tier, heal or report) but the
 * cool-down a rate limit or block sets.
 */
async function readBack(
  site: Site,
  theirs: boolean,
  op: Operation,
  args: Record<string, unknown>,
  r: Result,
  opts: CallOptions,
): Promise<Result> {
  const rb = op.readback!;
  const name = readbackName(rb);
  const readArgs = Object.fromEntries(Object.entries(rb.args).map(([k, v]) => [k, fillTemplate(v, args)]));
  // the read is no version of the write
  const o: CallOptions = {
    ...opts,
    allowWrites: false,
    again: undefined,
    idempotencyKey: undefined,
    onAnswered: undefined,
    view: undefined,
  };
  const read =
    "op" in rb
      ? await call(site.name, rb.op, readArgs, o)
      : await run(site, { ...proofOp(rb.read), ...(op.version ? { version: op.version } : {}) }, readArgs, o, {
          theirs,
          proof: true,
        });
  const noted = (note: string): Result => ({ ...r, reason: r.reason ? `${r.reason}; ${note}` : note });
  if (!read.ok)
    return noted(
      `could not read it back with ${name} (${read.class}: ${read.reason ?? "no reason"}), so it stays ${r.write}`,
    );
  const items = Array.isArray(read.data) ? read.data : read.data == null ? [] : [read.data];
  const want = rb.find && fillTemplate(rb.find.equals, args).trim();
  const found = rb.find
    ? items.some((item) => {
        const v = getPath(item, rb.find!.field);
        return v != null && typeof v !== "object" && asText(v).trim() === want;
      })
    : !(read.data == null || read.data === "" || (typeof read.data === "object" && !Object.keys(read.data).length));
  if (!found)
    return noted(
      `read back with ${name}: not found${read.truncated ? " in the part of its answer that fitted" : ""}, so it stays ${r.write}: the site may not show it yet; check the site before any retry`,
    );
  const { retry: _retry, nextCall: _next, next: _hint, server: _server, ...kept } = r;
  const note = `read back with ${name}: found it`;
  return { ...kept, ok: true, class: "ok", write: "applied", reason: r.reason ? `${r.reason}; ${note}` : note };
}

/** Where to check a write that may have gone through: the page it is made on, with the call's args, and its readback. */
function whereToLook(op: Operation, args: Record<string, unknown>): string {
  const rb = op.readback;
  const readArgs = rb && Object.fromEntries(Object.entries(rb.args).map(([k, v]) => [k, fillTemplate(v, args)]));
  // a read the write carries is no op of the site to call: its page is where to look
  const read = !rb
    ? ""
    : "op" in rb
      ? `, or with its readback: the read ${rb.op} with args ${JSON.stringify(readArgs)}`
      : `, or where its readback ${rb.read.name} reads: ${fillTrigger(rb.read.trigger, readArgs!).url}`;
  return `. Look on ${fillTrigger(op.trigger, args).url}${read}`;
}

/** The answer while the site cools down (`coolAfter`): nothing is sent. */
function cooled(c: CoolDown, site: string, now = Date.now()): Result {
  const reason = `not sent: ${site} answered ${c.class} at ${new Date(c.at).toISOString()} (${c.reason}), so nothing goes to it until ${new Date(c.until).toISOString()}`;
  const wait = { ok: false, class: c.class, reason, retryAfterMs: Math.max(0, c.until - now), cooling: true as const };
  if (c.class === "rate") return { ...wait, next: "rate limited: do not retry before retryAfterMs; nothing was sent" };
  if (c.status === 451) return { ...wait, next: REGION, nextCall: { action: "report" }, retry: "no" };
  return {
    ...wait,
    next: `the site blocked its last call at every tier: do not retry before retryAfterMs. To look sooner, ask the user to run api-anything login ${site} --window (a login ends the wait), then retry once`,
  };
}

/**
 * Leave a site alone once it said stop: a rate limit (for its Retry-After, capped, or a few minutes),
 * a block at every tier the op climbs to, or a 451. Another call now would only meet it again.
 */
function coolAfter(site: string, op: Operation, r: Result, log: Attempt[]): void {
  const last = log.at(-1);
  if (r.ok || !last || last.class !== r.class) return;
  if (r.class === "rate") {
    const ms = r.retryAfterMs ?? RATE_COOL_MS;
    if (ms > 0) coolDown(site, { class: "rate", reason: r.reason ?? last.reason }, ms);
  } else if (r.class === "blocked" && (last.status === 451 || last.tier === (op.readOnly ? 3 : 2)))
    coolDown(
      site,
      { class: "blocked", reason: r.reason ?? last.reason, ...(last.status ? { status: last.status } : {}) },
      BLOCKED_COOL_MS,
    );
}

/** The answer to a write the ledger held back: nothing is sent. */
function heldBack(g: Exclude<WriteGate, { send: true }>, op: Operation): Result {
  const when = new Date(g.earlier.at).toISOString();
  const was: WriteStatus = g.earlier.status === "sending" ? "may_have_applied" : g.earlier.status;
  const did =
    was === "applied"
      ? "a read back found it"
      : was === "accepted"
        ? "the site accepted it"
        : "it may have gone through";
  const again = "repeat the call with again (CLI --again, MCP again: true)";
  if (g.why === "key_reused")
    return {
      ok: false,
      class: "input",
      write: "not_sent",
      reason: `not sent: this idempotency key was used at ${when} for ${op.name} with other args`,
      next: "give each different write its own idempotency key",
    };
  if (g.why === "replay") {
    const ok = g.earlier.ok === true && (was === "accepted" || was === "applied");
    return {
      ok,
      class: ok ? "ok" : ((g.earlier.class as CallResult["class"] | undefined) ?? "error"),
      write: was,
      reason: `not sent again: this idempotency key was sent at ${when}, and this is that call's record (${did})`,
      ...(ok ? {} : { next: "the write may have gone through: check the site before any retry" }),
    };
  }
  return {
    ok: false,
    class: "duplicate",
    write: "not_sent",
    reason: `not sent: the same write (same args) was sent at ${when} and ${did}`,
    next: `check the site: the write is probably there. Only if it is not, and the user wants it sent again, ${again}`,
  };
}

/** Call one operation. Never throws for site-side failures; the result carries class, reason and next. */
export async function call(
  siteName: string,
  opName: string,
  args: Record<string, unknown> = {},
  opts: CallOptions = {},
): Promise<CallResult> {
  const t0 = Date.now();
  const problem = viewProblem(opts.view);
  if (problem)
    return {
      ok: false,
      class: "input",
      reason: problem,
      next: "check view.fields and view.maxChars; do not put them in the site's args",
      retry: "after_fix",
      ms: Date.now() - t0,
    };
  const found = resolveCall(siteName, opName);
  if ("ok" in found) return { ...finish(found, undefined, undefined, []), ms: Date.now() - t0 };
  opts.onAnswered?.(found.op);
  return run(found.site, found.op, args, opts, { theirs: found.theirs, source: found.source }, t0);
}

/**
 * A resolved op's call. `proof`: a write's readback running the read it carries (`readBack`), which
 * answers and changes nothing: no tier remembered, no heal, adopt or stale mark, no report. Its rate
 * limit or block still cools the site down, as a named readback's does.
 */
async function run(
  site: Site,
  op: Operation,
  args: Record<string, unknown>,
  opts: CallOptions,
  how: { theirs: boolean; source?: Resolved["source"]; proof?: boolean },
  t0 = Date.now(),
): Promise<CallResult> {
  if (opts.callOnly) {
    const asked = opts.minIntervalMs ?? 0;
    opts = { ...opts, minIntervalMs: Math.max(CALL_ONLY_INTERVAL_MS, Number.isFinite(asked) ? asked : 0) };
  }
  const log: Attempt[] = [];
  const siteName = site.name;
  const { theirs, proof } = how;
  /** the jar as the call found it: a value it rotated out can still be quoted in a reason */
  let jar: Session | undefined;
  /** this write's ledger record, settled with what the call did */
  let ledger: string | undefined;
  /** the site's cool-down this call was answered from, sending nothing: no news for the registry */
  let held: CoolDown | undefined;
  const done = async (r: Result): Promise<CallResult> => {
    let f = finish(r, op, siteName, log);
    // A forced call the site answered ends the cool-down: before its readback, which may start another.
    if (f.ok && opts.ignoreCoolDown && log.length) clearCoolDown(siteName);
    // log: something was sent this call (a ledger hold-back sends nothing, and reads nothing back)
    if (op.readback && log.length && (f.write === "accepted" || f.write === "may_have_applied"))
      f = await readBack(site, theirs, op, args, f, opts);
    if (!op.readOnly && f.nextCall?.action === "check_site")
      f.next = `${f.next ?? "check the site before any retry"}${whereToLook(op, args)}`;
    const sessions = [jar, sessionOrNone(siteName)];
    if (f.reason) f.reason = hide(f.reason, sessions, true);
    if (f.next) f.next = hide(f.next, sessions);
    if (f.heal) f.heal = { ...f.heal, changes: f.heal.changes.map((c) => hide(c, sessions)) };
    if (ledger) settleWrite(ledger, f.write ?? "may_have_applied", f);
    // a proof's rate limit or block is the site's, as any call's
    coolAfter(siteName, op, f, log);
    const out = { ...f, ms: Date.now() - t0 };
    if (!proof)
      appendCall({
        site: siteName,
        op: op.name,
        class: out.class,
        ...(log.length && out.tier ? { tier: out.tier } : {}),
        ms: out.ms,
        ...(out.healed ? { healed: true as const } : {}),
        ...(out.write ? { write: out.write } : {}),
      });
    if (how.source && !proof && !held && !opts.callOnly) {
      const { afterCall } = await import("./report.js");
      afterCall(siteName, op, how.source, out, {
        fetchImpl: opts.fetchImpl,
        minIntervalMs: opts.minIntervalMs,
      });
    }
    if (out.ok && !proof && out.data !== undefined) {
      const viewed = resultView(out.data, opts.view, undefined, opts.callOnly);
      if (viewed.truncated && out.nextPage !== undefined)
        viewed.truncated += `; nextPage starts after the last item of this page, cut or not${opts.callOnly ? "" : "; more stays on this page"}`;
      return { ...out, ...viewed };
    }
    return out;
  };
  const write = !op.readOnly;
  if (write && !opts.allowWrites) {
    return done({
      ok: false,
      class: "refused",
      reason: `${op.name} is a write and writes are not allowed`,
      next: nextFor("refused", siteName, op),
    });
  }
  const unknown = unknownArgs(op, args);
  if (unknown) return done({ ok: false, class: "input", reason: unknown, next: nextFor("input", siteName, op) });
  // Resolved once: the tier-3 trigger and its answer's match take a default just as the request does.
  args = withDefaults(op, args);
  let session: Session;
  try {
    if (theirs) dropUnbound(siteName);
    jar = loadSession(siteName);
    session = callSession(site, op, jar, theirs);
  } catch (e) {
    return done(badSession(siteName, e));
  }
  try {
    buildRequest(op, args, session);
  } catch (e) {
    return done(unsendable(siteName, op, e));
  }
  const capped = unconfirmed(site, op);
  // a proof's op is named by a label, not one the site holds
  const remembered = proof ? undefined : rememberedTier(siteName, op.name);
  const tiers = callTiers(site, op, opts.maxTier, remembered);
  let tier = tiers.tier;
  const unsafeWrite = opts.callOnly && callOnlyWriteRefusal(siteName, op, tier);
  if (unsafeWrite) return done(unsafeWrite);
  // A site that said stop is not asked again until its wait is over: before the write's ledger, as nothing is sent.
  held = opts.ignoreCoolDown ? undefined : cooling(siteName);
  if (held) return done(cooled(held, siteName));
  // auth recovery steps taken this call: 1 re-import, 2 the profile's cookies, 3 a trigger run
  let authStep = 0;
  /** where the user signs in again when a re-import brought back no new login (`reimportIfBrowser`) */
  let signIn: { text: string; step: NextCall } | undefined;
  const reimport = async () => {
    authStep = 1;
    if (opts.callOnly) return false;
    const { reimportIfBrowser } = await import("./login.js");
    const r = await reimportIfBrowser(siteName, op.request.url, site.loginCookies);
    signIn =
      r.signIn && r.profile ? { text: r.signIn, step: { action: "sign_in_browser", profile: r.profile } } : undefined;
    return r.renewed;
  };
  // A write learned signed in, with no live login cookie in the jar (expired, or never there), would be
  // refused, or run as a guest: re-import first, and send nothing while none is back. Before the
  // duplicate guard records it, since it is not sent. The check leaves `guestCookies` out: a spec
  // learned before they were recorded, or on someone else's machine, may have counted a guest name as
  // its login, and a signed-in write must not be refused for that. A guest's write the server answers
  // 401 or 403 is still retried as below.
  if (write && op.learnedLoggedIn && !loggedIn(session.cookies, site.loginCookies)) {
    await reimport();
    if (!loggedIn(loadSession(siteName).cookies, site.loginCookies))
      return done({
        ok: false,
        class: "auth",
        reason: `${op.name} is a write learned signed in, and the session holds no live login cookie (expired or missing)${signIn ? `, nor does a re-import bring one back` : ""}: nothing was sent`,
        next: nextFor("auth", siteName, op, undefined, signIn?.text),
        write: "not_sent",
        ...(signIn ? { nextCall: signIn.step } : {}),
      });
  }
  /** the gen slots' seed; a write's is its ledger record's, so one idempotency key sends the same values each time */
  let gen = randomBytes(8).toString("hex");
  if (write) {
    let gate: WriteGate | undefined;
    try {
      gate = beginWrite(siteName, op.name, args, { again: opts.again, idempotencyKey: opts.idempotencyKey });
    } catch (e) {
      // Without a record a repeat cannot be caught: only a caller that already said "send it again" goes on.
      if (!opts.again)
        return done({
          ok: false,
          class: "error",
          reason: `the write was not sent: it could not be recorded first, so a repeat of it could not be caught (${(e as Error).message.split("\n")[0]})`,
          next: "ask the user to make the api-anything home directory writable; only if they want it sent without the duplicate guard, repeat the call with again (CLI --again)",
          nextCall: { action: "report" },
          retry: "after_fix",
        });
    }
    if (gate && !gate.send) return done(heldBack(gate, op));
    ledger = gate?.id;
    if (gate) gen = gate.seed;
  }

  // No login on record for this site: the session has no source (a login records one, logout clears it),
  // the jar has no live login cookie, and the op neither takes a credential nor was learned signed in.
  // Asked when it matters, not at the start: recovery may have put a login in the jar by then.
  const noLogin = () => {
    if (op.slots.some(holdsRef) || op.learnedLoggedIn) return false;
    try {
      const s = loadSession(siteName);
      return !s.source && !loggedIn(s.cookies, site.loginCookies, s.guestCookies);
    } catch {
      return false;
    }
  };
  const ctx: Ctx = {
    site: siteName,
    args,
    opts,
    maxTier: tiers.maxTier,
    log,
    shared: site.shared,
    unconfirmed: capped,
    gen,
  };
  // Why a call ran above tier 1, so a slow call explains itself.
  const notes: string[] = tier > op.minTier ? [`started at tier ${tier}: an earlier call escalated there`] : [];
  const noted = (a: Attempt) => success(a, notes.length ? { reason: notes.join("; ") } : {});
  let examplesChecked = false;
  let plainTried = false;
  for (;;) {
    if (tier > ctx.maxTier) return done(tierBlocked(site, op, { tier, maxTier: ctx.maxTier }, opts.maxTier, notes));
    if (tier > 1 && !browserAvailable()) {
      return done({
        ok: false,
        class: "blocked",
        tier,
        reason: `tier ${tier} needs a Chromium browser (Google Chrome, Brave, Edge or Chromium)`,
        next: "install one, or set API_ANYTHING_BROWSER to its path, then retry once",
        nextCall: { action: "install_browser" },
      });
    }
    const a = await attempt(ctx, op, tier);
    if (a.note) notes.push(a.note);
    if (a.class === "ok") {
      // Only an escalation is remembered; a tier the spec itself asks for is not, so editing minTier takes effect.
      const keep = tier > op.minTier ? tier : undefined;
      if (remembered !== keep && !proof) rememberTier(siteName, op.name, keep);
      return done(noted(a));
    }
    const fail = (x = a, reason = a.note ? `${a.reason}; ${a.note}` : a.reason): Promise<CallResult> =>
      done({
        ok: false,
        class: x.class,
        tier,
        reason,
        next: nextFor(x.class, siteName, op, x, signIn?.text),
        ...(x.class === "auth" && signIn ? { nextCall: signIn.step } : {}),
        ...stepOf(x),
        ...(x.server ? { server: true as const } : {}),
      });
    // Approval covers this transport and session, not a retry in another profile or with refreshed cookies.
    if (write && (opts.callOnly || !notRun(a))) return fail();
    // Plain HTTP refused a read from a site with no login on record. Some walls refuse a client that
    // claims to be Chrome without Chrome's TLS (Hacker News's 419 "Sorry"): the same request goes once
    // more without the browser's identity headers, before any recovery or browser. Nothing is kept, so
    // the next call sends the stored template first and pays this one fast request again.
    const plain =
      tier === 1 && !write && !plainTried && (a.class === "auth" || a.class === "blocked") && withoutIdentity(op);
    if (plain && noLogin()) {
      plainTried = true;
      const b = await attempt(ctx, plain, 1);
      const why = `tier 1 said ${a.class} (${a.reason})`;
      if (b.class === "ok") {
        if (remembered !== undefined) rememberTier(siteName, op.name, undefined);
        const reason = [...notes, `${why}; plain HTTP answered without the browser's identity headers`];
        return done(success(b, { reason: reason.join("; ") }));
      }
      // a 429 is the site's answer to this client too: a browser would only add load
      if (b.class === "rate") return fail(b, `${why}; without the browser's identity headers: ${b.reason}`);
    }
    // A bare 403 is a wall or a refusal of this one entity (a private profile): if the example args
    // answer through the same tier, the args are the problem, and a browser run would not help.
    if (a.class === "blocked" && a.missing && !write && !examplesChecked && !opts.callOnly) {
      examplesChecked = true;
      const examples = exampleArgs(op);
      if (
        examples &&
        !sameArgs(examples, args, op) &&
        (await attempt({ ...ctx, args: examples }, op, tier)).class === "ok"
      ) {
        return done({
          ok: false,
          class: "input",
          tier,
          reason: `refused for these args (${a.reason}); the example args still return data, so the operation works`,
          next: `check the args (a private, restricted or missing entity is refused this way) against: api-anything ops ${siteName}; do not heal or re-add`,
        });
      }
    }
    // a 451 is the site's answer to this network: a browser on it gets the same
    if (a.class === "blocked" && tier < (write ? 2 : 3) && a.status !== 451) {
      notes.push(`tier ${tier} was blocked (${a.reason})`);
      tier++;
      continue;
    }
    // Each step once per call, at any tier; a retry that still says auth goes on to the next step (a
    // changed analytics cookie is a changed request, not a renewed token). A write gets here only
    // when it certainly did not run.
    if (a.class === "auth" && authStep < 3) {
      // An imported session is a mirror of the everyday browser: silently re-import from the same
      // profile once (browserless), in case the human re-signed in there. It lands in the jar and
      // in the Chrome profile tiers 2 and 3 send from. Then retry.
      if (authStep < 1 && (await reimport())) continue;
      // tier 3 ran the site's own page: the profile's cookies and session values are what it just used
      if (tier === 3 || ctx.maxTier <= 1) return fail();
      if (authStep < 2) {
        authStep = 2;
        // the profile's cookies into the jar: none of the user's session is touched for an unconfirmed op
        if (!ctx.unconfirmed && (await refreshCookies(ctx, op, tier))) continue;
      }
      authStep = 3;
      // Session values (a bearer, a guest token) come from the site's own requests: a trigger run
      // refreshes them, and for a read its answer is this call's answer.
      if (
        op.readOnly &&
        ctx.maxTier >= 3 &&
        browserAvailable() &&
        op.slots.some((s) => s.ref?.startsWith("session:"))
      ) {
        const b = await attempt(ctx, op, 3);
        if (b.class === "ok") {
          const why = [...notes, `tier ${tier} said ${a.class} (${a.reason})`].join("; ");
          return done(success(b, { reason: `${why}; refreshed the session through the site's own request` }));
        }
        // The run answered other args (a trigger fixed to one page), but it refreshed the session values: retry once.
        continue;
      }
      // A write's page-issued token (a CSRF field, fb_dtsg) went stale, and a login renews only cookies:
      // run the trigger as learning does, the write intercepted and never sent, to refresh it; retry once.
      if (
        !op.readOnly &&
        ctx.maxTier >= 3 &&
        browserAvailable() &&
        op.slots.some((s) => s.ref?.startsWith("session:"))
      ) {
        try {
          await runOpTrigger(siteName, op, args, { intercept: true });
          continue;
        } catch {
          // no browser run: the call keeps its auth answer
        }
      }
    }
    // a proof that drifted is no answer: the write stays as it was, and its read is not healed here
    if (a.class === "drift" && !proof) return done(await onDrift(ctx, site, op, a));
    // Recovery is spent, plain HTTP still says auth, and the site has no login on record that could
    // have run out: a wall that answers 419 or 401 to what is not a browser looks the same. One tier-2
    // attempt tells them apart, for a read only: a page can send a request more than once (its own
    // scripts, a retry after a navigation or a reset), and a write is sent once. When the attempt does
    // not get the data, the call ends with tier 1's answer.
    if (a.class === "auth" && tier === 1 && !write && ctx.maxTier >= 2 && browserAvailable() && noLogin()) {
      const b = await attempt(ctx, op, 2);
      if (b.class === "ok") {
        if (!proof) rememberTier(siteName, op.name, 2);
        const why = `tier 1 said auth with no login on record for this site (${a.reason}); a real page got the answer`;
        return done(success(b, { reason: why }));
      }
    }
    // A credential marked public (a web app's shared bearer) answers auth when the site rotated it,
    // which no login fixes: re-learn it from the page, as for drift.
    if (a.class === "auth" && op.readOnly && op.public?.length && noLogin() && !proof && !opts.callOnly)
      return done(await onDrift(ctx, site, op, { ...a, class: "drift" }));
    return fail();
  }
}

/** Forced heal for `api-anything heal`: ignores the stale guard. Reads only; a write's check would perform it. */
export async function heal(
  siteName: string,
  opName: string,
  args: Record<string, unknown> = {},
  opts: CallOptions = {},
): Promise<CallResult & { strategy?: string }> {
  const t0 = Date.now();
  const log: Attempt[] = [];
  let resolved: Operation | undefined;
  const done = (r: Result, extra: { strategy?: string } = {}): CallResult & { strategy?: string } => {
    const f = finish(r, resolved, resolved ? siteName : undefined, log);
    const sessions = [resolved ? sessionOrNone(siteName) : undefined];
    if (f.reason) f.reason = hide(f.reason, sessions, true);
    if (f.next) f.next = hide(f.next, sessions);
    if (f.heal) f.heal = { ...f.heal, changes: f.heal.changes.map((c) => hide(c, sessions)) };
    return {
      ...f,
      ...(f.ok && f.data !== undefined ? resultView(f.data) : {}),
      ...extra,
      ms: Date.now() - t0,
    };
  };
  if (opts.callOnly)
    return done({
      ok: false,
      class: "refused",
      reason: "callOnly does not heal operations",
      next: `ask the user to run: api-anything heal ${siteName} ${opName}`,
      nextCall: { action: "heal" },
    });
  const found = resolveCall(siteName, opName);
  if ("ok" in found) return done(found);
  const { site, op, theirs } = found;
  resolved = op;
  siteName = site.name;
  if (theirs) dropUnbound(siteName);
  if (!op.readOnly) {
    return done({
      ok: false,
      class: "refused",
      reason: "healing a write is validated by performing it",
      next: `writes heal during a real call: api-anything call ${siteName} ${opName} ... --allow-writes`,
      nextCall: { action: "report" },
      retry: "no",
    });
  }
  const capped = unconfirmed(site, op);
  const ctx: Ctx = {
    site: siteName,
    args,
    opts,
    maxTier: callTiers(site, op, opts.maxTier).maxTier,
    log,
    shared: site.shared,
    unconfirmed: capped,
    gen: randomBytes(8).toString("hex"),
  };
  const tier = Math.min(Math.max(op.minTier, rememberedTier(siteName, op.name) ?? 1), 2) as Tier;
  const h = await safeHeal(
    healOperation(siteName, op, args, {
      validate: (c) => attempt(ctx, c, tier),
      fetchImpl: opts.fetchImpl,
      loginCookies: site.loginCookies,
      browser: ctx.maxTier > 1 && !capped,
    }),
  );
  if (h.outcome === "healed")
    return done(success(h.attempt, { healed: true, heal: { strategy: h.strategy, changes: h.changes } }), {
      strategy: h.strategy,
    });
  if (h.outcome === "identical") {
    // The same template is no proof it works: its answer says whether the op does.
    const filled = withDefaults(op, args);
    const complete = op.params.every((p) => !p.required || filled[p.name] !== undefined);
    const b = await attempt({ ...ctx, args: complete ? filled : (exampleArgs(op) ?? filled) }, op, tier);
    const why = "the stored template is already current";
    if (b.class === "ok") return done(success(b, { healed: false, reason: why }));
    const recipe = b.class === "drift";
    return done({
      ok: false,
      class: b.class,
      tier: b.tier,
      reason: `${why}, and it answers: ${b.reason}`,
      next: recipe
        ? `if the site works in a browser, re-learn the response recipe: api-anything add ${siteName} ${op.name} ... --extract <path> (api-anything capture <trigger url> shows the response); otherwise report it`
        : nextFor(b.class, siteName, op, b),
      ...stepOf(b),
      ...(recipe ? { nextCall: { action: "relearn" } } : {}),
    });
  }
  const b = h.attempt ?? h.fallback;
  return done({
    ok: false,
    class: b?.class ?? "drift",
    tier: b?.tier,
    reason: h.reason,
    next: nextFor(b?.class ?? "drift", siteName, op, b),
    ...(b ? stepOf(b) : {}),
    // this was the heal: what is left is learning it again
    ...((b?.class ?? "drift") === "drift" ? { nextCall: { action: "relearn" } } : {}),
  });
}
