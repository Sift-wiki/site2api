import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { call, heal } from "../src/execute.js";
import { callPlanned, closeHost, hostSite, hostSites, planCall, setBundledDir } from "../src/host.js";
import { resolver } from "../src/http.js";
import { answerShare } from "../src/identity.js";
import { registryName } from "../src/publish.js";
import { settle } from "../src/report.js";
import { scanSecrets } from "../src/secrets.js";
import { loadSession, saveSession } from "../src/session.js";
import { parseSite, type Site } from "../src/spec.js";
import { cooling, listSites, loadCalls, loadSite, registryDir, saveSite, siteNotes } from "../src/store.js";
import { type Fixture, startFixture } from "./fixture/server.js";

const BUNDLED = fileURLToPath(new URL("../sites", import.meta.url));
let fixture: Fixture;
let registry: Fixture;
let home: string;
let site: Site;
const opts = { maxTier: 1 as const, minIntervalMs: 0 };

before(async () => {
  fixture = await startFixture();
  registry = await startFixture();
});
after(async () => {
  await closeHost();
  await Promise.all([fixture.close(), registry.close()]);
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "api-anything-host-"));
  process.env.API_ANYTHING_HOME = home;
  process.env.API_ANYTHING_REGISTRY = `${registry.url}/api/registry`;
  setBundledDir(BUNDLED);
  fixture.calls.length = 0;
  registry.calls.length = 0;
  answerShare(true);
  site = parseSite({
    name: "fixture",
    baseUrl: fixture.url,
    operations: [
      {
        name: "search",
        readOnly: true,
        description: "Search the fixture",
        request: { method: "GET", url: `${fixture.url}/api/scoped?q=alice`, headers: {} },
        slots: [{ param: "q", at: ["query:q"] }],
        params: [{ name: "q", default: "alice" }],
        trigger: { url: `${fixture.url}/scoped?q={q}` },
        response: { extract: "data.results" },
      },
      {
        name: "todos",
        readOnly: true,
        request: { method: "GET", url: `${fixture.url}/api/todos`, headers: {} },
        trigger: { url: `${fixture.url}/todos` },
        response: { extract: "todos" },
      },
      {
        name: "addTodo",
        readOnly: false,
        request: {
          method: "POST",
          url: `${fixture.url}/api/todos`,
          headers: { "content-type": "application/json" },
          body: '{"title":"example"}',
        },
        slots: [{ param: "title", at: ["body", "json:/title"] }],
        params: [{ name: "title", required: true, pattern: ".{3,}", hint: "at least 3 characters" }],
        trigger: { url: `${fixture.url}/todos/{title}` },
        readback: { op: "todos", args: {}, find: { field: "title", equals: "{title}" } },
      },
    ],
  });
  saveSite(site);
});
afterEach(async () => {
  await closeHost();
  await settle(1000);
  assert.deepEqual(registry.calls, [], "no registry traffic, even with sharing enabled");
  setBundledDir(BUNDLED);
  rmSync(home, { recursive: true, force: true });
});

const planned = (op: string, args?: Record<string, unknown>) => {
  const plan = planCall("fixture", op, args);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  if (!plan.ok) throw new Error("unreachable");
  return plan;
};

test("discovery lists bundled, pulled and user sites; user copy wins; notes, schemas and page prefixes", () => {
  const bundled = hostSite("hacker-news");
  assert.equal(bundled?.site.source, "bundled");
  assert.equal(bundled?.site.signedIn, false);
  const user = hostSite("fixture");
  assert.ok(user);
  assert.deepEqual(user.site.hosts, ["127.0.0.1"]);
  assert.deepEqual(user.site.operations.find((o) => o.name === "addTodo")?.pages, [`${fixture.url}/todos/`]);
  assert.deepEqual(user.site.operations.find((o) => o.name === "search")?.pages, [`${fixture.url}/scoped`]);
  assert.equal(user.operations[0]?.params.additionalProperties, false);
  writeFileSync(join(home, "sites", "fixture.md"), "Caller notes\n\n## Maintainer notes\nPrivate details");
  assert.equal(hostSite("fixture")?.notes, "Caller notes");
  saveSession("fixture", { cookies: [], values: { theme: "" } });
  assert.equal(hostSite("fixture")?.site.signedIn, true, "even an empty stored value counts");
  saveSession("fixture", {
    cookies: [
      {
        name: "guest",
        value: "guest-cookie",
        domain: "127.0.0.1",
        path: "/",
        expires: 1,
        httpOnly: false,
        secure: false,
      },
    ],
    values: {},
  });
  assert.equal(hostSite("fixture")?.site.signedIn, true, "an expired guest cookie counts conservatively");
  const copy = loadSite("hacker-news")!.site;
  saveSite({ ...copy, operations: [copy.operations[0]!] });
  const sites = hostSites();
  assert.equal(sites.filter((s) => s.name === "hacker-news").length, 1);
  assert.equal(sites.find((s) => s.name === "hacker-news")?.source, "user");
  assert.equal(sites.find((s) => s.name === "hacker-news")?.operations.length, 1);

  mkdirSync(registryDir(), { recursive: true });
  writeFileSync(
    join(registryDir(), "pulled.json"),
    JSON.stringify({
      ...copy,
      name: "pulled",
      shared: { from: `${registry.url}/v1/sites/pulled`, sha256: "0".repeat(64) },
    }),
  );
  assert.equal(hostSite("pulled")?.site.source, "pulled");
  assert.ok(hostSites().some((s) => s.name === "pulled"));
  assert.equal(hostSite("absent"), undefined);
  assert.deepEqual(fixture.calls, []);
});

