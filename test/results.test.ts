import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { call } from "../src/execute.js";
import { createServer } from "../src/mcp.js";
import {
  getResult,
  MAX_RESULT_CHARS,
  RESULT_BYTES,
  RESULT_LIMIT,
  RESULT_TTL_MS,
  type ResultCursor,
  resultView,
} from "../src/results.js";
import { isSealedText, type KeyStore, onPlaintext, setKeyStore } from "../src/seal.js";
import { parseSite } from "../src/spec.js";
import { saveSite } from "../src/store.js";
import { type Fixture, startFixture } from "./fixture/server.js";

const HOME = mkdtempSync(join(tmpdir(), "aa-results-"));
process.env.API_ANYTHING_HOME = HOME;
// these tests read the store as the home with no key writes it, and set a key where they seal
delete process.env.API_ANYTHING_KEY;
let fx: Fixture;
const opts = { maxTier: 1 as const, minIntervalMs: 0 };
before(async () => {
  fx = await startFixture();
  saveSite(
    parseSite({
      name: "result-fixture",
      baseUrl: fx.url,
      operations: [
        {
          name: "list",
          readOnly: true,
          request: { method: "GET", url: `${fx.url}/api/result-list?after=` },
          slots: [{ param: "after", at: ["query:after"] }],
          params: [{ name: "after", required: false }],
          trigger: { url: `${fx.url}/` },
          response: { format: "json", extract: "items" },
          paging: { param: "after", next: "next" },
        },
      ],
    }),
  );
});
beforeEach(() => {
  fx.calls.length = 0;
  rmSync(join(HOME, "results.json"), { force: true });
});
after(async () => {
  await fx.close();
  rmSync(HOME, { recursive: true, force: true });
});

test("a cut fixture page is fully retrievable in order without another request; site cursor stays unchanged", async () => {
  const r = await call("result-fixture", "list", {}, opts);
  assert.equal(r.ok, true);
  assert.equal(r.nextPage, "page2");
  assert.equal(r.hasMore, true);
  assert.ok(r.resultId);
  assert.ok(r.more);
  assert.match(r.truncated!, /get_result/);
  const items = [...(r.data as { id: number }[])];
  let more: ResultCursor | undefined = r.more;
  while (more) {
    const next = getResult(more.resultId, more);
    assert.equal(next.ok, true);
    if (!next.ok) return;
    items.push(...(next.data as { id: number }[]));
    more = next.more;
  }
  assert.deepEqual(
    items.map((item) => item.id),
    Array.from({ length: 30 }, (_, i) => i + 1),
  );
  assert.equal(fx.calls.length, 1);
  const last = await call(
    "result-fixture",
    "list",
    { after: r.nextPage },
    {
      ...opts,
      view: { fields: ["id"], maxChars: 2000 },
    },
  );
  assert.equal(last.hasMore, false);
  assert.equal(last.nextPage, undefined);
  assert.equal((last.data as { id: number }[])[0]!.id, 31);
  assert.equal(fx.calls.length, 2);
});

test("a call-only cut page keeps its nextPage warning but names no local continuation", async () => {
  const r = await call("result-fixture", "list", {}, { ...opts, callOnly: true });
  assert.equal(r.ok, true);
  assert.equal(r.nextPage, "page2");
  assert.equal(r.resultId, undefined);
  assert.equal(r.more, undefined);
  assert.match(r.truncated!, /nextPage starts after the last item of this page, cut or not$/);
  assert.doesNotMatch(r.truncated!, /get_result|maxChars|more stays/);
  assert.equal(existsSync(join(HOME, "results.json")), false);
});

