/** What a scheduled caller needs: a read's cache, what changed since last time, and a site's request budget. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callReads } from "../src/batch.js";
import { BudgetSpent, envPace, parseDuration, sitePace } from "../src/budget.js";
import { capChanges, changesOf } from "../src/changes.js";
import { call } from "../src/execute.js";
import { createServer } from "../src/mcp.js";
import { saveSession } from "../src/session.js";
import { cacheKey, clock, KEEP_SNAPSHOT_MS, opPrint, prune, saveSnapshot } from "../src/snapshots.js";
import { parseSite, type Site } from "../src/spec.js";
import { cooling, reserveSend, saveSite } from "../src/store.js";
import { vetShared } from "../src/vet.js";
import { type Fixture, LISTINGS, startFixture } from "./fixture/server.js";

const run1 = promisify(execFile);
const HOME = mkdtempSync(join(tmpdir(), "aa-watch-"));
process.env.API_ANYTHING_HOME = HOME;
const SNAPS = join(HOME, "snapshots");
const opts = { maxTier: 1 as const, minIntervalMs: 0 };
let fx: Fixture;

const list = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  readOnly: true,
  request: { method: "GET", url: `${fx.url}/api/listings?q=` },
  slots: [{ param: "q", at: ["query:q"] }],
  params: [{ name: "q", required: false, default: "" }],
  trigger: { url: `${fx.url}/` },
  match: { path: "/api/listings" },
  response: { format: "json", extract: "listings", ...extra },
});

const board = (name: string, more: Partial<Site> = {}) =>
  parseSite({
    name,
    baseUrl: fx.url,
    ...more,
    operations: [
      list("listings"),
      list("byRef", { key: "ref" }),
      list("bare", { pick: ["title", "price"] }),
      // a flat field named with a dot, told apart by it
      list("bySeller", { pick: ["title", "price", "seller.name"], key: '["seller.name"]' }),
      {
        ...list("page"),
        slots: [{ param: "n", at: ["query:n"] }],
        params: [{ name: "n", type: "number", required: true }],
      },
      {
        name: "listing",
        readOnly: true,
        request: { method: "GET", url: `${fx.url}/api/listings/a1` },
        slots: [{ param: "id", at: ["path:2"] }],
        params: [{ name: "id" }],
        trigger: { url: `${fx.url}/` },
        match: { path: "/api/listings/*" },
        response: { format: "json", extract: "listing" },
      },
      {
        name: "add",
        readOnly: false,
        request: {
          method: "POST",
          url: `${fx.url}/api/listings`,
          headers: { "content-type": "application/json" },
          body: '{"title":"x","price":1}',
        },
        slots: [{ param: "title", at: ["body", "json:/title"] }],
        params: [{ name: "title" }],
        trigger: { url: `${fx.url}/` },
        match: { method: "POST", path: "/api/listings" },
        response: { format: "json", extract: "listing" },
      },
      {
        name: "addChecked",
        readOnly: false,
        request: {
          method: "POST",
          url: `${fx.url}/api/listings`,
          headers: { "content-type": "application/json" },
          body: '{"title":"x","price":1}',
        },
        slots: [{ param: "title", at: ["body", "json:/title"] }],
        params: [{ name: "title" }],
        trigger: { url: `${fx.url}/` },
        match: { method: "POST", path: "/api/listings" },
        response: { format: "json", extract: "listing" },
        readback: { op: "listings", args: { q: "{title}" }, find: { field: "title", equals: "{title}" } },
      },
    ],
  });

const snapshots = () => (existsSync(SNAPS) ? readdirSync(SNAPS).filter((f) => f.endsWith(".json")) : []);

before(async () => {
  fx = await startFixture();
  saveSite(board("board"));
});
// each test starts from the same board, clock and home: no answer, slot, count or cool-down left by another
let now = Date.now();
beforeEach(() => {
  fx.resetListings();
  fx.calls.length = 0;
  for (const f of ["snapshots", "results.json", "pace.json", "sends.json", "state.json", "writes.json", "sessions"])
    rmSync(join(HOME, f), { recursive: true, force: true });
  delete process.env.API_ANYTHING_PACE;
  now = Date.now();
  clock.now = () => now;
});
afterEach(() => {
  clock.now = () => Date.now();
});
/** move the snapshots' clock on, with no wait */
const later = (ms: number) => {
  now += ms;
};
after(async () => {
  await fx.close();
  rmSync(HOME, { recursive: true, force: true });
});

