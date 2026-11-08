/** The ladder's rules with an injected fetch and maxTier 1 (no browser): writes, heal guards, rate. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { type CallResult, call, finish, stepOf } from "../src/execute.js";
import { type Attempt, PROFILE_HINT } from "../src/heal.js";
import { buildRequest } from "../src/http.js";
import { importSession } from "../src/login.js";
import { OMITTED } from "../src/secrets.js";
import { lockWait, saveSession } from "../src/session.js";
import { parseSite } from "../src/spec.js";
import { coolDown, cooling, saveSite, staleMark } from "../src/store.js";
import type { StoredCookie } from "../src/types.js";
import { makeChromiumDb } from "./fixture/cookie-db.js";
import { holdInChild, kill } from "./fixture/locks.js";

const HOME = mkdtempSync(join(tmpdir(), "api-anything-exec-"));
process.env.API_ANYTHING_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

const QID = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7H";
const NEW = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3S";
const site = parseSite({
  name: "t",
  baseUrl: "https://t.test",
  operations: [
    {
      name: "user",
      readOnly: true,
      request: { method: "GET", url: `https://t.test/api/${QID}/User?name=alice`, headers: {} },
      slots: [{ param: "name", at: ["query:name"] }],
      volatile: [{ at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "User" }],
      trigger: { url: "https://t.test/u/{name}" },
      params: [{ name: "name" }],
      response: { extract: "user" },
    },
    {
      name: "post",
      readOnly: false,
      request: {
        method: "POST",
        url: "https://t.test/api/post",
        headers: { "content-type": "application/json" },
        body: '{"text":"x"}',
      },
      slots: [{ param: "text", at: ["body", "json:/text"] }],
      trigger: { url: "https://t.test/compose" },
      params: [{ name: "text" }],
    },
  ],
});

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let seen: { url: string; method: string }[] = [];
const fake = (h: Handler): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET" });
    return h(url, init);
  }) as typeof fetch;
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const opts = (h: Handler) => ({ fetchImpl: fake(h), maxTier: 1 as const, minIntervalMs: 0 });
const NO_SESSION = { cookies: [], values: {} };
const heals = () => {
  try {
    return readFileSync(join(HOME, "heals.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

beforeEach(() => {
  rmSync(join(HOME, "state.json"), { force: true });
  rmSync(join(HOME, "heals.jsonl"), { force: true });
  rmSync(join(HOME, "writes.json"), { force: true });
  saveSite(site);
  seen = [];
});

test("different object and array args check the working examples before healing", async () => {
  for (const [type, example, given] of [
    ["object", { q: "alice" }, { q: "missing" }],
    ["array", ["a", "b"], ["a,b"]],
  ] as const) {
    for (const status of [200, 403]) {
      saveSite(
        parseSite({
          name: "t",
          baseUrl: "https://t.test",
          operations: [
            {
              name: "structured",
              readOnly: true,
              request: {
                method: "POST",
                url: "https://t.test/api/search",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ filter: example }),
              },
              slots: [{ param: "filter", at: ["body", "json:/filter"] }],
              params: [{ name: "filter", type, example }],
              trigger: { url: "https://t.test/search" },
              response: { extract: "items" },
            },
          ],
        }),
      );
      const sent: unknown[] = [];
      const r = await call(
        "t",
        "structured",
        { filter: given },
        opts((_url, init) => {
          const filter = JSON.parse(init?.body as string).filter;
          sent.push(filter);
          return JSON.stringify(filter) === JSON.stringify(example) ? json({ items: [example] }) : json({}, status);
        }),
      );
      assert.equal(r.class, "input", JSON.stringify(r));
      assert.deepEqual(sent.at(-1), example);
      assert.equal(sent.length, status === 200 ? 3 : 2);
      assert.equal(heals().length, 0);
    }
  }
});

test("writes: refused without allowWrites; 5xx and network errors are ambiguous and never retried", async () => {
  assert.equal(
    (
      await call(
        "t",
        "post",
        { text: "hi" },
        opts(() => json({})),
      )
    ).class,
    "refused",
  );
  assert.equal(seen.length, 0);

  const r = await call("t", "post", { text: "hi" }, { ...opts(() => json({ error: "boom" }, 502)), allowWrites: true });
  assert.equal(r.ok, false);
  assert.equal(seen.length, 1);
  assert.match(r.next ?? "", /may have gone through/);

  seen = [];
  // the 502 may have gone through: the same write again needs the override
  const n = await call(
    "t",
    "post",
    { text: "hi" },
    { ...opts(() => Promise.reject(new TypeError("fetch failed"))), allowWrites: true, again: true },
  );
  assert.equal(n.class, "error");
  assert.equal(seen.length, 1);
  assert.match(n.next ?? "", /may have gone through/);
});

test("headers too large for Node's fetch: a read climbs toward the browser, a write is sent once and stays an error", async () => {
  const overflow = () =>
    Promise.reject(
      new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_OVERFLOW", message: "Headers Overflow Error" } }),
    );
  const r = await call("t", "user", { name: "alice" }, opts(overflow));
  assert.equal(r.class, "blocked", JSON.stringify(r));
  assert.match(r.reason ?? "", /headers are too large for plain HTTP.*needs tier 2, capped at 1/);
  assert.equal(seen.length, 1);

  seen = [];
  const w = await call("t", "post", { text: "hi" }, { ...opts(overflow), allowWrites: true });
  assert.equal(w.class, "error", JSON.stringify(w));
  assert.equal(seen.length, 1);
  assert.match(w.next ?? "", /may have gone through/);
});

test("an answer past the body cap is final: no retry, no tier climb, no heal, and not a server failure", async () => {
  const huge = () =>
    new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(16)) }), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(64 * 1024 * 1024) },
    });
  // a climb would end as blocked, "needs tier 2, capped at 1"
  const r = await call("t", "user", { name: "alice" }, opts(huge));
  assert.equal(r.class, "error", JSON.stringify(r));
  assert.match(r.reason ?? "", /over the 32 MiB cap/);
  assert.equal(r.retry, "no");
  assert.equal(r.nextCall?.action, "report");
  assert.equal(r.server, undefined);
  assert.equal(r.tier, 1);
  assert.match(r.next ?? "", /^do not retry/);
  assert.equal(seen.length, 1);
  assert.equal(heals().length, 0);

  seen = [];
  const w = await call("t", "post", { text: "hi" }, { ...opts(huge), allowWrites: true });
  assert.equal(w.class, "error", JSON.stringify(w));
  assert.equal(w.write, "may_have_applied");
  assert.equal(w.retry, "no");
  assert.equal(w.nextCall?.action, "check_site");
  assert.match(w.next ?? "", /may have run: check the site first/);
  assert.equal(seen.length, 1);
});

test("drift heals by rescan and retries once; drifting again within 10 min marks it stale instead", async () => {
  let current = QID;
  const h: Handler = (url) => {
    if (url === "https://t.test/u/bob")
      return new Response('<script src="/app.js"></script>', { headers: { "content-type": "text/html" } });
    if (url === "https://t.test/app.js") return new Response(`r=[{id:"${current}",name:"User"}]`);
    if (url.includes(`/api/${current}/User`)) return json({ user: { name: new URL(url).searchParams.get("name") } });
    return new Response("", { status: 404 });
  };
  current = NEW;
  const r = await call("t", "user", { name: "bob" }, opts(h));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.healed, true);
  assert.deepEqual(r.data, { name: "bob" });
  assert.deepEqual(
    heals().map((x) => x.strategy),
    ["rescan"],
  );

  current = "Qq1Ww2Ee3Rr4Tt5Yy6Uu7I";
  // the bundle now serves an id the template does not have, but the op was healed seconds ago
  const again = await call("t", "user", { name: "bob" }, opts(h));
  assert.equal(again.class, "drift");
  assert.match(again.reason ?? "", /stale/);
  assert.ok(staleMark("t", "user"));
  assert.equal(heals().length, 1, "not re-healed");
});

test("a byte-identical rescan is not a heal; rate is reported without heal or retry", async () => {
  const h: Handler = (url) => {
    if (url.endsWith("/u/bob")) return new Response(`<script>r={id:"${QID}",name:"User"}</script>`);
    if (url.includes("/api/")) return new Response("", { status: 404 });
    return new Response("", { status: 404 });
  };
  const r = await call("t", "user", { name: "bob" }, opts(h));
  assert.equal(r.ok, false);
  assert.equal(heals().length, 0);

  seen = [];
  const rate = await call(
    "t",
    "user",
    { name: "bob" },
    opts(() => json({ message: "Too many requests" }, 429)),
  );
  assert.equal(rate.class, "rate");
  assert.equal(seen.length, 1);
  assert.match(rate.next ?? "", /do not retry/);
});

test("no data for an arg while the example still returns data is input, not drift: no heal, a second try and one example request", async () => {
  saveSite(
    parseSite({
      name: "nf",
      baseUrl: "https://t.test",
      operations: [
        {
          name: "user",
          readOnly: true,
          request: { method: "GET", url: "https://t.test/api/User?name=alice", headers: {} },
          slots: [{ param: "name", at: ["query:name"] }],
          trigger: { url: "https://t.test/u/{name}" },
          params: [{ name: "name", example: "alice" }],
          response: { extract: "data.user" },
        },
      ],
    }),
  );
  const h: Handler = (url) => {
    const name = new URL(url).searchParams.get("name");
    return name === "alice" ? json({ data: { user: { name } } }) : json({ data: {} });
  };
  const r = await call("nf", "user", { name: "zzqq_no_such_user" }, opts(h));
  assert.equal(r.class, "input", JSON.stringify(r));
  assert.match(r.reason ?? "", /example args still return data/);
  assert.match(r.next ?? "", /do not heal/);
  assert.equal(seen.length, 3);
  assert.equal(heals().length, 0);

  // when the example fails too, it is drift and the heal runs
  seen = [];
  const d = await call(
    "nf",
    "user",
    { name: "bob" },
    opts(() => json({ data: {} })),
  );
  assert.equal(d.class, "drift");
  assert.ok(seen.length >= 2);
});

test("a write answered 204, HTML or plain text is ok, sent once", async () => {
  for (const res of [
    new Response(null, { status: 204 }),
    new Response("<html>Posted!</html>", { headers: { "content-type": "text/html" } }),
    new Response("OK"),
  ]) {
    seen = [];
    const r = await call("t", "post", { text: "hi" }, { ...opts(() => res), allowWrites: true, again: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(seen.length, 1);
  }
});

describe("a session learned signed in", () => {
  const members = parseSite({
    name: "m",
    baseUrl: "https://members.test",
    operations: [
      {
        name: "me",
        readOnly: true,
        request: { method: "GET", url: "https://members.test/api/me", headers: {} },
        trigger: { url: "https://members.test/" },
        response: { extract: "data" },
        learnedLoggedIn: true,
      },
      {
        name: "post",
        readOnly: false,
        request: { method: "POST", url: "https://members.test/api/post", headers: {}, body: "x" },
        trigger: { url: "https://members.test/compose" },
        learnedLoggedIn: true,
      },
    ],
  });
  const token = (value: string, extra: Partial<StoredCookie> = {}): StoredCookie => ({
    name: "auth_token",
    value,
    domain: ".members.test",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
    ...extra,
  });
  const browser = mkdtempSync(join(tmpdir(), "api-anything-exec-browser-"));
  /** what the everyday browser's Chrome "Default" profile holds for the site */
  const profile = (...rows: { name: string; value: string }[]) =>
    makeChromiumDb(
      join(browser, "Default"),
      rows.map((r) => ({ host_key: ".members.test", ...r })),
      { password: "pw" },
    );
  /** the server takes only this login */
  let live = "";
  const server: Handler = (url, init) =>
    new Headers(init?.headers).get("cookie")?.includes(`auth_token=${live}`)
      ? json(url.endsWith("/me") ? { data: { name: "alice" } } : { ok: true })
      : json({ error: "unauthenticated" }, 401);
  const write = (): Promise<CallResult> => call("m", "post", {}, { ...opts(server), allowWrites: true });
  before(() => {
    process.env.API_ANYTHING_BROWSER = "no-such-browser"; // a re-import pushes into no browser profile
    process.env.API_ANYTHING_BROWSER_ROOTS = JSON.stringify([
      { name: "Chrome", family: "chromium", root: browser, password: "pw" },
    ]);
  });
  beforeEach(() => saveSite(members));
  after(() => {
    delete process.env.API_ANYTHING_BROWSER;
    delete process.env.API_ANYTHING_BROWSER_ROOTS;
    rmSync(browser, { recursive: true, force: true });
  });

  test("a write is not sent while the session holds no live login cookie, and is once one is back", async () => {
    live = "token-live-0001";
    saveSession("m", { cookies: [token(live, { expires: 1 })], values: {} });
    const expired = await write();
    assert.equal(expired.class, "auth");
    assert.equal(seen.length, 0, "nothing sent");
    assert.match(
      expired.reason ?? "",
      /learned signed in.*no live login cookie \(expired or missing\): nothing was sent/,
    );
    assert.match(expired.next ?? "", /ask the user to run: api-anything login m; then retry once/);
    assert.deepEqual(
      [expired.write, expired.retry, expired.nextCall],
      ["not_sent", "after_fix", { action: "login", site: "m", op: "post" }],
    );

    // imported from a browser profile that is signed out too: still nothing sent, and where to sign in
    profile({ name: "theme", value: "dark" });
    saveSession("m", { cookies: [], values: {}, source: "chrome:Default" });
    const out = await write();
    assert.equal(out.class, "auth");
    assert.equal(seen.length, 0, "nothing sent");
    assert.match(out.reason ?? "", /nor does a re-import bring one back: nothing was sent/);
    assert.match(
      out.next ?? "",
      /ask the user to sign in to members\.test in Chrome profile "Default"; then retry once/,
    );
    assert.deepEqual(
      [out.write, out.retry, out.nextCall],
      ["not_sent", "after_fix", { action: "sign_in_browser", profile: "Chrome/Default", site: "m", op: "post" }],
    );

    // signed in again there: the re-import brings the login back before the one send, and the
    // refusals left no record for the duplicate guard to hold it back with
    profile({ name: "auth_token", value: live });
    const sent = await write();
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(seen.length, 1);
  });

  test("an auth answer is not retried on a re-import that brought back the same login cookie", async () => {
    live = "token-live-0002";
    profile({ name: "auth_token", value: "token-dead-0001" });
    saveSession("m", { cookies: [token("token-dead-0001")], values: {}, source: "chrome:Default" });
    const r = await call("m", "me", {}, opts(server));
    assert.equal(r.class, "auth");
    assert.equal(seen.length, 1, "the same request again would get the same answer");
    assert.match(r.next ?? "", /ask the user to sign in to members\.test in Chrome profile "Default"; then retry once/);
    assert.deepEqual(
      [r.retry, r.nextCall],
      ["after_fix", { action: "sign_in_browser", profile: "Chrome/Default", site: "m", op: "me" }],
    );

    // signed in again in that profile: a renewed cookie is worth the retry
    seen = [];
    profile({ name: "auth_token", value: live });
    const ok = await call("m", "me", {}, opts(server));
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(seen.length, 2);
  });
});

