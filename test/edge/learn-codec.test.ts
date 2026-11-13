/**
 * Edge cases for learning and codecs (src/learn.ts, src/codec.ts, src/spec.ts). Each test is a
 * regression for a bug that was fixed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "api-anything-edge-learn-"));
process.env.API_ANYTHING_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

import { getAt, setAt, walk } from "../../src/codec.js";
import { addOperation, fillTrigger, runOpTrigger, triggerRefusal } from "../../src/heal.js";
import { buildRequest } from "../../src/http.js";
import { learnOperation, matches } from "../../src/learn.js";
import { OperationSchema, type Request } from "../../src/spec.js";
import type { Exchange, StoredCookie } from "../../src/types.js";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SEC_CH_UA = '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"';
const noSession = { cookies: [] as StoredCookie[], values: {} as Record<string, string> };

let nextId = 1;
function xhr(
  req: { method?: string; url: string; headers?: Record<string, string>; body?: string },
  resBody: unknown = { results: [{ id: 1 }, { id: 2 }] },
  contentType = "application/json",
): Exchange {
  return {
    id: nextId++,
    resourceType: "fetch",
    request: {
      method: req.method ?? "GET",
      url: req.url,
      headers: req.headers ?? {},
      ...(req.body !== undefined ? { body: req.body } : {}),
    },
    response: {
      status: 200,
      headers: {},
      contentType,
      body: typeof resBody === "string" ? resBody : JSON.stringify(resBody),
    },
  };
}

function learn(
  exchanges: Exchange[],
  examples: [Record<string, unknown>] | [Record<string, unknown>, Record<string, unknown>],
  extra: Partial<Parameters<typeof learnOperation>[0]> = {},
) {
  return learnOperation({
    exchanges,
    examples,
    cookies: [],
    name: "op",
    trigger: { url: "https://site.test/" },
    readOnly: true,
    ...extra,
  });
}

/** Build the request a call with args would send (no session). */
const built = (op: ReturnType<typeof learn>["operation"], args: Record<string, unknown>) =>
  buildRequest(op, args, noSession);
const q = (req: Request, k: string) => new URL(req.url).searchParams.get(k);

/* ------------------------------------------------------ passing regressions */

test("round-trip: unicode, emoji, RTL, spaces and URL-special chars in query, path, form and JSON", () => {
  const tricky = ["café ☕ 🚀", "مرحبا بالعالم", "a&b=c#d%e+f", `say "hi" 'there'`, "x".repeat(5000), "a/b?c"];
  const ex = xhr({
    method: "POST",
    url: "https://site.test/api/users/nasa/search?q=nasa&x=1",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `vars=${encodeURIComponent(JSON.stringify({ term: "nasa", n: 1 }))}&plain=nasa`,
  });
  const { operation: op } = learn([ex], [{ q: "nasa" }], { id: ex.id });
  for (const v of tricky) {
    const r = built(op, { q: v });
    assert.equal(q(r, "q"), v);
    assert.equal(q(r, "x"), "1");
    assert.equal(getAt(r, ["path:2"]), v);
    assert.equal(new URL(r.url).pathname.split("/").length, 5, "a value with / stays in one path segment");
    assert.equal(getAt(r, ["form:plain"]), v);
    assert.deepEqual(JSON.parse(getAt(r, ["form:vars"]) as string), { term: v, n: 1 });
  }
});

test("case difference: example NASA locates the sent nasa, and the caller's case is sent", () => {
  const ex = xhr({ url: "https://site.test/api/search?q=nasa" });
  const { operation: op } = learn([ex], [{ q: "NASA" }]);
  assert.deepEqual(op.slots, [{ param: "q", at: ["query:q"] }]);
  assert.equal(q(built(op, { q: "SpaceX" }), "q"), "SpaceX");
});

test("substring template keeps surrounding text and the arg's special chars (X search style)", () => {
  const ex = xhr({ url: `https://site.test/api/search?q=${encodeURIComponent("from:nasa lang:en {x}")}` });
  const { operation: op } = learn([ex], [{ query: "nasa" }]);
  assert.equal(q(built(op, { query: "a&b {c} 🚀" }), "q"), "from:a&b {c} 🚀 lang:en {x}");
});

