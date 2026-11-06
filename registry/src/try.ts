/**
 * `GET /v1/try/:site/:op`: the one place the catalog sends a request to a site, so a visitor can try a
 * public read with no install. Only an allowlisted, live, plain-HTTP GET with no cookie or session value
 * runs, once, from the Worker, under per-network and global limits, cached, and only while TRY_ENABLED is
 * on. It fills the template and judges the answer with the client's own modules.
 */
import { judge } from "../../src/classify.js";
import { siteOf } from "../../src/domain.js";
import type { CallResult } from "../../src/execute.js";
import { capOutput } from "../../src/extract.js";
import { buildRequest, decodeBody, holdsRef, REDIRECT, unknownArgs } from "../../src/http.js";
import type { ServedOp, ServedSite } from "../../src/registry-api.js";
import type { Operation } from "../../src/spec.js";
import { badAddress, vetShared } from "../../src/vet.js";
import { networksOf } from "./auth.js";
import { catalog } from "./catalog.js";
import { count, type D1Database } from "./store.js";

/**
 * The ops a visitor may try, by site: bundled public reads whose data is harmless, answered over plain
 * HTTP, from hosts that answer a datacenter's address. Nothing else is ever sent from the catalog.
 */
export const TRY_OPS: Readonly<Record<string, readonly string[]>> = {
  "hacker-news": ["frontPage", "getItem"],
  wikipedia: ["searchArticles", "getSummary"],
  openlibrary: ["getWork", "getAuthor"],
  "usgs-earthquakes": ["recent", "getEvent"],
  "nasa-images": ["search"],
};

/** Each is a Worker var too (e.g. TRY_PER_MINUTE), to tighten one without a code change. */
const DEFAULTS = {
  perMinute: 10,
  perDay: 100,
  allPerDay: 5000,
  timeoutMs: 8000,
  maxBytes: 1_000_000,
  cacheSeconds: 600,
};
const VARS: Record<keyof typeof DEFAULTS, string> = {
  perMinute: "TRY_PER_MINUTE",
  perDay: "TRY_PER_DAY",
  allPerDay: "TRY_PER_DAY_ALL",
  timeoutMs: "TRY_TIMEOUT_MS",
  maxBytes: "TRY_MAX_BYTES",
  cacheSeconds: "TRY_CACHE_SECONDS",
};
type Limits = typeof DEFAULTS;

const MAX_ARG = 500;
const MAX_ARGS = 20;
const MAX_REDIRECTS = 3;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const VIA = "catalog-try";

export interface TryEnv {
  DB: D1Database;
  SALT?: string;
  TRY_ENABLED?: unknown;
  [v: string]: unknown;
}

/** On only when the Worker var says so: registry/wrangler.jsonc sets it, and any other value turns it off. */
export const tryEnabled = (env: TryEnv) => /^(1|true|on|yes)$/i.test(String(env.TRY_ENABLED ?? ""));

function limits(env: TryEnv): Limits {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(VARS) as (keyof Limits)[]) {
    const v = Number(env[VARS[k]]);
    if (env[VARS[k]] !== undefined && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/** The op's published example args, defaults filled; undefined when a required param has neither. */
export function exampleArgs(op: Operation): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const p of op.params) {
    const v = p.example ?? p.default;
    if (v !== undefined) out[p.name] = v;
    else if (p.required) return undefined;
  }
  return out;
}

