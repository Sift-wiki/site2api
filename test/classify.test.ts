import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, emptyResults, judge, type Observed } from "../src/classify.js";
import { type Operation, OperationSchema } from "../src/spec.js";

const op = (over: Record<string, unknown> = {}): Operation =>
  OperationSchema.parse({
    name: "getUser",
    request: { method: "GET", url: "https://x.com/i/api/graphql/ID/UserByScreenName?variables=%7B%7D", headers: {} },
    slots: [{ param: "screen_name", at: ["query:variables", "json:/screen_name"] }],
    trigger: { url: "https://x.com/{screen_name}" },
    params: [{ name: "screen_name" }],
    response: { format: "json", extract: "data.user" },
    readOnly: true,
    ...over,
  });

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Observed => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const html = (status: number, body: string): Observed => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8" },
  body,
});
const cls = (o: Operation, r: Observed) => classify(o, r).class;

test("a body nested past the parser's stack is error, and names the depth instead of quoting it", () => {
  const deep = "[".repeat(20_000) + "]".repeat(20_000);
  const reason = "response is not JSON: the body nests too deeply to parse";
  const judged = judge(op(), json(200, deep));
  assert.equal(judged.class, "error");
  assert.equal(judged.reason, reason);
  // the same body where the extract path would read it, and an op with no extract at all
  assert.equal(judge(op(), json(200, `{"data":${deep}}`)).reason, reason);
  assert.equal(judge(op({ response: { format: "json" } }), json(200, deep)).reason, reason);
  // a shallow body still reads as the shape it is
  assert.equal(judge(op(), json(200, { data: { user: { id: 1 } } })).class, "ok");
});

test("judge classifies raw JSON before projection and shares only its own call's data", () => {
  const operation = op({ response: { format: "json", extract: "data.user", pick: ["id", "name"] } });
  const first = judge(operation, json(200, '{"data":{"user":{"id":9007199254740993,"name":"first"}}}'));
  assert.deepEqual(first, { class: "ok", reason: "ok", data: { id: "9007199254740993", name: "first" } });
  assert.deepEqual(judge(operation, json(200, { data: { user: { id: 2, name: "second" } } })), {
    class: "ok",
    reason: "ok",
    data: { id: 2, name: "second" },
  });
  assert.equal(
    judge(operation, json(200, { data: { user: null }, errors: [{ message: "login_required" }] })).class,
    "auth",
  );
  assert.equal(judge(operation, json(200, { error: { status: "UNAVAILABLE" } })).class, "error");
  assert.equal(judge(operation, json(200, { data: { other: [] } })).class, "drift");
});

test("valid XSSI text is data rather than drift", () => {
  const operation = op({ response: { format: "json", xssiPrefix: "for (;;);", extract: "data.user" } });
  assert.deepEqual(judge(operation, json(200, 'for (;;);{"data":{"user":{"name":"for (;;);"}}}')), {
    class: "ok",
    reason: "ok",
    data: { name: "for (;;);" },
  });
});

test("an inherited object member never stands in for missing response data", () => {
  for (const extract of ["toString", "constructor", "__proto__"]) {
    const operation = op({ response: { format: "json", extract } });
    assert.equal(judge(operation, json(200, "{}")).class, "drift");
    assert.deepEqual(judge(operation, json(200, `{"${extract}":42}`)), { class: "ok", reason: "ok", data: 42 });
  }
});

test("judge resolves JSON-in-string targets per call and retains the selected RPC's status", () => {
  const operation = op({ response: { format: "json", extract: "[1][2].items", pick: ["id"] } });
  const response = (payload: string | null, status?: number) =>
    json(200, [
      ["wrb.fr", "other", null, null, null, [8]],
      ["wrb.fr", "target", payload, null, null, status === undefined ? null : [status]],
    ]);
  assert.deepEqual(judge(operation, response('{"items":[{"id":9007199254740993}]}')), {
    class: "ok",
    reason: "ok",
    data: [{ id: "9007199254740993" }],
  });
  assert.deepEqual(judge(operation, response('{"items":[{"id":2}]}')).data, [{ id: 2 }]);
  assert.deepEqual(judge(operation, response('{"items":null}')), { class: "ok", reason: "ok", data: null });
  assert.equal(judge(operation, response("{}")).class, "drift");
  assert.equal(judge(operation, response(null, 13)).server, true);
  assert.equal(judge(operation, json(200, [["wrb.fr", "other", null, null, null, [8]]])).class, "drift");
  assert.equal(judge(op(), json(200, { data: '{"user":null}', errors: [{ message: "rate limit" }] })).class, "rate");
});

test("ok: 2xx JSON with the extract path present", () => {
  assert.deepEqual(classify(op(), json(200, { data: { user: { name: "NASA" } } })), { class: "ok", reason: "ok" });
  assert.equal(
    cls(op({ response: { format: "json", xssiPrefix: ")]}'", extract: "a" } }), json(200, ')]}\'\n{"a":1}')),
    "ok",
  );
});

