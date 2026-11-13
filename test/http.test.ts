import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import * as zlib from "node:zlib";
import {
  BodyTooLarge,
  buildRequest,
  MAX_BODY_BYTES,
  nextHop,
  privateAddress,
  publicAddress,
  ReadWrites,
  resolver,
  send,
} from "../src/http.js";
import type { Session } from "../src/session.js";
import { type Operation, OperationSchema } from "../src/spec.js";
import type { StoredCookie } from "../src/types.js";

// the send slots (pace.json) live in the home
const HOME = mkdtempSync(join(tmpdir(), "api-anything-http-"));
process.env.API_ANYTHING_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

const cookie = (name: string, value: string, domain: string): StoredCookie => ({
  name,
  value,
  domain,
  path: "/",
  expires: -1,
  httpOnly: false,
  secure: false,
});

const op = (over: Record<string, unknown> = {}): Operation =>
  OperationSchema.parse({
    name: "reply",
    request: {
      method: "post",
      url: "https://x.com/i/api/graphql/ID/CreateTweet",
      headers: { "content-type": "application/json", "x-csrf-token": "", authorization: "", "csrf-token": "" },
      body: '{"variables":{"tweet_text":"hi","reply":{"in_reply_to_tweet_id":"1"},"count":20,"dark":false},"queryId":"ID"}',
    },
    slots: [
      { param: "text", at: ["body", "json:/variables/tweet_text"] },
      { param: "tweet_id", at: ["body", "json:/variables/reply/in_reply_to_tweet_id"] },
      { param: "count", at: ["body", "json:/variables/count"] },
      { param: "dark", at: ["body", "json:/variables/dark"] },
      { ref: "cookie:ct0", at: ["header:x-csrf-token"] },
      { ref: "cookie:JSESSIONID", transform: "strip-quotes", at: ["header:csrf-token"] },
      { ref: "session:authorization", at: ["header:authorization"] },
    ],
    params: [
      { name: "text" },
      { name: "tweet_id" },
      { name: "count", type: "number", default: 20 },
      { name: "dark", type: "boolean", required: false },
    ],
    trigger: { url: "https://x.com/compose" },
    readOnly: false,
    ...over,
  });

const session: Session = {
  cookies: [
    cookie("ct0", "csrf123", ".x.com"),
    cookie("JSESSIONID", '"ajax:42"', ".x.com"),
    cookie("elsewhere", "no", ".other.com"),
  ],
  values: { authorization: "Bearer PUBLIC" },
};

test("buildRequest fills params with native types, refs with transforms, and scopes cookies", () => {
  const req = buildRequest(
    op(),
    { text: 'He said "hi"', tweet_id: "2085462611575857621", count: "1234567890123456789", dark: "false" },
    session,
  );
  assert.equal(req.method, "POST");
  assert.equal(
    req.body,
    '{"variables":{"tweet_text":"He said \\"hi\\"","reply":{"in_reply_to_tweet_id":"2085462611575857621"},"count":1234567890123456789,"dark":false},"queryId":"ID"}',
  );
  assert.equal(req.headers["x-csrf-token"], "csrf123");
  assert.equal(req.headers["csrf-token"], "ajax:42");
  assert.equal(req.headers.authorization, "Bearer PUBLIC");
  assert.equal(req.headers.cookie, 'ct0=csrf123; JSESSIONID="ajax:42"');
});

test("buildRequest: defaults, missing required params, bad types, missing session values drop the header", () => {
  const req = buildRequest(op(), { text: "a", tweet_id: "5" }, { cookies: [], values: {} });
  assert.match(req.body!, /"count":20,"dark":false/);
  assert.equal("authorization" in req.headers, false);
  assert.equal("x-csrf-token" in req.headers, false);
  assert.equal(req.headers.cookie, undefined);
  assert.throws(() => buildRequest(op(), { text: "a" }, session), /missing required param "tweet_id"/);
  assert.throws(() => buildRequest(op(), { text: "a", tweet_id: "1", dark: "yes" }, session), /must be boolean/);
});

