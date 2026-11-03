/** Offline sign-in caution for api-anything's own Chrome profile. Never reads cookie values. */
import { closeSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { siteOf } from "./domain.js";
import { profileDir } from "./heal.js";

function presentOrUnreadable(path: string, nonempty = false): boolean {
  try {
    const stat = lstatSync(path);
    return !nonempty || !stat.isFile() || stat.size > 0;
  } catch (e) {
    return !(e instanceof Error && "code" in e && e.code === "ENOENT");
  }
}

function openCookies(file: string) {
  const emitWarning = process.emitWarning;
  try {
    // As in import.ts, silence only SQLite's first-use warning, before the lazy require.
    process.emitWarning = (warning, ...args) => {
      const message = typeof warning === "string" ? warning : warning.message;
      if (!message.includes("SQLite is an experimental")) Reflect.apply(emitWarning, process, [warning, ...args]);
    };
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    return new DatabaseSync(file, { readOnly: true });
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** Any cookie counts, even a guest or expired one. An unreadable existing profile counts too. */
export function profileSignedIn(hosts: string[]): boolean {
  const dir = profileDir();
  try {
    statSync(dir);
  } catch (e) {
    return !(e instanceof Error && "code" in e && e.code === "ENOENT");
  }
  // A running Chrome may not have flushed newly set cookies to SQLite yet.
  if (presentOrUnreadable(join(dir, "SingletonLock"))) return true;
  const domains = new Set(hosts.map(siteOf));
  let found = false;
  for (const relative of ["Default/Network/Cookies", "Default/Cookies", "Network/Cookies", "Cookies"]) {
    const file = join(dir, relative);
    try {
      statSync(file);
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") continue;
      return true;
    }
    found = true;
    // Do not create SQLite shared-memory files or overlook uncheckpointed cookies.
    if (presentOrUnreadable(`${file}-wal`, true) || presentOrUnreadable(`${file}-journal`, true)) return true;
    try {
      // SQLite can create -shm/-wal even read-only in WAL mode. Read its header, never open that DB.
      const fd = openSync(file, "r");
      try {
        const header = Buffer.alloc(20);
        if (readSync(fd, header, 0, header.length, 0) < header.length || header[18] === 2 || header[19] === 2)
          return true;
      } finally {
        closeSync(fd);
      }
      const db = openCookies(file);
      try {
        for (const row of db.prepare("SELECT host_key, name FROM cookies").iterate()) {
          if (typeof row.host_key !== "string" || typeof row.name !== "string") return true;
          if (!domains.size || domains.has(siteOf(row.host_key.replace(/^\./, "")))) return true;
        }
      } finally {
        db.close();
      }
    } catch {
      return true;
    }
  }
  return !found; // an existing profile with no readable cookie database is not proof of sign-out
}
