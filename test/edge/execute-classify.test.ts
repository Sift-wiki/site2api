/**
 * Edge cases for execution, HTTP and classification. Each test is a regression for a bug that was
 * fixed. Chrome-only tests skip without Chrome.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import { addCookiesToProfile, browserAvailable, closeBrowser, openBrowser } from "../../src/browser.js";
import { classify, judge, type Observed } from "../../src/classify.js";
import { call } from "../../src/execute.js";
import { capOutput } from "../../src/extract.js";
import { profileDir } from "../../src/heal.js";
import { importSession } from "../../src/login.js";
import { cookieHeaderFor, cookieValue, loadSession, saveSession } from "../../src/session.js";
import { type Operation, OperationSchema, parseSite } from "../../src/spec.js";
import { rememberedTier, rememberTier, saveSite } from "../../src/store.js";
import type { StoredCookie } from "../../src/types.js";
import { makeChromiumDb } from "../fixture/cookie-db.js";
import { type Fixture, startFixture } from "./execute-classify.fixture.js";

const HOME = mkdtempSync(join(tmpdir(), "api-anything-edge-exec-"));
process.env.API_ANYTHING_HOME = HOME;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(async () => {
  await closeBrowser();
  fx.close();
  rmSync(HOME, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(HOME, "state.json"), { force: true });
  rmSync(join(HOME, "sessions"), { recursive: true, force: true });
  fx.hits.length = 0;
  fx.otherHits.length = 0;
});

const cookie = (name: string, value: string, domain: string, extra: Partial<StoredCookie> = {}): StoredCookie => ({
  name,
  value,
  domain,
  path: "/",
  expires: -1,
  httpOnly: false,
  secure: false,
  ...extra,
});

/** A read op on the fixture: GET <path>, extract "items". */
const rd = (name: string, path: string, over: Record<string, unknown> = {}) => ({
  name,
  readOnly: true,
  request: { method: "GET", url: `${fx.base}${path}`, headers: {} },
  trigger: { url: `${fx.base}/` },
  response: { format: "json", extract: "items" },
  ...over,
});

function site(name: string, ...operations: Record<string, unknown>[]) {
  saveSite(parseSite({ name, baseUrl: fx.base, operations }));
}
const t1 = { maxTier: 1 as const, minIntervalMs: 0, timeoutMs: 3000 };

/** A write whose body holds a session value two layers down: base64 of JSON, inside a JSON string. */
const wrapped = (path: string, over: Record<string, unknown> = {}) => ({
  name: "post",
  readOnly: false,
  request: {
    method: "POST",
    url: `${fx.base}${path}`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: Buffer.from('{"token":"PLACEHOLDER-TOKEN"}').toString("base64") }),
  },
  slots: [{ ref: "session:token", at: ["body", "json:/state", "b64", "json:/token"] }],
  trigger: { url: `${fx.base}/` },
  response: { format: "json" },
  ...over,
});
/** What a `wrapped` body carried, as the server decodes it. */
const unwrapped = (body: string) => Buffer.from(JSON.parse(body).state, "base64").toString();

/* ----------------------------------------------------------------- cookies and redirects */

describe("tier 1 cookies and redirects", () => {
  test("a cookie set on a redirect hop is sent on the next hop (consent/session bootstrap)", async () => {
    site("boot", rd("list", "/bootstrap"));
    const r = await call("boot", "list", {}, t1);
    const second = fx.hits.find((h) => h.url === "/needs-step");
    assert.equal(second?.headers.cookie, "step=1", "the Set-Cookie of the 302 must ride on the follow-up request");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a Set-Cookie from a tier-1 answer is persisted, so the next call presents the rotated value", async () => {
    site("rot", rd("list", "/rotate"));
    fx.state.rotate = 0;
    const a = await call("rot", "list", {}, t1);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.ok(
      loadSession("rot").cookies.some((c) => c.name === "tok" && c.value === "1"),
      "tok=1 from the answer is in the jar",
    );
    const b = await call("rot", "list", {}, t1);
    assert.equal(b.ok, true, JSON.stringify(b));
  });

  test("cross-origin redirects drop authorization, ref'd headers and cookies; 303 turns POST into GET", async () => {
    site(
      "xo",
      {
        ...rd("me", "/away?s=302"),
        request: {
          method: "GET",
          url: `${fx.base}/away?s=302`,
          headers: { authorization: "", "x-csrf-token": "", "x-keep": "1" },
        },
        slots: [
          { ref: "session:authorization", at: ["header:authorization"] },
          { ref: "cookie:ct0", at: ["header:x-csrf-token"] },
        ],
        response: { format: "json" },
      },
      {
        name: "post307",
        readOnly: false,
        request: {
          method: "POST",
          url: `${fx.base}/away?s=307`,
          headers: { authorization: "Bearer PUBLIC-LITERAL", "content-type": "application/json" },
          body: "{}",
        },
        trigger: { url: `${fx.base}/` },
        response: { format: "json" },
      },
    );
    saveSession("xo", {
      cookies: [cookie("ct0", "SECRET-CSRF-VALUE-123", "127.0.0.1")],
      values: { authorization: "Bearer SECRET-BEARER" },
    });
    const r = await call("xo", "me", {}, t1);
    assert.equal(r.ok, true, JSON.stringify(r));
    const h = fx.otherHits[0]!.headers;
    assert.equal(h.authorization, undefined);
    assert.equal(h["x-csrf-token"], undefined);
    assert.equal(h.cookie, undefined);
    assert.equal(h["x-keep"], "1");

    fx.otherHits.length = 0;
    const w = await call("xo", "post307", {}, { ...t1, allowWrites: true });
    assert.equal(w.ok, false, JSON.stringify(w));
    assert.match(w.reason ?? "", /it would send this write again/);
    assert.equal(fx.otherHits.length, 0, "a 307 would send the write a second time");

    // the same request as a read (a query sent as a POST) is taken on, without its authorization
    site("xoread", {
      ...rd("query", "/away?s=307"),
      request: {
        ...wrapped("").request,
        url: `${fx.base}/away?s=307`,
        headers: { authorization: "Bearer PUBLIC-LITERAL", "content-type": "application/json" },
        body: "{}",
      },
      response: { format: "json" },
    });
    const q = await call("xoread", "query", {}, t1);
    assert.equal(q.ok, true, JSON.stringify(q));
    assert.deepEqual(
      fx.otherHits.map((h) => [h.method, h.body, h.headers.authorization]),
      [["POST", "{}", undefined]],
      "307 keeps the method and body; even a literal authorization is dropped cross-origin",
    );
  });

  test("a write sent on by 303 to a page that answers 401 ran: it is not sent again", async () => {
    site("prg401", {
      ...rd("save", "/hop?s=303&to=/api/token"),
      readOnly: false,
      request: { method: "POST", url: `${fx.base}/hop?s=303&to=/api/token`, headers: {}, body: "x=1" },
    });
    fx.hits.length = 0;
    const r = await call("prg401", "save", {}, { ...t1, allowWrites: true });
    assert.deepEqual(
      fx.hits.map((h) => `${h.method} ${h.url}`),
      ["POST /hop?s=303&to=/api/token", "GET /api/token"],
      JSON.stringify(r),
    );
    assert.equal(r.ok, false);
    assert.match(r.next ?? "", /check the site/);
    assert.doesNotMatch(r.next ?? "", /retry once/);
  });

  test("a cross-origin 307 is not followed when a body slot holds a session value, whatever encodes it (base64)", async () => {
    // a read with a body (a query sent as a POST): a write stops at any 307
    site("xob64", wrapped("/away?s=307", { readOnly: true }));
    saveSession("xob64", { cookies: [], values: { token: "SECRET-BODY-TOKEN-123" } });
    const r = await call("xob64", "post", {}, t1);
    assert.match(unwrapped(fx.hits[0]!.body), /SECRET-BODY-TOKEN-123/, "the site itself gets its token");
    assert.equal(fx.otherHits.length, 0, `the other origin got ${fx.otherHits[0]?.body}`);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.reason ?? "", /not following the HTTP 307 redirect to http:\/\/localhost/);
    assert.match(r.next ?? "", /^do not retry: .* re-learn it with api-anything add xob64 post/);
    assert.doesNotMatch(r.next ?? "", /retry once/);
    assert.equal(fx.hits.length, 1, "sent once");
  });

  test("a cross-origin redirect drops a header whose ref sits under a JSON layer", async () => {
    site("xowrap", {
      ...rd("me", "/away?s=302"),
      request: {
        method: "GET",
        url: `${fx.base}/away?s=302`,
        headers: { "x-wrap": '{"token":""}', "x-keep": "1" },
      },
      slots: [{ ref: "cookie:ct0", at: ["header:x-wrap", "json:/token"] }],
      response: { format: "json" },
    });
    saveSession("xowrap", { cookies: [cookie("ct0", "SECRET-CSRF-VALUE-123", "127.0.0.1")], values: {} });
    const r = await call("xowrap", "me", {}, t1);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(String(fx.hits[0]!.headers["x-wrap"]), /SECRET-CSRF-VALUE-123/, "the site itself gets it");
    assert.equal(fx.otherHits[0]!.headers["x-wrap"], undefined);
    assert.equal(fx.otherHits[0]!.headers["x-keep"], "1");
  });

  test("a redirect loop ends with a non-ok answer instead of hanging", async () => {
    site("loop", rd("l", "/loop"));
    const r = await call("loop", "l", {}, t1);
    assert.equal(r.ok, false);
    assert.equal(r.class, "error");
    assert.ok(fx.hits.length <= 6);
  });

  test("a redirect to a login page where JSON was expected is auth", async () => {
    site("tl", rd("l", "/to-login"));
    const r = await call("tl", "l", {}, t1);
    assert.equal(r.class, "auth", JSON.stringify(r));
  });

  test("jar scoping: longest path first for duplicate names, expired never sent, Secure only over https/localhost", () => {
    const now = 1_800_000_000_000;
    const jar = [
      cookie("sid", "root", ".shop.test"),
      cookie("sid", "api", ".shop.test", { path: "/api" }),
      cookie("old", "x", ".shop.test", { expires: now / 1000 - 1 }),
      cookie("sec", "s", ".shop.test", { secure: true }),
    ];
    assert.equal(cookieHeaderFor(jar, "http://shop.test/api/v1", now), "sid=api; sid=root");
    assert.equal(cookieHeaderFor(jar, "https://shop.test/apix", now), "sid=root; sec=s");
    assert.equal(cookieValue(jar, "sid", "https://shop.test/api/v1", now), "api");
    assert.equal(cookieValue(jar, "sid", "https://evil-shop.test/api", now), undefined, "no suffix match across sites");
  });

  test("a cookie: ref never takes another site's cookie under a multi-label public suffix (co.uk, github.io)", () => {
    // browser.ts siteCookies keeps every cookie whose domain ends in siteOf(host); for bbc.co.uk that is ".co.uk",
    // so the shared profile's argos.co.uk cookies land in bbc's jar
    const jar = [
      cookie("csrftoken", "ARGOS-SECRET", ".argos.co.uk", { secure: true }),
      cookie("csrftoken", "ALICE-SECRET", "alice.github.io", { secure: true }),
    ];
    assert.equal(cookieValue(jar, "csrftoken", "https://api.bbc.co.uk/x"), undefined);
    assert.equal(cookieValue(jar, "csrftoken", "https://mallory.github.io/api"), undefined);
  });
});

