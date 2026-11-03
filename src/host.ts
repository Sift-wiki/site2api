/**
 * Local discovery and approval-bound calls for agent hosts. Learning, login, registry maintenance
 * and sharing remain CLI workflows. This module never installs specs or starts background work.
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { closeBrowser, closeIdleBrowser } from "./browser.js";
import { setAt, templateRefs } from "./codec.js";
import { describeOperation, type OperationDescription } from "./describe.js";
import { siteOf } from "./domain.js";
import {
  badSession,
  bareCall,
  type CallOptions,
  type CallResult,
  call,
  callOnlyWriteRefusal,
  callSession,
  callTiers,
  finish,
  resolveCall,
  type Tier,
  tierBlocked,
  unsendable,
} from "./execute.js";
import { fillTrigger } from "./heal.js";
import { buildRequest, filledValues, unknownArgs, withDefaults } from "./http.js";
import { profileSignedIn } from "./profile-state.js";
import { captureLive, redact } from "./secrets.js";
import { accountCookies, home, loadSession, placeholders, type Session } from "./session.js";
import type { Operation, Request, Site, Trigger } from "./spec.js";
import { listSites, loadSite, type Resolved, rememberedTier, siteNotes } from "./store.js";
import type { StoredCookie } from "./types.js";

/** A callable operation and the trigger-page prefixes a host can match against browser URLs. */
export interface HostOperation {
  name: string;
  readOnly: boolean;
  description?: string;
  /** Static origin + path before the first {param}; templated origins and invalid URLs are omitted. */
  pages: string[];
}

/** One locally installed site. signedIn is a caution, not a verified login. */
export interface HostSite {
  name: string;
  source: "user" | "bundled" | "pulled";
  hosts: string[];
  /** Whether a call may run under the user's account; anonymity needs positive evidence (docs/HOST.md). */
  signedIn: boolean;
  operations: HostOperation[];
}

/** An offline preview, or the same input/error class call() would return without sending. */
export type CallPlan =
  | {
      ok: true;
      site: string;
      op: string;
      readOnly: boolean;
      signedIn: boolean;
      /** Starting transport tier, with the same remembered-tier and cap rules as call(). */
      tier: Tier;
      /** Approved transport cap. Changing it requires a new plan. */
      maxTier: Tier;
      /** Defaults filled; these are call arguments, not redacted display text. */
      args: Record<string, unknown>;
      /** Like CLI --dry: credentials are placeholders. UUIDs and derived values are placeholders too. */
      request: Request;
      /** Tier-3 steps, companion matches, and the count/step indices of confirms the page may accept. */
      trigger?: Omit<Trigger, "confirms"> & { confirms?: { count: number; steps: number[] } };
      /** SHA-256 binding args, spec, preview, tier and cap to this approval. */
      fingerprint: string;
    }
  | { ok: false; result: CallResult };

type ReadyPlan = Extract<CallPlan, { ok: true }>;

/**
 * Host controls transport, write permission and the answer's shape (`view`), never healing, force or
 * duplicate overrides. `view` shapes only the answer, so it is not part of the approved plan.
 */
export type HostCallOptions = Pick<
  CallOptions,
  "allowWrites" | "maxTier" | "timeoutMs" | "fetchImpl" | "minIntervalMs" | "view"
>;
export type HostPlanOptions = Pick<CallOptions, "maxTier">;

/** Point every default bundled-spec/notes lookup at the host's extracted directory. */
export { setBundledDir } from "./store.js";
/** Shared call result and transport tier types, without importing the main library entry. */
export type { CallResult, OperationDescription, Tier };

const PARAM = "__api_anything_param__";

