/** The registry Worker: the HTTP surface of src/registry-api.ts, the pages, and the daily archive. */
import { z } from "zod";
import { siteOf } from "../../src/domain.js";
import {
  anonymous,
  type ClaimResult,
  canonical,
  fingerprintText,
  MAX_SEARCH_QUERY,
  nameHashText,
  type Report,
  type SearchMatch,
  type Status,
  type UploadResult,
  type VerifyJob,
} from "../../src/registry-api.js";
import { domainOf } from "../../src/search.js";
import type { Operation } from "../../src/spec.js";
import { badAddress, uploadProblems } from "../../src/vet.js";
import { networksOf, sha256Hex, signatureHeaders, signer } from "./auth.js";
import { catalog, confirmed, entryOf, search } from "./catalog.js";
import { CSP, homePage, sitemap, sitePage } from "./pages.js";
import { nextStatus, type Thresholds, thresholds, toArchive } from "./rules.js";
import { community, countCalls, forgetCalls, publicStats } from "./stats.js";
import {
  addSite,
  addVersion,
  archive,
  archiveCandidates,
  archiveOldSeeds,
  claimsOf,
  count,
  type D1Database,
  demandFor,
  demandList,
  facts,
  failedOn,
  forgetDemand,
  getKey,
  getSite,
  getVersion,
  holders,
  incumbentSig,
  interfacesOf,
  markPending,
  pendingVersions,
  putClaim,
  putReport,
  putStats,
  recountAll,
  reportInterface,
  reseed,
  seedSite,
  setStatus,
  siteOps,
  sitesOn,
  touchKey,
  touchOk,
  unverified,
  type VersionRow,
  versionsIn,
  wantDomain,
  wantedClaims,
} from "./store.js";
import { exampleArgs, tryApi, tryable } from "./try.js";
import {
  HASH,
  matchSig,
  nameRefusal,
  parseOperation,
  readUpload,
  refusals,
  reviewReasons,
  SiteContextSchema,
  type Upload,
  versionHash,
} from "./upload.js";
import { cleanDomain, WANTED_INDEX_NETWORKS, wantedPage } from "./wanted.js";

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  SALT?: string;
  /** thresholds (rules.ts), e.g. PROMOTE_KEYS */
  [threshold: string]: unknown;
}

const DAY = 86_400_000;
/** registry/wrangler.jsonc's cron for the pending recounts; the other cron is the daily job */
const EVERY_MINUTE = "* * * * *";
const HOUR = 3_600_000;
const MAX_BODY = 256 * 1024;
const MAX_SEED = 1024 * 1024;
const MAX_REPORTS = 50;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reasons?: string[],
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "public, max-age=60",
    },
  });

interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  now: number;
  t: Thresholds;
  body: Uint8Array<ArrayBuffer>;
}

/** The body, read as a stream that stops at `max`: a declared length or a stream past it is a 413. */
async function readBody(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return new Uint8Array();
  const tooBig = () => new HttpError(413, `the body is over ${max / 1024} KB`);
  if (Number(request.headers.get("content-length") ?? 0) > max) throw tooBig();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return body;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);

/** The key that signed the request; `required` refuses an unsigned one. A bad signature is always refused. */
async function keyOf(c: Ctx, required: true): Promise<string>;
async function keyOf(c: Ctx, required: false): Promise<string | undefined>;
async function keyOf(c: Ctx, required: boolean): Promise<string | undefined> {
  const s = await signer(c.request, c.body, c.now);
  if (s && "error" in s) throw new HttpError(401, s.error);
  if (!s && required) throw new HttpError(401, "this endpoint takes a signed request (x-aa-key, x-aa-ts, x-aa-sig)");
  return s?.key;
}

function salt(c: Ctx): string {
  if (!c.env.SALT) throw new HttpError(500, "the registry has no SALT set");
  return c.env.SALT;
}

const tooMany = (message: string, until: number, now: number) =>
  new HttpError(429, message, undefined, { "retry-after": String(Math.max(1, Math.ceil((until - now) / 1000))) });