test("maxAgeMs: a miss sends and keeps the answer, a hit sends nothing, other args miss", async () => {
  const first = await call("board", "listings", {}, { ...opts, maxAgeMs: 60_000 });
  assert.equal(first.ok, true);
  assert.equal(first.cached, undefined);
  assert.equal(fx.calls.length, 1);
  assert.equal(snapshots().length, 1);
  const file = join(SNAPS, snapshots()[0]!);
  assert.equal(statSync(file).mode & 0o777, 0o600, "the answer may hold the user's data");

  fx.listings.pop();
  const hit = await call("board", "listings", { q: "" }, { ...opts, maxAgeMs: 60_000 });
  assert.equal(hit.ok, true);
  assert.equal(hit.cached, true);
  assert.ok(hit.ageMs! >= 0 && hit.ageMs! < 60_000);
  assert.equal(hit.tier, undefined, "nothing was sent");
  assert.equal((hit.data as unknown[]).length, 3, "the kept answer, not the site's new one");
  assert.equal(fx.calls.length, 1, "a default filled in is the same args");

  const other = await call("board", "listings", { q: "desk" }, { ...opts, maxAgeMs: 60_000 });
  assert.equal(other.cached, undefined);
  assert.equal(fx.calls.length, 2);

  // no maxAgeMs: no cache, and nothing kept
  rmSync(SNAPS, { recursive: true, force: true });
  await call("board", "listings", { q: "chair" }, opts);
  assert.deepEqual(snapshots(), []);
});

test("maxAgeMs: an answer older than asked is a miss, and the view shapes a hit", async () => {
  await call("board", "listings", {}, { ...opts, maxAgeMs: 10 });
  later(11);
  const late = await call("board", "listings", {}, { ...opts, maxAgeMs: 10 });
  assert.equal(late.cached, undefined);
  assert.equal(fx.calls.length, 2);
  const hit = await call("board", "listings", {}, { ...opts, maxAgeMs: 60_000, view: { fields: ["title"] } });
  assert.equal(hit.cached, true);
  assert.deepEqual(hit.data, [{ title: "Desk" }, { title: "Chair" }, { title: "Lamp" }]);
  const bad = await call("board", "listings", {}, { ...opts, maxAgeMs: -1 });
  assert.equal(bad.class, "input");
  assert.equal(fx.calls.length, 2);
});