test("buildRequest: an arg outside the param's enum or min/max is refused, so nothing is sent", () => {
  const limited = op({
    params: [
      { name: "text", enum: ["hello", "goodbye"] },
      { name: "tweet_id", min: 1, max: 1000 },
      { name: "count", type: "number", default: 20, min: 1, max: 50 },
      { name: "dark", type: "boolean", required: false },
    ],
  });
  const ok = buildRequest(limited, { text: "goodbye", tweet_id: "1000", count: 1 }, session);
  assert.match(ok.body!, /"tweet_text":"goodbye".*"in_reply_to_tweet_id":"1000".*"count":1,/);
  assert.throws(
    () => buildRequest(limited, { text: "hi", tweet_id: "5" }, session),
    /param "text" must be one of "hello", "goodbye", got "hi"/,
  );
  assert.throws(
    () => buildRequest(limited, { text: "hello", tweet_id: "1001" }, session),
    /param "tweet_id" must be at most 1000, got "1001"/,
  );
  assert.throws(
    () => buildRequest(limited, { text: "hello", tweet_id: "abc" }, session),
    /param "tweet_id" must be a number from 1 to 1000, got "abc"/,
  );
  assert.throws(
    () => buildRequest(limited, { text: "hello", tweet_id: "5", count: 0 }, session),
    /param "count" must be at least 1, got 0/,
  );
});

test("a read's filled request is never a GraphQL mutation", () => {
  // the document is a param: the stored `{doc}` is no mutation, so the spec's rules cannot see what an arg makes it
  const viewer = (over: Record<string, unknown> = {}) =>
    OperationSchema.parse({
      name: "viewer",
      readOnly: true,
      request: {
        method: "POST",
        url: "https://www.example.com/api/gql",
        headers: { "content-type": "application/json" },
        body: '{"query":"{doc}"}',
      },
      slots: [{ param: "doc", at: ["body", "json:/query"] }],
      params: [
        {
          name: "doc",
          required: false,
          default: "mutation { closeAccount(confirm: true) { ok } }",
          example: "{ viewer { id } }",
        },
      ],
      trigger: { url: "https://www.example.com/me" },
      response: { extract: "data" },
      ...over,
    });
  const none: Session = { cookies: [], values: {} };
  // the default, an arg, a subscription, and a mutation after a query
  assert.throws(() => buildRequest(viewer(), {}, none), ReadWrites);
  assert.throws(() => buildRequest(viewer(), {}, none), /viewer is a read.*GraphQL mutation.*nothing was sent/);
  assert.throws(() => buildRequest(viewer(), { doc: "subscription { inbox { id } }" }, none), ReadWrites);
  assert.throws(() => buildRequest(viewer(), { doc: "{ me { id } } mutation M { drop { ok } }" }, none), ReadWrites);
  // a query, and a query named mutation, still go
  assert.equal(buildRequest(viewer(), { doc: "{ viewer { id } }" }, none).body, '{"query":"{ viewer { id } }"}');
  assert.match(buildRequest(viewer(), { doc: "query mutation { a }" }, none).body ?? "", /query mutation/);
  // a write is what allowWrites gates: its mutation builds
  assert.match(buildRequest(viewer({ readOnly: false }), {}, none).body ?? "", /closeAccount/);
  // a slot template around the arg, and a document in the URL's query, are tested alike
  const templated = viewer({
    slots: [{ param: "doc", at: ["body", "json:/query"], template: "mutation { {doc} }" }],
    params: [{ name: "doc", example: "x" }],
  });
  assert.throws(() => buildRequest(templated, { doc: "drop { ok }" }, none), ReadWrites);
  const inUrl = viewer({
    request: { method: "GET", url: "https://www.example.com/api/gql?query=x", headers: {} },
    slots: [{ param: "doc", at: ["query:query"] }],
  });
  assert.throws(() => buildRequest(inUrl, {}, none), ReadWrites);
  assert.match(buildRequest(inUrl, { doc: "tea" }, none).url, /query=tea/);
});

