import assert from "node:assert/strict";
import { test } from "node:test";
import { fillTemplate, getAt, parseJson, setAt, walk } from "../src/codec.js";
import type { Request } from "../src/spec.js";

const get = (url: string, headers: Record<string, string> = {}): Request => ({ method: "GET", url, headers });

test("path segments: get decodes, set encodes only that segment", () => {
  const r = get("https://x.com/i/api/graphql/Gb-d6r0vxPOADdG62OEBpQ/UserByScreenName?x=1#frag");
  assert.equal(getAt(r, ["path:3"]), "Gb-d6r0vxPOADdG62OEBpQ");
  assert.equal(getAt(r, ["path:4"]), "UserByScreenName");
  const r2 = setAt(r, ["path:3"], "NEWID");
  assert.equal(r2.url, "https://x.com/i/api/graphql/NEWID/UserByScreenName?x=1#frag");
  assert.equal(setAt(get("https://a.com/u/x"), ["path:1"], "a b/c").url, "https://a.com/u/a%20b%2Fc");
  assert.equal(
    r.url,
    "https://x.com/i/api/graphql/Gb-d6r0vxPOADdG62OEBpQ/UserByScreenName?x=1#frag",
    "input not mutated",
  );
});

test("query: raw pairs kept byte-identical, empty values preserved, missing key appended", () => {
  const r = get("https://a.com/s?q=old&cursor=&z=%7E(a%3Ab)&sort=top");
  assert.equal(getAt(r, ["query:cursor"]), "");
  assert.equal(getAt(r, ["query:z"]), "~(a:b)");
  const r2 = setAt(r, ["query:q"], "new value");
  assert.equal(r2.url, "https://a.com/s?q=new%20value&cursor=&z=%7E(a%3Ab)&sort=top");
  assert.equal(setAt(r, ["query:extra"], "1").url, "https://a.com/s?q=old&cursor=&z=%7E(a%3Ab)&sort=top&extra=1");
  // a query that used '+' for spaces keeps using it
  assert.equal(setAt(get("https://a.com/s?q=a+b"), ["query:q"], "c d").url, "https://a.com/s?q=c+d");
});

test("RestLi parens and colons stay literal when the site left them literal", () => {
  const raw = "(count:20,start:0,query:(keywords:alice,flagshipSearchIntent:SEARCH_SRP))";
  const r = get(`https://www.linkedin.com/voyager/api/graphql?variables=${raw}&queryId=voyagerSearchDashClusters.abc`);
  assert.equal(getAt(r, ["query:variables"]), raw);
  const r2 = setAt(r, ["query:variables"], raw.replace("alice", "bob smith"));
  assert.equal(
    r2.url,
    "https://www.linkedin.com/voyager/api/graphql?variables=(count:20,start:0,query:(keywords:bob%20smith,flagshipSearchIntent:SEARCH_SRP))&queryId=voyagerSearchDashClusters.abc",
  );
  // and a site that percent-encoded parens keeps them encoded
  const enc = get("https://a.com/?v=%28a%29");
  assert.equal(setAt(enc, ["query:v"], "(b)").url, "https://a.com/?v=%28b%29");
});

test("X-like variables JSON in the query: set one leaf, keep key order and other params", () => {
  const variables = '{"screen_name":"nasa","withSafetyMode":true,"count":20}';
  const features = '{"a":true,"b":false}';
  const r = get(
    `https://x.com/i/api/graphql/ID/UserByScreenName?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`,
  );
  assert.equal(getAt(r, ["query:variables", "json:/screen_name"]), "nasa");
  assert.equal(getAt(r, ["query:variables", "json:/count"]), 20);
  const r2 = setAt(r, ["query:variables", "json:/screen_name"], 'say "hi" OR x');
  const u = new URL(r2.url);
  assert.equal(u.searchParams.get("variables"), '{"screen_name":"say \\"hi\\" OR x","withSafetyMode":true,"count":20}');
  assert.ok(r2.url.endsWith(`&features=${encodeURIComponent(features)}`), "untouched pair keeps its bytes");
  assert.deepEqual(JSON.parse(u.searchParams.get("variables")!).screen_name, 'say "hi" OR x');
});