test("maxAgeMs never serves a failure: only ok answers are kept", async () => {
  fx.failListings(500);
  const failed = await call("board", "listings", {}, { ...opts, maxAgeMs: 60_000 });
  assert.equal(failed.ok, false);
  assert.deepEqual(snapshots(), []);
  const ok = await call("board", "listings", {}, { ...opts, maxAgeMs: 60_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.cached, undefined, "the failure was not kept, so this one was sent");
  // a fresh call that fails leaves the last ok answer in place
  fx.failListings(500);
  later(1);
  const again = await call("board", "listings", {}, { ...opts, maxAgeMs: 0 });
  assert.equal(again.ok, false);
  const hit = await call("board", "listings", {}, { ...opts, maxAgeMs: 60_000 });
  assert.equal(hit.cached, true);
  assert.equal(hit.ok, true);
  assert.equal(fx.calls.length, 3);
});

test("changes: first, then items added, removed and changed, told apart by id", async () => {
  const first = await call("board", "listings", {}, { ...opts, changes: true });
  assert.deepEqual(first.changes, { first: true });
  assert.equal((first.data as unknown[]).length, 3);

  fx.listings[0]!.price = 99;
  fx.listings.splice(1, 1);
  fx.listings.push({ id: "d4", ref: "R-4", title: "Rug", price: 70 });
  const next = await call("board", "listings", {}, { ...opts, changes: true });
  assert.equal(next.ok, true);
  const c = next.changes as Extract<NonNullable<typeof next.changes>, { since: string }>;
  assert.equal(c.key, "id");
  assert.ok(Date.parse(c.since) <= Date.now());
  assert.deepEqual(c.added, [{ id: "d4", ref: "R-4", title: "Rug", price: 70 }]);
  assert.deepEqual(
    c.removed.map((x) => (x as { id: string }).id),
    ["b2"],
  );
  assert.deepEqual(c.changed, [
    { key: "a1", item: { ...LISTINGS()[0], price: 99 }, fields: ["price"], was: { price: 120 } },
  ]);
  assert.equal(c.unchanged, 1);

  const same = await call("board", "listings", {}, { ...opts, changes: true });
  const s = same.changes as typeof c;
  assert.deepEqual([s.added, s.removed, s.changed, s.unchanged], [[], [], [], 3]);
});

test("changesOnly answers the changes without data, and keeps no result view", async () => {
  const first = await call("board", "listings", {}, { ...opts, changesOnly: true });
  assert.deepEqual(first.changes, { first: true });
  assert.equal("data" in first, false);
  fx.listings.push({ id: "e5", title: "Shelf", price: 30 });
  const r = await call("board", "listings", {}, { ...opts, changesOnly: true });
  assert.equal(r.ok, true);
  assert.equal("data" in r, false);
  assert.equal(r.resultId, undefined);
  assert.deepEqual((r.changes as { added: unknown[] }).added, [{ id: "e5", title: "Shelf", price: 30 }]);
  assert.equal(existsSync(join(HOME, "results.json")), false);
});

test("changes: a declared key keeps an item's identity; with no id an item is its hash", async () => {
  await call("board", "byRef", {}, { ...opts, changes: true });
  fx.listings[1]!.id = "renumbered";
  const r = await call("board", "byRef", {}, { ...opts, changes: true });
  const c = r.changes as {
    key: string;
    added: unknown[];
    removed: unknown[];
    changed: { key: string; fields: string[] }[];
  };
  assert.equal(c.key, "ref");
  assert.deepEqual([c.added, c.removed], [[], []]);
  assert.deepEqual(
    c.changed.map((x) => [x.key, x.fields]),
    [["R-2", ["id"]]],
  );

  // by id the same edit is one item gone and one new
  await call("board", "listings", {}, { ...opts, changes: true });
  fx.listings[1]!.id = "again";
  const byId = (await call("board", "listings", {}, { ...opts, changes: true })).changes as typeof c;
  assert.equal(byId.added.length, 1);
  assert.equal(byId.removed.length, 1);

  // pick keeps no id-like field: each item is a hash of itself
  await call("board", "bare", {}, { ...opts, changes: true });
  fx.listings[0]!.price = 1;
  const bare = (await call("board", "bare", {}, { ...opts, changes: true })).changes as typeof c;
  assert.equal(bare.key, "hash");
  assert.deepEqual(bare.added, [{ title: "Desk", price: 1 }]);
  assert.deepEqual(bare.removed, [{ title: "Desk", price: 120 }]);
  assert.deepEqual(bare.changed, []);
});

test("changes compare what the view returned, and still match items by the id it left out", async () => {
  const view = { fields: ["title"] };
  await call("board", "listings", {}, { ...opts, changes: true, view });
  fx.listings[0]!.price = 1;
  const priced = (await call("board", "listings", {}, { ...opts, changes: true, view })).changes as {
    changed: unknown[];
    unchanged: number;
  };
  assert.deepEqual(priced.changed, [], "price is not in the view");
  assert.equal(priced.unchanged, 3);
  fx.listings[2]!.title = "Floor lamp";
  const r = await call("board", "listings", {}, { ...opts, changes: true, view });
  assert.deepEqual(r.data, [{ title: "Desk" }, { title: "Chair" }, { title: "Floor lamp" }]);
  assert.deepEqual((r.changes as { changed: unknown[] }).changed, [
    { key: "c3", item: { title: "Floor lamp" }, fields: ["title"], was: { title: "Lamp" } },
  ]);
});

test("changes of a single object are its field paths", async () => {
  const first = await call("board", "listing", { id: "a1" }, { ...opts, changes: true });
  assert.deepEqual(first.changes, { first: true });
  fx.listings[0]!.price = 100;
  fx.listings[0]!.seller = { name: "Ann B." };
  delete fx.listings[0]!.url;
  const r = await call("board", "listing", { id: "a1" }, { ...opts, changes: true });
  const c = r.changes as { added: unknown[]; removed: unknown[]; changed: unknown[]; unchanged: number; key?: string };
  assert.equal(c.key, undefined);
  assert.deepEqual(c.changed, [
    { path: "price", from: 120, to: 100 },
    { path: "seller.name", from: "Ann", to: "Ann B." },
  ]);
  assert.deepEqual(c.removed, [{ path: "url", from: "/l/a1" }]);
  assert.deepEqual(c.added, []);
  assert.equal(c.unchanged, 3);
});

test("a write is never cached or kept, whatever it is asked", async () => {
  const w = { ...opts, allowWrites: true, maxAgeMs: 60_000, changes: true };
  const a = await call("board", "add", { title: "Stool" }, w);
  assert.equal(a.ok, true);
  assert.equal(a.changes, undefined);
  const b = await call("board", "add", { title: "Stool" }, { ...w, again: true });
  assert.equal(b.ok, true);
  assert.equal(b.cached, undefined);
  assert.equal(fx.calls.filter((c) => c.method === "POST").length, 2);
  assert.deepEqual(snapshots(), []);
});

test("a site's per-hour budget answers rate with retryAfterMs and sends nothing", async () => {
  saveSite(board("capped", { pace: { perHour: 2 } }));
  for (const q of ["a", "b"])
    assert.equal((await call("capped", "listings", { q }, { ...opts, maxAgeMs: 0 })).ok, true);
  const r = await call("capped", "listings", { q: "c" }, opts);
  assert.equal(r.ok, false);
  assert.equal(r.class, "rate");
  assert.equal(r.budget, true);
  assert.equal(r.retry, "after_wait");
  assert.ok(r.retryAfterMs! > 3_500_000 && r.retryAfterMs! <= 3_600_000, String(r.retryAfterMs));
  assert.match(r.reason!, /2 requests an hour/);
  assert.equal(fx.calls.length, 2);
  // a kept answer is still served with the budget spent, and spends nothing
  const hit = await call("capped", "listings", { q: "a" }, { ...opts, maxAgeMs: 60_000 });
  assert.equal(hit.cached, true);
  assert.equal(fx.calls.length, 2);
  // the environment lifts it (0) or sets one for a site with none
  process.env.API_ANYTHING_PACE = "capped:perHour=0";
  assert.equal((await call("capped", "listings", { q: "e" }, opts)).ok, true);
  saveSite(board("uncapped"));
  process.env.API_ANYTHING_PACE = "perHour=5,uncapped:perHour=1";
  assert.equal((await call("uncapped", "listings", {}, opts)).ok, true);
  const env = await call("uncapped", "listings", {}, opts);
  assert.equal(env.budget, true);
  process.env.API_ANYTHING_PACE = "perHour=often";
  const bad = await call("uncapped", "listings", {}, opts);
  assert.equal(bad.class, "error");
  assert.match(bad.reason!, /API_ANYTHING_PACE/);
});

test("a site's interval paces its sends, and a wait past 10 s answers rate instead", async () => {
  saveSite(board("slow", { pace: { minIntervalMs: 60_000 } }));
  const t = Date.now();
  assert.equal((await call("slow", "listings", {}, opts)).ok, true);
  assert.ok(Date.now() - t < 5_000, "an idle site waits for nothing");
  const r = await call("slow", "listings", {}, opts);
  assert.equal(r.class, "rate");
  assert.equal(r.budget, true);
  assert.ok(r.retryAfterMs! > 10_000 && r.retryAfterMs! <= 78_000, String(r.retryAfterMs));
  assert.equal(fx.calls.length, 1);
  // a write is held back before its ledger: not sent
  const w = await call("slow", "add", { title: "x" }, { ...opts, allowWrites: true });
  assert.equal(w.class, "rate");
  assert.equal(w.write, "not_sent");
});

test("the budget parses from the environment over the spec", () => {
  assert.deepEqual(
    [parseDuration("30s"), parseDuration("10m"), parseDuration("2h"), parseDuration("1d"), parseDuration("1.5s")],
    [30_000, 600_000, 7_200_000, 86_400_000, 1500],
  );
  assert.equal(parseDuration("30"), undefined);
  assert.equal(parseDuration("soon"), undefined);
  assert.deepEqual(envPace("gf", "interval=2s perHour=60,gf:perHour=30,other:interval=1m"), {
    minIntervalMs: 2000,
    perHour: 30,
  });
  assert.throws(() => envPace("gf", "fast"), /API_ANYTHING_PACE/);
  const site = parseSite({ name: "s", baseUrl: "https://s.test", pace: { minIntervalMs: 5000, perHour: 10 } });
  assert.deepEqual(sitePace(site, ""), { minIntervalMs: 5000, perHour: 10 });
  assert.deepEqual(sitePace(site, "s:interval=0,perHour=3"), { perHour: 3 });
});

test("the shared rules bound pace and check a declared key", () => {
  const spec = (pace: unknown, key?: string) =>
    parseSite({
      name: "v",
      baseUrl: "https://example.com",
      pace,
      operations: [
        {
          name: "list",
          readOnly: true,
          request: { method: "GET", url: "https://example.com/api" },
          trigger: { url: "https://example.com/" },
          match: { path: "/api" },
          response: { extract: "items", pick: ["id", "title"], ...(key ? { key } : {}) },
        },
      ],
    });
  assert.deepEqual(vetShared(spec({ minIntervalMs: 2000, perHour: 60 }, "id")).errors, []);
  const errors = vetShared(spec({ minIntervalMs: 10, perHour: 2000 }, "price")).errors.join("\n");
  assert.match(errors, /pace minIntervalMs is 10/);
  assert.match(errors, /pace perHour is 2000/);
  // a shared spec cannot hold a site's callers a minute or more apart
  assert.match(vetShared(spec({ minIntervalMs: 120_000 })).errors.join("\n"), /pace minIntervalMs is 120000/);
  assert.match(errors, /response key price is no field it returns/);
  assert.match(vetShared(spec(undefined, "a[*]")).errors.join("\n"), /not a path to one value/);
});

test("changes too large for maxChars are cut and say so", () => {
  const before = { full: [], shown: [] };
  const items = Array.from({ length: 200 }, (_, i) => ({ id: i, text: "x".repeat(100) }));
  const c = capChanges(changesOf(before, { full: items, shown: items }, Date.now()), 2000);
  assert.ok(JSON.stringify(c).length <= 2000);
  assert.match((c as { truncated: string }).truncated, /cut \d+ added/);
});

test("snapshots unused for 30 days are pruned", async () => {
  await call("board", "listings", {}, { ...opts, changes: true });
  assert.equal(snapshots().length, 2, "the cache entry, and the default watcher's baseline");
  const old = new Date(Date.now() - KEEP_SNAPSHOT_MS - 60_000);
  for (const name of snapshots()) utimesSync(join(SNAPS, name), old, old);
  prune();
  assert.deepEqual(snapshots(), []);
});

test("call_batch and call_operation take maxAgeMs and changesOnly", async () => {
  const items = [{ site: "board", op: "listings", args: { q: "desk" } }];
  const one = async (o: Parameters<typeof callReads>[1]) => {
    for await (const r of callReads(items, o)) return r;
  };
  const first = await one({ changesOnly: true });
  assert.deepEqual(first!.changes, { first: true });
  const hit = await one({ maxAgeMs: 60_000 });
  assert.equal(hit!.cached, true);
  assert.equal(fx.calls.length, 1);

  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer({
    run: { call: (site, op, args, options) => call(site, op, args, { ...options, ...opts }) },
  });
  const client = new Client({ name: "watch-test", version: "0" });
  try {
    await server.connect(a);
    await client.connect(b);
    const tool = async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: "call_operation", arguments: args });
      return JSON.parse((r.content as { text: string }[])[0]!.text);
    };
    const r = await tool({ site: "board", op: "listings", args: { q: "desk" }, changesOnly: true });
    assert.equal(r.ok, true);
    assert.equal(r.data, undefined);
    assert.equal(r.changes.unchanged, 1);
    const cached = await tool({ site: "board", op: "listings", args: { q: "desk" }, maxAgeMs: 60_000 });
    assert.equal(cached.cached, true);
    assert.equal(fx.calls.length, 2);
  } finally {
    await client.close();
    await server.close();
  }
});

