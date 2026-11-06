/**
 * login = get a signed-in session for a site. By default it IMPORTS cookies from the user's
 * everyday browser (they are almost always already signed in there); `--window` and `--cookies`
 * are the other two sources. This module wires the pure import (import.ts) to the session store
 * and the persistent browser profile, and re-imports on a self-healing auth failure.
 */
import { readFileSync, rmSync } from "node:fs";
import { addCookiesToProfile, browserAvailable, clearProfileCookies, login } from "./browser.js";
import { profileDir } from "./heal.js";
import {
  belongs,
  cookiesFromFile,
  type ImportedSession,
  type ImportPin,
  importFromBrowsers,
  parsePin,
  profileLabel,
} from "./import.js";
import {
  loadSession,
  loggedIn,
  parseSetCookie,
  renewedSignIn,
  safeName,
  saveSession,
  sessionFile,
  signInCookies,
  siteOf,
  withLock,
} from "./session.js";
import { clearCoolDown, listSites, loadSite } from "./store.js";
import type { StoredCookie } from "./types.js";

/** The known site whose baseUrl is on this host (www. or not). */
function siteOnHost(host: string): string | undefined {
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
  return listSites().find((n) => {
    try {
      return bare(new URL(loadSite(n)!.site.baseUrl).hostname) === bare(host);
    } catch {
      return false; // a corrupt spec is reported by the commands that use it
    }
  });
}

/**
 * Turn a login target into { site, url, loginCookies }: a site name ("linkedin"), a domain
 * ("linkedin.com", "www.linkedin.com") or a URL. A domain or URL on a known site's host is that
 * site; any other one is a new site named after its host.
 */
export function resolveLoginTarget(target: string): { site: string; url: string; loginCookies?: string[] } {
  let url = target;
  if (!/^https?:\/\//i.test(target)) {
    const known = /^[a-z0-9][a-z0-9._-]*$/i.test(target) ? loadSite(target) : undefined;
    if (known) return { site: known.site.name, url: known.site.baseUrl, loginCookies: known.site.loginCookies };
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(target))
      throw new Error(`no site "${target}": give a site name from api-anything sites, a domain (example.com) or a URL`);
    url = `https://${target}`;
  }
  const host = new URL(url).hostname.toLowerCase();
  const name = siteOnHost(host);
  if (name) {
    const s = loadSite(name)!.site;
    // a bare domain means the site itself; a full URL may name its sign-in page
    return { site: s.name, url: url === target ? url : s.baseUrl, loginCookies: s.loginCookies };
  }
  return { site: host.replace(/^www\./, ""), url };
}

export interface ImportOptions {
  loginCookies?: string[];
  /** "Chrome/Profile 1" or a session source "chrome:Profile 1" */
  profile?: string;
  /** a cookies.txt / JSON export, for servers/CI with no browser */
  file?: string;
  /** also inject into api-anything's browser profile (default true when a browser is present) */
  pushProfile?: boolean;
  /** guest names to judge the import by and save with it (`knownGuests`); default the session's */
  guest?: string[];
}

const PROBE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * The names of the cookies a signed-out visitor of `url` is given: a GET with no cookies, following
 * up to five redirects within the site, reading every Set-Cookie. A cookie page script sets is not
 * seen, but the session cookie a framework gives every visitor (laravel_session, a Rails
 * _app_session, ci_session) is the server's, and a browser would cost a launch and a profile of its
 * own. Undefined when the site did not answer.
 */
export async function guestCookieNames(url: string, fetchImpl: typeof fetch = fetch): Promise<string[] | undefined> {
  const site = siteOf(new URL(url).hostname.toLowerCase());
  const names = new Set<string>();
  let at = url;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const res = await fetchImpl(at, {
        redirect: "manual",
        headers: { "user-agent": PROBE_UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
        signal: AbortSignal.timeout(5000),
      });
      for (const line of res.headers.getSetCookie()) {
        const c = parseSetCookie(line, at);
        if (c && (c.expires < 0 || c.expires * 1000 > Date.now())) names.add(c.name); // not a deletion
      }
      await res.body?.cancel();
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      const next = new URL(location, at);
      if (!/^https?:$/.test(next.protocol) || siteOf(next.hostname.toLowerCase()) !== site) break;
      at = next.href;
    }
  } catch {
    if (!names.size) return undefined; // no answer: nothing learned
  }
  return [...names].sort();
}

/** Two lists of guest names as one: a name a signed-out visit was once given proves nothing, ever. */
const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])].sort();