test("a write whose 200 body refuses it is not ok and is never sent again, a lost session included", async () => {
  for (const [body, cls, step] of [
    [{ data: { createPost: { post: null, userErrors: [{ message: "Title can't be blank" }] } } }, "error", "fix_args"],
    [{ status: "error" }, "error", "fix_args"],
    [{ error: "Message too long" }, "error", "fix_args"],
    [{ error: "You are not logged in" }, "auth", "login"],
  ] as const) {
    seen = [];
    const text = `refused ${JSON.stringify(body)}`;
    const r = await call("t", "post", { text }, { ...opts(() => json(body)), allowWrites: true });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.class, cls, JSON.stringify(r));
    assert.match(r.reason ?? "", /refused the write/);
    assert.equal(seen.length, 1, "a 200 is no proof it did not run: sent once");
    // it did not run: fix what it says first, then it may be sent
    assert.equal(r.write, "not_applied", JSON.stringify(r));
    assert.equal(r.server, undefined, "the site answered: no server failure");
    assert.equal(r.nextCall?.action, step, JSON.stringify(r));
    assert.equal(r.retry, "after_fix", JSON.stringify(r));
    if (cls === "error") assert.match(r.next ?? "", /refused the write, so it did not run/);
  }
});

test("a write whose 200 may have partly run, or whose redirect lands back on its form with an error, may have applied", async () => {
  const back = (url: string) =>
    new URL(url).pathname === "/api/post"
      ? new Response("", { status: 303, headers: { location: "https://t.test/compose?error=blank" } })
      : new Response("<html><form></form></html>", { headers: { "content-type": "text/html" } });
  for (const [what, h] of [
    ["errors beside data", () => json({ data: { createPost: { id: 1 } }, errors: [{ message: "x" }] })],
    ["a server failure in the body", () => json({ status: 503 })],
    ["back on the form", back],
  ] as const) {
    seen = [];
    const r = await call("t", "post", { text: what }, { ...opts(h), allowWrites: true });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.write, "may_have_applied", `${what}: ${JSON.stringify(r)}`);
    assert.equal(r.retry, "no", what);
    assert.equal(r.nextCall?.action, "check_site", what);
    assert.equal(seen.filter((s) => s.method === "POST").length, 1, what);
    // a 5xx standing in the body is the server's own failure, as at the status line
    assert.equal(r.server, what === "a server failure in the body" ? true : undefined, what);
  }
});

