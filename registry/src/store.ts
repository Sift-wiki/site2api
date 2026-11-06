/** The registry's SQL over D1. Only the D1 surface below is used, so a test can stand in for it (test/d1.ts). */
import type { Evidence, Outcome, SiteContext, Status } from "../../src/registry-api.js";
import type { Operation } from "../../src/spec.js";
import { ABOUT_OP, type Archivable, type Facts, SERVED } from "./rules.js";

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

export interface SiteRow {
  name: string;
  domain: string;
  base_url: string;
  display_name: string | null;
  description: string | null;
  login_cookies: string | null;
  /** the site's budget as JSON (SiteContext.pace) */
  pace: string | null;
  notes: string | null;
  first_uploader: string;
}

export interface VersionRow {
  hash: string;
  site: string;
  op_name: string;
  sig: string;
  operation: string;
  status: Status;
  reasons: string | null;
  uploader: string;
  heal: number;
  created_at: string;
  last_ok_at: string | null;
  /** when it first became live: the incumbent of an op is the live version with the earliest */
  live_since: string | null;
  /** the uploader's network hash, as reports store it */
  uploader_network: string | null;
  /** what its recent reports said when last counted (`Stats`), so serving reads no reports */
  confirmations: number;
  oks: number;
  bad: number;
  reporters: number;
  stats_at: string | null;
  /** 1 while a report waits for a recount that was held back */
  pending: number;
}

/** A version's recent reports, counted: each install once, by its latest outcome. */
export interface Stats {
  /** installs other than the uploader whose outcome is ok */
  confirmations: number;
  oks: number;
  /** fail or wrong */
  bad: number;
  /** every install that reported it */
  reporters: number;
}

export const context = (r: SiteRow): SiteContext => ({
  name: r.name,
  domain: r.domain,
  baseUrl: r.base_url,
  ...(r.display_name ? { displayName: r.display_name } : {}),
  ...(r.description ? { description: r.description } : {}),
  ...(r.login_cookies ? { loginCookies: JSON.parse(r.login_cookies) as string[] } : {}),
  ...(r.pace ? { pace: JSON.parse(r.pace) as NonNullable<SiteContext["pace"]> } : {}),
  ...(r.notes ? { notes: r.notes } : {}),
});

export const getSite = (db: D1Database, name: string) =>
  db.prepare("SELECT * FROM sites WHERE name = ?").bind(name).first<SiteRow>();

export const allSites = async (db: D1Database) =>
  (await db.prepare("SELECT * FROM sites ORDER BY name").all<SiteRow>()).results;

const siteValues = (s: SiteContext, uploader: string, now: string) => [
  s.name,
  s.domain,
  s.baseUrl,
  s.displayName ?? null,
  s.description ?? null,
  s.loginCookies ? JSON.stringify(s.loginCookies) : null,
  s.pace && Object.keys(s.pace).length ? JSON.stringify(s.pace) : null,
  s.notes ?? null,
  uploader,
  now,
  now,
];
const SITE_COLUMNS =
  "(name, domain, base_url, display_name, description, login_cookies, pace, notes, first_uploader, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/** The first upload binds the name to its domain and sets the site's context; later ones leave it. */
export const addSite = (db: D1Database, s: SiteContext, uploader: string, now: string) =>
  db
    .prepare(`INSERT INTO sites ${SITE_COLUMNS} ON CONFLICT (name) DO NOTHING`)
    .bind(...siteValues(s, uploader, now))
    .run();

/** A maintainer's seed replaces the context, the domain included. */
export const seedSite = (db: D1Database, s: SiteContext, now: string) =>
  db
    .prepare(
      `INSERT INTO sites ${SITE_COLUMNS} ON CONFLICT (name) DO UPDATE SET domain = excluded.domain, base_url = excluded.base_url, display_name = excluded.display_name, description = excluded.description, login_cookies = excluded.login_cookies, pace = excluded.pace, notes = excluded.notes, updated_at = excluded.updated_at`,
    )
    .bind(...siteValues(s, "seed", now))
    .run();

export const getVersion = (db: D1Database, hash: string) =>
  db.prepare("SELECT * FROM versions WHERE hash = ?").bind(hash).first<VersionRow>();

