/**
 * The public aggregate stats (`GET /v1/stats`, the home page's strip) and which sites installs taught.
 * Only counts leave here: never a key, a network hash or anything that tells one install from another.
 */
import type { ServedSite } from "../../src/registry-api.js";
import { confirmed } from "./catalog.js";
import { SERVED, successRate } from "./rules.js";
import type { D1Database } from "./store.js";

/** The uploader of a maintainer's seed (worker.ts `adminSeed`, store.ts `seedSite`). */
const SEED = "seed";

/**
 * Installs from first contact to sharing, by install key. The registry sees a key only once its install
 * uploads or reports, so an install with sharing off is never counted.
 */
export interface Funnel {
  /** distinct keys in `keys`; `perDay`: keys first seen each UTC day of the last 30, oldest first, today included */
  seen: { total: number; last30Days: number; perDay: { day: string; new: number }[] };
  /**
   * keys with an accepted report (any outcome); `ok`: with an ok one. `ok.total` counts keys that ever had
   * one accepted (`keys.activated_at`), whatever they reported since; the windows are by the time of the
   * key's latest report on each version
   */
  activated: {
    total: number;
    last7Days: number;
    last30Days: number;
    ok: { total: number; last7Days: number; last30Days: number };
  };
  /** keys that uploaded a version or reported in the last 30 days */
  sharing: { last30Days: number };
  /** when these were counted, usually at most an hour before `generated`; absent (and every count 0) until the first count is stored */
  countedAt?: string;
}

export interface PublicStats {
  generated: string;
  /** last7Days/last30Days: distinct installs that reported, uploaded, claimed or reported an interface in the window */
  installs: { last7Days: number; last30Days: number } & Funnel;
  /** calls reported in the last 7 UTC days, today included; okRate is ok / (ok + fail + wrong) */
  calls: { last7Days: number; ok: number; okRate?: number };
  /** sites with a live op, and their live ops */
  sites: { live: number; operations: number };
  /** of those, the sites an install first shared, and the live ops whose served version an install uploaded */
  community: { sites: number; operations: number; uploadsLast30Days: number };
  /** domains asked for in the demand window that no site covers */
  wanted: number;
}

const DAY = 86_400_000;
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Statements adding a batch of reported outcomes to today's call counts. */
export function countCalls(db: D1Database, at: number, outcomes: string[]) {
  const by = new Map<string, number>();
  for (const o of outcomes) by.set(o, (by.get(o) ?? 0) + 1);
  return [...by].map(([outcome, n]) =>
    db
      .prepare(
        "INSERT INTO calls (day, outcome, n) VALUES (?, ?, ?) ON CONFLICT (day, outcome) DO UPDATE SET n = n + excluded.n",
      )
      .bind(utcDay(at), outcome, n),
  );
}

export const forgetCalls = (db: D1Database, before: number) =>
  db.prepare("DELETE FROM calls WHERE day < ?").bind(utcDay(before)).run();