test("a signed-in read redirected to a consent page is not drift: no heal, nothing stale, a hint to finish the page", async () => {
  saveSite(
    parseSite({
      name: "consent",
      baseUrl: "https://t.test",
      operations: [
        {
          name: "me",
          readOnly: true,
          learnedLoggedIn: true,
          request: { method: "GET", url: "https://t.test/api/me?v=alice", headers: {} },
          slots: [{ param: "v", at: ["query:v"] }],
          trigger: { url: "https://t.test/home?v={v}" },
          params: [{ name: "v", example: "alice" }],
          response: { extract: "data" },
        },
      ],
    }),
  );
  const h: Handler = (url) =>
    new URL(url).pathname === "/api/me"
      ? new Response("", { status: 302, headers: { location: "https://t.test/privacy/consent?continue=%2Fapi%2Fme" } })
      : new Response("<html><h1>We value your privacy</h1><button>Accept all</button></html>", {
          headers: { "content-type": "text/html" },
        });
  const r = await call("consent", "me", { v: "bob" }, opts(h));
  assert.equal(r.class, "error", JSON.stringify(r));
  assert.match(r.reason ?? "", /t\.test\/privacy\/consent/);
  assert.match(r.next ?? "", /https:\/\/t\.test\/privacy\/consent.*api-anything login consent/);
  assert.equal(heals().length, 0);
  assert.equal(staleMark("consent", "me"), undefined);
  assert.equal(r.nextCall?.action, "login", JSON.stringify(r));
  assert.equal(r.retry, "after_fix");
  assert.equal(seen.filter((s) => s.url.includes("/api/")).length, 1, "no second try and no example args replay");
});

test("add --from a capture judges the op on the captured response: a wrong --extract is a warning, a right one a preview", async () => {
  const { addOperation } = await import("../src/heal.js");
  const capture = {
    id: "cfake1",
    at: "",
    url: "https://t.test/u/nasa",
    cookies: [],
    finalUrl: "https://t.test/u/nasa",
    exchanges: [
      {
        id: 7,
        resourceType: "fetch",
        request: { method: "GET", url: "https://t.test/api/User?screen_name=nasa", headers: {} },
        response: {
          status: 200,
          headers: {},
          contentType: "application/json",
          body: '{"data":{"user_result":{"name":"NASA","followers":9}}}',
        },
      },
    ],
  };
  const bad = await addOperation({
    site: "addfrom",
    op: "u",
    examples: [{ screen_name: "nasa" }],
    from: { capture, id: 7 },
    response: { extract: "data.user.result" },
  });
  assert.ok(
    bad.warnings.some((w) =>
      /on the captured response this op says drift: extract path "data.user.result" missing.*add --from cfake1/.test(w),
    ),
    bad.warnings.join("\n"),
  );
  assert.equal(bad.preview, undefined);
  assert.equal(bad.operation.trigger.url, "https://t.test/u/{screen_name}");
  const good = await addOperation({
    site: "addfrom",
    op: "u",
    examples: [{ screen_name: "nasa" }],
    from: { capture, id: 7 },
    response: { extract: "data.user_result", pick: ["name"] },
  });
  assert.deepEqual(good.preview, { first: { name: "NASA" } });
  assert.equal(good.replaced, true);
});

test("capped below the tier a wall needs: the reason says what tier 1 met", async () => {
  const wall = new Response("<html><title>Just a moment...</title></html>", {
    status: 403,
    headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
  });
  const r = await call(
    "t",
    "user",
    { name: "bob" },
    opts(() => wall),
  );
  assert.equal(r.class, "blocked");
  assert.match(r.reason ?? "", /tier 1 was blocked \(Cloudflare.*\); needs tier 2, capped at 1/);
});

const LIVE = "Sx9Qw2Lm7Rt4Vb8Nc3KdPz";

test("a response that echoes a live credential never puts it in reason, whole or cut at the snippet's end", async () => {
  saveSession("t", {
    cookies: [{ name: "sid", value: LIVE, domain: "t.test", path: "/", expires: -1, httpOnly: true, secure: true }],
    values: {},
  });
  try {
    const whole = await call(
      "t",
      "user",
      { name: "bob" },
      opts(() => json({ error: `invalid session ${LIVE} for ${encodeURIComponent(LIVE)}` }, 401)),
    );
    assert.equal(whole.class, "auth", JSON.stringify(whole));
    assert.ok(!(whole.reason ?? "").includes(LIVE.slice(0, 8)), whole.reason ?? "");
    assert.match(whole.reason ?? "", /\[redacted\]/);
    // the 160-character snippet ends inside the value: no prefix of it is left either
    for (const cut of [4, 10, LIVE.length - 1]) {
      const body = `${"x".repeat(160 - cut - 9)}session: ${LIVE}`;
      const r = await call(
        "t",
        "user",
        { name: "bob" },
        opts(() => new Response(body, { status: 401 })),
      );
      assert.ok(!(r.reason ?? "").includes(LIVE.slice(0, 4)), `${cut}: ${r.reason}`);
    }
    // the body spells the value in JSON escapes, and the snippet ends inside it
    const escaped = `${"x".repeat(160 - 15 - 9)}session: \\u${LIVE.charCodeAt(0).toString(16).padStart(4, "0")}${LIVE.slice(1)}`;
    const r = await call(
      "t",
      "user",
      { name: "bob" },
      opts(() => new Response(escaped, { status: 401 })),
    );
    assert.equal(r.class, "auth", JSON.stringify(r));
    assert.ok(!(r.reason ?? "").includes(LIVE.slice(1, 5)), r.reason ?? "");
    assert.match(r.reason ?? "", /session: \[redacted\]$/);
  } finally {
    rmSync(join(HOME, "sessions"), { recursive: true, force: true });
  }
});

test("a reason cut inside a value spelled in escapes, then another value's prefix, keeps neither", async () => {
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: "t.test",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
  });
  saveSession("t", { cookies: [cookie("a", "session"), cookie("b", "kettlesessionMore")], values: {} });
  try {
    const u = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
    const body = `{"e":"${[..."kettle"].map(u).join("")}sessio`;
    const r = await call(
      "t",
      "user",
      { name: "bob" },
      opts(() => new Response(body, { status: 401 })),
    );
    assert.equal(r.class, "auth", JSON.stringify(r));
    assert.equal(r.reason, `HTTP 401: {"e":"[redacted]`);
  } finally {
    rmSync(join(HOME, "sessions"), { recursive: true, force: true });
  }
});

