/** Isolate module mocks from every real-browser suite. No Chrome is started by this test. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("host browser-tier policies with stubbed browser and trigger layers", () => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--import",
      "tsx",
      "--test",
      "--test-reporter=tap",
      fileURLToPath(new URL("./fixture/host-browser.ts", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 60_000, cwd: fileURLToPath(new URL("..", import.meta.url)), env },
  );
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^# pass [1-9]/m, "the stubbed suite ran");
});
