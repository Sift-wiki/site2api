/**
 * `status`: what this machine knows of each op's health, from local files only: the state's stale
 * marks, cool-downs and remembered tiers, the heal log, verify's record, the write ledger and the
 * call log. Each problem carries the step to take, phrased as a call's `next` is.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadRecord, type Outcome, opHash } from "./checks.js";
import { settingsFix, settingsProblem } from "./identity.js";
import { plaintextFiles, plaintextSessions, SealError, type Sealing, sealing } from "./seal.js";
import { home } from "./session.js";
import type { Operation } from "./spec.js";
import { type CallRecord, coolList, loadCalls, loadHeals, loadSite, loadWrites, staleList, tierList } from "./store.js";

const DAY_MS = 24 * 60 * 60_000;
/** fewer calls than this in a window say nothing about a trend */
const MIN_CALLS = 3;
/** an ok rate this much lower than the prior window's is degraded */
const OK_DROP = 0.2;

export interface Window {
  calls: number;
  /** share of calls answered ok, 0..1 */
  ok: number;
  /** calls per tier that answered them; a call that sent nothing has none */
  tiers: Partial<Record<"1" | "2" | "3", number>>;
  heals: number;
  medianMs: number;
}

export interface OpStatus {
  op: string;
  stale?: { until: string; reason: string };
  tier?: { remembered?: 1 | 2 | 3; minTier?: number };
  lastHeal?: { at: string; strategy: string };
  /** `current` false: the op changed since, so the outcome is of an older version of it */
  lastVerify?: { at: string; outcome: Outcome; current: boolean };
  /** the ledger's writes of the last 24 h, by what each did */
  writes?: Partial<Record<"accepted" | "applied" | "mayHaveApplied" | "notApplied" | "notSent", number>>;
  calls?: { "24h"?: Window; "7d": Window; last: { at: string; class: string; tier?: number } };
  degraded?: string;
}

export interface SiteStatus {
  site: string;
  cooling?: { class: string; until: string; reason: string };
  ops: OpStatus[];
}

export interface Problem {
  site: string;
  op?: string;
  problem: "cooling" | "stale" | "escalated" | "degraded" | "failing" | "verify" | "write" | "plaintext" | "settings";
  detail: string;
  next: string;
}

export interface Status {
  ok: true;
  /** whether session and capture files are sealed here, and if not, why */
  storage: Sealing | { sealed: false; why: string; error: true };
  sites: SiteStatus[];
  problems: Problem[];
}

const iso = (ms: number) => new Date(ms).toISOString();

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

function windowOf(calls: CallRecord[]): Window | undefined {
  if (!calls.length) return undefined;
  const tiers: Window["tiers"] = {};
  for (const c of calls) if (c.tier) tiers[`${c.tier}`] = (tiers[`${c.tier}`] ?? 0) + 1;
  return {
    calls: calls.length,
    ok: Math.round((calls.filter((c) => c.class === "ok").length / calls.length) * 100) / 100,
    tiers,
    heals: calls.filter((c) => c.healed).length,
    medianMs: median(calls.map((c) => c.ms)),
  };
}

/** The tier most calls were answered at; a tie goes to the higher one. */
function dominant(w: Window): number | undefined {
  const [top] = Object.entries(w.tiers).sort(([a, x], [b, y]) => y - x || +b - +a);
  return top ? +top[0] : undefined;
}

/** How the last 24 h are worse than the six days before them, if they are. */
function degradation(
  recent: Window | undefined,
  prior: Window | undefined,
): { why: string; tier?: number } | undefined {
  if (!recent || !prior || recent.calls < MIN_CALLS || prior.calls < MIN_CALLS) return undefined;
  const [now, before] = [dominant(recent), dominant(prior)];
  if (now !== undefined && before !== undefined && now > before)
    return {
      why: `most calls in the last 24 h ran at tier ${now} (median ${recent.medianMs} ms), the 6 days before at tier ${before} (median ${prior.medianMs} ms)`,
      tier: now,
    };
  if (recent.ok <= prior.ok - OK_DROP)
    return {
      why: `ok rate ${Math.round(recent.ok * 100)}% in the last 24 h, ${Math.round(prior.ok * 100)}% the 6 days before`,
    };
  return undefined;
}

