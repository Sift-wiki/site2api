/** Offline sign-in caution for api-anything's own Chrome profile. Never reads cookie values. */
import { lstatSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { siteOf } from "./domain.js";
import { profileDir } from "./heal.js";

function presentOrUnreadable(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    return !(e instanceof Error && "code" in e && e.code === "ENOENT");
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
    if (presentOrUnreadable(`${file}-wal`) || presentOrUnreadable(`${file}-journal`)) return true;
    try {
      // Lazy so Bun and compiled hosts need no SQLite support until a profile exists.
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(file, { readOnly: true });
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