function staticUrl(text: string): URL | undefined {
  try {
    const url = new URL(text.replace(/\{[^{}]+\}/g, PARAM));
    if (!["http:", "https:"].includes(url.protocol) || url.host.includes(PARAM)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function pages(op: Operation): string[] {
  const url = staticUrl(op.trigger.url);
  return url ? [url.origin + url.pathname.split(PARAM)[0]!] : [];
}

function urlsOf(op: Pick<Operation, "request" | "trigger" | "slots"> & Partial<Pick<Operation, "readback">>): string[] {
  return [
    op.request.url,
    ...op.slots.flatMap((s) => (s.from ? [s.from.request.url] : [])),
    op.trigger.url,
    ...(op.trigger.softFrom ? [op.trigger.softFrom] : []),
    ...(op.trigger.steps ?? []).flatMap((s) => (s.action === "goto" && s.value ? [s.value] : [])),
    ...(op.readback && "read" in op.readback ? urlsOf(op.readback.read) : []),
  ];
}

const siteUrls = (site: Site) => [site.baseUrl, ...site.operations.flatMap(urlsOf)];

function hostnames(urls: string[]): string[] {
  return [
    ...new Set(
      urls.flatMap((text) => {
        const url = staticUrl(text);
        return url ? [url.hostname] : [];
      }),
    ),
  ];
}

/**
 * The registrable domains of every login on record (`Session.source`): its cookies' domains, its site's
 * hosts, and the site's name, which `login <domain>` takes from the host. A login also puts its cookies
 * into api-anything's own profile, which every site on those domains shares.
 */
function loginDomains(): Set<string> {
  const domains = new Set<string>();
  let files: string[] = [];
  try {
    files = readdirSync(join(home(), "sessions"));
  } catch {
    // no session saved yet
  }
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const name = file.slice(0, -".json".length);
    try {
      const s = loadSession(name);
      if (!s.source) continue;
      domains.add(siteOf(name));
      for (const c of s.cookies) domains.add(siteOf(c.domain.replace(/^\./, "")));
      const r = loadSite(name);
      if (r) for (const host of hostnames(siteUrls(r.site))) domains.add(siteOf(host));
    } catch {
      // an unreadable session is no login on record; an unreadable spec still leaves its cookies' domains
    }
  }
  return domains;
}

/** A write's readback read as it is sent: the read op it names, or its inline read under the write's version. */
function readbackOf(site: Site, op: Operation): Operation | undefined {
  const rb = op.readback;
  if (!rb) return undefined;
  return "op" in rb
    ? site.operations.find((o) => o.name === rb.op)
    : { ...op, request: rb.read.request, slots: rb.read.slots };
}

/** What a call may send from the stored session: jar cookies, and the names of the stored values it fills. */
interface Sendable {
  cookies: StoredCookie[];
  values: string[];
}

// A value the page itself mints for visitors (X's x-guest-token); any other captured value may be an account's.
const GUEST_VALUE = /(^|[-_])guest([-_]|$)/i;

/**
 * What a call of `op` starting at `tier` may send from `session`, after execution's filters
 * (`callSession`): every jar cookie, since a redirect or a lookup can carry any of them, and the stored
 * values its request and a write's readback read fill. A tier-3 run's page fills its own values, but the
 * value it captured shows what the page holds (a bearer in its storage), so it counts unless it is a guest's.
 */
function sendable(site: Site, op: Operation, session: Session, theirs: boolean, tier: Tier): Sendable {
  const read = readbackOf(site, op);
  const own = callSession(site, op, session, theirs);
  const back = read && callSession(site, read, session, theirs);
  return {
    cookies: [...own.cookies, ...(back?.cookies ?? [])],
    values: [
      ...filledValues(op, own).filter((name) => tier < 3 || !GUEST_VALUE.test(name)),
      ...(read && back ? filledValues(read, back) : []),
    ],
  };
}

/**
 * Whether the call may run under the user's account. Anonymity needs positive evidence: a login on
 * record, a stored value the request fills, or any live cookie whose name is not known to be anonymous
 * (`accountCookies`) makes it true, so an unknown cookie name counts and a guest's NID does not.
 * `sent`: what the call may send from `s`. `browser`: the call can reach api-anything's own Chrome profile.
 */
function signedIn(s: Session, site: Site, sent: Sendable, browser: boolean, logins?: Set<string>): boolean {
  if (s.source || sent.values.length > 0) return true;
  if (accountCookies(sent.cookies, site.loginCookies, s.guestCookies).length > 0) return true;
  // Session values are captured in the own profile, so they carry whatever sign-in it holds.
  if (!browser && Object.keys(s.values).length === 0) return false;
  const urls = siteUrls(site);
  // A templated origin could be any site in the profile: no host list, so any domain counts.
  const hosts = urls.some((url) => !staticUrl(url)) ? [] : hostnames(urls);
  const domains = logins ?? loginDomains();
  if (hosts.length ? hosts.some((host) => domains.has(siteOf(host))) : domains.size > 0) return true;
  return profileSignedIn(hosts, site.loginCookies, s.guestCookies);
}

function summary(r: Resolved, logins: Set<string>): HostSite {
  const { site } = r;
  const session = loadSession(site.name);
  const theirs = r.source !== "user" || !!site.shared;
  const sent = site.operations.map((op) => {
    const { tier } = callTiers(site, op, undefined, rememberedTier(site.name, op.name));
    return sendable(site, op, session, theirs, tier);
  });
  return {
    name: site.name,
    source: r.source === "registry" ? "pulled" : r.source,
    hosts: hostnames(siteUrls(site)),
    signedIn: signedIn(
      session,
      site,
      { cookies: sent.flatMap((s) => s.cookies), values: sent.flatMap((s) => s.values) },
      site.operations.length > 0,
      logins,
    ),
    operations: site.operations.map((op) => ({
      name: op.name,
      readOnly: op.readOnly,
      ...(op.description ? { description: op.description } : {}),
      pages: pages(op),
    })),
  };
}

/** List every valid callable site using local files only; invalid specs/sessions are omitted. */
export function hostSites(): HostSite[] {
  const logins = loginDomains();
  return listSites().flatMap((name) => {
    try {
      const r = loadSite(name);
      return r ? [summary(r, logins)] : [];
    } catch {
      return [];
    }
  });
}

/** Describe one installed site and its caller notes, without pulling, calling or opening a browser. */
export function hostSite(
  name: string,
): { site: HostSite; notes?: string; operations: OperationDescription[] } | undefined {
  const r = loadSite(name);
  if (!r) return undefined;
  const notes = siteNotes(r.site.name);
  return {
    site: summary(r, loginDomains()),
    ...(notes ? { notes } : {}),
    operations: r.site.operations.map((op) => describeOperation(r.site, op.name)),
  };
}

const refused = (r: Omit<CallResult, "ms">, op?: Operation, site?: string): CallPlan => ({
  ok: false,
  result: { ...finish(r, op, site, []), ms: 0 },
});

/**
 * The session a preview is built from: `effective`, the one the call may send, as placeholders. Any
 * response can set, rotate or drop a cookie, so every cookie: ref shows its placeholder whether or not the
 * jar holds it yet; whether one may carry an account is `signedIn`'s answer. At tiers 1 and 2 a session:
 * ref shows its placeholder only when a stored value fills it and is left out otherwise, as at send time,
 * so a value stored after approval changes the plan. At tier 3 the page fills session: refs itself, so
 * every one `stored` holds no value for shows its placeholder too. A stored value the filters leave out
 * stays out.
 */
function previewSession(op: Operation, effective: Session, stored: Session, bare: boolean, tier: Tier): Session {
  const shown = placeholders(effective);
  if (bare) return shown;
  let domain: string;
  try {
    domain = new URL(op.request.url).hostname.toLowerCase();
  } catch {
    return shown; // buildRequest reports the URL
  }
  const refs = op.slots.flatMap((s) => [...(s.ref ? [s.ref] : []), ...(s.template ? templateRefs(s.template) : [])]);
  const named = (kind: string) =>
    new Set(refs.flatMap((ref) => (ref.startsWith(`${kind}:`) ? [ref.slice(kind.length + 1)] : [])));
  const absent = tier === 3 ? [...named("session")].filter((name) => !Object.hasOwn(stored.values, name)) : [];
  return {
    ...shown,
    values: { ...shown.values, ...Object.fromEntries(absent.map((name) => [name, `<${name}>`])) },
    cookies: [...named("cookie")].map((name) => ({
      name,
      value: `<${name}>`,
      domain,
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
    })),
  };
}

/** The request as a host shows it: placeholders for credentials, generated values and looked-up values. */
function previewRequest(
  site: Site,
  op: Operation,
  args: Record<string, unknown>,
  sessions: { effective: Session; stored: Session },
  tier: Tier,
  hide: (text: string) => string,
): Request {
  const bare = bareCall(site, op);
  let req = buildRequest(op, args, previewSession(op, sessions.effective, sessions.stored, bare, tier), "host-preview");
  for (const slot of op.slots) {
    if (slot.gen) req = setAt(req, slot.at, "<generated:uuid>");
    if (slot.from) req = setAt(req, slot.at, `<derived:${slot.path}>`);
  }
  // Which cookies go is the jar's or the page's at send time, not the plan's: anonymous ones come with
  // every response, and `signedIn` says whether a login is among them. At tier 2 or 3 the page, not the
  // per-site jar, chooses them, so the jar's account is not implied either.
  delete req.headers.cookie;
  if (!bare || tier === 3) req.headers.cookie = tier === 1 ? "<per-site jar cookies>" : "<browser-profile cookies>";
  return {
    method: hide(req.method),
    url: hide(req.url),
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [hide(k), hide(v)])),
    ...(req.body !== undefined ? { body: hide(req.body) } : {}),
  };
}

