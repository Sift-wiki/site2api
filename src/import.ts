/**
 * Import a site's cookies from the user's everyday browser, so `login` needs no password:
 * they are almost always already signed in there (2FA/captcha done by the human).
 *
 * Chromium family: cookie DB names are plaintext (so the right profile is chosen with no
 * decryption and no Keychain prompt); values are AES-128-CBC under a key derived from the
 * browser's Safe Storage password. Firefox: plaintext moz_cookies. Only the chosen profile is
 * decrypted, so at most one macOS Keychain dialog appears.
 *
 * node:sqlite is used over the sqlite3 CLI: it is built in (no extra dependency, present on every
 * Node >= 22.5), and it returns the encrypted BLOB as a Buffer directly, where the CLI would need
 * hex() plus escaping of binary output.
 */
import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AUTH_COOKIE, siteOf } from "./session.js";
import { openReadOnly } from "./sqlite.js";
import type { StoredCookie } from "./types.js";

/** One installed browser to scan. Tests inject these via API_ANYTHING_BROWSER_ROOTS. */
export interface BrowserRoot {
  /** display name, also the Keychain service prefix: "<name> Safe Storage" */
  name: string;
  family: "chromium" | "firefox";
  /** user-data dir (chromium) or profiles dir (firefox) */
  root: string;
  /** overrides the OS key lookup (test injection; also Linux "peanuts") */
  password?: string;
  /** PBKDF2 iterations (chromium): macOS 1003, Linux v10 1 */
  iterations?: number;
}

export interface ImportedSession {
  cookies: StoredCookie[];
  /** "<browser-lower>:<profile>", e.g. "chrome:Profile 1"; recorded so a heal re-imports the same one */
  source: string;
  browser: string;
  profile: string;
  /** the profile's display name and Google account, from Chrome's Local State, so a human can tell whose it is */
  name?: string;
  email?: string;
}

/** One browser profile a human can pick with --profile. */
export interface ProfileChoice {
  /** the --profile value: "Chrome/Profile 1" */
  profile: string;
  name?: string;
  email?: string;
}

/** Several profiles hold the site's login: importing one would be a guess between accounts. */
export class AmbiguousProfile extends Error {
  constructor(
    readonly site: string,
    readonly candidates: ProfileChoice[],
  ) {
    super(
      `${candidates.length} browser profiles are signed in to ${site}; pick one: ${candidates.map((c) => `"${c.profile}"${c.name || c.email ? ` (${[c.name, c.email].filter(Boolean).join(", ")})` : ""}`).join(", ")}`,
    );
    this.name = "AmbiguousProfile";
  }
}

const CHROMIUM_MAC: [string, string][] = [
  ["Chrome", "Google/Chrome"],
  ["Chrome Beta", "Google/Chrome Beta"],
  ["Brave", "BraveSoftware/Brave-Browser"],
  ["Edge", "Microsoft Edge"],
  ["Arc", "Arc/User Data"],
  ["Chromium", "Chromium"],
  ["Vivaldi", "Vivaldi"],
];
// The Keychain service is "<x> Safe Storage" where x differs from the display name for a few.
const SAFE_STORAGE: Record<string, string> = {
  Brave: "Brave",
  Edge: "Microsoft Edge",
  Arc: "Arc",
  Chromium: "Chromium",
  Vivaldi: "Vivaldi",
};

/** Installed browsers on this OS, or the injected set for tests. */
export function browserRoots(): BrowserRoot[] {
  const injected = process.env.API_ANYTHING_BROWSER_ROOTS;
  if (injected) return JSON.parse(injected) as BrowserRoot[];
  const out: BrowserRoot[] = [];
  const home = process.env.HOME || "";
  if (process.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    for (const [name, rel] of CHROMIUM_MAC) {
      const root = join(support, rel);
      if (existsSync(root)) out.push({ name, family: "chromium", root });
    }
    const ff = join(support, "Firefox", "Profiles");
    if (existsSync(ff)) out.push({ name: "Firefox", family: "firefox", root: ff });
  } else if (process.platform === "linux") {
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    for (const [name, rel] of [
      ["Chrome", "google-chrome"],
      ["Chromium", "chromium"],
      ["Brave", "BraveSoftware/Brave-Browser"],
      ["Edge", "microsoft-edge"],
    ] as const) {
      const root = join(config, rel);
      // Linux v10 is AES under a fixed password; v11 (secret-tool) is not attempted here.
      if (existsSync(root)) out.push({ name, family: "chromium", root, password: "peanuts", iterations: 1 });
    }
    const ff = join(home, ".mozilla", "firefox");
    if (existsSync(ff)) out.push({ name: "Firefox", family: "firefox", root: ff });
  }
  // Windows chromium uses app-bound encryption (DPAPI + more): not supported; login falls back to --window.
  return out;
}