test("search text refused as a mutation says what happened and what to do; the word alone is no mutation", () => {
  const search = (over: Record<string, unknown> = {}) =>
    OperationSchema.parse({
      name: "search",
      readOnly: true,
      request: { method: "GET", url: "https://www.example.com/api/search?query=x", headers: {} },
      slots: [{ param: "q", at: ["query:query"] }],
      params: [{ name: "q" }],
      trigger: { url: "https://www.example.com/search" },
      ...over,
    });
  const none: Session = { cookies: [], values: {} };
  const sent = (q: string, op = search()) => new URL(buildRequest(op, { q }, none).url).searchParams.get("query");
  // an operation's shape (the keyword first, an optional name and variables, then `{`) is refused, search text or not
  for (const q of [
    "mutation { addTodo }",
    "# how to\n  mutation AddTodo($t: String!) { addTodo(title: $t) { id } }",
    "subscription{inbox{id}}",
    // what the grammar lets stand between the keyword and the selection: variables, directives, commas, comments
    'mutation($t: String = "{") { addTodo(title: $t) { id } }',
    "mutation @live { addTodo }",
    "mutation AddTodo @live(if: true) { addTodo }",
    "mutation # the name follows\n AddTodo\n{ addTodo }",
    "mutation,AddTodo,{addTodo}",
    "\ufeffmutation\ufeff{addTodo}",
    "{ me { id } } subscription Inbox { inbox { id } }",
  ])
    assert.throws(
      () => sent(q),
      (e: unknown) =>
        e instanceof ReadWrites &&
        /^search is a read, and with these args its filled request reads as a GraphQL mutation or subscription/.test(
          e.message,
        ) &&
        /a read never sends one: nothing was sent/.test(e.message) &&
        /If that was search text and not a document, rephrase it/.test(e.message) &&
        // the reason names no arg's value
        !e.message.includes("addTodo") &&
        !e.message.includes("inbox"),
      q,
    );
  // the words in ordinary text go as they are
  for (const q of [
    "mutation testing tools",
    "subscription box",
    "mutation",
    "what is a mutation { in genetics }",
    // an operation has one name at most: no GraphQL parser takes these as one
    "mutation testing tools {2024}",
    "subscription box deals { under 20 }",
    "mutation testing # tools\n frameworks {2024}",
    "best subscription (2024) {deals}",
    'the "mutation { x }" keyword',
    "query mutation { a }",
  ])
    assert.equal(sent(q), q);
  // and in a JSON body's query field
  const posted = search({
    request: {
      method: "POST",
      url: "https://www.example.com/api/search",
      headers: { "content-type": "application/json" },
      body: '{"query":"x","page":1}',
    },
    slots: [{ param: "q", at: ["body", "json:/query"] }],
  });
  assert.equal(
    buildRequest(posted, { q: "mutation testing tools" }, none).body,
    '{"query":"mutation testing tools","page":1}',
  );
  assert.throws(() => buildRequest(posted, { q: "mutation { addTodo }" }, none), /rephrase it/);
});

test("a session value goes only back to the host it was captured from; a cookie's fallback skips HttpOnly", () => {
  const bound: Session = { ...session, valueHosts: { authorization: "x.com" } };
  const to = (url: string, s = bound) =>
    buildRequest(op({ request: { ...op().request, url } }), { text: "a", tweet_id: "5" }, s);
  assert.equal(to("https://x.com/i/api/graphql/ID/CreateTweet").headers.authorization, "Bearer PUBLIC");
  // a spec that points the request elsewhere gets no value to send there, a sibling host of the site included
  assert.equal("authorization" in to("https://collect.example.com/x").headers, false);
  assert.equal("authorization" in to("https://upload.x.com/x").headers, false);
  // a value from before the binding is sent as it was (a pull drops those for the site it pulls)
  assert.equal(to("https://collect.example.com/x", session).headers.authorization, "Bearer PUBLIC");
  // the site fallback is for a cookie page script can read and echo: never an HttpOnly one
  const hostOnly = (httpOnly: boolean): Session => ({
    cookies: [{ ...cookie("ct0", "csrf123", "accounts.x.com"), httpOnly }],
    values: {},
  });
  assert.equal(to("https://upload.x.com/x", hostOnly(false)).headers["x-csrf-token"], "csrf123");
  assert.equal("x-csrf-token" in to("https://upload.x.com/x", hostOnly(true)).headers, false);
});

