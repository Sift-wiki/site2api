/**
 * The client of the registry service (docs/REGISTRY.md; the wire contract is registry-api.ts): `pull`
 * fetches a site into `~/.api-anything/registry`, `search` asks which sites answer a query. The rules
 * a pulled spec must pass are vet.ts's.
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { loadRecord, opHash } from "./checks.js";
import { loadSettings, localOnly, localOnlyOff, signedHeaders } from "./identity.js";
import {
  MAX_SEARCH_QUERY,
  REGISTRY_API,
  requestSig,
  type ServedSite,
  type Status,
  triggerSig,
} from "./registry-api.js";
import { indexEntry, matchQuery, operationMatch, type QueryMatch, summarize } from "./search.js";
import { dropUnbound, home, loadSession, readJson, safeName, siteOf, writePrivate } from "./session.js";
import { type Operation, parseSite, type Site } from "./spec.js";
import { listSites, loadSite, registryDir, updateSite } from "./store.js";
import { badAddress, interfaceAddress, LIMITS, MAX_INTERFACE_URL, vetShared } from "./vet.js";

export { summarize };

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The registry's base URL: `API_ANYTHING_REGISTRY`, https (or http to this machine, for tests). */
export function registryBase(): string {
  const base = (process.env.API_ANYTHING_REGISTRY || REGISTRY_API).replace(/\/+$/, "");
  const u = new URL(base);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL.has(u.hostname)))
    throw new Error(`API_ANYTHING_REGISTRY must be https: ${base}`);
  return base;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Local-only mode refused a request before anything was sent. */
export class LocalOnlyError extends RegistryError {
  constructor() {
    super(`this install is local-only: nothing is sent to the shared catalog (${localOnlyOff()})`);
    this.name = "LocalOnlyError";
  }
}

/**
 * One request to the registry, answered with JSON: no redirects (one could move it to any origin), a
 * timeout, the answer read while streaming so a huge one stops at `cap`. `signed` adds identity.ts's headers.
 * Every registry request goes through here, so local-only mode is enforced here: it throws
 * `LocalOnlyError` before any connection opens.
 */
export async function registryRequest<T>(
  path: string,
  o: {
    method?: "GET" | "POST";
    body?: unknown;
    signed?: boolean;
    cap?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  if (localOnly()) throw new LocalOnlyError();
  const url = `${registryBase()}${path}`;
  const method = o.method ?? "GET";
  const text = o.body === undefined ? "" : JSON.stringify(o.body);
  const u = new URL(url);
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 20_000);
  const res = await fetch(url, {
    method,
    headers: {
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(o.signed ? signedHeaders(method, u.pathname + u.search, text) : {}),
    },
    ...(o.body !== undefined ? { body: text } : {}),
    redirect: "error",
    signal: o.signal ? AbortSignal.any([timeout, o.signal]) : timeout,
  }).catch((e: Error) => {
    throw new RegistryError(`${url} could not be reached (${e.message})`);
  });
  const cap = o.cap ?? 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > cap) throw new RegistryError(`${url} is over ${cap} bytes`, res.status);
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RegistryError(`${url} answered ${res.status}, not JSON`, res.status);
  }
  if (!res.ok) {
    const e = body as { error?: unknown; reasons?: unknown };
    const why = [e.error, ...(Array.isArray(e.reasons) ? e.reasons : [])].filter((x) => typeof x === "string");
    throw new RegistryError(`${url} answered ${res.status}${why.length ? `: ${why.join("; ")}` : ""}`, res.status);
  }
  return body as T;
}

export interface Pulled {
  site: string;
  from: string;
  sha256: string;
  operations: (ReturnType<typeof summarize> & {
    status?: string;
    registry: RegistryEvidence;
    local: LocalEvidence;
  })[];
  warnings: string[];
  /** on a pull again: ops that are new, changed or gone since the last one */
  changed?: { added: string[]; changed: string[]; removed: string[] };
  /** the user's own copy, which wins over the pulled one */
  shadowedBy?: string;
}

const sitesOfSession = (name: string) => {
  const s = loadSession(name);
  return new Set([
    ...s.cookies.map((c) => siteOf(c.domain.replace(/^\./, ""))),
    ...(s.origins ?? []).map((o) => siteOf(new URL(o).hostname)),
  ]);
};

