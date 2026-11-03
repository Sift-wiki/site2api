/**
 * Offline package-resolution and compiled-host smoke check. Run with:
 * BUN=~/.local/share/bun-1.4.4/bun node --import tsx test/smoke-host-bun.ts
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
import { hostSites, hostSite, planCall, closeHost, setBundledDir } from "api-anything/host";
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
const edit = new DatabaseSync(cookieFile);
edit.prepare("INSERT INTO cookies VALUES(?, ?)").run(".news.ycombinator.com", "synthetic-cookie");
edit.close();
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
await closeHost();
console.log(JSON.stringify({ runtime: Bun.version, compiled: !!process.env.COMPILED, sites: sites.length, profileChecks: 5 }));
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