test("a number past 2^53 goes exactly as plain digits; a form that would be rounded is refused, saying why", () => {
  const sent = (count: string) =>
    /"count":([^,]+),/.exec(buildRequest(op(), { text: "a", tweet_id: "5", count }, session).body!)?.[1];
  assert.equal(sent("9007199254740993"), "9007199254740993");
  assert.equal(sent("1.5e3"), "1500");
  assert.equal(sent("-0.25"), "-0.25");
  for (const v of ["9007199254740993e0", "-9007199254740993e0", "9007199254740993.0", "1e400"]) {
    assert.throws(() => sent(v), /param "count" would lose precision: .* past 2\^53.* plain digits/, v);
  }
  // the boundary is decided on the digits: a hair past the limit rounds down to it in a double
  for (const v of ["9007199254740991.1", "90071992547409911e-1", "-9007199254740991.1", "9007199254740992e0"]) {
    assert.throws(() => sent(v), /would lose precision/, v);
  }
  // exactly at the limit, in any form, is sent as the limit
  for (const v of ["9007199254740991", "9007199254740991.0", "9007199254740991e0", "90071992547409910e-1"]) {
    assert.equal(sent(v), "9007199254740991", v);
  }
  assert.equal(sent("-9007199254740991"), "-9007199254740991");
  assert.equal(sent("1e-400"), "0");
  // a mantissa longer than any number is still judged by its value, not its length
  assert.equal(sent(`0.${"0".repeat(500)}1`), "0");
  assert.throws(() => sent(`1${"0".repeat(500)}e-401`), /would lose precision/);
});

test("template slots fill a substring of the leaf", () => {
  const search = OperationSchema.parse({
    name: "search",
    request: { method: "GET", url: "https://a.test/s?q=from%3Anasa%20lang%3Aen&n=1", headers: {} },
    slots: [{ param: "user", at: ["query:q"], template: "from:{user} lang:en" }],
    params: [{ name: "user" }],
    trigger: { url: "https://a.test/" },
    readOnly: true,
  });
  assert.equal(
    buildRequest(search, { user: "esa" }, { cookies: [], values: {} }).url,
    "https://a.test/s?q=from%3Aesa%20lang%3Aen&n=1",
  );
});

test("send: injectable fetch, returns status/headers/body/url/ms", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const r = await send(op(), { text: "a", tweet_id: "5" }, session, { site: "t1", fetchImpl, minIntervalMs: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.body, '{"ok":true}');
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(seen!.init.method, "POST");
  assert.equal((seen!.init.headers as Record<string, string>)["x-csrf-token"], "csrf123");
  assert.ok(r.ms >= 0);
});

test("send: a body past the cap is refused before it is buffered whole", async () => {
  const chunk = new Uint8Array(1024 * 1024); // 1 MiB, reused, so this test allocates one MiB
  const fetchImpl = (async () => {
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent++ * chunk.byteLength > MAX_BODY_BYTES) return controller.close();
        controller.enqueue(chunk);
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => send(op(), { text: "a", tweet_id: "5" }, session, { site: "cap", fetchImpl, minIntervalMs: 0 }),
    (e) => e instanceof BodyTooLarge && /over the 32 MiB cap/.test(e.message),
  );
});