export const versionsIn = async (db: D1Database, hashes: string[]) =>
  hashes.length
    ? (
        await db
          .prepare(`SELECT * FROM versions WHERE hash IN (${hashes.map(() => "?").join(", ")})`)
          .bind(...hashes)
          .all<VersionRow>()
      ).results
    : [];

export interface NewVersion {
  hash: string;
  site: string;
  operation: Operation;
  sig: string;
  parent?: string;
  heal: boolean;
  status: Status;
  reasons: string[];
  uploader: string;
  /** the uploader's network hash; a seed has none */
  uploaderNetwork?: string;
  evidence: Evidence;
  /** the claim (fingerprint) this version answers */
  claim?: string;
}

export const addVersion = (db: D1Database, v: NewVersion, now: string) =>
  db
    .prepare(
      "INSERT INTO versions (hash, site, op_name, sig, operation, parent, heal, status, reasons, uploader, evidence, created_at, updated_at, last_ok_at, live_since, uploader_network, claim) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      v.hash,
      v.site,
      v.operation.name,
      v.sig,
      JSON.stringify(v.operation),
      v.parent ?? null,
      v.heal ? 1 : 0,
      v.status,
      v.reasons.length ? JSON.stringify(v.reasons) : null,
      v.uploader,
      JSON.stringify(v.evidence),
      now,
      now,
      null,
      v.status === "live" ? now : null,
      v.uploaderNetwork ?? null,
      v.claim ?? null,
    )
    .run();

/** Sets a status; the first time a version goes live is kept, so an incumbent stays one through a dip. */
export const setStatus = (db: D1Database, hash: string, status: Status, now: string) =>
  db
    .prepare(
      "UPDATE versions SET status = ?, updated_at = ?, live_since = CASE WHEN ? = 'live' THEN COALESCE(live_since, ?) ELSE live_since END WHERE hash = ?",
    )
    .bind(status, now, status, now, hash)
    .run();

export const putStats = (db: D1Database, hash: string, s: Stats, at: string) =>
  db
    .prepare("UPDATE versions SET confirmations = ?, oks = ?, bad = ?, reporters = ?, stats_at = ? WHERE hash = ?")
    .bind(s.confirmations, s.oks, s.bad, s.reporters, at, hash)
    .run();

export const markPending = (db: D1Database, hash: string, pending: boolean) =>
  db
    .prepare("UPDATE versions SET pending = ? WHERE hash = ?")
    .bind(pending ? 1 : 0, hash)
    .run();

export const pendingVersions = async (db: D1Database) =>
  (await db.prepare("SELECT * FROM versions WHERE pending = 1").all<VersionRow>()).results;

/** Recounts every version from its reports since `since`: the daily job, as reports age out. */
export const recountAll = (db: D1Database, since: string, at: string) =>
  db
    .prepare(
      `UPDATE versions SET
        confirmations = (SELECT COUNT(*) FROM reports r WHERE r.hash = versions.hash AND r.at >= ? AND r.outcome = 'ok' AND r.key <> versions.uploader),
        oks = (SELECT COUNT(*) FROM reports r WHERE r.hash = versions.hash AND r.at >= ? AND r.outcome = 'ok'),
        bad = (SELECT COUNT(*) FROM reports r WHERE r.hash = versions.hash AND r.at >= ? AND r.outcome IN ('fail', 'wrong')),
        reporters = (SELECT COUNT(*) FROM reports r WHERE r.hash = versions.hash AND r.at >= ?),
        stats_at = ?`,
    )
    .bind(since, since, since, since, at)
    .run();

/** A seed's version is live from now; a blocked one stays blocked. */
export const reseed = (db: D1Database, hash: string, now: string) =>
  db
    .prepare(
      "UPDATE versions SET status = CASE WHEN status = 'blocked' THEN status ELSE 'live' END, live_since = CASE WHEN status = 'blocked' THEN live_since ELSE COALESCE(live_since, ?) END, updated_at = ? WHERE hash = ?",
    )
    .bind(now, now, hash)
    .run();

