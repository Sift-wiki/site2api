/** Sealing of session and capture files: the key store, the envelope, migration and the no-key fallback. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CaptureUnavailable, loadCapture } from "../src/heal.js";
import {
  isSealedText,
  type KeyStore,
  macosKeychain,
  onPlaintext,
  SEALED,
  SealError,
  sealing,
  setKeyStore,
  writeSealed,
} from "../src/seal.js";
import { loadSession, saveSession, sessionFile } from "../src/session.js";
import { status } from "../src/status.js";
import type { StoredCookie } from "../src/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "live-session-cookie-value-0123456789";
const jar = (value = SECRET): StoredCookie[] => [
  { name: "sid", value, domain: "site.test", path: "/", expires: -1, httpOnly: true, secure: true },
];

/** An in-memory key store, as the Keychain would be; `gets` counts lookups. */
function memoryStore(): KeyStore & { key?: Buffer; gets: number } {
  const s = {
    name: "memory",
    key: undefined as Buffer | undefined,
    gets: 0,
    get() {
      s.gets++;
      return s.key;
    },
    put(k: Buffer) {
      s.key ??= k;
    },
  };
  return s;
}

const env = { ...process.env };
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aa-seal-"));
  process.env.API_ANYTHING_HOME = home;
  delete process.env.API_ANYTHING_KEY;
  delete process.env.API_ANYTHING_PLAINTEXT;
});
afterEach(() => {
  process.env = { ...env };
  setKeyStore(undefined);
  onPlaintext(() => {});
});

test("a session round-trips sealed: no value on disk, one key lookup per process, a format marker", () => {
  const store = memoryStore();
  setKeyStore(store);
  saveSession("site", { cookies: jar(), values: { authorization: "Bearer abcdef" } });
  const raw = readFileSync(sessionFile("site"), "utf8");
  assert.ok(!raw.includes(SECRET) && !raw.includes("Bearer"));
  assert.equal(JSON.parse(raw).sealed, SEALED);
  assert.ok(isSealedText(raw));
  assert.equal((statSync(sessionFile("site")).mode & 0o777).toString(8), "600");
  const s = loadSession("site");
  assert.equal(s.cookies[0]!.value, SECRET);
  assert.equal(s.values.authorization, "Bearer abcdef");
  const looked = store.gets;
  for (let i = 0; i < 5; i++) loadSession("site");
  assert.equal(store.gets, looked, "the key is cached for the process");
  assert.deepEqual(sealing(), { sealed: true, key: "memory" });
});

test("a tampered or swapped file is refused, never read as an empty session", () => {
  setKeyStore(memoryStore());
  saveSession("site", { cookies: jar(), values: {} });
  const file = sessionFile("site");
  const env = JSON.parse(readFileSync(file, "utf8"));
  const data = Buffer.from(env.data, "base64");
  data[3] = data[3]! ^ 1;
  writeFileSync(file, JSON.stringify({ ...env, data: data.toString("base64") }));
  assert.throws(
    () => loadSession("site"),
    (e: unknown) =>
      e instanceof SealError && /integrity check/.test(e.message) && /api-anything login site/.test(e.next),
  );
  // a whole sealed file moved under another site's name is bound to its own
  saveSession("a", { cookies: jar(), values: {} });
  writeFileSync(sessionFile("b"), readFileSync(sessionFile("a")));
  assert.throws(() => loadSession("b"), /integrity check/);
});