test("the same write while the last one is unsettled is refused unless the caller says again", async () => {
  const w = { ...opts(() => json({ ok: true })), allowWrites: true };
  const first = await call("t", "post", { text: "same" }, w);
  assert.equal(first.ok, true);
  assert.equal(first.write, "accepted");
  const dup = await call("t", "post", { text: "same" }, w);
  assert.equal(seen.length, 1, "not sent a second time");
  assert.equal(dup.ok, false);
  assert.equal(dup.class, "duplicate");
  assert.equal(dup.write, "not_sent");
  assert.equal(dup.retry, "no");
  assert.equal(dup.nextCall?.action, "check_site");
  assert.match(dup.next ?? "", /again/);
  // other args are another write
  assert.equal((await call("t", "post", { text: "other" }, w)).ok, true);
  assert.equal(seen.length, 2);
  // an explicit override sends it
  const again = await call("t", "post", { text: "same" }, { ...w, again: true });
  assert.equal(again.ok, true);
  assert.equal(seen.length, 3);
  // the args themselves are never stored
  const ledger = readFileSync(join(HOME, "writes.json"), "utf8");
  assert.ok(!ledger.includes("same") && !ledger.includes("other"), ledger);
});

test("a write that did not run does not hold back the next one, and one a dead process left sending does", async () => {
  const w = (h: Handler) => ({ ...opts(h), allowWrites: true });
  const refused = await call(
    "t",
    "post",
    { text: "x" },
    w(() => json({ error: "forbidden" }, 403)),
  );
  assert.equal(refused.write, "not_applied", JSON.stringify(refused));
  assert.notEqual(refused.retry, "no");
  assert.equal(
    (
      await call(
        "t",
        "post",
        { text: "x" },
        w(() => json({ ok: true })),
      )
    ).write,
    "accepted",
  );
  assert.equal(seen.length, 2);

  // a record still "sending" is a write whose process died mid-send: it may have gone through
  const all = JSON.parse(readFileSync(join(HOME, "writes.json"), "utf8"));
  for (const r of all) r.status = "sending";
  writeFileSync(join(HOME, "writes.json"), JSON.stringify(all));
  const dup = await call(
    "t",
    "post",
    { text: "x" },
    w(() => json({ ok: true })),
  );
  assert.equal(dup.class, "duplicate");
  assert.match(dup.reason ?? "", /may have gone through/);
  assert.equal(seen.length, 2);

  // outside the window it goes
  for (const r of all) r.at -= 11 * 60_000;
  writeFileSync(join(HOME, "writes.json"), JSON.stringify(all));
  assert.equal(
    (
      await call(
        "t",
        "post",
        { text: "x" },
        w(() => json({ ok: true })),
      )
    ).ok,
    true,
  );
  assert.equal(seen.length, 3);
});