test("send: a declared length past the cap is refused unread, and the body is cancelled", async () => {
  let cancelled = false;
  let pulled = 0;
  const fetchImpl = (async () => {
    const body = new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { "content-length": String(MAX_BODY_BYTES + 1) } });
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => send(op(), { text: "a", tweet_id: "5" }, session, { site: "cap", fetchImpl, minIntervalMs: 0 }),
    (e) => e instanceof BodyTooLarge && e.message.includes(`${MAX_BODY_BYTES + 1} bytes`),
  );
  assert.equal(cancelled, true);
  assert.ok(pulled <= 1, "nothing past the stream's own first fill was read");
});

test("send: a zstd body that decodes past the cap is refused, not inflated", {
  skip: !zlib.zstdCompressSync,
}, async () => {
  // 64 MiB of zeros compress to about 2 KB
  const bomb = zlib.zstdCompressSync(Buffer.alloc(2 * MAX_BODY_BYTES));
  assert.ok(bomb.byteLength < 64 * 1024);
  const fetchImpl = (async () =>
    new Response(bomb, { status: 200, headers: { "content-encoding": "zstd" } })) as unknown as typeof fetch;
  await assert.rejects(
    () => send(op(), { text: "a", tweet_id: "5" }, session, { site: "cap", fetchImpl, minIntervalMs: 0 }),
    (e) => e instanceof BodyTooLarge && /decode to over the 32 MiB cap/.test(e.message),
  );
  // under the cap, the body is decoded as before
  const small = zlib.zstdCompressSync(Buffer.from('{"ok":true}'));
  const r = await send(op(), { text: "a", tweet_id: "5" }, session, {
    site: "cap",
    fetchImpl: (async () =>
      new Response(small, { status: 200, headers: { "content-encoding": "zstd" } })) as unknown as typeof fetch,
    minIntervalMs: 0,
  });
  assert.equal(r.body, '{"ok":true}');
});