/**
 * Counts `n` against the key's and the network's hourly budget for `kind`, and an upload against every
 * key's together (the circuit breaker); past any, a 429. The breaker counts only what passed the others,
 * so one refused key cannot spend everyone's budget.
 */
async function spend(c: Ctx, kind: "upload" | "report", key: string, prefix: string, n: number) {
  const max = kind === "upload" ? c.t.uploadsPerHour : c.t.reportsPerHour;
  const hour = Math.floor(c.now / HOUR);
  const next = (hour + 1) * HOUR;
  const byKey = await count(c.env.DB, `key:${key}`, kind, hour, n);
  const byNet = await count(c.env.DB, `net:${prefix}`, kind, hour, n);
  if (byKey > max || byNet > max) throw tooMany(`over ${max} ${kind}s an hour`, next, c.now);
  if (kind === "upload" && (await count(c.env.DB, "all", kind, hour, n)) > c.t.uploadsPerHourAll)
    throw tooMany(`the registry takes at most ${c.t.uploadsPerHourAll} uploads an hour; try later`, next, c.now);
}

/** A key first seen less than an hour ago uploads at most `newKeyUploads` versions. */
async function newKeyLimit(c: Ctx, key: string) {
  const row = await getKey(c.env.DB, key);
  const seen = row ? Date.parse(row.first_seen) : c.now;
  if (c.now - seen < HOUR && (row?.uploads ?? 0) >= c.t.newKeyUploads)
    throw tooMany(`a key new this hour uploads at most ${c.t.newKeyUploads} versions`, seen + HOUR, c.now);
}

const recompute = (c: Ctx, v: VersionRow) => judge(c.env.DB, c.t, c.now, v);

/**
 * Applies what the version's reports now say to its status, and keeps their counts beside it. Counting
 * reads every report of the version, so one that many installs report is recounted at most every
 * `statsSeconds`, otherwise each report would cost as many reads as the version has installs. A report
 * in between marks it pending, and the job every minute recounts it (`force`), so no status change
 * waits on another report coming.
 */
async function judge(db: D1Database, t: Thresholds, at: number, v: VersionRow, force = false): Promise<Status> {
  const counted = v.stats_at ? Date.parse(v.stats_at) : 0;
  if (!force && v.reporters >= t.statsLiveUpTo && at - counted < t.statsSeconds * 1000) {
    if (!v.pending) await markPending(db, v.hash, true);
    return v.status;
  }
  // cleared before counting: a report held back while this counts marks it again
  if (v.pending) await markPending(db, v.hash, false);
  const since = new Date(at - t.recentDays * DAY).toISOString();
  const weekAgo = new Date(at - 7 * DAY).toISOString();
  const now = new Date(at).toISOString();
  const f = await facts(db, v, since, t.degradeWindow, weekAgo);
  await putStats(db, v.hash, f.stats, now);
  const status = nextStatus(v.status, f, t);
  if (status !== v.status) await setStatus(db, v.hash, status, now);
  return status;
}

/* ------------------------------------------------------------------ reads */

async function searchApi(c: Ctx) {
  const q = c.url.searchParams.get("q")?.trim();
  if (!q) throw new HttpError(400, "search takes q: words, a domain or a URL");
  if (q.length > MAX_SEARCH_QUERY) throw new HttpError(400, `q is longer than ${MAX_SEARCH_QUERY} characters`);
  const limit = Math.min(Math.max(Number(c.url.searchParams.get("limit")) || 5, 1), 20);
  const sites = await catalog(c.env.DB, await keyOf(c, false));
  const matches = await withInterfaces(c, search(sites, q, limit));
  const asked = domainOf(q);
  // a site with only its own agent interface is found by its domain
  if (!matches.length && asked) {
    const own = (await interfacesOf(c.env.DB, [asked], interfaceKeys(c))).get(asked);
    if (own)
      matches.push({
        name: asked.replace(/\./g, "-"),
        domain: asked,
        displayName: asked,
        operations: [],
        interfaces: own,
      });
  }
  // a site agents want and nobody shared: its domain, never the words of a search
  const domain = matches.length ? undefined : asked;
  if (domain) {
    const { network } = await networksOf(c.request, salt(c));
    await wantDomain(c.env.DB, domain, network, new Date(c.now).toISOString());
    // not cached: the next network asking for it is counted too
    return json({ matches }, 200, { "cache-control": "no-store" });
  }
  return json({ matches });
}

