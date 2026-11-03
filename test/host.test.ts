import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { call, heal } from "../src/execute.js";
import { callPlanned, closeHost, hostSite, hostSites, planCall, setBundledDir } from "../src/host.js";
import { resolver } from "../src/http.js";
import { answerShare } from "../src/identity.js";
import { registryName } from "../src/publish.js";
import { settle } from "../src/report.js";
import { scanSecrets } from "../src/secrets.js";
import { loadSession, mergeCapture, saveSession, sessionFile } from "../src/session.js";
import { parseSite, type Site } from "../src/spec.js";
import {
  cooling,
  listSites,
  loadCalls,
  loadSite,
  registryDir,
  rememberTier,
  saveSite,
  siteNotes,
} from "../src/store.js";
import type { StoredCookie } from "../src/types.js";
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
  const plan = planCall("fixture", op, args, opts);
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

const cookie = (name: string, value: string, more: Partial<StoredCookie> = {}): StoredCookie => ({
  name,
  value,
  domain: "127.0.0.1",
  path: "/",
  expires: -1,
  httpOnly: false,
  secure: false,
  ...more,
});

test("signedIn is a login on record or a cookie that may carry one, never known-anonymous cookies or unsent values", () => {
  const signedIn = () => hostSite("fixture")?.site.signedIn;
  const anonymous = [
    cookie("NID", "511=anonymous-preference-id"),
    cookie("CONSENT", "PENDING+987"),
    cookie("_ga", "GA1.1.123456789.1700000000"),
    cookie("csrftoken", "anonymous-csrf-token-value"),
    cookie("sessionid", "expired-session-value", { expires: 1 }),
    cookie("user_session", ""),
  ];
  saveSession("fixture", { cookies: anonymous, values: { theme: "", "x-guest-token": "1234567890" } });
  assert.equal(signedIn(), false, "anonymous, expired and empty cookies and session values are no login");
  const capped = planCall("fixture", "search");
  assert.ok(capped.ok);
  assert.equal(capped.signedIn, false, "the profile is reachable at the default cap, and holds nothing");
  saveSession("fixture", { cookies: [...anonymous, cookie("sessionid", "live-session-value")], values: {} });
  assert.equal(signedIn(), true, "a live auth-named cookie");
  assert.equal(planned("search").signedIn, true, "the jar counts at maxTier 1");
  saveSession("fixture", {
    cookies: [...anonymous, cookie("laravel_session", "every-visitor-gets-one")],
    values: {},
    guestCookies: ["laravel_session"],
  });
  assert.equal(signedIn(), false, "a name a signed-out visit is given");
  saveSession("fixture", { cookies: [], values: {}, source: "window" });
  assert.equal(signedIn(), true, "a login on record, even with its cookies gone");
  assert.equal(planned("search").signedIn, true);
  saveSite({ ...site, loginCookies: ["member"] });
  saveSession("fixture", { cookies: [cookie("member", "pinned-login")], values: {} });
  assert.equal(signedIn(), true, "a pinned loginCookies name");
  saveSession("fixture", { cookies: [cookie("sessionid", "not-the-pinned-name")], values: {} });
  assert.equal(signedIn(), true, "a pinned list adds names, never makes another one anonymous");
});

test("a login on another site of the same registrable domain counts where the shared profile is reachable", () => {
  const on = (name: string, origin: string): Site => ({
    ...site,
    name,
    baseUrl: origin,
    operations: [
      {
        ...site.operations[0]!,
        request: { ...site.operations[0]!.request, url: `${origin}/api/search?q=alice` },
        trigger: { url: `${origin}/search?q={q}` },
      },
    ],
  });
  saveSite(on("flights", "https://www.example.co.uk"));
  saveSite(on("maps", "https://maps.example.co.uk"));
  const plan = (maxTier?: 1) => {
    const p = planCall("flights", "search", {}, maxTier ? { maxTier } : {});
    assert.ok(p.ok, JSON.stringify(p));
    return p.signedIn;
  };
  saveSession("maps", { cookies: [cookie("NID", "anonymous", { domain: ".example.co.uk" })], values: {} });
  assert.equal(plan(), false, "another site's anonymous cookies are no login");
  saveSession("maps", { cookies: [], values: {}, source: "chrome:Default" });
  assert.equal(plan(), true, "maps' login put its cookies into the profile flights' browser tiers use");
  assert.equal(hostSite("flights")?.site.signedIn, true);
  assert.equal(hostSites().find((s) => s.name === "flights")?.signedIn, true);
  assert.equal(plan(1), false, "tier 1 sends only flights' own jar");
  saveSession("flights", { cookies: [], values: { "x-goog-batchexecute-bgr": "captured-in-the-profile" } });
  assert.equal(plan(1), true, "a session value was captured in that profile");
  assert.equal(hostSite("fixture")?.site.signedIn, false, "another registrable domain");
  rmSync(join(home, "sessions", "maps.json"));
  saveSession("flights", { cookies: [], values: {} });
  assert.equal(plan(), false);
  // `login example.co.uk` with no spec names the site after its host.
  saveSession("example.co.uk", { cookies: [], values: {}, source: "file" });
  assert.equal(plan(), true);
  rmSync(join(home, "sessions", "example.co.uk.json"));
  // A window login can store cookies of an identity provider on another domain than its site's.
  saveSession("video", {
    cookies: [cookie("SID", "identity-provider-login", { domain: ".example.co.uk" })],
    values: {},
    source: "window",
  });
  assert.equal(plan(), true);
  assert.deepEqual(fixture.calls, []);
});

