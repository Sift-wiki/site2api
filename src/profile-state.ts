/** Offline sign-in caution for api-anything's own Chrome profile. Reads cookie hosts, never values. */
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { siteOf } from "./domain.js";
import { profileDir } from "./heal.js";
import { openReadOnly } from "./sqlite.js";

/** Whether `path` may be there: only ENOENT says no. `nonempty`: an empty file does not count. */
function present(path: string, nonempty = false): boolean {
  try {
    const stat = lstatSync(path);
    return !nonempty || !stat.isFile() || stat.size > 0;
  } catch (e) {
    return !(e instanceof Error && "code" in e && e.code === "ENOENT");
  }
}

// Chrome picks between these by its own migration state, so a stale database can sit beside the live one: read every one.
const COOKIE_DBS = [
  ["Default", "Network", "Cookies"],
  ["Default", "Cookies"],
];

/** Any cookie on one of the hosts' sites counts, even a guest or expired one; so does a profile it cannot read. */
export function profileSignedIn(hosts: string[]): boolean {
  const dir = profileDir();
  if (!present(dir)) return false;
  // A running Chrome may not have flushed new cookies yet.
  if (present(join(dir, "SingletonLock"))) return true;
  const domains = new Set(hosts.map(siteOf));
  const files = COOKIE_DBS.map((parts) => join(dir, ...parts)).filter((file) => present(file));
  if (!files.length) return true;
  return files.some((file) => holdsCookie(file, domains));
}

function holdsCookie(file: string, domains: Set<string>): boolean {
  // A pending journal or WAL holds cookies the file lacks.
  if (present(`${file}-wal`, true) || present(`${file}-journal`, true)) return true;
  try {
    // SQLite creates -shm and -wal beside a WAL-mode database even read-only: its header says so, unopened.
    const header = Buffer.alloc(20);
    const fd = openSync(file, "r");
    try {
      if (readSync(fd, header, 0, header.length, 0) < header.length || header[18] === 2 || header[19] === 2)
        return true;
    } finally {
      closeSync(fd);
    }
    const db = openReadOnly(file);
    try {
      for (const { host_key } of db.prepare("SELECT host_key FROM cookies").iterate()) {
        if (typeof host_key !== "string" || !domains.size) return true;
        if (domains.has(siteOf(host_key.replace(/^\./, "")))) return true;
      }
    } finally {
      db.close();
    }
  } catch {
    return true;
  }
  return false;
}