test("the same value in URL and body: both filled, warned", () => {
  const ex = xhr({
    method: "POST",
    url: "https://site.test/api/search?q=nasa",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "nasa", page: 1 }),
  });
  const { operation: op, warnings } = learn([ex], [{ q: "nasa" }]);
  const r = built(op, { q: "mars" });
  assert.equal(q(r, "q"), "mars");
  assert.deepEqual(JSON.parse(r.body!), { query: "mars", page: 1 });
  assert.ok(warnings.some((w) => w.includes("2 places")));
});

test("text/plain JSON body is walked as JSON; numeric JSON leaf gets type number and native encoding", () => {
  const ex = xhr({
    method: "POST",
    url: "https://site.test/api/items",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: '{"id":1840000000000000001,"q":"rover"}',
  });
  const { operation: op } = learn([ex], [{ id: "1840000000000000001", q: "rover" }]);
  assert.equal(op.params.find((p) => p.name === "id")!.type, "number");
  const r = built(op, { id: "1840000000000000999", q: "lander" });
  assert.equal(r.body, '{"id":1840000000000000999,"q":"lander"}');
});

test("multipart/form-data body: the value's part is templated, boundary kept", () => {
  const b = "----WebKitFormBoundaryAbC123";
  const body = `--${b}\r\nContent-Disposition: form-data; name="q"\r\n\r\nnasa\r\n--${b}\r\nContent-Disposition: form-data; name="n"\r\n\r\n10\r\n--${b}--\r\n`;
  const ex = xhr({
    method: "POST",
    url: "https://site.test/api/upload",
    headers: { "content-type": `multipart/form-data; boundary=${b}` },
    body,
  });
  const { operation: op } = learn([ex], [{ q: "nasa" }]);
  const r = built(op, { q: "mars {x} rover" });
  assert.equal(r.body, body.replace("nasa", "mars {x} rover"));
  assert.equal(r.headers["content-type"], `multipart/form-data; boundary=${b}`);
});

test("Google-Flights style: JSON inside a form field inside JSON; a value in several roles", () => {
  const inner = JSON.stringify([
    null,
    [
      [[["JFK", 0]], [["LAX", 0]], null, 0, null, null, "2026-10-01"],
      [[["LAX", 0]], [["JFK", 0]]],
    ],
  ]);
  const freq = JSON.stringify([null, inner]);
  const ex = xhr(
    {
      method: "POST",
      url: "https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults?f.sid=-123&_reqid=4&rt=c",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: `f.req=${encodeURIComponent(freq)}&`,
    },
    ")]}'\n[1]",
  );
  const { operation: op } = learn([ex], [{ origin: "JFK", dest: "LAX", date: "2026-10-01" }]);
  const r = built(op, { origin: "SFO", dest: "CDG", date: "2026-12-24" });
  const got = JSON.parse(JSON.parse(getAt(r, ["form:f.req"]) as string)[1]);
  assert.deepEqual(got, [
    null,
    [
      [[["SFO", 0]], [["CDG", 0]], null, 0, null, null, "2026-12-24"],
      [[["CDG", 0]], [["SFO", 0]]],
    ],
  ]);
  assert.ok(r.body!.endsWith("&"), "trailing empty pair kept byte-identical");
});

test("persisted-query sha256 in extensions: volatile with the operationName anchor, never in match", () => {
  const hash = `${"a".repeat(20)}0123456789abcdef0123456789abcdef0123456789ab`;
  const ex = xhr({
    url: `https://site.test/graphql?operationName=SearchQuery&variables=${encodeURIComponent('{"q":"nasa"}')}&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }))}`,
  });
  const { operation: op } = learn([ex], [{ q: "nasa" }]);
  assert.deepEqual(
    op.volatile.map((v) => [v.at, v.anchor]),
    [[["query:extensions", "json:/persistedQuery/sha256Hash"], "SearchQuery"]],
  );
  assert.deepEqual(op.match, { method: "GET", host: "site.test", path: "/graphql", operationName: "SearchQuery" });
});