/* ------------------------------------------------------------ review fixes */

const cookie = (name: string, value: string) => ({
  name,
  value,
  domain: new URL(fx.url).hostname,
  path: "/",
  expires: -1,
  httpOnly: false,
  secure: false,
});
const changesOf2 = (r: Awaited<ReturnType<typeof call>>) =>
  r.changes as Extract<NonNullable<typeof r.changes>, { since: string }>;

test("a kept answer is the session's it was for: another session, or none, is a miss", async () => {
  const as = (cookies: ReturnType<typeof cookie>[]) => saveSession("board", { cookies, values: {} });
  const cached = () => call("board", "listings", {}, { ...opts, maxAgeMs: 60_000 });
  as([cookie("sid", "account-A-secret")]);
  assert.equal((await cached()).cached, undefined);
  assert.equal((await cached()).cached, true);
  as([cookie("sid", "account-B-secret")]);
  assert.equal((await cached()).cached, undefined, "B is not served A's answer");
  as([]);
  assert.equal((await cached()).cached, undefined, "signed out is not served A's answer");
  as([cookie("sid", "account-A-secret"), cookie("__cf_bm", "rotated-every-answer")]);
  assert.equal((await cached()).cached, true, "A again, a cookie known to carry no account aside");
  assert.equal(fx.calls.length, 3);
  // neither a file's name nor its content says whose it is
  for (const f of readdirSync(SNAPS)) {
    assert.doesNotMatch(f, /account|sid/);
    assert.doesNotMatch(readFileSync(join(SNAPS, f), "utf8"), /account-[AB]-secret/);
  }
  assert.equal(statSync(join(HOME, "snapshot-salt")).mode & 0o777, 0o600);
  // a watcher's baseline is the session's too
  as([cookie("sid", "account-A-secret")]);
  await call("board", "listings", {}, { ...opts, changes: true });
  as([cookie("sid", "account-B-secret")]);
  assert.deepEqual((await call("board", "listings", {}, { ...opts, changes: true })).changes, { first: true });
});