const DEMAND_DAYS = 30;

const demandSince = (c: Ctx) => new Date(c.now - DEMAND_DAYS * DAY).toISOString();

async function demandApi(c: Ctx) {
  return json({ demand: await demandList(c.env.DB, demandSince(c), 50) });
}

/** Aggregate counts only: no key, no network hash. */
async function statsApi(c: Ctx) {
  return json(await publicStats(c.env.DB, await catalog(c.env.DB), c.now, demandSince(c)));
}

async function siteApi(c: Ctx, name: string) {
  const [site] = await catalog(c.env.DB, await keyOf(c, false), name);
  if (!site) throw new HttpError(404, `no shared site ${name}`);
  const own = (await interfacesOf(c.env.DB, [site.domain], interfaceKeys(c))).get(site.domain);
  return json(own ? { ...site, interfaces: own } : site);
}

/** Installs, one per network, that must report an interface before it is served: as many as promote a version. */
const interfaceKeys = (c: Ctx) => Math.max(c.t.promoteKeys, c.t.promoteNetworks);

async function withInterfaces(c: Ctx, matches: SearchMatch[]): Promise<SearchMatch[]> {
  const byDomain = await interfacesOf(c.env.DB, [...new Set(matches.map((m) => m.domain))], interfaceKeys(c));
  return matches.map((m) => (byDomain.get(m.domain) ? { ...m, interfaces: byDomain.get(m.domain) } : m));
}

const InterfaceSchema = z.object({
  kind: z.enum(["mcp", "openapi"]),
  url: z.string().max(2000),
});

/** An install says a site offers its own agent interface. It must be https on a public host; it is keyed by its registrable domain. */
async function addInterface(c: Ctx) {
  const key = await keyOf(c, true);
  const r = InterfaceSchema.safeParse(parseJson(c.body));
  if (!r.success) throw new HttpError(400, "the body is { kind: mcp | openapi, url }", issues(r.error));
  const bad = badAddress(r.data.url);
  if (bad) throw new HttpError(422, "the interface is refused", [`its url ${bad}`]);
  const { network, prefix } = await networksOf(c.request, salt(c));
  await spend(c, "upload", key, prefix, 1);
  const domain = siteOf(new URL(r.data.url).hostname);
  await reportInterface(c.env.DB, { ...r.data, domain, key, network }, new Date(c.now).toISOString());
  const served = (await interfacesOf(c.env.DB, [domain], interfaceKeys(c))).get(domain) ?? [];
  return json({ domain, served: served.some((i) => i.url === r.data.url) });
}

async function indexApi(c: Ctx) {
  const sites = await catalog(c.env.DB, await keyOf(c, false));
  return json({ generated: new Date(c.now).toISOString(), sites: sites.filter(confirmed).map(entryOf) });
}

async function verifyJobs(c: Ctx) {
  const key = await keyOf(c, true);
  const limit = Math.min(Math.max(Number(c.url.searchParams.get("limit")) || 5, 1), 20);
  // a candidate with no examples cannot be checked, so look past it
  const rows = await unverified(c.env.DB, key, limit * 5);
  const jobs: VerifyJob[] = rows
    .flatMap((r) => {
      const operation = JSON.parse(r.operation) as Operation;
      const args = exampleArgs(operation);
      return args ? [{ hash: r.hash, site: r.site, op: r.op_name, args, operation, baseUrl: r.base_url }] : [];
    })
    .slice(0, limit);
  return json({ jobs });
}

/* ------------------------------------------------------------------ writes */

/**
 * Whether an upload claiming `healedFrom` is a heal, promoted by fewer installs: only of a version of the
 * same op that is degraded, or live and failing for this very key in the last week. Otherwise anyone could
 * name a live hash and take its op over.
 */
