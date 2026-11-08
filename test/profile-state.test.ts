/**
 * api-anything's own Chrome profile: whether it may hold a site's sign-in, read offline from cookie
 * hosts and names only (values are never read).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { profileDir } from "../src/heal.js";
import { profileSignedIn } from "../src/profile-state.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aa-profile-"));
  process.env.API_ANYTHING_HOME = home;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const dbFile = () => join(profileDir(), "Default", "Network", "Cookies");

const cookieDb = (rows: [string, string][]) => {
  mkdirSync(dirname(dbFile()), { recursive: true });
  const db = new DatabaseSync(dbFile());
  db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT)");
  const insert = db.prepare("INSERT INTO cookies (host_key, name) VALUES (?, ?)");
  for (const [host, name] of rows) insert.run(host, name);
  db.close();
};

test("no profile directory: nothing there can be signed in", () => {
  assert.equal(profileSignedIn(["x.test"]), false);
});

test("a running Chrome's lock counts as a possible sign-in, before any cookie is read", () => {
  mkdirSync(profileDir(), { recursive: true });
  writeFileSync(join(profileDir(), "SingletonLock"), "");
  assert.equal(profileSignedIn(["x.test"]), true);
});

test("a profile with no cookie database at all is treated as possibly signed in", () => {
  mkdirSync(profileDir(), { recursive: true });
  assert.equal(profileSignedIn(["x.test"]), true);
});

test("anonymous-only cookies are not a sign-in", () => {
  cookieDb([
    [".x.test", "__cf_bm"],
    [".x.test", "_ga"],
  ]);
  assert.equal(profileSignedIn(["x.test"]), false);
});

test("an account-carrying cookie on the host is a sign-in", () => {
  cookieDb([["x.test", "sid"]]);
  assert.equal(profileSignedIn(["x.test"]), true);
});

test("a sign-in cookie for another site does not count when hosts are given", () => {
  cookieDb([["other.test", "sid"]]);
  assert.equal(profileSignedIn(["x.test"]), false);
  assert.equal(profileSignedIn([]), true, "with no hosts, any account cookie counts");
});

// A zeroed journal is not hot to SQLite, so the database still opens and only the file check can say true.
for (const suffix of ["-wal", "-journal"]) {
  test(`a pending ${suffix.slice(1)} means cookies that are not in the file yet`, () => {
    cookieDb([[".x.test", "_ga"]]);
    assert.equal(profileSignedIn(["x.test"]), false, "the database alone holds no sign-in");
    writeFileSync(`${dbFile()}${suffix}`, Buffer.alloc(512));
    assert.equal(profileSignedIn(["x.test"]), true);
  });
}

test("a cookie database that cannot be read is treated as possibly signed in", () => {
  cookieDb([[".x.test", "_ga"]]);
  // Keep the 100-byte SQLite header so only opening or querying can fail.
  const bytes = readFileSync(dbFile());
  bytes.fill(0xff, 100);
  writeFileSync(dbFile(), bytes);
  assert.equal(profileSignedIn(["x.test"]), true);
});

test("a cookie table with an unexpected shape is treated as possibly signed in", () => {
  mkdirSync(dirname(dbFile()), { recursive: true });
  const db = new DatabaseSync(dbFile());
  db.exec("CREATE TABLE cookies (host_key TEXT)"); // no name column
  db.close();
  assert.equal(profileSignedIn(["x.test"]), true);
});