test("plaintext files still read, and the first key seals the existing sessions and captures in place", () => {
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(join(home, "captures"), { recursive: true });
  writeFileSync(sessionFile("old"), JSON.stringify({ cookies: jar(), values: {} }));
  const capture = {
    id: "cold1",
    at: new Date().toISOString(),
    url: "https://site.test/",
    finalUrl: "https://site.test/",
  };
  const cfile = join(home, "captures", "cold1.json");
  writeFileSync(cfile, JSON.stringify({ ...capture, cookies: jar(), exchanges: [] }));
  const hourAgo = new Date(Date.now() - 3600_000);
  utimesSync(cfile, hourAgo, hourAgo);
  setKeyStore(null);
  assert.equal(loadSession("old").cookies[0]!.value, SECRET, "plaintext reads with no key at all");

  setKeyStore(memoryStore());
  assert.equal(loadSession("old").cookies[0]!.value, SECRET, "a plaintext read needs no key");
  saveSession("other", { cookies: [], values: {} }); // the first key: the migration runs
  for (const f of [sessionFile("old"), cfile]) {
    const raw = readFileSync(f, "utf8");
    assert.ok(isSealedText(raw) && !raw.includes(SECRET), f);
  }
  assert.equal(
    Math.round(statSync(cfile).mtimeMs / 1000),
    Math.round(hourAgo.getTime() / 1000),
    "pruning keeps its clock",
  );
  assert.equal(loadSession("old").cookies[0]!.value, SECRET);
  assert.equal(loadCapture("cold1").cookies[0]!.value, SECRET);
  assert.ok(JSON.parse(readFileSync(join(home, "sealed.json"), "utf8")).at, "the migration is one-shot");
});

test("with no key a save stays plaintext and says so once; status and site_status report it; API_ANYTHING_PLAINTEXT=1 silences it", () => {
  setKeyStore(null);
  const told: string[] = [];
  onPlaintext((why) => told.push(why));
  saveSession("site", { cookies: jar(), values: {} });
  saveSession("site", { cookies: jar("v2"), values: {} });
  assert.equal(told.length, 1);
  assert.ok(readFileSync(sessionFile("site"), "utf8").includes('"v2"'));
  const s = status();
  assert.equal(s.storage.sealed, false);
  const p = s.problems.filter((x) => x.problem === "plaintext");
  assert.deepEqual(
    p.map((x) => x.site),
    ["site"],
  );
  assert.match(p[0]!.next, /API_ANYTHING_KEY/);

  process.env.API_ANYTHING_PLAINTEXT = "1";
  setKeyStore(null);
  told.length = 0;
  saveSession("site", { cookies: jar(), values: {} });
  assert.equal(told.length, 0);
  assert.deepEqual(
    status().problems.filter((x) => x.problem === "plaintext"),
    [],
  );
  assert.deepEqual(status().storage, { sealed: false, why: "no key store in tests", chosen: true });
});

test("the CLI warns on stderr once when a call saves cookies unsealed", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("set-cookie", "sid=rotated-value-1234567890; Path=/");
    res.setHeader("content-type", "application/json");
    res.end('{"n":1}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mkdirSync(join(home, "sites"), { recursive: true });
  const op = { name: "get", readOnly: true, request: { method: "GET", url: `${base}/n` }, trigger: { url: base } };
  writeFileSync(join(home, "sites", "local.json"), JSON.stringify({ name: "local", baseUrl: base, operations: [op] }));
  try {
    const run = (extra: Record<string, string>) =>
      promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", "call", "local", "get"], {
        cwd: ROOT,
        env: { ...process.env, API_ANYTHING_HOME: home, API_ANYTHING_REGISTRY: "http://127.0.0.1:9", ...extra },
      });
    const { stdout, stderr } = await run({});
    assert.match(stdout, /"ok":true/);
    assert.equal(stderr.match(/stored unsealed/g)?.length, 1, stderr);
    assert.match(stderr, /API_ANYTHING_KEY/);
    assert.doesNotMatch((await run({ API_ANYTHING_PLAINTEXT: "1" })).stderr, /unsealed/);
    // with a passphrase the same call seals the jar, and says nothing
    const sealed = await run({ API_ANYTHING_KEY: "correct horse battery staple" });
    assert.doesNotMatch(sealed.stderr, /unsealed/);
    assert.ok(isSealedText(readFileSync(join(home, "sessions", "local.json"), "utf8")));
  } finally {
    server.close();
  }
});