/* ----------------------------------------------------------------- bodies */

describe("response bodies", () => {
  test("gzip, br and deflate bodies are decoded", async () => {
    site("enc", ...["gzip", "br", "deflate"].map((e) => rd(e, `/enc?e=${e}`)));
    for (const e of ["gzip", "br", "deflate"]) {
      const r = await call("enc", e, {}, t1);
      assert.deepEqual(r.data, [{ name: "café ☕" }], `${e}: ${JSON.stringify(r)}`);
    }
  });

  test("zstd bodies are decoded", {
    skip: !zlib.zstdCompressSync && "Node 22.15 or newer is required for zstd",
  }, async () => {
    site("enc", rd("zstd", "/enc?e=zstd"));
    const r = await call("enc", "zstd", {}, t1);
    assert.deepEqual(r.data, [{ name: "café ☕" }], JSON.stringify(r));
  });

  test("a UTF-8 BOM before JSON parses", async () => {
    site("bom", rd("b", "/bom"));
    const r = await call("bom", "b", {}, t1);
    assert.deepEqual(r.data, [1], JSON.stringify(r));
  });

  test("the declared charset is honoured (ISO-8859-1 JSON, Shift_JIS HTML)", async () => {
    site(
      "cs",
      rd("latin", "/latin1"),
      rd("sjis", "/sjis", { response: { format: "html", html: { items: "li.i", fields: { t: "" } } } }),
    );
    const l = await call("cs", "latin", {}, t1);
    const s = await call("cs", "sjis", {}, t1);
    assert.deepEqual({ latin: l.data, sjis: s.data }, { latin: [{ name: "café" }], sjis: [{ t: "日本" }] });
  });

  test("an MB-scale JSON array comes back capped at an item boundary with a truncation note", async () => {
    site("big", rd("b", "/huge"));
    const r = await call("big", "b", {}, t1);
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.data) && r.data.length > 10 && r.data.length < 50_000);
    assert.ok(JSON.stringify(r).length < 22_000, `output ${JSON.stringify(r).length} chars`);
    assert.match(r.truncated ?? "", /showing \d+ of 50000 items/);
  });

  test("an array whose first item alone exceeds the cap still returns some data", async () => {
    site("fat", rd("f", "/fat-item"));
    const r = await call("fat", "f", {}, t1);
    assert.equal(r.ok, true);
    assert.ok(r.truncated);
    assert.ok(
      Array.isArray(r.data) && r.data.length >= 1,
      `data: ${JSON.stringify(r.data).slice(0, 80)} / ${r.truncated}`,
    );
  });

  test("capping a long string keeps a prefix of the string itself, not of its JSON encoding", () => {
    const html = '<div class="a">\n'.repeat(3000);
    const { data } = capOutput(html);
    assert.equal(typeof data, "string");
    assert.ok(html.startsWith(data as string), `starts with ${JSON.stringify((data as string).slice(0, 30))}`);
  });

  test("capping an object with a big nested array returns a JSON value, not cut JSON text", () => {
    const value = {
      user: { id: 1 },
      timeline: Array.from({ length: 2000 }, (_, i) => ({ id: i, text: "tweet text here" })),
    };
    const { data } = capOutput(value);
    assert.equal(typeof data, "object", `got a ${typeof data}: ${JSON.stringify(data).slice(0, 60)}`);
  });

  test("a read answered 204 with no body is not ok, and is sent once more at most", async () => {
    site("e204", rd("e", "/empty"));
    const r = await call("e204", "e", {}, t1);
    assert.notEqual(r.class, "ok");
    assert.equal(fx.hits.length, 2, "the request, and a second try for missing data");
  });

  test("an empty 204 read while the example args still answer is input (the missing-data check), not a heal", async () => {
    site("m204", {
      ...rd("s", "/maybe?q=alice"),
      slots: [{ param: "q", at: ["query:q"] }],
      params: [{ name: "q", example: "alice" }],
    });
    const r = await call("m204", "s", { q: "zz_no_results" }, t1);
    assert.equal(r.class, "input", JSON.stringify(r));
  });
});

/* ----------------------------------------------------------------- transport failures */

describe("timeouts and network errors", () => {
  test("a body that stalls after the headers times out with a clear reason", async () => {
    site("stall", rd("s", "/stall"));
    const t0 = Date.now();
    const r = await call("stall", "s", {}, { ...t1, timeoutMs: 300 });
    assert.equal(r.class, "error");
    assert.match(r.reason ?? "", /no response within 300 ms/);
    assert.ok(Date.now() - t0 < 2500);
  });

  test("a server that never answers times out; a reset is an error; a write reset is sent once and flagged ambiguous", async () => {
    site("net", rd("n", "/never"), rd("r", "/reset"), {
      name: "w",
      readOnly: false,
      request: { method: "POST", url: `${fx.base}/reset`, headers: {}, body: "x=1" },
      trigger: { url: `${fx.base}/` },
    });
    assert.match((await call("net", "n", {}, { ...t1, timeoutMs: 200 })).reason ?? "", /no response within 200 ms/);
    assert.equal((await call("net", "r", {}, t1)).class, "error");
    fx.hits.length = 0;
    const w = await call("net", "w", {}, { ...t1, allowWrites: true });
    assert.equal(w.class, "error");
    assert.equal(fx.hits.length, 1);
    assert.match(w.next ?? "", /may have gone through/);
  });

  test("a network error names its cause (refused, DNS), not just 'fetch failed'", async () => {
    const port = await new Promise<number>((r) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => r(p));
      });
    });
    saveSite(
      parseSite({
        name: "down",
        baseUrl: `http://127.0.0.1:${port}`,
        operations: [{ ...rd("d", "/"), request: { method: "GET", url: `http://127.0.0.1:${port}/x`, headers: {} } }],
      }),
    );
    const r = await call("down", "d", {}, t1);
    assert.equal(r.class, "error");
    assert.match(r.reason ?? "", /ECONNREFUSED|refused/i, `reason: ${r.reason}`);

    const dns = (async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.nowhere.test"), { code: "ENOTFOUND" }),
      });
    }) as typeof fetch;
    const d = await call("down", "d", {}, { ...t1, fetchImpl: dns });
    assert.match(d.reason ?? "", /ENOTFOUND/, `reason: ${d.reason}`);
  });

  test("429 reports the server's Retry-After (seconds and HTTP date)", async () => {
    site("rl", rd("s", "/r429?ra=120"), rd("d", `/r429?ra=${encodeURIComponent("Wed, 21 Oct 2026 07:28:00 GMT")}`));
    const s = await call("rl", "s", {}, t1);
    assert.equal(s.class, "rate");
    assert.match(`${s.reason} ${s.next}`, /120/, JSON.stringify(s));
    // sent, though the first 429 cooled the site down
    const d = await call("rl", "d", {}, { ...t1, ignoreCoolDown: true });
    assert.match(`${d.reason} ${d.next}`, /2026-10-21|Oct 2026/, JSON.stringify(d));
  });
});

/* ----------------------------------------------------------------- classification */

const gqlOp = (over: Record<string, unknown> = {}): Operation =>
  OperationSchema.parse({
    name: "user",
    request: { method: "GET", url: "https://g.test/graphql?q=1", headers: {} },
    slots: [{ param: "login", at: ["query:q"] }],
    params: [{ name: "login" }],
    trigger: { url: "https://g.test/{login}" },
    response: { format: "json", extract: "data.user" },
    readOnly: true,
    ...over,
  });
const obs = (
  status: number,
  body: string,
  ct = "application/json",
  headers: Record<string, string> = {},
): Observed => ({
  status,
  headers: { "content-type": ct, ...headers },
  body,
});