test("a cache entry of another op is a miss: a changed path, a raised minTier, a tier above maxTier", async () => {
  const cached = (o = {}) => call("board", "listings", {}, { ...opts, maxAgeMs: 60_000, ...o });
  await cached();
  assert.equal((await cached()).cached, true);
  const moved = board("board");
  moved.operations[0]!.request.url = `${fx.url}/api/listings/?q=`;
  saveSite(moved);
  assert.equal((await cached()).cached, undefined, "a new path");
  const raised = board("board");
  raised.operations[0]!.minTier = 2;
  saveSite(raised);
  const r = await cached();
  assert.equal(r.cached, undefined, "a raised minTier");
  assert.equal(r.ok, false, "and tier 1 cannot run it");
  saveSite(board("board"));
  // an entry tier 2 answered is no answer for a caller held to tier 1
  const op = board("board").operations[0]!;
  const id = { site: "board", op, args: { q: "" }, session: "signed-out" };
  saveSnapshot(cacheKey(id), { at: now, op: opPrint(board("board"), op), tier: 2, data: [] });
  const sent = fx.calls.length;
  assert.equal((await cached()).cached, undefined);
  assert.equal(fx.calls.length, sent + 1);
});

test("args are coerced as the request takes them before they name a kept answer", async () => {
  for (const n of [1, "1.0", "01"])
    assert.equal((await call("board", "page", { n }, { ...opts, maxAgeMs: 60_000 })).ok, true, String(n));
  assert.equal(fx.calls.length, 1);
  const bad = await call("board", "page", { n: "one" }, { ...opts, maxAgeMs: 60_000 });
  assert.equal(bad.class, "input");
  assert.equal(fx.calls.length, 1);
});