test("an idempotency key returns the first call's record instead of sending, and is refused for other args", async () => {
  const w = (h: Handler, idempotencyKey: string) => ({ ...opts(h), allowWrites: true, idempotencyKey });
  const first = await call(
    "t",
    "post",
    { text: "k" },
    w(() => json({ ok: true }), "order-1"),
  );
  assert.equal(first.write, "accepted");
  const repeat = await call(
    "t",
    "post",
    { text: "k" },
    w(() => json({ ok: true }), "order-1"),
  );
  assert.equal(seen.length, 1, "not sent");
  assert.equal(repeat.ok, true);
  assert.equal(repeat.write, "accepted");
  assert.match(repeat.reason ?? "", /that call's record/);
  // a new key is a new write, whatever the args: the caller said so
  assert.equal(
    (
      await call(
        "t",
        "post",
        { text: "k" },
        w(() => json({ ok: true }), "order-2"),
      )
    ).ok,
    true,
  );
  assert.equal(seen.length, 2);
  const other = await call(
    "t",
    "post",
    { text: "different" },
    w(() => json({ ok: true }), "order-1"),
  );
  assert.equal(other.class, "input");
  assert.equal(other.write, "not_sent");
  assert.equal(seen.length, 2);

  // a key whose write may have gone through answers with that, not with a send
  const ambiguous = await call(
    "t",
    "post",
    { text: "m" },
    w(() => json({}, 502), "order-3"),
  );
  assert.equal(ambiguous.write, "may_have_applied");
  const again = await call(
    "t",
    "post",
    { text: "m" },
    w(() => json({ ok: true }), "order-3"),
  );
  assert.equal(seen.length, 3);
  assert.equal(again.ok, false);
  assert.equal(again.write, "may_have_applied");
  assert.equal(again.retry, "no");
  assert.equal(again.nextCall?.action, "check_site");
  // a key whose write did not run is free to send again
  await call(
    "t",
    "post",
    { text: "n" },
    w(() => json({}, 403), "order-4"),
  );
  assert.equal(
    (
      await call(
        "t",
        "post",
        { text: "n" },
        w(() => json({ ok: true }), "order-4"),
      )
    ).write,
    "accepted",
  );
  assert.equal(seen.length, 5);
});

/*
 * The contract over every class, a read and a write, and what was sent: each result's fields agree,
 * and no write that went through or may have says it can be sent again.
 */
test("contract: class x read/write x sent says consistent write, retry and nextCall", () => {
  const read = site.operations[0]!;
  const write = site.operations[1]!;
  const classes: CallResult["class"][] = [
    "ok",
    "drift",
    "auth",
    "rate",
    "blocked",
    "input",
    "error",
    "refused",
    "duplicate",
  ];
  const sends: [string, Attempt[]][] = [
    ["nothing", []],
    ["profile busy", [{ tier: 2, class: "error", reason: "busy", hint: PROFILE_HINT, unsent: true }]],
    ["answered 403", [{ tier: 1, class: "blocked", reason: "403", status: 403 }]],
    ["answered 502", [{ tier: 1, class: "error", reason: "502", status: 502, server: true }]],
    ["no answer", [{ tier: 1, class: "error", reason: "timeout", ambiguous: true, server: true }]],
    ["tier-3 401", [{ tier: 3, class: "auth", reason: "401", status: 401 }]],
    ["refused in a 2xx", [{ tier: 1, class: "error", reason: "ok:false", status: 200, rejected: true }]],
    ["rate, retry after", [{ tier: 1, class: "rate", reason: "429", status: 429, retryAfterMs: 120_000 }]],
    ["accepted", [{ tier: 1, class: "ok", reason: "ok", status: 200 }]],
  ];
  const ACTIONS = new Set([
    "retry",
    "login",
    "sign_in_browser",
    "heal",
    "relearn",
    "fix_args",
    "list_sites",
    "check_site",
    "allow_writes",
    "raise_tier",
    "install_browser",
    "report",
  ]);
  let rows = 0;
  for (const op of [read, write])
    for (const c of classes)
      for (const [what, log] of sends) {
        const ok = c === "ok";
        // only a combination a call can produce: an ok result came from an ok attempt, and the other way round
        if (ok !== (what === "accepted")) continue;
        const last = log.at(-1);
        const r = finish({ ok, class: c, ...(last && !ok ? stepOf(last) : {}) }, op, "t", log);
        const row = `${op.readOnly ? "read" : "write"} ${c} after ${what}: ${JSON.stringify(r)}`;
        rows++;
        if (op.readOnly) assert.equal(r.write, undefined, row);
        else assert.ok(r.write, row);
        if (!op.readOnly && !log.length) assert.equal(r.write, "not_sent", row);
        if (!op.readOnly && what === "profile busy") assert.equal(r.write, "not_sent", row);
        if (!op.readOnly && (what === "answered 403" || what === "refused in a 2xx"))
          assert.equal(r.write, "not_applied", row);
        if (!op.readOnly && ["answered 502", "no answer", "tier-3 401"].includes(what))
          assert.equal(r.write, "may_have_applied", row);
        if (ok) {
          assert.equal(r.retry, undefined, row);
          assert.equal(r.nextCall, undefined, row);
          continue;
        }
        assert.ok(r.retry, row);
        assert.ok(r.nextCall && ACTIONS.has(r.nextCall.action), row);
        assert.equal(r.nextCall?.site, "t", row);
        // the rule this contract exists for
        if (r.write === "accepted" || r.write === "may_have_applied") {
          assert.equal(r.retry, "no", row);
          assert.equal(r.nextCall?.action, "check_site", row);
        }
        if (r.retry === "safe" || r.retry === "after_wait")
          assert.ok(op.readOnly || r.write === "not_sent" || r.write === "not_applied", row);
        if (!op.readOnly) assert.notEqual(r.nextCall?.action, "heal", row);
        if (r.retry === "after_wait" && what === "rate, retry after") assert.equal(r.retryAfterMs, 120_000, row);
        if (c === "duplicate") assert.equal(r.retry, "no", row);
      }
  assert.ok(rows > 100, String(rows));

  // an auth whose re-import brought back the same cookies: the user signs in again in that profile,
  // unless a write may have run, which comes first
  const signIn = { action: "sign_in_browser" as const, profile: "Chrome/Profile 1" };
  for (const op of [read, write])
    for (const [what, log] of sends.filter(([w]) => w !== "accepted")) {
      const r = finish({ ok: false, class: "auth", nextCall: signIn }, op, "t", log);
      const row = `${op.readOnly ? "read" : "write"} auth after ${what}: ${JSON.stringify(r)}`;
      if (r.write === "may_have_applied") assert.deepEqual([r.nextCall?.action, r.retry], ["check_site", "no"], row);
      else assert.deepEqual([r.nextCall, r.retry], [{ ...signIn, site: "t", op: op.name }, "after_fix"], row);
    }
  // a readback that found the write: the strongest status, kept as said, and nothing left to do
  const applied = finish({ ok: true, class: "ok", write: "applied" }, write, "t", sends.at(-1)![1]);
  assert.deepEqual([applied.write, applied.retry, applied.nextCall], ["applied", undefined, undefined]);
});

test("contract through call(): a read's rate limit and a write's three outcomes", async () => {
  const rate = await call(
    "t",
    "user",
    { name: "bob" },
    opts(() => new Response("slow down", { status: 429, headers: { "retry-after": "120" } })),
  );
  assert.deepEqual([rate.class, rate.retry, rate.retryAfterMs, rate.write], ["rate", "after_wait", 120_000, undefined]);
  assert.equal(rate.nextCall?.action, "retry");
  rmSync(join(HOME, "state.json"), { force: true }); // the site's cool-down, which would answer the writes below unsent

  const w = (h: Handler) => ({ ...opts(h), allowWrites: true, again: true });
  const cases: [Handler | undefined, Partial<CallResult>][] = [
    [() => json({ ok: true }), { ok: true, write: "accepted" }],
    [() => json({ error: "no" }, 403), { write: "not_applied" }],
    [() => json({ error: "boom" }, 502), { write: "may_have_applied", retry: "no" }],
    [() => Promise.reject(new TypeError("fetch failed")), { write: "may_have_applied", retry: "no" }],
    [undefined, { class: "refused", write: "not_sent", retry: "after_fix" }],
  ];
  for (const [h, want] of cases) {
    const r = await call("t", "post", { text: "c" }, h ? w(h) : opts(() => json({})));
    for (const [k, v] of Object.entries(want)) assert.equal(r[k as keyof CallResult], v, `${k}: ${JSON.stringify(r)}`);
  }
  const unknown = await call(
    "t",
    "post",
    { nope: 1 },
    w(() => json({})),
  );
  assert.deepEqual([unknown.class, unknown.write, unknown.nextCall?.action], ["input", "not_sent", "fix_args"]);
});

/** A read whose list pages by `after`, and a to-do write whose readback is a read of the same site. */
const pagedAndTodos = (paging: Record<string, unknown>, readback?: Record<string, unknown>) =>
  parseSite({
    name: "t",
    baseUrl: "https://t.test",
    operations: [
      {
        name: "reviews",
        readOnly: true,
        request: { method: "GET", url: "https://t.test/api/reviews?after=", headers: {} },
        slots: [{ param: "after", at: ["query:after"] }],
        params: [{ name: "after", required: false }],
        trigger: { url: "https://t.test/reviews" },
        response: { extract: "data.edges", pick: ["id"] },
        paging,
      },
      {
        name: "todos",
        readOnly: true,
        request: { method: "GET", url: "https://t.test/api/todos", headers: {} },
        trigger: { url: "https://t.test/todos" },
        response: { extract: "todos" },
      },
      {
        name: "add",
        readOnly: false,
        request: {
          method: "POST",
          url: "https://t.test/api/todos",
          headers: { "content-type": "application/json" },
          body: '{"title":"x"}',
        },
        slots: [{ param: "title", at: ["body", "json:/title"] }],
        trigger: { url: "https://t.test/todos" },
        params: [{ name: "title" }],
        ...(readback ? { readback } : {}),
      },
    ],
  });

test("paging: a call returns the next page's cursor, read from the whole answer before extract and pick", async () => {
  saveSite(pagedAndTodos({ param: "after", next: "data.pageInfo.next" }));
  const page = (next: unknown) => () =>
    json({ data: { edges: [{ id: 1, text: "a" }], pageInfo: next === undefined ? {} : { next } } });
  const r = await call("t", "reviews", {}, opts(page("c2")));
  assert.deepEqual([r.ok, r.data, r.nextPage, r.hasMore], [true, [{ id: 1 }], "c2", true]);
  // the cursor goes where the param goes
  const second = await call("t", "reviews", { after: "c2" }, opts(page(3)));
  assert.equal(new URL(seen.at(-1)!.url).searchParams.get("after"), "c2");
  assert.equal(second.nextPage, 3);
  // the site says there is no next page
  for (const end of [null, ""]) {
    const last = await call("t", "reviews", { after: "c9" }, opts(page(end)));
    assert.deepEqual([last.ok, last.nextPage, last.hasMore], [true, undefined, false], JSON.stringify(end));
  }
  // nothing at the path: unknown, so neither field is said
  const silent = await call("t", "reviews", {}, opts(page(undefined)));
  assert.deepEqual([silent.ok, "nextPage" in silent, "hasMore" in silent], [true, false, false]);

  // learned from the request that loads page 2, the template holds page 2's cursor: left out, the
  // cursor is cleared (empty, or null in JSON), never the captured one sent
  const learned = pagedAndTodos({ param: "after", next: "data.pageInfo.next" });
  learned.operations[0]!.request.url = "https://t.test/api/reviews?after=Y2Fw";
  saveSite(learned);
  await call("t", "reviews", {}, opts(page("c2")));
  assert.equal(new URL(seen.at(-1)!.url).searchParams.get("after"), "");
  const graphql = {
    ...learned.operations[0]!,
    request: {
      method: "POST",
      url: "https://t.test/graphql",
      headers: {},
      body: '{"pagination":{"after":"Y2Fw","limit":30}}',
    },
    slots: [{ param: "after", at: ["body", "json:/pagination/after"] }],
  };
  assert.equal(buildRequest(graphql, {}, NO_SESSION).body, '{"pagination":{"after":null,"limit":30}}');
  assert.equal(buildRequest(graphql, { after: "c2" }, NO_SESSION).body, '{"pagination":{"after":"c2","limit":30}}');

  // numbered pages: an answer says nothing about the next one, and page+1 is no evidence there is one
  saveSite(pagedAndTodos({ param: "after" }));
  const numbered = await call("t", "reviews", { after: "1" }, opts(page("c2")));
  assert.deepEqual([numbered.ok, "nextPage" in numbered, "hasMore" in numbered], [true, false, false]);
});

test("paging: a page cut to fit the output cap says the cut items are not on the next page either", async () => {
  saveSite(pagedAndTodos({ param: "after", next: "data.pageInfo.next" }));
  const edges = Array.from({ length: 40 }, (_, i) => ({ id: `${i}-${"x".repeat(1000)}` }));
  const r = await call(
    "t",
    "reviews",
    {},
    opts(() => json({ data: { edges, pageInfo: { next: "c2" } } })),
  );
  assert.equal(r.nextPage, "c2");
  assert.match(r.truncated ?? "", /nextPage starts after the last item of this page, cut or not/);
});

test("readback: a write the read finds is applied, sent once; the ledger settles it, so a repeat is refused", async () => {
  saveSite(pagedAndTodos({ param: "after" }, { op: "todos", find: { field: "title", equals: "{title}" } }));
  const list: { title: string }[] = [];
  const answer = (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      list.push(JSON.parse(String(init.body)));
      return json({ ok: true });
    }
    return json({ todos: list });
  };
  const w = { ...opts(answer), allowWrites: true };
  const r = await call("t", "add", { title: "milk" }, w);
  assert.deepEqual([r.ok, r.class, r.write], [true, "ok", "applied"], JSON.stringify(r));
  assert.match(r.reason ?? "", /read back with todos: found it/);
  assert.deepEqual(
    seen.map((s) => s.method),
    ["POST", "GET"],
  );
  const ledger = JSON.parse(readFileSync(join(HOME, "writes.json"), "utf8"));
  assert.equal(ledger.at(-1).status, "applied");
  const dup = await call("t", "add", { title: "milk" }, w);
  assert.deepEqual([dup.class, dup.write], ["duplicate", "not_sent"]);
  assert.match(dup.reason ?? "", /read back/);
  assert.equal(seen.length, 2, "not sent again");
  // an idempotency key answers with the applied record
  assert.equal((await call("t", "add", { title: "eggs" }, { ...w, idempotencyKey: "k1" })).write, "applied");
  const replay = await call("t", "add", { title: "eggs" }, { ...w, idempotencyKey: "k1" });
  assert.deepEqual([replay.ok, replay.write], [true, "applied"]);
  assert.equal(seen.filter((s) => s.method === "POST").length, 2);
});

