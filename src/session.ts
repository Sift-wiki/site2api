/** Per-site cookie jar and session values under ~/.api-anything (0700 dirs, 0600 files). */
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getDomain } from "tldts";
import { siteOf } from "./domain.js";
import { besideOrigins, credentialsOf, originsOf } from "./secrets.js";
import type { StoredCookie } from "./types.js";

export interface Session {
  cookies: StoredCookie[];
  /** values of session: refs (auth/anti-bot headers), refreshed by every capture */
  values: Record<string, string>;
  /**
   * The host of the request each value was captured from. A session: ref resolves only for a request
   * to that host, so a spec cannot send a value to a host of its choosing, a sibling on the same
   * site included. A value from before the field has none and is sent as before; `pull` drops those,
   * since a pulled spec is someone else's.
   */
  valueHosts?: Record<string, string>;
  /**
   * What a learn classified each name in `values` as. A save-time scan skips a "setting"; a name with
   * no entry, one a file written before the field or a refused add left behind, is scanned like a
   * credential until a learn classifies it. "credential" is sticky: no later learn downgrades one, and
   * every write records here what the scan keeps (`recordProtection`), so no rotation undoes it.
   */
  kinds?: Record<string, "setting" | "credential">;
  /**
   * The origins this site's saved operations send to or open, recorded with each save and never
   * dropped. A value equal to one is no credential (`besideOrigins`), so no write records a setting as
   * one for it.
   */
  origins?: string[];
  /** where the cookies came from: "<browser>:<profile>" (import), "window", or "file"; drives self-heal re-import */
  source?: string;
  /**
   * The names, never the values, of the cookies a signed-out visit to the site is given (`knownGuests`,
   * saved by a login). A framework hands every visitor a `laravel_session` or an `_app_session`, so a name here
   * is no evidence of a sign-in.
   */
  guestCookies?: string[];
  updatedAt?: string;
}

export const home = () => process.env.API_ANYTHING_HOME || join(homedir(), ".api-anything");

/**
 * Site names become file names; refuse anything that could leave the directory. Lower-cased, so
 * "EDGE" and "edge" are one site on every file system (and share one state).
 */
