/**
 * The local call log (calls.jsonl) and `status`, the health view built from it and the rest of the
 * home: stale marks, cool-downs, remembered tiers, the heal log, verify's record and the write ledger.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { recordCases } from "../src/checks.js";
import { call } from "../src/execute.js";
import { createServer } from "../src/mcp.js";
import { parseSite } from "../src/spec.js";
import { status } from "../src/status.js";
import {
  appendCall,
  appendHeal,
  beginWrite,
  type CallEntry,
  coolDown,
  loadCalls,
  loadSite,
  markStale,
  rememberTier,
  saveSite,
  settleWrite,
} from "../src/store.js";
import { type Fixture, startFixture } from "./fixture/server.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DAY = 24 * 60 * 60_000;
const NEEDLE = "needle-arg-4711";

let fx: Fixture;
let home: string;
before(async () => (fx = await startFixture()));
after(() => fx.close());
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aa-status-"));
  process.env.API_ANYTHING_HOME = home;
});

const callsText = () => readFileSync(join(home, "calls.jsonl"), "utf8");

/** demo: three reads and a write against the fixture. */
function saveDemo(base = fx.url): void {
  const read = (name: string) => ({
    name,
    readOnly: true,
    request: { method: "GET", url: `${base}/api/scoped?q=books` },
    slots: [{ param: "q", at: ["query:q"] }],
    params: [{ name: "q", example: "books" }],
    trigger: { url: `${base}/` },
  });
  saveSite(
    parseSite({
      name: "demo",
      baseUrl: base,
      operations: [
        read("feed"),
        read("get"),
        read("list"),
        {
          name: "follow",
          readOnly: false,
          request: { method: "POST", url: `${base}/api/follow?user=ann` },
          slots: [{ param: "user", at: ["query:user"] }],
          params: [{ name: "user" }],
          trigger: { url: `${base}/` },
        },
      ],
    }),
  );
}

test("a finished call appends one line of names, enums and numbers: never its args or its data", async () => {
  saveDemo();
  const opts = { maxTier: 1 as const, minIntervalMs: 0 };
  assert.equal((await call("demo", "get", { q: NEEDLE }, opts)).ok, true);
  assert.equal((await call("demo", "follow", { user: NEEDLE }, { ...opts, allowWrites: true })).write, "accepted");
  assert.equal((await call("demo", "get", { nope: NEEDLE }, opts)).class, "input");
  const text = callsText();
  assert.ok(!text.includes(NEEDLE), text);
  assert.ok(!text.includes("one"), "the answer's data is not kept");
  const lines = text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  for (const l of lines) {
    for (const k of Object.keys(l)) assert.ok(/^(at|site|op|class|tier|ms|healed|write)$/.test(k), k);
    assert.equal(typeof l.ms, "number");
  }
  assert.deepEqual(
    lines.map(({ at: _a, ms: _m, ...l }) => l),
    [
      { site: "demo", op: "get", class: "ok", tier: 1 },
      { site: "demo", op: "follow", class: "ok", tier: 1, write: "accepted" },
      // refused before anything was sent: no tier answered it
      { site: "demo", op: "get", class: "input" },
    ],
  );
});

test("the call log drops entries past 30 days and keeps under its cap, without a rewrite per call", () => {
  const e: CallEntry = { site: "s", op: "o", class: "ok", tier: 1, ms: 5 };
  const now = Date.now();
  const line = (at: number) => `${JSON.stringify({ at: new Date(at).toISOString(), ...e })}\n`;
  const file = join(home, "calls.jsonl");

  // 29 days old: inside the 30 days kept, so the append leaves the file as it was and adds one line
  writeFileSync(file, line(now - 29 * DAY));
  appendCall(e, now);
  assert.equal(callsText(), line(now - 29 * DAY) + line(now));

  // a line a day past the 30 days: the file is rewritten without it
  writeFileSync(file, line(now - 32 * DAY) + line(now - 2 * DAY));
  appendCall(e, now);
  assert.equal(callsText(), line(now - 2 * DAY) + line(now));
  assert.equal(loadCalls(undefined, now).length, 2);
  // read without a window of its own, the log gives status the last week; asked, up to the 30 days
  writeFileSync(file, line(now - 30.5 * DAY) + line(now - 7.5 * DAY) + line(now - DAY));
  assert.equal(loadCalls(undefined, now).length, 1);
  assert.equal(loadCalls(undefined, now, 30 * DAY).length, 2);
  assert.equal(loadCalls(undefined, now, 90 * DAY).length, 2, "never past the 30 days kept");

  // over the cap within the 30 days: the newest half stays
  writeFileSync(file, Array.from({ length: 16_000 }, (_, i) => line(now - DAY + i)).join(""));
  assert.ok(statSync(file).size > 1_000_000);
  appendCall({ ...e, op: "newest" }, now);
  assert.ok(statSync(file).size < 1_000_000);
  const kept = loadCalls(undefined, now);
  assert.equal(kept.length, 8_000);
  assert.equal(kept.at(-1)!.op, "newest");
});