/** The seed's earlier versions of a site that this seed no longer has: replaced. */
export async function archiveOldSeeds(db: D1Database, site: string, keep: string[], now: string) {
  const rows = (
    await db
      .prepare(
        "SELECT hash FROM versions WHERE site = ? AND uploader = 'seed' AND status IN ('live', 'candidate', 'degraded')",
      )
      .bind(site)
      .all<{ hash: string }>()
  ).results;
  const old = rows.filter((r) => !keep.includes(r.hash));
  if (old.length)
    await db.batch(
      old.map((r) =>
        db.prepare("UPDATE versions SET status = 'archived', updated_at = ? WHERE hash = ?").bind(now, r.hash),
      ),
    );
}

export interface ReportRow {
  hash: string;
  key: string;
  network: string;
  outcome: Outcome;
  tier?: number;
  ms?: number;
  at: string;
}

/** An install counts once per version: its latest report replaces the one before. */
export const putReport = (db: D1Database, r: ReportRow) =>
  db
    .prepare(
      "INSERT INTO reports (hash, key, network, outcome, tier, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (hash, key) DO UPDATE SET network = excluded.network, outcome = excluded.outcome, tier = excluded.tier, ms = excluded.ms, at = excluded.at",
    )
    .bind(r.hash, r.key, r.network, r.outcome, r.tier ?? null, r.ms ?? null, r.at);

/** An ok from someone other than the uploader keeps a version from the archive. */
export const touchOk = (db: D1Database, hash: string, key: string, at: string) =>
  db.prepare("UPDATE versions SET last_ok_at = ? WHERE hash = ? AND uploader <> ?").bind(at, hash, key);

/** What the recent reports on `v` say; `weekAgo` bounds the ok networks degradation weighs failures against. */
export async function facts(
  db: D1Database,
  v: VersionRow,
  since: string,
  window: number,
  weekAgo: string,
): Promise<Facts & { stats: Stats }> {
  const counts = await db
    .prepare(
      `SELECT COALESCE(SUM(outcome = 'ok' AND key <> ?), 0) AS okKeys,
        COUNT(DISTINCT CASE WHEN outcome = 'ok' AND key <> ? THEN network END) AS okNetworks,
        COALESCE(SUM(outcome = 'wrong'), 0) AS wrongKeys,
        COUNT(DISTINCT CASE WHEN outcome = 'ok' AND at >= ? THEN network END) AS weekOkNetworks,
        COALESCE(SUM(outcome = 'ok'), 0) AS oks,
        COALESCE(SUM(outcome IN ('fail', 'wrong')), 0) AS bad,
        COUNT(*) AS reporters
      FROM reports WHERE hash = ? AND at >= ?`,
    )
    .bind(v.uploader, v.uploader, weekAgo, v.hash, since)
    .first<{
      okKeys: number;
      okNetworks: number;
      wrongKeys: number;
      weekOkNetworks: number;
      oks: number;
      bad: number;
      reporters: number;
    }>();
  const latest = await db
    .prepare(
      `SELECT outcome, network FROM reports WHERE hash = ? AND at >= ? AND outcome IN (${ABOUT_OP.map(() => "?").join(", ")}) ORDER BY at DESC LIMIT ?`,
    )
    .bind(v.hash, since, ...ABOUT_OP, window)
    .all<{ outcome: Outcome; network: string }>();
  const failed = latest.results.filter((r) => r.outcome === "fail" || r.outcome === "wrong");
  return {
    okKeys: counts?.okKeys ?? 0,
    okNetworks: counts?.okNetworks ?? 0,
    wrongKeys: counts?.wrongKeys ?? 0,
    heal: v.heal === 1,
    latest: latest.results.map((r) => r.outcome),
    failedNetworks: new Set(failed.map((r) => r.network)).size,
    weekOkNetworks: counts?.weekOkNetworks ?? 0,
    stats: {
      confirmations: counts?.okKeys ?? 0,
      oks: counts?.oks ?? 0,
      bad: counts?.bad ?? 0,
      reporters: counts?.reporters ?? 0,
    },
  };
}

/**
 * The versions a viewer may be served, with their counts as last recounted: everything served, and the
 * viewer's own `review` versions. `site` narrows to one site. It reads no reports, whatever their number.
 */
export async function servable(db: D1Database, viewer?: string, site?: string): Promise<VersionRow[]> {
  const statuses = SERVED.map(() => "?").join(", ");
  return (
    await db
      .prepare(
        `SELECT * FROM versions
        WHERE (status IN (${statuses}) OR (status = 'review' AND uploader = ?))${site ? " AND site = ?" : ""}`,
      )
      .bind(...SERVED, viewer ?? "", ...(site ? [site] : []))
      .all<VersionRow>()
  ).results;
}