async function isHeal(c: Ctx, healedFrom: string | undefined, site: string, op: string, key: string) {
  const from = healedFrom ? await getVersion(c.env.DB, healedFrom) : null;
  if (!from || from.site !== site || from.op_name !== op) return false;
  if (from.status === "degraded") return true;
  return from.status === "live" && failedOn(c.env.DB, from.hash, key, new Date(c.now - 7 * DAY).toISOString());
}

async function upload(c: Ctx) {
  const key = await keyOf(c, true);
  const { network, prefix } = await networksOf(c.request, salt(c));
  await newKeyLimit(c, key);
  await spend(c, "upload", key, prefix, 1);
  const now = new Date(c.now).toISOString();
  await touchKey(c.env.DB, key, now, 1, 0);
  const u = await readUpload(parseJson(c.body));
  if ("errors" in u) throw new HttpError(422, "the version is refused", u.errors);
  const db = c.env.DB;
  const bound = await getSite(db, u.site.name);
  if (bound && bound.domain !== u.site.domain)
    throw new HttpError(409, "the version is refused", [`the name ${u.site.name} is bound to ${bound.domain}`]);
  const squat = bound ? undefined : nameRefusal(u.site.name, u.site.domain);
  if (squat) throw new HttpError(422, "the version is refused", [squat]);
  const claimed = u.claim ? await answersClaim(c, u, key) : undefined;
  if (claimed) {
    u.operation = claimed.operation;
    u.hash = await versionHash(u.site.name, u.operation);
    // the site's words are one person's too
    u.site = { name: u.site.name, domain: u.site.domain, baseUrl: u.site.baseUrl };
  }

  const held = await getVersion(db, u.hash);
  if (held) {
    // the same version again: its uploader's confirmation
    await db.batch([
      putReport(db, { hash: u.hash, key, network, outcome: "ok", at: now }),
      touchOk(db, u.hash, key, now),
    ]);
    const status = await recompute(c, held);
    const reasons = held.reasons ? (JSON.parse(held.reasons) as string[]) : undefined;
    return json({ hash: u.hash, status, duplicate: true, ...(reasons ? { reasons } : {}) } satisfies UploadResult);
  }

  const ops = await siteOps(db, u.site.name, u.site.domain);
  const loginCookies = bound?.login_cookies ? (JSON.parse(bound.login_cookies) as string[]).length > 0 : false;
  const incumbent = await incumbentSig(db, u.site.name, u.operation.name);
  const reasons = reviewReasons(u.site, u.operation, u.evidence, {
    opNames: ops.opNames,
    login: loginCookies || ops.loginOp,
    established: ops.established,
    ...(incumbent ? { incumbentSig: incumbent } : {}),
  });
  const heal = await isHeal(c, u.evidence.healedFrom, u.site.name, u.operation.name, key);
  if (claimed) reasons.push(claimed.reason);
  const status: Status = reasons.length ? "review" : "candidate";
  // an uploaded title could claim any brand: a site nobody seeded is titled by its domain
  await addSite(db, { ...u.site, displayName: u.site.domain }, key, now);
  await addVersion(
    db,
    {
      hash: u.hash,
      site: u.site.name,
      operation: u.operation,
      sig: matchSig(u.operation),
      ...(u.parent ? { parent: u.parent } : {}),
      heal,
      status,
      reasons,
      uploader: key,
      uploaderNetwork: network,
      evidence: u.evidence,
      ...(u.claim ? { claim: u.claim } : {}),
    },
    now,
  );
  return json(
    { hash: u.hash, status, duplicate: false, ...(reasons.length ? { reasons } : {}) } satisfies UploadResult,
    201,
  );
}

/**
 * An upload that answers a claim: allowed only from an install that claimed the fingerprint, once
 * `claimKeys` installs on as many networks did, with the op in its anonymous form hashing to it. The
 * op keeps its name only if as many of them gave it that name; otherwise it is named by its fingerprint.
 */