const sh = (v: unknown) => {
  const s = String(v);
  return /^[\w.,:/@%+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
};

/** The op's call with its stored examples, as a command line. */
const exampleCall = (site: string, op: Operation | undefined, name: string) =>
  [
    `api-anything call ${site} ${name}`,
    ...(op?.params ?? []).flatMap((p) => (p.example !== undefined ? [`${p.name}=${sh(p.example)}`] : [])),
  ].join(" ");

/** What to do about a read the site answers at a higher tier than the op's own. */
const lowerTier = (site: string, op: Operation | undefined, name: string, remembered: number, minTier: number) =>
  `${exampleCall(site, op, name)} --max-tier ${minTier} tries tier ${minTier} again (an answer there forgets tier ${remembered}); if it fails the same way, the op needs the browser: re-learn it with api-anything add ${site} ${name} ...`;

/** The step a failing class asks for, as nextFor in execute.ts says it. */
function stepFor(cls: string, site: string, name: string, write: boolean): string {
  switch (cls) {
    case "auth":
      return `ask the user to run: api-anything login ${site}; then retry once`;
    case "blocked":
      return `ask the user to run api-anything login ${site} --window and clear the challenge in the window, then retry once`;
    case "rate":
      return "rate limited: wait a few minutes before the next call";
    case "drift":
      return write
        ? `re-learn it with api-anything add ${site} ${name} ... --write`
        : `api-anything heal ${site} ${name}; if that fails, re-learn it with api-anything add ${site} ${name} ...`;
    case "input":
    case "refused":
      return `check the args against: api-anything ops ${site}`;
    default:
      // verify calls reads only
      if (write) return "the write may have gone through: check the site before sending it again";
      return `api-anything verify ${site} shows whether its example still answers; if it fails the same way, report the reason`;
  }
}

// as verify's exit code and search's local evidence read it: one case that tested nothing is no pass
function verdict(results: { outcome: Outcome }[]): Outcome {
  if (results.some((r) => r.outcome === "fail")) return "fail";
  return results.length && results.every((r) => r.outcome === "pass") ? "pass" : "inconclusive";
}

/** Sites with anything on record here: a status of all 57 bundled sites would be mostly empty. */
function sitesWithState(now: number): string[] {
  const names = new Set<string>();
  for (const x of [...staleList(now), ...tierList(), ...coolList(now), ...loadHeals(), ...loadCalls(undefined, now)])
    names.add(x.site);
  for (const w of loadWrites({ since: now - DAY_MS })) names.add(w.site);
  try {
    for (const f of readdirSync(join(home(), "checks"))) if (f.endsWith(".json")) names.add(f.slice(0, -5));
  } catch {
    // no verify has run
  }
  return [...names].sort();
}

/** One site's status, and its problems. `named`: every op is listed, not only those with something to say. */
function siteStatus(name: string, now: number, named: boolean): { status: SiteStatus; problems: Problem[] } {
  let ops: Operation[] = [];
  try {
    ops = loadSite(name)?.site.operations ?? [];
  } catch {
    // a spec that does not load still has its local records
  }
  const byName = new Map(ops.map((o) => [o.name, o]));
  const problems: Problem[] = [];
  const problem = (p: Omit<Problem, "site">) => problems.push({ site: name, ...p });

  const status: SiteStatus = { site: name, ops: [] };
  const cool = coolList(now).find((c) => c.site === name);
  if (cool) {
    status.cooling = { class: cool.class, until: iso(cool.until), reason: cool.reason };
    problem({
      problem: "cooling",
      detail: `${cool.class} at ${iso(cool.at)}: calls answer without sending until ${iso(cool.until)}`,
      next:
        cool.status === 451
          ? "the site refuses this network or region (HTTP 451): no call changes that; tell the user"
          : cool.class === "rate"
            ? `rate limited: wait until ${iso(cool.until)}; only if the user asks, send one sooner with api-anything call ${name} <op> --force`
            : `ask the user to run api-anything login ${name} --window (a login ends the wait), then retry once`,
    });
  }

  const stale = new Map(staleList(now).flatMap((s) => (s.site === name ? [[s.op, s]] : [])));
  const tiers = new Map(tierList().flatMap((t) => (t.site === name ? [[t.op, t.tier]] : [])));
  const heals = new Map<string, { at: string; strategy: string }>();
  for (const h of loadHeals(name)) heals.set(h.op, { at: h.at, strategy: h.strategy });
  let record: ReturnType<typeof loadRecord> = {};
  try {
    record = loadRecord(name);
  } catch {
    // a corrupt record: verify writes it again
  }
  const writes = new Map<string, NonNullable<OpStatus["writes"]>>();
  for (const w of loadWrites({ since: now - DAY_MS })) {
    if (w.site !== name) continue;
    const key = (
      {
        accepted: "accepted",
        applied: "applied",
        may_have_applied: "mayHaveApplied",
        sending: "mayHaveApplied",
        not_applied: "notApplied",
        not_sent: "notSent",
      } as const
    )[w.status];
    const counts = writes.get(w.op) ?? {};
    counts[key] = (counts[key] ?? 0) + 1;
    writes.set(w.op, counts);
  }
  const calls = new Map<string, CallRecord[]>();
  for (const c of loadCalls(name, now)) {
    const list = calls.get(c.op);
    if (list) list.push(c);
    else calls.set(c.op, [c]);
  }

  const names = [
    ...new Set([
      ...ops.map((o) => o.name),
      ...stale.keys(),
      ...tiers.keys(),
      ...heals.keys(),
      ...Object.keys(record),
      ...writes.keys(),
      ...calls.keys(),
    ]),
  ];
  for (const opName of names) {
    const op = byName.get(opName);
    const write = op ? !op.readOnly : false;
    const s: OpStatus = { op: opName };
    const mark = stale.get(opName);
    if (mark) {
      s.stale = { until: iso(mark.until), reason: mark.reason };
      problem({
        op: opName,
        problem: "stale",
        detail: `no heal is tried until ${iso(mark.until)}: ${mark.reason}`,
        next: write
          ? `re-learn it with api-anything add ${name} ${opName} ... --write`
          : `api-anything heal ${name} ${opName} (it ignores the mark); if that fails, re-learn it with api-anything add ${name} ${opName} ...`,
      });
    }
    const remembered = tiers.get(opName);
    if (remembered !== undefined || (op && op.minTier > 1))
      s.tier = { ...(remembered !== undefined ? { remembered } : {}), ...(op ? { minTier: op.minTier } : {}) };
    if (remembered !== undefined && op && remembered > op.minTier && !write)
      problem({
        op: opName,
        problem: "escalated",
        detail: `every call starts at tier ${remembered}, an escalation remembered from an earlier call; the op's own tier is ${op.minTier}`,
        next: lowerTier(name, op, opName, remembered, op.minTier),
      });
    const heal = heals.get(opName);
    if (heal) s.lastHeal = heal;
    const rec = record[opName];
    if (rec?.results?.length) {
      const outcome = verdict(rec.results);
      const current = !!op && rec.hash === opHash(op);
      s.lastVerify = { at: rec.at, outcome, current };
      if (current && outcome === "fail") {
        const failed = rec.results.find((r) => r.outcome === "fail")!;
        problem({
          op: opName,
          problem: "verify",
          detail: `verify at ${rec.at}: ${failed.case} expects ${failed.expect}, and answered ${failed.got}`,
          next: failed.next ?? stepFor(failed.got, name, opName, write),
        });
      }
    }
    const w = writes.get(opName);
    if (w) {
      s.writes = w;
      if (w.mayHaveApplied)
        problem({
          op: opName,
          problem: "write",
          detail: `${w.mayHaveApplied} write${w.mayHaveApplied > 1 ? "s" : ""} in the last 24 h may have gone through: the site's answer did not say`,
          next: "check the site before sending any of them again",
        });
    }
    const mine = calls.get(opName) ?? [];
    if (mine.length) {
      const day = mine.filter((c) => now - Date.parse(c.at) < DAY_MS);
      const prior = mine.filter((c) => now - Date.parse(c.at) >= DAY_MS);
      const last = mine.at(-1)!;
      s.calls = {
        ...(day.length ? { "24h": windowOf(day)! } : {}),
        "7d": windowOf(mine)!,
        last: { at: last.at, class: last.class, ...(last.tier ? { tier: last.tier } : {}) },
      };
      const deg = degradation(windowOf(day), windowOf(prior));
      if (deg) s.degraded = deg.why;
      // a failure the caller's args explain says nothing about the op
      const failed = !["ok", "input", "refused", "duplicate"].includes(last.class);
      if (deg?.tier && !(remembered !== undefined && op && remembered > op.minTier))
        problem({
          op: opName,
          problem: "degraded",
          detail: deg.why,
          next:
            op && !write ? lowerTier(name, op, opName, deg.tier, op.minTier) : stepFor("error", name, opName, write),
        });
      if (failed) {
        const okBefore = mine.findLast((c) => c.class === "ok");
        const healedSince =
          heal && heal.strategy !== "revert" && (!okBefore || Date.parse(heal.at) > Date.parse(okBefore.at));
        problem({
          op: opName,
          problem: "failing",
          detail: [
            `the last call (${last.at}) answered ${last.class}`,
            ...(okBefore ? [`the last ok was at ${okBefore.at}`] : []),
            ...(deg && !deg.tier ? [deg.why] : []),
          ].join("; "),
          next: `${stepFor(last.class, name, opName, write)}${healedSince ? `; if the heal at ${heal.at} broke it: api-anything revert ${name} ${opName}` : ""}`,
        });
      } else if (deg && !deg.tier) {
        const lastFail = day.findLast((c) => c.class !== "ok");
        problem({
          op: opName,
          problem: "degraded",
          detail: deg.why,
          next: stepFor(lastFail?.class ?? "error", name, opName, write),
        });
      }
    }
    // across all sites, an op whose only news is a passing verify is left out: bare `verify` touches every site
    const { op: _o, lastVerify, ...news } = s;
    if (named || Object.keys(news).length || (lastVerify && (lastVerify.outcome !== "pass" || !lastVerify.current)))
      status.ops.push(s);
  }
  return { status, problems };
}

/** Sealing here, and a problem for each session file it leaves in plaintext that the user did not choose. */
function storageStatus(site: string | undefined): { storage: Status["storage"]; problems: Problem[] } {
  let storage: Status["storage"];
  try {
    storage = sealing();
  } catch (e) {
    const why = (e as Error).message;
    const next = e instanceof SealError ? e.next : "fix the key store, then retry";
    return {
      storage: { sealed: false, why, error: true },
      problems: [{ site: site ?? "*", problem: "plaintext", detail: why, next }],
    };
  }
  if (storage.sealed) {
    // files the migration to sealing could not seal yet (busy, corrupt or unwritable): it retries on the next run
    const left = plaintextSessions().filter((s) => !site || s === site);
    const captures = site ? [] : plaintextFiles("captures");
    return {
      storage,
      problems: [
        ...left.map(
          (s): Problem => ({
            site: s,
            problem: "plaintext",
            detail: "its session file is still unsealed (0600 plaintext): sealing it in place did not succeed yet",
            next: `run status again (each run retries); if it stays, the file is corrupt or not writable: fix that, or sign in again: api-anything login ${s}`,
          }),
        ),
        ...(captures.length
          ? [
              {
                site: "*",
                problem: "plaintext" as const,
                detail: `${captures.length} capture file(s) are still unsealed (0600 plaintext): sealing them in place did not succeed yet`,
                next: `run status again (each run retries); if it stays, delete the files in ${join(home(), "captures")} (a later learn captures again)`,
              },
            ]
          : []),
      ],
    };
  }
  if (storage.chosen) return { storage, problems: [] };
  const problems = plaintextSessions()
    .filter((s) => !site || s === site)
    .map(
      (s): Problem => ({
        site: s,
        problem: "plaintext",
        detail: `its session file holds cookies unsealed (0600 plaintext): ${storage.why}`,
        next: "set API_ANYTHING_KEY to a passphrase in this environment (the next run seals it), or API_ANYTHING_PLAINTEXT=1 to keep plaintext",
      }),
    );
  return { storage, problems };
}

/** The status of one site, or of every site with something on record here. */
export function status(site?: string, now = Date.now()): Status {
  const names = site ? [site] : sitesWithState(now);
  const sites: SiteStatus[] = [];
  const problems: Problem[] = [];
  for (const n of names) {
    const r = siteStatus(n, now, !!site);
    if (site || r.status.ops.length || r.status.cooling) sites.push(r.status);
    problems.push(...r.problems);
  }
  const kept = storageStatus(site);
  const settings = settingsProblem();
  if (settings)
    kept.problems.push({
      site: "*",
      problem: "settings",
      detail: `${settings}: until it reads, this install is local-only, and sharing and verification are off`,
      next: settingsFix(),
    });
  return { ok: true, storage: kept.storage, sites, problems: [...problems, ...kept.problems] };
}