/**
 * Candidates this key neither uploaded nor reported, oldest first: only those served (no live version of
 * the op shadows them), that plain HTTP can call (minTier 1). On a site with no live op, only one installs
 * on 2 networks other than the uploader's already reported ok (they found the site by themselves), so a
 * stranger's fresh site cannot point every verifying install at a host it watches.
 */
export async function unverified(db: D1Database, key: string, limit: number) {
  return (
    await db
      .prepare(
        `SELECT v.hash, v.site, v.op_name, v.operation, s.base_url FROM versions v
        JOIN sites s ON s.name = v.site
        WHERE v.status = 'candidate' AND v.uploader <> ?
          AND COALESCE(json_extract(v.operation, '$.minTier'), 1) = 1
          AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.hash = v.hash AND r.key = ?)
          AND NOT EXISTS (SELECT 1 FROM versions l WHERE l.site = v.site AND l.op_name = v.op_name AND l.status = 'live')
          AND (EXISTS (SELECT 1 FROM versions l WHERE l.site = v.site AND l.status = 'live')
            OR (SELECT COUNT(DISTINCT r.network) FROM reports r WHERE r.hash = v.hash AND r.outcome = 'ok'
              AND r.key <> v.uploader AND r.network <> COALESCE(v.uploader_network, '')) >= 2)
        ORDER BY v.created_at LIMIT ?`,
      )
      .bind(key, key, limit)
      .all<Pick<VersionRow, "hash" | "site" | "op_name" | "operation"> & { base_url: string }>()
  ).results;
}

/**
 * The op names a site's versions have; whether any was learned signed in; and whether its domain is
 * established: some site on it has a live or seeded op. By domain, so a second name for x.com is no way
 * around the review of new ops on x.
 */
export async function siteOps(
  db: D1Database,
  site: string,
  domain: string,
): Promise<{ opNames: string[]; loginOp: boolean; established: boolean }> {
  const rows = (
    await db
      .prepare(
        "SELECT op_name, MAX(COALESCE(json_extract(operation, '$.learnedLoggedIn'), 0)) AS login FROM versions WHERE site = ? GROUP BY op_name",
      )
      .bind(site)
      .all<{ op_name: string; login: number }>()
  ).results;
  const established = await db
    .prepare(
      "SELECT 1 AS x FROM versions v JOIN sites s ON s.name = v.site WHERE s.domain = ? AND (v.status = 'live' OR v.uploader = 'seed') LIMIT 1",
    )
    .bind(domain)
    .first();
  return { opNames: rows.map((r) => r.op_name), loginOp: rows.some((r) => r.login === 1), established: !!established };
}

/**
 * The match signature of an op's incumbent: of its live and degraded versions, the one live the longest.
 * Degraded counts, so degrading the incumbent first does not move the reference.
 */
export const incumbentSig = async (db: D1Database, site: string, op: string) =>
  (
    await db
      .prepare(
        "SELECT sig FROM versions WHERE site = ? AND op_name = ? AND status IN ('live', 'degraded') ORDER BY live_since IS NULL, live_since LIMIT 1",
      )
      .bind(site, op)
      .first<{ sig: string }>()
  )?.sig;

/** Whether `key`'s latest report on `hash` is a fail made since `since`. */
export const failedOn = async (db: D1Database, hash: string, key: string, since: string) =>
  !!(await db
    .prepare("SELECT 1 AS x FROM reports WHERE hash = ? AND key = ? AND outcome = 'fail' AND at >= ?")
    .bind(hash, key, since)
    .first());

export const getKey = (db: D1Database, key: string) =>
  db
    .prepare("SELECT first_seen, uploads FROM keys WHERE key = ?")
    .bind(key)
    .first<{ first_seen: string; uploads: number }>();

/** Adds `n` to a subject's count for this hour and answers the new count. */
export async function count(db: D1Database, subject: string, kind: string, hour: number, n: number): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO rates (subject, kind, hour, n) VALUES (?, ?, ?, ?) ON CONFLICT (subject, kind, hour) DO UPDATE SET n = n + excluded.n RETURNING n",
    )
    .bind(subject, kind, hour, n)
    .first<{ n: number }>();
  return row?.n ?? n;
}