test("planning rejects unknown site/op, missing, unknown and bad args without sending", async () => {
  const plans = [
    planCall("missing", "search"),
    planCall("fixture", "missing"),
    planCall("fixture", "addTodo"),
    planCall("fixture", "addTodo", { title: "no" }),
    planCall("fixture", "search", { typo: "alice" }),
  ];
  for (const plan of plans) {
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.equal(plan.result.class, "input");
  }
  for (const [op, args] of [
    ["missing", {}],
    ["addTodo", {}],
    ["search", { typo: "alice" }],
  ] as const) {
    const plan = planCall("fixture", op, args);
    const result = await call("fixture", op, args, { ...opts, callOnly: true, allowWrites: true });
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.equal(plan.result.class, result.class);
  }
  assert.deepEqual(fixture.calls, []);
});

test("planning redacts cookie/session values and encoded copies; fingerprints bind defaults and args", () => {
  const cookie = ["Cookie", "Abcd1234567890", "Secret"].join("");
  const token = ["Session", "Abcd1234567890", "Secret"].join("");
  saveSession("fixture", {
    cookies: [
      { name: "auth", value: cookie, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false },
    ],
    values: { bearer: token },
    valueHosts: { bearer: "127.0.0.1" },
  });
  const op = site.operations[0]!;
  saveSite({
    ...site,
    operations: [
      {
        ...op,
        request: { ...op.request, headers: { authorization: "" } },
        slots: [...op.slots, { ref: "session:bearer", at: ["header:authorization"] }],
      },
    ],
  });
  const a = planned("search");
  assert.deepEqual(a.args, { q: "alice" });
  assert.equal(a.request.headers.cookie, "auth=<auth>");
  assert.equal(a.request.headers.authorization, "<bearer>");
  assert.deepEqual(scanSecrets(a.request, loadSession("fixture")).secrets, []);
  assert.equal(planned("search").fingerprint, a.fingerprint);
  assert.equal(planned("search", { q: "alice" }).fingerprint, a.fingerprint);
  assert.notEqual(planned("search", { q: "bob" }).fingerprint, a.fingerprint);
  const echo = planned("search", { q: Buffer.from(token).toString("base64") });
  assert.deepEqual(scanSecrets(echo.request, loadSession("fixture")).secrets, []);
  assert.deepEqual(fixture.calls, []);
});

test("planned reads call the fixture, stay paced, and log locally without registry reports", async () => {
  const plan = planned("search", { q: "bob" });
  const first = await callPlanned(plan, opts);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.data, ["bob one", "bob two"]);
  const start = Date.now();
  const second = await callPlanned(plan, opts);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.ok(Date.now() - start >= 900, "minIntervalMs: 0 cannot bypass host pacing");
  assert.equal(fixture.calls.length, 2);
  assert.equal(loadCalls("fixture").length, 2);
  assert.equal(existsSync(join(home, "heals.jsonl")), false);
});