test("a passphrase seals without an OS store; a wrong one is a clear error, not an empty session", () => {
  setKeyStore(null);
  process.env.API_ANYTHING_KEY = "correct horse battery staple";
  saveSession("site", { cookies: jar(), values: {} });
  assert.equal(JSON.parse(readFileSync(sessionFile("site"), "utf8")).key, "passphrase");
  assert.equal(loadSession("site").cookies[0]!.value, SECRET);

  process.env.API_ANYTHING_KEY = "wrong horse";
  assert.throws(
    () => loadSession("site"),
    (e: unknown) => e instanceof SealError && /not the passphrase/.test(e.message) && /API_ANYTHING_KEY/.test(e.next),
  );
  assert.throws(() => saveSession("site", { cookies: [], values: {} }), /not the passphrase/);
  assert.match(status().problems.find((p) => p.problem === "plaintext")!.detail, /not the passphrase/);

  delete process.env.API_ANYTHING_KEY;
  assert.throws(
    () => loadSession("site"),
    (e: unknown) => e instanceof SealError && /passphrase key/.test(e.message) && /API_ANYTHING_KEY/.test(e.next),
  );
});

test("a file sealed by the OS store names the key it needs when a passphrase is set instead", () => {
  setKeyStore(memoryStore());
  saveSession("site", { cookies: jar(), values: {} });
  process.env.API_ANYTHING_KEY = "some passphrase";
  assert.throws(
    () => loadSession("site"),
    (e: unknown) =>
      e instanceof SealError && /another key \(memory\)/.test(e.message) && /unset API_ANYTHING_KEY/.test(e.next),
  );
});

test("a capture past its 24 h is refused with a next, and deleted; a sealed fresh one loads", () => {
  setKeyStore(memoryStore());
  const write = (id: string, at: number) =>
    writeSealed(
      join(home, "captures", `${id}.json`),
      JSON.stringify({
        id,
        at: new Date(at).toISOString(),
        url: "https://site.test/",
        finalUrl: "https://site.test/",
        cookies: jar(),
        exchanges: [],
      }),
      `capture:${id}`,
    );
  write("cfresh", Date.now() - 3600_000);
  assert.equal(loadCapture("cfresh").cookies[0]!.value, SECRET);
  write("cstale", Date.now() - 25 * 3600_000);
  assert.throws(
    () => loadCapture("cstale"),
    (e: unknown) =>
      e instanceof CaptureUnavailable && /24 h lifetime/.test(e.message) && /capture the page again/.test(e.next),
  );
  assert.throws(() => loadCapture("cstale"), /no capture "cstale"/, "the expired file is gone");
});

test("the Keychain store reads with find-generic-password, adds through stdin without -U, and keeps a key added first", () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-security-"));
  const bin = join(dir, "security");
  const kept = join(dir, "kept");
  const log = join(dir, "log");
  // a stand-in for /usr/bin/security: exit 44 until an item exists, 45 when adding over one
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = "find-generic-password" ]; then [ -f "${kept}" ] || exit 44; cat "${kept}"; exit 0; fi
if [ "$1" = "-i" ]; then line=$(cat); echo "stdin: $line" >> "${log}"; [ -f "${kept}" ] && exit 45
  printf '%s\\n' "$line" | sed 's/.* -w \\([^ ]*\\).*/\\1/' > "${kept}"; exit 0; fi
exit 1
`,
  );
  chmodSync(bin, 0o755);
  const store = macosKeychain(bin);
  assert.equal(store.get(), undefined);
  setKeyStore(store);
  saveSession("site", { cookies: jar(), values: {} });
  const calls = readFileSync(log, "utf8");
  assert.match(calls, /^find-generic-password -s api-anything -a data-key -w$/m);
  assert.match(calls, /^stdin: add-generic-password -s api-anything -a data-key -l api-anything -w \S+$/m);
  assert.doesNotMatch(calls, /^-i .* -w|-U/m, "the key is never an argument, and never replaces another");
  assert.equal(store.get()!.length, 32);
  // a second add (another process raced it) keeps the first key: the file still opens
  store.put(Buffer.alloc(32, 7));
  setKeyStore(store);
  assert.equal(loadSession("site").cookies[0]!.value, SECRET);
});