test("drift: 404 on templated API path, persisted-query errors, missing extract, shape change", () => {
  assert.equal(cls(op(), json(404, { message: "Query not found" })), "drift");
  assert.equal(cls(op(), json(200, { errors: [{ message: "PersistedQueryNotFound" }], data: null })), "drift");
  assert.equal(cls(op(), json(400, { errors: [{ message: "The following features cannot be null: x" }] })), "drift");
  assert.equal(cls(op(), json(200, { data: {} })), "drift");
  const shaped = op({
    response: {
      format: "json",
      shape: { a: "object", "a.b": "string", "a.c": "number", "a.d": "array", "a.e": "boolean" },
    },
  });
  assert.equal(cls(shaped, json(200, { a: { b: "x", c: 1, d: [], e: null } })), "ok");
  assert.equal(cls(shaped, json(200, { z: { y: 1 } })), "drift");
  assert.equal(
    cls(op(), html(200, "<!doctype html><title>x</title><div>app</div>")),
    "drift",
    "HTML where JSON expected",
  );
  assert.equal(cls(op(), json(200, "not json at all")), "drift");
});

test("404 with the param in the URL path is input (the entity does not exist)", () => {
  const byPath = op({ slots: [{ param: "screen_name", at: ["path:0"] }] });
  assert.equal(cls(byPath, json(404, {})), "input");
});

test("auth: 401, 403 with login markers, require_login, HTML login page, login redirect, GraphQL auth error", () => {
  assert.equal(cls(op(), json(401, { errors: [{ code: 32, message: "Could not authenticate you" }] })), "auth");
  assert.equal(cls(op(), json(403, { message: "login_required" })), "auth");
  assert.equal(
    cls(
      op(),
      json(401, { message: "Please wait a few minutes before you try again.", require_login: true, status: "fail" }),
    ),
    "auth",
    "Instagram require_login wins over the rate wording",
  );
  assert.equal(cls(op(), html(200, '<html><form><input type="password" name="pass"></form></html>')), "auth");
  assert.equal(
    cls(op(), { ...json(200, { data: { user: {} } }), url: "https://x.com/i/flow/login?redirect=1" }),
    "auth",
  );
  assert.equal(cls(op(), json(200, { errors: [{ message: "Bad guest token" }], data: null })), "auth");
});

test("rate: 429 and rate-limit wording on errors", () => {
  assert.equal(cls(op(), json(429, {})), "rate");
  assert.equal(cls(op(), json(420, { message: "Rate limit exceeded" })), "rate");
});

test("rate: any failure that names its wait in Retry-After; a 2xx with one is still its answer", () => {
  const rows: [Observed, string, number | undefined][] = [
    [json(503, "down for maintenance", { "retry-after": "120" }), "rate", 120_000],
    [json(403, { message: "locked" }, { "retry-after": "60" }), "rate", 60_000],
    [json(500, "boom", { "retry-after": "30" }), "rate", 30_000],
    [json(503, "down for maintenance"), "error", undefined],
    [json(429, {}, { "retry-after": "300" }), "rate", 300_000],
    [json(200, { data: { user: { id: 1 } } }, { "retry-after": "5" }), "ok", undefined],
    // Retry-After: 0 names no wait (Reddit's network block page), so the 403 is a block the next tier may pass
    [
      {
        ...html(403, "<p>blocked by network security.</p>"),
        headers: { "content-type": "text/html", "retry-after": "0" },
      },
      "blocked",
      undefined,
    ],
    [json(429, {}, { "retry-after": "0" }), "rate", 0],
  ];
  for (const [r, want, ms] of rows) {
    const c = classify(op(), r);
    assert.deepEqual([c.class, c.retryAfterMs], [want, ms], `${r.status} ${JSON.stringify(r.headers)}`);
  }
  // a wall that names a wait is still a wall
  const wall = html(503, "<html><head><title>Just a moment...</title></head><div id=cf-chl-x></div></html>");
  assert.equal(cls(op(), { ...wall, headers: { ...wall.headers, "retry-after": "10" } }), "blocked");
});

test("blocked: 451 is refused to this network or region, with or without a body", () => {
  for (const r of [json(451, { message: "Unavailable for legal reasons" }), json(451, "")]) {
    const c = classify(op(), r);
    assert.equal(c.class, "blocked");
    assert.match(c.reason, /^HTTP 451: not available from this network or region/);
    assert.equal(c.missing, undefined);
  }
});