test("Laravel/Angular XSRF: header mirrors the URL-decoded cookie -> cookie ref with url-decode, blanked in the spec", () => {
  const raw = "eyJpdiI6IkFCQ0RFRkdISUpLTE1OT1AiLCJ2YWx1ZSI6Ing9In0%3D";
  const ex = xhr({
    url: "https://site.test/api/search?q=nasa",
    headers: { "x-xsrf-token": decodeURIComponent(raw), cookie: `XSRF-TOKEN=${raw}` },
  });
  const { operation: op } = learn([ex], [{ q: "nasa" }], {
    cookies: [
      { name: "XSRF-TOKEN", value: raw, domain: "site.test", path: "/", expires: -1, httpOnly: false, secure: true },
    ],
  });
  assert.deepEqual(
    op.slots.find((s) => s.ref),
    { ref: "cookie:XSRF-TOKEN", transform: "url-decode", at: ["header:x-xsrf-token"] },
  );
  assert.equal(op.request.headers["x-xsrf-token"], "");
});

test("--match picks the right one among near-duplicate requests (autocomplete vs search)", () => {
  const suggest = xhr(
    { url: "https://site.test/api/suggest?q=nasa" },
    { s: ["nasa", "nasa tv", "nasa live", "nasa jobs"].map((x) => ({ x })) },
  );
  const search = xhr({ url: "https://site.test/api/search?q=nasa" }, { r: [{ id: 1 }] });
  const { operation: op } = learn([suggest, search], [{ q: "nasa" }], { match: { path: "/api/search" } });
  assert.equal(new URL(op.request.url).pathname, "/api/search");
});

test("a trigger URL template percent-encodes every arg, including / & # ? and emoji", () => {
  const t = fillTrigger({ url: "https://site.test/search?q={q}#tab={tab}" }, { q: "a&b=c/d?e", tab: "🚀 x" });
  assert.equal(
    t.url,
    `https://site.test/search?q=${encodeURIComponent("a&b=c/d?e")}#tab=${encodeURIComponent("🚀 x")}`,
  );
});

test("a goto step's address is filled percent-encoded wherever it is written; other steps take the arg as given", () => {
  const u = "other.test/x?";
  const t = fillTrigger(
    {
      url: "https://site.test/",
      steps: [
        { action: "goto", selector: "https://{u}@site.test/" },
        { action: "goto", value: "https://{u}@site.test/" },
        { action: "click", selector: "#row-{u}" },
        { action: "fill", selector: "#q", value: "{u}" },
      ],
    },
    { u },
  );
  assert.equal(t.steps![0]!.selector, `https://${encodeURIComponent(u)}@site.test/`);
  assert.equal(new URL(t.steps![0]!.selector!).host, "site.test");
  assert.equal(new URL(t.steps![1]!.value!).host, "site.test");
  assert.equal(t.steps![2]!.selector, "#row-other.test/x?");
  assert.equal(t.steps![3]!.value, "other.test/x?");
});

test("an arg that makes a trigger's path segment a dot segment: the trigger still fills, and is not opened", async () => {
  const trigger = {
    url: "https://site.test/u/{name}/posts?tab={tab}",
    softFrom: "https://site.test/feed/{feed}",
    steps: [
      { action: "goto" as const, value: "https://site.test/t/.{dot}" },
      { action: "goto" as const, selector: "https://site.test/s/{a}{b}/x" },
      { action: "click" as const, selector: "#{name}" },
    ],
  };
  const fine = { name: "..a", tab: "..", feed: "...", dot: "x", a: ".", b: "x" };
  assert.equal(triggerRefusal(trigger, fine), undefined);
  for (const [args, seg] of [
    [{ name: ".." }, "{name}"],
    [{ name: "." }, "{name}"],
    [{ feed: ".." }, "{feed}"],
    [{ dot: "." }, ".{dot}"],
    [{ a: ".", b: "." }, "{a}{b}"],
  ] as const)
    assert.match(
      triggerRefusal(trigger, { ...fine, ...args }) ?? "",
      new RegExp(`${seg.replace(/[.{}]/g, "\\$&")}.* a URL reads it as another address`),
      JSON.stringify(args),
    );
  // filling never throws: a message about a call that already ran spells the page with it
  assert.equal(fillTrigger(trigger, { ...fine, name: ".." }).url, "https://site.test/u/../posts?tab=..");

  const op = OperationSchema.parse({
    name: "posts",
    readOnly: true,
    request: { method: "GET", url: "https://site.test/api/posts?user=alice", headers: {} },
    slots: [{ param: "name", at: ["query:user"] }],
    trigger: { url: "https://site.test/u/{name}/posts" },
    match: { method: "GET", path: "/api/posts" },
    params: [{ name: "name" }],
  });
  await assert.rejects(runOpTrigger("dots", op, { name: ".." }), /not opening .*a URL reads it as another address/);
});

