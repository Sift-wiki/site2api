/**
 * A read's kept `ok` answers, in `~/.api-anything/snapshots/<hash>.json`: a cache entry (what
 * `maxAgeMs` answers from) and, apart from it, each watcher's baseline (what `changes` compares
 * with). Kept only for a call that asked for one of them. The answer can hold the user's own data, so
 * each file is 0600, its name says nothing of the args or the session, and one unused for 30 days is removed.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "./changes.js";
import { asText } from "./codec.js";
import { filledValues, requestArgs } from "./http.js";
import { cookiesFor, home, mayCarryAccount, readJson, type Session, withLock, writePrivate } from "./session.js";
import type { Operation, Site } from "./spec.js";

export interface Snapshot {
  at: number;
  /** the effective op when it was kept (`opPrint`, or `recipeOf` for a baseline): another op answers differently */
  op: string;
  /** the tier that answered: a cache hit is served only to a caller whose maxTier allows it */
  tier?: 1 | 2 | 3;
  data: unknown;
  nextPage?: string | number;
  hasMore?: boolean;
}

export const KEEP_SNAPSHOT_MS = 30 * 24 * 60 * 60_000;
/** an answer larger than this is not kept */
export const SNAPSHOT_BYTES = 16 * 1024 * 1024;
/** the watcher a `changes` call without `watch` compares for */
export const DEFAULT_WATCH = "default";
const PRUNE_EVERY_MS = 60 * 60_000;
let prunedAt = 0;
/** When a kept answer was taken and how old it is: tests move it on rather than sleep. */
export const clock = { now: (): number => Date.now() };

const dir = () => join(home(), "snapshots");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/* ------------------------------------------------------------- identities */

const saltFile = () => join(home(), "snapshot-salt");
let ownSalt: string | undefined;
const salts = new Map<string, string>();

/** A random local secret, kept beside (never inside) the snapshots: a home that cannot keep one gets this process's own. */
function salt(): string {
  const file = saltFile();
  const known = salts.get(file);
  if (known) return known;
  try {
    const s = withLock(file, () => {
      const kept = readJson<{ salt?: unknown }>(saltFile(), {});
      if (typeof kept?.salt === "string" && /^[0-9a-f]{64}$/.test(kept.salt)) return kept.salt;
      const fresh = randomBytes(32).toString("hex");
      writePrivate(saltFile(), JSON.stringify({ salt: fresh }));
      return fresh;
    });
    salts.set(file, s);
    return s;
  } catch {
    ownSalt ??= randomBytes(32).toString("hex");
    return ownSalt;
  }
}

/**
 * Who the answer was for, without saying it: an HMAC under the local salt of the cookies the op's
 * request carries and the session values it fills, or `signed-out` when it carries none. A cookie
 * known to carry no account (`mayCarryAccount`: analytics, bot management, CSRF) is left out, since
 * several of them rotate on every answer and would make each call a new identity.
 */
export function sessionPrint(op: Operation, session: Session, loginCookies?: string[]): string {
  let cookies: [string, string][] = [];
  try {
    cookies = cookiesFor(session.cookies, op.request.url)
      .filter((c) => c.value && mayCarryAccount(c.name, loginCookies, session.guestCookies))
      .map((c): [string, string] => [c.name, c.value])
      .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1));
  } catch {
    cookies = session.cookies.map((c): [string, string] => [c.name, c.value]).sort();
  }
  const values = filledValues(op, session)
    .sort()
    .map((k) => [k, session.values[k]]);
  if (!cookies.length && !values.length) return "signed-out";
  return createHmac("sha256", salt())
    .update(JSON.stringify([cookies, values]))
    .digest("hex");
}

/** The args as the request takes them (`requestArgs`: defaults filled, coerced, checked), as text; throws for args no request can carry. */
export function argsText(op: Operation, args: Record<string, unknown>): [string, string][] {
  const vals = requestArgs(op, args);
  return Object.keys(vals)
    .sort()
    .map((k) => {
      const v = vals[k];
      return [k, v && typeof v === "object" ? canonical(v) : asText(v)];
    });
}

export interface Identity {
  site: string;
  op: Operation;
  args: Record<string, unknown>;
  /** `sessionPrint` */
  session: string;
}

