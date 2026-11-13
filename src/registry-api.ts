/**
 * The wire contract between the client and the registry service (registry/): what each endpoint takes
 * and answers. docs/REGISTRY.md says why. Both sides import these types; neither adds a field the other
 * does not read without making it optional.
 */
import { getAt } from "./codec.js";
import type { Operation, Request } from "./spec.js";

/** Production registry; API_ANYTHING_REGISTRY overrides it (https, or http to this machine for tests). */
export const REGISTRY_API = "https://api-anything-registry.forth-site.workers.dev";

/** Longest `GET /v1/search` q: a search answer repeats the query's words for each op it lists. */
export const MAX_SEARCH_QUERY = 200;

/**
 * - candidate: uploaded, served to others (marked) while no live version of the op exists
 * - live: confirmed by other installs; the default answer
 * - degraded: failing across installs; served only when nothing better exists
 * - review: outside the automatic rules (a login, a write, another site's host); served only to its uploader
 * - archived: a candidate or degraded version with no ok report in 30 days, or a degraded one a newer live version replaced; never served (a live version is never archived)
 * - blocked: a maintainer's kill switch; never served
 */
export type Status = "candidate" | "live" | "degraded" | "review" | "archived" | "blocked";

/** A call's outcome as a report: the class of `CallResult`, with `wrong` for data an agent saw contradict the page. */
export type Outcome = "ok" | "fail" | "wrong" | "auth" | "blocked" | "rate" | "input" | "error";

/** What a site is, shared by all its operations. A site's name is bound to its domain by the first upload. */
export interface SiteContext {
  /**
   * the site's short name, as `safeName` allows. A new site's is its domain with dots as dashes
   * (crates-io); a maintainer's seed may pick another (goodreads, google-flights)
   */
  name: string;
  /** the registrable domain of baseUrl (`siteOf`); the server computes it and refuses a mismatch */
  domain: string;
  baseUrl: string;
  /** a seed's title; the server stores the domain as the title of any other site */
  displayName?: string;
  description?: string;
  loginCookies?: string[];
  /** the site's request budget (spec.ts `pace`); the shared rules bound it (vet.ts LIMITS) */
  pace?: { minIntervalMs?: number; perHour?: number };
  /** caller notes (the `<site>.md` text before `## Maintainer notes`), at most 8 KB */
  notes?: string;
}

/** What the uploader's client proved before uploading (see learnsite.ts and share.ts). */
export interface Evidence {
  clientVersion: string;
  learnedLoggedIn: boolean;
  /**
   * the op replayed with no cookies and no session values at all. ok: it is public. blocked: a bot wall
   * answered (an Anubis or Cloudflare page): public data behind a wall, which each caller's browser tier
   * passes on its own, so it counts as public too.
   */
  cleanReplay: "ok" | "blocked" | "failed" | "skipped";
  /** a call with args used as neither example */
  holdout?: { args: Record<string, unknown>; ok: boolean; tier?: 1 | 2 | 3 };
  /** the tier the uploader's own successful calls answered at */
  tier?: 1 | 2 | 3;
  /** a heal: the version this one repairs */
  healedFrom?: string;
}

/** POST /v1/versions (signed). The operation is stored as sent, keyed by its hash. */
export interface VersionUpload {
  site: SiteContext;
  operation: Operation;
  /** the version this one replaces (a heal, or a re-learn of the same op) */
  parent?: string;
  evidence: Evidence;
  /**
   * an op learned signed in, sent because enough installs claimed its fingerprint (`Claim`): the
   * fingerprint, which the operation (in its `anonymous` form) must hash to
   */
  claim?: string;
}

/**
 * POST /v1/claims (signed): an op learned signed in, by its fingerprint alone. Its body can encode the
 * person who learned it (an account id in a path, a literal they typed), so it stays on their machine
 * until installs on enough distinct networks claimed the same fingerprint: identical bytes from strangers
 * hold no one person's own value. `nameHash` lets the registry keep the op's name only if as many of
 * them chose it.
 */
export interface Claim {
  site: { name: string; domain: string };
  /** sha256 hex of `fingerprintText` */
  fingerprint: string;
  /** sha256 hex of `nameHashText` */
  nameHash: string;
}

/**
 * The answer to POST and GET /v1/claims: this install's claims that enough installs hold, whose bodies the
 * registry asks for. `named`: as many of them gave the op the name this install did, so the body may carry
 * it; otherwise the body goes up as `op_<fingerprint>`, and this install's name never leaves it.
 */