test("writes require allowWrites, send once, read back, then refuse duplicates", async () => {
  const plan = planned("addTodo", { title: "host task" });
  const denied = await callPlanned(plan, opts);
  assert.equal(denied.class, "refused");
  assert.equal(denied.write, "not_sent");
  assert.equal(fixture.calls.length, 0);
  const result = await callPlanned(plan, { ...opts, allowWrites: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.write, "applied");
  assert.equal(fixture.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(fixture.calls.filter((c) => c.method === "GET").length, 1, "readback retained");
  const duplicate = await callPlanned(plan, { ...opts, allowWrites: true });
  assert.equal(duplicate.class, "duplicate");
  assert.equal(fixture.calls.length, 2);
});

test("changed spec, trigger, write flag, readback, arguments or preview refuses approval before sending", async () => {
  const plan = planned("addTodo", { title: "approval task" });
  for (const alter of [
    (op: Site["operations"][number]) => ({ ...op, request: { ...op.request, url: `${fixture.url}/api/elsewhere` } }),
    (op: Site["operations"][number]) => ({ ...op, trigger: { url: `${fixture.url}/changed` } }),
    (op: Site["operations"][number]) => ({ ...op, readOnly: true }),
    (op: Site["operations"][number]) => ({ ...op, readback: undefined }),
  ]) {
    saveSite({ ...site, operations: site.operations.map((o) => (o.name === "addTodo" ? alter(o) : o)) });
    const result = await callPlanned(plan, { ...opts, allowWrites: true });
    assert.equal(result.class, "refused");
    assert.equal(result.write, "not_sent");
    assert.match(result.reason ?? "", /changed after it was approved/);
  }
  saveSite(site);
  for (const changed of [
    { ...plan, args: { title: "another task" } },
    { ...plan, request: { ...plan.request, body: "not what was planned" } },
  ])
    assert.equal((await callPlanned(changed, { ...opts, allowWrites: true })).class, "refused");
  assert.deepEqual(fixture.calls, []);
});

test("drifting callOnly reads/writes never rescan, recapture, adopt or change any spec bytes", async () => {
  const path = join(home, "sites", "fixture.json");
  const drifted = parseSite({
    ...site,
    operations: site.operations.map((op) => ({
      ...op,
      request: { ...op.request, url: `${fixture.url}/api/graphql/old/${op.name}` },
      volatile: [{ at: ["path:2"], shape: { charset: "base64url", length: 22 }, anchor: "UserByName" }],
      version: { hash: "a".repeat(64), status: "live" },
    })),
  });
  // Not a known endpoint: a 404 is drift and certainly did not run the write.
  saveSite(drifted);
  const before = readFileSync(path);
  for (const name of ["search", "addTodo"]) {
    const result = await callPlanned(planned(name, name === "addTodo" ? { title: "drift task" } : {}), {
      ...opts,
      allowWrites: true,
    });
    assert.equal(result.class, "drift", JSON.stringify(result));
    assert.match(result.next ?? "", new RegExp(`api-anything heal fixture ${name}`));
    assert.equal(result.nextCall?.action, "heal");
    assert.equal(result.healed, undefined);
    assert.deepEqual(readFileSync(path), before);
  }
  assert.equal(fixture.calls.length, 2, "only the operation requests, no rescan or example probes");
  assert.equal(existsSync(join(home, "heals.jsonl")), false);
  const noHeal = await heal("fixture", "search", {}, { ...opts, callOnly: true });
  assert.equal(noHeal.class, "refused");
  assert.equal(fixture.calls.length, 2);
});

test("auth never imports an everyday-browser session and directs the user to CLI login", async () => {
  saveSite({
    ...site,
    operations: [
      {
        ...site.operations[0]!,
        request: { method: "GET", url: `${fixture.url}/private`, headers: {} },
        public: ["authorization"],
      },
      { ...site.operations[2]!, learnedLoggedIn: true },
    ],
  });
  saveSession("fixture", { cookies: [], values: {}, source: "chrome:HostMustNotOpenThisProfile" });
  const read = await callPlanned(planned("search"), opts);
  assert.equal(read.class, "auth", JSON.stringify(read));
  assert.match(read.next ?? "", /api-anything login fixture/);
  assert.equal(read.nextCall?.action, "login");
  const write = await callPlanned(planned("addTodo", { title: "signed in task" }), { ...opts, allowWrites: true });
  assert.equal(write.class, "auth");
  assert.equal(write.write, "not_sent");
  assert.equal(loadSession("fixture").source, "chrome:HostMustNotOpenThisProfile");
  assert.deepEqual(fixture.calls, []);
});

test("callOnly keeps truncation and rate cool-downs and refuses sending during a cool-down", async () => {
  saveSite({
    ...site,
    operations: [
      {
        ...site.operations[0]!,
        request: { method: "GET", url: `${fixture.url}/api/result-list`, headers: {} },
        slots: [],
        params: [],
        response: { format: "json", extract: "items" },
      },
    ],
  });
  const list = await callPlanned(planned("search"), opts);
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.ok(list.truncated);
  // Use a separate site so the fixture's previous limited calls cannot affect this test.
  saveSite({
    ...site,
    name: "limited",
    operations: [
      { ...site.operations[0]!, request: { method: "GET", url: `${fixture.url}/api/limited`, headers: {} } },
    ],
  });
  const plan = planCall("limited", "search");
  assert.ok(plan.ok);
  for (let i = 0; i < 3; i++) await callPlanned(plan, opts);
  assert.ok(cooling("limited"));
  const count = fixture.calls.length;
  const held = await callPlanned(plan, opts);
  assert.equal(held.class, "rate");
  assert.equal(held.cooling, true);
  assert.equal(fixture.calls.length, count);
});

test("generated placeholders stay stable while real writes use fresh generated keys", async () => {
  saveSite(
    parseSite({
      ...site,
      operations: [
        {
          name: "checkout",
          readOnly: false,
          request: {
            method: "POST",
            url: `${fixture.url}/api/checkout`,
            headers: { "content-type": "application/json", "idempotency-key": "" },
            body: '{"item":"example"}',
          },
          slots: [
            { param: "item", at: ["body", "json:/item"] },
            { gen: "uuid", at: ["header:idempotency-key"] },
          ],
          params: [{ name: "item" }],
          trigger: { url: `${fixture.url}/checkout/{item}` },
        },
      ],
    }),
  );
  const plan = planned("checkout", { item: "blue-mug" });
  assert.equal(plan.request.headers["idempotency-key"], "<generated:uuid>");
  assert.equal(planned("checkout", { item: "blue-mug" }).fingerprint, plan.fingerprint);
  assert.equal((await callPlanned(plan, { ...opts, allowWrites: true })).ok, true);
  assert.match(String(fixture.calls[0]?.headers["idempotency-key"]), /^[0-9a-f-]{36}$/);
  const another = planned("checkout", { item: "red-kettle" });
  assert.equal((await callPlanned(another, { ...opts, allowWrites: true })).ok, true);
  assert.notEqual(fixture.calls[0]?.headers["idempotency-key"], fixture.calls[1]?.headers["idempotency-key"]);
});

test("derived slots plan offline and keep the operation's lookup at call time", async () => {
  saveSite(
    parseSite({
      ...site,
      operations: [
        {
          name: "reviews",
          readOnly: true,
          request: { method: "GET", url: `${fixture.url}/api/products/4821/reviews`, headers: {} },
          slots: [
            {
              from: {
                request: { method: "GET", url: `${fixture.url}/api/resolve?slug=blue-mug`, headers: {} },
                slots: [{ param: "slug", at: ["query:slug"] }],
              },
              path: "product.id",
              at: ["path:2"],
            },
          ],
          params: [{ name: "slug" }],
          trigger: { url: `${fixture.url}/p/{slug}` },
          response: { extract: "reviews" },
        },
      ],
    }),
  );
  const plan = planned("reviews", { slug: "red-kettle" });
  assert.match(decodeURIComponent(plan.request.url), /<derived:product.id>/);
  assert.equal(planned("reviews", { slug: "red-kettle" }).fingerprint, plan.fingerprint);
  assert.equal(fixture.calls.length, 0);
  const result = await callPlanned(plan, opts);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    fixture.calls.map((c) => c.path),
    ["/api/resolve?slug=red-kettle", "/api/products/5170/reviews"],
  );
});

test("a shared operation still refuses private addresses without sending or adopting", async () => {
  saveSite(
    parseSite({
      ...site,
      name: "external",
      baseUrl: "https://example.com",
      shared: { from: `${registry.url}/v1/sites/external`, sha256: "0".repeat(64) },
      operations: [
        {
          ...site.operations[0]!,
          request: { method: "GET", url: "https://example.com/api/scoped?q=alice", headers: {} },
          match: { method: "GET", host: "example.com", path: "/api/scoped" },
          trigger: { url: "https://example.com/scoped?q={q}" },
        },
      ],
    }),
  );
  const lookup = resolver.lookup;
  resolver.lookup = async () => [{ address: "127.0.0.1" }];
  try {
    const plan = planCall("external", "search");
    assert.ok(plan.ok, JSON.stringify(plan));
    const result = await callPlanned(plan, opts);
    assert.equal(result.class, "error", JSON.stringify(result));
    assert.equal(result.nextCall?.action, "report");
    assert.equal(fixture.calls.length, 0);
  } finally {
    resolver.lookup = lookup;
  }
});

test("setBundledDir redirects every default loader, notes and publishing name", () => {
  const dir = join(home, "extracted");
  mkdirSync(dir);
  writeFileSync(join(dir, "extracted.json"), JSON.stringify({ ...site, name: "extracted" }));
  writeFileSync(join(dir, "extracted.md"), "Extracted notes");
  setBundledDir(dir);
  assert.deepEqual(listSites(), ["extracted", "fixture"]);
  assert.equal(hostSites().find((s) => s.name === "extracted")?.source, "bundled");
  assert.equal(hostSite("hacker-news"), undefined);
  assert.equal(siteNotes("extracted"), "Extracted notes");
  assert.equal(loadSite("extracted")?.source, "bundled");
  assert.equal(registryName({ ...site, name: "extracted" }), "extracted");
});