test("a signed-out read's own anonymous cookies leave the next plan unchanged; a login still refuses a write", async () => {
  saveSite({
    ...site,
    operations: [
      {
        ...site.operations[0]!,
        request: {
          method: "GET",
          url: `${fixture.url}/api/visitor-search?q=alice`,
          headers: { "x-csrf-token": "" },
        },
        slots: [
          { param: "q", at: ["query:q"] },
          { ref: "cookie:csrftoken", at: ["header:x-csrf-token"] },
        ],
      },
      site.operations[1]!,
      site.operations[2]!,
    ],
  });
  // The default cap: the shared profile is reachable, as for an embedding host's reads.
  const plan = (op: string, args: Record<string, unknown>) => {
    const p = planCall("fixture", op, args);
    assert.ok(p.ok, JSON.stringify(p));
    return p;
  };
  const approved = plan("search", { q: "sfo" });
  assert.equal(approved.signedIn, false);
  const first = await callPlanned(approved, { minIntervalMs: 0 });
  assert.equal(first.ok, true, JSON.stringify(first));
  const jar = loadSession("fixture").cookies;
  assert.deepEqual(jar.map((c) => c.name).sort(), ["CONSENT", "NID", "_ga", "csrftoken"]);
  assert.deepEqual(plan("search", { q: "sfo" }), approved, "the same plan, fingerprint and signedIn");
  assert.equal(hostSite("fixture")?.site.signedIn, false);
  const second = await callPlanned(approved, { minIntervalMs: 0 });
  assert.equal(second.ok, true, JSON.stringify(second));
  const sent = fixture.calls.at(-1)!.headers;
  assert.equal(sent["x-csrf-token"], jar.find((c) => c.name === "csrftoken")?.value, "the cookie ref still goes");
  assert.match(String(sent.cookie), /NID=511=/, "the jar's anonymous cookies still go");
  assert.deepEqual(plan("search", { q: "sfo" }), approved, "rotated values change nothing either");

  const write = plan("addTodo", { title: "after anonymous cookies" });
  assert.equal(write.signedIn, false);
  const anonymous = loadSession("fixture");
  saveSession("fixture", {
    ...anonymous,
    cookies: [...anonymous.cookies, cookie("sessionid", "signed-in-meanwhile", { httpOnly: true })],
  });
  const refused = await callPlanned(write, { allowWrites: true, minIntervalMs: 0 });
  assert.equal(refused.class, "refused", JSON.stringify(refused));
  assert.equal(refused.write, "not_sent");
  assert.equal(fixture.calls.filter((c) => c.method === "POST").length, 0);
  saveSession("fixture", anonymous);
  const applied = await callPlanned(write, { allowWrites: true, minIntervalMs: 0 });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.write, "applied");
  assert.equal(fixture.calls.filter((c) => c.method === "POST").length, 1);
});

test("an auth answer's own cookies are never taken as a guest's: the next plan is signed in", async () => {
  const members = {
    ...site.operations[0]!,
    name: "company",
    request: { method: "GET", url: `${fixture.url}/api/members-only`, headers: {} },
    slots: [],
    params: [],
  };
  saveSite({ ...site, loginCookies: ["li_at"], operations: [members] });
  const approved = planCall("fixture", "company", {}, { maxTier: 1 });
  assert.ok(approved.ok);
  assert.equal(approved.signedIn, false);
  // A 401 can still issue a session cookie the next request would carry: nothing proves it a visitor's.
  const first = await callPlanned(approved, { minIntervalMs: 0 });
  assert.equal(first.class, "auth", JSON.stringify(first));
  const s = loadSession("fixture");
  assert.deepEqual(s.cookies.map((c) => c.name).sort(), ["bcookie", "lidc"]);
  assert.equal(s.guestCookies, undefined);
  const next = planCall("fixture", "company", {}, { maxTier: 1 });
  assert.ok(next.ok);
  assert.equal(next.signedIn, true, "unknown cookies from any answer count");
  const stale = await callPlanned(approved, { minIntervalMs: 0 });
  assert.equal(stale.class, "refused", "an approval made before them no longer matches");
});

// Hacker News's login cookie is `user` (`<name>&<hash>`); Java, PHP and Express name theirs JSESSIONID,
// PHPSESSID and connect.sid; Google's account cookies are the SID family.
const ACCOUNT_COOKIES = [
  cookie("user", "alice&Ab3dE5fG7hI9jK1lM3nO5pQ7rS9tU1v"),
  cookie("JSESSIONID", "node0abc123def456ghi789.node0"),
  cookie("PHPSESSID", "q2v6l9n3k1m8p4r7s5t0u2w4x6"),
  cookie("connect.sid", "s%3Aabc123.def456"),
  cookie("session", "eyJ1c2VyIjoiYWxpY2UifQ.abc"),
  cookie("sid", "abc123"),
  cookie("logged_in", "yes"),
  ...[
    "SID",
    "HSID",
    "SSID",
    "APISID",
    "SAPISID",
    "__Secure-1PSID",
    "__Secure-3PSID",
    "__Secure-1PAPISID",
    "__Secure-3PAPISID",
    "__Secure-1PSIDTS",
    "__Secure-3PSIDCC",
  ].map((name) => cookie(name, "g.a000-synthetic-account-value")),
];
const ANONYMOUS_COOKIES = [
  "NID",
  "AEC",
  "SOCS",
  "CONSENT",
  "1P_JAR",
  "__Secure-ENID",
  "_ga",
  "_ga_ABC123XYZ",
  "_gid",
  "_gat",
  "_gat_UA-12345-1",
  "_fbp",
  "OptanonConsent",
  "OptanonAlertBoxClosed",
  "euconsent-v2",
  "__cf_bm",
  "_cfuvid",
  "cf_clearance",
  "csrftoken",
  "XSRF-TOKEN",
  "_csrf",
].map((name) => cookie(name, "anonymous-visitor-value"));