/* -------------------------------------------------------------------- bugs */

test("a value found only in the Referer header is not 'in the request' (would silently return the example's data)", () => {
  // GitHub-style owner/repo spans two path segments; the only single leaf holding it is the Referer.
  const ex = xhr({
    url: "https://api.site.test/repos/facebook/react",
    headers: { referer: "https://site.test/facebook/react", accept: "application/json" },
  });
  assert.throws(
    () => learn([ex], [{ repo: "facebook/react" }], { match: { path: "/repos/*/*" } }),
    /not in the learned request/,
  );
});

test("a subdomain arg found only in Origin/Referer is not 'in the request'", () => {
  const ex = xhr({
    url: "https://api.tumblr.test/v2/blog/info",
    headers: { origin: "https://nasa.tumblr.test", referer: "https://nasa.tumblr.test/" },
  });
  assert.throws(() => learn([ex], [{ blog: "nasa" }], { id: ex.id }), /not in the learned request/);
});

test("an example value inside the User-Agent / sec-ch-ua does not template those headers", () => {
  const ex = xhr({
    url: "https://shop.test/api/search?q=apple",
    headers: { "user-agent": MAC_UA, "sec-ch-ua": SEC_CH_UA, accept: "application/json" },
  });
  const { operation: op } = learn([ex], [{ q: "apple" }]);
  const r = built(op, { q: "pear" });
  assert.equal(q(r, "q"), "pear");
  assert.equal(r.headers["user-agent"], MAC_UA);

  const ex2 = xhr({
    url: "https://shop.test/api/search?q=google",
    headers: { "user-agent": MAC_UA, "sec-ch-ua": SEC_CH_UA },
  });
  const r2 = built(learn([ex2], [{ q: "google" }]).operation, { q: "bing" });
  assert.equal(r2.headers["sec-ch-ua"], SEC_CH_UA);
});

test("a 3-letter example like 'app' does not rewrite Accept / Content-Type", () => {
  const ex = xhr({
    method: "POST",
    url: "https://site.test/api/search",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: '{"q":"app"}',
  });
  const r = built(learn([ex], [{ q: "app" }]).operation, { q: "shoes" });
  assert.equal(r.body, '{"q":"shoes"}');
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.headers.accept, "application/json");
});

test("a numeric example does not template digits inside unrelated numbers (timestamps), nor retype them", () => {
  const ex = xhr({
    method: "POST",
    url: "https://site.test/api/list?_=1727380100123",
    headers: { "content-type": "application/json" },
    body: '{"limit":100,"since":1727380100456}',
  });
  const { operation: op } = learn([ex], [{ limit: "100" }]);
  const r = built(op, { limit: "20" });
  assert.equal(r.body, '{"limit":20,"since":1727380100456}');
  assert.equal(q(r, "_"), "1727380100123");
});

test("a boolean example 'true' binds to its own leaf, not every true flag in the request", () => {
  const variables = JSON.stringify({ userId: "nasa", includeReplies: true });
  const features = JSON.stringify({ verified_enabled: true, media_enabled: true });
  const ex = xhr({
    url: `https://site.test/graphql/Tweets?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`,
  });
  const { operation: op } = learn([ex], [{ userId: "nasa", includeReplies: "true" }]);
  const r = built(op, { userId: "nasa", includeReplies: "false" });
  assert.deepEqual(JSON.parse(q(r, "variables")!), { userId: "nasa", includeReplies: false });
  assert.deepEqual(
    JSON.parse(q(r, "features")!),
    { verified_enabled: true, media_enabled: true },
    "unrelated feature flags must not follow the arg",
  );
});

