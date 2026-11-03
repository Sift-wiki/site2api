/** node:test module mocks require --experimental-test-module-mocks; launched by host-browser.test.ts. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { PageFetchResult } from "../../src/browser.js";
import type { TriggerRun } from "../../src/heal.js";
import { loadSession, saveSession } from "../../src/session.js";
import { parseSite, type Site } from "../../src/spec.js";
import { rememberTier, saveSite } from "../../src/store.js";
import type { StoredCookie } from "../../src/types.js";

const browser = await import("../../src/browser.js");
const pageCalls: Parameters<typeof browser.pageFetch>[0][] = [];
let pageStatus = 200;
let triggerStatus = 200;
let cookieReads = 0;
let profileJar: StoredCookie[];
const cookie: StoredCookie = {
  name: "sid",
  value: "profile-other-account",
  domain: "127.0.0.1",
  path: "/",
  expires: -1,
  secure: false,
  httpOnly: true,
};
mock.module(new URL("../../src/browser.ts", import.meta.url).href, {
  namedExports: {
    ...browser,
    browserAvailable: () => true,
    closeBrowser: async () => {},
    profileCookies: async () => {
      cookieReads++;
      return profileJar;
    },
    pageFetch: async (options: Parameters<typeof browser.pageFetch>[0]): Promise<PageFetchResult> => {
      pageCalls.push(options);
      return {
        status: pageStatus,
        body: pageStatus === 200 ? '{"items":["page"]}' : "Unauthorized",
        headers: {},
        url: options.url,
        ms: 0,
      };
    },
    runTrigger: async () => {
      throw new Error("unexpected raw browser run");
    },
  },
});
const heal = await import("../../src/heal.js");
const triggerCalls: { op: string; intercept?: boolean }[] = [];
mock.module(new URL("../../src/heal.ts", import.meta.url).href, {
  namedExports: {
    ...heal,
    runOpTrigger: async (
      _site: string,
      op: Site["operations"][number],
      _args: Record<string, unknown>,
      options: { intercept?: boolean } = {},
    ): Promise<TriggerRun> => {
      triggerCalls.push({ op: op.name, ...options });
      assert.notEqual(options.intercept, true, "callOnly must never recapture a write's auth token");
      const matched = {
        id: 1,
        resourceType: "fetch",
        request: op.request,
        response: {
          status: triggerStatus,
          headers: {},
          body: triggerStatus === 200 ? '{"items":["trigger"]}' : "Unauthorized",
          contentType: "application/json",
        },
      };
      return { matched, capture: { cookies: [], exchanges: [matched], finalUrl: op.trigger.url } };
    },
  },
});
const { call } = await import("../../src/execute.js");
const { planCall, callPlanned } = await import("../../src/host.js");
const base = "http://127.0.0.1";
let home: string;
let site: Site;
let sends: number;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "api-anything-host-browser-"));
  process.env.API_ANYTHING_HOME = home;
  // Any accidentally introduced registry/import path must fail locally, never access an account.
  process.env.API_ANYTHING_BROWSER_ROOTS = "[]";
  globalThis.fetch = async () => {
    throw new Error("unexpected network request");
  };
  pageCalls.length = 0;
  triggerCalls.length = 0;
  cookieReads = 0;
  profileJar = [cookie];
  sends = 0;
  pageStatus = 200;
  triggerStatus = 200;
  site = parseSite({
    name: "fixture",
    baseUrl: base,
    operations: [
      {
        name: "read",
        readOnly: true,
        request: { method: "GET", url: `${base}/api/items`, headers: {} },
        trigger: { url: `${base}/items` },
        response: { extract: "items" },
      },
      {
        name: "write",
        readOnly: false,
        request: { method: "POST", url: `${base}/api/create`, headers: { authorization: "" }, body: "{}" },
        match: { method: "POST", host: "127.0.0.1", path: "/api/create" },
        slots: [{ ref: "session:bearer", at: ["header:authorization"] }],
        trigger: { url: `${base}/compose`, steps: [{ action: "click", selector: "#send" }], companions: [] },
      },
    ],
  });
  saveSite(site);
});
afterEach(() => {
  assert.equal(existsSync(join(home, "heals.jsonl")), false);
  rmSync(home, { recursive: true, force: true });
});

const response =
  (status: number): typeof fetch =>
  async () => {
    sends++;
    return new Response(status === 200 ? '{"items":["http"]}' : status === 403 ? "Forbidden" : "Unauthorized", {
      status,
    });
  };
const plan = (op: string, maxTier: 1 | 2 | 3 = 3) => {
  const p = planCall("fixture", op, {}, { maxTier });
  assert.ok(p.ok, JSON.stringify(p));
  return p;
};
const original = () => readFileSync(join(home, "sites", "fixture.json"));

test("callOnly writes stay at the approved tier after a bare 403; reads still climb", async () => {
  const p = plan("write");
  assert.equal(p.tier, 1);
  const before = original();
  const result = await callPlanned(p, { allowWrites: true, fetchImpl: response(403) });
  assert.equal(result.class, "blocked", JSON.stringify(result));
  assert.equal(result.write, "not_applied");
  assert.equal(result.tier, 1);
  assert.equal(sends, 1);
  assert.deepEqual(pageCalls, []);
  assert.deepEqual(triggerCalls, []);
  assert.equal(cookieReads, 0);
  assert.deepEqual(original(), before);
  const read = await callPlanned(plan("read"), { fetchImpl: response(403) });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.tier, 2);
  assert.equal(pageCalls.length, 1);
});

test("callOnly writes never refresh cookies or intercept-recapture after a 401", async () => {
  saveSession("fixture", { cookies: [{ ...cookie, value: "approved-account" }], values: { bearer: "expired" } });
  const p = plan("write");
  const result = await callPlanned(p, { allowWrites: true, fetchImpl: response(401) });
  assert.equal(result.class, "auth", JSON.stringify(result));
  assert.equal(result.write, "not_applied");
  assert.equal(sends, 1);
  assert.equal(cookieReads, 0);
  assert.deepEqual(triggerCalls, []);
  assert.equal(loadSession("fixture").cookies[0]?.value, "approved-account");
});

test("a planned tier-2 write uses profile-cookie preview and sends once without tier-1 fetch", async () => {
  saveSite({ ...site, operations: [{ ...site.operations[1]!, minTier: 2 }] });
  saveSession("fixture", { cookies: [cookie], values: {} });
  const p = plan("write");
  assert.equal(p.tier, 2);
  assert.equal(p.request.headers.cookie, "<browser-profile cookies>");
  const result = await callPlanned(p, { allowWrites: true, fetchImpl: response(200) });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.write, "accepted");
  assert.equal(result.tier, 2);
  assert.equal(sends, 0);
  assert.equal(pageCalls.length, 1);
  assert.equal(pageCalls[0]?.headers.cookie, undefined, "the browser, not the jar, chooses cookies");
  assert.equal(pageCalls[0]?.retryOnNavigation, false);
});

test("a tier-3 write runs only its approved trigger and never runs a write without permission", async () => {
  saveSite({ ...site, operations: [{ ...site.operations[1]!, minTier: 3 }] });
  const p = plan("write");
  assert.equal(p.tier, 3);
  assert.deepEqual(p.trigger, site.operations[1]!.trigger);
  assert.equal((await callPlanned(p)).write, "not_sent");
  assert.deepEqual(triggerCalls, []);
  const result = await callPlanned(p, { allowWrites: true, fetchImpl: response(200) });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.tier, 3);
  assert.equal(result.write, "accepted");
  assert.deepEqual(triggerCalls, [{ op: "write" }]);
  assert.equal(sends, 0);
  assert.deepEqual(pageCalls, []);
  assert.equal(cookieReads, 0);
});

test("a tier-3 write auth failure may have applied and is never repeated or refreshed", async () => {
  saveSite({ ...site, operations: [{ ...site.operations[1]!, minTier: 3 }] });
  triggerStatus = 401;
  const result = await callPlanned(plan("write"), { allowWrites: true, fetchImpl: response(200) });
  assert.equal(result.class, "auth");
  assert.equal(result.write, "may_have_applied");
  assert.equal(result.retry, "no");
  assert.equal(result.nextCall?.action, "check_site");
  assert.match(result.next ?? "", /check the site/);
  assert.deepEqual(triggerCalls, [{ op: "write" }]);
  assert.equal(sends, 0);
  assert.equal(cookieReads, 0);
});

for (const missing of ["companions", "match"] as const) {
  test(`callOnly refuses a tier-3 write with no ${missing} before any transport or ledger entry`, async () => {
    const op = { ...site.operations[1]!, minTier: 3 as const };
    saveSite({ ...site, operations: [op] });
    const approved = plan("write");
    const { companions: _companions, ...oldTrigger } = op.trigger;
    saveSite({
      ...site,
      operations: [{ ...op, ...(missing === "match" ? { match: {} } : { trigger: oldTrigger }) }],
    });
    const before = original();
    const blocked = planCall("fixture", "write");
    assert.equal(blocked.ok, false);
    if (blocked.ok) throw new Error("expected an incomplete write to be refused");
    assert.equal(blocked.result.class, "refused");
    assert.equal(blocked.result.write, "not_sent");
    assert.match(blocked.result.reason ?? "", new RegExp(missing));
    assert.match(blocked.result.next ?? "", /re-learn.*api-anything add fixture write.*--write/);
    assert.equal(blocked.result.nextCall?.action, "relearn");
    const result = await call("fixture", "write", {}, { callOnly: true, allowWrites: true });
    assert.deepEqual(blocked.result, { ...result, ms: 0 });
    assert.deepEqual(await callPlanned(approved, { allowWrites: true }), blocked.result);
    assert.deepEqual(triggerCalls, []);
    assert.deepEqual(pageCalls, []);
    assert.equal(sends, 0);
    assert.equal(cookieReads, 0);
    assert.equal(existsSync(join(home, "writes.json")), false);
    assert.deepEqual(original(), before);
  });
}

test("a callOnly read can refresh profile cookies and run tier 3 without healing", async () => {
  const op = site.operations[0]!;
  saveSite({
    ...site,
    operations: [
      {
        ...op,
        request: { ...op.request, headers: { authorization: "" } },
        slots: [{ ref: "session:bearer", at: ["header:authorization"] }],
      },
    ],
  });
  saveSession("fixture", { cookies: [], values: { bearer: "expired" } });
  const before = original();
  const result = await callPlanned(plan("read"), { fetchImpl: response(401) });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.tier, 3);
  assert.equal(cookieReads, 1);
  assert.equal(sends, 2, "the read may resend with refreshed cookies");
  assert.deepEqual(triggerCalls, [{ op: "read" }]);
  assert.deepEqual(original(), before);
});

test("a remembered tier-2 write is bound to that starting tier and never refreshes on failure", async () => {
  rememberTier("fixture", "write", 2);
  pageStatus = 401;
  const p = plan("write");
  assert.equal(p.tier, 2);
  const result = await callPlanned(p, { allowWrites: true, fetchImpl: response(200) });
  assert.equal(result.class, "auth");
  assert.equal(result.write, "not_applied");
  assert.equal(pageCalls.length, 1);
  assert.equal(sends, 0);
  assert.equal(cookieReads, 0);
  assert.deepEqual(triggerCalls, []);
});

test("a bare 403 read with examples climbs to tier 2 without probing the example", async () => {
  const op = site.operations[0]!;
  saveSite(
    parseSite({
      ...site,
      operations: [
        {
          ...op,
          request: { ...op.request, url: `${base}/api/items?q=example-user` },
          params: [{ name: "q", example: "example-user" }],
          slots: [{ param: "q", at: ["query:q"] }],
        },
      ],
    }),
  );
  const p = planCall("fixture", "read", { q: "private-user" }, { maxTier: 2 });
  assert.ok(p.ok);
  const urls: string[] = [];
  const result = await callPlanned(p, {
    fetchImpl: async (url) => {
      urls.push(String(url));
      return new Response("Forbidden", { status: 403 });
    },
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.tier, 2);
  assert.deepEqual(urls, [`${base}/api/items?q=private-user`]);
  assert.equal(pageCalls.length, 1);
  assert.match(pageCalls[0]!.url, /q=private-user/);
  assert.deepEqual(triggerCalls, []);
});

test("a public credential read stays auth after tier-2 recovery, without calling drift/relearn", async () => {
  const op = site.operations[0]!;
  const authorization = ["public", "shared", "key"].join("-");
  saveSite({
    ...site,
    operations: [
      {
        ...op,
        public: ["authorization"],
        request: { ...op.request, headers: { authorization } },
      },
    ],
  });
  profileJar = [];
  pageStatus = 401;
  const before = original();
  const result = await callPlanned(plan("read"), { fetchImpl: response(401) });
  assert.equal(result.class, "auth", JSON.stringify(result));
  assert.equal(result.nextCall?.action, "login");
  assert.equal(cookieReads, 1);
  assert.equal(sends, 1);
  assert.equal(pageCalls.length, 1);
  assert.deepEqual(triggerCalls, []);
  assert.deepEqual(original(), before);
});