export interface ClaimResult {
  wanted: { site: string; fingerprint: string; named: boolean }[];
}

/**
 * An op as it leaves a machine on a claim: none of the words its learner wrote (description, param
 * descriptions and hints), no examples (their own args), no checks. What stays is the request, the
 * response recipe and the param names and types: what every install that learned it has alike.
 */
export function anonymous(op: Operation): Operation {
  const {
    description: _d,
    checks: _c,
    unproven: _u,
    version: _v,
    learnedAt: _l,
    publicOnly: _p,
    ...rest
  } = op as Operation & {
    version?: unknown;
  };
  return {
    ...rest,
    params: op.params.map(({ description: _pd, hint: _h, example: _e, ...p }) => p),
  } as Operation;
}

/** The text an op's fingerprint is taken over: its site, then its anonymous form without its name. */
export const fingerprintText = (site: string, op: Operation) => {
  const { name: _n, ...rest } = anonymous(op);
  return `${site}\n${canonical(rest)}`;
};

export const nameHashText = (name: string) => `name|${name}`;

export interface UploadResult {
  /** sha256 hex of the canonical operation (see `versionHash`) */
  hash: string;
  status: Status;
  /** the same version was already there: this upload counted as a confirmation */
  duplicate: boolean;
  /** why it is `review`, or why it was refused (then the HTTP status is 4xx) */
  reasons?: string[];
}

/** The selected registry version's stored aggregate health. */
export interface RegistryHealth {
  /** the registry version these aggregates describe, not necessarily an installed local op */
  hash?: string;
  status: Status;
  confirmations: number;
  successRate?: number;
  lastOkAt?: string;
}

/** One op as the registry serves it: the best version of it. */
export interface ServedOp {
  hash: string;
  status: Status;
  /** distinct installs (not the uploader) that reported ok on this version */
  confirmations: number;
  /** ok / (ok + fail + wrong) over the recent window, distinct installs; absent with no reports */
  successRate?: number;
  lastOkAt?: string;
  registry?: RegistryHealth;
  operation: Operation;
}

/**
 * A site's own agent interface (an MCP server, an OpenAPI document) on its own registrable domain, which
 * installs on enough distinct networks reported. The agent may prefer it to a learned operation.
 */
export interface ServedInterface {
  kind: "mcp" | "openapi";
  url: string;
  /** distinct installs, one per network, that reported it */
  confirmations: number;
}

/** POST /v1/interfaces (signed): a site offers its own agent interface at `url`. */
export interface InterfaceReport {
  kind: "mcp" | "openapi";
  url: string;
}

/** GET /v1/sites/:name */
export interface ServedSite extends SiteContext {
  operations: ServedOp[];
  interfaces?: ServedInterface[];
}

/** One op in a search answer: enough to call it without another round trip. */
export interface FoundOp {
  name: string;
  /** `name(params) -> fields`, as `summarize` in registry.ts writes it */
  signature: string;
  description?: string;
  status: Status;
  confirmations: number;
  successRate?: number;
  lastOkAt?: string;
  registry?: RegistryHealth;
  matched?: string[];
  unmatched?: string[];
  login?: true;
  params: { name: string; type: string; required: boolean; description?: string; hint?: string; example?: unknown }[];
}

/** GET /v1/search?q=&limit= */
export interface SearchMatch {
  name: string;
  domain: string;
  displayName?: string;
  description?: string;
  operations: FoundOp[];
  matched?: string[];
  unmatched?: string[];
  /** the site's own agent interfaces; a domain search finds a site that has only these, with no operations */
  interfaces?: ServedInterface[];
}

/** POST /v1/reports (signed), at most 50 per request */
export interface Report {
  hash: string;
  outcome: Outcome;
  tier?: 1 | 2 | 3;
  ms?: number;
}

/** GET /v1/verify-jobs?limit= (signed): candidates this install has not reported, with the args to call them with */
export interface VerifyJob {
  hash: string;
  site: string;
  op: string;
  args: Record<string, unknown>;
  /** the version itself, and its site's baseUrl: /v1/sites serves only each op's best version */
  operation?: Operation;
  baseUrl?: string;
}

/**
 * Request signing. An install's key is an Ed25519 key pair made at setup (identity.ts). A signed request
 * carries three headers:
 * - x-aa-key: the raw 32-byte public key, base64url
 * - x-aa-ts: milliseconds since the epoch; the server refuses one more than 5 minutes off
 * - x-aa-sig: base64url Ed25519 signature of `signingText`
 */