async function activeInstalls(db: D1Database, since: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
        SELECT key FROM reports WHERE at >= ?
        UNION SELECT uploader FROM versions WHERE created_at >= ? AND uploader <> ?
        UNION SELECT key FROM claims WHERE at >= ?
        UNION SELECT key FROM interface_reports WHERE at >= ?
      )`,
    )
    .bind(since, since, SEED, since, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const FUNNEL_SECONDS = 3600;
/** How long a claimed recount holds off other claims, should the request that claimed it die. */
const LEASE_SECONDS = 300;

async function n(db: D1Database, sql: string, ...values: unknown[]): Promise<number> {
  return (
    (
      await db
        .prepare(sql)
        .bind(...values)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

const days30 = (now: number) => Array.from({ length: 30 }, (_, i) => utcDay(now - (29 - i) * DAY));

/** What the funnel says before it was ever counted. */
const uncounted = (now: number): Funnel => ({
  seen: { total: 0, last30Days: 0, perDay: days30(now).map((day) => ({ day, new: 0 })) },
  activated: { total: 0, last7Days: 0, last30Days: 0, ok: { total: 0, last7Days: 0, last30Days: 0 } },
  sharing: { last30Days: 0 },
});

async function countFunnel(db: D1Database, now: number): Promise<Funnel> {
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  const firstDay = utcDay(now - 29 * DAY);
  const days = await db
    .prepare("SELECT substr(first_seen, 1, 10) AS day, COUNT(*) AS n FROM keys WHERE first_seen >= ? GROUP BY day")
    .bind(firstDay)
    .all<{ day: string; n: number }>();
  const byDay = new Map(days.results.map((r) => [r.day, r.n]));
  const perDay = days30(now).map((day) => ({ day, new: byDay.get(day) ?? 0 }));
  const reported = (since: string, ok: boolean) =>
    n(db, `SELECT COUNT(DISTINCT key) AS n FROM reports WHERE at >= ?${ok ? " AND outcome = 'ok'" : ""}`, since);
  return {
    seen: {
      total: await n(db, "SELECT COUNT(*) AS n FROM keys"),
      last30Days: perDay.reduce((s, d) => s + d.new, 0),
      perDay,
    },
    activated: {
      // keys.reports and keys.activated_at outlive the report rows a purged version takes with it
      total: await n(
        db,
        "SELECT COUNT(*) AS n FROM (SELECT key FROM keys WHERE reports > 0 OR activated_at IS NOT NULL UNION SELECT key FROM reports)",
      ),
      last7Days: await reported(ago(7), false),
      last30Days: await reported(ago(30), false),
      ok: {
        // a report row holds only the latest outcome, so an ok then a fail would read as never ok
        total: await n(db, "SELECT COUNT(*) AS n FROM keys WHERE activated_at IS NOT NULL"),
        last7Days: await reported(ago(7), true),
        last30Days: await reported(ago(30), true),
      },
    },
    sharing: {
      last30Days: await n(
        db,
        "SELECT COUNT(*) AS n FROM (SELECT key FROM reports WHERE at >= ? UNION SELECT uploader FROM versions WHERE created_at >= ? AND uploader <> ?)",
        ago(30),
        ago(30),
        SEED,
      ),
    },
    countedAt: new Date(now).toISOString(),
  };
}

/**
 * The funnel as last counted, recounted when that was over an hour ago. One request claims the recount
 * with a lease; the others serve what is held meanwhile, or zeros before the first count is stored.
 */
export async function funnel(db: D1Database, now: number): Promise<Funnel> {
  const held = await db
    .prepare("SELECT body, at FROM snapshots WHERE name = 'funnel'")
    .first<{ body: string | null; at: string | null }>();
  const last = held?.body ? (JSON.parse(held.body) as Funnel) : undefined;
  const at = held?.at ? Date.parse(held.at) : Number.NaN;
  if (last && now - at < FUNNEL_SECONDS * 1000 && at <= now) return last;
  const iso = new Date(now).toISOString();
  // claims only while the snapshot is stale and no live lease holds it, so a request that read a stale
  // snapshot just before another stored a fresh one does not recount again
  const claimed = await db
    .prepare(
      `INSERT INTO snapshots (name, lease) VALUES ('funnel', ?) ON CONFLICT (name) DO UPDATE SET lease = excluded.lease
       WHERE (snapshots.lease IS NULL OR snapshots.lease <= ?)
         AND (snapshots.at IS NULL OR snapshots.at <= ? OR snapshots.at > ?)
       RETURNING name`,
    )
    .bind(
      new Date(now + LEASE_SECONDS * 1000).toISOString(),
      iso,
      new Date(now - FUNNEL_SECONDS * 1000).toISOString(),
      iso,
    )
    .first();
  if (!claimed) return last ?? uncounted(now);
  let counted: Funnel;
  try {
    counted = await countFunnel(db, now);
  } catch (e) {
    await db.prepare("UPDATE snapshots SET lease = NULL WHERE name = 'funnel'").run();
    throw e;
  }
  await db
    .prepare("UPDATE snapshots SET body = ?, at = ?, lease = NULL WHERE name = 'funnel'")
    .bind(JSON.stringify(counted), iso)
    .run();
  return counted;
}

/** Sites an install first shared, and the served versions installs uploaded; `site` narrows to one site. */
export async function community(db: D1Database, site?: string): Promise<{ sites: Set<string>; hashes: Set<string> }> {
  const only = site ? " AND name = ?" : "";
  const sites = await db
    .prepare(`SELECT name FROM sites WHERE first_uploader <> ?${only}`)
    .bind(SEED, ...(site ? [site] : []))
    .all<{ name: string }>();
  const hashes = await db
    .prepare(
      `SELECT hash FROM versions WHERE uploader <> ? AND status IN (${SERVED.map(() => "?").join(", ")})${site ? " AND site = ?" : ""}`,
    )
    .bind(SEED, ...SERVED, ...(site ? [site] : []))
    .all<{ hash: string }>();
  return { sites: new Set(sites.results.map((r) => r.name)), hashes: new Set(hashes.results.map((r) => r.hash)) };
}

/** The stats over `sites`, the catalog as served to an unsigned caller; `by` is `community()` when already read. */
export async function publicStats(
  db: D1Database,
  sites: ServedSite[],
  now: number,
  demandSince: string,
  by?: { sites: Set<string>; hashes: Set<string> },
): Promise<PublicStats> {
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  const calls = await db
    .prepare(
      `SELECT COALESCE(SUM(n), 0) AS total, COALESCE(SUM(CASE WHEN outcome = 'ok' THEN n END), 0) AS ok,
        COALESCE(SUM(CASE WHEN outcome IN ('fail', 'wrong') THEN n END), 0) AS bad FROM calls WHERE day >= ?`,
    )
    .bind(utcDay(now - 6 * DAY))
    .first<{ total: number; ok: number; bad: number }>();
  const uploads = await db
    .prepare("SELECT COUNT(*) AS n FROM versions WHERE created_at >= ? AND uploader <> ?")
    .bind(ago(30), SEED)
    .first<{ n: number }>();
  const wanted = await db
    .prepare(
      `SELECT COUNT(DISTINCT d.domain) AS n FROM demand d
       WHERE d.at >= ? AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.domain = d.domain)`,
    )
    .bind(demandSince)
    .first<{ n: number }>();
  const taught = by ?? (await community(db));
  const live = sites.filter(confirmed);
  const liveOps = live.flatMap((s) => s.operations.filter((o) => o.status === "live"));
  const rate = successRate(calls?.ok ?? 0, calls?.bad ?? 0);
  return {
    generated: new Date(now).toISOString(),
    installs: {
      last7Days: await activeInstalls(db, ago(7)),
      last30Days: await activeInstalls(db, ago(30)),
      ...(await funnel(db, now)),
    },
    calls: { last7Days: calls?.total ?? 0, ok: calls?.ok ?? 0, ...(rate !== undefined ? { okRate: rate } : {}) },
    sites: { live: live.length, operations: liveOps.length },
    community: {
      sites: live.filter((s) => taught.sites.has(s.name)).length,
      operations: liveOps.filter((o) => taught.hashes.has(o.hash)).length,
      uploadsLast30Days: uploads?.n ?? 0,
    },
    wanted: wanted?.n ?? 0,
  };
}