/** The `security` Keychain lookup for a browser's Safe Storage password (may show a macOS dialog). */
function keychainPassword(name: string): string {
  const service = `${SAFE_STORAGE[name] ?? name} Safe Storage`;
  try {
    return execFileSync("security", ["find-generic-password", "-w", "-s", service], { encoding: "utf8" }).trim();
  } catch (e) {
    throw new Error(
      `could not read the "${service}" password from the macOS Keychain (${(e as Error).message.split("\n")[0]})`,
    );
  }
}

/** Copy a locked DB (plus -wal/-journal) to a temp dir and open it read-only. */
function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "aa-cookies-"));
  try {
    const copy = join(dir, basename(dbPath));
    copyFileSync(dbPath, copy);
    for (const ext of ["-wal", "-journal", "-shm"])
      if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, copy + ext);
    const db = openReadOnly(copy);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A chromium profile's cookie DB is <profile>/Network/Cookies (modern) or <profile>/Cookies. */
function chromiumCookieDb(profileDir: string): string | undefined {
  for (const p of [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")]) if (existsSync(p)) return p;
  return undefined;
}

interface Candidate {
  browser: string;
  profile: string;
  family: "chromium" | "firefox";
  root: BrowserRoot;
  dbPath: string;
  /** cookie names present for the site (plaintext, no decryption) */
  names: Set<string>;
}

/** Every profile of every browser that holds at least one cookie for the site's registrable domain. */
function candidatesFor(site: string, pin?: ImportPin): Candidate[] {
  const out: Candidate[] = [];
  for (const root of browserRoots()) {
    if (pin?.browser && root.name.toLowerCase() !== pin.browser.toLowerCase()) continue;
    if (root.family === "firefox") {
      for (const entry of safeReaddir(root.root)) {
        if (pin && entry !== pin.profile) continue;
        const db = join(root.root, entry, "cookies.sqlite");
        if (!existsSync(db)) continue;
        const names = firefoxNames(db, site);
        if (names.size) out.push({ browser: root.name, profile: entry, family: "firefox", root, dbPath: db, names });
      }
      continue;
    }
    for (const entry of safeReaddir(root.root)) {
      if (pin && entry !== pin.profile) continue;
      const profileDir = join(root.root, entry);
      const db = chromiumCookieDb(profileDir);
      if (!db) continue;
      const names = chromiumNames(db, site);
      if (names.size) out.push({ browser: root.name, profile: entry, family: "chromium", root, dbPath: db, names });
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** true when a cookie's host_key/host belongs to the site's registrable domain. */
export const belongs = (host: string, site: string) => {
  const h = host.replace(/^\./, "").toLowerCase();
  return h === site || h.endsWith(`.${site}`) || siteOf(h) === site;
};

function chromiumNames(dbPath: string, site: string): Set<string> {
  return withDb(dbPath, (db) => {
    const rows = db.prepare("SELECT host_key, name FROM cookies").all() as { host_key: string; name: string }[];
    return new Set(rows.filter((r) => belongs(r.host_key, site)).map((r) => r.name));
  });
}

function firefoxNames(dbPath: string, site: string): Set<string> {
  return withDb(dbPath, (db) => {
    const rows = db.prepare("SELECT host, name FROM moz_cookies").all() as { host: string; name: string }[];
    return new Set(rows.filter((r) => belongs(r.host, site)).map((r) => r.name));
  });
}

const CHROME_EPOCH_OFFSET = 11644473600; // seconds between 1601-01-01 and 1970-01-01
const SAMESITE: Record<number, StoredCookie["sameSite"]> = { 0: "None", 1: "Lax", 2: "Strict" };

function deriveKey(password: string, iterations: number): Buffer {
  return pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
}

/** Decrypt one chromium encrypted_value; meta.version >= 24 prefixes 32 bytes (SHA-256 of host_key). */
function decryptChromium(raw: Uint8Array, key: Buffer, metaVersion: number): string | undefined {
  if (!raw || raw.length === 0) return "";
  const blob = Buffer.from(raw); // node:sqlite hands back a Uint8Array, whose toString ignores encodings
  const prefix = blob.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") return blob.toString("utf8"); // unencrypted (older Linux)
  try {
    const iv = Buffer.alloc(16, 0x20); // 16 spaces
    const d = createDecipheriv("aes-128-cbc", key, iv);
    let out = Buffer.concat([d.update(blob.subarray(3)), d.final()]);
    if (metaVersion >= 24) out = out.subarray(32);
    return out.toString("utf8");
  } catch {
    return undefined; // wrong key: skip this cookie rather than fail the whole import
  }
}

function readChromium(root: BrowserRoot, dbPath: string, site: string): StoredCookie[] {
  const iterations = root.iterations ?? (process.platform === "linux" ? 1 : 1003);
  const password = root.password ?? keychainPassword(root.name);
  const key = deriveKey(password, iterations);
  return withDb(dbPath, (db) => {
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
      | { value: string | number }
      | undefined;
    const metaVersion = metaRow ? Number(metaRow.value) : 0;
    const stmt = db.prepare(
      "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies",
    );
    // expires_utc (microseconds since 1601) overflows a JS number; read every integer as BigInt.
    stmt.setReadBigInts(true);
    const rows = stmt.all() as unknown as {
      host_key: string;
      name: string;
      value: string;
      encrypted_value: Uint8Array;
      path: string;
      expires_utc: bigint;
      is_secure: bigint;
      is_httponly: bigint;
      samesite: bigint;
    }[];
    const out: StoredCookie[] = [];
    for (const r of rows) {
      if (!belongs(r.host_key, site)) continue;
      const value = r.value || decryptChromium(r.encrypted_value, key, metaVersion);
      if (value === undefined || value === "") continue;
      out.push({
        name: r.name,
        value,
        domain: r.host_key,
        path: r.path || "/",
        expires: r.expires_utc > 0n ? Math.floor(Number(r.expires_utc) / 1_000_000 - CHROME_EPOCH_OFFSET) : -1,
        httpOnly: !!Number(r.is_httponly),
        secure: !!Number(r.is_secure),
        sameSite: SAMESITE[Number(r.samesite)],
      });
    }
    return out;
  });
}

function readFirefox(dbPath: string, site: string): StoredCookie[] {
  return withDb(dbPath, (db) => {
    const rows = db
      .prepare("SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies")
      .all() as {
      host: string;
      name: string;
      value: string;
      path: string;
      expiry: number;
      isSecure: number;
      isHttpOnly: number;
      sameSite: number;
    }[];
    return rows
      .filter((r) => belongs(r.host, site))
      .map((r) => ({
        name: r.name,
        value: r.value,
        domain: r.host,
        path: r.path || "/",
        expires: r.expiry || -1, // Firefox expiry is unix seconds
        httpOnly: !!r.isHttpOnly,
        secure: !!r.isSecure,
        sameSite: SAMESITE[r.sameSite],
      }));
  });
}

export interface ImportPin {
  browser?: string;
  profile: string;
}

/** Parse `--profile "Chrome/Profile 1"` or a session source "chrome:Profile 1" into a pin. */
export function parsePin(text: string): ImportPin {
  const sep = text.includes("/") ? "/" : ":";
  const i = text.indexOf(sep);
  if (i === -1) return { profile: text };
  return { browser: text.slice(0, i), profile: text.slice(i + 1) };
}

/** A chromium profile's display name and signed-in Google account, from the browser's "Local State". */
function profileInfo(c: Pick<Candidate, "family" | "root" | "profile">): { name?: string; email?: string } {
  if (c.family !== "chromium") return {};
  try {
    const state = JSON.parse(readFileSync(join(c.root.root, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: string; user_name?: string }> };
    };
    const info = state.profile?.info_cache?.[c.profile];
    return { ...(info?.name ? { name: info.name } : {}), ...(info?.user_name ? { email: info.user_name } : {}) };
  } catch {
    return {};
  }
}

/**
 * A session source ("chrome:Profile 1") as a human knows it, `Chrome profile "Work" (me@example.com)`,
 * and as `--profile` takes it, "Chrome/Profile 1".
 */
export function profileLabel(source: string): { label: string; profile: string } {
  const pin = parsePin(source);
  let root: BrowserRoot | undefined;
  try {
    root = browserRoots().find((r) => r.name.toLowerCase() === pin.browser?.toLowerCase());
  } catch {
    // a malformed API_ANYTHING_BROWSER_ROOTS: the bare source still names the profile
  }
  const info = root ? profileInfo({ family: root.family, root, profile: pin.profile }) : {};
  const browser = root?.name ?? pin.browser ?? "the browser";
  return {
    label: `${browser} profile "${info.name ?? pin.profile}"${info.email ? ` (${info.email})` : ""}`,
    profile: `${browser}/${pin.profile}`,
  };
}

/**
 * Import the site's cookies from the everyday browser: the one profile that holds the site's
 * `loginCookies` (for an unknown site, auth-looking cookies no signed-out visitor is also given, else
 * any cookies for it), or the `pin`ned one. Never a guess: when several profiles qualify (two people's
 * accounts), it throws AmbiguousProfile with their display names and emails. Undefined when nothing
 * is importable (the caller falls back to the window flow).
 */
export function importFromBrowsers(o: {
  url: string;
  loginCookies?: string[];
  pin?: ImportPin;
  /** the names a signed-out visit is given (`Session.guestCookies`): a profile holding only these is not signed in */
  guest?: string[];
}): ImportedSession | undefined {
  const site = siteOf(new URL(o.url).hostname.toLowerCase());
  const candidates = candidatesFor(site, o.pin);
  if (o.pin && !candidates.length)
    throw new Error(
      `no browser profile "${o.pin.browser ? `${o.pin.browser}/` : ""}${o.pin.profile}" has cookies for ${site}`,
    );
  const signedIn = candidates.filter((c) =>
    o.loginCookies?.length
      ? o.loginCookies.every((n) => c.names.has(n))
      : [...c.names].some((n) => AUTH_COOKIE.test(n) && !o.guest?.includes(n)),
  );
  const pool = signedIn.length ? signedIn : candidates;
  if (pool.length > 1)
    throw new AmbiguousProfile(
      site,
      pool.map((c) => ({ profile: `${c.browser}/${c.profile}`, ...profileInfo(c) })),
    );
  const chosen = pool[0];
  if (!chosen) return undefined;
  const cookies =
    chosen.family === "chromium" ? readChromium(chosen.root, chosen.dbPath, site) : readFirefox(chosen.dbPath, site);
  if (!cookies.length) return undefined;
  return {
    cookies,
    source: `${chosen.browser.toLowerCase()}:${chosen.profile}`,
    browser: chosen.browser,
    profile: chosen.profile,
    ...profileInfo(chosen),
  };
}

/* --------------------------------------------------------------- file import */

/** Parse a cookies.txt (Netscape) or JSON array (Cookie-Editor / Playwright shape) export. */
export function cookiesFromFile(text: string, url: string): StoredCookie[] {
  const trimmed = text.trim();
  const host = new URL(url).hostname;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : (parsed.cookies ?? []);
    return (arr as Record<string, unknown>[]).map((c) => normalizeJson(c, host));
  }
  // Netscape columns: domain, includeSubdomains, path, secure, expiry, name, value.
  // A leading "#HttpOnly_" on the domain marks an http-only cookie (curl/yt-dlp convention).
  return trimmed
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l && (!l.startsWith("#") || l.startsWith("#HttpOnly_")))
    .map((l) => l.split("\t"))
    .filter((f) => f.length >= 7)
    .map((f) => ({
      name: f[5]!,
      value: f[6]!,
      domain: f[0]!.replace(/^#HttpOnly_/, ""),
      path: f[2] || "/",
      expires: Number(f[4]) || -1,
      httpOnly: f[0]!.startsWith("#HttpOnly_"),
      secure: f[3]?.toUpperCase() === "TRUE",
    }));
}

function normalizeJson(c: Record<string, unknown>, host: string): StoredCookie {
  const exp = (c.expires ?? c.expirationDate) as number | undefined;
  return {
    name: String(c.name),
    value: String(c.value),
    domain: String(c.domain ?? host),
    path: String(c.path ?? "/"),
    expires: typeof exp === "number" ? Math.floor(exp) : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: (c.sameSite as StoredCookie["sameSite"]) || undefined,
  };
}
