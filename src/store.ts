/**
 * Site specs (user dir, then pulled, then bundled), heal log, stale marks, remembered tiers, cool-downs,
 * the per-site send slots, the write ledger, and the call log.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickedShape } from "./classify.js";
import { type Leaf, setAt, walk } from "./codec.js";
import {
  besideOrigins,
  credentialsOf,
  ipIn,
  leafName,
  literalCredentials,
  opUrls,
  redact,
  scanSecrets,
  signInFills,
} from "./secrets.js";
import { ensureDir, home, loadSession, readJson, safeName, withLock, writePrivate } from "./session.js";
import { type Operation, parseSite, type Site } from "./spec.js";
import { vetShared } from "./vet.js";

let bundledOverride: string | undefined;
/** Resolve lazily: a compiled host supplies its extracted specs before the first load. */
export const bundledDir = () => bundledOverride ?? fileURLToPath(new URL("../sites", import.meta.url));
/** Override the bundled directory for every default spec and notes lookup in this process. */
export function setBundledDir(dir: string): void {
  bundledOverride = dir;
}
export const userSitesDir = () => join(home(), "sites");
/** Specs `pull` fetched from the registry: someone else's, so checked again on every load. */
export const registryDir = () => join(home(), "registry");

export interface Resolved {
  site: Site;
  source: "user" | "registry" | "bundled";
  path: string;
}

const specDirs = (bundled: string) =>
  [
    [userSitesDir(), "user"],
    [registryDir(), "registry"],
    [bundled, "bundled"],
  ] as const;

export function loadSite(name: string, directory = bundledDir()): Resolved | undefined {
  name = safeName(name);
  const file = `${name}.json`;
  for (const [dir, source] of specDirs(directory)) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      // The file name is the site's address; saving under a different inner name would overwrite another site.
      const site = { ...parseSite(JSON.parse(readFileSync(path, "utf8"))), name };
      // someone else's spec, pulled or a heal's copy of one, meets the rules of today, not of its pull
      // pull writes the record with every spec, so one without it is no spec pull wrote
      if (source === "registry" && !site.shared) throw new Error("a pulled spec without its record; pull it again");
      if (source === "registry" || site.shared) {
        const { errors } = vetShared(site, notesAt(join(dir, `${name}.md`)));
        if (errors.length) throw new Error(`a pulled spec that fails the shared rules: ${errors.join("; ")}`);
      }
      return { site, source, path };
    } catch (e) {
      throw new Error(`${path}: ${(e as Error).message}`);
    }
  }
  return undefined;
}

/**
 * A site's notes for whoever calls it (caveats, arg formats, login advice): `<site>.md` beside its spec, the
 * user's copy first. Every caller pays for them in tokens, so a `## Maintainer notes` heading ends them:
 * from there on the file is for people working on the spec.
 */
export function siteNotes(
  name: string,
  o: { bundledDir?: string; from?: Resolved["source"] } = {},
): string | undefined {
  for (const [dir, source] of specDirs(o.bundledDir ?? bundledDir())) {
    if (o.from && source !== o.from) continue;
    const text = notesAt(join(dir, `${safeName(name)}.md`));
    if (text === undefined) continue;
    const [forCallers] = text.split(/^## Maintainer notes\s*$/im);
    return forCallers!.trim();
  }
  return undefined;
}

const notesAt = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

export function listSites(directory = bundledDir()): string[] {
  const names = new Set<string>();
  for (const [dir] of specDirs(directory)) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".json")) names.add(f.slice(0, -5));
  }
  return [...names].sort();
}

/** Writes the user copy; a healed bundled spec becomes a user spec this way. */
export function saveSite(site: Site): string {
  const path = join(userSitesDir(), `${safeName(site.name)}.json`);
  writePrivate(path, `${JSON.stringify(parseSite(site), null, 2)}\n`);
  return path;
}