test("any live jar cookie counts as signed in unless its name is known to be anonymous", async () => {
  const signedIn = () => planned("search").signedIn; // maxTier 1: the jar alone
  saveSession("fixture", { cookies: ANONYMOUS_COOKIES, values: {} });
  assert.equal(signedIn(), false, "analytics, consent, bot-management, CSRF and Google's signed-out cookies");
  assert.equal(hostSite("fixture")?.site.signedIn, false);
  for (const login of ACCOUNT_COOKIES) {
    saveSession("fixture", { cookies: [...ANONYMOUS_COOKIES, login], values: {} });
    assert.equal(signedIn(), true, login.name);
  }
  saveSession("fixture", { cookies: [cookie("an-unknown-name", "x")], values: {} });
  assert.equal(signedIn(), true, "an unknown name is no evidence of anonymity");
  saveSession("fixture", { cookies: [ACCOUNT_COOKIES[1]!], values: {}, guestCookies: ["JSESSIONID"] });
  assert.equal(signedIn(), false, "a name a signed-out visit to the site was given");
  saveSite({ ...site, loginCookies: ["JSESSIONID"] });
  assert.equal(signedIn(), true, "a pinned login name counts even when a guest is given it");
  saveSite({ ...site, loginCookies: ["member"] });
  saveSession("fixture", { cookies: [ACCOUNT_COOKIES[0]!], values: {} });
  assert.equal(signedIn(), true, "a pinned name never makes another name anonymous");
  saveSite(site);

  saveSession("fixture", { cookies: ANONYMOUS_COOKIES, values: {} });
  const write = planned("addTodo", { title: "before the login" });
  assert.equal(write.signedIn, false);
  saveSession("fixture", { cookies: [...ANONYMOUS_COOKIES, ACCOUNT_COOKIES[0]!], values: {} });
  const refused = await callPlanned(write, { ...opts, allowWrites: true });
  assert.equal(refused.class, "refused", JSON.stringify(refused));
  assert.equal(refused.write, "not_sent");
  assert.deepEqual(fixture.calls, []);
});

test("a stored session value the request fills counts as signed in, and its arrival refuses an approved write unsent", async () => {
  const bearer = { ref: "session:bearer", at: ["header:authorization"] };
  const withBearer = (op: Site["operations"][number]) => ({
    ...op,
    request: { ...op.request, headers: { ...op.request.headers, authorization: "" } },
    slots: [...op.slots, bearer],
  });
  saveSite({ ...site, operations: site.operations.map((op) => (op.name === "todos" ? op : withBearer(op))) });
  const write = planned("addTodo", { title: "before the token" });
  assert.equal(write.signedIn, false);
  assert.equal(write.request.headers.authorization, undefined, "no stored value: the header is left out, as sent");
  const token = "Bearer synthetic-account-token-123";
  saveSession("fixture", { cookies: [], values: { bearer: token }, valueHosts: { bearer: "127.0.0.1" } });
  const read = planned("search");
  assert.equal(read.signedIn, true, "no source and no cookie: the bearer alone");
  assert.equal(read.request.headers.authorization, "<bearer>");
  assert.equal(hostSite("fixture")?.site.signedIn, true);
  const refused = await callPlanned(write, { ...opts, allowWrites: true });
  assert.equal(refused.class, "refused", JSON.stringify(refused));
  assert.equal(refused.write, "not_sent");
  assert.equal(fixture.calls.length, 0);
  const sent = await callPlanned(read, opts);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(fixture.calls[0]?.headers.authorization, token, "the plan said signed in, and the account went");

  // A value the call cannot send is none: bound to another host, or empty.
  saveSession("fixture", { cookies: [], values: { bearer: token }, valueHosts: { bearer: "elsewhere.test" } });
  assert.equal(planned("search").signedIn, false);
  saveSession("fixture", { cookies: [], values: { bearer: "" }, valueHosts: { bearer: "127.0.0.1" } });
  assert.equal(planned("search").signedIn, false);
  // A write's readback read is sent with the session too.
  saveSite({ ...site, operations: site.operations.map((op) => (op.name === "todos" ? withBearer(op) : op)) });
  saveSession("fixture", { cookies: [], values: { bearer: token }, valueHosts: { bearer: "127.0.0.1" } });
  assert.equal(planned("addTodo", { title: "read back with a token" }).signedIn, true);
});

test("an own-profile cookie on the site's domains counts unless its name is known to be anonymous", () => {
  profileDb().close();
  const only = (name: string) => {
    const db = new DatabaseSync(join(home, "profile", "Default/Network/Cookies"));
    db.exec("DELETE FROM cookies");
    db.prepare("INSERT INTO cookies VALUES(?, ?)").run("127.0.0.1", name);
    db.close();
    return hostSite("fixture")?.site.signedIn;
  };
  for (const name of ["an-unknown-name", ...ACCOUNT_COOKIES.map((c) => c.name)]) assert.equal(only(name), true, name);
  for (const { name } of ANONYMOUS_COOKIES) assert.equal(only(name), false, name);
  saveSession("fixture", { cookies: [], values: {}, guestCookies: ["JSESSIONID"] });
  assert.equal(only("JSESSIONID"), false, "a name a signed-out visit to the site was given");
  saveSite({ ...site, loginCookies: ["JSESSIONID"] });
  assert.equal(only("JSESSIONID"), true, "a pinned login name");
});

