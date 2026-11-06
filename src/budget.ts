/**
 * A site's request budget, over the default pacing (`store.ts` send slots, ~1 s apart): a longer gap
 * between sends and a cap on requests an hour, from the spec's `pace` with API_ANYTHING_PACE over it.
 * A send that would exceed it is refused (`BudgetSpent`) and the call answers `rate`, so a scheduled
 * caller stays at a person's volume. The check, the slot and the count are one step under pace.json's
 * lock (`store.ts` `reserveSend`); this module only says what fits.
 */
import { MAX_PACE_INTERVAL_MS, MAX_PER_HOUR, type Site } from "./spec.js";

export interface Pace {
  minIntervalMs?: number;
  perHour?: number;
}

/** The budget a send is held to; `exempt` (a write's readback) is counted and never refused. */
export interface SendBudget {
  site: string;
  pace: Pace;
  exempt?: boolean;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };

/** `30s`, `10m`, `2h`, `1d` (or `ms`) as milliseconds; undefined for anything else. */
export function parseDuration(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text.trim());
  if (!m) return undefined;
  const ms = Math.round(Number(m[1]) * UNITS[m[2]!]!);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

export const HOUR_MS = 60 * 60_000;
/** A send under a budget whose slot is further off than this is refused rather than waited for. */
export const MAX_PACE_WAIT_MS = 10_000;

/** A send the budget refused: nothing went. */
export class BudgetSpent extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/** API_ANYTHING_PACE is the user's own configuration: a mistake in it is theirs to fix, not the site's or the spec's. */
export class PaceConfigError extends Error {}

/**
 * API_ANYTHING_PACE: entries split by commas or spaces, each `interval=<duration>` or `perHour=<n>`,
 * for every site or, prefixed `<site>:`, for one; a site's own entry wins. 0 turns either off.
 * Example: `interval=2s,perHour=120,google-flights:perHour=30`.
 */
export function envPace(site: string, text = process.env.API_ANYTHING_PACE ?? ""): Partial<Record<keyof Pace, number>> {
  const all: Partial<Record<keyof Pace, number>> = {};
  const own: Partial<Record<keyof Pace, number>> = {};
  for (const entry of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(?:([a-z0-9][a-z0-9._-]*):)?(interval|perHour)=(.+)$/i.exec(entry);
    if (!m)
      throw new PaceConfigError(
        `API_ANYTHING_PACE: "${entry}" is not interval=<duration> or perHour=<n>, for every site or as <site>:...`,
      );
    const [, name, what, value] = m;
    const interval = what!.toLowerCase() === "interval";
    const n =
      value === "0" ? 0 : interval ? parseDuration(value!) : /^\d{1,7}$/.test(value!) ? Number(value) : undefined;
    const max = interval ? MAX_PACE_INTERVAL_MS : MAX_PER_HOUR;
    if (n === undefined || n > max)
      throw new PaceConfigError(
        `API_ANYTHING_PACE: "${entry}" needs ${interval ? "a duration such as 30s, 10m or 1h, at most 1h" : `a whole number from 1 to ${MAX_PER_HOUR}`}, or 0 for none`,
      );
    const into = name ? (name.toLowerCase() === site ? own : undefined) : all;
    if (into) into[interval ? "minIntervalMs" : "perHour"] = n;
  }
  return { ...all, ...own };
}

/** The site's budget: its spec's `pace`, each field the environment sets taking its place (0: none). */
export function sitePace(site: Site, env?: string): Pace {
  const out: Pace = { ...site.pace };
  for (const [k, v] of Object.entries(envPace(site.name, env)) as [keyof Pace, number][]) {
    if (v > 0) out[k] = v;
    else delete out[k];
  }
  return out;
}

export const limited = (p: Pace | undefined): boolean => !!(p?.minIntervalMs || p?.perHour);

/**
 * Why a send at `slot` would go over the budget, given the site's counted sends of the last hour
 * (oldest first); undefined when it fits. Under any budget a slot more than `MAX_PACE_WAIT_MS` off is
 * refused, so concurrent callers past the budget are told to come back rather than queue.
 */
export function overBudget(
  site: string,
  pace: Pace,
  sent: number[],
  slot: number,
  now: number,
): BudgetSpent | undefined {
  if (pace.perHour && sent.length >= pace.perHour) {
    const retryAfterMs = Math.max(1, sent[sent.length - pace.perHour]! + HOUR_MS - now);
    return new BudgetSpent(
      `not sent: ${site}'s budget is ${pace.perHour} requests an hour, and ${sent.length} went since ${new Date(sent[0]!).toISOString()}`,
      retryAfterMs,
    );
  }
  const wait = slot - now;
  if (limited(pace) && wait > MAX_PACE_WAIT_MS)
    return new BudgetSpent(
      pace.minIntervalMs
        ? `not sent: ${site}'s budget keeps ${pace.minIntervalMs} ms between requests, and its next request may go in ${wait} ms`
        : `not sent: ${site} has a budget, and its next request may go in ${wait} ms, past the ${MAX_PACE_WAIT_MS} ms a call waits`,
      wait,
    );
  return undefined;
}
