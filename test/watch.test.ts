/** What a scheduled caller needs: a read's cache, what changed since last time, and a site's request budget. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callReads } from "../src/batch.js";
import { envPace, parseDuration, sitePace } from "../src/budget.js";
import { capChanges, changesOf } from "../src/changes.js";
import { call } from "../src/execute.js";
import { createServer } from "../src/mcp.js";
import { KEEP_SNAPSHOT_MS, prune } from "../src/snapshots.js";
import { parseSite, type Site } from "../src/spec.js";
import { saveSite } from "../src/store.js";
import { vetShared } from "../src/vet.js";
import { type Fixture, LISTINGS, startFixture } from "./fixture/server.js";

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
    ],
  });

const snapshots = () => (existsSync(SNAPS) ? readdirSync(SNAPS).filter((f) => f.endsWith(".json")) : []);
const reset = () => fx.listings.splice(0, fx.listings.length, ...LISTINGS());

before(async () => {
  fx = await startFixture();
  saveSite(board("board"));
});
beforeEach(() => {
  reset();
  fx.calls.length = 0;
  rmSync(SNAPS, { recursive: true, force: true });
  rmSync(join(HOME, "results.json"), { force: true });
  delete process.env.API_ANYTHING_PACE;
});
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
  await new Promise((r) => setTimeout(r, 30));
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
  const errors = vetShared(spec({ minIntervalMs: 10, perHour: 5000 }, "price")).errors.join("\n");
  assert.match(errors, /pace minIntervalMs is 10/);
  assert.match(errors, /pace perHour is 5000/);
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
  const [name] = snapshots();
  const old = new Date(Date.now() - KEEP_SNAPSHOT_MS - 60_000);
  utimesSync(join(SNAPS, name!), old, old);
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
