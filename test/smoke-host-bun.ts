/**
 * Offline package-resolution and compiled-host smoke check (docs/HOST.md). Run with
 * `node --import tsx test/smoke-host-bun.ts`; set BUN to a Bun that is not on PATH.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "api-anything-bun-host-"));
const bun = process.env.BUN ?? "bun";
const bundled = join(root, "sites");
const expected = readdirSync(bundled).filter((name) => name.endsWith(".json")).length;
try {
  mkdirSync(join(scratch, "node_modules"));
  symlinkSync(root, join(scratch, "node_modules", "api-anything"), "dir");
  const entry = join(scratch, "host-check.ts");
  writeFileSync(
    entry,
    `
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { callPlanned, hostSites, hostSite, planCall, closeHost, setBundledDir } from "api-anything/host";
if (!process.env.COMPILED) {
  assert.match(import.meta.resolve("api-anything/host"), /src\\/host\\.ts$/);
} else {
  setBundledDir(${JSON.stringify(bundled)});
}
globalThis.fetch = () => { throw new Error("host discovery must stay offline"); };
const sites = hostSites();
assert.equal(sites.length, ${expected});
assert.ok(sites.every(s => s.source === "bundled"));
assert.ok(hostSite("hacker-news").operations.length > 0);
const profile = join(process.env.API_ANYTHING_HOME, "profile", "Default", "Network");
mkdirSync(profile, { recursive: true });
const cookieFile = join(profile, "Cookies");
const db = new DatabaseSync(cookieFile);
db.exec("CREATE TABLE cookies(host_key TEXT, name TEXT)");
db.close();
writeFileSync(cookieFile + "-journal", "");
const before = readdirSync(profile).sort();
assert.equal(hostSite("hacker-news").site.signedIn, false);
const emptyPlan = planCall("hacker-news", "frontPage");
assert.ok(emptyPlan.ok, JSON.stringify(emptyPlan));
assert.equal(emptyPlan.signedIn, false);
assert.deepEqual(readdirSync(profile).sort(), before);
const insert = (name) => {
  const edit = new DatabaseSync(cookieFile);
  edit.prepare("INSERT INTO cookies VALUES(?, ?)").run(".news.ycombinator.com", name);
  edit.close();
};
insert("_ga");
insert("__cf_bm");
assert.equal(hostSite("hacker-news").site.signedIn, false);
insert("user");
assert.equal(hostSite("hacker-news").site.signedIn, true);
const wal = new DatabaseSync(cookieFile);
wal.exec("DELETE FROM cookies; PRAGMA journal_mode=WAL");
wal.close();
const walFiles = readdirSync(profile).sort();
const walBytes = readFileSync(cookieFile);
assert.equal(walBytes[18], 2);
const plan = planCall("hacker-news", "frontPage");
assert.ok(plan.ok, JSON.stringify(plan));
assert.equal(plan.signedIn, true);
assert.equal(hostSite("hacker-news").site.signedIn, true);
assert.deepEqual(readdirSync(profile).sort(), walFiles);
assert.deepEqual(readFileSync(cookieFile), walBytes);
// The approval comparison under Bun: a changed preview sends nothing, the approved plan sends once.
mkdirSync(join(process.env.API_ANYTHING_HOME, "sites"), { recursive: true });
writeFileSync(join(process.env.API_ANYTHING_HOME, "sites", "local.json"), JSON.stringify({
  name: "local",
  baseUrl: "http://127.0.0.1",
  operations: [{
    name: "read",
    readOnly: true,
    request: { method: "GET", url: "http://127.0.0.1/api/items", headers: {} },
    trigger: { url: "http://127.0.0.1/items" },
  }],
}));
const approved = planCall("local", "read", {}, { maxTier: 1 });
assert.ok(approved.ok, JSON.stringify(approved));
let sends = 0;
const fetchImpl = async () => {
  sends++;
  return new Response('{"items":[1]}', { headers: { "content-type": "application/json" } });
};
const changed = await callPlanned({ ...approved, request: { ...approved.request, url: "http://127.0.0.1/other" } }, { fetchImpl });
assert.equal(changed.class, "refused");
assert.equal(sends, 0);
const sent = await callPlanned(approved, { fetchImpl });
assert.ok(sent.ok, JSON.stringify(sent));
assert.equal(sends, 1);
await closeHost();
console.log(JSON.stringify({ runtime: Bun.version, compiled: !!process.env.COMPILED, sites: sites.length }));
`,
  );
  const env = { ...process.env, API_ANYTHING_HOME: join(scratch, "home") };
  const run = (cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    execFileSync(cmd, args, { cwd: scratch, env: { ...env, ...extra }, encoding: "utf8" });
  process.stdout.write(run(bun, [entry]));
  const binary = join(scratch, "compiled-host");
  process.stdout.write(
    run(bun, ["build", "--compile", "--target=bun", "--external=playwright-core", entry, "--outfile", binary]),
  );
  process.stdout.write(run(binary, [], { COMPILED: "1", API_ANYTHING_HOME: join(scratch, "compiled-home") }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