/** The cache entry's file name: site, op, args and session, hashed; none of them is written in it. */
export const cacheKey = (id: Identity): string =>
  sha(JSON.stringify(["cache", id.site, id.op.name, argsText(id.op, id.args), id.session])).slice(0, 32);

/** A watcher's baseline: its own file, apart from the cache and from every other watcher's. */
export const watchKey = (id: Identity, watch: string): string =>
  sha(JSON.stringify(["watch", watch, id.site, id.op.name, argsText(id.op, id.args), id.session])).slice(0, 32);

/** What answers the op: its request, slots, params, recipe, tier and address. A cache entry of another op is no hit. */
export const opPrint = (site: Pick<Site, "baseUrl">, op: Operation): string =>
  sha(
    canonical({
      baseUrl: site.baseUrl,
      request: op.request,
      slots: op.slots,
      volatile: op.volatile,
      params: op.params,
      public: op.public,
      trigger: op.trigger,
      match: op.match,
      response: { ...op.response, shape: undefined },
      minTier: op.minTier,
      paging: op.paging,
    }) ?? "",
  ).slice(0, 32);

/** The op's response recipe: a baseline survives a heal of the request, not a changed answer's shape. */
export const recipeOf = (op: Operation): string =>
  sha(canonical({ ...op.response, shape: undefined }) ?? "").slice(0, 16);

/* ------------------------------------------------------------------ files */

const fileOf = (key: string) => join(dir(), `${key}.json`);

// Every snapshot goes to and from disk through these two: sealing private files at rest belongs here.
const put = (file: string, text: string) => writePrivate(file, text);
const get = (file: string) => readFileSync(file, "utf8");

/** The kept answer, if any; reading it counts as use for the 30 days. */
export function loadSnapshot(key: string, now = Date.now()): Snapshot | undefined {
  const file = fileOf(key);
  try {
    const s = JSON.parse(get(file)) as Snapshot;
    if (!s || typeof s !== "object" || typeof s.at !== "number" || typeof s.op !== "string") return undefined;
    try {
      utimesSync(file, new Date(now), new Date(now));
    } catch {
      /* a read-only home still answers */
    }
    return s;
  } catch {
    return undefined;
  }
}

export type Saved = { kept: true } | { kept: false; reason: string };

/** Keep `s` in place of the last; when it could not be, why (too large, or a home that cannot be written). */
export function saveSnapshot(key: string, s: Snapshot, now = Date.now()): Saved {
  try {
    const text = JSON.stringify(s);
    const file = fileOf(key);
    const bytes = Buffer.byteLength(text);
    if (bytes > SNAPSHOT_BYTES) {
      rmSync(file, { force: true });
      return { kept: false, reason: `the answer is ${bytes} bytes, over the ${SNAPSHOT_BYTES} kept` };
    }
    put(file, text);
    if (now - prunedAt > PRUNE_EVERY_MS) prune(now);
    return { kept: true };
  } catch (e) {
    return { kept: false, reason: `it could not be written (${(e as Error).message.split("\n")[0]})` };
  }
}

/**
 * Read the last answer and keep the next one under the file's lock, so concurrent calls compare in
 * turn. `saved`: whether `next` was kept (undefined when there was none to keep).
 */
export function swapSnapshot<T>(
  key: string,
  fn: (prev: Snapshot | undefined) => { next?: Snapshot; out: T },
): { out: T; saved?: Saved } {
  const run = () => {
    const r = fn(loadSnapshot(key));
    return { out: r.out, ...(r.next ? { saved: saveSnapshot(key, r.next) } : {}) };
  };
  try {
    return withLock(fileOf(key), run);
  } catch {
    return run();
  }
}

/** Remove what nobody read or wrote for 30 days: old answers, and the temp and lock files of a crashed process. */
export function prune(now = Date.now()): void {
  prunedAt = now;
  let names: string[];
  try {
    names = readdirSync(dir());
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir(), name);
    try {
      if (now - statSync(file).mtimeMs > KEEP_SNAPSHOT_MS) rmSync(file, { force: true });
    } catch {
      /* removed meanwhile */
    }
  }
}