test("a session: ref shows its placeholder before a tier-3 run first captures its value", () => {
  const op = site.operations[0]!;
  saveSite({
    ...site,
    operations: [
      {
        ...op,
        minTier: 3,
        request: { ...op.request, headers: { "x-guest-token": "" } },
        slots: [...op.slots, { ref: "session:x-guest-token", at: ["header:x-guest-token"] }],
      },
    ],
  });
  const before = planCall("fixture", "search");
  assert.ok(before.ok, JSON.stringify(before));
  assert.equal(before.tier, 3);
  assert.equal(before.request.headers["x-guest-token"], "<x-guest-token>");
  // What a read's tier-3 run stores: the page's anonymous cookies and the op's session value.
  mergeCapture("fixture", [cookie("NID", "511=set-by-the-page")], {
    from: op.request.url,
    values: { "x-guest-token": "1700000000123456789" },
  });
  assert.deepEqual(planCall("fixture", "search"), before);
  saveSession("fixture", {
    cookies: [],
    values: { "x-guest-token": "1700000000123456789" },
    valueHosts: { "x-guest-token": "elsewhere.test" },
  });
  const elsewhere = planCall("fixture", "search");
  assert.ok(elsewhere.ok);
  assert.equal(elsewhere.request.headers["x-guest-token"], undefined, "a stored value the call cannot send");
  assert.deepEqual(fixture.calls, []);
});