test("blocked: vendor challenge pages even at 200, cf-mitigated, bare 403", () => {
  assert.equal(
    cls(
      op(),
      html(
        403,
        "<html><head><title>Just a moment...</title></head><script src=/cdn-cgi/challenge-platform/h/b/cf-chl-x></script></html>",
      ),
    ),
    "blocked",
  );
  assert.equal(
    cls(op(), html(200, '<html><script src="https://ct.captcha-delivery.com/c.js"></script></html>')),
    "blocked",
  );
  assert.equal(cls(op(), json(403, { url: "https://geo.captcha-delivery.com/captcha/?initialCid=x" })), "blocked");
  assert.equal(cls(op(), html(200, '<div id="px-captcha"></div>')), "blocked");
  assert.equal(cls(op(), html(200, "<html><title>Reddit - Prove your humanity</title></html>")), "blocked");
  assert.equal(
    cls(op(), html(403, "<H1>Access Denied</H1> Reference #18.1 https://errors.edgesuite.net/18.1")),
    "blocked",
  );
  assert.equal(cls(op(), { ...json(403, ""), headers: { "cf-mitigated": "challenge" } }), "blocked");
  assert.equal(cls(op(), json(403, "")), "blocked");
  const reason = classify(op(), html(200, "<html><title>Just a moment...</title></html>")).reason;
  assert.match(reason, /Cloudflare/);
});

test("a large legit HTML page that mentions recaptcha is not blocked", () => {
  const page = op({ response: { format: "html", html: { items: "tr.athing", fields: { t: "a" } } }, slots: [] });
  const body = `<html><script src="https://www.google.com/recaptcha/api.js"></script>${"<tr class=athing><td><a>x</a></td></tr>".repeat(3000)}</html>`;
  assert.equal(cls(page, html(200, body)), "ok");
  assert.equal(cls(page, html(200, "<html><p>nothing here</p></html>")), "drift");
});

test("a sign-in form that embeds a CAPTCHA widget is auth; a CAPTCHA page with no sign-in form is blocked", () => {
  const widget = `<script src="https://www.google.com/recaptcha/api.js" async defer></script><div class="g-recaptcha" data-sitekey="k"></div>`;
  const signIn = `<!doctype html><html><head><title>Sign in</title></head><body><form action="/session" method="post"><input name="username"><input type="password" name="password">${widget}<button>Sign in</button></form></body></html>`;
  const interstitial = `<!doctype html><html><head><title>One more step</title></head><body><form action="/verify" method="post">${widget}</form></body></html>`;
  const listed = op({ response: { format: "html", html: { items: "li.r", fields: { t: "" } } } });
  const write = op({ readOnly: false, response: { format: "json" } });
  // an interstitial's own markers win over any form on the page (a hidden or unrelated login form)
  const walled = `<!doctype html><html><head><title>One more step</title></head><body><script src="https://geo.captcha-delivery.com/captcha/"></script><form name="js_challenge"><input name="username"><input type="password" name="password"></form></body></html>`;
  // a script that rides on ordinary pages, named first, must not hide another vendor's interstitial
  const both = walled.replace(
    "<body>",
    '<body><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>',
  );
  assert.equal(cls(op(), html(403, both)), "blocked");
  // Kasada's headers ride on its sites' ordinary answers: a 403 sign-in form with them asks for a login
  assert.equal(
    cls(op(), { status: 403, headers: { "content-type": "text/html", "x-kpsdk-ct": "t" }, body: signIn }),
    "auth",
  );
  assert.equal(
    cls(op(), { status: 403, headers: { "content-type": "text/html", "x-kpsdk-ct": "t" }, body: walled }),
    "blocked",
  );
  for (const o of [op(), listed, write]) {
    for (const status of [200, 403]) {
      assert.equal(cls(o, html(status, signIn)), "auth", `${o.response.format} ${status}`);
      assert.equal(cls(o, html(status, interstitial)), "blocked", `${o.response.format} ${status}`);
      assert.equal(cls(o, html(status, walled)), "blocked", `walled ${o.response.format} ${status}`);
    }
  }
});

test("input: 400 naming a param; error: 5xx and unexplained GraphQL errors", () => {
  assert.equal(cls(op(), json(400, { error: "screen_name is invalid" })), "input");
  assert.equal(cls(op(), json(400, { error: "something odd" })), "error");
  assert.equal(cls(op(), json(503, "upstream")), "error");
  assert.equal(cls(op(), json(200, { errors: [{ message: "User has been suspended" }], data: null })), "error");
});

