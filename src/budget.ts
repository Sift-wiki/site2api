/**
 * A site's request budget, over the default pacing (`store.ts` send slots, ~1 s apart): a longer gap
 * between sends and a cap on requests an hour, from the spec's `pace` with API_ANYTHING_PACE over it.
 * A call that would exceed it is answered `rate` without sending, so a scheduled caller stays at a
 * person's volume.
 */
import type { Site } from "./spec.js";
import { nextSlot, sendsThisHour } from "./store.js";

export interface Pace {
  minIntervalMs?: number;
  perHour?: number;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };

/** `30s`, `10m`, `2h`, `1d` (or `ms`) as milliseconds; undefined for anything else. */
export function parseDuration(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text.trim());
  if (!m) return undefined;
  const ms = Math.round(Number(m[1]) * UNITS[m[2]!]!);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

const HOUR_MS = 60 * 60_000;
/** A gap the budget's interval asks a call to wait longer than this is answered `rate` instead. */
export const MAX_PACE_WAIT_MS = 10_000;

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
      throw new Error(
        `API_ANYTHING_PACE: "${entry}" is not interval=<duration> or perHour=<n>, for every site or as <site>:...`,
      );
    const [, name, what, value] = m;
    const n =
      value === "0"
        ? 0
        : what!.toLowerCase() === "interval"
          ? parseDuration(value!)
          : /^\d+$/.test(value!)
            ? Number(value)
            : undefined;
    if (n === undefined)
      throw new Error(
        `API_ANYTHING_PACE: "${entry}" needs ${what!.toLowerCase() === "interval" ? "a duration such as 30s, 10m or 2h" : "a whole number"}`,
      );
    const into = name ? (name.toLowerCase() === site ? own : undefined) : all;
    if (into) into[what!.toLowerCase() === "interval" ? "minIntervalMs" : "perHour"] = n;
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

/** Why a call now would go over the budget, and how long until it would not; undefined when it fits. */
export function overBudget(
  site: string,
  pace: Pace,
  now = Date.now(),
): { reason: string; retryAfterMs: number } | undefined {
  if (pace.perHour) {
    const sent = sendsThisHour(site, now);
    if (sent.length >= pace.perHour) {
      const retryAfterMs = Math.max(1, sent[sent.length - pace.perHour]! + HOUR_MS - now);
      return {
        reason: `not sent: ${site}'s budget is ${pace.perHour} requests an hour, and ${sent.length} went since ${new Date(sent[0]!).toISOString()}`,
        retryAfterMs,
      };
    }
  }
  if (pace.minIntervalMs) {
    const wait = nextSlot(site) - now;
    if (wait > MAX_PACE_WAIT_MS)
      return {
        reason: `not sent: ${site}'s budget keeps ${pace.minIntervalMs} ms between requests, and its next request may go in ${wait} ms`,
        retryAfterMs: wait,
      };
  }
  return undefined;
}