/** A served site as a local spec: each op records the version it is. */
function siteFrom(name: string, served: ServedSite): Site {
  if (String(served.name).toLowerCase() !== name) throw new Error(`is the site "${served.name}", not "${name}"`);
  const site = parseSite({
    name,
    ...(served.displayName ? { displayName: served.displayName } : {}),
    baseUrl: served.baseUrl,
    ...(served.description ? { description: served.description } : {}),
    ...(served.loginCookies ? { loginCookies: served.loginCookies } : {}),
    ...(served.pace ? { pace: served.pace } : {}),
    operations: served.operations.map((o) => ({ ...o.operation, version: { hash: o.hash, status: o.status } })),
  });
  if (siteOf(new URL(site.baseUrl).hostname) !== served.domain)
    throw new Error(`names the domain ${served.domain}, and its baseUrl is ${site.baseUrl}`);
  return site;
}

/**
 * `by` marks a pull no human ran. `"agent"`: an agent made it over MCP, so its writes stay hidden there
 * whatever the server allows, since page text may have steered the agent to it. `"upgrade"`: the
 * background replacement of a bundled site. Under either, a candidate stays out of the browser profile.
 */
export async function pull(name: string, o: { by?: "agent" | "upgrade"; signal?: AbortSignal } = {}): Promise<Pulled> {
  name = safeName(name);
  const from = `${registryBase()}/v1/sites/${name}`;
  let served: ServedSite;
  try {
    // the spec, its notes and the served fields around them
    served = await registryRequest<ServedSite>(`/v1/sites/${name}`, {
      cap: LIMITS.file + LIMITS.notes + 64 * 1024,
      signal: o.signal,
    });
  } catch (e) {
    if (e instanceof RegistryError && e.status === 404) throw new Error(`no shared spec for "${name}" in the registry`);
    throw e;
  }
  let site: Site;
  try {
    site = siteFrom(name, served);
  } catch (e) {
    throw new Error(`${from}: ${(e as Error).message}`);
  }
  const notes = typeof served.notes === "string" ? served.notes : undefined;
  const { errors, warnings } = vetShared(site, notes);
  if (errors.length) throw new Error(`the shared spec of "${name}" fails the shared rules: ${errors.join("; ")}`);
  const body = JSON.stringify(site, null, 2);
  if (Buffer.byteLength(body) > LIMITS.file) throw new Error(`${from} is over ${LIMITS.file} bytes`);
  const sha256 = createHash("sha256").update(body).digest("hex");
  site = { ...site, shared: { from, sha256, ...(o.by ? { by: o.by } : {}) } };

  // One name is one session: a spec on another site would inherit this one's cookies and values.
  const own = siteOf(new URL(site.baseUrl).hostname);
  let local: ReturnType<typeof loadSite>;
  try {
    local = loadSite(name);
  } catch {
    local = undefined; // an unreadable copy is replaced
  }
  if (local && siteOf(new URL(local.site.baseUrl).hostname) !== own)
    throw new Error(`a local spec "${name}" is for ${local.site.baseUrl}, not ${site.baseUrl}`);
  const held = sitesOfSession(name);
  if (held.size && !held.has(own))
    throw new Error(`the local session "${name}" belongs to ${[...held].join(", ")}, not ${own}`);

  dropUnbound(name);

  const path = join(registryDir(), `${name}.json`);
  const before = local?.site.shared ? local.site : undefined;
  // the notes first: a spec without its new notes beside it would load with the old ones
  const notesPath = join(registryDir(), `${name}.md`);
  if (notes !== undefined) writePrivate(notesPath, notes);
  else rmSync(notesPath, { force: true });
  writePrivate(path, `${JSON.stringify(site, null, 2)}\n`);
  // The user's own copy (a heal's, or one an add extended) wins over the pulled one: a human's pull
  // is the consent that clears the mark there too, or an agent pull's writes would stay hidden for good.
  if (!o.by && local?.source === "user" && local.site.shared?.by)
    updateSite(name, (s) => ({ ...s!, shared: { from: s!.shared!.from, sha256: s!.shared!.sha256 } }));

  return {
    site: name,
    from,
    sha256,
    operations: site.operations.map((op) => ({
      ...summarize(op),
      ...(op.version ? { status: op.version.status } : {}),
      registry: registryEvidence(served.operations.find((o) => o.operation.name === op.name)),
      local: localEvidence(name, op),
    })),
    warnings,
    ...(before ? { changed: changes(before, site) } : {}),
    ...(local?.source === "user" ? { shadowedBy: local.path } : {}),
  };
}