/** Counts a key's uploads and reports; `ok`: an ok report of it was accepted, which sets `activated_at` once. */
export const touchKey = (db: D1Database, key: string, now: string, uploads: number, reports: number, ok = false) =>
  db
    .prepare(
      "INSERT INTO keys (key, first_seen, uploads, reports, activated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET uploads = uploads + excluded.uploads, reports = reports + excluded.reports, activated_at = COALESCE(keys.activated_at, excluded.activated_at)",
    )
    .bind(key, now, uploads, reports, ok ? now : null)
    .run();

/** Sets an existing key's `activated_at`, unless it is set already. */
export const activateKey = (db: D1Database, key: string, now: string) =>
  db.prepare("UPDATE keys SET activated_at = ? WHERE key = ? AND activated_at IS NULL").bind(now, key);

/** Every version that could still be served, with what the archive decision reads. */
export async function archiveCandidates(db: D1Database): Promise<(Archivable & { hash: string })[]> {
  const rows = (
    await db
      .prepare(
        `SELECT hash, site, op_name, status, created_at, last_ok_at FROM versions WHERE status IN (${SERVED.map(() => "?").join(", ")})`,
      )
      .bind(...SERVED)
      .all<Pick<VersionRow, "hash" | "site" | "op_name" | "status" | "created_at" | "last_ok_at">>()
  ).results;
  return rows.map((r) => ({
    hash: r.hash,
    site: r.site,
    op: r.op_name,
    status: r.status,
    createdAt: r.created_at,
    ...(r.last_ok_at ? { lastOkAt: r.last_ok_at } : {}),
  }));
}

/**
 * Archives the given versions, deletes versions archived before `purgeBefore` with their reports, and drops
 * spent rate counters.
 */
export const archive = (db: D1Database, hashes: string[], now: string, hour: number, purgeBefore: string) =>
  db.batch([
    ...hashes.map((h) =>
      db.prepare("UPDATE versions SET status = 'archived', updated_at = ? WHERE hash = ?").bind(now, h),
    ),
    db
      .prepare(
        "DELETE FROM reports WHERE hash IN (SELECT hash FROM versions WHERE status = 'archived' AND updated_at < ?)",
      )
      .bind(purgeBefore),
    db.prepare("DELETE FROM versions WHERE status = 'archived' AND updated_at < ?").bind(purgeBefore),
    db.prepare("DELETE FROM rates WHERE hour < ?").bind(hour - 24),
  ]);

/* ------------------------------------------------------------------ claims */

export interface ClaimRow {
  fingerprint: string;
  site: string;
  key: string;
  network: string;
  name_hash: string;
}

export const putClaim = (db: D1Database, c: ClaimRow, now: string) =>
  db
    .prepare(
      `INSERT INTO claims (fingerprint, site, key, network, name_hash, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (fingerprint, key) DO UPDATE SET network = excluded.network, name_hash = excluded.name_hash, at = excluded.at`,
    )
    .bind(c.fingerprint, c.site, c.key, c.network, c.name_hash, now)
    .run();

export async function claimsOf(db: D1Database, fingerprint: string): Promise<ClaimRow[]> {
  const { results } = await db
    .prepare("SELECT fingerprint, site, key, network, name_hash FROM claims WHERE fingerprint = ?")
    .bind(fingerprint)
    .all<ClaimRow>();
  return results;
}

/** How many installs hold `rows`, counting each network once: a thousand keys on one machine are one voice. */
export const holders = (rows: { key: string; network: string }[]) =>
  Math.min(new Set(rows.map((r) => r.key)).size, new Set(rows.map((r) => r.network)).size);

/**
 * This key's claims that `k` installs hold and whose body the registry does not have yet, each with
 * whether `k` of them gave the op this key's name too.
 */
export async function wantedClaims(
  db: D1Database,
  key: string,
  k: number,
): Promise<{ site: string; fingerprint: string; named: boolean }[]> {
  const { results } = await db
    .prepare(
      `SELECT c.fingerprint, c.site, c.name_hash FROM claims c
       WHERE c.key = ? AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.claim = c.fingerprint)`,
    )
    .bind(key)
    .all<{ fingerprint: string; site: string; name_hash: string }>();
  const out = [];
  for (const r of results) {
    const all = await claimsOf(db, r.fingerprint);
    if (holders(all) >= k)
      out.push({
        site: r.site,
        fingerprint: r.fingerprint,
        named: holders(all.filter((x) => x.name_hash === r.name_hash)) >= k,
      });
  }
  return out;
}

