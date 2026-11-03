import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { packProblems } from "./smoke-pack.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("the package ships dist, Bun source, every bundled spec and the skill, and no tests", {
  // npm ci builds dist (prepare); npm run smoke:pack builds, installs and runs the tarball in CI
  skip: !existsSync(new URL("../dist/cli.js", import.meta.url)) && "dist is not built",
}, () => {
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" }),
  ) as { files: { path: string }[] }[];
  const files = packed!.files.map((f) => f.path);
  assert.deepEqual(packProblems(files), []);
  assert.deepEqual(packProblems(files.filter((f) => !f.startsWith("sites/x."))), ["missing sites/x.json"]);
  assert.deepEqual(packProblems([...files, "test/e2e.test.ts"]), ["ships test/e2e.test.ts"]);
});