test("readback: not found, or a read that fails, changes nothing; a write that may have run and is found is applied", async () => {
  saveSite(pagedAndTodos({ param: "after" }, { op: "todos", find: { field: "title", equals: "{title}" } }));
  const w = (h: Handler) => ({ ...opts(h), allowWrites: true, again: true });
  const notYet = await call(
    "t",
    "add",
    { title: "milk" },
    w((_u, i) => (i?.method === "POST" ? json({ ok: true }) : json({ todos: [{ title: "bread" }] }))),
  );
  assert.deepEqual([notYet.ok, notYet.write], [true, "accepted"]);
  assert.match(notYet.reason ?? "", /read back with todos: not found.*may not show it yet/);

  const readFails = await call(
    "t",
    "add",
    { title: "milk" },
    w((_u, i) => (i?.method === "POST" ? json({ ok: true }) : json({}, 500))),
  );
  assert.deepEqual([readFails.ok, readFails.write], [true, "accepted"]);
  assert.match(readFails.reason ?? "", /could not read it back with todos/);

  // the write's answer was lost, but the list shows it: it ran
  const lost = await call(
    "t",
    "add",
    { title: "milk" },
    w((_u, i) => (i?.method === "POST" ? json({ error: "boom" }, 502) : json({ todos: [{ title: "milk" }] }))),
  );
  assert.deepEqual(
    [lost.ok, lost.class, lost.write, lost.retry, lost.nextCall],
    [true, "ok", "applied", undefined, undefined],
  );
  assert.match(lost.reason ?? "", /502.*read back with todos: found it/);
  // a lost answer and nothing in the list: still may_have_applied, still never sent again
  const unknown = await call(
    "t",
    "add",
    { title: "milk" },
    w((_u, i) => (i?.method === "POST" ? json({ error: "boom" }, 502) : json({ todos: [] }))),
  );
  assert.deepEqual([unknown.ok, unknown.write, unknown.retry], [false, "may_have_applied", "no"]);

  // a write that did not run, or was not sent, is not read back
  seen = [];
  const refused = await call(
    "t",
    "add",
    { title: "milk" },
    w(() => json({ error: "no" }, 403)),
  );
  assert.equal(refused.write, "not_applied");
  assert.deepEqual(
    seen.map((s) => s.method),
    ["POST"],
  );
  // a 200 whose body refuses the write (rejected): it did not run, so there is nothing to read back
  seen = [];
  const rejected = await call(
    "t",
    "add",
    { title: "milk" },
    w((_u, i) =>
      i?.method === "POST" ? json({ ok: false, error: "title taken" }) : json({ todos: [{ title: "milk" }] }),
    ),
  );
  assert.deepEqual([rejected.ok, rejected.write], [false, "not_applied"], JSON.stringify(rejected));
  assert.deepEqual(
    seen.map((s) => s.method),
    ["POST"],
  );
  seen = [];
  await call(
    "t",
    "add",
    { title: "milk" },
    opts(() => json({})),
  );
  assert.equal(seen.length, 0);
});

test("readback: with no find, any data counts; read args take the write's values", async () => {
  saveSite(pagedAndTodos({ param: "after" }, { op: "reviews", args: { after: "{title}" } }));
  const w = (h: Handler) => ({ ...opts(h), allowWrites: true, again: true });
  const r = await call(
    "t",
    "add",
    { title: "c7" },
    w((_u, i) => (i?.method === "POST" ? json({ ok: true }) : json({ data: { edges: [{ id: 7 }] } }))),
  );
  assert.equal(r.write, "applied");
  assert.equal(new URL(seen.at(-1)!.url).searchParams.get("after"), "c7");
  const empty = await call(
    "t",
    "add",
    { title: "c8" },
    w((_u, i) => (i?.method === "POST" ? json({ ok: true }) : json({ data: { edges: [] } }))),
  );
  assert.equal(empty.write, "accepted");
});

test("a value of the jar before the send that redacting the rotated one would expose never reaches the reason", async () => {
  // Redacting each snapshot on its own checks the first before the second's replacement spells it.
  const rotated = "RotatedSid4Kq9Lm2";
  const old = `Old[redacted]Tail7Xw`;
  saveSession("t", {
    cookies: [{ name: "sid", value: old, domain: "t.test", path: "/", expires: -1, httpOnly: true, secure: true }],
    values: {},
  });
  const r = await call(
    "t",
    "user",
    { name: "bob" },
    opts(
      () =>
        new Response(`bad session Old${rotated}Tail7Xw`, {
          status: 401,
          headers: { "content-type": "text/plain", "set-cookie": `sid=${rotated}; Path=/` },
        }),
    ),
  );
  assert.equal(r.class, "auth", JSON.stringify(r));
  assert.ok(!r.reason!.includes(old) && !r.reason!.includes(rotated), r.reason!);
  assert.ok(r.reason!.includes(OMITTED), r.reason!);
});

/** The to-do write alone, carrying the read its readback runs, as a shared spec holds it. */
const carrying = () => {
  const s = pagedAndTodos({ param: "after" });
  const { readOnly: _r, ...read } = s.operations[1]!;
  return parseSite({
    ...s,
    operations: [{ ...s.operations[2]!, readback: { read, find: { field: "title", equals: "{title}" } } }],
  });
};