test("status assembles each op's health from a seeded home, and gives each problem its next step", () => {
  saveDemo("https://demo.example.com");
  const now = Date.now();
  coolDown("demo", { class: "rate", reason: "HTTP 429" }, 60_000);
  markStale("demo", "get", "drifted again within 10 min of a heal (HTTP 404)");
  rememberTier("demo", "feed", 3);
  appendHeal({ site: "demo", op: "get", strategy: "rescan", diff: "query:v 1 -> 2" }, now - 2 * DAY);
  const get = loadSite("demo")!.site.operations.find((o) => o.name === "get")!;
  recordCases("demo", get, [
    { op: "get", case: "example", expect: "result", outcome: "fail", got: "empty", next: "api-anything heal demo get" },
  ]);
  for (const [args, settled] of [
    [{ user: "secret-user-1" }, "accepted"],
    [{ user: "secret-user-2" }, "may_have_applied"],
  ] as const) {
    const g = beginWrite("demo", "follow", args);
    assert.ok(g.send);
    settleWrite(g.id, settled, { ok: settled === "accepted", class: settled === "accepted" ? "ok" : "error" });
  }
  const log = (op: string, at: number, c: Partial<CallEntry> = {}) =>
    appendCall({ site: "demo", op, class: "ok", tier: 1, ms: 4, ...c }, at);
  // feed: plain HTTP for days, then every call at tier 3 (the scout's signed feed)
  for (let i = 0; i < 4; i++) log("feed", now - 3 * DAY + i);
  for (let i = 0; i < 4; i++) log("feed", now - 60_000 + i, { tier: 3, ms: 700 });
  // get: ok for days, then drift; its heal came after its last ok call
  for (let i = 0; i < 4; i++) log("get", now - 3 * DAY - 10 + i);
  for (let i = 0; i < 3; i++) log("get", now - 50_000 + i, { class: "drift" });
  // list: ok for days, then mostly signed out, its last call ok again
  for (let i = 0; i < 4; i++) log("list", now - 3 * DAY - 20 + i);
  for (const c of ["auth", "auth", "auth", "ok"]) log("list", now - 40_000, { class: c });

  const s = status("demo", now);
  assert.equal(s.sites.length, 1);
  const site = s.sites[0]!;
  const op = (name: string) => site.ops.find((o) => o.op === name)!;
  const problem = (name: string, op?: string) => s.problems.find((p) => p.problem === name && p.op === op);

  assert.equal(site.cooling?.class, "rate");
  assert.match(problem("cooling")!.next, /wait until .*--force/);

  assert.match(op("get").stale!.reason, /drifted again/);
  assert.match(problem("stale", "get")!.next, /^api-anything heal demo get/);
  assert.deepEqual(op("get").lastHeal, { at: new Date(now - 2 * DAY).toISOString(), strategy: "rescan" });
  assert.deepEqual(op("get").lastVerify && { ...op("get").lastVerify, at: "" }, {
    at: "",
    outcome: "fail",
    current: true,
  });
  assert.equal(problem("verify", "get")!.next, "api-anything heal demo get");
  assert.equal(op("get").calls!.last.class, "drift");
  assert.match(problem("failing", "get")!.detail, /ok rate 0% in the last 24 h, 100% the 6 days before/);
  assert.match(problem("failing", "get")!.next, /api-anything heal demo get.*api-anything revert demo get/);

  // the escalation `ops` never showed: remembered tier 3 over the op's own 1, and the days it took
  assert.deepEqual(op("feed").tier, { remembered: 3, minTier: 1 });
  assert.match(op("feed").degraded!, /tier 3 \(median 700 ms\), the 6 days before at tier 1 \(median 4 ms\)/);
  assert.deepEqual(op("feed").calls!["24h"], { calls: 4, ok: 1, tiers: { 3: 4 }, heals: 0, medianMs: 700 });
  assert.deepEqual(op("feed").calls!["7d"]!.tiers, { 1: 4, 3: 4 });
  assert.match(problem("escalated", "feed")!.next, /^api-anything call demo feed q=books --max-tier 1 /);
  // one problem for it, not two
  assert.equal(problem("degraded", "feed"), undefined);

  assert.match(op("list").degraded!, /ok rate 25%/);
  assert.match(problem("degraded", "list")!.next, /api-anything login demo/);
  assert.equal(problem("failing", "list"), undefined);

  assert.deepEqual(op("follow").writes, { accepted: 1, mayHaveApplied: 1 });
  assert.match(problem("write", "follow")!.next, /check the site/);
  // the ledger's args never reach the view
  assert.ok(!JSON.stringify(s).includes("secret-user"));

  // without a site: only the sites with something on record, not every bundled one
  assert.deepEqual(
    status(undefined, now).sites.map((x) => x.site),
    ["demo"],
  );
});

test("a site with nothing on record lists its ops with nothing to say, and no problems", () => {
  saveDemo("https://demo.example.com");
  const s = status("demo");
  assert.deepEqual(s.sites[0]!.ops, [{ op: "feed" }, { op: "get" }, { op: "list" }, { op: "follow" }]);
  assert.deepEqual(s.problems, []);
  assert.deepEqual(status().sites, []);
});