test("call views project extracted items with renamed paths, leave the spec untouched, and validate before sending", async () => {
  const spec = readFileSync(join(HOME, "sites", "result-fixture.json"), "utf8");
  const r = await call(
    "result-fixture",
    "list",
    {},
    {
      ...opts,
      view: { fields: ["id", "name=details.label"], maxChars: 2000 },
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.truncated, undefined);
  assert.deepEqual((r.data as unknown[])[0], { id: 1, name: "Label 1" });
  assert.equal(readFileSync(join(HOME, "sites", "result-fixture.json"), "utf8"), spec);
  for (const view of [
    { maxChars: 0 },
    { maxChars: MAX_RESULT_CHARS + 1 },
    { fields: [] },
    { fields: ["bad=x~["] },
    { fields: ["x~^(a+)+$"] },
    { fields: ["x~^(a|aa)+$"] },
    { fields: ['bad=details["\\q"]'] },
  ]) {
    const bad = await call("result-fixture", "list", {}, { ...opts, view });
    assert.equal(bad.class, "input");
  }
  assert.equal(fx.calls.length, 1);
});

test("a write's view never hides the field its readback checks or changes its send count", async () => {
  saveSite(
    parseSite({
      name: "write-result-fixture",
      baseUrl: fx.url,
      operations: [
        {
          name: "add",
          readOnly: false,
          request: {
            method: "POST",
            url: `${fx.url}/api/todos`,
            headers: { "content-type": "application/json" },
            body: '{"title":"fixture title"}',
          },
          slots: [{ param: "title", at: ["body", "json:/title"] }],
          params: [{ name: "title" }],
          trigger: { url: `${fx.url}/` },
          readback: { op: "list", find: { field: "title", equals: "{title}" } },
        },
        {
          name: "list",
          readOnly: true,
          request: { method: "GET", url: `${fx.url}/api/todos` },
          trigger: { url: `${fx.url}/` },
          response: { format: "json", extract: "todos" },
        },
      ],
    }),
  );
  const r = await call(
    "write-result-fixture",
    "add",
    { title: "readback title" },
    {
      ...opts,
      allowWrites: true,
      view: { fields: ["id"], maxChars: 256 },
    },
  );
  assert.equal(r.write, "applied", JSON.stringify(r));
  assert.match(r.reason!, /read back with list: found it/);
  assert.equal(fx.calls.filter((c) => c.method === "POST").length, 1);
});

test("views cannot turn a classified failure into success, and a broken result store cannot fail a successful call", async () => {
  const failed = await call(
    "result-fixture",
    "list",
    {},
    {
      ...opts,
      view: { fields: ["id"] },
      fetchImpl: async () =>
        new Response('{"error":"service unavailable"}', {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.resultId, undefined);
  assert.equal(failed.more, undefined);
  assert.equal(existsSync(join(HOME, "results.json")), false);
  // a store that is not a file cannot be read or replaced: the call still answers, and says what it lost
  mkdirSync(join(HOME, "results.json"));
  try {
    const r = await call("result-fixture", "list", {}, opts);
    assert.equal(r.ok, true);
    assert.equal(r.resultId, undefined);
    assert.equal(r.more, undefined);
    assert.match(r.truncated!, /local retention failed/);
  } finally {
    rmSync(join(HOME, "results.json"), { recursive: true, force: true });
  }
  // a damaged store is an empty one: the answer is kept over it, and none of its text is repeated
  writeFileSync(join(HOME, "results.json"), "corrupt private store", { mode: 0o600 });
  const kept = await call("result-fixture", "list", {}, opts);
  assert.equal(kept.ok, true);
  assert.ok(kept.resultId);
  assert.doesNotMatch(kept.truncated!, /local retention failed|corrupt private store/);
  assert.equal(getResult(kept.resultId).ok, true);
});

test("retained answers can be reprojected, including fields omitted by the initial view", async () => {
  const r = await call(
    "result-fixture",
    "list",
    {},
    {
      ...opts,
      view: { fields: ["id", "body"], maxChars: 4000 },
    },
  );
  assert.ok(r.resultId);
  const next = getResult(r.resultId, { fields: ["id", "label=details.label"], maxChars: 2000 });
  assert.equal(next.ok, true);
  if (!next.ok) return;
  assert.deepEqual((next.data as unknown[])[29], { id: 30, label: "Label 30" });
  assert.equal(next.more, undefined);
  assert.equal(fx.calls.length, 1);
  const absent = getResult(r.resultId, { fields: ["missing"] });
  assert.equal(absent.ok, true);
  if (absent.ok)
    assert.deepEqual(
      absent.data,
      Array.from({ length: 30 }, () => ({})),
    );
  for (const name of ["heals.jsonl", "writes.json", "reports.json"]) {
    if (existsSync(join(HOME, name))) assert.doesNotMatch(readFileSync(join(HOME, name), "utf8"), /Long fixture text/);
  }
});

test("private retained answers expire without extending their TTL, and the oldest are evicted at the count bound", () => {
  const t = Date.now();
  const value = Array.from({ length: 20 }, (_, id) => ({ id, body: "private answer ".repeat(30) }));
  const first = resultView(value, { maxChars: 256 }, t);
  assert.ok(first.resultId);
  assert.equal(statSync(HOME).mode & 0o777, 0o700);
  assert.equal(statSync(join(HOME, "results.json")).mode & 0o777, 0o600);
  assert.equal(getResult(first.resultId, {}, t + RESULT_TTL_MS - 1).ok, true);
  assert.equal(getResult(first.resultId, {}, t + RESULT_TTL_MS).ok, false);
  assert.equal(readFileSync(join(HOME, "results.json"), "utf8"), "[]");
  const ids = Array.from({ length: RESULT_LIMIT + 1 }, () => resultView(value, { maxChars: 256 }, t).resultId!);
  assert.equal(getResult(ids[0]!, {}, t).ok, false);
  assert.equal(getResult(ids[1]!, {}, t).ok, true);
  assert.equal(JSON.parse(readFileSync(join(HOME, "results.json"), "utf8")).length, RESULT_LIMIT);
  assert.equal(getResult("../sites/result-fixture").ok, false);
  assert.equal(getResult(ids[1]!, { offset: -1 }).ok, false);
  assert.equal(getResult(ids[1]!, { offset: 0.5 }).ok, false);
});

test("a home that seals keeps cut answers sealed: an older plaintext store is sealed on first access, and a key error keeps none", () => {
  const sealed = mkdtempSync(join(tmpdir(), "aa-results-sealed-"));
  const store = join(sealed, "results.json");
  const SECRET = "signed-in-answer-row-0123456789";
  const value = Array.from({ length: 20 }, (_, id) => ({ id, body: `${SECRET} `.repeat(30) }));
  const key: { held?: Buffer } = {};
  const memory: KeyStore = {
    name: "memory",
    get: () => key.held,
    put: (k) => {
      key.held ??= k;
    },
  };
  const told: string[] = [];
  process.env.API_ANYTHING_HOME = sealed;
  try {
    // an older version's store, written before answers were sealed
    const t = Date.now();
    const old = { id: "0f0e0d0c-0b0a-4908-8706-050403020100", expiresAt: t + RESULT_TTL_MS, data: value };
    writeFileSync(store, JSON.stringify([old]), { mode: 0o600 });
    setKeyStore(memory);
    // a call whose answer is not cut still reads the store: that access seals it
    assert.deepEqual(resultView([1], {}, t), { data: [1] });
    assert.ok(isSealedText(readFileSync(store, "utf8")), "the plaintext store is sealed on first access");
    assert.equal(getResult(old.id, {}, t).ok, true, "and its answers are still read");
    const first = resultView(value, { maxChars: 256 }, t);
    assert.ok(first.resultId);
    const raw = readFileSync(store, "utf8");
    assert.ok(isSealedText(raw) && !raw.includes(SECRET));
    assert.equal(statSync(store).mode & 0o777, 0o600);
    const back = getResult(first.resultId, { maxChars: 256 }, t);
    assert.equal(back.ok, true);
    // an expired record is dropped by a sealed rewrite too
    assert.equal(getResult(first.resultId, {}, t + RESULT_TTL_MS).ok, false);
    assert.ok(isSealedText(readFileSync(store, "utf8")));

    // the key store fails: the answer is not kept, in plaintext or otherwise, and the call says so
    const kept = resultView(value, { maxChars: 256 }, t);
    assert.ok(kept.resultId);
    const before = readFileSync(store, "utf8");
    setKeyStore({
      name: "flaky",
      get() {
        throw new Error("locked keychain");
      },
      put() {},
    });
    const lost = resultView(value, { maxChars: 256 }, t);
    assert.equal(lost.resultId, undefined);
    assert.match(lost.truncated ?? "", /local retention failed; the full answer is not available/);
    assert.equal(readFileSync(store, "utf8"), before);
    assert.deepEqual(getResult(kept.resultId, {}, t), {
      ok: false,
      class: "error",
      reason: "could not read the local result store",
    });

    // a home with no key store that never sealed: 0600 plaintext, as its sessions are, and no warning for it
    const plain = mkdtempSync(join(tmpdir(), "aa-results-plain-"));
    process.env.API_ANYTHING_HOME = plain;
    setKeyStore(null);
    onPlaintext((why) => told.push(why));
    try {
      const r = resultView(value, { maxChars: 256 }, t);
      assert.ok(r.resultId);
      assert.equal(JSON.parse(readFileSync(join(plain, "results.json"), "utf8")).length, 1);
      assert.equal(statSync(join(plain, "results.json")).mode & 0o777, 0o600);
      assert.deepEqual(told, []);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    process.env.API_ANYTHING_HOME = HOME;
    setKeyStore(undefined);
    onPlaintext(() => {});
    rmSync(sealed, { recursive: true, force: true });
  }
});

test("a store that cannot be opened is an empty one and is written over: another key's, a damaged one, one that is no list", () => {
  const home = mkdtempSync(join(tmpdir(), "aa-results-rekey-"));
  const store = join(home, "results.json");
  const SECRET = "signed-in-answer-row-0123456789";
  const value = Array.from({ length: 20 }, (_, id) => ({ id, body: `${SECRET} `.repeat(30) }));
  const memory = (): KeyStore => {
    let held: Buffer | undefined;
    return {
      name: "memory",
      get: () => held,
      put: (k) => {
        held ??= k;
      },
    };
  };
  const gone = { ok: false, class: "input", reason: "result not found, expired, or evicted" };
  const sealedOnly = () => {
    const raw = readFileSync(store, "utf8");
    assert.ok(isSealedText(raw) && !raw.includes(SECRET), "the store is sealed, never plaintext");
  };
  const passphrase = process.env.API_ANYTHING_KEY;
  process.env.API_ANYTHING_HOME = home;
  try {
    const t = Date.now();
    // sealed with a passphrase, which is then unset: the OS store's key is the one in use
    process.env.API_ANYTHING_KEY = "the first passphrase";
    setKeyStore(null);
    const first = resultView(value, { maxChars: 256 }, t);
    assert.ok(first.resultId);
    delete process.env.API_ANYTHING_KEY;
    setKeyStore(memory());
    // 30 days on, long past the 15 minutes of what the store held
    const later = t + 30 * 24 * 60 * 60_000;
    const second = resultView(value, { maxChars: 256 }, later);
    assert.ok(second.resultId, "a cut answer is kept under the key in use");
    assert.doesNotMatch(second.truncated ?? "", /local retention failed/);
    sealedOnly();
    assert.equal(getResult(second.resultId, {}, later).ok, true);
    assert.deepEqual(getResult(first.resultId, {}, t), gone);

    // another key of the same store (a new Keychain item): a lookup finds nothing, and leaves an empty sealed store
    setKeyStore(memory());
    assert.deepEqual(getResult(second.resultId, {}, later), gone);
    sealedOnly();
    assert.ok(resultView(value, { maxChars: 256 }, later).resultId);

    // a damaged sealed file, damaged plaintext, and JSON that is no list of kept answers
    for (const broken of [
      readFileSync(store, "utf8").slice(0, -24),
      "corrupt private store",
      '{"id":"x"}',
      "[null]",
      '[{"id":7,"expiresAt":"never","data":1}]',
    ]) {
      writeFileSync(store, broken, { mode: 0o600 });
      // a call whose answer is not cut reads the store too
      assert.deepEqual(resultView([1], {}, later), { data: [1] });
      sealedOnly();
      writeFileSync(store, broken, { mode: 0o600 });
      const again = resultView(value, { maxChars: 256 }, later);
      assert.ok(again.resultId, `kept over ${JSON.stringify(broken.slice(0, 24))}`);
      sealedOnly();
      assert.equal(getResult(again.resultId, {}, later).ok, true);
    }

    // starting over with a new passphrase (the old salt deleted) recovers too
    process.env.API_ANYTHING_KEY = "the first passphrase";
    setKeyStore(null);
    rmSync(store);
    assert.ok(resultView(value, { maxChars: 256 }, later).resultId);
    rmSync(join(home, "key-salt.json"));
    process.env.API_ANYTHING_KEY = "another passphrase";
    setKeyStore(null);
    assert.ok(resultView(value, { maxChars: 256 }, later).resultId);
    sealedOnly();

    // a key that cannot be had is still an answer not kept, and the store is left as it is
    const before = readFileSync(store, "utf8");
    process.env.API_ANYTHING_KEY = "not the passphrase";
    setKeyStore(null);
    const lost = resultView(value, { maxChars: 256 }, later);
    assert.equal(lost.resultId, undefined);
    assert.match(lost.truncated ?? "", /local retention failed; the full answer is not available/);
    assert.equal(readFileSync(store, "utf8"), before);
  } finally {
    if (passphrase === undefined) delete process.env.API_ANYTHING_KEY;
    else process.env.API_ANYTHING_KEY = passphrase;
    process.env.API_ANYTHING_HOME = HOME;
    setKeyStore(undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

test("kept answers fit a byte budget: big ones evict the oldest, and one over it alone is not kept", () => {
  const t = Date.now();
  const big = (n: number) => [{ body: "x".repeat(n) }, { body: "y" }];
  const quarter = Math.floor(RESULT_BYTES / 4);
  const ids = Array.from({ length: 5 }, () => resultView(big(quarter), { maxChars: 256 }, t).resultId!);
  assert.ok(ids.every(Boolean));
  assert.equal(getResult(ids[0]!, {}, t).ok, false, "the oldest went to make room");
  assert.equal(getResult(ids[4]!, {}, t).ok, true);
  assert.ok(statSync(join(HOME, "results.json")).size <= RESULT_BYTES);
  const over = resultView(big(RESULT_BYTES), { maxChars: 256 }, t);
  assert.equal(over.resultId, undefined);
  assert.match(over.truncated ?? "", /full answer is not available/);
  assert.equal(getResult(ids[4]!, {}, t).ok, true, "an answer that is not kept evicts nothing");
});

test("in a home that seals, the sealed store on disk fits the byte budget too", () => {
  const home = mkdtempSync(join(tmpdir(), "aa-results-sealed-budget-"));
  const passphrase = process.env.API_ANYTHING_KEY;
  process.env.API_ANYTHING_HOME = home;
  process.env.API_ANYTHING_KEY = "a budget passphrase";
  setKeyStore(null);
  try {
    const t = Date.now();
    const big = (n: number) => [{ body: "x".repeat(n) }, { body: "y" }];
    const quarter = Math.floor(RESULT_BYTES / 4);
    const ids = Array.from({ length: 4 }, () => resultView(big(quarter), { maxChars: 256 }, t).resultId!);
    assert.ok(ids.every(Boolean));
    const store = join(home, "results.json");
    assert.ok(isSealedText(readFileSync(store, "utf8").slice(0, 64)));
    assert.ok(statSync(store).size <= RESULT_BYTES, `${statSync(store).size} bytes`);
    assert.equal(getResult(ids[3]!, {}, t).ok, true);
  } finally {
    if (passphrase === undefined) delete process.env.API_ANYTHING_KEY;
    else process.env.API_ANYTHING_KEY = passphrase;
    process.env.API_ANYTHING_HOME = HOME;
    setKeyStore(undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

test("JSON fragments recover oversized single items, objects, and strings without losing shortened tails", () => {
  for (const value of [
    [{ id: 1, body: '"\\\n😀'.repeat(600) }, { id: 2 }],
    { large: "abcdef".repeat(600), tail: { important: true } },
    "abcdef".repeat(600),
  ]) {
    const first = resultView(value, { maxChars: 256 });
    assert.equal(first.more?.format, "json");
    let more: ResultCursor | undefined = first.more;
    let serialized = "";
    while (more) {
      const r = getResult(more.resultId, more);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.encoding, "json");
      assert.ok(JSON.stringify(r.data).length <= 256);
      serialized += r.data;
      if (r.more) assert.ok(r.more.offset > more.offset);
      more = r.more;
    }
    assert.deepEqual(JSON.parse(serialized), value);
  }
});

test("projected continuations preserve item offsets and their selected view", () => {
  const value = Array.from({ length: 30 }, (_, i) => (i % 2 ? { id: i, name: "n".repeat(50) } : { other: true }));
  const first = resultView(value, { fields: ["id", "name"], maxChars: 256 });
  let more = first.more;
  const got = [...(first.data as unknown[])];
  assert.deepEqual(more?.fields, ["id", "name"]);
  while (more) {
    const r = getResult(more.resultId, more);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    got.push(...(r.data as unknown[]));
    more = r.more;
  }
  assert.deepEqual(
    got,
    value.map((x) => ("id" in x ? x : {})),
  );
});

test("MCP exposes call-level views and local get_result with table compression", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer({
    run: { call: (site, op, args, options) => call(site, op, args, { ...options, ...opts }) },
  });
  const client = new Client({ name: "results-test", version: "0" });
  try {
    await server.connect(a);
    await client.connect(b);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.find((t) => t.name === "get_result")!.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse((r.content as { text: string }[])[0]!.text);
    };
    const first = await tool("call_operation", {
      site: "result-fixture",
      op: "list",
      view: { fields: ["id", "body"], maxChars: 4000 },
    });
    assert.ok(first.resultId);
    const next = await tool("get_result", {
      resultId: first.resultId,
      fields: ["id", "name=details.label"],
      maxChars: 2000,
    });
    assert.equal(next.ok, true);
    assert.deepEqual(next.data.columns, ["id", "name"]);
    assert.deepEqual(next.data.rows[29], [30, "Label 30"]);
    assert.equal(fx.calls.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("CLI call views and result retrieval work across separate processes", async () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = (...args: string[]) =>
    new Promise<{ code: number; data: Record<string, unknown> }>((resolve) =>
      execFile(
        process.execPath,
        ["--import", "tsx", cli, ...args],
        { env: { ...process.env, API_ANYTHING_HOME: HOME }, timeout: 120_000 },
        (err, stdout) => resolve({ code: err ? 1 : 0, data: JSON.parse(stdout) }),
      ),
    );
  const first = await run(
    "call",
    "result-fixture",
    "list",
    "--max-tier",
    "1",
    "--fields",
    "id,body",
    "--max-chars",
    "4000",
  );
  assert.equal(first.code, 0);
  assert.ok(first.data.resultId);
  const next = await run(
    "result",
    String(first.data.resultId),
    "--offset",
    "1",
    "--fields",
    "id,name=details.label",
    "--max-chars",
    "2000",
  );
  assert.equal(next.code, 0);
  assert.deepEqual((next.data.data as unknown[])[0], { id: 2, name: "Label 2" });
  assert.equal(fx.calls.length, 1);
  const missing = await run("result", "not-an-id");
  assert.equal(missing.code, 1);
});