/* ------------------------------------------------------------------ demand */

export const wantDomain = (db: D1Database, domain: string, network: string, now: string) =>
  db
    .prepare(
      "INSERT INTO demand (domain, network, at) VALUES (?, ?, ?) ON CONFLICT (domain, network) DO UPDATE SET at = excluded.at",
    )
    .bind(domain, network, now)
    .run();

/** Domains asked for since `since` that no shared site answers yet, by how many networks asked. */
export async function demandList(
  db: D1Database,
  since: string,
  limit: number,
): Promise<{ domain: string; networks: number; lastAt: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT d.domain, COUNT(*) AS networks, MAX(d.at) AS lastAt FROM demand d
       WHERE d.at >= ? AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.domain = d.domain)
       GROUP BY d.domain ORDER BY networks DESC, lastAt DESC LIMIT ?`,
    )
    .bind(since, limit)
    .all<{ domain: string; networks: number; lastAt: string }>();
  return results;
}

/** How many networks asked for `domain` since `since`; 0 once a site covers it. */
export const demandFor = async (db: D1Database, domain: string, since: string) =>
  (
    await db
      .prepare(
        `SELECT COUNT(*) AS networks FROM demand WHERE domain = ? AND at >= ?
         AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.domain = ?)`,
      )
      .bind(domain, since, domain)
      .first<{ networks: number }>()
  )?.networks ?? 0;

/** The names of the sites on `domain`, seeded ones first. */
export const sitesOn = async (db: D1Database, domain: string) =>
  (
    await db
      .prepare("SELECT name FROM sites WHERE domain = ? ORDER BY first_uploader <> 'seed', name")
      .bind(domain)
      .all<{ name: string }>()
  ).results.map((r) => r.name);

export const forgetDemand = (db: D1Database, before: string) =>
  db.prepare("DELETE FROM demand WHERE at < ?").bind(before).run();

/* -------------------------------------------------------------- interfaces */

export async function reportInterface(
  db: D1Database,
  i: { url: string; domain: string; kind: string; key: string; network: string },
  now: string,
): Promise<void> {
  await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO interfaces (url, domain, kind, created_at) VALUES (?, ?, ?, ?)")
      .bind(i.url, i.domain, i.kind, now),
    db
      .prepare(
        "INSERT INTO interface_reports (url, key, network, at) VALUES (?, ?, ?, ?) ON CONFLICT (url, key) DO UPDATE SET network = excluded.network, at = excluded.at",
      )
      .bind(i.url, i.key, i.network, now),
  ]);
}

/** The interfaces of `domains` that at least `k` installs, one per network, reported. */
export async function interfacesOf(
  db: D1Database,
  domains: string[],
  k: number,
): Promise<Map<string, { kind: "mcp" | "openapi"; url: string; confirmations: number }[]>> {
  const out = new Map<string, { kind: "mcp" | "openapi"; url: string; confirmations: number }[]>();
  if (!domains.length) return out;
  const { results } = await db
    .prepare(
      `SELECT i.url, i.domain, i.kind, r.key, r.network FROM interfaces i JOIN interface_reports r ON r.url = i.url
       WHERE i.domain IN (${domains.map(() => "?").join(",")})`,
    )
    .bind(...domains)
    .all<{ url: string; domain: string; kind: "mcp" | "openapi"; key: string; network: string }>();
  const byUrl = new Map<string, typeof results>();
  for (const r of results) byUrl.set(r.url, [...(byUrl.get(r.url) ?? []), r]);
  for (const [url, rows] of byUrl) {
    const n = holders(rows);
    if (n < k) continue;
    const { domain, kind } = rows[0]!;
    out.set(domain, [...(out.get(domain) ?? []), { kind, url, confirmations: n }]);
  }
  // the best confirmed ten a domain has: what the client keeps
  for (const [d, list] of out) out.set(d, list.sort((a, b) => b.confirmations - a.confirmations).slice(0, 10));
  return out;
}