async function answersClaim(c: Ctx, u: Upload, key: string): Promise<{ operation: Operation; reason: string }> {
  const fingerprint = u.claim!;
  const refuse = (why: string) => new HttpError(422, "the version is refused", [why]);
  const rows = (await claimsOf(c.env.DB, fingerprint)).filter((r) => r.site === u.site.name);
  if (!rows.some((r) => r.key === key)) throw refuse("this install did not claim that fingerprint");
  const n = holders(rows);
  if (n < c.t.claimKeys) throw refuse(`fewer than ${c.t.claimKeys} installs on distinct networks claimed it`);
  const op = anonymous(u.operation);
  if (canonical(op) !== canonical(u.operation)) throw refuse("an op answering a claim is sent in its anonymous form");
  if ((await sha256Hex(fingerprintText(u.site.name, op))) !== fingerprint)
    throw refuse("the op does not hash to the claimed fingerprint");
  const nameHash = await sha256Hex(nameHashText(op.name));
  const named = holders(rows.filter((r) => r.name_hash === nameHash)) >= c.t.claimKeys;
  return {
    operation: named ? op : { ...op, name: `op_${fingerprint.slice(0, 8)}` },
    reason: `learned signed in; ${n} installs on distinct networks hold this exact op`,
  };
}

const ClaimSchema = z.object({
  site: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), domain: z.string().max(253) }),
  fingerprint: HASH,
  nameHash: HASH,
});

async function claims(c: Ctx) {
  const key = await keyOf(c, true);
  if (c.request.method === "POST") {
    const r = ClaimSchema.safeParse(parseJson(c.body));
    if (!r.success) throw new HttpError(400, "the body is a Claim", issues(r.error));
    const { network, prefix } = await networksOf(c.request, salt(c));
    await spend(c, "upload", key, prefix, 1);
    const bound = await getSite(c.env.DB, r.data.site.name);
    if (bound && bound.domain !== r.data.site.domain)
      throw new HttpError(409, "the claim is refused", [`the name ${r.data.site.name} is bound to ${bound.domain}`]);
    const squat = bound ? undefined : nameRefusal(r.data.site.name, r.data.site.domain);
    if (squat) throw new HttpError(422, "the claim is refused", [squat]);
    await putClaim(
      c.env.DB,
      { fingerprint: r.data.fingerprint, site: r.data.site.name, key, network, name_hash: r.data.nameHash },
      new Date(c.now).toISOString(),
    );
  }
  return json({ wanted: await wantedClaims(c.env.DB, key, c.t.claimKeys) } satisfies ClaimResult);
}

const ReportSchema = z.object({
  hash: HASH,
  outcome: z.enum(["ok", "fail", "wrong", "auth", "blocked", "rate", "input", "error"]),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  ms: z.number().int().min(0).max(3_600_000).optional(),
});

async function reports(c: Ctx) {
  const key = await keyOf(c, true);
  const raw = parseJson(c.body);
  const list = z
    .array(ReportSchema)
    .max(MAX_REPORTS)
    .safeParse(Array.isArray(raw) ? raw : (raw as { reports?: unknown } | null)?.reports);
  if (!list.success)
    throw new HttpError(400, `the body is { reports: Report[] }, at most ${MAX_REPORTS}`, issues(list.error));
  const { network, prefix } = await networksOf(c.request, salt(c));
  await spend(c, "report", key, prefix, list.data.length);
  const db = c.env.DB;
  const now = new Date(c.now).toISOString();
  const versions = new Map((await versionsIn(db, [...new Set(list.data.map((r) => r.hash))])).map((v) => [v.hash, v]));
  const known: Report[] = list.data.filter((r) => versions.has(r.hash));
  if (known.length)
    await db.batch([
      ...known.flatMap((r) => [
        putReport(db, { ...r, key, network, at: now }),
        ...(r.outcome === "ok" ? [touchOk(db, r.hash, key, now)] : []),
      ]),
      ...countCalls(
        db,
        c.now,
        known.map((r) => r.outcome),
      ),
    ]);
  for (const v of versions.values()) await recompute(c, v);
  await touchKey(db, key, now, 0, known.length);
  return json({ accepted: known.length, ignored: list.data.length - known.length });
}