/**
 * The guest names to judge a login by: the session's, plus what a signed-out visit of `url` is given
 * now. Saved only with the login that uses them, so a failed login leaves the session as it was. A
 * site with pinned `loginCookies` is not probed: they decide alone.
 */
export async function knownGuests(
  site: string,
  url: string,
  loginCookies?: string[],
  fetchImpl?: typeof fetch,
): Promise<string[]> {
  const stored = loadSession(site).guestCookies;
  if (loginCookies?.length) return stored ?? [];
  return union(stored, await guestCookieNames(url, fetchImpl));
}

export interface Imported extends ImportedSession {
  /** the cookies show a sign-in, by `loginCookies` or a login-looking name no signed-out visitor gets */
  signedIn: boolean;
  /**
   * The import brought sign-in cookies the jar did not hold, or held with other values. For a site
   * where neither side holds one any rule can name, any cookie that changed: one retry is worth it.
   */
  renewed: boolean;
}

/**
 * Import a session for `site` and save it. Returns the source (e.g. "chrome:Profile 1", "file"),
 * or undefined when nothing was importable (the caller falls back to the visible window).
 */
export async function importSession(site: string, url: string, o: ImportOptions = {}): Promise<Imported | undefined> {
  let imported: ImportedSession | undefined;
  const guest = o.guest ?? loadSession(site).guestCookies;
  if (o.file) {
    const cookies = cookiesFromFile(readFileSync(o.file, "utf8"), url).filter((c) => forSite(c, url));
    if (cookies.length) imported = { cookies, source: "file", browser: "file", profile: o.file };
  } else {
    const pin = o.profile ? parsePin(o.profile) : undefined;
    imported = importFromBrowsers({ url, loginCookies: o.loginCookies, pin, guest });
  }
  if (!imported?.cookies.length) return undefined;
  const { cookies } = imported;
  const before = withLock(sessionFile(site), () => {
    const s = loadSession(site);
    const guestCookies = o.guest ? union(s.guestCookies, o.guest) : s.guestCookies;
    saveSession(site, { ...s, cookies, source: imported.source, ...(guestCookies ? { guestCookies } : {}) });
    return s.cookies;
  });
  clearCoolDown(site);
  const had = new Set(before.map((c) => `${c.name}=${c.value}`));
  const unnamed =
    !o.loginCookies?.length && !signInCookies(cookies, [], guest).length && !signInCookies(before, [], guest).length;
  if (o.pushProfile !== false && browserAvailable()) {
    try {
      await addCookiesToProfile(cookies, profileDir());
    } catch {
      // an open browser, a locked profile: the jar still works for tier 1
    }
  }
  return {
    ...imported,
    signedIn: loggedIn(cookies, o.loginCookies, guest),
    renewed:
      renewedSignIn(before, cookies, o.loginCookies, guest).length > 0 ||
      (unnamed && cookies.some((c) => !had.has(`${c.name}=${c.value}`))),
  };
}

/** Where a session's cookies came from, as a human knows it. */
const sourceLabel = (source: string, file?: string) =>
  source === "file" ? `the cookies file${file ? ` ${file}` : ""}` : profileLabel(source).label;

/** The site's host as a human types it: "linkedin.com". */
const hostOf = (url: string) => siteOf(new URL(url).hostname.toLowerCase());

/**
 * What a login by import should say beyond `ok`: that the cookies show no sign-in, or that they are
 * the ones the session already held, so a call that said `auth` will say it again. Undefined when
 * the import brought a fresh sign-in.
 */
export function importWarning(url: string, r: Imported): string | undefined {
  const from = sourceLabel(r.source, r.profile);
  const signIn =
    r.source === "file"
      ? `export the cookies again from a browser signed in to ${hostOf(url)}, then run login again`
      : `sign in to ${hostOf(url)} in ${from}, then run login again`;
  if (!r.signedIn)
    return `none of the cookies imported from ${from} shows a sign-in: it looks signed out of ${hostOf(url)}. If calls say auth, ${signIn}`;
  if (!r.renewed)
    return `the login cookies imported from ${from} are the ones the session already held: nothing was renewed. If calls said auth, the site has ended that sign-in there too: ${signIn}`;
  return undefined;
}

const forSite = (c: StoredCookie, url: string) => belongs(c.domain, siteOf(new URL(url).hostname.toLowerCase()));

/** The browser profile a human chose for this site ("chrome:Profile 1"), if its session came from one. */
export function browserSource(site: string): string | undefined {
  const source = loadSession(site).source;
  return source && source !== "window" && source !== "file" ? source : undefined;
}