test("an error status in a 200 body is judged as the HTTP status it stands for, never as moved data", () => {
  // Google batchexecute (issue #21): the payload's place holds a gRPC status instead
  const rpc = op({ response: { format: "json", xssiPrefix: ")]}'", extract: "[0][0][2][1]" } });
  const status = (code: number) => json(200, `)]}'\n\n39\n[["wrb.fr",null,null,null,null,[${code}]]]\n`);
  assert.deepEqual(classify(rpc, status(13)), {
    class: "error",
    reason: `HTTP 200 carrying batchexecute error 13 (INTERNAL), judged as HTTP 500: )]}' 39 [["wrb.fr",null,null,null,null,[13]]]`,
    server: true,
  });
  assert.equal(cls(rpc, status(14)), "error");
  assert.equal(cls(rpc, status(8)), "rate");
  assert.equal(cls(rpc, status(16)), "auth");
  // NOT_FOUND is a 404: missing data, which the example args tell apart from drift
  assert.deepEqual([cls(rpc, status(5)), classify(rpc, status(5)).missing], ["drift", true]);
  // a bad request names no param: like missing data, the example args tell bad args (input) from drift
  assert.deepEqual([cls(rpc, status(3)), classify(rpc, status(3)).missing], ["drift", true]);
  // the status of the RPC the extract path reads, not of another one that failed first
  const two = op({ response: { format: "json", extract: "[1][2].data" } });
  const pair = JSON.stringify([
    ["wrb.fr", "other", null, null, null, [8]],
    ["wrb.fr", "target", null, null, null, [13]],
  ]);
  assert.equal(cls(two, json(200, pair)), "error");
  // the target RPC is absent: another one's status is not its answer, so the data is missing
  assert.equal(cls(two, json(200, JSON.stringify([["wrb.fr", "other", null, null, null, [8]]]))), "drift");
  // a second RPC's failure does not undo the data the extract path finds
  const mixed = `)]}'\n\n9\n[["wrb.fr",null,"[0,[\\"a\\"]]"],["wrb.fr",null,null,null,null,[13]]]\n`;
  assert.equal(cls(rpc, json(200, mixed)), "ok");

  // {"error": {...}} with a gRPC status or an HTTP code, and JSON-RPC
  assert.equal(cls(op(), json(200, { error: { code: 503, message: "backend", status: "UNAVAILABLE" } })), "error");
  assert.equal(cls(op(), json(200, { error: { code: 429, message: "slow down" } })), "rate");
  assert.equal(cls(op(), json(200, { error: { code: 401, message: "who are you" } })), "auth");
  assert.equal(cls(op(), json(200, { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "oops" } })), "error");
  assert.equal(cls(op(), json(200, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no method" } })), "drift");
  // an app's own error code is not a status: the missing data decides, as before
  assert.equal(cls(op(), json(200, { error: { code: 190, message: "token expired" } })), "drift");
  // without an extract path the body is the answer, so its error is too; data next to an error field is fine
  const whole = op({ response: { format: "json" } });
  assert.equal(cls(whole, json(200, { error: { status: "INTERNAL" } })), "error");
  assert.equal(cls(op(), json(200, { data: { user: { name: "x" } }, error: { code: 500 } })), "ok");
  // data whose shape changed is drift, whatever error member sits next to it
  const shaped = op({
    response: {
      format: "json",
      extract: "data",
      shape: { data: "object", "data.a": "string", "data.b": "number", "data.c": "array", "data.d": "string" },
    },
  });
  assert.equal(cls(shaped, json(200, { data: { newField: 42 }, error: { status: "INTERNAL" } })), "drift");
  // a null target next to an error is the error, not a successful null; a plain null is still ok
  const nullable = op({ response: { format: "json", extract: "data" } });
  assert.equal(cls(nullable, json(200, { data: null, error: { code: 503, status: "UNAVAILABLE" } })), "error");
  assert.equal(cls(nullable, json(200, { data: null })), "ok");
  // only gRPC's own names count: an inherited property name is no status
  assert.equal(cls(op(), json(200, { error: { status: "toString" } })), "drift");
  // a server failure, at the status line or in the body, says so: nothing is learned about the request
  assert.equal(classify(rpc, status(13)).server, true);
  assert.equal(classify(op(), json(502, "bad gateway")).server, true);
  assert.equal(classify(rpc, status(3)).server, undefined);
  // a write's 200 that carries one was refused, not done
  assert.equal(cls(op({ readOnly: false, response: { format: "json" } }), status(3)), "error");
});

test("embedded: missing data is drift, present is ok", () => {
  const emb = op({ response: { format: "embedded", embedded: { regex: "data:(\\[)" } } });
  assert.equal(cls(emb, html(200, "<script>x({data:[1,2]})</script>")), "ok");
  assert.equal(cls(emb, html(200, "<script>nothing</script>")), "drift");
});

test("auth and rate signals win over drift when the data is gone (X code 215, Instagram 200 JSON, csrf 403)", () => {
  assert.equal(cls(op(), json(400, { errors: [{ message: "Bad Authentication data", code: 215 }] })), "auth");
  assert.equal(
    cls(
      op(),
      json(403, { errors: [{ code: 353, message: "This request requires a matching csrf cookie and header." }] }),
    ),
    "auth",
  );
  assert.equal(cls(op(), json(200, { message: "login_required", require_login: true, status: "fail" })), "auth");
  assert.equal(
    cls(
      op(),
      json(200, { message: "Please wait a few minutes before you try again.", require_login: false, status: "fail" }),
    ),
    "rate",
  );
  assert.equal(cls(op(), json(200, { errors: [{ message: "Rate limit exceeded" }], data: {} })), "rate");
  assert.equal(
    cls(op(), json(200, { data: { user: { bio: "I rate limit my coffee" } } })),
    "ok",
    "wording alone does not matter when the data is there",
  );
});

test("login wording on 400, 403 and 422 is auth; a 422 validation error or form page is not", () => {
  for (const status of [400, 403, 422]) {
    assert.equal(cls(op(), json(status, { message: "Bad Authentication data" })), "auth", `HTTP ${status}`);
    // a rotated public key (Algolia's answer): the credential is refused, not a bot wall
    const key = { message: "Invalid Application-ID or API key", status };
    assert.equal(cls(op(), json(status, key)), "auth", `HTTP ${status}`);
  }
  assert.equal(cls(op(), json(403, { error: "API key expired" })), "auth");
  assert.equal(cls(op(), json(422, { errors: { email: ["is invalid"] } })), "error");
  assert.equal(cls(op(), json(422, { error: "screen_name is invalid" })), "error");
  // a signup's "username taken" page shows a password field; only the wording counts
  const taken =
    '<form action="/users"><p>Username has already been taken</p><input name="username"><input type="password" name="pw"></form>';
  assert.equal(cls(op({ readOnly: false }), html(422, taken)), "error");
});

test("missing data is drift flagged missing, so the caller can check the example args first", () => {
  assert.deepEqual(classify(op(), json(200, { data: {} })), {
    class: "drift",
    reason: 'extract path "data.user" missing',
    missing: true,
  });
  // a read's 404 on a query-param API may be "no such user": the example args tell (edge EC-09)
  assert.equal(
    classify(op(), json(404, "")).missing,
    true,
    "a read's 404 on a templated API path is checked against the examples",
  );
  assert.equal(classify(op({ readOnly: false }), json(404, "")).missing, undefined, "a write's 404 is plain drift");
  // Next.js /_next/data/<buildId>/u/<name>.json: 404 after a deploy is not "no such user"
  const next = op({
    slots: [{ param: "screen_name", at: ["path:4"], template: "{screen_name}.json" }],
    volatile: [{ at: ["path:2"], shape: { charset: "base64url", length: 21 }, anchor: "u" }],
  });
  assert.deepEqual(classify(next, html(404, "<html>404</html>")), {
    class: "drift",
    reason: "HTTP 404",
    missing: true,
  });
});

test("a write's 2xx is ok whatever the body; judge hands back the text; a bad recipe is an error, not a throw", async () => {
  const { judge } = await import("../src/classify.js");
  const write = op({ readOnly: false, response: { format: "json" } });
  for (const r of [
    json(204, ""),
    html(200, "<html><body>Liked!</body></html>"),
    { status: 200, headers: {}, body: "OK" },
  ]) {
    assert.equal(cls(write, r), "ok", r.body);
  }
  assert.deepEqual(judge(write, { status: 200, headers: {}, body: "OK" }), {
    class: "ok",
    reason: "HTTP 200, non-JSON body",
    data: "OK",
  });
  // the write ran; a landing page with a change-password form is not a login wall (edge EC-05)
  assert.equal(cls(write, html(200, '<form><input type="password"></form>')), "ok");
  assert.equal(cls(write, json(200, { errors: [{ message: "denied" }], data: null })), "error");
  const bad = op({ response: { format: "html", html: { items: "li[", fields: {} } } });
  assert.equal(judge(bad, html(200, "<li>x</li>")).class, "error");
});

test("a logged-out page that only links a sign-in page (Google's ServiceLogin button) is not auth; a sign-in form or a ServiceLogin redirect is", () => {
  const link = `<html><body><a href="https://accounts.google.com/ServiceLogin?hl=en">Sign in</a><div>Explore destinations</div></body></html>`;
  const embedded = op({
    request: { method: "GET", url: "https://www.google.com/travel/flights?q=x", headers: {} },
    response: { format: "embedded", embedded: { regex: "key: 'ds:1'[^[]*data:(\\[)" } },
  });
  const listed = op({
    request: { method: "GET", url: "https://s.test/search?q=x", headers: {} },
    response: { format: "html", html: { items: "li.r", fields: { t: "" } } },
  });
  for (const o of [embedded, listed]) {
    const c = classify(o, html(200, link));
    assert.equal(c.class, "drift", c.reason);
    assert.equal(c.missing, true);
    const form = `<html><form action="/signin"><input name="email"><input type="password" name="pw"></form></html>`;
    assert.equal(cls(o, html(200, form)), "auth");
    assert.equal(cls(o, { ...html(200, link), url: "https://accounts.google.com/ServiceLogin?continue=x" }), "auth");
    assert.equal(cls(o, html(200, "<html><p>Please sign in to continue</p></html>")), "auth");
  }
});

test("an extract ending in [*] returns the items: the learned shape is compared per item", () => {
  const items = op({
    response: {
      format: "json",
      extract: "[*]",
      shape: { "[]": "object", "[].id": "string", "[].title": "string", "[].rating": "string", "[].count": "number" },
    },
  });
  assert.equal(
    cls(
      items,
      json(200, [
        { id: "1", title: "Dune", rating: "4.29", count: 10 },
        { id: "2", title: "Emma", rating: "4.0", count: 3 },
      ]),
    ),
    "ok",
  );
  assert.equal(cls(items, json(200, [{ other: 1 }, { other: 2 }])), "drift");
  const nested = op({
    response: {
      format: "json",
      extract: "results[*]",
      shape: {
        results: "array",
        "results[]": "object",
        "results[].a": "string",
        "results[].b": "number",
        "results[].c": "boolean",
      },
    },
  });
  assert.equal(cls(nested, json(200, { results: [{ a: "x", b: 1, c: true }] })), "ok");
});

test("blocked: an Anubis proof-of-work page, even at 200 and on an html op whose items it lacks", () => {
  const page = `<!doctype html><html><head><title>Making sure you&#39;re not a bot!</title>
<script id="anubis-main" defer type="module" src="/.within.website/x/cmd/anubis/static/js/main.mjs"></script></head>
<body><p>Anubis is a compromise.</p></body></html>`;
  const htmlOp = op({ response: { format: "html", html: { items: "li.story", fields: { title: "a" } } } });
  assert.equal(cls(htmlOp, html(200, page)), "blocked");
  assert.equal(cls(htmlOp, html(200, "<title>Making sure you're not a bot!</title>")), "blocked");
});

test("a write's 2xx whose body says it was refused is not ok, and says so; an empty error field is no refusal", () => {
  const write = op({ readOnly: false, response: { format: "json" } });
  for (const body of [
    { data: { createPost: { post: null, userErrors: [{ field: ["title"], message: "Title can't be blank" }] } } },
    { data: { records: { save: { result: { userErrors: [{ message: "taken" }] } } } } },
    { status: "error" },
    { status: "fail", data: { title: "A title is required" } },
    { error: "Message too long" },
    { errors: { title: ["can't be blank"] } },
    { success: true, errors: [{ message: "Message too long" }] },
    { data: { createPost: null }, errors: [{ message: "Message too long" }] },
    { result: { ok: false } },
    { data: { save: { success: false } } },
    { status: 422, message: "Unprocessable" },
    { meta: { statusCode: 400 } },
    { hasError: true },
    { validationErrors: ["title"] },
  ]) {
    const c = classify(write, json(200, body));
    assert.notEqual(c.class, "ok", JSON.stringify(body));
    assert.equal(c.rejected, true, JSON.stringify(body));
  }
  // its wording still names the class: a write refused for a lost session or a limit
  assert.equal(cls(write, json(200, { error: "You are not logged in" })), "auth");
  assert.equal(cls(write, json(200, { status: "error", error: "Rate limit exceeded" })), "rate");
  // GraphQL with no data at all is a request error: by the spec nothing ran
  assert.match(classify(write, json(200, { errors: [{ message: "Message too long" }] })).reason, /nothing ran/);
  // errors next to a payload that is there: the write may have partly run, which is no clear refusal
  const partly = classify(write, json(200, { data: { createPost: { id: 1 } }, errors: [{ message: "x" }] }));
  assert.equal(partly.class, "error");
  assert.equal(partly.rejected, undefined);
  // a server failure in the body is as ambiguous as a 5xx
  assert.equal(classify(write, json(200, { status: 503 })).rejected, undefined);
  for (const body of [
    { ok: true },
    { error: null, data: { id: 1 } },
    { errors: [] },
    { error: "" },
    { errorCode: 0, errorMessage: "none" },
    { data: { createPost: { post: { id: 1 }, userErrors: [] } } },
    { status: "queued", id: "job-1" },
    { status: "pending" },
    { status: "success" },
    { status: 200 },
    { message: "Error report sent. Thanks!" },
    { notifyOnError: true, id: 1 },
    { data: { job: { id: 1, state: "failed" } } },
    { data: { a: { b: { c: { d: { error: "a stored value five levels down" } } } } } },
  ]) {
    assert.equal(cls(write, json(200, body)), "ok", JSON.stringify(body));
  }
  // 201 with a Location is a created resource, whatever its body names
  assert.equal(cls(write, json(201, { errors: ["imported with warnings"] }, { location: "/posts/9" })), "ok");
  // a read's data may carry an error field of its own (a job's, a payment's): reads are judged as before
  assert.equal(cls(op({ response: { format: "json" } }), json(200, { status: "error", error: "timeout" })), "ok");
});

test("a write redirected back to its form with an error, or answered by its form showing errors, is not ok", () => {
  const write = op({
    readOnly: false,
    request: { method: "POST", url: "https://s.test/posts", headers: {} },
    slots: [],
    params: [],
    trigger: { url: "https://s.test/posts/new" },
    response: { format: "json" },
  });
  const page = (body: string, url: string, redirected = true): Observed => ({
    ...html(200, `<html><body><form action="/posts">${body}<input name="title"></form></body></html>`),
    url,
    redirected,
  });
  const errorlist = '<ul class="errorlist"><li>Title can\'t be blank</li></ul>';
  // Post/Redirect/Get back to the form: it may or may not have run, so no clear refusal
  for (const r of [
    page("", "https://s.test/posts/new?error=title_blank"),
    page("", "https://s.test/posts/new#status=failed"),
    page(errorlist, "https://s.test/posts/new"),
    page('<div class="alert alert-danger">Could not save: title is required</div>', "https://s.test/posts/new"),
  ]) {
    const c = classify(write, r);
    assert.equal(c.class, "error", r.url ?? "");
    assert.equal(c.rejected, undefined, r.url ?? "");
  }
  // the form itself answered with its errors: nothing ran
  const rendered = classify(write, page(errorlist, "https://s.test/posts", false));
  assert.equal(rendered.class, "error");
  assert.equal(rendered.rejected, true);
  // back on the form with nothing wrong, on another page, or an error word in the request's own URL: done
  assert.equal(cls(write, page("", "https://s.test/posts/new")), "ok");
  assert.equal(
    cls(write, page('<div class="alert alert-danger">Maintenance tonight</div>', "https://s.test/posts/new")),
    "ok",
  );
  assert.equal(cls(write, page('<ul class="errorlist"><li>Required</li></ul>', "https://s.test/posts/9")), "ok");
  assert.equal(cls(write, page("", "https://s.test/posts?kind=error", false)), "ok");
  // a hidden template for client-side checks is not a shown error
  assert.equal(
    cls(write, page('<ul class="errorlist" hidden><li>Required</li></ul>', "https://s.test/posts/new")),
    "ok",
  );
  // a templated form page matches by its path's shape
  const templated = op({ ...write, trigger: { url: "https://s.test/t/{board}/new" } });
  assert.equal(cls(templated, page(errorlist, "https://s.test/t/cats/new")), "error");
});

test("a list the pick empties is missing data, not 'no results'; html items with none of their fields too", () => {
  const picked = op({ response: { format: "json", extract: "data.items", pick: ["id", "title"] } });
  const renamed = judge(
    picked,
    json(200, {
      data: {
        items: [
          { uid: 1, name: "a" },
          { uid: 2, name: "b" },
        ],
      },
    }),
  );
  assert.equal(renamed.class, "drift");
  assert.equal(renamed.missing, true);
  assert.match(renamed.reason, /pick/);
  assert.deepEqual(judge(picked, json(200, { data: { items: [] } })), { class: "ok", reason: "no results", data: [] });
  // an item with none of the fields next to one with them is dropped, as before
  assert.deepEqual(judge(picked, json(200, { data: { items: [{ id: 1 }, { ad: true }] } })).data, [{ id: 1 }]);
  // a write ran whatever its answer's pick finds
  const write = op({ readOnly: false, response: { format: "json", extract: "items", pick: ["id"] } });
  assert.equal(cls(write, json(200, { items: [{ uid: 1 }] })), "ok");

  const listed = op({ response: { format: "html", html: { items: "ul.r li", fields: { t: ".title", u: "a@href" } } } });
  const items = (inner: string) =>
    html(200, `<html><body><ul class="r"><li>${inner}</li><li>${inner}</li></ul></body></html>`);
  assert.equal(cls(listed, items('<span class="title">Dune</span><a href="/d">x</a>')), "ok");
  assert.equal(cls(listed, items('<span class="title">Dune</span>')), "ok");
  const gone = classify(listed, items('<span class="name">Dune</span><b>no link</b>'));
  assert.deepEqual([gone.class, gone.missing], ["drift", true]);
  assert.match(gone.reason, /none of their fields/);
  // an empty "all:" list or empty text is no field found either
  const tags = op({
    response: { format: "html", html: { items: "ul.r li", fields: { tags: "all:.tag", t: ".title" } } },
  });
  assert.equal(cls(tags, items('<span class="title"> </span>')), "drift");

  const embedded = op({ response: { format: "embedded", embedded: { regex: "data:(\\[)" }, pick: ["id"] } });
  assert.equal(cls(embedded, html(200, '<script>x({data:[{"id":1}]})</script>')), "ok");
  assert.equal(cls(embedded, html(200, '<script>x({data:[{"uid":1}]})</script>')), "drift");
  assert.equal(cls(embedded, html(200, "<script>x({data:[]})</script>")), "ok");
});

test("an html recipe's empty selector: a no-results page with no list container answers [] when that element is shown", () => {
  const recipe = { items: "ul.r li", fields: { t: ".title" } };
  const message = html(200, '<html><body><h1>Search</h1><p class="none">No results</p></body></html>');
  // without it, a page with neither list nor container is a selector that matched nothing
  const bare = classify(op({ response: { format: "html", html: recipe } }), message);
  assert.deepEqual([bare.class, bare.missing], ["drift", true]);
  assert.match(bare.reason, /matched nothing/);
  const told = op({ response: { format: "html", html: { ...recipe, empty: "p.none" } } });
  assert.deepEqual(judge(told, message), { class: "ok", reason: "no results", data: [] });
  // the message must be shown: one the page keeps hidden under a missing list says nothing
  assert.equal(cls(told, html(200, '<html><body><p class="none" hidden>No results</p></body></html>')), "drift");
  assert.equal(cls(told, html(200, '<html><body><p class="other">Moved</p></body></html>')), "drift");
  // items on the page win over the message; a sign-in page is auth whatever it also shows
  const rows = html(
    200,
    '<html><body><ul class="r"><li><span class="title">Dune</span></li></ul><p class="none"></p></body></html>',
  );
  assert.deepEqual(judge(told, rows).data, [{ t: "Dune" }]);
  assert.deepEqual(emptyResults(message.body, { ...recipe, empty: "p.none" }), '"p.none" is on the page');
  assert.equal(emptyResults(message.body, recipe), undefined);
  assert.match(emptyResults('<ul class="r"></ul>', recipe)!, /container of "ul.r li" is on the page and empty/);
});

test("paging reads the next cursor from the whole answer, past extract and pick; a pick-emptied page is drift with none", () => {
  const paged = op({
    response: { format: "json", extract: "data.edges", pick: ["id"] },
    paging: { param: "screen_name", next: "data.pageInfo.next" },
  });
  const page = (edges: unknown[]) => json(200, { data: { edges, pageInfo: { next: "c2" } } });
  const ok = judge(paged, page([{ id: 1, text: "a" }]));
  assert.deepEqual([ok.class, ok.data, ok.nextPage, ok.hasMore], ["ok", [{ id: 1 }], "c2", true]);
  // the site renamed the picked field: no page to go on from, so no cursor to page past it with
  const renamed = judge(paged, page([{ identifier: 1 }]));
  assert.deepEqual([renamed.class, renamed.nextPage, renamed.hasMore], ["drift", undefined, undefined]);
});

test("a signed-in JSON read redirected to a same-site page with no login or challenge is unfinished, not drift", () => {
  const me = op({
    request: { method: "GET", url: "https://www.s.test/api/me", headers: {} },
    slots: [],
    params: [],
    learnedLoggedIn: true,
    response: { format: "json", extract: "data" },
  });
  const consent =
    "<html><body><h1>Before you continue</h1><form action='/save'><button>Accept all</button></form></body></html>";
  const at = (url: string, redirected = true): Observed => ({ ...html(200, consent), url, redirected });
  const c = classify(me, at("https://consent.s.test/terms?continue=%2Fapi%2Fme"));
  assert.equal(c.class, "error");
  assert.equal(c.unfinished, "https://consent.s.test/terms?continue=%2Fapi%2Fme");
  assert.match(c.reason, /consent\.s\.test\/terms/);
  // an SPA's shell at the old path, with no redirect, is real drift
  assert.equal(cls(me, at("https://www.s.test/api/me", false)), "drift");
  // another site, or an op that holds no credential and was learned signed out: drift as before
  assert.equal(cls(me, at("https://consent.other.test/terms")), "drift");
  assert.equal(cls(op({ ...me, learnedLoggedIn: false }), at("https://www.s.test/terms")), "drift");
  const ref = op({ ...me, learnedLoggedIn: false, slots: [{ at: ["header:authorization"], ref: "session:token" }] });
  assert.equal(cls(ref, at("https://www.s.test/terms")), "error");
  // a sign-in page or a challenge keeps its own class
  const signIn = '<html><form action="/session"><input name="email"><input type="password" name="pw"></form></html>';
  assert.equal(cls(me, { ...html(200, signIn), url: "https://www.s.test/verify", redirected: true }), "auth");
  assert.equal(
    cls(me, { ...html(200, "<title>Just a moment...</title>"), url: "https://www.s.test/x", redirected: true }),
    "blocked",
  );
});