test("watchers are independent, and a maxAgeMs refresh never moves a baseline", async () => {
  const watch = (w?: string) => call("board", "listings", {}, { ...opts, changes: true, ...(w ? { watch: w } : {}) });
  assert.deepEqual((await watch()).changes, { first: true });
  assert.deepEqual((await watch("other")).changes, { first: true });
  fx.listings.push({ id: "d4", title: "Rug", price: 70 });
  // a refresh of the cache entry between two changes calls
  later(1);
  const refresh = await call("board", "listings", {}, { ...opts, maxAgeMs: 0 });
  assert.deepEqual([refresh.ok, refresh.cached, refresh.changes], [true, undefined, undefined]);
  assert.equal(changesOf2(await watch()).added.length, 1, "the default watcher still sees it");
  assert.equal(changesOf2(await watch("other")).added.length, 1, "and so does the other");
  assert.equal(changesOf2(await watch()).added.length, 0);
  // a watch name implies changes; a malformed one is refused
  assert.ok((await call("board", "listings", {}, { ...opts, watch: "third" })).changes);
  assert.equal((await call("board", "listings", {}, { ...opts, watch: "no spaces" })).class, "input");
});

test("repeated keys keep their identity: a value that looks like a suffix or a hash is its own key", () => {
  const items = [
    { id: "a~2", v: 1 },
    { id: "a", v: 1 },
    { id: "a", v: 2 },
  ];
  const c = changesOf({ full: items, shown: items }, { full: [...items], shown: [...items] }, 0, "id") as {
    added: unknown[];
    removed: unknown[];
    changed: unknown[];
    unchanged: number;
  };
  assert.deepEqual([c.added, c.removed, c.changed, c.unchanged], [[], [], [], 3]);
  // 1 and "1" are two keys; an item without one is its hash, in a namespace no id can reach
  const before = [{ id: 1 }, { id: "1" }];
  const after = [{ id: "1" }, { id: 1 }];
  const d = changesOf({ full: before, shown: before }, { full: after, shown: after }, 0, "id") as typeof c;
  assert.deepEqual([d.added, d.removed, d.unchanged], [[], [], 2]);
});