/**
 * Read-modify-write one site's user spec under its lock, so concurrent adds and heals (other
 * processes, or other calls in this one) never drop each other's operations. fn gets the current
 * spec (user copy, else bundled), undefined for a new site.
 */
export function updateSite(name: string, fn: (site: Site | undefined) => Site): string {
  return withLock(join(userSitesDir(), `${safeName(name)}.json`), () => saveSite(fn(loadSite(name)?.site)));
}

/* ------------------------------------------------------------------ state */

export interface StaleMark {
  until: number;
  reason: string;
  /** false when the site's own frontend did not answer either, so a tier-3 read is pointless */
  tier3?: boolean;
}

/** A site that said stop: calls to it are answered without sending until `until`. */
export interface CoolDown {
  class: "rate" | "blocked";
  at: number;
  until: number;
  reason: string;
  /** the answer's HTTP status (451: refused to this network or region) */
  status?: number;
}

interface State {
  stale: Record<string, StaleMark>;
  tier: Record<string, 1 | 2 | 3>;
  healedAt: Record<string, number>;
  cool: Record<string, CoolDown>;
}

const stateFile = () => join(home(), "state.json");
const key = (site: string, op: string) => `${site}/${op}`;

function loadState(): State {
  let s: Partial<State>;
  try {
    s = readJson<Partial<State>>(stateFile(), {}) ?? {};
  } catch {
    // tier memory and stale marks are hints: a corrupt file is started over, never a failed call
    s = {};
  }
  return { stale: s.stale ?? {}, tier: s.tier ?? {}, healedAt: s.healedAt ?? {}, cool: s.cool ?? {} };
}

function updateState(fn: (s: State) => void): void {
  try {
    withLock(stateFile(), () => {
      const s = loadState();
      fn(s);
      writePrivate(stateFile(), JSON.stringify(s, null, 1));
    });
  } catch {
    // ponytail: a read-only home loses tier memory and stale marks (hints), never the call's answer
  }
}

export interface HealEntry {
  site: string;
  op: string;
  /** `revert`: `api-anything revert` took back the last heal not taken back yet */
  strategy: "rescan" | "recapture" | "revert";
  /** short human summary of what changed */
  diff: string;
  /** what changed in the template, one line each, with `{param}` and refs in place of values */
  changes?: string[];
  /** the op as it was before: what a revert puts back. It holds refs, never a credential; redacted anyway */
  previous?: Operation;
  /** templateHash of the op saved, so a revert never undoes a later re-learn or edit */
  saved?: string;
}
export type HealRecord = HealEntry & { at: string };

/** The template's identity: its request, slots and volatile ids. */
export const templateHash = (op: Operation) =>
  createHash("sha256")
    .update(JSON.stringify([op.request, op.slots, op.volatile]))
    .digest("hex")
    .slice(0, 16);

/** `text` without the site's live session values: what is kept on disk is read by agents too. */
function hidden(site: string, text: string): string {
  try {
    return redact(text, loadSession(site));
  } catch {
    return text; // an unreadable session file: no live value to look for
  }
}

/** Every string in `v` without the site's live session values. */
const hiddenAll = (site: string, v: unknown): unknown =>
  typeof v === "string"
    ? hidden(site, v)
    : Array.isArray(v)
      ? v.map((x) => hiddenAll(site, x))
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hiddenAll(site, x)]))
        : v;

const healsFile = () => join(home(), "heals.jsonl");

/** Append to heals.jsonl and remember when the op was last healed (for the heal-loop guard; a revert is no heal). */
export function appendHeal(entry: HealEntry, now = Date.now()): void {
  ensureDir(home());
  const file = healsFile();
  const line = { at: new Date(now).toISOString(), ...(hiddenAll(entry.site, entry) as HealEntry) };
  appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  if (entry.strategy !== "revert")
    updateState((s) => {
      s.healedAt[key(entry.site, entry.op)] = now;
    });
}