test("one example value inside another's leaf: the exact leaf keeps its own param", () => {
  const ex = xhr({ url: "https://site.test/api/search?q=new+york+pizza&city=new+york" });
  const { operation: op } = learn([ex], [{ q: "new york pizza", city: "new york" }]);
  const r = built(op, { q: "tacos", city: "boston" });
  assert.equal(q(r, "city"), "boston");
  assert.equal(q(r, "q"), "tacos");
});

test("two params sharing a prefix inside one leaf are both templated", () => {
  const ex = xhr({ url: `https://site.test/api/search?q=${encodeURIComponent("from:nasa to:nasagov")}` });
  const { operation: op } = learn([ex], [{ from: "nasa", to: "nasagov" }]);
  assert.equal(q(built(op, { from: "esa", to: "spacex" }), "q"), "from:esa to:spacex");
});

test("the same numeric value as a JSON string and a JSON number keeps each leaf's own type", () => {
  const ex = xhr({
    method: "POST",
    url: "https://site.test/api/user",
    headers: { "content-type": "application/json" },
    body: '{"id":"12345","ids":[12345]}',
  });
  const r = built(learn([ex], [{ id: "12345" }]).operation, { id: "777" });
  assert.equal(r.body, '{"id":"777","ids":[777]}');
});

test("a URL carried inside a query param keeps its own encoding layer (arg with & and =)", () => {
  const ex = xhr({ url: `https://site.test/api/go?next=${encodeURIComponent("/search?q=nasa&page=1")}` });
  const { operation: op } = learn([ex], [{ q: "nasa" }]);
  const next = q(built(op, { q: "a&page=9" }), "next")!;
  const inner = new URL(next, "https://site.test");
  assert.equal(inner.searchParams.get("q"), "a&page=9");
  assert.equal(inner.searchParams.getAll("page").join(), "1");
});

test("an inline GraphQL string literal escapes quotes in the arg", () => {
  const ex = xhr({
    method: "POST",
    url: "https://site.test/graphql",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: '{ search(q: "nasa") { id } }' }),
  });
  const { operation: op } = learn([ex], [{ q: "nasa" }]);
  const query = JSON.parse(built(op, { q: 'say "hi"' }).body!).query as string;
  assert.equal(query, '{ search(q: "say \\"hi\\"") { id } }');
});

test("a twice-URL-encoded value is located and refilled at the same encoding depth", () => {
  const ex = xhr({ url: "https://site.test/api/search?state=q%3Dnew%2520york" });
  const { operation: op } = learn([ex], [{ q: "new york" }], { id: ex.id });
  assert.equal(new URL(built(op, { q: "los angeles" }).url).search, "?state=q%3Dlos%2520angeles");
});

test("base64-encoded JSON in a query param is a decoded layer", () => {
  const state = Buffer.from(JSON.stringify({ q: "nasa", page: 1 })).toString("base64");
  const ex = xhr({ url: `https://site.test/api/search?s=${encodeURIComponent(state)}` });
  const { operation: op } = learn([ex], [{ q: "nasa" }], { id: ex.id });
  const s = q(built(op, { q: "mars" }), "s")!;
  assert.deepEqual(JSON.parse(Buffer.from(s, "base64").toString()), { q: "mars", page: 1 });
});

test("batched GraphQL (array body) gets an operationName in its match, so it does not match other GraphQL ops", () => {
  const body = (op: string, v: object) =>
    JSON.stringify([{ operationName: op, variables: v, query: `query ${op} { x }` }]);
  const ex = xhr({
    method: "POST",
    url: "https://site.test/graphql",
    headers: { "content-type": "application/json" },
    body: body("SearchProducts", { q: "nasa" }),
  });
  const { operation: op } = learn([ex], [{ q: "nasa" }]);
  const other: Request = { method: "POST", url: "https://site.test/graphql", headers: {}, body: body("CartCount", {}) };
  assert.equal(matches(op.match, other), false, `match ${JSON.stringify(op.match)} also accepts CartCount`);
});

test("GraphQL POST without operationName field: match uses the query's operation name", () => {
  const body = (name: string, v: object) =>
    JSON.stringify({ query: `query ${name}($q: String) { search(q: $q) { id } }`, variables: v });
  const ex = xhr({
    method: "POST",
    url: "https://site.test/graphql",
    headers: { "content-type": "application/json" },
    body: body("SearchProducts", { q: "nasa" }),
  });
  const { operation: op } = learn([ex], [{ q: "nasa" }]);
  const other: Request = { method: "POST", url: "https://site.test/graphql", headers: {}, body: body("CartCount", {}) };
  assert.equal(matches(op.match, other), false, `match ${JSON.stringify(op.match)} also accepts CartCount`);
});