const sameSite = (url: string, baseUrl: string) => {
  try {
    return siteOf(new URL(url).hostname.toLowerCase()) === siteOf(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/** Why `served` may not be tried from the catalog, or undefined when it may. `site.operations`: the site's ops, for the shared rules. */
export function tryRefusal(
  site: { name: string; baseUrl: string; operations?: Operation[] },
  served: Pick<ServedOp, "status" | "operation">,
  allow: Readonly<Record<string, readonly string[]>> = TRY_OPS,
): string | undefined {
  const op = served.operation;
  if (!allow[site.name]?.includes(op.name)) return `${site.name} ${op.name} is not one of the operations open to try`;
  if (served.status !== "live") return "only a live operation is tried from the catalog";
  if (!op.readOnly) return "it writes";
  if (op.request.method.toUpperCase() !== "GET") return `it is sent as ${op.request.method}, not GET`;
  if ((op.minTier ?? 1) !== 1) return "it needs a browser";
  if (op.learnedLoggedIn) return "it was learned signed in";
  if (op.slots.some((s) => holdsRef(s) || s.from)) return "it sends a cookie, a session value or a lookup's answer";
  if (op.public?.length) return "it sends a credential-named value";
  const bad = badAddress(op.request.url) ?? badAddress(site.baseUrl);
  if (bad) return `its address ${bad}`;
  if (!sameSite(op.request.url, site.baseUrl)) return "it sends off its own site";
  // the whole site: an op's links name its other ops
  const others = (site.operations ?? []).filter((o) => o.name !== op.name);
  const vetted = vetShared({ name: site.name, baseUrl: site.baseUrl, operations: [op, ...others] });
  if (vetted.errors.length) return `it fails the shared rules: ${vetted.errors[0]}`;
  return undefined;
}

/** The ops of `site` a visitor may try now, with the args the form starts from. */
export function tryable(env: TryEnv, site: ServedSite): { op: Operation; args: Record<string, unknown> }[] {
  if (!tryEnabled(env)) return [];
  const spec = { ...site, operations: site.operations.map((o) => o.operation) };
  return site.operations.flatMap((o) => {
    const args = exampleArgs(o.operation);
    return args && !tryRefusal(spec, o) ? [{ op: o.operation, args }] : [];
  });
}

type TryResult = Pick<CallResult, "ok" | "class" | "data" | "truncated" | "ms" | "reason" | "retryAfterMs"> & {
  tier?: 1;
  via: typeof VIA;
  next: string;
  cached?: true;
};

const shellArg = (s: string) => (/^[\w.,:/@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const argText = (v: unknown) => (typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));

/** How to call it for real; `ran`: the catalog sent the request (or answered from its cache). */
function nextOf(site: string, op?: string, args: Record<string, unknown> = {}, ran = false): string {
  const call = op
    ? ` then \`${["api-anything call", site, op, ...Object.entries(args).map(([k, v]) => shellArg(`${k}=${argText(v)}`))].join(" ")}\``
    : ` then ask your agent for ${site}`;
  const how = `from your own machine and agent: \`npx -y api-anything setup\` (Node 22),${call}.`;
  return ran ? `This ran once on the catalog's server as a demo. To call it ${how}` : `To call ${site} ${how}`;
}

function answer(
  r: Omit<TryResult, "via" | "next">,
  status: number,
  next: string,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify({ ...r, via: VIA, next } satisfies TryResult), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

const refused = (reason: string, status: number, next: string) =>
  answer({ ok: false, class: "refused", reason, ms: 0 }, status, next);

function limited(reason: string, until: number, now: number, status: number, next: string) {
  const retryAfterMs = Math.max(1000, until - now);
  return answer({ ok: false, class: "rate", reason, ms: 0, retryAfterMs }, status, next, {
    "retry-after": String(Math.ceil(retryAfterMs / 1000)),
  });
}

/** The args in the query: one value each, none too long; an empty value is no value. */
function argsOf(url: URL): Record<string, string> | string {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of url.searchParams) {
    if (++n > MAX_ARGS) return `at most ${MAX_ARGS} args`;
    if (k in out) return `the arg ${k} is given twice`;
    if (v.length > MAX_ARG) return `the arg ${k} is over ${MAX_ARG} characters`;
    if (v !== "") out[k] = v;
  }
  return out;
}

interface Upstream {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
  redirected?: boolean;
}

class TooBig extends Error {}

/** One GET of `url`, its redirects followed only on the op's site, the whole exchange under `timeoutMs` and `maxBytes`. */
async function fetchCapped(
  url: string,
  headers: Record<string, string>,
  baseUrl: string,
  l: Limits,
): Promise<Upstream> {
  const signal = AbortSignal.timeout(l.timeoutMs);
  let at = url;
  let redirected = false;
  for (let hop = 0; ; hop++) {
    const res = await fetch(at, { method: "GET", headers, redirect: "manual", signal });
    const location = res.headers.get("location");
    if (REDIRECT.has(res.status) && location) {
      await res.body?.cancel();
      const next = new URL(location, at).href;
      if (hop >= MAX_REDIRECTS || badAddress(next) || !sameSite(next, baseUrl))
        throw new Error(`the site redirected to ${new URL(next).origin}, which the catalog does not follow`);
      at = next;
      redirected = true;
      continue;
    }
    if (Number(res.headers.get("content-length") ?? 0) > l.maxBytes) {
      await res.body?.cancel();
      throw new TooBig();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    for (;;) {
      if (!reader) break;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > l.maxBytes) {
        await reader.cancel();
        throw new TooBig();
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(size);
    let i = 0;
    for (const c of chunks) {
      buf.set(c, i);
      i += c.byteLength;
    }
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: decodeBody(buf, res.headers.get("content-type") ?? ""),
      url: at,
      ...(redirected ? { redirected } : {}),
    };
  }
}

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
// absent outside Workers, and a no-op on a workers.dev host: the limits hold without it
const edgeCache = () => (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;

export interface TryCtx {
  env: TryEnv;
  request: Request;
  url: URL;
  now: number;
  /** "site/op" from the path */
  param: string;
}

export async function tryApi(c: TryCtx): Promise<Response> {
  const [siteName = "", opName = ""] = c.param.split("/");
  const general = nextOf(siteName);
  if (!tryEnabled(c.env)) return refused("trying operations from the catalog is switched off", 503, general);
  const allowed = TRY_OPS[siteName]?.includes(opName);
  if (!allowed) return refused(`${siteName} ${opName} is not one of the operations open to try`, 404, general);
  const l = limits(c.env);
  const db = c.env.DB;

  // every try counts against its network, a cached one too; only a send counts against the day's total
  if (!c.env.SALT) return refused("the registry has no SALT set", 500, general);
  const { prefix } = await networksOf(c.request, c.env.SALT);
  const hour = Math.floor(c.now / HOUR);
  const minute = Math.floor(c.now / MINUTE);
  const dayHour = Math.floor(c.now / DAY) * 24;
  const nextDay = (Math.floor(c.now / DAY) + 1) * DAY;
  if ((await count(db, `net:${prefix}`, `try:m${minute % 60}`, hour, 1)) > l.perMinute)
    return limited(`over ${l.perMinute} tries a minute from this network`, (minute + 1) * MINUTE, c.now, 429, general);
  if ((await count(db, `net:${prefix}`, "try:day", dayHour, 1)) > l.perDay)
    return limited(`over ${l.perDay} tries a day from this network`, nextDay, c.now, 429, general);

  const [site] = await catalog(db, undefined, siteName);
  const served = site?.operations.find((o) => o.operation.name === opName);
  if (!site || !served) return refused(`the catalog serves no ${siteName} ${opName}`, 404, general);
  const why = tryRefusal({ ...site, operations: site.operations.map((o) => o.operation) }, served);
  if (why) return refused(`${siteName} ${opName} is not tried from the catalog: ${why}`, 403, general);
  const op = served.operation;

  const given = argsOf(c.url);
  const input = (reason: string) => answer({ ok: false, class: "input", reason, ms: 0 }, 400, nextOf(siteName, opName));
  if (typeof given === "string") return input(given);
  const args = Object.keys(given).length ? given : (exampleArgs(op) ?? {});
  const unknown = unknownArgs(op, args);
  if (unknown) return input(unknown);
  let req: ReturnType<typeof buildRequest>;
  try {
    req = buildRequest(op, args, { cookies: [], values: {} });
  } catch (e) {
    return input((e as Error).message);
  }
  if (req.method !== "GET" || badAddress(req.url) || !sameSite(req.url, site.baseUrl))
    return refused("the filled request leaves the op's site", 403, nextOf(siteName, opName, args));
  const next = nextOf(siteName, opName, args, true);

  const cache = edgeCache();
  const key = new Request(
    `${c.url.origin}/v1/try/${siteName}/${opName}?v=${served.hash ?? ""}&u=${encodeURIComponent(req.url)}`,
  );
  const hit = await cache?.match(key);
  if (hit) {
    const held = (await hit.json()) as TryResult;
    return answer({ ...held, cached: true }, 200, next);
  }

  if ((await count(db, "all", "try:day", dayHour, 1)) > l.allPerDay)
    return limited(
      `the catalog runs at most ${l.allPerDay} tries a day; try tomorrow`,
      nextDay,
      c.now,
      503,
      nextOf(siteName, opName, args),
    );

  // only the op's own literal headers: nothing of the visitor's request, and no cookie
  const { cookie: _c, host: _h, "content-length": _l, ...headers } = req.headers;
  const t0 = Date.now();
  let up: Upstream;
  try {
    up = await fetchCapped(req.url, headers, site.baseUrl, l);
  } catch (e) {
    const ms = Date.now() - t0;
    if (e instanceof TooBig)
      return answer(
        { ok: false, class: "error", reason: `the site's answer is over ${l.maxBytes} bytes`, ms, tier: 1 },
        502,
        next,
      );
    const timeout = ["TimeoutError", "AbortError"].includes((e as Error).name);
    return answer(
      {
        ok: false,
        class: "error",
        reason: timeout ? `no answer from the site within ${l.timeoutMs} ms` : (e as Error).message,
        ms,
        tier: 1,
      },
      timeout ? 504 : 502,
      next,
    );
  }
  const ms = Date.now() - t0;
  const j = judge(op, up);
  const capped = j.data !== undefined ? capOutput(j.data) : undefined;
  const result: Omit<TryResult, "via" | "next"> = {
    ok: j.class === "ok",
    class: j.class,
    ...(capped ? { data: capped.data, ...(capped.truncated ? { truncated: capped.truncated } : {}) } : {}),
    tier: 1,
    ms,
    ...(j.class !== "ok" ? { reason: j.reason } : {}),
    ...(j.retryAfterMs !== undefined ? { retryAfterMs: j.retryAfterMs } : {}),
  };
  if (result.ok && cache)
    await cache.put(
      key,
      new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${l.cacheSeconds}` },
      }),
    );
  return answer(result, 200, next);
}