test("a declared key is read with the extractor's own paths", async () => {
  const spec = (key: string, pick = ["id", "seller.name"]) =>
    parseSite({
      name: "v",
      baseUrl: "https://example.com",
      operations: [
        {
          name: "list",
          readOnly: true,
          request: { method: "GET", url: "https://example.com/api" },
          trigger: { url: "https://example.com/" },
          match: { path: "/api" },
          response: { extract: "items", pick, key },
        },
      ],
    });
  assert.match(vetShared(spec('meta["\\q"]', ["meta"])).errors.join("\n"), /not a path to one value/);
  assert.match(vetShared(spec("id.")).errors.join("\n"), /not a path to one value/);
  assert.deepEqual(vetShared(spec('["seller.name"]')).errors, []);
  assert.match(vetShared(spec("seller.name")).errors.join("\n"), /no field it returns/);
  // and a call matches items by it
  await call("board", "bySeller", {}, { ...opts, changes: true });
  fx.listings[0]!.price = 1;
  const c = changesOf2(await call("board", "bySeller", {}, { ...opts, changes: true }));
  assert.equal(c.key, '["seller.name"]');
  assert.deepEqual(
    (c.changed as { key: string; fields: string[] }[]).map((x) => [x.key, x.fields]),
    [["Ann", ["price"]]],
  );
});

test("perHour is a whole number the accounting can hold, wherever it is set", () => {
  const withPace = (pace: unknown) => () => parseSite({ name: "p", baseUrl: "https://p.test", pace });
  for (const perHour of [1e20, Number.POSITIVE_INFINITY, Number.NaN, 3601, 0, 1.5])
    assert.throws(withPace({ perHour }), /invalid site spec/, String(perHour));
  assert.equal(parseSite({ name: "p", baseUrl: "https://p.test", pace: { perHour: 3600 } }).pace?.perHour, 3600);
  for (const bad of ["perHour=99999999999", "perHour=Infinity", "perHour=3601", "interval=2h", "perHour=-1"])
    assert.throws(() => envPace("p", bad), /API_ANYTHING_PACE/, bad);
  const raw = { name: "p", baseUrl: "https://example.com", operations: [] } as unknown as Site;
  for (const perHour of [Number.NaN, Number.POSITIVE_INFINITY, 1e20])
    assert.match(vetShared({ ...raw, pace: { perHour } }).errors.join("\n"), /pace perHour/, String(perHour));
});

test("changesOnly is a read's: a write keeps its data", async () => {
  const w = await call("board", "add", { title: "Stool" }, { ...opts, allowWrites: true, changesOnly: true });
  assert.equal(w.ok, true);
  assert.equal((w.data as { title: string }).title, "Stool");
  assert.equal(w.changes, undefined);
});

test("a baseline that cannot be kept says so, and the call stays ok", async () => {
  writeFileSync(SNAPS, "not a directory");
  try {
    const r = await call("board", "listings", {}, { ...opts, changes: true });
    assert.equal(r.ok, true);
    assert.equal((r.data as unknown[]).length, 3);
    const c = r.changes as { first: true; retained: false; reason: string };
    assert.equal(c.first, true);
    assert.equal(c.retained, false);
    assert.match(c.reason, /not kept as the baseline/);
  } finally {
    rmSync(SNAPS, { force: true });
  }
});