function changes(before: Site, after: Site) {
  const old = new Map(before.operations.map((op) => [op.name, JSON.stringify(op)]));
  const now = new Map(after.operations.map((op) => [op.name, JSON.stringify(op)]));
  return {
    added: [...now.keys()].filter((n) => !old.has(n)),
    changed: [...now].filter(([n, s]) => old.has(n) && old.get(n) !== s).map(([n]) => n),
    removed: [...old.keys()].filter((n) => !now.has(n)),
  };
}

/** How long a drifted call waits for the registry before it heals on its own. */
const SERVED_NOW_MS = 3_000;

const sameMatch = (a: Operation, b: Operation) =>
  (a.match.method ?? a.request.method).toUpperCase() === (b.match.method ?? b.request.method).toUpperCase() &&
  (a.match.host ?? "") === (b.match.host ?? "") &&
  (a.match.path ?? "") === (b.match.path ?? "") &&
  (a.match.operationName ?? "") === (b.match.operationName ?? "") &&
  // the match is its author's word: the request itself must be the same one, and what a browser run opens
  requestSig(a) === requestSig(b) &&
  triggerSig(a) === triggerSig(b);

/**
 * A drifted op of a pulled spec: the version the registry serves for it now, when that is another live
 * one with the same match (another install's repair, promoted, or the next best after this one
 * degraded), returned for the call to try: one request in place of a browser heal. Nothing is saved
 * until it answers (`adopt`). Undefined when the registry serves nothing else, cannot be reached in 3 s,
 * or serves something the shared rules refuse.
 */
export async function servedNow(
  name: string,
  op: Operation,
  o: { signal?: AbortSignal } = {},
): Promise<Operation | undefined> {
  if (!op.version || !op.readOnly) return undefined;
  name = safeName(name);
  const r = loadSite(name);
  // Only a spec that is someone else's already takes someone else's version: its `shared` record is what
  // holds the replacement to the shared rules, in this call and after. An op the user learned and shared
  // has a version and no record, so it heals by itself and shares the heal back.
  if (!r || r.source === "bundled" || !r.site.shared) return undefined;
  let served: ServedSite;
  let site: Site;
  try {
    // a pulled spec keeps the name the registry holds it under
    served = await registryRequest<ServedSite>(`/v1/sites/${name}`, {
      cap: LIMITS.file + LIMITS.notes + 64 * 1024,
      timeoutMs: SERVED_NOW_MS,
      signal: o.signal,
    });
    site = siteFrom(name, served);
  } catch {
    return undefined;
  }
  const next = site.operations.find((x) => x.name === op.name);
  if (!next?.version || next.version.hash === op.version.hash || next.version.status !== "live") return undefined;
  if (!next.readOnly || !sameMatch(op, next)) return undefined;
  if (vetShared({ ...r.site, operations: [next] }).errors.length) return undefined;
  if (siteOf(new URL(site.baseUrl).hostname) !== siteOf(new URL(r.site.baseUrl).hostname)) return undefined;
  return next;
}

/** The registry's version answered in place of a drifted op: it replaces that op where this machine reads it, the rest of the spec untouched. */
export function adopt(name: string, op: Operation, next: Operation): void {
  name = safeName(name);
  const r = loadSite(name);
  if (!r) return;
  // an upload carries no links (their targets are other ops), so the local ones stay
  const swap = (s: Site): Site => ({
    ...s,
    operations: s.operations.map((x) =>
      x.name === op.name ? { ...next, ...(x.links && !next.links ? { links: x.links } : {}) } : x,
    ),
  });
  if (r.source === "registry") writePrivate(r.path, `${JSON.stringify(swap(r.site), null, 2)}\n`);
  else updateSite(name, (cur) => swap(cur ?? r.site));
}

const upgradesFile = () => join(home(), "upgrades.json");
const RETRY_UPGRADE_MS = 7 * 24 * 60 * 60_000;

/**
 * A bundled site called with sharing on is replaced by the registry's copy, once, so its calls carry a
 * version and report. No agent mark: the package already trusted the site, so its writes stay visible
 * and its reviewed reads keep the session. Its own mark instead: nobody looked at this copy, and the
 * registry may serve a candidate where the seeded version degraded. An attempt is recorded, so a
 * registry without the site is asked again only after a week.
 */