export const signingText = (method: string, path: string, ts: string, bodySha256Hex: string) =>
  `${method.toUpperCase()}\n${path}\n${ts}\n${bodySha256Hex}`;

/** The canonical form a version's hash is taken over: keys sorted at every level, no `learnedAt`. */
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .filter((k) => k !== "learnedAt")
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value));
}

/** The text a version's hash (sha256 hex) is taken over: its site's name, then the canonical operation. */
export const versionHashText = (site: string, operation: Operation) => `${site}\n${canonical(operation)}`;

const GQL_NAME = /(?:^|\})\s*(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/;
const NAME_AT = [
  ["body", "json:/operationName"],
  ["body", "json:/0/operationName"],
  ["form:fb_api_req_friendly_name"],
  ["form:operationName"],
  ["query:operationName"],
  ["header:x-fb-friendly-name"],
];
const DOCUMENT_AT = [["body", "json:/query"], ["body", "json:/0/query"], ["form:query"], ["query:query"]];

/** The GraphQL operation name a request carries, read as learn.ts `operationNameOf` reads it (the Worker cannot import learn.ts). */
function nameOf(req: Request): string | undefined {
  const read = (at: string[]) => {
    try {
      return getAt(req, at);
    } catch {
      return undefined;
    }
  };
  for (const at of NAME_AT) {
    const v = read(at);
    if (typeof v === "string" && v) return v;
  }
  for (const at of DOCUMENT_AT) {
    const v = read(at);
    const m = typeof v === "string" ? GQL_NAME.exec(v) : null;
    if (m) return m[1];
  }
  return undefined;
}

// a slot's last step at a field that names the operation, and at the document or whole body that can
const FILLS_NAME =
  /^(json:(\/\d+)?\/operationName|(form|query)(\[\d+\])?:(operationName|fb_api_req_friendly_name)|header:x-fb-friendly-name)$/i;
const FILLS_DOCUMENT = /^(body|b64|json:(\/\d+)?(\/query)?|(form|query)(\[\d+\])?:query)$/;

/**
 * The request an op sends, as the registry's review and a client taking a repair compare it: method,
 * origin, path and GraphQL operationName, read from the request and its slots. An op's `match` is its
 * author's word, so it lends only its wildcards (a rotating hash segment, which a heal changes). A path
 * segment a slot fills is `*`, whatever the stored one says, and so is a name a slot can change: a param's
 * default moves neither unseen. A URL that fetch would rewrite (dot segments, a backslash) equals only itself.
 */
export function requestSig(op: Pick<Operation, "request" | "slots" | "match">): string {
  const method = op.request.method.toUpperCase();
  const last = op.slots.map((s) => s.at.at(-1) ?? "");
  const stored = nameOf(op.request);
  const name =
    last.some((st) => FILLS_NAME.test(st)) || (stored !== undefined && last.some((st) => FILLS_DOCUMENT.test(st)))
      ? "*"
      : (stored ?? "");
  const filled = new Set(
    op.slots.flatMap((s) => (/^path:\d+$/.test(s.at[0] ?? "") ? [Number(s.at[0]!.slice(5))] : [])),
  );
  // as codec.ts splits a URL: the path is what comes before the first ? or #
  const base = op.request.url.split(/[?#]/)[0]!;
  const odd = JSON.stringify([method, "", base, name, [...filled].sort((a, b) => a - b)]);
  let u: URL;
  try {
    u = new URL(op.request.url);
  } catch {
    return odd;
  }
  const have = u.pathname.split("/");
  // the codec counts segments in the stored text and fetch in the parsed URL: they must be the same ones
  const asStored = base === u.origin + u.pathname || base === u.origin;
  if (!asStored || [...filled].some((i) => i + 1 >= have.length)) return odd;
  const declared = (op.match.path ?? "").split("/");
  const path = have
    .map((seg, i) =>
      filled.has(i - 1) || (declared.length === have.length && declared[i] === "*") ? "*" : seg === "*" ? "%2A" : seg,
    )
    .join("/");
  return JSON.stringify([method, u.origin, path, name]);
}

/**
 * What an op's browser runs open and do, compared wherever `requestSig` is: its trigger in canonical form.
 * A heal keeps its op's trigger (heal.ts), so a version with another one opens a page nobody approved.
 */
export const triggerSig = (op: Pick<Operation, "trigger">): string => canonical(op.trigger);