/** heals.jsonl, oldest first, one site's or all; a line that does not parse is skipped. */
export function loadHeals(site?: string): HealRecord[] {
  if (!existsSync(healsFile())) return [];
  return readFileSync(healsFile(), "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        const h = JSON.parse(l) as HealRecord;
        return h && typeof h === "object" && (!site || h.site === site) ? [h] : [];
      } catch {
        return [];
      }
    });
}

export function lastHealAt(site: string, op: string): number | undefined {
  return loadState().healedAt[key(site, op)];
}

export function markStale(
  site: string,
  op: string,
  reason: string,
  ttlMs = 30 * 60_000,
  now = Date.now(),
  extra: { tier3?: boolean } = {},
): void {
  const why = hidden(site, reason);
  updateState((s) => {
    s.stale[key(site, op)] = { until: now + ttlMs, reason: why, ...extra };
  });
}

export function clearStale(site: string, op: string): void {
  updateState((s) => void delete s.stale[key(site, op)]);
}

/** Current stale mark for an op, if it has not expired. */
export function staleMark(site: string, op: string, now = Date.now()): StaleMark | undefined {
  const m = loadState().stale[key(site, op)];
  return m && m.until > now ? m : undefined;
}

const unkey = (k: string) => {
  const i = k.indexOf("/");
  return { site: k.slice(0, i), op: k.slice(i + 1) };
};

export function staleList(now = Date.now()): { site: string; op: string; until: number; reason: string }[] {
  return Object.entries(loadState().stale)
    .filter(([, m]) => m.until > now)
    .map(([k, m]) => ({ ...unkey(k), ...m }));
}

/** Every remembered escalation. */
export function tierList(): { site: string; op: string; tier: 1 | 2 | 3 }[] {
  return Object.entries(loadState().tier).map(([k, tier]) => ({ ...unkey(k), tier }));
}

/** Every cool-down that has not run out. */
export function coolList(now = Date.now()): (CoolDown & { site: string })[] {
  return Object.entries(loadState().cool)
    .filter(([, c]) => c.until > now)
    .map(([site, c]) => ({ site, ...c }));
}

/** The tier an op escalated to; undefined forgets it (the op's own minTier applies again). */
export function rememberTier(site: string, op: string, tier: 1 | 2 | 3 | undefined): void {
  updateState((s) => {
    if (tier === undefined) delete s.tier[key(site, op)];
    else s.tier[key(site, op)] = tier;
  });
}

export function rememberedTier(site: string, op: string): 1 | 2 | 3 | undefined {
  return loadState().tier[key(site, op)];
}

/** A rate limit's wait when the site names none, and the longest one kept whatever it names. */
export const RATE_COOL_MS = 3 * 60_000;
export const MAX_COOL_MS = 30 * 60_000;
/** A block on every tier a call could use: each further call would only meet the wall again. */
export const BLOCKED_COOL_MS = 10 * 60_000;

export function coolDown(
  site: string,
  c: Pick<CoolDown, "class" | "reason" | "status">,
  ms: number,
  now = Date.now(),
): void {
  const reason = hidden(site, c.reason);
  updateState((s) => {
    s.cool[safeName(site)] = { ...c, reason, at: now, until: now + Math.min(ms, MAX_COOL_MS) };
  });
}

/** The site's cool-down, if it has not run out. */
export function cooling(site: string, now = Date.now()): CoolDown | undefined {
  const c = loadState().cool[safeName(site)];
  return c && c.until > now ? c : undefined;
}

/** A login ends a site's cool-down: the user has seen the site, and what it answers may have changed. */
export function clearCoolDown(site: string): void {
  if (loadState().cool[safeName(site)]) updateState((s) => void delete s.cool[safeName(site)]);
}

/* ----------------------------------------------------------------- pacing */