export async function upgradeBundled(name: string, o: { signal?: AbortSignal } = {}): Promise<boolean> {
  name = safeName(name);
  if (!loadSettings().share || localOnly() || loadSite(name)?.source !== "bundled") return false;
  const tried = readJsonOr<Record<string, number>>(upgradesFile(), {});
  if (Date.now() - (tried[name] ?? 0) < RETRY_UPGRADE_MS) return false;
  writePrivate(upgradesFile(), JSON.stringify({ ...tried, [name]: Date.now() }));
  await pull(name, { by: "upgrade", signal: o.signal });
  return true;
}

function readJsonOr<T>(file: string, fallback: T): T {
  try {
    return readJson<T>(file, fallback) ?? fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ search */

// A match reaches the agent as text, so it is held to the limits the shared rules put on a spec.
const text = z.string().max(LIMITS.text);
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const STATUS = z.enum(["candidate", "live", "degraded", "review", "archived", "blocked"]);
const RegistryHealthSchema = z.object({
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  status: STATUS,
  confirmations: z.number().int().min(0),
  successRate: z.number().min(0).max(1).optional(),
  lastOkAt: z.iso.datetime().optional(),
});

export interface RegistryEvidence {
  hash?: string;
  status: Status | "unknown";
  confirmations: number | "unknown";
  successRate: number | "unknown";
  lastOkAt: string;
}

export interface LocalEvidence {
  status: "pass" | "fail" | "inconclusive" | "unknown";
  at?: string;
}

// The top-level fields are what the registry serves the op as; a nested copy that disagrees with them is not
// evidence of anything, so it lends only its hash, and only when it agrees.
function registryEvidence(value?: unknown): RegistryEvidence {
  const p = RegistryHealthSchema.safeParse(value);
  const n = RegistryHealthSchema.safeParse((value as { registry?: unknown } | undefined)?.registry);
  const agrees =
    p.success &&
    n.success &&
    n.data.status === p.data.status &&
    n.data.confirmations === p.data.confirmations &&
    n.data.successRate === p.data.successRate &&
    n.data.lastOkAt === p.data.lastOkAt &&
    (!p.data.hash || n.data.hash === p.data.hash);
  const hash = p.success ? (p.data.hash ?? (agrees ? n.data?.hash : undefined)) : undefined;
  return {
    ...(hash ? { hash } : {}),
    status: p.success ? p.data.status : "unknown",
    confirmations: p.success ? p.data.confirmations : "unknown",
    successRate: p.success ? (p.data.successRate ?? "unknown") : "unknown",
    lastOkAt: p.success ? (p.data.lastOkAt ?? "unknown") : "unknown",
  };
}

function localEvidence(site: string, op: Operation): LocalEvidence {
  let r: ReturnType<typeof loadRecord>[string] | undefined;
  try {
    r = loadRecord(site)[op.name];
  } catch {
    // a corrupt record says nothing, and must not cost the search its answer
  }
  if (!r || r.hash !== opHash(op) || !r.results?.length) return { status: "unknown" };
  const outcomes = r.results.map((c) => c.outcome);
  return {
    status: outcomes.includes("fail") ? "fail" : outcomes.includes("inconclusive") ? "inconclusive" : "pass",
    at: r.at,
  };
}

const FoundOpSchema = z.object({
  name: z.string().regex(NAME),
  // `name(params) -> fields`, whose name the shared rules restrict
  signature: z
    .string()
    .max(2000)
    .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}\(/),
  description: text.optional(),
  status: STATUS,
  confirmations: z.number().int().min(0),
  successRate: z.number().min(0).max(1).optional(),
  lastOkAt: z.iso.datetime().optional(),
  registry: RegistryHealthSchema.optional(),
  login: z.literal(true).optional(),
  params: z
    .array(
      z.object({
        name: z.string().regex(NAME),
        type: z.string().max(20),
        required: z.boolean(),
        description: text.optional(),
        hint: text.optional(),
        example: z.union([text, z.number(), z.boolean()]).optional(),
      }),
    )
    .max(50),
});
/** interfaces kept per match: more are dropped, never the match */
const MAX_INTERFACES = 10;

const InterfaceSchema = z.object({
  kind: z.enum(["mcp", "openapi"]),
  url: z.string().max(MAX_INTERFACE_URL),
  confirmations: z.number().int().min(0),
});

const SearchMatchSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  domain: z.string().regex(/^[a-z0-9.-]{1,253}$/),
  displayName: z.string().max(100).optional(),
  description: text.optional(),
  operations: z.array(FoundOpSchema).max(LIMITS.operations),
  // a malformed interface is dropped, not the match
  interfaces: z
    .array(z.unknown())
    .optional()
    .transform((list) =>
      list
        ?.flatMap((x) => {
          const p = InterfaceSchema.safeParse(x);
          const url = p.success ? interfaceAddress(p.data.url) : undefined;
          return p.success && url ? [{ ...p.data, url }] : [];
        })
        .slice(0, MAX_INTERFACES),
    ),
});