export function safeName(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.includes("..")) throw new Error(`invalid site name "${name}"`);
  return name.toLowerCase();
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Atomic write with 0600 (writeFile's mode is ignored for an existing file, hence the chmod). */
export function writePrivate(file: string, text: string): void {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${file} is corrupt (${(e as Error).message}); fix or delete it`);
  }
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run fn holding an exclusive lock file next to `file`, so a read-modify-write in one process
 * never drops another process's update. A lock older than 10 s is a crashed holder's and is taken over.
 */
export function withLock<T>(file: string, fn: () => T): T {
  ensureDir(dirname(file));
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  let held = false;
  while (!held) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      held = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
      } catch {
        /* released meanwhile */
      }
      // ponytail: after 10 s of contention go ahead unlocked rather than hang a call
      if (Date.now() > deadline) break;
      pause(2);
    }
  }
  try {
    return fn();
  } finally {
    if (held) rmSync(lock, { force: true });
  }
}

const CAPTURE_TTL_MS = 24 * 60 * 60_000;
const CAPTURES_KEPT = 20;

/**
 * Captures hold every response body and the run's cookie values, and one page can be tens of MB:
 * keep the newest 20, none older than 24 h. Runs after each new capture.
 */
export function pruneCaptures(now = Date.now()): void {
  const dir = join(home(), "captures");
  let files: { file: string; at: number }[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: join(dir, f), at: statSync(join(dir, f)).mtimeMs }));
  } catch {
    return; // no captures yet
  }
  files.sort((a, b) => b.at - a.at);
  files.forEach((f, i) => {
    if (i >= CAPTURES_KEPT || now - f.at > CAPTURE_TTL_MS) rmSync(f.file, { force: true });
  });
}

export const sessionFile = (site: string) => join(home(), "sessions", `${safeName(site)}.json`);

export function loadSession(site: string): Session {
  const file = sessionFile(site);
  const s = readJson<Partial<Session>>(file, {});
  if (!s || typeof s !== "object" || (s.cookies !== undefined && !Array.isArray(s.cookies)))
    throw new Error(`${file} is not a session file; delete it and log in again`);
  return {
    cookies: s.cookies ?? [],
    values: s.values ?? {},
    ...(s.valueHosts && typeof s.valueHosts === "object" ? { valueHosts: s.valueHosts } : {}),
    ...(s.kinds ? { kinds: s.kinds } : {}),
    ...(Array.isArray(s.origins) ? { origins: s.origins } : {}),
    ...(Array.isArray(s.guestCookies) ? { guestCookies: s.guestCookies } : {}),
    source: s.source,
    updatedAt: s.updatedAt,
  };
}

/**
 * The protection the save-time scan computes lives in the values, not in the file: it keeps a setting
 * that holds a credential, or that a credential holds. Rotating either side (a new bearer, a
 * re-imported cookie) would undo it, so every setting the scan keeps is recorded as a credential here
 * -- before the write and after it, since either state can hold the relationship -- and a credential
 * is sticky. A setting whose own value this write replaces is left alone: the protected text is gone.
 */
function recordProtection(site: string, s: Session, urls: (string | undefined)[]): Session {
  if (!s.kinds || !Object.values(s.kinds).includes("setting")) return s; // nothing is exempt: nothing to keep
  const kinds = { ...s.kinds };
  const stored = loadSession(site);
  // A name this write calls a setting that the stored file left unclassified -- a file written before
  // the field, a refused add -- was scanned there like a credential, so the scan was never asked what
  // it protected; it is asked now, as the setting this write makes it, or the same write replacing the
  // other side (a re-imported cookie) would take that relationship apart unseen. A name this write does
  // not call a setting stays unclassified there, so it goes on protecting.
  const was: Session = {
    ...stored,
    kinds: {
      ...Object.fromEntries(Object.keys(kinds).flatMap((n) => (kinds[n] === "setting" ? [[n, "setting"]] : []))),
      ...stored.kinds,
    },
  };
  // The origins of an operation not saved yet relax only what this write stores: what the file held is
  // protected as it was, since a refused save would otherwise leave that protection taken apart.
  const own = s.origins ?? [];
  for (const [held, origins] of [
    [was, own],
    [s, [...own, ...urls]],
  ] as const)
    for (const name of Object.keys(credentialsOf(besideOrigins(held, origins)).values))
      if (held.kinds?.[name] === "setting" && kinds[name] === "setting" && held.values[name] === s.values[name])
        kinds[name] = "credential";
  return { ...s, kinds };
}

/**
 * Every write of the session file goes through here, so the protection a scan found is never lost.
 * It returns what it wrote: a caller that goes on scanning with the session it passed in would use
 * kinds the seal has already overruled, and save a spec this file's own kinds refuse. `urls`: those of
 * an operation being learned, whose origins count as the site's own for this write only.
 */
export function saveSession(site: string, s: Session, urls: (string | undefined)[] = []): Session {
  const sealed = recordProtection(site, s, urls);
  writePrivate(sessionFile(site), JSON.stringify({ ...sealed, updatedAt: new Date().toISOString() }, null, 1));
  return sealed;
}

const expired = (c: StoredCookie, now: number) => c.expires > 0 && c.expires * 1000 <= now;

/**
 * Merge a browser run's cookies and session values into the stored session and save it. `captured`:
 * the values, and the URL of the request they were sent in, whose host each is bound to.
 */
export function mergeCapture(
  site: string,
  cookies: StoredCookie[],
  captured: { from: string; values: Record<string, string> } = { from: "", values: {} },
  /**
   * a learn's classification of `values`, and the URLs its operation sends to or opens; without one a
   * name whose value changed is unclassified again
   */
  learned?: { settings: string[]; urls?: (string | undefined)[] },
  now = Date.now(),
): Session {
  const { values } = captured;
  return withLock(sessionFile(site), () => {
    const s = loadSession(site);
    const valueHosts = { ...s.valueHosts };
    if (Object.keys(values).length) {
      const host = new URL(captured.from).hostname.toLowerCase();
      for (const name of Object.keys(values)) valueHosts[name] = host;
    }
    const key = (c: StoredCookie) => `${c.name}\0${c.domain.toLowerCase()}\0${c.path}`;
    const jar = new Map(s.cookies.map((c) => [key(c), c]));
    for (const c of cookies) jar.set(key(c), c);
    const kinds = { ...s.kinds };
    // This learn classifies every name it stored, and a credential stays one: a later learn reading the
    // same name as a setting would otherwise drop the protection the first one established.
    if (learned)
      for (const name of Object.keys(values))
        kinds[name] = learned.settings.includes(name) && kinds[name] !== "credential" ? "setting" : "credential";
    // A refresh (a trigger run, a recapture) replaces values without classifying them, and the page can
    // put anything in a name a learn once read as a setting: a changed value is unclassified again, so the
    // scan protects it until a learn reads it. An unchanged one keeps its kind, and a credential stays one.
    else
      for (const [name, value] of Object.entries(values))
        if (kinds[name] === "setting" && s.values[name] !== value) delete kinds[name];
    const merged = {
      cookies: [...jar.values()].filter((c) => !expired(c, now)),
      values: { ...s.values, ...values },
      ...(Object.keys(valueHosts).length ? { valueHosts } : {}),
      source: s.source,
      ...(Object.keys(kinds).length ? { kinds } : {}),
      ...(s.origins ? { origins: s.origins } : {}),
      ...(s.guestCookies ? { guestCookies: s.guestCookies } : {}),
    };
    return saveSession(site, merged, learned?.urls);
  });
}

/**
 * Delete the values that have no host to go back to (from before `valueHosts`), before a spec
 * someone else wrote uses this session: such a value would go wherever its request points. The next
 * trigger run captures them again, bound.
 */
export function dropUnbound(site: string): void {
  withLock(sessionFile(site), () => {
    const s = loadSession(site);
    const bound = boundSession(s);
    if (Object.keys(bound.values).length < Object.keys(s.values).length) saveSession(site, bound);
  });
}

/** The same filter as dropUnbound, without changing the session or writing a file. */
export function boundSession(s: Session): Session {
  return { ...s, values: Object.fromEntries(Object.entries(s.values).filter(([k]) => s.valueHosts?.[k])) };
}

/** The session with `<name>` in place of every cookie and value: a request built with it is safe to show. */
export function placeholders(s: Session): Session {
  return {
    ...s,
    cookies: s.cookies.map((c) => ({ ...c, value: `<${c.name}>` })),
    values: Object.fromEntries(Object.keys(s.values).map((k) => [k, `<${k}>`])),
  };
}

/** Record the origins of an operation just saved as the site's own (`Session.origins`). */
export function recordOrigins(site: string, urls: (string | undefined)[]): void {
  withLock(sessionFile(site), () => {
    const s = loadSession(site);
    const origins = new Set([...(s.origins ?? []), ...originsOf(urls)]);
    if (origins.size > (s.origins?.length ?? 0)) saveSession(site, { ...s, origins: [...origins] });
  });
}

function domainMatch(host: string, domain: string): boolean {
  const d = domain.toLowerCase();
  // Playwright marks domain cookies with a leading dot; without it the cookie is host-only.
  if (d.startsWith(".")) return host === d.slice(1) || host.endsWith(d);
  return host === d;
}

function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/");
}

/** RFC 6265 domain/path/secure/expiry matching, longest path first. */
export function cookiesFor(cookies: StoredCookie[], url: string, now = Date.now()): StoredCookie[] {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const secureOk = u.protocol === "https:" || host === "localhost" || host === "127.0.0.1";
  return cookies
    .filter((c) => domainMatch(host, c.domain) && pathMatch(u.pathname || "/", c.path || "/"))
    .filter((c) => (!c.secure || secureOk) && !expired(c, now))
    .sort((a, b) => (b.path || "/").length - (a.path || "/").length);
}

export function cookieHeaderFor(cookies: StoredCookie[], url: string, now = Date.now()): string {
  return cookiesFor(cookies, url, now)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

export { siteOf };

/**
 * Value for a cookie: ref. Prefers a cookie that would be sent to url; else one from the same site
 * (page JS on www.site.com echoes its cookies to api.site.com), never another site's, a Secure
 * cookie only over https, and never an HttpOnly one: no page script can read that to echo it, and
 * a host-only session cookie would otherwise reach every other host of its site.
 */
export function cookieValue(cookies: StoredCookie[], name: string, url?: string, now = Date.now()): string | undefined {
  const live = cookies.filter((c) => c.name === name && !expired(c, now));
  if (!url) return live[0]?.value;
  const scoped = cookiesFor(cookies, url, now).find((c) => c.name === name);
  if (scoped) return scoped.value;
  const u = new URL(url);
  const site = siteOf(u.hostname.toLowerCase());
  const secureOk = u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1";
  return live.find(
    (c) => !c.httpOnly && siteOf(c.domain.replace(/^\./, "").toLowerCase()) === site && (!c.secure || secureOk),
  )?.value;
}

/** One Set-Cookie line, scoped per RFC 6265 to the URL that set it; undefined if it may not be set there. */
export function parseSetCookie(line: string, url: string, now = Date.now()): StoredCookie | undefined {
  const [pair = "", ...attrs] = line.split(";");
  const eq = pair.indexOf("=");
  if (eq < 1) return undefined;
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const dir = u.pathname.slice(0, u.pathname.lastIndexOf("/"));
  const c: StoredCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: host,
    path: dir.startsWith("/") ? dir : "/",
    expires: -1,
    httpOnly: false,
    secure: false,
  };
  let maxAge: number | undefined;
  for (const attr of attrs) {
    const i = attr.indexOf("=");
    const k = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? "" : attr.slice(i + 1).trim();
    if (k === "domain" && v) {
      const d = v.replace(/^\./, "").toLowerCase();
      // never a cookie for another site, or for a public suffix
      const site = siteOf(host);
      if ((host !== d && !host.endsWith(`.${d}`)) || (d !== site && !d.endsWith(`.${site}`))) return undefined;
      // a host that is itself a suffix (s3.amazonaws.com, localhost) gets a host-only cookie, as in a browser
      if (getDomain(d, { allowPrivateDomains: true })) c.domain = `.${d}`;
    } else if (k === "path" && v.startsWith("/")) c.path = v;
    else if (k === "max-age" && /^-?\d+$/.test(v)) maxAge = Number(v);
    else if (k === "expires" && !Number.isNaN(Date.parse(v))) c.expires = Date.parse(v) / 1000;
    else if (k === "secure") c.secure = true;
    else if (k === "httponly") c.httpOnly = true;
    else if (k === "samesite" && /^(strict|lax|none)$/i.test(v))
      c.sameSite = (v[0]!.toUpperCase() + v.slice(1).toLowerCase()) as StoredCookie["sameSite"];
  }
  // max-age wins over expires; 0 or less deletes (an expired cookie drops out of the jar)
  if (maxAge !== undefined) c.expires = maxAge <= 0 ? 1 : now / 1000 + maxAge;
  return c;
}

/** Parse a raw Cookie header ("a=1; b=\"x\"") into a name -> value map. */
export function parseCookieHeader(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

// ponytail: name heuristic for "logged in"; a site's spec can pin exact names via loginCookies.
export const AUTH_COOKIE =
  /^(auth_token|sessionid|session_id|li_at|sid|ssid|__secure-\dpsid|user_session|reddit_session|remember_\w+|\w*_session|\w*_sess)$/i;

/**
 * The live cookies that show a sign-in: the pinned `loginCookies`; else auth-looking ones whose name a
 * signed-out visitor is not also given (`guest`), since a name every visitor gets proves nothing.
 */
export function signInCookies(
  cookies: StoredCookie[],
  loginCookies?: string[],
  guest: string[] = [],
  now = Date.now(),
): StoredCookie[] {
  const live = cookies.filter((c) => !expired(c, now) && c.value);
  if (loginCookies?.length) return live.filter((c) => loginCookies.includes(c.name));
  return live.filter(
    (c) =>
      (c.name === "logged_in" && c.value === "yes") ||
      (!guest.includes(c.name) && AUTH_COOKIE.test(c.name) && c.value.length >= 8),
  );
}

/**
 * Cookies every visitor is given, signed in or not, that carry no account: analytics, consent, bot
 * management, CSRF tokens, and Google's signed-out preference cookies. Only positive evidence belongs
 * here: never a login cookie (Google's SID, HSID, SSID, APISID, SAPISID and __Secure-*PSID* stay out).
 */
export const ANONYMOUS_COOKIE =
  /^(_ga|_ga_[\w-]+|_gid|_gat|_gat_[\w-]+|_fbp|CONSENT|SOCS|OptanonConsent|OptanonAlertBoxClosed|euconsent(-v\d+)?|__cf_bm|_cfuvid|cf_clearance|csrftoken|XSRF-TOKEN|_csrf|NID|AEC|1P_JAR|__Secure-ENID)$/;

/**
 * Whether a cookie of this name may carry the user's account. A name is anonymous only on positive
 * evidence (`ANONYMOUS_COOKIE`, or a name a signed-out visit to the site is given, `guest`); an unknown
 * name may carry one, and a pinned login name always does.
 */
export function mayCarryAccount(name: string, loginCookies: string[] = [], guest: string[] = []): boolean {
  return loginCookies.includes(name) || !(guest.includes(name) || ANONYMOUS_COOKIE.test(name));
}

/** The live, non-empty cookies that may carry the user's account (`mayCarryAccount`). */
export function accountCookies(
  cookies: StoredCookie[],
  loginCookies?: string[],
  guest?: string[],
  now = Date.now(),
): StoredCookie[] {
  return cookies.filter((c) => !expired(c, now) && c.value && mayCarryAccount(c.name, loginCookies, guest));
}

export function loggedIn(
  cookies: StoredCookie[],
  loginCookies?: string[],
  guest?: string[],
  now = Date.now(),
): boolean {
  const found = signInCookies(cookies, loginCookies, guest, now);
  if (loginCookies?.length) return loginCookies.every((n) => found.some((c) => c.name === n));
  return found.length > 0;
}

/** The names of the sign-in cookies `after` holds that `before` did not, or held with another value. */
export function renewedSignIn(
  before: StoredCookie[],
  after: StoredCookie[],
  loginCookies?: string[],
  guest?: string[],
  now = Date.now(),
): string[] {
  const had = new Set(signInCookies(before, loginCookies, guest, now).map((c) => `${c.name}=${c.value}`));
  const fresh = signInCookies(after, loginCookies, guest, now).filter((c) => !had.has(`${c.name}=${c.value}`));
  return [...new Set(fresh.map((c) => c.name))].sort();
}