test("send against a local server: GET has no body, per-site pacing, timeout", async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/slow")) return void setTimeout(() => res.end("late"), 500);
    res.setHeader("content-type", "text/plain");
    res.end(`${req.method} ${req.url} ${req.headers.cookie ?? ""}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const get = OperationSchema.parse({
      name: "g",
      request: { method: "GET", url: `${base}/items?id=1`, headers: {} },
      slots: [{ param: "id", at: ["query:id"] }],
      params: [{ name: "id" }],
      trigger: { url: base },
      readOnly: true,
    });
    const local: Session = { cookies: [cookie("sid", "abc", "127.0.0.1")], values: {} };
    // pacing is measured where fetch is called, so server/network jitter can't flake it
    const calls: number[] = [];
    const timed = ((url: string, init: RequestInit) => {
      calls.push(Date.now());
      return fetch(url, init);
    }) as typeof fetch;
    const a = await send(get, { id: "123" }, local, { site: "pace", minIntervalMs: 150, fetchImpl: timed });
    const b = await send(get, { id: "456" }, local, { site: "pace", minIntervalMs: 150, fetchImpl: timed });
    assert.equal(a.body, "GET /items?id=123 sid=abc");
    assert.equal(b.body, "GET /items?id=456 sid=abc");
    // the interval ±30%: never an exact period
    assert.ok(calls[1]! - calls[0]! >= 104, `paced ${calls[1]! - calls[0]!} ms apart`);
    assert.equal(a.url, `${base}/items?id=123`);

    const slow = { ...get, request: { ...get.request, url: `${base}/slow?id=1` } };
    await assert.rejects(
      send(slow, { id: "1" }, local, { site: "slow", minIntervalMs: 0, timeoutMs: 50 }),
      /no response within 50 ms/,
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("send: a plain-http hop cannot replace, shadow or delete a Secure cookie", async () => {
  const feed = OperationSchema.parse({
    name: "feed",
    readOnly: true,
    request: { method: "GET", url: "https://www.shop.example/api/feed", headers: {} },
    trigger: { url: "https://www.shop.example/" },
  });
  const stored = (domain: string): Session => ({
    cookies: [
      { ...cookie("sid", "USER-SESSION", domain), secure: true, httpOnly: true },
      cookie("theme", "dark", ".shop.example"),
    ],
    values: {},
  });
  // https feed -> `middle`/landing, which sets the cookie -> https feed2
  const through = async (middle: string, setCookie: string, domain = ".shop.example") => {
    const cookies: (string | undefined)[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      cookies.push(new Headers(init?.headers).get("cookie") ?? undefined);
      if (url === "https://www.shop.example/api/feed")
        return new Response(null, { status: 302, headers: { location: `${middle}/landing` } });
      if (url === `${middle}/landing`)
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.shop.example/api/feed2", "set-cookie": setCookie },
        });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const sent = await send(feed, {}, stored(domain), { site: "shop", minIntervalMs: 0, fetchImpl });
    return { cookies, set: sent.setCookies };
  };
  const http = "http://old.shop.example";
  const kept = ["sid=USER-SESSION; theme=dark", "theme=dark", "sid=USER-SESSION; theme=dark"];
  // replace: the same name, domain and path
  let r = await through(http, "sid=PLANTED; Domain=shop.example; Path=/");
  assert.deepEqual(r.cookies, kept);
  assert.equal(r.set, undefined);
  // shadow: a longer path, or a domain above the host-only Secure cookie's, would be sent ahead of it
  r = await through(http, "sid=PLANTED; Domain=shop.example; Path=/api", "www.shop.example");
  assert.deepEqual(r.cookies, kept);
  assert.equal(r.set, undefined);
  // delete
  r = await through(http, "sid=gone; Domain=shop.example; Path=/; Max-Age=0");
  assert.deepEqual(r.cookies, kept);
  assert.equal(r.set, undefined);
  // nor may a plain-http answer set a Secure cookie, or a name that promises one
  for (const line of ["tok=PLANTED; Secure", "__Secure-tok=PLANTED", "__Host-tok=PLANTED; Path=/"]) {
    r = await through(http, `${line}; Domain=shop.example`);
    assert.deepEqual(r.cookies, kept, line);
    assert.equal(r.set, undefined, line);
  }
  // any other cookie of the http hop rides on, as before
  r = await through(http, "step=1; Domain=shop.example; Path=/");
  assert.deepEqual(r.cookies, ["sid=USER-SESSION; theme=dark", "theme=dark", "sid=USER-SESSION; theme=dark; step=1"]);
  assert.deepEqual(
    r.set?.map((c) => c.name),
    ["step"],
  );
  // and an https answer replaces a Secure cookie, with a non-Secure one too
  r = await through("https://old.shop.example", "sid=ROTATED; Domain=shop.example; Path=/");
  assert.deepEqual(r.cookies, [
    "sid=USER-SESSION; theme=dark",
    "sid=USER-SESSION; theme=dark",
    "theme=dark; sid=ROTATED",
  ]);
  assert.deepEqual(
    r.set?.map((c) => c.value),
    ["ROTATED"],
  );
});

test("send: a cross-origin redirect drops cookie-derived and session headers; same-origin keeps them", async () => {
  let seen: Record<string, unknown> = {};
  const other = createServer((req, res) => {
    seen = req.headers;
    res.setHeader("content-type", "application/json");
    res.end('{"landed":true}');
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/landing`;
  let sameHeaders: Record<string, unknown> = {};
  const site = createServer((req, res) => {
    if (req.url === "/away") return void res.writeHead(302, { location: otherUrl }).end();
    if (req.url === "/here") return void res.writeHead(307, { location: "/final" }).end();
    sameHeaders = req.headers;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((r) => site.listen(0, "localhost", r));
  const base = `http://localhost:${(site.address() as AddressInfo).port}`;
  const me = (path: string) =>
    OperationSchema.parse({
      name: "me",
      readOnly: true,
      request: { method: "GET", url: `${base}${path}`, headers: { "x-csrf-token": "", "x-keep": "1" } },
      slots: [{ ref: "cookie:ct0", at: ["header:x-csrf-token"] }],
      trigger: { url: base },
    });
  const local: Session = { cookies: [cookie("ct0", "SECRET-CSRF-COOKIE-VALUE", "localhost")], values: {} };
  try {
    const r = await send(me("/away"), {}, local, { site: "redir", minIntervalMs: 0 });
    assert.equal(r.body, '{"landed":true}');
    assert.equal(r.url, otherUrl);
    assert.equal(seen["x-csrf-token"], undefined);
    assert.equal(seen.cookie, undefined);
    assert.equal(seen["x-keep"], "1");
    await send(me("/here"), {}, local, { site: "redir", minIntervalMs: 0 });
    assert.equal(sameHeaders["x-csrf-token"], "SECRET-CSRF-COOKIE-VALUE");
    assert.equal(sameHeaders.cookie, "ct0=SECRET-CSRF-COOKIE-VALUE");
  } finally {
    for (const s of [site, other]) {
      s.closeAllConnections();
      s.close();
    }
  }
});

test("a redirect to another origin is refused when its Location repeats a header's value, however it is encoded", () => {
  const get = op({
    readOnly: true,
    request: { method: "get", url: "https://x.com/me", headers: { authorization: "" } },
  });
  // a space and a literal plus, a quote and a backslash: what form and JSON encoding each treat their own way
  const v = 'SECRET/a b+"c\\d-1234';
  const held: Session = { cookies: [], values: { authorization: v } };
  const from = { url: "https://x.com/me", method: "GET", headers: { authorization: v } };
  const enc = encodeURIComponent;
  const form = new URLSearchParams({ t: v }).toString().slice(2);
  const copies = [
    enc(v),
    enc(enc(v)),
    form,
    enc(JSON.stringify(v)),
    enc(JSON.stringify(v).replaceAll("/", "\\/")),
    // a return address inside a return address: three decodes deep, and a form-encoded one inside a percent-encoded one
    enc(`/a?next=${enc(`/b?t=${enc(v)}`)}`),
    enc(`/a?next=${enc(`/b?t=${form}`)}`),
    Buffer.from(v).toString("base64"),
    Buffer.from(v).toString("base64url"),
  ];
  for (const copy of copies)
    assert.throws(
      () => nextHop(get, held, from, 302, `https://evil.example/landing?t=${copy}`),
      /not following the HTTP 302 redirect to https:\/\/evil\.example: /,
      copy,
    );
  assert.equal(nextHop(get, held, from, 302, `/landing?t=${enc(v)}`).url, `https://x.com/landing?t=${enc(v)}`);
  assert.deepEqual(nextHop(get, held, from, 302, "https://evil.example/landing").headers, {});
});

test("privateAddress: this host, private, link-local, CGNAT, unique-local and reserved ranges, IPv4 inside IPv6 too", () => {
  for (const ip of [
    "0.0.0.0",
    "127.0.0.1",
    "127.8.9.10",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::10.0.0.1",
    "not an address",
  ])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of [
    "93.184.215.14",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "192.169.0.1",
    "2606:2800:220:1::1",
    "::ffff:93.184.215.14",
  ])
    assert.equal(privateAddress(ip), false, ip);
});

test("publicAddress: https to a public host whose every address is public", async () => {
  const lookup = resolver.lookup;
  try {
    resolver.lookup = async (host) =>
      host === "split.example.com"
        ? [{ address: "93.184.215.14" }, { address: "10.0.0.2" }]
        : host === "gone.example.com"
          ? Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }))
          : [{ address: "93.184.215.14" }];
    assert.equal(await publicAddress("https://www.example.com/x"), undefined);
    assert.match((await publicAddress("http://www.example.com/x"))!, /is not https/);
    assert.match((await publicAddress("https://127.0.0.1/x"))!, /no public host/);
    assert.match((await publicAddress("https://split.example.com/"))!, /non-public address 10\.0\.0\.2/);
    assert.match(
      (await publicAddress("https://gone.example.com/"))!,
      /does not resolve \(gone\.example\.com: ENOTFOUND\)/,
    );
  } finally {
    resolver.lookup = lookup;
  }
});
