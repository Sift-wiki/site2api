/** node:sqlite opened read-only: the profile check reads Chrome's database without writing it. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { openReadOnly } from "../src/sqlite.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aa-sqlite-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("reads a database another process wrote, and refuses to write it", () => {
  const file = join(dir, "cookies.db");
  const writer = new DatabaseSync(file);
  writer.exec("CREATE TABLE cookies (host_key TEXT, name TEXT)");
  writer.exec("INSERT INTO cookies VALUES ('x.test', 'sid')");
  writer.close();

  const r = openReadOnly(file);
  try {
    const rows = r.prepare("SELECT host_key, name FROM cookies").all() as { host_key: string; name: string }[];
    assert.deepEqual(
      rows.map((row) => [row.host_key, row.name]),
      [["x.test", "sid"]],
    );
    assert.throws(() => r.exec("INSERT INTO cookies VALUES ('y.test', 'sid')"), "a read-only handle writes nothing");
  } finally {
    r.close();
  }
});

test("a missing file is an error, not a new empty database", () => {
  assert.throws(() => openReadOnly(join(dir, "nope.db")));
});