/* ---------------------------------------------- add --from: trigger templatize */

function captureFile(url: string, exchanges: Exchange[]) {
  return { id: `c${nextId++}`, at: new Date().toISOString(), url, exchanges, cookies: [], finalUrl: url };
}

test("add --from templatizes a capture URL written with + for spaces", async () => {
  const url = "https://site.test/search?q=new+york";
  const ex = xhr({ url: "https://site.test/api/search?q=new+york" });
  const r = await addOperation({
    site: "edge-plus",
    op: "search",
    examples: [{ q: "new york" }],
    from: { capture: captureFile(url, [ex]) },
  });
  // A literal trigger makes every tier-3 run and recapture load the example's page, whatever the args.
  assert.equal(fillTrigger(r.operation.trigger, { q: "boston" }).url, "https://site.test/search?q=boston");
});

test("add --from templatizes only the arg's own position, not an equal path segment or host", async () => {
  const url = "https://www.reddit.test/r/python/search?q=python";
  const ex = xhr({ url: "https://www.reddit.test/svc/search?q=python&sr=python" });
  const r = await addOperation({
    site: "edge-host",
    op: "search",
    examples: [{ q: "python" }],
    from: { capture: captureFile(url, [ex]) },
  });
  assert.equal(fillTrigger(r.operation.trigger, { q: "rust" }).url, "https://www.reddit.test/r/python/search?q=rust");
});

test("add --from templatizes a %20-encoded capture URL (passes)", async () => {
  const url = "https://site.test/search?q=new%20york";
  const ex = xhr({ url: "https://site.test/api/search?q=new%20york" });
  const r = await addOperation({
    site: "edge-pct",
    op: "search",
    examples: [{ q: "new york" }],
    from: { capture: captureFile(url, [ex]) },
  });
  assert.equal(r.operation.trigger.url, "https://site.test/search?q={q}");
});

/* ------------------------------------------------------------ codec basics */

test("codec: walk/getAt/setAt agree for every leaf of a mixed request", () => {
  const req: Request = {
    method: "POST",
    url: "https://site.test/a/b%20c/d?x=1&y=%7B%22k%22%3A%5B1%2C%22v%22%5D%7D&z=",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-a": "h" },
    body: "f=%5B%22a%22%2C%7B%22b%22%3A%22c%22%7D%5D&g=2",
  };
  for (const leaf of walk(req)) {
    const got = getAt(req, leaf.at);
    assert.equal(typeof got === "string" ? got : JSON.stringify(got), leaf.value, leaf.at.join(" > "));
    if (!leaf.container)
      assert.deepEqual(setAt(req, leaf.at, getAt(req, leaf.at)), req, `identity set at ${leaf.at.join(" > ")}`);
  }
});

/* ------------------------------------------------------------------ batch 2 */

test("a Referer templated with the arg stays a valid, percent-encoded header for non-ASCII args", async () => {
  const ex = xhr({
    url: "https://site.test/api/search?q=nasa",
    headers: { referer: "https://site.test/search?q=nasa" },
  });
  const { operation: op } = learn([ex], [{ q: "nasa" }]);
  const r = built(op, { q: "東京 café" });
  assert.equal(q(r, "q"), "東京 café");
  assert.doesNotThrow(() => new Headers(r.headers), "fetch rejects a non-ByteString header value");
  assert.equal(new URL(r.headers.referer!).searchParams.get("q"), "東京 café");
});

test("bundled google-flights spec: a non-Latin-1 city goes into the referer percent-encoded", async () => {
  const { parseSite } = await import("../../src/spec.js");
  const { readFileSync } = await import("node:fs");
  const site = parseSite(JSON.parse(readFileSync(new URL("../../sites/google-flights.json", import.meta.url), "utf8")));
  const op = site.operations.find((o) => o.name === "search")!;
  const r = buildRequest(op, { origin: "東京", destination: "São Paulo", date: "2026-12-01" }, noSession);
  assert.doesNotThrow(() => new Headers(r.headers));
  assert.ok(!/ /.test(r.headers.referer!), `referer is not a valid URL: ${r.headers.referer}`);
});