/** Whether the registry may be asked about `host`: no IP, localhost, single label, suffix outside the public list or `.arpa` name. */
const publicHost = (host: string) => !badAddress(`https://${host}`);

// Letters and digits of any script, a hyphen or an apostrophe only inside. With no dot, colon or slash it
// names a single-label host at most, which nothing tells from a word.
const WORD = /^[\p{L}\p{M}\p{Nd}]+(?:['’-][\p{L}\p{M}\p{Nd}]+)*$/u;
// what is written around a word or an address and is no part of it; never a colon or a slash, which are part of one
const AROUND = /^[("'“”‘’`<[{*]+|[)"'“”‘’`>\]}*,.;!?…]+$/g;
// before an address: `site:`, `host=`, a scheme with any slashes; not the colon of host:port
const KEY = /^[a-z][\w+-]*(?:=|:(?!\d+(?:[/?#]|$))\/*)/i;
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** The public registrable domain of a token that is no word, read as an address; undefined when it has none. */
function publicDomain(token: string): string | undefined {
  let t = token;
  // an address pasted encoded, once or twice over
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(t); i++)
    try {
      t = decodeURIComponent(t);
    } catch {
      break;
    }
  // a few, not all: a key left in front makes no host below
  for (let i = 0; i < 4 && KEY.test(t); i++) t = t.replace(KEY, "");
  let host: string;
  try {
    // the URL parser drops a user name and password, and reads an IP however it is written
    host = new URL(`https://${t}`).hostname.replace(/\.$/, "");
  } catch {
    return undefined;
  }
  return isIP(host.replace(/^\[|\]$/g, "")) || !DOMAIN.test(host) || !publicHost(host) ? undefined : siteOf(host);
}

/**
 * What a search sends the registry: `sent`, absent when nothing of the query may go, and `dropped`, whether
 * part of it stayed here. A word goes as typed. Every other token is read as an address and goes as its
 * public registrable domain, which is all the registry reads of one (its path and query can hold a token),
 * or not at all: an IP, a host that is not public, or anything else that is no word (`node.js`, a file
 * path, `k=v`). The registry holds no such site, and would list the name as demand. A query over the
 * registry's limit loses whole tokens. Local matching keeps the whole query.
 */
export function registryQuery(query: string): { sent?: string; dropped: boolean } {
  const sent: string[] = [];
  let dropped = false;
  let length = -1;
  for (const typed of query.split(/\s+/)) {
    // a token with no letter or digit says nothing to send or to keep back
    if (!/[\p{L}\p{N}]/u.test(typed)) continue;
    const token = typed.replace(AROUND, "");
    const part = WORD.test(token) ? token : publicDomain(token);
    if (part === undefined || length + 1 + part.length > MAX_SEARCH_QUERY) dropped = true;
    else {
      sent.push(part);
      length += 1 + part.length;
    }
  }
  return { ...(sent.length ? { sent: sent.join(" ") } : {}), dropped };
}

/** `search`'s `notSent`: fixed text, since what stayed here is not for an answer to repeat. */
const NOT_ASKED =
  "the shared catalog was not asked: only plain words and public domains are sent to it, and this query has neither, so these are this machine's sites only";
const PART_SENT =
  "part of the query was not sent to the shared catalog: only plain words and public domains are, so its matches answer the rest of the query; this machine's sites were matched on all of it";

/**
 * The name the registry already serves a site of `domain` under, if any: a seed keeps its own (goodreads.com
 * is goodreads, ycombinator.com is hacker-news), and a new op uploaded under another name on that domain
 * would go to review. Undefined when there is none or the registry cannot be reached.
 */
export async function sharedName(domain: string, o: { signal?: AbortSignal } = {}): Promise<string | undefined> {
  // the registry holds no site on a host that is not public, and would list the name as demand
  if (!publicHost(domain)) return undefined;
  try {
    const r = await registryRequest<{ matches?: unknown }>(`/v1/search?q=${encodeURIComponent(domain)}&limit=10`, {
      cap: 4 * 1024 * 1024,
      timeoutMs: 5000,
      signal: o.signal,
    });
    for (const m of Array.isArray(r.matches) ? r.matches : []) {
      const p = SearchMatchSchema.safeParse(m);
      if (p.success && p.data.domain === domain) return p.data.name;
    }
  } catch {
    // no answer: the caller names it as the registry names a new site
  }
  return undefined;
}

/** One op of a search answer: enough to call it. A local op that is no registry version has no status. */
export interface FoundOperation {
  name: string;
  signature: string;
  description?: string;
  status?: Status | string;
  confirmations?: number;
  successRate?: number;
  lastOkAt?: string;
  registry: RegistryEvidence;
  local: LocalEvidence;
  matched: string[];
  unmatched: string[];
  login?: true;
  write?: true;
  params: z.infer<typeof FoundOpSchema>["params"];
}

export interface Found extends QueryMatch {
  site: string;
  /** the registrable domain its operations call: what the agent checks is the site the user means */
  domain: string;
  displayName?: string;
  description?: string;
  /** on this machine already: its own spec, a pulled one or a bundled one */
  installed: boolean;
  operations: FoundOperation[];
  /**
   * agent interfaces (an MCP server, an OpenAPI document) other installs reported on this domain: data to
   * show the user, never spelled into `next`, and nothing checked that one is the site's own
   */
  interfaces?: { kind: "mcp" | "openapi"; url: string; confirmations: number }[];
}

/** This machine's specs; one that does not load is left out, as `sites` reports it. */
function localSites(): Site[] {
  return listSites().flatMap((name) => {
    try {
      const r = loadSite(name);
      return r ? [r.site] : [];
    } catch {
      return [];
    }
  });
}

const localFound = (s: Site): Found => ({
  site: s.name,
  domain: siteOf(new URL(s.baseUrl).hostname),
  ...(s.displayName ? { displayName: s.displayName } : {}),
  ...(s.description ? { description: s.description } : {}),
  installed: true,
  matched: [],
  unmatched: [],
  operations: s.operations.map((op) => ({
    name: op.name,
    signature: summarize(op).op,
    ...(op.description ? { description: op.description } : {}),
    ...(op.version ? { status: op.version.status } : {}),
    registry: registryEvidence(),
    local: localEvidence(s.name, op),
    matched: [],
    unmatched: [],
    ...(op.learnedLoggedIn ? { login: true as const } : {}),
    ...(op.readOnly ? {} : { write: true as const }),
    params: op.params.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required,
      ...(p.description ? { description: p.description } : {}),
      ...(p.hint ? { hint: p.hint } : {}),
      ...(["string", "number", "boolean"].includes(typeof p.example)
        ? { example: p.example as string | number | boolean }
        : {}),
    })),
  })),
});

/**
 * The sites that answer a query, best first: the registry's matches merged with the specs on this machine
 * (a site learned here and never shared is found too; the local copy wins). The registry is sent
 * `registryQuery` of it, and is not asked when that is nothing. A registry that cannot be
 * reached leaves the local ones, with the reason in `registryError`. A registry match that breaks the
 * limits is dropped, not the rest. Local-only mode searches this machine alone and says so in `localOnly`.
 * `notSent` says when the registry was sent only part of the query, or was not asked: its side of the answer is then partial.
 */
export async function search(
  query: string,
  o: { limit?: number; local?: Site[] } = {},
): Promise<{ matches: Found[]; registryError?: string; localOnly?: string; notSent?: string }> {
  const limit = o.limit ?? 5;
  const offline = localOnly();
  // read before the cut below: the start of a cut address can spell another host
  const asked = offline ? undefined : registryQuery(query);
  // local scoring and each op's coverage repeat the query's words too
  query = query.trim().slice(0, MAX_SEARCH_QUERY);
  let remote: z.infer<typeof SearchMatchSchema>[] = [];
  let registryError: string | undefined;
  if (asked?.sent !== undefined)
    try {
      const r = await registryRequest<{ matches?: unknown }>(
        `/v1/search?q=${encodeURIComponent(asked.sent)}&limit=${limit}`,
        {
          cap: 4 * 1024 * 1024,
        },
      );
      if (!Array.isArray(r.matches)) throw new Error(`${registryBase()}/v1/search answered no matches`);
      remote = r.matches.flatMap((m) => {
        const p = SearchMatchSchema.safeParse(m);
        // a match whose interfaces were all dropped and that has no operations is no site to name
        return p.success && (p.data.operations.length || p.data.interfaces?.length) ? [p.data] : [];
      });
    } catch (e) {
      registryError = (e as Error).message;
    }
  const local = o.local ?? localSites();
  const installed = new Set(local.map((s) => s.name));
  // Local call metadata wins. Registry evidence describes its own version, never local verification.
  const remoteInterfaces = new Map(
    remote.flatMap((m) => (m.interfaces?.length ? [[m.domain, m.interfaces] as const] : [])),
  );
  const withInterfaces = (f: Found): Found => {
    const own = remoteInterfaces.get(f.domain);
    const shared = remote.find((m) => m.name === f.site && m.domain === f.domain);
    return {
      ...f,
      ...(own ? { interfaces: own } : {}),
      operations: f.operations.map((op) => ({
        ...op,
        registry: registryEvidence(shared?.operations.find((o) => o.name === op.name)),
      })),
    };
  };
  const scored = [
    ...local.map((s) => ({
      found: withInterfaces(localFound(s)),
      match: matchQuery(indexEntry(s, ""), query),
      local: true,
    })),
    ...remote
      .filter((m) => !installed.has(m.name))
      .map((m) => ({
        found: {
          site: m.name,
          domain: m.domain,
          ...(m.displayName ? { displayName: m.displayName } : {}),
          ...(m.description ? { description: m.description } : {}),
          installed: false,
          matched: [],
          unmatched: [],
          operations: m.operations.map((op) => ({
            ...op,
            registry: registryEvidence(op),
            local: { status: "unknown" as const },
            matched: [],
            unmatched: [],
          })),
          ...(m.interfaces?.length ? { interfaces: m.interfaces } : {}),
        },
        match: matchQuery(
          { ...m, site: m.name, domains: [m.domain], operations: m.operations.map((x) => ({ ...x, op: x.signature })) },
          query,
        ),
        local: false,
      })),
  ];
  const best = Math.max(0, ...scored.map((x) => x.match.score));
  // a local site far behind the best answer matched a stray word; the registry already chose its own
  const matches = scored
    .filter((x) => !x.local || (x.match.score > 0 && x.match.score * 3 >= best))
    .sort((a, b) => b.match.score - a.match.score || a.found.site.localeCompare(b.found.site))
    .slice(0, limit)
    .map(({ found, match }) => ({
      ...found,
      matched: match.matched,
      unmatched: match.unmatched,
      operations: found.operations.map((op) => ({
        ...op,
        ...operationMatch({ op: op.signature, description: op.description }, query),
      })),
    }));
  return {
    matches,
    ...(registryError ? { registryError } : {}),
    ...(offline
      ? {
          localOnly: `searched this machine only: this install is local-only, so the shared catalog was not asked (${localOnlyOff()})`,
        }
      : {}),
    ...(asked && asked.sent === undefined ? { notSent: NOT_ASKED } : asked?.dropped ? { notSent: PART_SENT } : {}),
  };
}

/**
 * Tells the registry a site offers its own agent interface at `url` (an MCP server or an OpenAPI document,
 * https on the site's own domain). Once installs on enough networks said so, search lists it beside the
 * site's operations, and finds a site that has only it.
 */
export async function reportInterface(kind: "mcp" | "openapi", url: string, o: { signal?: AbortSignal } = {}) {
  const bad = badAddress(url);
  if (bad) throw new Error(`the interface's url ${bad}`);
  const address = interfaceAddress(url);
  if (!address)
    throw new Error(
      `the interface's url is more than an address: at most ${MAX_INTERFACE_URL} characters, no query or fragment, and a path of letters, digits and . _ ~ / - only`,
    );
  return registryRequest<{ domain: string; served: boolean }>("/v1/interfaces", {
    method: "POST",
    body: { kind, url: address },
    signed: true,
    cap: 64 * 1024,
    signal: o.signal,
  });
}
