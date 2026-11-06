/**
 * A read's last `ok` answer, per site, op and args, in `~/.api-anything/snapshots/<hash>.json`: what
 * `maxAgeMs` answers from and `changes` compares with. Kept only for a call that asked for one of them.
 * The answer can hold the user's own data, so each file is 0600, and one unused for 30 days is removed.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { asText } from "./codec.js";
import { home, withLock, writePrivate } from "./session.js";
import type { Operation } from "./spec.js";

export interface Snapshot {
  at: number;
  /** the op's response recipe when it was kept: a re-learned recipe answers differently, so it is no hit */
  recipe: string;
  data: unknown;
  nextPage?: string | number;
  hasMore?: boolean;
}

export const KEEP_SNAPSHOT_MS = 30 * 24 * 60 * 60_000;
/** an answer larger than this is not kept */
export const SNAPSHOT_BYTES = 16 * 1024 * 1024;
const PRUNE_EVERY_MS = 60 * 60_000;
let prunedAt = 0;

const dir = () => join(home(), "snapshots");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The file's name: site, op and the args as the request takes them (defaults filled), never the args themselves. */
export function snapshotKey(site: string, op: Operation, args: Record<string, unknown>): string {
  const filled = op.params
    .filter((p) => args[p.name] !== undefined)
    .map((p) => [p.name, asText(args[p.name])])
    .sort(([a], [b]) => (a! < b! ? -1 : 1));
  return sha(JSON.stringify([site, op.name, filled])).slice(0, 32);
}

export const recipeOf = (op: Operation) => sha(JSON.stringify({ ...op.response, shape: undefined })).slice(0, 16);

const fileOf = (key: string) => join(dir(), `${key}.json`);

// Every snapshot goes to and from disk through these two: sealing private files at rest belongs here.
const put = (file: string, text: string) => writePrivate(file, text);
const get = (file: string) => readFileSync(file, "utf8");

/** The kept answer, if any; reading it counts as use for the 30 days. */
export function loadSnapshot(key: string, now = Date.now()): Snapshot | undefined {
  const file = fileOf(key);
  try {
    const s = JSON.parse(get(file)) as Snapshot;
    if (!s || typeof s !== "object" || typeof s.at !== "number" || typeof s.recipe !== "string") return undefined;
    try {
      utimesSync(file, new Date(now), new Date(now));
    } catch {
      /* a read-only home still answers */
    }
    return s;
  } catch {
    return undefined;
  }
}

/** Keep `s` in place of the last; false when it was not kept (too large, or a home that cannot be written). */
export function saveSnapshot(key: string, s: Snapshot, now = Date.now()): boolean {
  try {
    const text = JSON.stringify(s);
    const file = fileOf(key);
    if (Buffer.byteLength(text) > SNAPSHOT_BYTES) {
      rmSync(file, { force: true });
      return false;
    }
    put(file, text);
    if (now - prunedAt > PRUNE_EVERY_MS) prune(now);
    return true;
  } catch {
    return false;
  }
}

/** Read the last answer and keep the next one under the file's lock, so concurrent calls compare in turn. */
export function swapSnapshot<T>(key: string, fn: (prev: Snapshot | undefined) => { next?: Snapshot; out: T }): T {
  const run = () => {
    const r = fn(loadSnapshot(key));
    if (r.next) saveSnapshot(key, r.next);
    return r.out;
  };
  try {
    return withLock(fileOf(key), run);
  } catch {
    return run();
  }
}

/** Remove what nobody read or wrote for 30 days: old answers, and the temp and lock files of a crashed process. */
export function prune(now = Date.now()): void {
  prunedAt = now;
  let names: string[];
  try {
    names = readdirSync(dir());
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir(), name);
    try {
      if (now - statSync(file).mtimeMs > KEEP_SNAPSHOT_MS) rmSync(file, { force: true });
    } catch {
      /* removed meanwhile */
    }
  }
}