/* ------------------------------------------------------------------ admin */

async function admin(request: Request, env: Env) {
  const token = env.ADMIN_TOKEN;
  const given = request.headers.get("authorization") ?? "";
  // compared as digests, so the time taken says nothing about the token
  if (!token || (await sha256Hex(given)) !== (await sha256Hex(`Bearer ${token}`)))
    throw new HttpError(403, "this endpoint takes the maintainer's token");
}

const STATUSES = ["candidate", "live", "degraded", "review", "archived", "blocked"] as const;

async function adminVersion(c: Ctx, hash: string) {
  const r = z.object({ status: z.enum(STATUSES) }).safeParse(parseJson(c.body));
  if (!r.success) throw new HttpError(400, `the body is { status: ${STATUSES.join(" | ")} }`, issues(r.error));
  if (!(await getVersion(c.env.DB, hash))) throw new HttpError(404, `no version ${hash}`);
  await setStatus(c.env.DB, hash, r.data.status, new Date(c.now).toISOString());
  return json({ hash, status: r.data.status });
}

async function adminSeed(c: Ctx) {
  const r = z.object({ site: SiteContextSchema, operations: z.array(z.unknown()).min(1) }).safeParse(parseJson(c.body));
  if (!r.success)
    throw new HttpError(400, "the body is { site: SiteContext, operations: Operation[] }", issues(r.error));
  const site = r.data.site;
  const ops: Operation[] = [];
  for (const raw of r.data.operations) {
    const p = parseOperation(raw);
    if ("errors" in p) throw new HttpError(422, "the seed is refused", p.errors);
    ops.push(p.op);
  }
  // a seeded write is held to an upload's rule: its proof is inside its version, never a name
  const refused = [...ops.flatMap(uploadProblems), ...refusals(site, ops)];
  if (refused.length) throw new HttpError(422, "the seed is refused", refused);
  const db = c.env.DB;
  const now = new Date(c.now).toISOString();
  await seedSite(db, site, now);
  const out: { name: string; hash: string; status: Status }[] = [];
  for (const op of ops) {
    const hash = await versionHash(site.name, op);
    const held = await getVersion(db, hash);
    if (held) await reseed(db, hash, now);
    else
      await addVersion(
        db,
        {
          hash,
          site: site.name,
          operation: op,
          sig: matchSig(op),
          heal: false,
          status: "live",
          reasons: [],
          uploader: "seed",
          evidence: { clientVersion: "seed", learnedLoggedIn: op.learnedLoggedIn, cleanReplay: "skipped" },
        },
        now,
      );
    out.push({ name: op.name, hash, status: held?.status === "blocked" ? "blocked" : "live" });
  }
  await archiveOldSeeds(
    db,
    site.name,
    out.map((o) => o.hash),
    now,
  );
  return json({ site: site.name, operations: out });
}

/* ------------------------------------------------------------------ pages */

async function home(c: Ctx) {
  const sites = await catalog(c.env.DB);
  const q = c.url.searchParams.get("q")?.trim();
  // a site nobody but its uploader vouched for may say it is any brand: it is reached by name or domain only
  if (!q) {
    const demand = (await demandList(c.env.DB, demandSince(c), 10)).filter((d) => cleanDomain(d.domain));
    // the strip is only shown when its counts are; the page never fails for it
    const by = await community(c.env.DB).catch(() => undefined);
    const stats = by && (await publicStats(c.env.DB, sites, c.now, demandSince(c), by).catch(() => undefined));
    return html(
      homePage(sites.filter(confirmed), c.url.origin, undefined, demand, {
        ...(stats ? { stats } : {}),
        ...(by ? { community: by.sites } : {}),
      }),
    );
  }
  const byName = new Map(sites.map((s) => [s.name, s]));
  const found = search(sites, q, 20).map((m) => byName.get(m.name)!);
  return html(homePage(found, c.url.origin, q));
}

