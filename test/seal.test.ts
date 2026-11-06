/** Sealing of session and capture files: the key store, the envelope, migration and the no-key fallback. */
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CaptureUnavailable, loadCapture } from "../src/heal.js";
import { learnSite } from "../src/learnsite.js";
import { logout } from "../src/login.js";
import {
  isSealedText,
  type KeyStore,
  KeyUnavailable,
  keyLock,
  MAGIC,
  macosKeychain,
  onPlaintext,
  SEALED,
  SealError,
  sealing,
  secretTool,
  setKeyStore,
  writeSealed,
} from "../src/seal.js";
import { CAPTURE_TTL_MS, loadSession, mergeCapture, saveSession, sessionFile } from "../src/session.js";
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

const envelope = (file: string) => JSON.parse(readFileSync(file, "utf8").slice(MAGIC.length));
const writeEnvelope = (file: string, env: unknown) => writeFileSync(file, `${MAGIC}${JSON.stringify(env)}`);

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
  assert.ok(raw.startsWith(MAGIC) && isSealedText(raw));
  assert.equal(envelope(sessionFile("site")).sealed, SEALED);
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
  const env = envelope(file);
  const data = Buffer.from(env.data, "base64");
  data[3] = data[3]! ^ 1;
  writeEnvelope(file, { ...env, data: data.toString("base64") });
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
  assert.equal(JSON.parse(readFileSync(join(home, "sealed.json"), "utf8")).migrated, true, "the migration is one-shot");
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
  assert.equal(envelope(sessionFile("site")).key, "passphrase");
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

/* ------------------------------------------------------------ review fixes */

const marker = () => JSON.parse(readFileSync(join(home, "sealed.json"), "utf8"));
const plaintextProblems = () => status().problems.filter((p) => p.problem === "plaintext");

test("fail closed: a damaged key-salt.json with API_ANYTHING_KEY set refuses the write, and writes nothing", () => {
  setKeyStore(null);
  process.env.API_ANYTHING_KEY = "correct horse battery staple";
  for (const damaged of ["{not json", JSON.stringify({ v: 1, salt: "c2FsdA==" })]) {
    writeFileSync(join(home, "key-salt.json"), damaged);
    assert.throws(
      () => saveSession("site", { cookies: jar(), values: {} }),
      (e: unknown) => e instanceof SealError && /damaged/.test(e.message) && /restore the original/.test(e.next),
    );
    assert.ok(!existsSync(sessionFile("site")), "no plaintext was written");
    assert.equal(readFileSync(join(home, "key-salt.json"), "utf8"), damaged, "the salt file is left as it was");
  }
});

test("fail closed: a key store that fails once refuses that write, is not cached, and the next write seals", () => {
  const store = memoryStore();
  let fail = true;
  setKeyStore({
    name: "flaky",
    get() {
      if (fail) {
        fail = false;
        throw new Error("The user name or passphrase you entered is not correct (locked keychain)");
      }
      return store.get();
    },
    put: (k) => store.put(k),
  });
  const told: string[] = [];
  onPlaintext((why) => told.push(why));
  assert.throws(
    () => saveSession("site", { cookies: jar(), values: {} }),
    (e: unknown) => e instanceof SealError && /flaky key store failed/.test(e.message) && /unlock/.test(e.next),
  );
  assert.ok(!existsSync(sessionFile("site")), "nothing written in plaintext");
  assert.deepEqual(told, [], "no plaintext warning either: it is an error");
  saveSession("site", { cookies: jar(), values: {} });
  assert.ok(isSealedText(readFileSync(sessionFile("site"), "utf8")));
  assert.equal(loadSession("site").cookies[0]!.value, SECRET);
});

test("fail closed: a store that fails on a home that never sealed is an error too; only a missing store falls back", () => {
  setKeyStore({
    name: "broken",
    get() {
      throw new Error("secret-tool lookup: timed out");
    },
    put() {},
  });
  assert.throws(() => saveSession("site", { cookies: jar(), values: {} }), SealError);
  assert.ok(!existsSync(sessionFile("site")));

  setKeyStore({
    name: "absent",
    get() {
      throw new KeyUnavailable("secret-tool is not installed");
    },
    put() {},
  });
  saveSession("site", { cookies: jar(), values: {} });
  assert.ok(readFileSync(sessionFile("site"), "utf8").includes(SECRET), "a never-sealed home with no store: plaintext");
  assert.deepEqual(sealing(), { sealed: false, why: "secret-tool is not installed", chosen: false });
});