test("a verify that passed one case and could not test another is inconclusive, as verify itself says", () => {
  saveDemo("https://demo.example.com");
  const get = loadSite("demo")!.site.operations.find((o) => o.name === "get")!;
  recordCases("demo", get, [
    { op: "get", case: "example", expect: "result", outcome: "pass", got: "result" },
    { op: "get", case: "check 1", expect: "result", outcome: "inconclusive", got: "rate" },
  ]);
  const op = status("demo").sites[0]!.ops.find((o) => o.op === "get")!;
  assert.equal(op.lastVerify?.outcome, "inconclusive");
});

test("site_status over MCP is a local read, and names its steps in MCP terms", async () => {
  saveDemo("https://demo.example.com");
  appendCall({ site: "demo", op: "get", class: "auth", tier: 1, ms: 3 });
  const client = new Client({ name: "probe", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  await client.connect(b);
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === "site_status");
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const r = await client.callTool({ name: "site_status", arguments: { site: "demo" } });
    const body = JSON.parse((r.content as { text: string }[])[0]!.text);
    assert.equal(body.problems[0].problem, "failing");
    assert.match(body.problems[0].next, /ask the user to run in a terminal: api-anything login demo/);
    const missing = await client.callTool({ name: "site_status", arguments: { site: "nosuch" } });
    assert.equal(missing.isError, true);
  } finally {
    await client.close();
  }
});

test("the CLI prints status as compact JSON, and refuses a site it does not know", async () => {
  saveDemo("https://demo.example.com");
  const run = (...args: string[]) =>
    new Promise<{ code: number; stdout: string }>((resolve) =>
      execFile(
        process.execPath,
        ["--import", "tsx", join(ROOT, "src", "cli.ts"), ...args],
        { cwd: ROOT, env: { ...process.env, API_ANYTHING_HOME: home } },
        (err, stdout) => resolve({ code: err ? Number(err.code ?? 1) : 0, stdout }),
      ),
    );
  const ok = await run("status", "demo");
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(ok.stdout).sites[0].site, "demo");
  const bad = await run("status", "nosuch");
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  rmSync(home, { recursive: true, force: true });
});

test("status reports a settings.json that cannot be read, with the way back, never its text", () => {
  const file = join(home, "settings.json");
  const settings = () => status().problems.filter((p) => p.problem === "settings");
  assert.deepEqual(settings(), []);
  writeFileSync(file, '{"share": SECRETX');
  const [p] = settings();
  assert.equal(p?.site, "*");
  assert.match(p!.detail, /settings\.json is not valid JSON: until it reads, this install is local-only/);
  assert.match(p!.next, /api-anything setup --local-only --share-only/);
  assert.doesNotMatch(JSON.stringify(p), /SECRETX/);
  writeFileSync(file, "[]");
  assert.match(settings()[0]!.detail, /is not a JSON object/);
  rmSync(file);
  mkdirSync(file);
  assert.match(settings()[0]!.detail, /settings\.json cannot be read \(EISDIR\)/);
  assert.match(status("demo").problems.find((x) => x.problem === "settings")!.detail, /EISDIR/, "with a site too");
});

test("an example is spelled in a next command only when no shell reads it; any other is left for the caller to put in", () => {
  const read = (name: string, example: unknown) => ({
    name,
    readOnly: true,
    request: { method: "GET", url: "https://demo.example.com/api/scoped?q=books" },
    slots: [{ param: "q", at: ["query:q"] }],
    params: [{ name: "q", example }],
    trigger: { url: "https://demo.example.com/" },
  });
  // what a spec's author can write as an example: each ends a quoted argument in cmd.exe or PowerShell
  const hostile = [
    "x&echo MARKER-AMP&rem ",
    "y'; echo MARKER-SEMI; '",
    'z"|echo MARKER-PIPE|"',
    "$(id)",
    "`id`",
    "a b",
    "%PATH%",
    "a,b",
    "@x",
    "~",
  ];
  const plain = ["books", "rare-orchids_2", "v1.2", "en/US", "10:30", "a+b", 42, true];
  const examples = [...hostile, ...plain];
  saveSite(
    parseSite({
      name: "demo",
      baseUrl: "https://demo.example.com",
      operations: examples.map((e, i) => read(`op${i}`, e)),
    }),
  );
  for (const i of examples.keys()) rememberTier("demo", `op${i}`, 2);
  const s = status("demo");
  const next = (i: number) => s.problems.find((p) => p.problem === "escalated" && p.op === `op${i}`)!.next;
  for (const [i, e] of hostile.entries()) {
    assert.ok(next(i).startsWith(`api-anything call demo op${i} q=<q> --max-tier 1 `), `${e}: ${next(i)}`);
    assert.ok(!next(i).includes(e), `${e} is not in the command`);
    assert.match(next(i), /put a value for q in place of <q>/);
  }
  for (const [n, e] of plain.entries()) {
    const i = hostile.length + n;
    assert.ok(next(i).startsWith(`api-anything call demo op${i} q=${e} --max-tier 1 tries tier 1 again`), next(i));
  }
});