test("a bearer a tier-3 page captured from its storage makes the next plan signed in, with no cookie", () => {
  const op = site.operations[0]!;
  saveSite({
    ...site,
    operations: [
      {
        ...op,
        minTier: 3,
        request: { ...op.request, headers: { authorization: "" } },
        slots: [...op.slots, { ref: "session:authorization", at: ["header:authorization"] }],
      },
    ],
  });
  const before = planCall("fixture", "search");
  assert.ok(before.ok, JSON.stringify(before));
  assert.equal(before.tier, 3);
  assert.equal(before.signedIn, false);
  mergeCapture("fixture", [], { from: op.request.url, values: { authorization: "Bearer stored-in-local-storage" } });
  const after = planCall("fixture", "search");
  assert.ok(after.ok);
  assert.equal(after.signedIn, true, "the page holds an account bearer even though it fills it itself");
  assert.notDeepEqual(after, before, "an anonymous approval no longer matches");
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

test("planning rejects null, arrays, primitives and non-plain argument objects", () => {
  for (const args of [null, [], "q=alice", 42, false, new Date(), new Map(), Object.create({ q: "alice" })]) {
    const plan = planCall("fixture", "search", args);
    assert.equal(plan.ok, false);
    if (!plan.ok) {
      assert.equal(plan.result.class, "input");
      assert.match(plan.result.reason ?? "", /plain object/);
    }
  }
  assert.ok(planCall("fixture", "search", Object.create(null)).ok);
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
  assert.equal(a.request.headers.cookie, "<per-site jar cookies>");
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
    { ...plan, signedIn: !plan.signedIn },
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
    if (name === "search") {
      assert.match(result.next ?? "", /api-anything heal fixture search/);
      assert.equal(result.nextCall?.action, "heal");
    } else {
      assert.match(result.next ?? "", /api-anything add fixture addTodo .* --write/);
      assert.equal(result.nextCall?.action, "relearn");
      assert.equal(result.write, "not_applied");
    }
    assert.equal(result.healed, undefined);
    assert.deepEqual(readFileSync(path), before);
  }
  assert.equal(fixture.calls.length, 2, "only the operation requests, no rescan or example probes");
  assert.equal(existsSync(join(home, "heals.jsonl")), false);
  const noHeal = await heal("fixture", "search", {}, { ...opts, callOnly: true });
  assert.equal(noHeal.class, "refused");
  assert.equal(fixture.calls.length, 2);
});

test("callOnly write drift after a 2xx keeps the check-site warning and never suggests heal", async () => {
  saveSite({
    ...site,
    operations: [{ ...site.operations[2]!, readback: undefined, response: { format: "json", extract: "missing" } }],
  });
  let sends = 0;
  const result = await callPlanned(planned("addTodo", { title: "ambiguous drift" }), {
    ...opts,
    allowWrites: true,
    fetchImpl: async () => {
      sends++;
      return new Response('{"data":{"created":{"id":1}},"errors":[{"message":"unknown field"}]}');
    },
  });
  assert.equal(result.class, "drift", JSON.stringify(result));
  assert.equal(result.write, "may_have_applied");
  assert.equal(result.retry, "no");
  assert.equal(result.nextCall?.action, "check_site");
  assert.match(result.next ?? "", /may have run: check the site first/);
  assert.match(result.next ?? "", /api-anything add fixture addTodo .* --write/);
  assert.doesNotMatch(result.next ?? "", /api-anything heal/);
  assert.equal(sends, 1);
});

test("a read learned signed in whose data is missing with no login cookie asks for a login, not a heal", async () => {
  saveSite({ ...site, operations: [{ ...site.operations[0]!, learnedLoggedIn: true }] });
  let sends = 0;
  const result = await callPlanned(planned("search"), {
    ...opts,
    fetchImpl: async () => {
      sends++;
      return new Response('{"data":{}}', { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result.class, "auth", JSON.stringify(result));
  assert.match(result.reason ?? "", /learned signed in/);
  assert.equal(result.nextCall?.action, "login");
  assert.equal(sends, 1);
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
  // A host has no get_result or maxChars: the note names only fields and the arguments, and nothing is kept.
  assert.match(list.truncated, /pass fields to keep fewer fields per item, or narrow the arguments$/);
  assert.doesNotMatch(list.truncated, /get_result|maxChars/);
  assert.equal(list.resultId, undefined);
  assert.equal(list.more, undefined);
  assert.equal(existsSync(join(home, "results.json")), false);
  const picked = await callPlanned(planned("search"), { ...opts, view: { fields: ["id"] } });
  assert.equal(picked.ok, true, JSON.stringify(picked));
  assert.ok(Array.isArray(picked.data) && picked.data.length > (list.data as unknown[]).length);
  assert.deepEqual(Object.keys((picked.data as Record<string, unknown>[])[0]!), ["id"]);
  // Use a separate site so the fixture's previous limited calls cannot affect this test.
  saveSite({
    ...site,
    name: "limited",
    operations: [
      { ...site.operations[0]!, request: { method: "GET", url: `${fixture.url}/api/limited`, headers: {} } },
    ],
  });
  const plan = planCall("limited", "search", {}, opts);
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
    const plan = planCall("external", "search", {}, opts);
    assert.ok(plan.ok, JSON.stringify(plan));
    const result = await callPlanned(plan, opts);
    assert.equal(result.class, "error", JSON.stringify(result));
    assert.equal(result.nextCall?.action, "report");
    assert.equal(fixture.calls.length, 0);
  } finally {
    resolver.lookup = lookup;
  }
});

test("planning filters unbound values for bundled specs without deleting them until execution", async () => {
  const op = site.operations[0]!;
  const dir = join(home, "bundled");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "fixture.json"),
    JSON.stringify({
      ...site,
      operations: [
        {
          ...op,
          request: { ...op.request, headers: { authorization: "" } },
          slots: [...op.slots, { ref: "session:bearer", at: ["header:authorization"] }],
        },
      ],
    }),
  );
  rmSync(join(home, "sites", "fixture.json"));
  setBundledDir(dir);
  saveSession("fixture", { cookies: [], values: { bearer: "unbound-value" } });
  const before = readFileSync(sessionFile("fixture"));
  const plan = planned("search");
  assert.equal(plan.request.headers.authorization, undefined);
  assert.deepEqual(readFileSync(sessionFile("fixture")), before, "planning never writes the session");
  let authorization: string | null | undefined;
  const result = await callPlanned(plan, {
    ...opts,
    fetchImpl: async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response('{"data":{"results":["ok"]}}', { headers: { "content-type": "application/json" } });
    },
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(authorization, null);
  assert.deepEqual(loadSession("fixture").values, {});
});

test("planning and execution both omit session credentials for agent-pulled POST reads and candidates", async () => {
  for (const candidate of [false, true]) {
    const op = site.operations[0]!;
    saveSite(
      parseSite({
        ...site,
        name: "external",
        baseUrl: "https://example.com",
        shared: { from: `${registry.url}/v1/sites/external`, sha256: "0".repeat(64), by: "agent" },
        operations: [
          {
            ...op,
            request: {
              method: candidate ? "GET" : "POST",
              url: "https://example.com/api/search?q=alice",
              headers: { authorization: "" },
            },
            slots: [...op.slots, { ref: "session:bearer", at: ["header:authorization"] }],
            match: { method: candidate ? "GET" : "POST", host: "example.com", path: "/api/search" },
            trigger: { url: "https://example.com/search?q={q}" },
            ...(candidate ? { version: { hash: "b".repeat(64), status: "candidate" } } : {}),
          },
        ],
      }),
    );
    saveSession("external", {
      cookies: [],
      values: { bearer: "bound-but-not-allowed" },
      valueHosts: { bearer: "example.com" },
    });
    const plan = planCall("external", "search", {}, opts);
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.equal(plan.request.headers.authorization, undefined);
    const before = readFileSync(sessionFile("external"));
    const lookup = resolver.lookup;
    resolver.lookup = async () => [{ address: "203.0.113.1" }];
    try {
      const result = await callPlanned(plan, {
        ...opts,
        fetchImpl: async (_url, init) => {
          assert.equal(new Headers(init?.headers).get("authorization"), null);
          assert.equal(new Headers(init?.headers).get("cookie"), null);
          return new Response('{"data":{"results":["ok"]}}');
        },
      });
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(readFileSync(sessionFile("external")), before);
    } finally {
      resolver.lookup = lookup;
    }
  }
});

test("plans bind their tier and cap, including remembered tiers and caps below minTier", async () => {
  rememberTier("fixture", "search", 3);
  const high = planCall("fixture", "search");
  assert.ok(high.ok);
  assert.equal(high.tier, 3);
  assert.equal(high.maxTier, 3);
  assert.deepEqual(high.trigger, { url: `${fixture.url}/scoped?q=alice` });
  const low = planned("search");
  assert.equal(low.tier, 1, "a remembered tier above the cap is ignored");
  assert.equal(low.trigger, undefined);
  assert.notEqual(low.fingerprint, high.fingerprint);
  assert.equal((await callPlanned(high, opts)).class, "refused");
  assert.equal((await callPlanned({ ...high, tier: 2 })).class, "refused");
  assert.equal((await callPlanned({ ...high, maxTier: 2 })).class, "refused");
  assert.equal((await callPlanned({ ...high, trigger: { url: `${fixture.url}/different` } })).class, "refused");
  rememberTier("fixture", "search", 2);
  assert.equal((await callPlanned(high)).class, "refused", "a changed starting tier needs new approval");
  saveSite({ ...site, operations: [{ ...site.operations[0]!, minTier: 3 }] });
  const blocked = planCall("fixture", "search", {}, opts);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.result.class, "blocked");
  assert.deepEqual(fixture.calls, []);
});

test("tier-cap planning returns the same recovery step as call for ordinary and unconfirmed operations", async () => {
  for (const agent of [false, true]) {
    saveSite(
      parseSite({
        ...site,
        name: "external",
        baseUrl: "https://example.com",
        ...(agent
          ? { shared: { from: `${registry.url}/v1/sites/external`, sha256: "0".repeat(64), by: "agent" } }
          : {}),
        operations: [
          {
            ...site.operations[0]!,
            minTier: 3,
            request: { method: "GET", url: "https://example.com/api/search?q=alice", headers: {} },
            match: { method: "GET", host: "example.com", path: "/api/search" },
            trigger: { url: "https://example.com/search?q={q}" },
            ...(agent ? { version: { hash: "b".repeat(64), status: "candidate" } } : {}),
          },
        ],
      }),
    );
    for (const maxTier of agent ? ([2, 3] as const) : ([2] as const)) {
      const plan = planCall("external", "search", {}, { maxTier });
      assert.equal(plan.ok, false);
      if (plan.ok) throw new Error("expected a tier-cap refusal");
      const result = await call("external", "search", {}, { maxTier, callOnly: true });
      assert.deepEqual(plan.result, { ...result, ms: 0 });
      assert.equal(plan.result.nextCall?.action, agent && maxTier === 3 ? "report" : "raise_tier");
      if (!agent) assert.doesNotMatch(plan.result.next ?? "", /unconfirmed/);
    }
  }
  assert.deepEqual(fixture.calls, []);
});

test("tier-3 plans fill and redact the URL, soft navigation and steps", () => {
  const token = ["Secret", "Token", "Abcd", "ef123456789"].join("");
  saveSession("fixture", { cookies: [], values: { token } });
  saveSite({
    ...site,
    operations: [
      {
        ...site.operations[0]!,
        minTier: 3,
        trigger: {
          url: `${fixture.url}/scoped?q={q}`,
          softFrom: `${fixture.url}/?key=${token}`,
          steps: [
            { action: "fill", selector: `#${token}`, value: "{q}" },
            { action: "goto", value: `${fixture.url}/next?q={q}` },
            { action: "click", selector: "#submit" },
          ],
        },
      },
    ],
  });
  const plan = planCall("fixture", "search", { q: token });
  assert.ok(plan.ok, JSON.stringify(plan));
  assert.equal(plan.tier, 3);
  assert.equal(plan.request.headers.cookie, "<browser-profile cookies>");
  assert.ok(plan.trigger?.steps);
  assert.deepEqual(scanSecrets(plan.trigger, loadSession("fixture")).secrets, []);
  assert.doesNotMatch(JSON.stringify(plan.trigger), new RegExp(token));
  assert.match(plan.trigger.url, /session:token/);
});

test("tier-3 write plans show confirm counts and steps plus redacted companion matches", async () => {
  const token = ["Synthetic", "Companion", "Value123456789"].join("");
  saveSession("fixture", { cookies: [], values: { token } });
  const trigger = {
    url: `${fixture.url}/todos/{title}`,
    steps: [{ action: "click" as const, selector: "#send" }],
    confirms: [
      { step: -1, digest: "a".repeat(64) },
      { step: 0, digest: "b".repeat(64) },
      { step: 0, digest: "c".repeat(64) },
    ],
    companions: [{ method: "POST", host: `api.${token}.test`, path: `/cart/${token}`, operationName: token }],
  };
  saveSite({
    ...site,
    operations: [{ ...site.operations[2]!, minTier: 3, match: { method: "POST", path: "/api/todos" }, trigger }],
  });
  const plan = planCall("fixture", "addTodo", { title: "approved todo" });
  assert.ok(plan.ok, JSON.stringify(plan));
  assert.deepEqual(plan.trigger?.confirms, { count: 3, steps: [-1, 0, 0] });
  assert.equal(plan.trigger?.companions?.[0]?.method, "POST");
  for (const field of ["host", "path", "operationName"] as const)
    assert.match(plan.trigger?.companions?.[0]?.[field] ?? "", /session:token/);
  assert.doesNotMatch(JSON.stringify(plan.trigger), new RegExp(token));
  assert.deepEqual(scanSecrets(plan.trigger, loadSession("fixture")).secrets, []);
  const changed = structuredClone(plan);
  assert.ok(changed.trigger);
  changed.trigger.companions = [];
  const result = await callPlanned(changed, { allowWrites: true });
  assert.equal(result.class, "refused");
  assert.equal(result.write, "not_sent");
  assert.deepEqual(fixture.calls, []);
});

function profileDb(relative = "Default/Network/Cookies") {
  const path = join(home, "profile", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE cookies(host_key TEXT, name TEXT)");
  return db;
}

test("signedIn checks own-profile cookie names across registrable domains without reading values or writing", () => {
  const db = profileDb();
  db.prepare("INSERT INTO cookies VALUES(?, ?)").run(".other.test", "sid");
  db.close();
  const path = join(home, "profile", "Default/Network/Cookies");
  writeFileSync(`${path}-journal`, "");
  const files = readdirSync(join(home, "profile"), { recursive: true }).sort();
  const before = readFileSync(path);
  assert.equal(hostSite("fixture")?.site.signedIn, false);
  assert.deepEqual(readdirSync(join(home, "profile"), { recursive: true }).sort(), files);
  const insert = (rows: [string, string][]) => {
    const edit = new DatabaseSync(path);
    for (const row of rows) edit.prepare("INSERT INTO cookies VALUES(?, ?)").run(...row);
    edit.close();
  };
  insert([
    ["127.0.0.1", "guest"],
    [".www.google.com", "NID"],
    [".api.example.co.uk", "CONSENT"],
    [".api.example.co.uk", "csrftoken"],
  ]);
  // A signed-out visit to the fixture was recorded being given `guest`.
  saveSession("fixture", { cookies: [], values: {}, guestCookies: ["guest"] });
  saveSite({
    ...site,
    name: "sibling",
    baseUrl: "https://www.example.co.uk",
    operations: [
      {
        ...site.operations[0]!,
        request: { ...site.operations[0]!.request, url: "https://www.example.co.uk/api/search?q=alice" },
        trigger: { url: "https://www.example.co.uk/search?q={q}" },
      },
    ],
  });
  assert.equal(hostSite("fixture")?.site.signedIn, false, "known-anonymous and recorded guest names are no sign-in");
  assert.equal(hostSite("sibling")?.site.signedIn, false);
  saveSite({ ...site, loginCookies: ["guest"] });
  assert.equal(hostSite("fixture")?.site.signedIn, true, "a pinned loginCookies name counts by name");
  saveSite(site);
  rmSync(sessionFile("fixture"));
  assert.equal(hostSite("fixture")?.site.signedIn, true, "with no recorded guest list, `guest` is an unknown name");
  insert([
    ["127.0.0.1", "sessionid"],
    [".api.example.co.uk", "__Secure-1PSID"],
  ]);
  const stored = readFileSync(path);
  const storedFiles = readdirSync(join(home, "profile"), { recursive: true }).sort();
  assert.notDeepEqual(stored, before);
  assert.equal(hostSite("fixture")?.site.signedIn, true, "a missing per-site session cannot hide profile cookies");
  assert.equal(hostSite("sibling")?.site.signedIn, true, "a login cookie on another host of the registrable domain");
  const browser = planCall("fixture", "search");
  assert.ok(browser.ok);
  assert.equal(browser.signedIn, true, "a read may climb from tier 1");
  assert.equal(planned("search").signedIn, false, "maxTier 1 never consults the profile");
  assert.deepEqual(readFileSync(path), stored);
  assert.deepEqual(readdirSync(join(home, "profile"), { recursive: true }).sort(), storedFiles);
  assert.deepEqual(fixture.calls, []);
});

test("signedIn reads both cookie database locations, since a stale one can sit beside the live one", () => {
  profileDb().close();
  const legacy = profileDb("Default/Cookies");
  legacy.prepare("INSERT INTO cookies VALUES(?, ?)").run(".127.0.0.1", "sid");
  legacy.close();
  assert.equal(hostSite("fixture")?.site.signedIn, true, "a cookie in the legacy database counts");
  rmSync(join(home, "profile", "Default", "Network"), { recursive: true });
  const empty = new DatabaseSync(join(home, "profile", "Default/Cookies"));
  empty.exec("DELETE FROM cookies");
  empty.close();
  assert.equal(hostSite("fixture")?.site.signedIn, false, "an empty legacy-only database is read, not assumed");
});

test("planning a WAL-mode profile never creates shared-memory or WAL files in the profile", () => {
  const db = profileDb();
  db.exec("PRAGMA journal_mode=WAL");
  db.close();
  const profile = join(home, "profile");
  const path = join(profile, "Default/Network/Cookies");
  const before = readFileSync(path);
  const files = readdirSync(profile, { recursive: true }).sort();
  assert.equal(before[18], 2, "the fixture retains SQLite's WAL header after closing");
  const plan = planCall("fixture", "search");
  assert.ok(plan.ok, JSON.stringify(plan));
  assert.equal(plan.signedIn, true, "WAL mode is conservatively signed in without opening SQLite");
  assert.equal(hostSite("fixture")?.site.signedIn, true);
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readdirSync(profile, { recursive: true }).sort(), files);
  assert.deepEqual(fixture.calls, []);
});

test("loading SQLite for host planning suppresses only its experimental warning", () => {
  profileDb().close();
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import { planCall } from ${JSON.stringify(new URL("../src/host.ts", import.meta.url).href)};
       const plan = planCall("fixture", "search");
       assert.ok(plan.ok);
       assert.equal(plan.signedIn, false);
       process.emitWarning("synthetic host warning");`,
    ],
    { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "", NODE_OPTIONS: "" } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /SQLite is an experimental/);
  assert.match(result.stderr, /synthetic host warning/);
});

test("signedIn fails closed for a locked or malformed own profile, but ignores it at maxTier 1", () => {
  const db = profileDb();
  db.exec("BEGIN EXCLUSIVE");
  try {
    const plan = planCall("fixture", "search");
    assert.ok(plan.ok);
    assert.equal(plan.signedIn, true);
    assert.equal(planned("search").signedIn, false);
    assert.equal(hostSite("fixture")?.site.signedIn, true);
  } finally {
    db.exec("ROLLBACK");
    db.exec("DROP TABLE cookies");
    db.close();
  }
  const malformed = planCall("fixture", "search");
  assert.ok(malformed.ok);
  assert.equal(malformed.signedIn, true, "missing schema is not proof of sign-out");
});

test("signedIn fails closed for a running profile or uncheckpointed cookies without opening SQLite", () => {
  const db = profileDb();
  db.close();
  const cookieFile = join(home, "profile", "Default/Network/Cookies");
  const before = readFileSync(cookieFile);
  for (const marker of [`${cookieFile}-wal`, `${cookieFile}-journal`, join(home, "profile", "SingletonLock")]) {
    writeFileSync(marker, "synthetic pending state");
    const plan = planCall("fixture", "search");
    assert.ok(plan.ok);
    assert.equal(plan.signedIn, true);
    assert.equal(hostSites().find((s) => s.name === "fixture")?.signedIn, true);
    assert.equal(planned("search").signedIn, false);
    assert.deepEqual(readFileSync(cookieFile), before);
    assert.equal(existsSync(`${cookieFile}-shm`), false);
    rmSync(marker);
  }
});

test("an unresolved trigger origin conservatively counts any own-profile cookie, without leaking placeholder hosts", () => {
  const db = profileDb();
  db.prepare("INSERT INTO cookies VALUES(?, ?)").run(".another-site.test", "sid");
  db.close();
  saveSite({
    ...site,
    operations: [{ ...site.operations[0]!, trigger: { url: "{q}" } }],
  });
  const plan = planCall("fixture", "search", { q: "https://another-site.test/page" });
  assert.ok(plan.ok);
  assert.equal(plan.signedIn, true, "a read can reach a fully templated trigger on another signed-in domain");
  assert.equal(hostSite("fixture")?.site.signedIn, true);
  assert.deepEqual(hostSite("fixture")?.site.hosts, ["127.0.0.1"]);
});

test("discovery includes lookup and inline readback hosts, and omits invalid or templated origins only", () => {
  saveSite(
    parseSite({
      ...site,
      operations: [
        {
          ...site.operations[2]!,
          request: { method: "POST", url: "https://api.example.test/write", headers: {} },
          slots: [
            {
              from: { request: { method: "GET", url: "https://lookup.example.test/id", headers: {} } },
              path: "id",
              at: ["query:id"],
            },
          ],
          trigger: { url: "https://{tenant}.example.test/write" },
          readback: {
            read: {
              ...site.operations[1]!,
              request: { method: "GET", url: "https://readback.example.test/read", headers: {} },
              trigger: { url: "https://pages.example.test/read/{id}" },
            },
          },
        },
        { ...site.operations[0]!, trigger: { url: "{url}" } },
        {
          ...site.operations[1]!,
          trigger: {
            url: "https://pages.example.test/todos/{id}?ignored=1#fragment",
            softFrom: "https://neutral.example.test/",
            steps: [{ action: "goto", value: "https://next.example.test/" }],
          },
        },
      ],
    }),
  );
  const found = hostSite("fixture");
  assert.ok(found);
  assert.deepEqual(found.site.hosts, [
    "127.0.0.1",
    "api.example.test",
    "lookup.example.test",
    "readback.example.test",
    "pages.example.test",
    "neutral.example.test",
    "next.example.test",
  ]);
  assert.deepEqual(found.site.operations[0]?.pages, []);
  assert.deepEqual(found.site.operations[1]?.pages, []);
  assert.deepEqual(found.site.operations[2]?.pages, ["https://pages.example.test/todos/"]);
  assert.ok(
    hostSites().some((s) => s.name === "fixture"),
    "an unparseable URL never drops the whole site",
  );
});

test("callPlanned returns the fresh planning failure for invalid specs and corrupt sessions", async () => {
  const plan = planned("search");
  const path = join(home, "sites", "fixture.json");
  const before = readFileSync(path);
  writeFileSync(path, '{"operations":');
  let fresh = planCall("fixture", "search", {}, opts);
  assert.equal(fresh.ok, false);
  if (!fresh.ok) assert.deepEqual(await callPlanned(plan, opts), fresh.result);
  writeFileSync(path, before);
  saveSession("fixture", { cookies: [], values: {} });
  writeFileSync(sessionFile("fixture"), "null");
  fresh = planCall("fixture", "search", {}, opts);
  assert.equal(fresh.ok, false);
  if (!fresh.ok) {
    assert.deepEqual(await callPlanned(plan, opts), fresh.result);
    const direct = await call("fixture", "search", {}, { ...opts, callOnly: true });
    assert.deepEqual(fresh.result, { ...direct, ms: 0 }, "a corrupt session gets call()'s answer and next step");
  }
  assert.deepEqual(fixture.calls, []);
});

test("planning answers bad args before a tier cap, as call does", async () => {
  saveSite({ ...site, operations: [{ ...site.operations[2]!, minTier: 2 }] });
  const plan = planCall("fixture", "addTodo", { title: "no" }, opts);
  const result = await call("fixture", "addTodo", { title: "no" }, { ...opts, callOnly: true, allowWrites: true });
  assert.equal(result.class, "input");
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.deepEqual(plan.result, { ...result, ms: 0 });
  assert.deepEqual(fixture.calls, []);
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