test("native type kept when a whole JSON leaf is replaced", () => {
  const r: Request = {
    method: "POST",
    url: "https://a.com/g",
    headers: { "content-type": "application/json" },
    body: '{"v":{"n":1,"s":"x","b":false}}',
  };
  assert.equal(setAt(r, ["body", "json:/v/n"], 42).body, '{"v":{"n":42,"s":"x","b":false}}');
  assert.equal(setAt(r, ["body", "json:/v/n"], "42").body, '{"v":{"n":"42","s":"x","b":false}}');
  assert.equal(setAt(r, ["body", "json:/v/b"], true).body, '{"v":{"n":1,"s":"x","b":true}}');
  assert.equal(setAt(r, ["body", "json:/v/s"], ["a", 1]).body, '{"v":{"n":1,"s":["a",1],"b":false}}');
  assert.throws(() => setAt(r, ["body", "json:/v/missing"], 1), /not found/);
});

test("19-digit snowflake ids never lose precision", () => {
  const body = '{"tweet_id":2085462611575857621,"reply":{"in_reply_to_tweet_id":"2085462611575857621"},"n":1.50}';
  const r: Request = { method: "POST", url: "https://x.com/i/api/graphql/ID/CreateTweet", headers: {}, body };
  assert.equal(getAt(r, ["body", "json:/tweet_id"]), "2085462611575857621");
  // editing a sibling leaves the big number's bytes (and 1.50) untouched
  const r2 = setAt(r, ["body", "json:/reply/in_reply_to_tweet_id"], "1999999999999999999");
  assert.equal(
    r2.body,
    '{"tweet_id":2085462611575857621,"reply":{"in_reply_to_tweet_id":"1999999999999999999"},"n":1.50}',
  );
  // a bigint is written as raw digits, not rounded
  const r3 = setAt(r, ["body", "json:/tweet_id"], 2085462611575857699n);
  assert.equal(
    r3.body,
    '{"tweet_id":2085462611575857699,"reply":{"in_reply_to_tweet_id":"2085462611575857621"},"n":1.50}',
  );
  const leaf = walk(r).find((l) => l.at.join() === "body,json:/tweet_id")!;
  assert.deepEqual([leaf.value, leaf.type], ["2085462611575857621", "number"]);
  assert.deepEqual(parseJson('{"a":12345678901234567890,"b":5}'), { a: "12345678901234567890", b: 5 });
});

// Google Flights GetShoppingResults: form-urlencoding > JSON string > JSON array.
function flightsRequest(origin: string, dest: string) {
  const inner = JSON.stringify([
    [null, null, null, "HKUJcc"],
    [
      null,
      null,
      1,
      null,
      [],
      1,
      [1, 0, 0, 0],
      null,
      null,
      null,
      null,
      null,
      null,
      [
        [[[[origin, 0]]], [[[dest, 0]]], null, 0, null, null, "2026-11-12"],
        [[[[dest, 0]]], [[[origin, 0]]], null, 0, null, null, "2026-11-16"],
      ],
    ],
  ]);
  const outer = JSON.stringify([null, inner]);
  const body = `f.req=${encodeURIComponent(outer)}&at=AFoo%3A1700000000000&`;
  return {
    method: "POST",
    url: "https://www.google.com/_/FlightsFrontendUi/data/GetShoppingResults?f.sid=-123&bl=boq_x&hl=en-US&_reqid=4521&rt=c",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-goog-ext-259736195-jspb": '["en-US","US","USD"]',
    },
    body,
  } satisfies Request;
}

test("Google Flights triple-encoded f.req: walk finds leaves, setAt edits one and keeps the rest", () => {
  const r = flightsRequest("SFO", "JFK");
  const leaves = walk(r);
  const sfo = leaves.filter((l) => l.value === "SFO").map((l) => l.at);
  assert.deepEqual(sfo, [
    ["form:f.req", "json:/1", "json:/1/13/0/0/0/0/0"],
    ["form:f.req", "json:/1", "json:/1/13/1/1/0/0/0"],
  ]);
  assert.ok(leaves.find((l) => l.at.join() === "form:f.req")!.container);
  assert.ok(leaves.some((l) => l.at.join() === "header:x-goog-ext-259736195-jspb,json:/2" && l.value === "USD"));

  const r2 = setAt(r, sfo[0]!, "OAK");
  const expected = flightsRequest("SFO", "JFK");
  // decode the edited body and compare with a request built directly
  const outer = JSON.parse(new URLSearchParams(r2.body).get("f.req")!);
  const inner = JSON.parse(outer[1]);
  assert.equal(inner[1][13][0][0][0][0][0], "OAK");
  assert.equal(inner[1][13][1][1][0][0][0], "SFO", "the other SFO is untouched");
  assert.equal(inner[1][13][0][1][0][0][0], "JFK");
  assert.ok(r2.body!.endsWith("&at=AFoo%3A1700000000000&"), "other form pairs keep their bytes");
  assert.equal(r2.url, expected.url);
  assert.equal(getAt(r2, sfo[0]!), "OAK");
});