/** What a tier-3 run will do: the filled page and steps, the confirms it may accept, the companions it lets go. */
function previewTrigger(
  op: Operation,
  args: Record<string, unknown>,
  hide: (text: string) => string,
): NonNullable<ReadyPlan["trigger"]> {
  const { url, softFrom, steps } = fillTrigger(op.trigger, args);
  const { confirms, companions } = op.trigger;
  return {
    url: hide(url),
    ...(softFrom ? { softFrom: hide(softFrom) } : {}),
    ...(steps
      ? {
          steps: steps.map((s) => ({
            ...s,
            ...(s.selector !== undefined ? { selector: hide(s.selector) } : {}),
            ...(s.value !== undefined ? { value: hide(s.value) } : {}),
          })),
        }
      : {}),
    ...(confirms ? { confirms: { count: confirms.length, steps: confirms.map((c) => c.step) } } : {}),
    ...(companions
      ? { companions: companions.map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, hide(v)]))) }
      : {}),
  };
}

/** Build a redacted preview and approval hash. No requests, file writes or browser launch. */
export function planCall(
  site: string,
  op: string,
  args: Record<string, unknown> = {},
  opts: HostPlanOptions = {},
): CallPlan {
  const found = resolveCall(site, op);
  if ("ok" in found) return refused(found);
  const name = found.site.name;
  const refuse = (r: Omit<CallResult, "ms">) => refused(r, found.op, name);
  const input = (reason: string) =>
    refuse({ ok: false, class: "input", reason, next: `check the args against: api-anything ops ${name}` });
  if (
    args === null ||
    typeof args !== "object" ||
    (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)
  )
    return input("args must be a plain object");
  if (opts.maxTier !== undefined && ![1, 2, 3].includes(opts.maxTier)) return input("maxTier must be 1, 2 or 3");
  const unknown = unknownArgs(found.op, args);
  if (unknown) return input(unknown);
  let session: Session;
  try {
    session = loadSession(name);
  } catch (e) {
    return refuse(badSession(name, e));
  }
  try {
    args = structuredClone(withDefaults(found.op, args));
    const effective = callSession(found.site, found.op, session, found.theirs);
    // Live values, as call() checks them: a placeholder in a credential's place could hide a BadHeader.
    buildRequest(found.op, args, effective, "host-preview");
    const { tier, maxTier } = callTiers(found.site, found.op, opts.maxTier, rememberedTier(name, found.op.name));
    if (tier > maxTier) return refuse(tierBlocked(found.site, found.op, { tier, maxTier }, opts.maxTier));
    const unsafeWrite = callOnlyWriteRefusal(name, found.op, tier);
    if (unsafeWrite) return refuse(unsafeWrite);
    // A caller's arg or a stored literal can echo a live value outside a credential slot.
    const live = captureLive({ cookies: session.cookies, storage: session.values });
    const hide = (text: string) => redact(text, live, { named: true });
    const request = previewRequest(found.site, found.op, args, { effective, stored: session }, tier, hide);
    const trigger = tier === 3 ? previewTrigger(found.op, args, hide) : undefined;
    return {
      ok: true,
      site: name,
      op: found.op.name,
      readOnly: found.op.readOnly,
      // The browser is reachable when the plan starts there, or when a read (a write's readback too) may climb.
      signedIn: signedIn(
        session,
        found.site,
        sendable(found.site, found.op, session, found.theirs, tier),
        tier >= 2 || (maxTier >= 2 && (found.op.readOnly || !!found.op.readback)),
      ),
      tier,
      maxTier,
      args,
      request,
      ...(trigger ? { trigger } : {}),
      // The whole spec also binds what the preview does not show: write flags, readbacks, trust rules.
      fingerprint: createHash("sha256")
        .update(JSON.stringify([found.source, found.site, found.op.name, args, request, trigger, tier, maxTier]))
        .digest("hex"),
    };
  } catch (e) {
    const r = unsendable(name, found.op, e);
    return refuse({ ...r, reason: redact(r.reason ?? "", session) });
  }
}