async function landing(c: Ctx, name: string) {
  const [site] = await catalog(c.env.DB, undefined, name);
  if (!site) return html(homePage([], c.url.origin, name), 404);
  const by = await community(c.env.DB, name);
  return html(
    sitePage(
      site,
      c.url.origin,
      {
        byInstall: by.sites.has(name),
        opsByInstalls: site.operations.filter((o) => by.hashes.has(o.hash)).length,
      },
      tryable(c.env, site),
    ),
  );
}

/**
 * A domain agents asked for that no site covers. Only a clean registrable domain still in demand has a
 * page: anything else is a 404, so no input makes a page. Once a site covers it, its page takes over.
 */
async function wanted(c: Ctx, domain: string) {
  if (!cleanDomain(domain)) throw new HttpError(404, "no wanted page for that domain");
  for (const name of await sitesOn(c.env.DB, domain))
    if ((await catalog(c.env.DB, undefined, name)).length)
      return new Response(null, { status: 301, headers: { location: `/sites/${encodeURIComponent(name)}` } });
  const networks = await demandFor(c.env.DB, domain, demandSince(c));
  if (!networks) throw new HttpError(404, "no wanted page for that domain");
  return html(wantedPage({ domain, networks }, c.url.origin, DEMAND_DAYS));
}

async function sitemapXml(c: Ctx) {
  const sites = await catalog(c.env.DB);
  const demand = await demandList(c.env.DB, demandSince(c), 50);
  return new Response(
    sitemap(
      sites.filter(confirmed).map((s) => s.name),
      c.url.origin,
      demand.filter((d) => d.networks >= WANTED_INDEX_NETWORKS && cleanDomain(d.domain)).map((d) => d.domain),
    ),
    { headers: { "content-type": "application/xml; charset=utf-8" } },
  );
}

/* ------------------------------------------------------------------ routing */

type Handler = (c: Ctx, param: string) => Promise<Response>;
/** What a route takes before its body is read: a signature, the maintainer's token, or nothing. */
type Auth = "signed" | "admin" | undefined;
const NAME = "([a-z0-9][a-z0-9._-]{0,63})";
/** the shape of a wanted page's domain; the handler checks it is a clean registrable domain */
const DOMAIN = "([a-z0-9][a-z0-9.-]{0,252})";
const ROUTES: [method: string, path: RegExp, handler: Handler, auth?: Auth, maxBody?: number][] = [
  ["GET", /^\/v1\/search$/, searchApi],
  ["GET", new RegExp(`^/v1/sites/${NAME}$`), siteApi],
  ["GET", /^\/v1\/index$/, indexApi],
  ["GET", /^\/v1\/demand$/, demandApi],
  ["GET", /^\/v1\/stats$/, statsApi],
  [
    "GET",
    new RegExp(`^/v1/try/(${NAME.slice(1, -1)}/[A-Za-z][\\w.-]{0,63})$`),
    (c, param) => tryApi({ env: c.env, request: c.request, url: c.url, now: c.now, param }),
  ],
  ["GET", /^\/v1\/verify-jobs$/, verifyJobs, "signed"],
  ["POST", /^\/v1\/versions$/, upload, "signed"],
  ["POST", /^\/v1\/reports$/, reports, "signed"],
  ["POST", /^\/v1\/claims$/, claims, "signed"],
  ["POST", /^\/v1\/interfaces$/, addInterface, "signed"],
  ["GET", /^\/v1\/claims$/, claims, "signed"],
  ["POST", /^\/v1\/admin\/versions\/([0-9a-f]{64})$/, adminVersion, "admin"],
  ["POST", /^\/v1\/admin\/seed$/, adminSeed, "admin", MAX_SEED],
  ["GET", /^\/$/, home],
  ["GET", new RegExp(`^/sites/${NAME}/?$`), landing],
  ["GET", new RegExp(`^/wanted/${DOMAIN}/?$`), wanted],
  ["GET", /^\/sitemap\.xml$/, sitemapXml],
];