test("header and whole-body steps", () => {
  const r: Request = { method: "POST", url: "https://a.com/", headers: { "x-csrf-token": "" }, body: "raw" };
  assert.equal(setAt(r, ["header:X-CSRF-Token"], "abc").headers["x-csrf-token"], "abc");
  assert.equal(setAt(r, ["header:x-new"], "1").headers["x-new"], "1");
  assert.equal(setAt(r, ["body"], "new").body, "new");
  assert.throws(() => setAt(r, ["json:/a"], 1), /not a request layer/);
});

test("fillTemplate fills known names only; literal {braces} survive", () => {
  assert.equal(fillTemplate("from:{query} lang:en {viewer{id}}", { query: "cats" }), "from:cats lang:en {viewer{id}}");
  assert.equal(fillTemplate("Bearer {cookie:ct0}", { "cookie:ct0": "tok" }), "Bearer tok");
});

test("walk: path, query, headers, form and JSON-in-JSON leaves with step paths", () => {
  const r: Request = {
    method: "POST",
    url: "https://a.com/api/users/nasa?vars=%7B%22id%22%3A%22x1%22%7D",
    headers: { "content-type": "application/json" },
    body: '{"variables":{"q":"hello","inner":"{\\"deep\\":[1,\\"two\\"]}"},"flag":null}',
  };
  const byAt = new Map(walk(r).map((l) => [l.at.join(" "), l]));
  assert.equal(byAt.get("path:2")!.value, "nasa");
  assert.equal(byAt.get("query:vars json:/id")!.value, "x1");
  assert.equal(byAt.get("body json:/variables/q")!.value, "hello");
  assert.equal(byAt.get("body json:/variables/inner json:/deep/1")!.value, "two");
  assert.equal(byAt.get("body json:/flag")!.type, "null");
  const deep = setAt(r, ["body", "json:/variables/inner", "json:/deep/1"], "three");
  assert.equal(deep.body, '{"variables":{"q":"hello","inner":"{\\"deep\\":[1,\\"three\\"]}"},"flag":null}');
});

test("JSON pointer escapes ~0 and ~1", () => {
  const r: Request = { method: "POST", url: "https://a.com/", headers: {}, body: '{"a/b":{"c~d":"v"}}' };
  const leaf = walk(r).find((l) => l.value === "v")!;
  assert.deepEqual(leaf.at, ["body", "json:/a~1b/c~0d"]);
  assert.equal(setAt(r, leaf.at, "w").body, '{"a/b":{"c~d":"w"}}');
});

test("a JSON body labeled form-urlencoded (Algolia) is walked as JSON, so its values are found", () => {
  const r: Request = {
    method: "POST",
    url: "https://app-dsn.algolia.net/1/indexes/Item_dev/query",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: '{"query":"sqlite","hitsPerPage":30}',
  };
  const leaf = walk(r).find((l) => l.value === "sqlite");
  assert.deepEqual(leaf?.at, ["body", "json:/query"]);
  assert.equal(setAt(r, leaf!.at, "duckdb").body, '{"query":"duckdb","hitsPerPage":30}');
  const form: Request = { ...r, body: "q=sqlite&n=1" };
  assert.deepEqual(
    walk(form).find((l) => l.value === "sqlite")?.at,
    ["form:q"],
    "a real form body still parses as pairs",
  );
});

test("fillTemplate: doubled braces are literal, so a learned leaf's own {name} text survives", () => {
  assert.equal(
    fillTemplate('query{{repo(name:"{name}"){{name}}}}', { name: "linux" }),
    'query{repo(name:"linux"){name}}',
  );
  assert.equal(fillTemplate("{{{name}}}", { name: "x" }), "{x}");
});

test("a body nested past the JSON reviver's stack fails in the body's terms, not the engine's", () => {
  // the reviver runs once per value down the whole body, so ~5000 levels overflow the stack even
  // though JSON.parse itself handles far more: a 10 KB body a site sends is enough
  const deep = "[".repeat(20_000) + "]".repeat(20_000);
  assert.throws(
    () => parseJson(deep),
    (error: Error) => {
      assert.ok(!(error instanceof RangeError), "an engine stack overflow is not what a caller can act on");
      assert.match(error.message, /the body nests too deeply to parse/);
      return true;
    },
  );
  assert.doesNotThrow(() => parseJson("[".repeat(1_000) + "]".repeat(1_000)), "a body that parses still parses");
});