/**
 * Re-plan immediately before calling; any difference from the approved plan, in the spec or in what
 * was shown, refuses without sending. Calls only the installed op, with every write gate intact.
 */
export async function callPlanned(plan: ReadyPlan, opts: HostCallOptions = {}): Promise<CallResult> {
  const fresh = planCall(plan.site, plan.op, plan.args, { maxTier: opts.maxTier ?? plan.maxTier });
  if (!fresh.ok) return fresh.result;
  if (!isDeepStrictEqual(fresh, plan))
    return {
      ok: false,
      class: "refused",
      reason: "the operation or request changed after it was approved; plan and approve it again",
      ...(!plan.readOnly || !fresh.readOnly ? { write: "not_sent" as const } : {}),
      retry: "after_fix",
      next: "plan and approve the current request before calling",
      ms: 0,
    };
  try {
    return await call(fresh.site, fresh.op, fresh.args, {
      allowWrites: opts.allowWrites,
      maxTier: fresh.maxTier,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      minIntervalMs: opts.minIntervalMs,
      ...(opts.view ? { view: opts.view } : {}),
      callOnly: true,
    });
  } finally {
    // The next plan reads the profile; a browser left idle would lock it and flip signedIn for seconds.
    await closeIdleBrowser();
  }
}

/** Close the shared browser so the process can exit. Host calls never queue background work. */
export async function closeHost(): Promise<void> {
  await closeBrowser();
}