test("changesOnly with maxChars: the changes, note and all, fit maxChars", async () => {
  await call("board", "listings", {}, { ...opts, changesOnly: true });
  for (let i = 0; i < 60; i++) fx.listings.push({ id: `n${i}`, title: `Listing number ${i}`, price: i });
  const r = await call("board", "listings", {}, { ...opts, changesOnly: true, view: { maxChars: 256 } });
  const text = JSON.stringify(r.changes);
  assert.ok(text.length <= 256, `${text.length}: ${text}`);
  assert.match(changesOf2(r).truncated!, /cut \d+ added/);
  // capChanges alone, across sizes
  const items = Array.from({ length: 50 }, (_, i) => ({ id: i, text: "y".repeat(i * 7) }));
  for (const max of [256, 300, 1000, 4000]) {
    const c = capChanges(changesOf({ full: [], shown: [] }, { full: items, shown: items }, 0), max);
    assert.ok(JSON.stringify(c).length <= max, String(max));
  }
});

/* ------------------------------------------------------------- budgets */

test("concurrent calls under perHour: 1 send one request between them", async () => {
  saveSite(board("one", { pace: { perHour: 1 } }));
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => call("one", "listings", { q: String(i) }, opts)));
  assert.equal(fx.calls.length, 1);
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.ok(rs.filter((r) => !r.ok).every((r) => r.class === "rate" && r.budget && r.retryAfterMs! > 0));
  // a refusal is no word from the site: no cool-down
  assert.equal(cooling("one"), undefined);
});

test("two processes under perHour: 1 send one request between them", async () => {
  saveSite(board("twoproc", { pace: { perHour: 1 } }));
  const src = fileURLToPath(new URL("../src/execute.ts", import.meta.url));
  const script = `const { call } = await import(${JSON.stringify(src)});
const r = await call("twoproc", "listings", {}, { maxTier: 1, minIntervalMs: 0 });
console.log(JSON.stringify({ ok: r.ok, budget: r.budget ?? false }));`;
  const run = () =>
    run1(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, API_ANYTHING_HOME: HOME },
    });
  const outs = (await Promise.all([run(), run()])).map((o) => JSON.parse(o.stdout.trim().split("\n").at(-1)!));
  assert.equal(fx.calls.length, 1, JSON.stringify(outs));
  assert.deepEqual(outs.map((o) => o.ok).sort(), [false, true]);
  assert.ok(outs.some((o) => o.budget));
});

test("each send of a call is held to the budget: the plain-HTTP retry is refused once the hour is spent", async () => {
  saveSite(
    parseSite({
      name: "walled",
      baseUrl: fx.url,
      pace: { perHour: 1 },
      operations: [
        {
          ...list("listings"),
          request: { method: "GET", url: `${fx.url}/api/sorry`, headers: { "user-agent": "Mozilla/5.0 Chrome/140" } },
          slots: [],
          params: [],
          match: { path: "/api/sorry" },
        },
      ],
    }),
  );
  fx.calls.length = 0;
  const r = await call("walled", "listings", {}, opts);
  assert.equal(fx.calls.length, 1, "the retry without identity headers was not sent");
  assert.equal(r.class, "rate");
  assert.equal(r.budget, true);
});

test("a slot more than 10 s off under a budget is refused, never queued", () => {
  const real = Math.random;
  Math.random = () => 0.5; // no jitter: each gap is the interval
  try {
    const budget = { site: "q", pace: { minIntervalMs: 6000 } };
    const t = 1_000_000_000_000;
    assert.equal(reserveSend("q", 6000, t, budget), t);
    assert.equal(reserveSend("q", 6000, t, budget), t + 6000);
    assert.throws(
      () => reserveSend("q", 6000, t, budget),
      (e: unknown) => e instanceof BudgetSpent && e.retryAfterMs === 12_000,
    );
    // the refusal reserved nothing; a write's readback is never refused
    assert.equal(reserveSend("q", 6000, t, { ...budget, exempt: true }), t + 12_000);
  } finally {
    Math.random = real;
  }
});

test("a write's readback is counted, never refused, by a spent budget", async () => {
  saveSite(board("rb", { pace: { perHour: 1 } }));
  const r = await call("rb", "addChecked", { title: "Ottoman" }, { ...opts, allowWrites: true });
  assert.equal(r.write, "applied", JSON.stringify(r));
  assert.equal(fx.calls.length, 2, "the write and its readback");
  const next = await call("rb", "listings", {}, opts);
  assert.equal(next.budget, true, "both were counted");
});