const paceFile = () => join(home(), "pace.json");
const ownSlots = new Map<string, number>();
/** A gap between two sends is the interval ± this share of it: an exact period is a robot's. */
export const PACE_JITTER = 0.3;

/**
 * Reserve the next moment a request may go to `site`, and move the site's slot on by the interval
 * ±`PACE_JITTER`. The slots are kept in pace.json under its lock, so separate processes (a CLI loop,
 * agents in parallel) queue up too; a home that cannot be written paces this process only.
 */
export function reserveSend(site: string, intervalMs: number, now = Date.now()): number {
  const gap = Math.round(intervalMs * (1 - PACE_JITTER + Math.random() * 2 * PACE_JITTER));
  try {
    return withLock(paceFile(), () => {
      let slots: Record<string, unknown>;
      try {
        slots = readJson<Record<string, unknown>>(paceFile(), {});
      } catch {
        slots = {};
      }
      if (!slots || typeof slots !== "object" || Array.isArray(slots)) slots = {};
      // a slot in the past holds nothing back
      for (const [k, t] of Object.entries(slots)) if (!(typeof t === "number" && t > now)) delete slots[k];
      const at = Math.max(now, (slots[site] as number | undefined) ?? 0);
      slots[site] = at + gap;
      writePrivate(paceFile(), JSON.stringify(slots));
      return at;
    });
  } catch {
    const at = Math.max(now, ownSlots.get(site) ?? 0);
    ownSlots.set(site, at + gap);
    return at;
  }
}

/* ------------------------------------------------------------ write ledger */

/** What a write did, as far as the caller can know; see CallResult.write. */
export type WriteStatus = "not_sent" | "not_applied" | "accepted" | "may_have_applied" | "applied";

/** One write call, kept in writes.json. Never the args or a credential: an HMAC digest of the args. */
export interface WriteRecord {
  id: string;
  site: string;
  op: string;
  /** HMAC-SHA256 of [site, op, args] under this machine's random key */
  digest: string;
  /** HMAC of the caller's idempotency key, when it gave one */
  key?: string;
  at: number;
  /** "sending" until the call settles it; a process that died mid-send leaves it so, and it counts as may_have_applied */
  status: WriteStatus | "sending";
  ok?: boolean;
  class?: string;
}

/**
 * A repeat of a write that may have gone through is refused for this long. Long enough for an agent
 * that re-sends after an unclear answer (seconds to minutes later, often after a login or a heal) and
 * for the user to look at the site; short enough that the same comment or order placed again later
 * on purpose goes through without the override.
 */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;
// An idempotency key is answered from its record this long; older records are dropped.
const KEEP_WRITES_MS = 24 * 60 * 60_000;

const writesFile = () => join(home(), "writes.json");
const unsettled = (r: WriteRecord) =>
  r.status === "accepted" || r.status === "applied" || r.status === "may_have_applied" || r.status === "sending";

