/**
 * An exclusive lock the OS releases when its holder dies: an SQLite database beside the file it
 * guards, held by an EXCLUSIVE transaction that writes nothing (fcntl on POSIX, LockFileEx on Windows).
 * Nothing about a holder is guessed (no pid, no age), so nothing ever takes a lock over, and the lock
 * file is never removed or replaced: a waiter that opened the old file would get a lock nobody else
 * checks.
 */
import { closeSync, openSync } from "node:fs";
import { openReadWrite } from "./sqlite.js";

/**
 * `.lk`, not `.lock`: api-anything 0.4 and earlier keep O_EXCL `.lock` files (empty, or a pid) beside
 * the same files. SQLite refuses those as no database, and those versions delete a `.lock` they judge
 * stale, which here would leave a waiter holding a lock on a file nobody else opens.
 */
export const lockPath = (file: string) => `${file}.lk`;

/** The lock stayed held by another process for the whole wait; fn did not run, and a retry may succeed. */
export class LockBusy extends Error {
  readonly next: string;
  constructor(
    readonly file: string,
    waitMs: number,
  ) {
    super(
      `${file} stayed locked by another api-anything process for ${Math.round(waitMs / 1000)} s; nothing was changed`,
    );
    this.next = "retry: another api-anything process was updating it";
  }
}

/** Locks this process holds: a nested lock of the same file runs inside the outer one. */
const holding = new Set<string>();

const busy = (e: unknown) => ((e as { errcode?: number }).errcode ?? 0) % 256 === 5; // SQLITE_BUSY and its extended codes

/** Run fn holding `file`'s lock, waiting up to `waitMs` for it: undefined when it stayed held. */
export function hold<T>(file: string, waitMs: number, fn: () => T): { value: T } | undefined {
  const lock = lockPath(file);
  if (holding.has(lock)) return { value: fn() };
  // Created 0600 here (SQLite would make it 0644), and only when missing: closing any descriptor of a
  // file drops every POSIX lock this process holds on it, SQLite's included.
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const db = openReadWrite(lock);
  try {
    const deadline = Date.now() + waitMs;
    const wait = () => db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.round(deadline - Date.now()))}`);
    try {
      wait();
      // no -journal file beside the lock, not even one a killed holder leaves; this pragma waits for the lock too
      db.exec("PRAGMA journal_mode = MEMORY");
      wait();
      db.exec("BEGIN EXCLUSIVE");
    } catch (e) {
      if (busy(e)) return undefined;
      throw e;
    }
    holding.add(lock);
    try {
      return { value: fn() };
    } finally {
      holding.delete(lock);
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}