describe("classification", () => {
  test("challenge pages from every listed vendor are blocked, whatever the status", () => {
    const o = gqlOp();
    const cases: [string, Observed][] = [
      [
        "Cloudflare 403",
        obs(
          403,
          "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>",
          "text/html",
        ),
      ],
      ["Cloudflare cf-mitigated", obs(403, "", "text/html", { "cf-mitigated": "challenge" })],
      ["Cloudflare 503", obs(503, "<title>Just a moment...</title>", "text/html")],
      ["Cloudflare WAF", obs(403, "<title>Attention Required! | Cloudflare</title>", "text/html")],
      [
        "Akamai",
        obs(
          403,
          '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18.1 <a href="https://errors.edgesuite.net/18.1">',
          "text/html",
        ),
      ],
      ["DataDome JSON", obs(403, '{"url":"https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqAAA"}')],
      ["PerimeterX JSON", obs(403, '{"appId":"PXu6b0qd2S","blockScript":"/u6b0qd2S/captcha/captcha.js","vid":"x"}')],
      ["PerimeterX 200 page", obs(200, "<html><body><div id=px-captcha></div>Press & Hold</body></html>", "text/html")],
      [
        "reCAPTCHA 200 interstitial",
        obs(200, '<html><div class="g-recaptcha" data-sitekey="x"></div></html>', "text/html"),
      ],
    ];
    for (const [name, r] of cases) assert.equal(classify(o, r).class, "blocked", name);
    assert.equal(
      classify(o, obs(429, "<title>Access denied | Error 1015</title> You are being rate limited", "text/html")).class,
      "rate",
    );
  });

  test("Imperva/Incapsula and Kasada interstitials are blocked (tier escalation), not drift or rate", () => {
    const o = gqlOp();
    const incapsula = obs(
      200,
      '<html><head><META NAME="robots" CONTENT="noindex,nofollow"><script src="/_Incapsula_Resource?SWJIYLWA=5074a744"></script></head><body><iframe src="/_Incapsula_Resource?CWUDNSAI=9">Request unsuccessful. Incapsula incident ID: 1</iframe></body></html>',
      "text/html",
    );
    assert.equal(classify(o, incapsula).class, "blocked", "Imperva");
    const kasada = obs(
      429,
      '<html><script src="/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/ips.js"></script></html>',
      "text/html",
      { "x-kpsdk-ct": "abc" },
    );
    assert.equal(classify(o, kasada).class, "blocked", "Kasada");
  });

  test("400 with a CSRF marker is auth (DESIGN: 400/403 with login or CSRF markers)", () => {
    const w = gqlOp({ readOnly: false, response: { format: "json" } });
    assert.equal(classify(w, obs(403, '{"error":"CSRF token mismatch"}')).class, "auth");
    assert.equal(classify(w, obs(400, '{"error":"CSRF token mismatch"}')).class, "auth");
  });

  test("5xx is error (retry hint), 4xx without markers is not auth", () => {
    assert.equal(classify(gqlOp(), obs(503, "Service Unavailable", "text/plain")).class, "error");
    // one that names its wait is a limit
    assert.equal(
      classify(gqlOp(), obs(503, "Service Unavailable", "text/plain", { "retry-after": "30" })).class,
      "rate",
    );
    assert.equal(classify(gqlOp(), obs(500, '{"error":"internal"}')).class, "error");
    assert.equal(classify(gqlOp(), obs(403, '{"message":"CSRF token missing or incorrect."}')).class, "auth");
    assert.equal(classify(gqlOp(), obs(401, "")).class, "auth");
  });

  test("JSON served as text/html is still JSON; an HTML login page where JSON was expected is auth", () => {
    assert.equal(classify(gqlOp(), obs(200, '{"data":{"user":{"id":1}}}', "text/html; charset=utf-8")).class, "ok");
    assert.equal(
      classify(gqlOp(), obs(200, '<!doctype html><form><input name=u><input type="password"></form>', "text/html"))
        .class,
      "auth",
    );
  });

  test("GraphQL errors with null data map to rate/auth/drift/error", () => {
    const o = gqlOp();
    assert.equal(classify(o, obs(200, '{"errors":[{"message":"Rate limit exceeded"}],"data":null}')).class, "rate");
    assert.equal(classify(o, obs(200, '{"errors":[{"message":"Bad guest token"}]}')).class, "auth");
    assert.equal(classify(o, obs(200, '{"errors":[{"message":"PersistedQueryNotFound"}]}')).class, "drift");
  });

  test("GraphQL partial data: errors next to a null extract target are not a successful null", () => {
    const o = gqlOp();
    const rate = judge(
      o,
      obs(200, '{"data":{"user":null},"errors":[{"message":"Rate limit exceeded","path":["user"]}]}'),
    );
    assert.equal(rate.class, "rate", JSON.stringify(rate));
    const nf = judge(
      o,
      obs(
        200,
        `{"data":{"user":null},"errors":[{"type":"NOT_FOUND","path":["user"],"message":"Could not resolve to a User with the login of 'zz'."}]}`,
      ),
    );
    assert.notEqual(nf.class, "ok", JSON.stringify(nf));
    // errors on an unrelated field with the target present: still ok
    assert.equal(
      judge(o, obs(200, '{"data":{"user":{"id":1},"ads":null},"errors":[{"message":"x","path":["ads"]}]}')).class,
      "ok",
    );
  });

  test("a write answered 2xx is ok even when the landing page has a password field (it ran)", () => {
    const w = gqlOp({ readOnly: false, response: { format: "json" } });
    assert.equal(classify(w, obs(204, "", "")).class, "ok");
    const saved = judge(
      w,
      obs(200, '<!doctype html><h1>Settings saved</h1><form><input type="password" name="new"></form>', "text/html"),
    );
    assert.equal(saved.class, "ok", JSON.stringify(saved));
  });
});

/* ----------------------------------------------------------------- the ladder */

describe("execution ladder", () => {
  test("404 for an unknown entity on a query-param API is input after the example check, not a heal", async () => {
    site("nf404", {
      ...rd("user", "/api/user?name=alice"),
      slots: [{ param: "name", at: ["query:name"] }],
      params: [{ name: "name", example: "alice" }],
      response: { format: "json", extract: "user" },
    });
    const ok = await call("nf404", "user", { name: "alice" }, t1);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const r = await call("nf404", "user", { name: "zz_nobody" }, t1);
    assert.equal(r.class, "input", JSON.stringify(r));
  });

  test("a remembered escalation does not stop --max-tier 1 from trying tier 1", async () => {
    site("mem", rd("l", "/plain"));
    rememberTier("mem", "l", 2);
    const r = await call("mem", "l", {}, t1);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 1);
  });

  test("an unknown arg name (a typo) is refused instead of silently using the default", async () => {
    site("typo", {
      ...rd("items", "/api/items?page=1"),
      slots: [{ param: "page", at: ["query:page"] }],
      params: [{ name: "page", default: "1", required: false }],
    });
    const r = await call("typo", "items", { pgae: "7" }, t1);
    assert.equal(r.class, "input", JSON.stringify(r));
    assert.equal(fx.hits.length, 0, "nothing sent");
  });

  test("a numeric arg in a form that would be rounded past 2^53 is input, and nothing is sent", async () => {
    site("big", {
      ...rd("items", "/api/items?page=1"),
      slots: [{ param: "page", at: ["query:page"] }],
      params: [{ name: "page", type: "number" }],
    });
    const r = await call("big", "items", { page: "9007199254740993e0" }, t1);
    assert.equal(r.class, "input", JSON.stringify(r));
    assert.match(r.reason ?? "", /would lose precision/);
    assert.equal(fx.hits.length, 0, "nothing sent");
    assert.deepEqual((await call("big", "items", { page: "9007199254740993" }, t1)).data, [
      { page: "9007199254740993" },
    ]);
  });

  test("a corrupt session or state file is reported as such: not 'check the args', and call() does not throw", async () => {
    site("corrupt", rd("l", "/plain"));
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(HOME, "sessions"), { recursive: true });
    writeFileSync(join(HOME, "sessions", "corrupt.json"), '{"cookies":[{"name":"a"');
    const s = await call("corrupt", "l", {}, t1);
    assert.notEqual(s.class, "input", JSON.stringify(s));
    rmSync(join(HOME, "sessions", "corrupt.json"));
    writeFileSync(join(HOME, "state.json"), '{"tier":');
    await assert.doesNotReject(call("corrupt", "l", {}, t1));
  });

  test("in-process concurrent calls to one site are paced and all answer", async () => {
    site("conc", rd("l", "/plain"));
    const t0 = Date.now();
    const rs = await Promise.all([1, 2, 3].map(() => call("conc", "l", {}, { ...t1, minIntervalMs: 100 })));
    assert.ok(rs.every((r) => r.ok));
    assert.ok(Date.now() - t0 >= 135, "3 requests at 100 ms ±30% spacing");
  });
});

/* ----------------------------------------------------------------- writes gating */