test("readback: a carried read proves the write as a named one does, and leaves no trace on the spec or its state", async () => {
  saveSite(carrying());
  const file = join(HOME, "sites", "t.json");
  const bytes = readFileSync(file, "utf8");
  const list: { title: string }[] = [];
  const w = (h: Handler) => ({ ...opts(h), allowWrites: true, again: true });
  const r = await call(
    "t",
    "add",
    { title: "milk" },
    w((_u, i) => {
      if (i?.method === "POST") list.push(JSON.parse(String(i.body)));
      return i?.method === "POST" ? json({ ok: true }) : json({ todos: list });
    }),
  );
  assert.deepEqual([r.ok, r.class, r.write], [true, "ok", "applied"], JSON.stringify(r));
  assert.match(r.reason ?? "", /read back with todos: found it/);
  assert.deepEqual(
    seen.map((x) => [x.method, new URL(x.url).pathname]),
    [
      ["POST", "/api/todos"],
      ["GET", "/api/todos"],
    ],
  );

  // the read drifted: no answer, so the write stays accepted, and nothing heals, marks or remembers it
  seen = [];
  const drift = await call(
    "t",
    "add",
    { title: "eggs" },
    w((_u, i) => (i?.method === "POST" ? json({ ok: true }) : json({ items: [] }))),
  );
  assert.deepEqual([drift.ok, drift.write], [true, "accepted"], JSON.stringify(drift));
  assert.match(drift.reason ?? "", /could not read it back with todos \(drift/);
  assert.deepEqual(
    seen.map((x) => x.method),
    ["POST", "GET"],
  );
  const missed = await call(
    "t",
    "add",
    { title: "jam" },
    w((_u, i) => (i?.method === "POST" ? json({ ok: true }) : json({ todos: [] }))),
  );
  assert.deepEqual([missed.ok, missed.write], [true, "accepted"]);
  assert.match(missed.reason ?? "", /read back with todos: not found/);
  assert.equal(readFileSync(file, "utf8"), bytes, "the spec is as it was");
  assert.deepEqual(heals(), []);
  assert.ok(!existsSync(join(HOME, "state.json")), "no tier remembered, nothing marked stale");
});

test("readback: a read the site limits cools it down, carried or named, after a forced write too", async () => {
  const limited: Handler = (_u, i) =>
    i?.method === "POST"
      ? json({ ok: true })
      : new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
  const named = pagedAndTodos({ param: "after" }, { op: "todos", find: { field: "title", equals: "{title}" } });
  for (const [shape, s] of [
    ["carried", carrying()],
    ["named", named],
  ] as const)
    for (const force of [false, true]) {
      saveSite(s);
      rmSync(join(HOME, "state.json"), { force: true });
      // forced through a cool-down: the write's success ends it, and the read's 429 starts one again
      if (force) coolDown("t", { class: "rate", reason: "HTTP 429" }, 600_000);
      seen = [];
      const r = await call(
        "t",
        "add",
        { title: "milk" },
        { ...opts(limited), allowWrites: true, again: true, ...(force ? { ignoreCoolDown: true } : {}) },
      );
      const what = `${shape}${force ? ", forced" : ""}`;
      assert.deepEqual([r.ok, r.write, seen.map((x) => x.method)], [true, "accepted", ["POST", "GET"]], what);
      assert.match(r.reason ?? "", /could not read it back with todos \(rate/, what);
      const c = cooling("t");
      assert.equal(c?.class, "rate", what);
      assert.ok(c!.until - Date.now() <= 30_000, `${what}: the read's Retry-After, not the old wait`);
    }
});

test("a cookie a redirect set, sent on the next hop and rotated again, is redacted from the reason", async () => {
  const middle = "MiddleSecretABC987";
  saveSite(
    parseSite({
      name: "hops",
      baseUrl: "https://hops.test",
      operations: [
        {
          name: "read",
          readOnly: true,
          request: { method: "GET", url: "https://hops.test/start", headers: {} },
          trigger: { url: "https://hops.test/" },
        },
      ],
    }),
  );
  const r = await call(
    "hops",
    "read",
    {},
    opts((url) =>
      url.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "/answer", "set-cookie": `sid=${middle}; Path=/` } })
        : new Response(`backend failed for session ${middle}`, {
            status: 500,
            headers: { "content-type": "text/plain", "set-cookie": "sid=FinalSecretXYZ654; Path=/" },
          }),
    ),
  );
  assert.equal(r.ok, false);
  assert.ok(!r.reason!.includes(middle), r.reason!);
  assert.match(r.reason!, /\[redacted\]/);
});
const shop = parseSite({
  name: "g",
  baseUrl: "https://g.test",
  operations: [
    {
      name: "order",
      readOnly: false,
      request: {
        method: "POST",
        url: "https://g.test/api/order",
        headers: { "content-type": "application/json", "idempotency-key": "" },
        body: '{"item":"x"}',
      },
      slots: [
        { param: "item", at: ["body", "json:/item"] },
        { gen: "uuid", at: ["header:idempotency-key"] },
      ],
      trigger: { url: "https://g.test/p/{item}" },
      params: [{ name: "item" }],
    },
  ],
});