/**
 * Self-heal an imported session: re-import from the same browser profile once. Used when a call
 * classified `auth` and the session came from a browser (source "<browser>:<profile>"). No-op for
 * "window" (independent session) and "file" (no path to re-read) sources. `renewed` only when the
 * login cookies came back new: the same dead cookies again would only repeat the failure. `signIn`,
 * for a browser source: what the user does when the session still fails, as "sign in to
 * linkedin.com in Chrome profile "Work"", since `api-anything login` would import from there again;
 * `profile`, that profile as `--profile` takes it.
 */
export async function reimportIfBrowser(
  site: string,
  url: string,
  loginCookies?: string[],
): Promise<{ renewed: boolean; signIn?: string; profile?: string }> {
  let source: string | undefined;
  let renewed = false;
  try {
    source = browserSource(site);
    if (!source) return { renewed };
    const pin: ImportPin = parsePin(source);
    renewed = !!(await importSession(site, url, { loginCookies, profile: `${pin.browser}/${pin.profile}` }))?.renewed;
  } catch {
    // an unreadable session file, a profile with no cookies left, a full disk: no recovery
    if (!source) return { renewed };
  }
  const { label, profile } = profileLabel(source);
  return { renewed, signIn: `sign in to ${hostOf(url)} in ${label}`, profile };
}

export type WindowLogin =
  | { ok: true; cookies: StoredCookie[]; renewed: string[] }
  | { ok: false; cookies: StoredCookie[]; reason: string };

/**
 * The visible-window sign-in. It counts only when login cookies appear or change while the window is
 * open (guest names aside), since a profile that already held them proves nothing: they may be the
 * ones the site has signed out. Only then is the jar replaced; otherwise the stored session stays.
 */
export async function windowLogin(
  site: string,
  url: string,
  o: { loginCookies?: string[]; waitForEnter?: boolean } = {},
): Promise<WindowLogin> {
  const guest = await knownGuests(site, url, o.loginCookies);
  const { opened, closed } = await login({ url, profileDir: profileDir(), waitForEnter: o.waitForEnter });
  // the user had the site open: a challenge cleared there counts even with no sign-in
  clearCoolDown(site);
  const renewed = renewedSignIn(opened, closed, o.loginCookies, guest);
  if (renewed.length && loggedIn(closed, o.loginCookies, guest)) {
    withLock(sessionFile(site), () => {
      const s = loadSession(site);
      saveSession(site, { ...s, cookies: closed, source: "window", guestCookies: union(s.guestCookies, guest) });
    });
    return { ok: true, cookies: closed, renewed };
  }
  const held = cookieNames(signInCookies(opened, o.loginCookies, guest));
  const visitors = guest.filter((n) => closed.some((c) => c.name === n));
  const reason = held.length
    ? `no new sign-in: the window already held ${held.join(", ")} when it opened and none changed, which proves nothing (the site may have ended that sign-in)`
    : `no sign-in seen: no login cookie appeared while the window was open${visitors.length ? ` (${visitors.join(", ")} every visitor is given does not count)` : ""}`;
  return { ok: false, cookies: closed, reason: `${reason}; the stored session is unchanged` };
}

/** The `next` for a window sign-in that did not count. */
export const windowRetry = (site: string, how: string) =>
  `sign in completely in the window (2FA included), then close it: ${how}. If you did sign in and this repeats, ${site}'s login cookie is named like a visitor's: list its name in the spec's loginCookies`;

/** logout: clear the jar and this site's cookies in the profile. */
export async function logout(site: string): Promise<void> {
  safeName(site);
  // removed, not overwritten with an empty jar: a sealed file whose key is lost must still be resettable
  withLock(sessionFile(site), () => rmSync(sessionFile(site), { force: true }));
  if (browserAvailable()) {
    try {
      let domain = site.toLowerCase();
      try {
        const baseUrl = loadSite(site)?.site.baseUrl;
        if (baseUrl) domain = siteOf(new URL(baseUrl).hostname);
      } catch {
        // A corrupt spec must not prevent logging out a domain-named site.
      }
      await clearProfileCookies(domain, profileDir());
    } catch {
      /* no profile yet, or the browser open */
    }
  }
}

/** Cookie NAMES only, for printing — values are never logged. */
export const cookieNames = (cookies: StoredCookie[]): string[] => [...new Set(cookies.map((c) => c.name))].sort();

export { loggedIn };