test("fail closed: once a home has sealed, a missing key store refuses writes (marker or not), and sealed files are kept", () => {
  setKeyStore(memoryStore());
  saveSession("site", { cookies: jar(), values: {} });
  const sealedBytes = readFileSync(sessionFile("site"), "utf8");
  assert.equal(marker().key, "memory", "the first sealed write records that this home seals");

  for (const dropMarker of [false, true]) {
    if (dropMarker) rmSync(join(home, "sealed.json"));
    setKeyStore(null);
    process.env.API_ANYTHING_PLAINTEXT = "1"; // not even the plaintext choice writes over a sealed home
    assert.throws(
      () => saveSession("site", { cookies: jar("plain"), values: {} }),
      (e: unknown) => e instanceof SealError && /not available here/.test(e.message) && /memory key store/.test(e.next),
    );
    assert.throws(() => saveSession("other", { cookies: jar("plain"), values: {} }), SealError);
    assert.ok(!existsSync(sessionFile("other")));
    assert.equal(readFileSync(sessionFile("site"), "utf8"), sealedBytes);
    delete process.env.API_ANYTHING_PLAINTEXT;
  }
});

test("key creation: the lock is not taken from a live holder, however old, and is taken from a dead one", () => {
  const file = join(home, "data-key");
  writeFileSync(`${file}.lock`, String(process.ppid));
  const old = new Date(Date.now() - 30_000);
  utimesSync(`${file}.lock`, old, old);
  let ran = false;
  assert.throws(
    () =>
      keyLock(
        file,
        () => {
          ran = true;
        },
        300,
      ),
    (e: unknown) => e instanceof SealError && /held/.test(e.message),
  );
  assert.equal(ran, false, "a 30 s old lock of a live process is still its own");

  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  writeFileSync(`${file}.lock`, String(dead));
  assert.equal(
    keyLock(file, () => "ran", 300),
    "ran",
  );
  assert.ok(!existsSync(`${file}.lock`));
});

test("key creation: a store shared by every home locks per user, not per home", () => {
  const a = macosKeychain().lock!;
  process.env.API_ANYTHING_HOME = mkdtempSync(join(tmpdir(), "aa-seal-other-"));
  assert.equal(macosKeychain().lock, a);
  assert.equal(secretTool().lock, a);
  assert.ok(!a.startsWith(home), a);
});