test("a gen slot: each call sends its own UUID, and one idempotency key always sends the same one", async () => {
  saveSite(shop);
  const keys: string[] = [];
  let status = 200;
  const w = (idempotencyKey?: string) => ({
    ...opts((_u, init) => {
      keys.push((init!.headers as Record<string, string>)["idempotency-key"]!);
      return json(status < 400 ? { ok: true } : { error: "bad" }, status);
    }),
    allowWrites: true,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  assert.equal((await call("g", "order", { item: "fridge" }, w())).write, "accepted");
  assert.equal((await call("g", "order", { item: "toaster" }, w())).write, "accepted");
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], "a new order is not the last one replayed");
  for (const k of keys) assert.match(k, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // the caller's key: a send the site refused may go again, and carries the same value, so the site dedupes it too
  status = 400;
  assert.equal((await call("g", "order", { item: "stove" }, w("order-7"))).write, "not_applied");
  status = 200;
  assert.equal((await call("g", "order", { item: "stove" }, w("order-7"))).write, "accepted");
  assert.equal(keys.length, 4);
  assert.equal(keys[2], keys[3]);
  assert.ok(!keys.slice(0, 2).includes(keys[2]!));
  // another key is another write, with its own value
  await call("g", "order", { item: "stove" }, w("order-8"));
  assert.equal(keys.length, 5);
  assert.notEqual(keys[4], keys[3]);
  // the ledger holds no generated value
  const ledger = readFileSync(join(HOME, "writes.json"), "utf8");
  for (const k of keys) assert.ok(!ledger.includes(k));
});

test("a retry that adds an idempotency key after an unclear answer is the same write: held back, and told where to look", async () => {
  const w = (h: Handler, idempotencyKey?: string) => ({ ...opts(h), allowWrites: true, idempotencyKey });
  const lost = await call(
    "t",
    "post",
    { text: "fridge" },
    w(() => new Response("bad gateway", { status: 502 })),
  );
  assert.deepEqual([lost.write, lost.retry], ["may_have_applied", "no"]);
  assert.match(lost.next ?? "", /check the site.*Look on https:\/\/t\.test\/compose/);
  const retry = await call(
    "t",
    "post",
    { text: "fridge" },
    w(() => json({ ok: true }), "fresh-key"),
  );
  assert.deepEqual([retry.class, retry.write, retry.retry], ["duplicate", "not_sent", "no"]);
  assert.equal(seen.length, 1, "sent once");
  assert.match(retry.next ?? "", /Look on https:\/\/t\.test\/compose/);
  // other args with a key are another write
  assert.equal(
    (
      await call(
        "t",
        "post",
        { text: "stove" },
        w(() => json({ ok: true }), "fresh-key"),
      )
    ).ok,
    true,
  );
  assert.equal(seen.length, 2);

  // with a readback, the result names it too
  saveSite(pagedAndTodos({ param: "after" }, { op: "todos", find: { field: "title", equals: "{title}" } }));
  const unclear = await call(
    "t",
    "add",
    { title: "milk" },
    w((_u, i) => (i?.method === "POST" ? new Response("", { status: 502 }) : json({ todos: [] }))),
  );
  assert.equal(unclear.write, "may_have_applied");
  assert.match(unclear.next ?? "", /Look on https:\/\/t\.test\/todos, or with its readback: the read todos/);
});

/* ------------------------------------------------- pacing and cool-downs */

describe("a site that said stop, and the pace between sends (localhost)", () => {
  let server: Server;
  let base = "";
  let hits: number[] = [];
  let answer: (res: ServerResponse) => void = (res) => res.end();
  before(async () => {
    server = createServer((_req, res) => {
      hits.push(Date.now());
      answer(res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  const local = () =>
    parseSite({
      name: "local",
      baseUrl: base,
      operations: [
        {
          name: "get",
          readOnly: true,
          request: { method: "GET", url: `${base}/api/get?q=a`, headers: {} },
          slots: [{ param: "q", at: ["query:q"] }],
          trigger: { url: `${base}/s?q={q}` },
          params: [{ name: "q", example: "a" }],
          response: { extract: "items" },
        },
        {
          name: "post",
          readOnly: false,
          request: {
            method: "POST",
            url: `${base}/api/post`,
            headers: { "content-type": "application/json" },
            body: '{"text":"x"}',
          },
          slots: [{ param: "text", at: ["body", "json:/text"] }],
          trigger: { url: `${base}/compose` },
          params: [{ name: "text" }],
        },
      ],
    });
  const reply =
    (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (res: ServerResponse) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
  const fast = { maxTier: 1 as const, minIntervalMs: 0 };
  beforeEach(() => {
    saveSite(local());
    hits = [];
  });

  test("calls from separate processes are paced as one: about the interval apart, never all at once", async () => {
    answer = reply(200, { items: [1] });
    const interval = 1000;
    // every child waits for the same moment, so unpaced they would arrive together
    const start = Date.now() + 4000;
    const child = () =>
      new Promise<string>((resolve, reject) => {
        const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD], {
          env: {
            ...process.env,
            AA_EXECUTE: new URL("../src/execute.ts", import.meta.url).href,
            AA_START: String(start),
            AA_INTERVAL: String(interval),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (out += d));
        p.on("error", reject);
        p.on("close", () => resolve(out));
      });
    const outs = await Promise.all([child(), child(), child()]);
    assert.deepEqual(outs, ["true", "true", "true"], outs.join("\n"));
    const at = hits.sort((a, b) => a - b);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    assert.equal(gaps.length, 2);
    // slots are reserved at least 0.7 × the interval apart; arrival adds each process's own send latency
    for (const g of gaps) assert.ok(g >= interval * 0.7 - 50, `arrivals ${gaps.join(", ")} ms apart`);
  });

  test("a 429's Retry-After is kept: the next calls send nothing until it is over, a write too", async () => {
    answer = reply(429, { message: "Too Many Requests" }, { "retry-after": "300" });
    const first = await call("local", "get", { q: "x" }, fast);
    assert.deepEqual([first.class, first.retryAfterMs, hits.length], ["rate", 300_000, 1]);

    answer = reply(200, { items: [1] });
    const second = await call("local", "get", { q: "y" }, fast);
    assert.equal(hits.length, 1, "nothing sent while the site cools down");
    assert.deepEqual(
      [second.ok, second.class, second.retry, second.nextCall?.action],
      [false, "rate", "after_wait", "retry"],
    );
    assert.ok(second.retryAfterMs! <= 300_000 && second.retryAfterMs! > 290_000, String(second.retryAfterMs));
    assert.match(
      second.reason ?? "",
      /^not sent: local answered rate at .*HTTP 429 \(the server says retry after 300 s\)/,
    );
    await new Promise((r) => setTimeout(r, 20));
    const third = await call("local", "get", { q: "z" }, fast);
    assert.ok(third.retryAfterMs! < second.retryAfterMs!, "counts down");

    // a write is not sent either, and its ledger holds nothing that would refuse it later as a duplicate
    const w = await call("local", "post", { text: "hi" }, { ...fast, allowWrites: true });
    assert.deepEqual([w.class, w.write, hits.length], ["rate", "not_sent", 1]);

    // the user's override sends
    const forced = await call("local", "get", { q: "x" }, { ...fast, ignoreCoolDown: true });
    assert.deepEqual([forced.ok, hits.length], [true, 2]);
    const sent = await call("local", "post", { text: "hi" }, { ...fast, allowWrites: true, ignoreCoolDown: true });
    assert.deepEqual([sent.write, hits.length], ["accepted", 3]);
  });

  test("a forced call the site answers ends the cool-down; one it limits again starts it over", async () => {
    answer = reply(429, {}, { "retry-after": "300" });
    await call("local", "get", { q: "x" }, fast);
    // limited again: a new cool-down, from this answer's Retry-After
    answer = reply(429, {}, { "retry-after": "600" });
    const again = await call("local", "get", { q: "x" }, { ...fast, ignoreCoolDown: true });
    assert.deepEqual([again.class, again.retryAfterMs, hits.length], ["rate", 600_000, 2]);
    const held = await call("local", "get", { q: "y" }, fast);
    assert.ok(held.retryAfterMs! > 590_000, String(held.retryAfterMs));
    assert.equal(hits.length, 2);

    answer = reply(200, { items: [1] });
    const forced = await call("local", "get", { q: "x" }, { ...fast, ignoreCoolDown: true });
    assert.deepEqual([forced.ok, hits.length], [true, 3]);
    const plain = await call("local", "get", { q: "z" }, fast);
    assert.deepEqual([plain.ok, hits.length], [true, 4], plain.reason ?? "");
  });

  test("a bare 429 cools down for a few minutes; a long Retry-After is capped", async () => {
    answer = reply(429, {});
    await call("local", "get", { q: "x" }, fast);
    const bare = await call("local", "get", { q: "x" }, fast);
    assert.ok(bare.retryAfterMs! > 170_000 && bare.retryAfterMs! <= 180_000, String(bare.retryAfterMs));

    rmSync(join(HOME, "state.json"));
    answer = reply(429, {}, { "retry-after": String(24 * 3600) });
    await call("local", "get", { q: "x" }, fast);
    const capped = await call("local", "get", { q: "x" }, fast);
    assert.ok(capped.retryAfterMs! <= 30 * 60_000, String(capped.retryAfterMs));
    assert.equal(hits.length, 2);
  });

  test("a failure that names its wait is rate, and is kept the same way", async () => {
    answer = reply(503, { message: "down for maintenance" }, { "retry-after": "120" });
    const r = await call("local", "get", { q: "x" }, fast);
    assert.deepEqual([r.class, r.retry, r.retryAfterMs], ["rate", "after_wait", 120_000]);
    await call("local", "get", { q: "x" }, fast);
    assert.equal(hits.length, 1);
  });

  test("a login ends the cool-down", async () => {
    answer = reply(429, {}, { "retry-after": "300" });
    await call("local", "get", { q: "x" }, fast);
    const file = join(HOME, "cookies.json");
    writeFileSync(file, JSON.stringify([{ name: "sid", value: "s1", domain: "127.0.0.1", path: "/" }]));
    assert.ok(await importSession("local", `${base}/`, { file, pushProfile: false }));
    answer = reply(200, { items: [1] });
    const r = await call("local", "get", { q: "x" }, fast);
    assert.deepEqual([r.ok, hits.length], [true, 2]);
  });

  test("451: refused to this network or region; no tier climbed, no retry, and none sent again for a while", async () => {
    answer = reply(451, { message: "Unavailable For Legal Reasons" });
    // tier 3 allowed: a browser on the same network would get the same answer, so none is started
    const r = await call("local", "get", { q: "x" }, { minIntervalMs: 0 });
    assert.deepEqual([r.class, r.tier, r.retry, r.nextCall?.action, hits.length], ["blocked", 1, "no", "report", 1]);
    assert.match(r.next ?? "", /not available from this network or region/);
    const again = await call("local", "get", { q: "x" }, { minIntervalMs: 0 });
    assert.deepEqual([again.class, again.retry, hits.length], ["blocked", "no", 1]);
    assert.ok(again.retryAfterMs! > 9 * 60_000 && again.retryAfterMs! <= 10 * 60_000, String(again.retryAfterMs));
  });
});

const CHILD = `
const { call } = await import(process.env.AA_EXECUTE);
await new Promise((r) => setTimeout(r, Math.max(0, Number(process.env.AA_START) - Date.now())));
const r = await call("local", "get", { q: "c" }, { maxTier: 1, minIntervalMs: Number(process.env.AA_INTERVAL) });
process.stdout.write(String(r.ok));
`;

test("a lock another process keeps sends nothing: a write's ledger, even with again, and a read's send slot", async () => {
  lockWait.ms = 200;
  try {
    const ledger = await holdInChild(join(HOME, "writes.json"));
    try {
      const w = await call(
        "t",
        "post",
        { text: "busy" },
        { ...opts(() => json({ ok: true })), allowWrites: true, again: true },
      );
      assert.deepEqual([w.ok, w.class, w.write, w.retry, seen.length], [false, "error", "not_sent", "safe", 0]);
      assert.match(w.reason ?? "", /stayed locked/);
    } finally {
      await kill(ledger);
    }
    const pace = await holdInChild(join(HOME, "pace.json"));
    try {
      const r = await call("t", "user", { name: "bob" }, { ...opts(() => json({ user: {} })), minIntervalMs: 1000 });
      assert.deepEqual([r.ok, r.class, seen.length], [false, "error", 0]);
      assert.match(r.next ?? "", /^retry/);
    } finally {
      await kill(pace);
    }
  } finally {
    lockWait.ms = 30_000;
  }
});