describe("allowWrites at every entry point", () => {
  const writeSite = () =>
    site("wr", rd("read", "/plain"), {
      name: "follow",
      readOnly: false,
      request: {
        method: "POST",
        url: `${fx.base}/api/follow`,
        headers: { "content-type": "application/json" },
        body: '{"id":"1"}',
      },
      trigger: { url: `${fx.base}/` },
      response: { format: "json" },
    });

  test("library: call refused without allowWrites, heal always refuses a write; nothing sent", async () => {
    writeSite();
    const r = await call("wr", "follow", {}, t1);
    assert.equal(r.class, "refused");
    const { heal } = await import("../../src/execute.js");
    assert.equal((await heal("wr", "follow", {}, { ...t1, allowWrites: true })).class, "refused");
    assert.equal(fx.hits.length, 0);
  });

  test("MCP: writes hidden and refused unless the server allows them", async () => {
    writeSite();
    const { createServer: mcp } = await import("../../src/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = mcp({});
    await server.connect(a);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(b);
    const list = await client.callTool({ name: "list_operations", arguments: { site: "wr" } });
    assert.doesNotMatch(JSON.stringify(list), /follow/);
    const r = await client.callTool({ name: "call_operation", arguments: { site: "wr", op: "follow", args: {} } });
    assert.match(JSON.stringify(r), /refused/);
    assert.equal(fx.hits.length, 0);
    await client.close();
  });

  const cli = (...args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const p = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src/cli.ts"), ...args], {
        cwd: ROOT,
        env: { ...process.env, API_ANYTHING_HOME: HOME },
      });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    });

  test("CLI: a write without --allow-writes is refused; --dry redacts every credential and sends nothing", async () => {
    writeSite();
    site("dry", {
      ...rd("me", "/plain"),
      request: { method: "GET", url: `${fx.base}/plain`, headers: { authorization: "", "x-csrf-token": "" } },
      slots: [
        { ref: "session:authorization", at: ["header:authorization"] },
        { ref: "cookie:ct0", at: ["header:x-csrf-token"] },
      ],
    });
    saveSession("dry", {
      cookies: [cookie("ct0", "LIVE-CSRF-SECRET-1", "127.0.0.1")],
      values: { authorization: "Bearer LIVE-BEARER-SECRET" },
    });
    const w = await cli("call", "wr", "follow");
    assert.equal(w.code, 1);
    assert.match(w.out, /refused/);
    const d = await cli("call", "dry", "me", "--dry");
    assert.equal(d.code, 0, d.err);
    assert.doesNotMatch(d.out, /LIVE-/);
    assert.match(d.out, /<ct0>/);
    assert.equal(fx.hits.length, 0);
    // verify runs reads only
    const v = await cli("verify", "wr");
    assert.equal(fx.hits.filter((h) => h.method === "POST").length, 0, v.out);
  });

  test("CLI: an invalid --max-tier is rejected", async () => {
    site("mt", rd("l", "/plain"));
    const r = await cli("call", "mt", "l", "--max-tier", "abc");
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.err, /max-tier/);
  });
});

test("auth stays at tier 1 when no browser tier may run, and when a login is on record", async () => {
  site("pickyoff", rd("items", "/api/picky"));
  // capped at tier 1: the answer is the site's, with the login hint, not "needs tier 2"
  const capped = await call("pickyoff", "items", {}, t1);
  assert.equal(capped.class, "auth", JSON.stringify(capped));
  assert.equal(capped.tier, 1);
  assert.match(capped.next ?? "", /api-anything login pickyoff/);
  // a login was run for this site (its source is recorded, though its cookies are gone): recovery, not a probe
  saveSession("pickyoff", { cookies: [], values: {}, source: "window" });
  fx.hits.length = 0;
  const known = await call("pickyoff", "items", {}, { maxTier: 2, minIntervalMs: 0, timeoutMs: 3000 });
  assert.equal(known.class, "auth", JSON.stringify(known));
  assert.equal(known.tier, 1);
  assert.equal(fx.hits.filter((h) => h.url === "/api/picky").length, 1, "one request, no page fetch");
});

/* ----------------------------------------------------------------- Chrome-only */