/** This machine's HMAC key, made on first use: a digest of short args (a comment, a vote) cannot be guessed back without it. */
function ledgerKey(): Buffer {
  const file = join(home(), "write.key");
  if (!existsSync(file)) {
    ensureDir(home());
    // written whole, then linked into place: a concurrent first use reads one key or the other, never half of one
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, randomBytes(32).toString("hex"), { mode: 0o600 });
    try {
      linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
}

/** The same value whatever the order of its object keys. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;

const hmac = (key: Buffer, value: unknown) =>
  createHmac("sha256", key).update(JSON.stringify(value)).digest("hex").slice(0, 32);

export type WriteGate =
  /** `seed`: the call's gen slots are drawn from it: the key's HMAC, else the record's id */
  | { send: true; id: string; seed: string }
  /** an unsettled write with the same args within the window */
  | { send: false; why: "duplicate"; earlier: WriteRecord }
  /** the idempotency key's write may have gone through: its record answers */
  | { send: false; why: "replay"; earlier: WriteRecord }
  /** the idempotency key was used for other args */
  | { send: false; why: "key_reused"; earlier: WriteRecord };

/**
 * Record a write before it is sent, under the ledger's lock so two processes cannot both pass, or
 * say why it must not be sent. `again` skips both checks (the user saw the site and wants it sent).
 * With an idempotency key the key decides, not the args' digest: the caller says which calls are one.
 * A key with no live record of its own still meets a keyless call with the same args: an agent that
 * adds a key only to its retry of an unclear answer is repeating that call.
 * Throws when the record cannot be written (a read-only home).
 */
export function beginWrite(
  site: string,
  op: string,
  args: Record<string, unknown>,
  o: { again?: boolean; idempotencyKey?: string } = {},
  now = Date.now(),
): WriteGate {
  const secret = ledgerKey();
  const digest = hmac(secret, [site, op, canonical(args)]);
  const key = o.idempotencyKey !== undefined ? hmac(secret, ["key", site, op, o.idempotencyKey]) : undefined;
  return withLock(writesFile(), () => {
    let all: WriteRecord[];
    try {
      all = readJson<WriteRecord[]>(writesFile(), []);
      if (!Array.isArray(all)) all = [];
    } catch {
      all = []; // a corrupt ledger is started over, like state.json, rather than refusing every write
    }
    all = all.filter((r) => now - r.at < KEEP_WRITES_MS);
    const mine = all.filter((r) => r.site === site && r.op === op);
    if (!o.again) {
      if (key) {
        const used = mine.findLast((r) => r.key === key);
        if (used && used.digest !== digest) return { send: false, why: "key_reused", earlier: used };
        if (used && unsettled(used)) return { send: false, why: "replay", earlier: used };
      }
      // with a key, only keyless calls: another key is another write, as the caller said
      const earlier = mine.findLast(
        (r) => (!key || !r.key) && r.digest === digest && now - r.at < DUPLICATE_WINDOW_MS && unsettled(r),
      );
      if (earlier) return { send: false, why: "duplicate", earlier };
    }
    const id = randomBytes(8).toString("hex");
    all.push({ id, site, op, digest, ...(key ? { key } : {}), at: now, status: "sending" });
    writePrivate(writesFile(), JSON.stringify(all, null, 1));
    return { send: true, id, seed: key ?? id };
  });
}

/** What the write did, once its call returns. */
export function settleWrite(id: string, status: WriteStatus, outcome: { ok: boolean; class: string }): void {
  try {
    withLock(writesFile(), () => {
      const all = readJson<WriteRecord[]>(writesFile(), []);
      const r = all.find((x) => x.id === id);
      if (!r) return;
      Object.assign(r, { status, ok: outcome.ok, class: outcome.class });
      writePrivate(writesFile(), JSON.stringify(all, null, 1));
    });
  } catch {
    // ponytail: the record stays "sending", which a repeat treats as may_have_applied: the safe side
  }
}

/** The ledger's records, oldest first: of a site (and op) when named, since `since`; a corrupt ledger reads as empty. */
export function loadWrites(o: { site?: string; op?: string; since?: number } = {}): WriteRecord[] {
  let all: WriteRecord[];
  try {
    all = readJson<WriteRecord[]>(writesFile(), []);
  } catch {
    return [];
  }
  if (!Array.isArray(all)) return [];
  return all.filter(
    (r) =>
      (o.site === undefined || r.site === o.site) &&
      (o.op === undefined || r.op === o.op) &&
      (o.since === undefined || r.at >= o.since),
  );
}

/* --------------------------------------------------------------- call log */

/**
 * One finished call, in calls.jsonl, for `status` and `stats`. Names, enums and numbers only: no args, data,
 * reason or next, so nothing a site answered and nothing the caller typed is kept.
 */
export interface CallEntry {
  site: string;
  op: string;
  class: string;
  /** absent when nothing was sent (a cool-down's answer, refused input) */
  tier?: 1 | 2 | 3;
  ms: number;
  healed?: true;
  write?: WriteStatus;
}
export type CallRecord = CallEntry & { at: string };

/** how long the log keeps a call: `stats` reports up to this far back */
export const KEEP_CALLS_DAYS = 30;
const KEEP_CALLS_MS = KEEP_CALLS_DAYS * 24 * 60 * 60_000;
/** what `loadCalls` returns unless asked for more: `status` reads a week */
const WEEK_MS = 7 * 24 * 60 * 60_000;
// ~100 bytes a line: some 10,000 calls, a few an hour for 30 days or a few a minute for a week
const MAX_CALLS_BYTES = 1_000_000;
const callsFile = () => join(home(), "calls.jsonl");

const parseCalls = (text: string): CallRecord[] =>
  text.split("\n").flatMap((l) => {
    try {
      const c = JSON.parse(l) as CallRecord;
      return c && typeof c === "object" && typeof c.at === "string" ? [c] : [];
    } catch {
      return [];
    }
  });

/** When the log's first line was written: a few bytes read, so each append can afford to ask. */
function oldestCall(file: string): number | undefined {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(80);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const at = /"at":"([^"]+)"/.exec(buf.toString("utf8", 0, n))?.[1];
    return at ? Date.parse(at) : undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one call. The file is rewritten only when it outgrows its cap or its first line is a day past
 * the week kept, so a call pays for one short append. Never throws: the log is a hint, never the answer.
 */