test("a JSON API whose path ends in .js (GitHub vercel/next.js, npm chart.js) is not dropped as an asset", () => {
  const ex = xhr(
    { url: "https://api.github.test/repos/vercel/next.js" },
    { full_name: "vercel/next.js", stargazers_count: 1 },
  );
  const { operation: op } = learn([ex], [{ repo: "next.js" }], { match: { path: "/repos/vercel/*" } });
  assert.equal(op.request.url, "https://api.github.test/repos/vercel/next.js");
});

test("a path segment that carries the arg as a substring (@handle) is wildcarded in match (passes)", () => {
  const run = (h: string) => [xhr({ url: `https://site.test/api/users/@${h}/profile.json` }, { user: { name: h } })];
  const { operation: op, warnings } = learnOperation({
    exchanges: run("nasa"),
    exchanges2: run("spacex"),
    examples: [{ handle: "nasa" }, { handle: "spacex" }],
    cookies: [],
    name: "op",
    trigger: { url: "https://site.test/@{handle}" },
    readOnly: true,
  });
  assert.equal(op.match.path, "/api/users/*/profile.json");
  assert.ok(!warnings.some((w) => w.includes("no matching request")), warnings.join("\n"));
});

test("a nonce inside a templated leaf is still detected by the two-run diff (minTier 3)", () => {
  const run = (v: string, sig: string) => [
    xhr({ url: `https://site.test/api/go?u=${encodeURIComponent(`/search?q=${v}&sig=${sig}`)}` }),
  ];
  const { operation: op } = learnOperation({
    exchanges: run("nasa", "Zx81kPq0aB3dF7gH2jK9"),
    exchanges2: run("spacex", "Qm4nR7sT1uV5wX8yZ2aB"),
    examples: [{ q: "nasa" }, { q: "spacex" }],
    cookies: [],
    name: "op",
    trigger: { url: "https://site.test/?q={q}" },
    readOnly: true,
  });
  assert.equal(op.minTier, 3);
});

test("control: a nonce in its own leaf is detected by the two-run diff (passes)", () => {
  const run = (v: string, sig: string) => [xhr({ url: `https://site.test/api/search?q=${v}&sig=${sig}` })];
  const { operation: op } = learnOperation({
    exchanges: run("nasa", "Zx81kPq0aB3dF7gH2jK9"),
    exchanges2: run("spacex", "Qm4nR7sT1uV5wX8yZ2aB"),
    examples: [{ q: "nasa" }, { q: "spacex" }],
    cookies: [],
    name: "op",
    trigger: { url: "https://site.test/?q={q}" },
    readOnly: true,
  });
  assert.equal(op.minTier, 3);
});

test("an array example (library add) binds to the JSON array leaf with type array", () => {
  const ex = xhr({
    method: "POST",
    url: "https://site.test/api/search",
    headers: { "content-type": "application/json" },
    body: '{"tags":["nasa","mars"],"n":10}',
  });
  const { operation: op } = learn([ex], [{ tags: ["nasa", "mars"] }]);
  assert.equal(op.params[0]!.type, "array");
  assert.equal(built(op, { tags: ["esa"] }).body, '{"tags":["esa"],"n":10}');
});