describe("browser tiers", { skip: !browserAvailable() && "no Chromium browser installed" }, () => {
  test("a write whose POST was redirected (303) to a 403 page ran: it is not re-sent at tier 2", async () => {
    site("prg", {
      name: "follow",
      readOnly: false,
      request: {
        method: "POST",
        url: `${fx.base}/api/follow`,
        headers: { "content-type": "application/json" },
        body: '{"id":"1"}',
      },
      trigger: { url: `${fx.base}/` },
      response: { format: "json" },
    });
    const r = await call("prg", "follow", {}, { allowWrites: true, maxTier: 2, minIntervalMs: 0, timeoutMs: 5000 });
    const posts = fx.hits.filter((h) => h.method === "POST" && h.url === "/api/follow").length;
    assert.equal(posts, 1, `POST sent ${posts} times; result ${JSON.stringify(r)}`);
  });

  test("tier 2 follows tier 1's redirect policy: a cross-origin 307 gets no ref'd header and no body holding a session value", async () => {
    site(
      "t2xo",
      rd("me", "/away?s=307", {
        minTier: 2,
        request: { method: "GET", url: `${fx.base}/away?s=307`, headers: { "x-csrf": "", "x-keep": "1" } },
        slots: [{ ref: "cookie:ct", at: ["header:x-csrf"] }],
        response: { format: "json" },
      }),
      wrapped("/away?s=307", { minTier: 2, readOnly: true }),
    );
    saveSession("t2xo", {
      cookies: [cookie("ct", "SECRET-CSRF-VALUE-123", "127.0.0.1")],
      values: { token: "SECRET-BODY-TOKEN-123" },
    });
    const o = { maxTier: 2 as const, minIntervalMs: 0, timeoutMs: 5000 };
    // the other origin approves every CORS preflight, so only the policy stands between it and the request
    const landed = () => fx.otherHits.filter((h) => h.method !== "OPTIONS");
    const r = await call("t2xo", "me", {}, o);
    assert.equal(fx.hits.find((h) => h.url === "/away?s=307")?.headers["x-csrf"], "SECRET-CSRF-VALUE-123");
    assert.equal(landed().length, 1, JSON.stringify(r));
    assert.equal(landed()[0]!.headers["x-csrf"], undefined, "the CSRF header went to another origin");
    assert.equal(landed()[0]!.headers["x-keep"], "1");
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 2);

    fx.hits.length = 0;
    fx.otherHits.length = 0;
    const w = await call("t2xo", "post", {}, o);
    assert.match(unwrapped(fx.hits.find((h) => h.method === "POST")!.body), /SECRET-BODY-TOKEN-123/);
    assert.equal(landed().length, 0, `the other origin got ${landed()[0]?.body}`);
    assert.equal(w.ok, false, JSON.stringify(w));
    assert.equal(w.tier, 2);
    assert.match(w.reason ?? "", /not following the HTTP 307 redirect to http:\/\/localhost/);
    assert.match(w.next ?? "", /^do not retry: .* re-learn it with api-anything add t2xo post/);
    assert.equal(fx.hits.filter((h) => h.method === "POST").length, 1, "the request was sent once");
  });

  test("tier 2 same-origin redirects: a hop's cookie rides on the next; 307 keeps POST and body, 303 makes a bodiless GET; a loop ends", async () => {
    const post = (s: number) => ({
      ...rd(`post${s}`, `/hop?s=${s}`, { minTier: 2 }),
      // the 307 is a read with a body: a write stops there
      readOnly: s === 307,
      request: {
        method: "POST",
        url: `${fx.base}/hop?s=${s}`,
        headers: { "content-type": "application/json" },
        body: '{"id":"1"}',
      },
    });
    site("t2hop", rd("boot", "/bootstrap", { minTier: 2 }), post(307), post(303), rd("loop", "/loop", { minTier: 2 }));
    const o = { maxTier: 2 as const, minIntervalMs: 0, timeoutMs: 5000 };
    await (await openBrowser({ profileDir: profileDir() })).clearCookies({ name: "step" });
    const r = await call("t2hop", "boot", {}, o);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 2);
    assert.match(fx.hits.find((h) => h.url === "/needs-step")?.headers.cookie ?? "", /(^|; )step=1/);

    for (const [s, method, body, type] of [
      [307, "POST", '{"id":"1"}', "application/json"],
      [303, "GET", "", undefined],
    ] as const) {
      fx.hits.length = 0;
      const w = await call("t2hop", `post${s}`, {}, { ...o, allowWrites: true });
      assert.equal(w.ok, true, JSON.stringify(w));
      const landed = fx.hits.find((h) => h.url === "/landed");
      assert.deepEqual([landed?.method, landed?.body, landed?.headers["content-type"]], [method, body, type], `${s}`);
      assert.equal(fx.hits.filter((h) => h.url.startsWith("/hop")).length, 1, "the write was sent once");
    }

    fx.hits.length = 0;
    const loop = await call("t2hop", "loop", {}, o);
    assert.equal(loop.ok, false);
    assert.equal(loop.class, "error", JSON.stringify(loop));
    assert.ok(fx.hits.length <= 21, `${fx.hits.length} requests`);

    // Post/Redirect/Get to a page that refuses scripts: the 403 answers the redirect's follow-up, so the write ran
    site("t2prg", {
      ...post(303),
      name: "follow",
      request: { method: "POST", url: `${fx.base}/api/follow`, headers: {}, body: "x=1" },
    });
    fx.hits.length = 0;
    const ran = await call("t2prg", "follow", {}, { ...o, allowWrites: true });
    assert.equal(ran.tier, 2, JSON.stringify(ran));
    assert.equal(fx.hits.filter((h) => h.method === "POST").length, 1, "the write was sent once");
    assert.match(ran.next ?? "", /may have gone through/, "a redirected write is one that ran");
  });

  for (const tier of [1, 2] as const) {
    const o = { maxTier: tier, minIntervalMs: 0, timeoutMs: 5000 };

    test(`tier ${tier}: a Location that copies a token from inside a header is not followed to another origin`, async () => {
      site(`copy${tier}`, {
        ...rd("me", "/away-copy", { minTier: tier }),
        request: { method: "GET", url: `${fx.base}/away-copy`, headers: { "x-session": '{"token":""}' } },
        slots: [{ ref: "session:token", at: ["header:x-session", "json:/token"] }],
        response: { format: "json" },
      });
      saveSession(`copy${tier}`, { cookies: [], values: { token: "SECRET-token-1234" } });
      const r = await call(`copy${tier}`, "me", {}, o);
      assert.deepEqual(
        fx.otherHits.filter((h) => h.method !== "OPTIONS").map((h) => h.url),
        [],
        "the token reached the other origin in the address",
      );
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(r.reason ?? "", /not following the HTTP 302 redirect/);
    });

    test(`tier ${tier}: a POST redirected to a GET loses every body header with its body`, async () => {
      for (const s of [301, 302, 303]) {
        site(`strict${tier}s${s}`, {
          ...rd("q", `/hop-strict?s=${s}`, { minTier: tier }),
          request: {
            method: "POST",
            url: `${fx.base}/hop-strict?s=${s}`,
            headers: { "content-type": "text/plain", "content-language": "en", "content-location": "/x" },
            body: "q",
          },
        });
        const r = await call(`strict${tier}s${s}`, "q", {}, o);
        assert.equal(r.ok, true, `HTTP ${s}: ${JSON.stringify(r)}`);
      }
    });

    test(`tier ${tier}: a GET answered 303 goes on as it was, headers and all`, async () => {
      site(`told${tier}`, {
        ...rd("q", "/hop?s=303&to=/told", { minTier: tier }),
        request: {
          method: "GET",
          url: `${fx.base}/hop?s=303&to=/told`,
          headers: { "content-language": "fr", "content-type": "application/json" },
        },
      });
      const r = await call(`told${tier}`, "q", {}, o);
      assert.deepEqual(r.data, [{ language: "fr", type: "application/json" }], JSON.stringify(r));
    });

    test(`tier ${tier}: a session value no header can carry fails naming the header, never the value`, async () => {
      site(`brk${tier}`, {
        ...rd("me", "/api/brk", { minTier: tier }),
        request: { method: "GET", url: `${fx.base}/api/brk`, headers: { "x-token": "" } },
        slots: [{ ref: "session:tok", at: ["header:x-token"] }],
      });
      saveSession(`brk${tier}`, { cookies: [], values: { tok: "SECRET-source-token-1234\r\nextra" } });
      fx.hits.length = 0;
      const r = await call(`brk${tier}`, "me", {}, o);
      assert.equal(r.ok, false);
      assert.doesNotMatch(JSON.stringify(r), /SECRET|extra/);
      assert.match(r.reason ?? "", /the x-token header/);
      assert.match(r.next ?? "", /api-anything login brk\d/);
      assert.equal(fx.hits.filter((h) => h.url === "/api/brk").length, 0);
    });

    test(`tier ${tier}: a write is not sent a second time by a redirect, and the result says where it stopped`, async () => {
      const write = (name: string, method: string, path: string) => ({
        ...rd(name, path, { minTier: tier }),
        readOnly: false,
        request: { method, url: `${fx.base}${path}`, headers: {}, ...(method === "GET" ? {} : { body: "x=1" }) },
      });
      const sends = () => fx.hits.map((h) => h.url).filter((u) => /^\/(again|hop|landed)/.test(u));
      site(
        `once${tier}`,
        write("loop307", "POST", "/again?s=307"),
        write("loop308", "POST", "/again?s=308"),
        write("moved", "POST", "/hop?s=307"),
        write("put", "PUT", "/hop?s=302"),
        write("vote", "GET", "/again?s=302"),
        write("prg", "GET", "/hop?s=302"),
      );
      for (const [name, status] of [
        ["loop307", 307],
        ["loop308", 308],
        ["moved", 307],
        ["put", 302],
        ["vote", 302],
      ] as const) {
        fx.hits.length = 0;
        const r = await call(`once${tier}`, name, {}, { ...o, allowWrites: true });
        assert.equal(sends().length, 1, `${name} was sent to ${sends()}: ${JSON.stringify(r)}`);
        assert.equal(r.ok, false, `${name}: ${JSON.stringify(r)}`);
        assert.equal(
          r.reason,
          `not following the HTTP ${status} redirect to ${fx.base}: it would send this write again`,
          name,
        );
        assert.match(
          r.next ?? "",
          /^the write was sent once.*check the site first.*Do not retry.*api-anything add once\d \w+ \.\.\. --write/,
        );
      }
      // a GET write's landing page is another request: followed
      fx.hits.length = 0;
      const prg = await call(`once${tier}`, "prg", {}, { ...o, allowWrites: true });
      assert.equal(prg.ok, true, JSON.stringify(prg));
      assert.deepEqual(sends(), ["/hop?s=302", "/landed"]);
    });

    // each tier's cap is the one it had before redirects were followed by hand: 5 at tier 1, 20 at tier 2
    const cap = tier === 1 ? 5 : 20;

    test(`tier ${tier}: a chain is followed up to ${cap} redirects; one more ends saying so, and how to go on`, async () => {
      site(`chain${tier}`, rd("far", "/chain", { minTier: tier }), rd("round", "/loop", { minTier: tier }));
      const far = await call(`chain${tier}`, "far", {}, o);
      if (tier === 2) assert.deepEqual(far.data, [{ end: 6 }], JSON.stringify(far));
      else assert.match(far.reason ?? "", /^stopped after 5 redirects/, JSON.stringify(far));

      fx.hits.length = 0;
      const r = await call(`chain${tier}`, "round", {}, o);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(
        r.reason ?? "",
        new RegExp(`^stopped after ${cap} redirects, the last one to http://127\\.0\\.0\\.1:\\d+$`),
      );
      assert.match(r.next ?? "", /do not retry.*api-anything add chain\d round/);
      assert.equal(fx.hits.filter((h) => h.url === "/loop").length, cap + 1);
    });

    test(`tier ${tier}: a GET write sent on to a new address at each hop reaches the server no more than ${cap + 1} times`, async () => {
      site(`votes${tier}`, { ...rd("vote", "/vote/0", { minTier: tier }), readOnly: false });
      fx.hits.length = 0;
      const r = await call(`votes${tier}`, "vote", {}, { ...o, allowWrites: true });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(fx.hits.filter((h) => h.url.startsWith("/vote")).length, cap + 1);
      assert.match(r.next ?? "", /check the site first/);
    });
  }

  test("tier 2 refuses a redirect it cannot tell from another's: the origin page sent the same request at the same time", async () => {
    const waiting: ServerResponse[] = [];
    const landed: string[] = [];
    const twin = createHttpServer((req, res) => {
      if (req.url === "/")
        return void res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            '<!doctype html><title>twin</title><script>fetch("/twin?token=SECRET-query-token-123",{method:"POST",body:"q"})</script>',
          );
      // a POST: Chrome's cache makes a second GET of one URL wait for the first
      if (req.url?.startsWith("/twin")) {
        // held until a second copy comes in (the page's own, then the call's); then each is sent
        // somewhere else. One alone goes on after 3 s: a page replaced for a stall sends its own again.
        const mate = waiting.shift();
        if (mate) {
          mate.writeHead(302, { location: "/to-0" }).end();
          return void res.writeHead(302, { location: "/to-1" }).end();
        }
        waiting.push(res);
        setTimeout(() => {
          if (waiting.includes(res))
            waiting.splice(waiting.indexOf(res), 1)[0]!.writeHead(302, { location: "/to-alone" }).end();
        }, 3000).unref();
        return;
      }
      landed.push(req.url!);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => twin.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(twin.address() as AddressInfo).port}`;
    try {
      const request = { method: "POST", url: `${base}/twin?token=x`, headers: {}, body: "q" };
      const slots = [{ ref: "session:token", at: ["query:token"] }];
      const query = rd("query", "/twin", { minTier: 2, request, slots });
      saveSite(parseSite({ name: "twin", baseUrl: base, operations: [query] }));
      saveSession("twin", { cookies: [], values: { token: "SECRET-query-token-123" } });
      // This checks redirect safety, not speed: leave room for the runner's concurrent browser tests.
      const r = await call("twin", "query", {}, { maxTier: 2, minIntervalMs: 0 });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(r.reason ?? "", /not following a redirect from http:\/\/127\.0\.0\.1:\d+: .* cannot be told apart/);
      assert.doesNotMatch(JSON.stringify(r), /SECRET-query-token-123/, "the result carries the session's token");
      assert.ok(!landed.includes("/to-1"), `followed anyway: ${landed}`);
    } finally {
      twin.closeAllConnections();
      twin.close();
    }
  });

  test("a param's default reaches the tier-3 trigger: the page opens with it, not with a literal {page}", async () => {
    site("deftrig", {
      ...rd("items", "/api/items?page=1", { minTier: 3 }),
      slots: [{ param: "page", at: ["query:page"] }],
      params: [{ name: "page", default: "7", required: false }],
      trigger: { url: `${fx.base}/paged?page={page}` },
      match: { path: "/api/items" },
    });
    const r = await call("deftrig", "items", {}, { minIntervalMs: 0, timeoutMs: 5000 });
    const pages = fx.hits.filter((h) => h.url.startsWith("/paged")).map((h) => h.url);
    assert.deepEqual(pages, ["/paged?page=7"], JSON.stringify(r));
    assert.equal(r.tier, 3, JSON.stringify(r));
    assert.deepEqual(r.data, [{ page: "7" }]);
  });

  test("auth at tier 2 re-imports the browser session into the profile and retries once; a write is not resent", async () => {
    site("t2auth", rd("me", "/api/me", { minTier: 2 }), {
      ...rd("save", "/api/me", { minTier: 2 }),
      readOnly: false,
      request: { method: "POST", url: `${fx.base}/api/me`, headers: {}, body: "x=1" },
    });
    const root = mkdtempSync(join(HOME, "everyday-browser-"));
    // the human signs in in their everyday browser; the server honours only that session
    const signIn = (sid: string) => {
      fx.state.sid = sid;
      makeChromiumDb(join(root, "Default"), [{ host_key: "127.0.0.1", name: "sid", value: sid }], { password: "pw" });
    };
    const me = () => fx.hits.filter((h) => h.url === "/api/me").length;
    const o = { maxTier: 2 as const, minIntervalMs: 0, timeoutMs: 5000 };
    process.env.API_ANYTHING_BROWSER_ROOTS = JSON.stringify([
      { name: "Chrome", family: "chromium", root, password: "pw" },
    ]);
    try {
      signIn("first");
      assert.equal(
        (await importSession("t2auth", `${fx.base}/`, { confirm: async () => true }))?.source,
        "chrome:Default",
      );
      assert.deepEqual((await call("t2auth", "me", {}, o)).data, [{ me: "first" }]);

      signIn("second");
      fx.hits.length = 0;
      const r = await call("t2auth", "me", {}, o);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.tier, 2);
      assert.deepEqual(r.data, [{ me: "second" }]);
      assert.equal(me(), 2, "one retry");

      // logged out with nothing new to import: the same cookies again are not retried, and the hint
      // names the profile to sign in to again, since login would import the same ones
      fx.state.sid = "third";
      fx.hits.length = 0;
      const out = await call("t2auth", "me", {}, o);
      assert.equal(out.class, "auth", JSON.stringify(out));
      assert.match(out.next ?? "", /sign in to 127\.0\.0\.1 in Chrome profile "Default"/);
      assert.equal(me(), 1, "no retry with the same cookies");

      // a write answered 200 with the login page may have run: never resent
      fx.hits.length = 0;
      const w = await call("t2auth", "save", {}, { ...o, allowWrites: true });
      assert.equal(w.class, "auth", JSON.stringify(w));
      assert.equal(me(), 1, "the write was sent once");
    } finally {
      delete process.env.API_ANYTHING_BROWSER_ROOTS;
    }
  });

  test("a tier-3 read's own request may be sent on by a 307, to its own origin or another", async () => {
    for (const far of [false, true]) {
      const q = far ? "?far=1" : "";
      site(`signed${q ? "far" : ""}`, {
        ...rd("q", `/read${q}`, { minTier: 3, trigger: { url: `${fx.base}/signed-page${q}` } }),
        request: { method: "POST", url: `${fx.base}/read${q}`, headers: {}, body: "final" },
        match: { method: "POST", path: "/read" },
      });
      fx.hits.length = 0;
      fx.otherHits.length = 0;
      const r = await call(`signed${q ? "far" : ""}`, "q", {}, { maxTier: 3, minIntervalMs: 0, timeoutMs: 5000 });
      const posts = (hits: typeof fx.hits) => hits.filter((h) => h.method === "POST").map((h) => `${h.url} ${h.body}`);
      // the check is reached, wherever it is, and then the page asks for the data
      assert.deepEqual(
        [...posts(fx.hits), ...posts(fx.otherHits)].sort(),
        ["/answer initial", `/read${q} final`, `/read${q} initial`],
        JSON.stringify(r),
      );
      assert.equal(posts(fx.otherHits).length, far ? 1 : 0);
      assert.equal(r.tier, 3, JSON.stringify(r));
      assert.deepEqual(r.data, [{ name: "alice" }]);
    }
  });

  test("auth at tier 3 re-imports the browser session into the profile and retries once", async () => {
    site(
      "t3auth",
      rd("me", "/api/me", { minTier: 3, trigger: { url: `${fx.base}/me-page` }, match: { path: "/api/me" } }),
    );
    const root = mkdtempSync(join(HOME, "everyday-browser-"));
    const signIn = (sid: string) => {
      fx.state.sid = sid;
      makeChromiumDb(join(root, "Default"), [{ host_key: "127.0.0.1", name: "sid", value: sid }], { password: "pw" });
    };
    const me = () => fx.hits.filter((h) => h.url === "/api/me").length;
    const o = { minIntervalMs: 0, timeoutMs: 5000 };
    process.env.API_ANYTHING_BROWSER_ROOTS = JSON.stringify([
      { name: "Chrome", family: "chromium", root, password: "pw" },
    ]);
    try {
      signIn("first");
      assert.equal(
        (await importSession("t3auth", `${fx.base}/`, { confirm: async () => true }))?.source,
        "chrome:Default",
      );
      assert.deepEqual((await call("t3auth", "me", {}, o)).data, [{ me: "first" }]);

      signIn("second");
      fx.hits.length = 0;
      const r = await call("t3auth", "me", {}, o);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.tier, 3);
      assert.deepEqual(r.data, [{ me: "second" }]);
      assert.equal(me(), 2, "one retry");

      // logged out with nothing new to import: no retry, and the hint names the profile
      fx.state.sid = "third";
      fx.hits.length = 0;
      const out = await call("t3auth", "me", {}, o);
      assert.equal(out.class, "auth", JSON.stringify(out));
      assert.match(out.next ?? "", /sign in to 127\.0\.0\.1 in Chrome profile "Default"/);
      assert.equal(me(), 1, "no retry with the same cookies");
    } finally {
      delete process.env.API_ANYTHING_BROWSER_ROOTS;
    }
  });

  test("a tier-3 write that ran and was then redirected to a refusal is not sent again by auth recovery", async () => {
    site("t3write", {
      ...rd("save", "/api/save", {
        minTier: 3,
        trigger: { url: `${fx.base}/save-page` },
        match: { method: "POST", path: "/api/save" },
      }),
      readOnly: false,
      request: { method: "POST", url: `${fx.base}/api/save`, headers: {}, body: "x=1" },
    });
    // a session to re-import, so recovery would have something to retry with
    const root = mkdtempSync(join(HOME, "everyday-browser-"));
    makeChromiumDb(join(root, "Default"), [{ host_key: "127.0.0.1", name: "sid", value: "any" }], { password: "pw" });
    process.env.API_ANYTHING_BROWSER_ROOTS = JSON.stringify([
      { name: "Chrome", family: "chromium", root, password: "pw" },
    ]);
    try {
      assert.equal(
        (await importSession("t3write", `${fx.base}/`, { confirm: async () => true }))?.source,
        "chrome:Default",
      );
      fx.hits.length = 0;
      const r = await call("t3write", "save", {}, { allowWrites: true, minIntervalMs: 0, timeoutMs: 5000 });
      const saves = fx.hits.filter((h) => h.method === "POST" && h.url === "/api/save").length;
      assert.equal(saves, 1, `the write was sent ${saves} times; result ${JSON.stringify(r)}`);
      assert.equal(r.ok, false);
      assert.match(r.next ?? "", /check the site/);
      assert.doesNotMatch(r.next ?? "", /retry once/);
      // the server's 307 would have the page send the write a second time: stopped, and said
      assert.deepEqual(
        fx.hits.filter((h) => h.url === "/api/save?login=1").map((h) => h.method),
        [],
        "the redirect sent the write on",
      );
      assert.equal(r.class, "error", JSON.stringify(r));
      assert.match(r.reason ?? "", /^the site answered this write with a redirect that would send it again: stopped/);
      assert.match(r.next ?? "", /api-anything add t3write save \.\.\. --write/);
    } finally {
      delete process.env.API_ANYTHING_BROWSER_ROOTS;
    }
  });

  test("a tier-3 write whose page sends it twice is performed once, and the result says a repeat was stopped", async () => {
    site("t3twice", {
      ...rd("save", "/api/double", {
        minTier: 3,
        trigger: { url: `${fx.base}/double-page`, steps: [{ action: "click", selector: "#go" }] },
        match: { method: "POST", path: "/api/double" },
      }),
      readOnly: false,
      request: { method: "POST", url: `${fx.base}/api/double`, headers: {}, body: "x=1" },
      response: { format: "json" },
    });
    const r = await call("t3twice", "save", {}, { allowWrites: true, minIntervalMs: 0, timeoutMs: 5000 });
    const posts = (path: string) => fx.hits.filter((h) => h.method === "POST" && h.url === path).length;
    assert.equal(posts("/api/double"), 1, `the write reached the server ${posts("/api/double")} times`);
    assert.equal(posts("/api/companion"), 1, "what else the trigger sends is left alone");
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 3);
    assert.match(r.reason ?? "", /sent this write 2 times.* stopped/);
  });

  test("auth at tier 2 from a stale cookie behind a header ref: the jar is refreshed from the profile, one retry", async () => {
    site(
      "t2csrf",
      rd("items", "/api/csrf", {
        minTier: 2,
        request: { method: "GET", url: `${fx.base}/api/csrf`, headers: { "x-csrf": "" } },
        slots: [{ ref: "cookie:ct", at: ["header:x-csrf"] }],
      }),
    );
    // the site rotated its token in the profile; the jar still holds the old one
    await addCookiesToProfile([cookie("ct", "fresh", "127.0.0.1")], profileDir());
    saveSession("t2csrf", { cookies: [cookie("ct", "stale", "127.0.0.1")], values: {} });
    const r = await call("t2csrf", "items", {}, { maxTier: 2, minIntervalMs: 0, timeoutMs: 5000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 2);
    assert.deepEqual(r.data, [{ ct: "fresh" }]);
    assert.equal(fx.hits.filter((h) => h.url === "/api/csrf").length, 2, "one retry");
  });

  test("auth at tier 2: a cookie: ref the refreshed jar cannot place is a failed call, not a thrown one", async () => {
    site(
      "t2wrap",
      rd("items", "/api/csrf", {
        minTier: 2,
        request: { method: "GET", url: `${fx.base}/api/csrf`, headers: { "x-wrap": "{}" } },
        slots: [{ ref: "cookie:ct", at: ["header:x-wrap", "json:/token"] }],
      }),
    );
    // with no ct in the jar the slot is skipped; the profile has one, and it has nowhere to go in "{}"
    await addCookiesToProfile([cookie("ct", "fresh", "127.0.0.1")], profileDir());
    saveSession("t2wrap", { cookies: [], values: {} });
    const r = await call("t2wrap", "items", {}, { maxTier: 2, minIntervalMs: 0, timeoutMs: 5000 });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.reason ?? "", /JSON pointer/);
  });

  test("auth at tier 2 for a read with a session: ref: one trigger run refreshes the value and answers", async () => {
    site(
      "t2token",
      rd("items", "/api/token", {
        minTier: 2,
        request: { method: "GET", url: `${fx.base}/api/token`, headers: { "x-token": "" } },
        slots: [{ ref: "session:x-token", at: ["header:x-token"] }],
        trigger: { url: `${fx.base}/tokened` },
        match: { path: "/api/token" },
      }),
    );
    const o = { minIntervalMs: 0, timeoutMs: 5000 };
    const r = await call("t2token", "items", {}, o);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 3);
    assert.match(r.reason ?? "", /^tier 2 said auth .*refreshed the session/);
    assert.equal((await call("t2token", "items", {}, o)).tier, 2, "the refreshed value serves tier 2");
  });

  test("auth with no login on record gets one attempt from a real page before giving up, and the tier that answers is remembered", async () => {
    site("picky", rd("items", "/api/picky"));
    const o = { minIntervalMs: 0, timeoutMs: 5000 };
    fx.hits.length = 0;
    const r = await call("picky", "items", {}, o);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 2);
    assert.deepEqual(r.data, [{ picky: "ok" }]);
    assert.match(r.reason ?? "", /tier 1 said auth with no login on record/);
    // the next call starts where this one got through
    fx.hits.length = 0;
    assert.equal((await call("picky", "items", {}, o)).tier, 2);
    assert.equal(fx.hits.filter((h) => h.url === "/api/picky").length, 1, "tier 1 was not tried again");
  });

  test("when the page says auth too, the call ends exactly as it would have: tier 1's auth and the login hint", async () => {
    // /api/me answers its login page to everyone but the one session it honours
    site("walled", rd("me", "/api/me"));
    fx.state.sid = "nobody-has-this";
    fx.hits.length = 0;
    const r = await call("walled", "me", {}, { minIntervalMs: 0, timeoutMs: 5000 });
    assert.equal(r.class, "auth", JSON.stringify(r));
    assert.equal(r.tier, 1);
    assert.match(r.next ?? "", /api-anything login walled/);
    const fromPage = fx.hits.filter((h) => h.url === "/api/me" && /Chrome\//.test(String(h.headers["user-agent"])));
    assert.equal(fromPage.length, 1, "one attempt from a page, and no trigger run");
  });

  test("a write is never given the page attempt: it ends as tier 1's auth, and no page sent it", async () => {
    // 401 is an answer a write may be retried after, so only the read-only rule keeps this one from the page
    const url = `${fx.base}/api/picky?status=401`;
    site(
      "pickywrite",
      rd("save", "/api/picky", { readOnly: false, request: { method: "POST", url, headers: {}, body: "x=1" } }),
    );
    fx.hits.length = 0;
    const r = await call("pickywrite", "save", {}, { allowWrites: true, minIntervalMs: 0, timeoutMs: 5000 });
    assert.equal(r.class, "auth", JSON.stringify(r));
    assert.equal(r.tier, 1);
    // recovery may send it once more after a 401, with the profile's cookies: that is plain HTTP too
    assert.ok(fx.hits.filter((h) => h.method === "POST").length <= 2);
    assert.equal(
      fx.hits.filter((h) => /Chrome\//.test(String(h.headers["user-agent"]))).length,
      0,
      "no page was opened",
    );
  });

  test("a login that recovery finds counts: with one in the jar by then, auth is the answer and no page is opened", async () => {
    // nothing on record at the start; the Chrome profile holds a login cookie the wall does not care about
    site(
      "pickyin",
      rd("items", "/api/picky", { request: { method: "GET", url: `${fx.base}/api/picky`, headers: {} } }),
    );
    await addCookiesToProfile([cookie("sessionid", "signed-in-elsewhere", "127.0.0.1")], profileDir());
    fx.hits.length = 0;
    const r = await call("pickyin", "items", {}, { minIntervalMs: 0, timeoutMs: 5000 });
    assert.equal(r.class, "auth", JSON.stringify(r));
    assert.equal(r.tier, 1);
    assert.equal(
      fx.hits.filter((h) => /Chrome\//.test(String(h.headers["user-agent"]))).length,
      0,
      "no page was opened",
    );
  });

  test("recovery comes before the page attempt: a fresher cookie in the Chrome profile answers at tier 1", async () => {
    // a session with no source (one saved by an older version), an empty jar, and the cookie only in the profile
    site("legacy", rd("me", "/api/me"));
    fx.state.sid = "profile-only";
    await addCookiesToProfile([cookie("sid", "profile-only", "127.0.0.1")], profileDir());
    saveSession("legacy", { cookies: [], values: {} });
    fx.hits.length = 0;
    const r = await call("legacy", "me", {}, { minIntervalMs: 0, timeoutMs: 5000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 1);
    assert.deepEqual(r.data, [{ me: "profile-only" }]);
    const fromPage = fx.hits.filter((h) => h.url === "/api/me" && /Chrome\//.test(String(h.headers["user-agent"])));
    assert.equal(fromPage.length, 0, "the jar was refreshed from the profile and plain HTTP answered");
  });

  test("tier 2 honours timeoutMs", async () => {
    site("t2slow", rd("n", "/never", { minTier: 2 }), rd("up", "/plain", { minTier: 2 }));
    // timeoutMs bounds the wait for the site's answer, not Chrome's first start in this process
    // (many seconds on a busy machine): have the browser up on the origin before the clock starts.
    assert.equal((await call("t2slow", "up", {}, { maxTier: 2, minIntervalMs: 0 })).ok, true);
    const t0 = Date.now();
    const r = await Promise.race([
      call("t2slow", "n", {}, { maxTier: 2, minIntervalMs: 0, timeoutMs: 1000 }),
      new Promise<"hung">((res) => setTimeout(() => res("hung"), 15_000).unref()),
    ]);
    assert.notEqual(r, "hung", `no answer after ${Date.now() - t0} ms with timeoutMs 1000`);
  });

  test("tier 2's timeoutMs is one deadline once Chrome is up: opening the site's page and the fetch share it", async () => {
    // a site whose root page takes 2.5 s to come, and whose API never answers
    const slow = createHttpServer((req, res) => {
      if (req.url !== "/") return;
      setTimeout(
        () => res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>slow</title>"),
        2500,
      );
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    try {
      site("t2up", rd("up", "/plain", { minTier: 2 }));
      assert.equal((await call("t2up", "up", {}, { maxTier: 2, minIntervalMs: 0 })).ok, true, "Chrome is up");
      const request = { method: "GET", url: `${base}/api`, headers: {} };
      saveSite(parseSite({ name: "t2late", baseUrl: base, operations: [rd("n", "/api", { minTier: 2, request })] }));
      const t0 = Date.now();
      const r = await call("t2late", "n", {}, { maxTier: 2, minIntervalMs: 0, timeoutMs: 3000 });
      const ms = Date.now() - t0;
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(r.reason ?? "", /no response within 3000 ms/);
      assert.ok(ms < 4500, `${ms} ms with timeoutMs 3000: the page's 2.5 s were not counted`);
    } finally {
      slow.closeAllConnections();
      slow.close();
    }
  });

  test("a tier-2 page still busy at the deadline is reported as the deadline, not as a stalled page", async () => {
    // the root page's renderer is busy for 1.5 s right after load, so its fetch can't start before a 1 s deadline
    const busy = createHttpServer((req, res) => {
      if (req.url !== "/") return;
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<!doctype html><script>setTimeout(()=>{for(const e=Date.now()+1500;Date.now()<e;);})</script>");
    });
    await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(busy.address() as AddressInfo).port}`;
    try {
      site("t2up", rd("up", "/plain", { minTier: 2 }));
      assert.equal((await call("t2up", "up", {}, { maxTier: 2, minIntervalMs: 0 })).ok, true, "Chrome is up");
      const request = { method: "GET", url: `${base}/api`, headers: {} };
      saveSite(parseSite({ name: "t2busy", baseUrl: base, operations: [rd("n", "/api", { minTier: 2, request })] }));
      const r = await call("t2busy", "n", {}, { maxTier: 2, minIntervalMs: 0, timeoutMs: 1000 });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(r.reason ?? "", /no response within 1000 ms/);
      assert.doesNotMatch(r.reason ?? "", /within 2000 ms/);
    } finally {
      busy.closeAllConnections();
      busy.close();
    }
  });

  test("a cached page that never sends the fetch is replaced, the write goes once, and what the page sends when it wakes never leaves", async () => {
    site("t2stall", rd("up", "/plain", { minTier: 2 }), {
      ...rd("save", "/api/stalled", { minTier: 2 }),
      readOnly: false,
      request: { method: "POST", url: `${fx.base}/api/stalled`, headers: {}, body: "x=1" },
    });
    assert.equal((await call("t2stall", "up", {}, { maxTier: 2, minIntervalMs: 0 })).ok, true, "the page is cached");
    const cached = (await openBrowser({ profileDir: profileDir() })).pages().find((p) => p.url() === `${fx.base}/`);
    assert.ok(cached, "the cached origin page");
    // a renderer that runs nothing for longer than the call may take, as a stalled one did
    const busy = Date.now() + 6000;
    await cached.evaluate(
      (until) =>
        void setTimeout(() => {
          while (Date.now() < until);
        }),
      busy,
    );
    const r = await call("t2stall", "save", {}, { maxTier: 2, minIntervalMs: 0, timeoutMs: 4000, allowWrites: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 2);
    assert.equal(r.write, "accepted");
    // the stalled page wakes up and runs the fetch it was handed
    await new Promise((res) => setTimeout(res, Math.max(0, busy + 1500 - Date.now())));
    assert.equal(fx.hits.filter((h) => h.url === "/api/stalled").length, 1, "sent once");
  });

  test("a second process (CLI next to a running MCP server) can still use tier 2", async () => {
    await closeBrowser();
    site("two", rd("l", "/plain", { minTier: 2 }));
    const holder = `
      import { call } from ${JSON.stringify(join(ROOT, "src/execute.ts"))};
      const r = await call("two", "l", {}, { minIntervalMs: 0 });
      console.log("HOLDER " + r.ok);
      await new Promise((r) => setTimeout(r, 8000)); // an MCP server stays up with Chrome open
      process.exit(0);
    `;
    const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", holder], {
      cwd: ROOT,
      env: { ...process.env, API_ANYTHING_HOME: HOME },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        p.stdout.on("data", (d) => (/HOLDER true/.test(String(d)) ? resolve() : reject(new Error(String(d)))));
        p.on("close", () => reject(new Error("holder exited")));
      });
      const r = await call("two", "l", {}, { minIntervalMs: 0 });
      assert.equal(
        r.ok,
        true,
        `${r.class}: ${(r.reason ?? "").slice(0, 200)} (reason ${(r.reason ?? "").length} chars)`,
      );
    } finally {
      p.kill();
    }
  });
});

/* ----------------------------------------------------------------- two processes */

test("two processes merging browser cookies into one jar lose nothing", async () => {
  const script = (tag: string) => `
    import { mergeCapture } from ${JSON.stringify(join(ROOT, "src/session.ts"))};
    for (let i = 0; i < 150; i++) mergeCapture("race", [{ name: "${tag}" + i, value: "v", domain: "race.test", path: "/", expires: -1, httpOnly: false, secure: false }]);
  `;
  const run = (tag: string) =>
    new Promise<number>((resolve) => {
      const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script(tag)], {
        cwd: ROOT,
        env: { ...process.env, API_ANYTHING_HOME: HOME },
        stdio: "inherit",
      });
      p.on("close", (c) => resolve(c ?? -1));
    });
  const codes = await Promise.all([run("a"), run("b")]);
  assert.deepEqual(codes, [0, 0]);
  const n = loadSession("race").cookies.length;
  assert.equal(n, 300, `jar kept ${n} of 300 cookies`);
});

describe("a read refused for the browser's identity headers", () => {
  const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  /** what a learned op copies from Chrome, identity and all */
  const chrome = () => ({
    "user-agent": UA,
    "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130"',
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-site": "same-origin",
    "sec-fetch-dest": "empty",
    accept: "application/json",
    referer: `${fx.base}/`,
  });
  const at = (path: string, over: Record<string, unknown> = {}) =>
    rd("from", path, { request: { method: "GET", url: `${fx.base}${path}`, headers: chrome() }, ...over });
  const sent = (path: string) => fx.hits.filter((h) => h.url.startsWith(path));

  test("plain HTTP answers without them at tier 1, under max tier 1, and nothing is kept", async () => {
    site("sorry", at("/api/sorry?site=arxiv.org"));
    const r = await call("sorry", "from", {}, t1);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 1);
    assert.deepEqual(r.data, [{ sorry: "ok" }]);
    assert.match(r.reason ?? "", /^tier 1 said auth \(HTTP 419: Sorry\); plain HTTP answered without the browser's/);
    const [first, second] = sent("/api/sorry");
    assert.equal(sent("/api/sorry").length, 2);
    assert.match(String(first!.headers["user-agent"]), /Chrome\//);
    assert.equal(second!.url, first!.url);
    assert.doesNotMatch(String(second!.headers["user-agent"]), /Chrome\//);
    for (const h of ["sec-ch-ua", "sec-ch-ua-platform", "sec-fetch-site", "sec-fetch-dest"])
      assert.equal(second!.headers[h], undefined, h);
    assert.equal(second!.headers.accept, "application/json");
    assert.equal(second!.headers.referer, `${fx.base}/`);
    assert.equal(rememberedTier("sorry", "from"), undefined);
    fx.hits.length = 0;
    assert.equal((await call("sorry", "from", {}, t1)).ok, true);
    assert.equal(sent("/api/sorry").length, 2, "the next call sends the stored template first again");
  });

  test("a wall that answers 403 (blocked) gets the same retry instead of a browser", async () => {
    site("sorry403", at("/api/sorry?wall=403"));
    const r = await call("sorry403", "from", {}, t1);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 1);
    assert.match(r.reason ?? "", /^tier 1 said blocked/);
    assert.equal(sent("/api/sorry").length, 2);
  });

  test("a site that wants the Chrome user-agent answers the first request: no retry", async () => {
    site("wantsua", at("/api/picky"));
    const r = await call("wantsua", "from", {}, t1);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.reason, undefined);
    assert.equal(sent("/api/picky").length, 1);
  });

  test("a write is sent once, even after a 401 a write may be retried after", async () => {
    site(
      "sorrywrite",
      at("/api/sorry", {
        readOnly: false,
        request: { method: "POST", url: `${fx.base}/api/sorry?wall=401`, headers: chrome(), body: "x=1" },
      }),
    );
    const r = await call("sorrywrite", "from", {}, { ...t1, allowWrites: true });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(sent("/api/sorry").length, 1);
  });

  test("no retry for an op without them, a login on record, or a slot that fills the user-agent", async () => {
    site("bare419", rd("from", "/api/picky"));
    assert.equal((await call("bare419", "from", {}, t1)).class, "auth");
    assert.equal(sent("/api/picky").length, 1, "nothing to remove");

    fx.hits.length = 0;
    site("signedin", at("/api/sorry", { learnedLoggedIn: true }));
    assert.equal((await call("signedin", "from", {}, t1)).class, "auth");
    assert.equal(sent("/api/sorry").length, 1, "learned signed in");

    fx.hits.length = 0;
    site("withref", at("/api/sorry", { slots: [{ ref: "cookie:ct0", at: ["header:x-csrf-token"] }] }));
    saveSession("withref", { cookies: [cookie("ct0", "c", "127.0.0.1")], values: {} });
    assert.equal((await call("withref", "from", {}, t1)).class, "auth");
    assert.equal(sent("/api/sorry").length, 1, "takes a cookie");

    fx.hits.length = 0;
    saveSite(parseSite({ name: "jarlogin", baseUrl: fx.base, loginCookies: ["sid"], operations: [at("/api/sorry")] }));
    saveSession("jarlogin", { cookies: [cookie("sid", "s", "127.0.0.1")], values: {} });
    assert.equal((await call("jarlogin", "from", {}, t1)).class, "auth");
    assert.equal(sent("/api/sorry").length, 1, "a live login cookie in the jar");

    fx.hits.length = 0;
    site(
      "uaslot",
      at("/api/sorry", {
        params: [{ name: "ua", required: true }],
        slots: [{ param: "ua", at: ["header:user-agent"] }],
      }),
    );
    assert.equal((await call("uaslot", "from", { ua: UA }, t1)).class, "auth");
    assert.equal(sent("/api/sorry").length, 1, "the caller fills the user-agent");
  });

  test("a retry answering 429 is the call's answer: no browser", async () => {
    site("sorryrate", at("/api/sorry?bare=429"));
    const r = await call("sorryrate", "from", {}, { minIntervalMs: 0, timeoutMs: 3000 });
    assert.equal(r.class, "rate", JSON.stringify(r));
    assert.equal(r.tier, 1);
    assert.match(r.reason ?? "", /^tier 1 said auth .*without the browser's identity headers: /);
    assert.equal(sent("/api/sorry").length, 2);
    assert.equal(rememberedTier("sorryrate", "from"), undefined);
  });

  test("a retry refused again leaves the ladder as it was: tier 1's auth and the login hint", async () => {
    site("sorryagain", at("/api/sorry?bare=419"));
    const r = await call("sorryagain", "from", {}, t1);
    assert.equal(r.class, "auth", JSON.stringify(r));
    assert.equal(r.tier, 1);
    assert.equal(r.reason, "HTTP 419: Sorry");
    assert.match(r.next ?? "", /api-anything login sorryagain/);
    assert.equal(sent("/api/sorry").length, 2);
  });
});

test("two processes writing state.json (tier memory, stale marks) lose nothing", async () => {
  const script = (tag: string) => `
    import { rememberTier } from ${JSON.stringify(join(ROOT, "src/store.ts"))};
    for (let i = 0; i < 150; i++) rememberTier("race", "${tag}" + i, 2);
  `;
  const run = (tag: string) =>
    new Promise<number>((resolve) => {
      const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script(tag)], {
        cwd: ROOT,
        env: { ...process.env, API_ANYTHING_HOME: HOME },
        stdio: "inherit",
      });
      p.on("close", (c) => resolve(c ?? -1));
    });
  assert.deepEqual(await Promise.all([run("a"), run("b")]), [0, 0]);
  const { readFileSync } = await import("node:fs");
  const n = Object.keys(JSON.parse(readFileSync(join(HOME, "state.json"), "utf8")).tier).length;
  assert.equal(n, 300, `state kept ${n} of 300 tier entries`);
});