export function appendCall(entry: CallEntry, now = Date.now()): void {
  const file = callsFile();
  try {
    withLock(file, () => {
      appendFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString(), ...entry })}\n`, { mode: 0o600 });
      const oldest = oldestCall(file);
      const old = oldest !== undefined && now - oldest > KEEP_CALLS_MS + 24 * 60 * 60_000;
      if (!old && statSync(file).size <= MAX_CALLS_BYTES) return;
      let kept = parseCalls(readFileSync(file, "utf8"))
        .filter((c) => now - Date.parse(c.at) < KEEP_CALLS_MS)
        .map((c) => `${JSON.stringify(c)}\n`);
      // still over the cap within the week: the newest half stays, so the next rewrite is far off
      if (kept.join("").length > MAX_CALLS_BYTES) kept = kept.slice(-Math.floor(kept.length / 2));
      writePrivate(file, kept.join(""));
    });
  } catch {
    // a read-only home keeps no call log
  }
}

/** The call log's last week (or `withinMs`, up to the 30 days kept), oldest first; one site's or all. */
export function loadCalls(site?: string, now = Date.now(), withinMs = WEEK_MS): CallRecord[] {
  let text: string;
  try {
    text = readFileSync(callsFile(), "utf8");
  } catch {
    return [];
  }
  const within = Math.min(withinMs, KEEP_CALLS_MS);
  return parseCalls(text).filter((c) => (!site || c.site === site) && now - Date.parse(c.at) < within);
}

/**
 * A write that was sent and whose landing nothing confirmed: accepted (its readback did not find it,
 * or it has none), may_have_applied, or still "sending" (the process died mid-call).
 */
export const unconfirmedWrite = (r: WriteRecord) =>
  r.status === "accepted" || r.status === "may_have_applied" || r.status === "sending";

/* ----------------------------------------------------------------- export */

/**
 * A shareable copy: example values stripped from the stored request (param slots become `{name}`,
 * or null in a typed JSON leaf) and from params (unless `keepExamples`: a human confirmed they
 * are public), response shapes dropped (their keys can be user data), then scanned against this
 * machine's live session.
 */
export function exportSite(
  name: string,
  o: { keepExamples?: boolean } = {},
): { spec: Site; secrets: string[]; warnings: string[] } {
  const r = loadSite(name);
  if (!r) throw new Error(`no site "${name}"`);
  const spec = structuredClone(r.site);
  // where this copy was pulled from, when an op was learned and its registry version are this machine's history
  delete spec.shared;
  for (const op of spec.operations) {
    delete op.learnedAt;
    delete op.version;
  }
  const allowed = new Set<string>();
  const named: [string, string][] = [];
  const ips: string[] = [];
  spec.operations.forEach((op, i) => {
    const strip = (request: Operation["request"], slots: Operation["slots"]) => {
      const types = new Map(walk(request).map((l) => [JSON.stringify(l.at), l.type]));
      for (const slot of slots) {
        const p = slot.param !== undefined ? op.params.find((x) => x.name === slot.param) : undefined;
        // a derived leaf holds what the example's lookup answered; every call looks it up again. It keeps
        // its JSON type, which the value a call looks up is sent as.
        const derived = () =>
          types.get(JSON.stringify(slot.at)) === "number" ? 0 : slot.at[0]!.startsWith("path:") ? "0" : "";
        if (!p && !slot.from) continue;
        const typed = !!p && p.type !== "string" && slot.template === undefined && slot.at.at(-1)!.startsWith("json:");
        try {
          request = setAt(request, slot.at, p ? (typed ? null : (slot.template ?? `{${p.name}}`)) : derived());
        } catch {
          /* position gone; leave it */
        }
      }
      return request;
    };
    op.request = strip(op.request, op.slots);
    for (const slot of op.slots) if (slot.from) slot.from.request = strip(slot.from.request, slot.from.slots);
    if (!o.keepExamples) for (const p of op.params) delete p.example;
    // a shape's keys can be user data; the picked fields' are in the pick already, and their types let
    // every caller of the copy tell a picked field that went
    const picked = pickedShape(op.response);
    if (picked) op.response.shape = picked;
    else delete op.response.shape;
    const pub = new Set((op.public ?? []).map((h) => h.toLowerCase()));
    for (const h of pub) allowed.add(`$.operations[${i}].request.headers.${h}`);
    const where = (leaf: Leaf) => `$.operations[${i}].request ${leaf.at.join(" > ")}`;
    for (const leaf of literalCredentials(op.request, pub)) {
      const root = leaf.at[0]!;
      const n = leafName(leaf.at);
      named.push([
        `$.operations[${i}].request.${root.startsWith("header:") ? `headers.${root.slice(7)}` : /^(path|query)/.test(root) ? "url" : "body"}`,
        `${where(leaf)} holds a literal credential (${n}); make it a session: ref, or list ${n} in the op's public names if the site ships it to everyone`,
      ]);
    }
    op.slots.forEach((slot, j) => {
      if (!slot.from) return;
      for (const leaf of literalCredentials(slot.from.request, pub))
        named.push([
          `$.operations[${i}].slots[${j}].from.request`,
          `$.operations[${i}].slots[${j}].from.request ${leaf.at.join(" > ")} holds a literal credential (${leafName(leaf.at)})`,
        ]);
    });
    for (const fill of signInFills(op.trigger.steps))
      named.push([`$.operations[${i}].trigger.steps`, `$.operations[${i}].trigger ${fill}`]);
    for (const leaf of walk(op.request)) {
      const ip = leaf.type === "string" && !leaf.container ? ipIn(leaf.value) : undefined;
      if (ip)
        ips.push(
          `${where(leaf)} holds the IP address ${ip} (likely yours, as the page reported it); blank it if the site does not need it`,
        );
    }
  });
  const own = [spec.baseUrl, ...spec.operations.flatMap(opUrls)];
  const scan = scanSecrets(spec, credentialsOf(besideOrigins(loadSession(name), own)), allowed);
  // one finding per place: the exact live hit already names it
  const more = named.filter(([p]) => !scan.secrets.some((s) => s.startsWith(`${p} `))).map(([, why]) => why);
  return { spec, secrets: [...scan.secrets, ...more], warnings: [...scan.warnings, ...ips] };
}