async function route(request: Request, env: Env, now: number): Promise<Response> {
  const url = new URL(request.url);
  const matches = ROUTES.flatMap(([method, re, handler, auth, max]) => {
    const m = re.exec(url.pathname);
    return m ? [{ method, handler, auth, max, param: m[1] ?? "" }] : [];
  });
  if (!matches.length) throw new HttpError(404, `no route ${url.pathname}`);
  // a HEAD is answered as its GET; the runtime drops the body
  const hit = matches.find((m) => m.method === (request.method === "HEAD" ? "GET" : request.method));
  if (!hit) throw new HttpError(405, `${url.pathname} takes ${matches.map((m) => m.method).join(", ")}`);
  // refused before a byte of the body is read
  const sig = signatureHeaders(request.headers, now);
  if (sig && "error" in sig) throw new HttpError(401, sig.error);
  if (hit.auth === "signed" && !sig)
    throw new HttpError(401, "this endpoint takes a signed request (x-aa-key, x-aa-ts, x-aa-sig)");
  if (hit.auth === "admin") await admin(request, env);
  const t = thresholds(env);
  const body = await readBody(request, hit.max ?? MAX_BODY);
  return hit.handler({ request, env, url, now, t, body }, hit.param);
}

/** The Workers Cache API's default cache, absent outside Workers (tests may stand one in). */
interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
const edgeCache = () => (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;

/** Public reads, the same for every unsigned caller: cached 60 s by URL. */
const CACHED = new RegExp(
  `^/(v1/search|v1/sites/${NAME}|v1/index|v1/demand|v1/stats|sites/${NAME}/?|wanted/${DOMAIN}/?|sitemap\\.xml)?$`,
);
const CACHE_SECONDS = 60;

function cacheable(request: Request): boolean {
  if (request.method !== "GET") return false;
  // a signed read may hold the signer's own review versions
  if (["x-aa-key", "x-aa-ts", "x-aa-sig"].some((h) => request.headers.has(h))) return false;
  return CACHED.test(new URL(request.url).pathname);
}

async function answer(request: Request, env: Env): Promise<Response> {
  try {
    return await route(request, env, Date.now());
  } catch (e) {
    if (e instanceof HttpError)
      return json({ error: e.message, ...(e.reasons ? { reasons: e.reasons } : {}) }, e.status, e.headers);
    console.error(e);
    return json({ error: "the registry failed on this request" }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const cache = cacheable(request) ? edgeCache() : undefined;
    const key = new Request(request.url, { method: "GET" });
    const hit = await cache?.match(key);
    if (hit) return hit;
    const res = await answer(request, env);
    if (!cache || res.status !== 200 || res.headers.get("cache-control") === "no-store") return res;
    res.headers.set("cache-control", `public, max-age=${CACHE_SECONDS}`);
    const put = cache.put(key, res.clone());
    if (ctx) ctx.waitUntil(put);
    else await put;
    return res;
  },

  /**
   * Every minute: recount the versions whose recount a report found held back. Daily: archive stale
   * candidates and degraded versions, and degraded versions a newer live one replaced; delete what was
   * archived over 30 days ago, with its reports; recount every version as reports age out.
   */
  async scheduled(controller: { scheduledTime: number; cron?: string }, env: Env): Promise<void> {
    const now = controller.scheduledTime;
    const t = thresholds(env);
    if (controller.cron === EVERY_MINUTE) {
      for (const v of await pendingVersions(env.DB)) await judge(env.DB, t, now, v, true);
      return;
    }
    const cutoff = new Date(now - t.recentDays * DAY).toISOString();
    const gone = toArchive(await archiveCandidates(env.DB), cutoff);
    await archive(
      env.DB,
      gone.map((v) => v.hash),
      new Date(now).toISOString(),
      Math.floor(now / HOUR),
      new Date(now - 30 * DAY).toISOString(),
    );
    await forgetDemand(env.DB, new Date(now - 90 * DAY).toISOString());
    await forgetCalls(env.DB, now - 90 * DAY);
    await recountAll(env.DB, cutoff, new Date(now).toISOString());
    console.log(`archived ${gone.length} versions`);
  },
};
