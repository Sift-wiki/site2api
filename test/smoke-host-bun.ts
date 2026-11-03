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
import { hostSites, hostSite, closeHost, setBundledDir } from "api-anything/host";
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
  process.stdout.write(run(binary, [], { COMPILED: "1" }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