test("an access_token / token field is a session ref, never literal in the spec", () => {
  const secret = "EAAGm0PX4ZCpsBAKZCZBw7hjk2ZAn9ZCqZB8ZAzT";
  const slack = "xoxc-1234567890-1234567890-abcdef0123456789";
  const ex = xhr({
    method: "POST",
    url: `https://site.test/api/graphql?access_token=${secret}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `token=${slack}&variables=${encodeURIComponent('{"q":"nasa"}')}`,
  });
  const spec = JSON.stringify(learn([ex], [{ q: "nasa" }]).operation);
  assert.ok(!spec.includes(secret), "access_token query value is literal in the spec");
  assert.ok(!spec.includes(slack), "token form value is literal in the spec");
});

test("Meta's x-fb-lsd header (same token as the lsd form field, which is ref'd) is not literal in the spec", () => {
  const lsd = "AVqbxe3J_YcQ1nKp";
  const ex = xhr({
    method: "POST",
    url: "https://www.site.test/api/graphql/",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-fb-lsd": lsd,
      "x-fb-friendly-name": "SearchQuery",
    },
    body: `lsd=${lsd}&fb_api_req_friendly_name=SearchQuery&variables=${encodeURIComponent('{"q":"nasa"}')}`,
  });
  const { operation: op } = learn([ex], [{ q: "nasa" }]);
  assert.deepEqual(
    op.slots.find((s) => s.ref === "session:op/lsd")?.at,
    ["form:lsd"],
    "control: the form field is a ref",
  );
  assert.ok(!JSON.stringify(op).includes(lsd), "x-fb-lsd header keeps the lsd token literally");
});

test("a URL-valued example (link preview / archive lookup) locates its request", () => {
  const ex = xhr(
    { url: `https://tool.test/api/preview?url=${encodeURIComponent("https://example.com/page")}` },
    { title: "x", links: [1, 2] },
  );
  const doc: Exchange = {
    ...xhr({ url: "https://tool.test/?u=https://example.com/page" }, "<html></html>", "text/html"),
    resourceType: "document",
  };
  const { operation: op } = learn([doc, ex], [{ url: "https://example.com/page" }]);
  assert.equal(new URL(op.request.url).pathname, "/api/preview");
});

test("empty-string and very long args at call time (passes)", () => {
  const ex = xhr({
    method: "POST",
    url: "https://site.test/api/search?q=nasa",
    headers: { "content-type": "application/json" },
    body: '{"q":"nasa"}',
  });
  const { operation: op } = learn([ex], [{ q: "nasa" }]);
  const r = built(op, { q: "" });
  assert.equal(new URL(r.url).search, "?q=");
  assert.equal(r.body, '{"q":""}');
  const long = "ü".repeat(20000);
  assert.equal(q(built(op, { q: long }), "q"), long);
});

test("add --from templatizes a capture URL whose arg differs only in case from the example", async () => {
  const url = "https://site.test/search?q=NASA";
  const ex = xhr({ url: "https://site.test/api/search?q=nasa" });
  const r = await addOperation({
    site: "edge-case",
    op: "search",
    examples: [{ q: "nasa" }],
    from: { capture: captureFile(url, [ex]) },
  });
  assert.equal(r.operation.trigger.url, "https://site.test/search?q={q}");
});

test("a hand-written spec with mixed-case header names does not send duplicated/joined headers", async () => {
  const { parseSite } = await import("../../src/spec.js");
  const site = parseSite({
    name: "h",
    baseUrl: "https://s.test",
    operations: [
      {
        name: "o",
        readOnly: true,
        trigger: { url: "https://s.test/" },
        request: { method: "GET", url: "https://s.test/api?q=x", headers: { "X-CSRF-Token": "", "X-Search": "x" } },
        params: [{ name: "q" }],
        slots: [
          { param: "q", at: ["query:q"] },
          { param: "q", at: ["header:X-Search"] },
          { ref: "session:tok", at: ["header:x-csrf-token"] },
        ],
      },
    ],
  });
  const r = buildRequest(site.operations[0]!, { q: "nasa" }, { cookies: [], values: { tok: "SECRET123" } });
  const h = new Headers(r.headers);
  assert.equal(h.get("x-csrf-token"), "SECRET123");
  assert.equal(h.get("x-search"), "nasa");
});

test("a repeated query key (tag=a&tag=b) locates an example in its second occurrence", () => {
  const ex = xhr({ url: "https://s.test/api/search?tag=mars&tag=nasa" });
  assert.doesNotThrow(() => learn([ex], [{ tag: "nasa" }], { id: ex.id }));
});

test("example equal to the endpoint's own path segment binds it, with a warning (documented; kept as regression)", () => {
  const ex = xhr({ url: "https://s.test/api/search?q=search" });
  const { operation: op, warnings } = learn([ex], [{ q: "search" }]);
  assert.ok(warnings.some((w) => w.includes("2 places")));
  assert.equal(new URL(built(op, { q: "nasa" }).url).pathname, "/api/nasa");
});