test("key creation: two processes on two homes racing a store whose put replaces end with one key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-race-"));
  const child = join(dir, "child.mts");
  writeFileSync(
    child,
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const { setKeyStore, writeSealed } = await import(process.env.SEAL_URL!);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const f = process.env.STORE!;
setKeyStore({
  name: "file",
  lock: process.env.LOCK,
  get: () => (existsSync(f) ? Buffer.from(readFileSync(f, "utf8"), "base64") : undefined),
  // like secret-tool store and DPAPI: a put replaces whatever is there, slowly
  put: (k: Buffer) => { sleep(400); writeFileSync(f, k.toString("base64")); },
});
while (!existsSync(process.env.GO!)) sleep(5);
const out = process.env.API_ANYTHING_HOME + "/sessions/s.json";
writeSealed(out, "{}", "session:s");
process.stdout.write(/"kid":"(\\w+)"/.exec(readFileSync(out, "utf8"))![1]!);
`,
  );
  const runOne = (h: string) =>
    new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, ["--import", "tsx", child], {
        cwd: ROOT,
        env: {
          ...process.env,
          API_ANYTHING_HOME: h,
          SEAL_URL: pathToFileURL(join(ROOT, "src/seal.ts")).href,
          STORE: join(dir, "store"),
          LOCK: join(dir, "user", "data-key"),
          GO: join(dir, "go"),
        },
      });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
    });
  const runs = [runOne(mkdtempSync(join(tmpdir(), "aa-race-a-"))), runOne(mkdtempSync(join(tmpdir(), "aa-race-b-")))];
  await new Promise((r) => setTimeout(r, 1500)); // both are up and waiting
  writeFileSync(join(dir, "go"), "");
  const [a, b] = await Promise.all(runs);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, b, "the second process used the key the first created, not one of its own");
});

test("key creation: the key used is the one the store returns after the put", () => {
  const kept = Buffer.alloc(32, 9);
  let stored: Buffer | undefined;
  setKeyStore({
    name: "elsewhere",
    get: () => stored,
    put() {
      stored = kept; // another process's key landed instead of ours
    },
  });
  saveSession("site", { cookies: jar(), values: {} });
  const s = memoryStore();
  s.key = kept;
  setKeyStore({ ...s, name: "elsewhere", get: () => kept });
  assert.equal(loadSession("site").cookies[0]!.value, SECRET);
});

test("migration seals a session under its writers' lock: a busy one is left, reported, and sealed by a later run", () => {
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(sessionFile("busy"), JSON.stringify({ cookies: jar(), values: {} }));
  writeFileSync(`${sessionFile("busy")}.lock`, ""); // another process is mid-update
  const store = memoryStore();
  setKeyStore(store);
  saveSession("other", { cookies: [], values: {} });
  assert.ok(readFileSync(sessionFile("busy"), "utf8").includes(SECRET), "not written over under another's lock");
  assert.notEqual(marker().migrated, true, "not recorded as done with a file left");
  assert.deepEqual(
    plaintextProblems().map((p) => p.site),
    ["busy"],
  );

  rmSync(`${sessionFile("busy")}.lock`);
  // the same process (a long-lived MCP server) retries on the next status, with the key it has cached
  assert.deepEqual(plaintextProblems(), []);
  assert.ok(isSealedText(readFileSync(sessionFile("busy"), "utf8")));
  assert.equal(marker().migrated, true);
  assert.equal(loadSession("busy").cookies[0]!.value, SECRET);
});

test("migration inside a caller that holds the session's lock neither deadlocks nor loses the caller's update", () => {
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(sessionFile("site"), JSON.stringify({ cookies: jar(), values: {} }));
  setKeyStore(memoryStore());
  const t = Date.now();
  mergeCapture("site", [{ ...jar()[0]!, name: "fresh", value: "merged-cookie-value" }]);
  assert.ok(Date.now() - t < 900, "the nested lock ran at once");
  assert.equal(marker().migrated, true, "the held file was sealed, not skipped");
  assert.deepEqual(
    loadSession("site")
      .cookies.map((c) => c.name)
      .sort(),
    ["fresh", "sid"],
  );
});

test("migration records completion only when every file is sealed: a corrupt one keeps it open", () => {
  mkdirSync(join(home, "captures"), { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(sessionFile("good"), JSON.stringify({ cookies: jar(), values: {} }));
  writeFileSync(join(home, "captures", "broken.json"), "{half");
  setKeyStore(memoryStore());
  saveSession("x", { cookies: [], values: {} });
  assert.ok(isSealedText(readFileSync(sessionFile("good"), "utf8")));
  assert.notEqual(marker().migrated, true);
  assert.ok(plaintextProblems().some((p) => p.site === "*" && /1 capture/.test(p.detail)));
});

/**
 * api-anything v0.3.2's session reader, copied from `git show v0.3.2:src/session.ts` (readJson and
 * loadSession): what an older install does with a sealed home after a downgrade.
 */
function loadSession032(file: string) {
  const readJson = <T>(f: string, fallback: T): T => {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw e;
    }
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new Error(`${f} is corrupt (${(e as Error).message}); fix or delete it`);
    }
  };
  const s = readJson<{ cookies?: unknown[]; values?: Record<string, string> }>(file, {});
  if (!s || typeof s !== "object" || (s.cookies !== undefined && !Array.isArray(s.cookies)))
    throw new Error(`${file} is not a session file; delete it and log in again`);
  return { cookies: s.cookies ?? [], values: s.values ?? {} };
}

test("a downgrade to 0.3.2 refuses a sealed session loudly instead of reading it as empty (so it never saves over it)", () => {
  setKeyStore(memoryStore());
  saveSession("site", { cookies: jar(), values: {} });
  const bytes = readFileSync(sessionFile("site"), "utf8");
  // every 0.3.2 write of a session (merge, import, window login, dropUnbound, recordOrigins, the
  // call's cookie swap) loads it first, so this throw stops the write
  assert.throws(() => loadSession032(sessionFile("site")), /is corrupt/);
  assert.equal(readFileSync(sessionFile("site"), "utf8"), bytes);
  // the bug this guards: a JSON envelope read by 0.3.2 is an empty session, which its next save replaces
  writeFileSync(join(home, "json-envelope.json"), bytes.slice(MAGIC.length));
  assert.deepEqual(loadSession032(join(home, "json-envelope.json")).cookies, []);
});

test("a short GCM tag or a wrong-length IV is refused before decrypting", () => {
  setKeyStore(memoryStore());
  saveSession("site", { cookies: jar(), values: {} });
  const file = sessionFile("site");
  const env = envelope(file);
  for (const bad of [
    { tag: Buffer.from(env.tag, "base64").subarray(0, 4).toString("base64") },
    { tag: Buffer.from(env.tag, "base64").subarray(0, 12).toString("base64") },
    { iv: Buffer.alloc(8).toString("base64") },
    { data: "not base64!" },
  ]) {
    writeEnvelope(file, { ...env, ...bad });
    assert.throws(
      () => loadSession("site"),
      (e: unknown) => e instanceof SealError && /integrity check/.test(e.message),
      JSON.stringify(bad),
    );
  }
});

test("an unknown or malformed sealed marker is an integrity error, never a plaintext session", () => {
  setKeyStore(memoryStore());
  saveSession("site", { cookies: jar(), values: {} });
  const file = sessionFile("site");
  const env = envelope(file);
  for (const text of [
    `${MAGIC}${JSON.stringify({ ...env, sealed: "api-anything/9" })}`,
    `${MAGIC}${JSON.stringify({ ...env, sealed: 7 })}`,
    `${MAGIC}{"sealed":`,
    `${MAGIC}null`,
    JSON.stringify(env), // the envelope without its first line
    JSON.stringify({ sealed: "something", cookies: [] }),
  ]) {
    writeFileSync(file, text);
    assert.throws(
      () => loadSession("site"),
      (e: unknown) => e instanceof SealError && /integrity check/.test(e.message),
      text.slice(0, 60),
    );
  }
});

test("a missing key-salt.json with passphrase-sealed files is an error, not a new salt; logout resets without the key", async () => {
  setKeyStore(null);
  process.env.API_ANYTHING_KEY = "correct horse battery staple";
  process.env.API_ANYTHING_BROWSER = join(home, "no-such-browser");
  saveSession("site", { cookies: jar(), values: {} });
  rmSync(join(home, "key-salt.json"));
  setKeyStore(null);
  const missing = (e: unknown) =>
    e instanceof SealError &&
    /key-salt\.json is missing/.test(e.message) &&
    /restore the original .*key-salt\.json/.test(e.next) &&
    /api-anything logout/.test(e.next);
  assert.throws(() => loadSession("site"), missing);
  assert.throws(() => saveSession("other", { cookies: [], values: {} }), missing);
  assert.ok(!existsSync(join(home, "key-salt.json")), "no new salt was made");

  await logout("site");
  assert.ok(!existsSync(sessionFile("site")));
  saveSession("site", { cookies: jar(), values: {} });
  assert.ok(existsSync(join(home, "key-salt.json")), "with nothing left to orphan, a new salt is made");
  assert.equal(loadSession("site").cookies[0]!.value, SECRET);
});

const writeCapture = (id: string, at: number) =>
  writeSealed(
    join(home, "captures", `${id}.json`),
    JSON.stringify({
      id,
      at: new Date(at).toISOString(),
      url: "http://127.0.0.1:1/s?q=aaa",
      finalUrl: "http://127.0.0.1:1/s?q=aaa",
      cookies: jar(),
      exchanges: [],
    }),
    `capture:${id}`,
  );
const learnInput = (captures: [string, string]) => ({
  trigger: "http://127.0.0.1:1/s?q={q}",
  args: { q: "aaa" },
  args2: { q: "bbb" },
  args3: { q: "ccc" },
  captures,
});

test("learn_site keeps a sealed capture's own recovery step (the key), not a generic learn-again", async () => {
  process.env.API_ANYTHING_REGISTRY = "http://127.0.0.1:9";
  setKeyStore(null);
  process.env.API_ANYTHING_KEY = "correct horse battery staple";
  writeCapture("k1", Date.now());
  writeCapture("k2", Date.now());
  delete process.env.API_ANYTHING_KEY;
  setKeyStore(null);
  const r = await learnSite(learnInput(["k1", "k2"]));
  assert.equal(r.ok, false);
  assert.match(r.next ?? "", /API_ANYTHING_KEY/);
});

test("learn_site admits its capture pair at one instant: a pair valid when it began is not half-refused at 24 h", async (t) => {
  process.env.API_ANYTHING_REGISTRY = "http://127.0.0.1:9";
  const real = Date.now.bind(Date);
  let jumped = false;
  const store = memoryStore();
  setKeyStore(store);
  const edge = real() - CAPTURE_TTL_MS + 1000;
  writeCapture("p1", edge);
  writeCapture("p2", edge);
  // reading the first capture takes the clock 2 s past the pair's 24 h
  setKeyStore({
    ...store,
    get() {
      jumped = true;
      return store.get();
    },
  });
  t.mock.method(Date, "now", () => real() + (jumped ? 2000 : 0));
  const r = await learnSite(learnInput(["p1", "p2"]));
  assert.ok(jumped, "the clock moved during the learn");
  assert.doesNotMatch(r.error ?? "", /24 h lifetime/);
  assert.ok(existsSync(join(home, "captures", "p2.json")), "the second capture was not refused and deleted");
});

test("status reads a sealed session as sealed (the whole prefix, not a 64-character cut of the JSON)", () => {
  setKeyStore(memoryStore());
  saveSession("site", { cookies: jar(), values: { authorization: "Bearer abcdef" } });
  assert.deepEqual(plaintextProblems(), []);
  assert.deepEqual(status().storage, { sealed: true, key: "memory" });
});
