/**
 * `npm run smoke:pack`: pack the package, install the tarball into a fresh directory outside the
 * checkout, and run the installed CLI and library offline. It proves what a user installs works:
 * `dist`, `sites` and `skills` ship, and the declared dependencies are enough without the repo's
 * dev ones. The install fetches those dependencies, so CI runs this and `npm test` does not;
 * test/pack.test.ts checks the packed file list offline.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL = "skills/api-anything/SKILL.md";

/** The bundled site names, from the checkout's `sites/`. */
export const bundledSites = () =>
  readdirSync(join(ROOT, "sites"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));

/** What a packed file list lacks that an install needs, or ships that it must not. */
export function packProblems(files: string[]): string[] {
  const has = new Set(files);
  // setup copies the skill folder whole: SKILL.md links into references/
  const skill = readdirSync(join(ROOT, "skills", "api-anything"), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(ROOT.length).split("\\").join("/"));
  const need = [
    "package.json",
    "dist/cli.js",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/host.js",
    "dist/host.d.ts",
    "src/host.ts",
    "src/execute.ts",
    SKILL,
    ...skill,
  ];
  return [
    ...need.filter((f) => !has.has(f)).map((f) => `missing ${f}`),
    ...bundledSites()
      .filter((s) => !has.has(`sites/${s}.json`))
      .map((s) => `missing sites/${s}.json`),
    ...files.filter((f) => /^(test|bench)\//.test(f)).map((f) => `ships ${f}`),
  ];
}

const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

function smoke(): void {
  const tmp = mkdtempSync(join(tmpdir(), "aa-pack-"));
  try {
    // built first: a lifecycle script's output would land in the JSON pack prints
    run("npm", ["run", "build"], ROOT);
    const [packed] = JSON.parse(
      run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp], ROOT),
    ) as {
      filename: string;
      files: { path: string }[];
    }[];
    assert.deepEqual(packProblems(packed!.files.map((f) => f.path)), [], "the packed file list");
    const app = join(tmp, "app");
    mkdirSync(app);
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "aa-pack-smoke", private: true, type: "module" }));
    run(
      "npm",
      ["install", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts", join(tmp, packed!.filename)],
      app,
    );

    // a fresh home: the bundled specs and nothing of this machine's
    const env = { ...process.env, API_ANYTHING_HOME: join(tmp, "home") };
    const cli = join(app, "node_modules", ".bin", "api-anything");
    const sites = JSON.parse(run(cli, ["sites"], app, env)) as { name: string; source: string }[];
    assert.deepEqual(sites.map((s) => s.name).sort(), bundledSites().sort(), "sites lists every bundled spec");
    assert.ok(
      sites.every((s) => s.source === "bundled"),
      "every site comes from the package",
    );
    const ops = JSON.parse(run(cli, ["ops", "hacker-news"], app, env)) as { operations: { name: string }[] };
    assert.ok(ops.operations.length > 0, "ops reads a bundled spec");
    const lib = run(
      process.execPath,
      ["--input-type=module", "-e", 'const m = await import("api-anything"); console.log(typeof m.call)'],
      app,
      env,
    );
    assert.equal(lib.trim(), "function", "the library entry loads");
    assert.ok(existsSync(join(app, "node_modules", "api-anything", SKILL)), `${SKILL} is installed`);
    console.log(`${packed!.filename}: ${packed!.files.length} files, ${sites.length} sites, CLI and library run`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) smoke();
