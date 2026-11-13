/**
 * Regressions for the learner's slots (src/learn.ts, src/codec.ts): credentials that reached the
 * spec or were stored under the wrong name, and params the second example proves or disproves.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "api-anything-edge-slots-"));
process.env.API_ANYTHING_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

import { addOperation, type CaptureFile } from "../../src/heal.js";
import { buildRequest } from "../../src/http.js";
import { learnOperation, matches } from "../../src/learn.js";
import { credentialsOf, scanSecrets } from "../../src/secrets.js";
import { loadSession, mergeCapture, saveSession } from "../../src/session.js";
import { exportSite, loadSite } from "../../src/store.js";
import type { Exchange, StoredCookie } from "../../src/types.js";

const A = "Zx81kLmN0pQrStUv2wXyZ3aBcD";
const B = "Ys92jKnM1qRsTuVw3xYzA4bCdE";

let nextId = 1;
function xhr(
  req: { method?: string; url: string; headers?: Record<string, string>; body?: string },
  resBody: unknown = { results: [{ id: 1 }, { id: 2 }] },
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
    response: { status: 200, headers: {}, contentType: "application/json", body: JSON.stringify(resBody) },
  };
}
const post = (body: string, headers: Record<string, string> = {}) =>
  xhr({
    method: "POST",
    url: "https://api.site.test/v1/search",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

type Examples = [Record<string, unknown>] | [Record<string, unknown>, Record<string, unknown>];
const learn = (exchanges: Exchange[], examples: Examples, extra: Partial<Parameters<typeof learnOperation>[0]> = {}) =>
  learnOperation({
    exchanges,
    examples,
    cookies: [],
    name: "op",
    trigger: { url: "https://site.test/" },
    readOnly: true,
    ...extra,
  });

// readable by page script, as a cookie a page copies into a request to api.site.test must be
const cookie = (name: string, value: string): StoredCookie => ({
  name,
  value,
  domain: "site.test",
  path: "/",
  expires: -1,
  httpOnly: false,
  secure: false,
});

/* ------------------------------------------------------- repeated keys */

test("a repeated JSON key is refused where a slot would go, in any occurrence, and is a constant otherwise", () => {
  const SID = "q2Fz9kLmT0vXYb7NcW1pReHs3JuQa8Df";
  const refused: [string, string, Parameters<typeof learn>[2]?][] = [
    // a credential by its name, in both occurrences and in the later one only
    ["token", `{"q":"nasa","token":"${A}","token":"${B}"}`],
    ["token", `{"q":"nasa","token":"x","token":"${B}"}`],
    // the later occurrence is an object: its leaves are not at the first one's path either
    ["auth", `{"q":"nasa","auth":1,"auth":{"token":"${B}"}}`],
    // a cookie and a stored value, whichever occurrence holds it
    ["n", `{"q":"nasa","n":"${SID}","n":"x"}`, { cookies: [cookie("sid", SID)] }],
    ["n", `{"q":"nasa","n":"x","n":"${SID}"}`, { cookies: [cookie("sid", SID)] }],
    ["n", `{"q":"nasa","n":1,"n":"solarized-dark"}`, { storage: { theme: "solarized-dark" } }],
    // the param itself, and a second copy of it
    ["q", '{"q":"nasa","q":"other"}'],
    ["k", '{"q":"nasa","k":"x","k":"nasa"}'],
    // a persisted-query id: a rescan would rewrite the first occurrence only
    ["doc_id", '{"q":"nasa","doc_id":"1234567890123","doc_id":"1234567890124"}'],
  ];
  for (const [name, body, extra] of refused)
    assert.throws(
      () => learn([post(body)], [{ q: "nasa" }], extra),
      new RegExp(`repeats a key \\(body > json:/${name}\\) where a param or a session value goes`),
      body,
    );
  // in JSON inside a string too
  assert.throws(
    () => learn([post(JSON.stringify({ q: "nasa", vars: `{"token":"x","token":"${B}"}` }))], [{ q: "nasa" }]),
    /repeats a key \(body > json:\/vars > json:\/token\)/,
  );
  // a repeated key that is no slot and holds none is sent as captured, byte for byte
  for (const body of ['{"q":"nasa","limit":1,"limit":2}', '{"q":"nasa","meta":{},"meta":{"a":[1]},"x":"y","x":"y"}']) {
    const { operation: op } = learn([post(body)], [{ q: "nasa" }], { public: ["limit"] });
    assert.deepEqual(op.slots, [{ param: "q", at: ["body", "json:/q"] }]);
    assert.equal(buildRequest(op, { q: "mars" }, { cookies: [], values: {} }).body, body.replace("nasa", "mars"));
  }
  // control: a repeated query key has a position of its own
  const { operation: op } = learn(
    [xhr({ url: `https://api.site.test/v1/search?q=nasa&t=${A}&t=${B}` })],
    [{ q: "nasa" }],
  );
  assert.equal(
    new URL(buildRequest(op, { q: "mars" }, { cookies: [], values: {} }).url).search,
    `?q=mars&t=${A}&t=${B}`,
  );
});

/* ------------------------------------------------------------- public */

test("a name marked public keeps no per-session field, no cookie and no stored value literal", () => {
  const SID = "q2Fz9kLmT0vXYb7NcW1pReHs3JuQa8Df";
  const NEXT = "Zx9Qw8vLm7Kj6HgF5dS4aP3oI2uY1tRe";
  const ex = xhr({
    // token: a per-session field by name; sv: equal to a stored credential; theme: equal to a stored setting
    url: `https://api.site.test/v1/search?q=kittens&token=${A}&sv=${B}&theme=solarized-dark`,
    // x-app: equal to a cookie; x-ctx: a cookie inside a longer leaf
    headers: { "x-app": SID, "x-ctx": `v1:${SID}`, cookie: `sid=${SID}` },
  });
  const input = { cookies: [cookie("sid", SID)], storage: { cached: B, theme: "solarized-dark" } };
  const names = ["sv", "theme", "token", "x-app", "x-ctx"];
  // control: each of the five is a reference when nobody says otherwise
  assert.deepEqual(
    learn([ex], [{ q: "kittens" }], input)
      .operation.slots.flatMap((s) => (s.ref ? [s.at[0]!.split(":")[1]] : []))
      .sort(),
    names,
  );
  const { operation: op, sessionValues } = learn([ex], [{ q: "kittens" }], { ...input, public: names });
  // Every one of them is a reference under a public name too, as it was before this file's fixes:
  // the mark keeps a header by its name and a credential-like name literal, nothing else.
  assert.deepEqual(op.slots, [
    { param: "q", at: ["query:q"] },
    { ref: "session:op/cached", at: ["query:sv"] },
    { ref: "session:op/theme", at: ["query:theme"] },
    { ref: "cookie:sid", at: ["header:x-app"] },
    { ref: "session:op/token", at: ["query:token"] },
    { ref: "cookie:sid", at: ["header:x-ctx"], template: "v1:{cookie:sid}" },
  ]);
  assert.deepEqual(sessionValues, { "op/cached": B, "op/theme": "solarized-dark", "op/token": A });
  assert.deepEqual(op.public, names);
  for (const live of [SID, A, B]) assert.ok(!JSON.stringify(op).includes(live), `${live} is in the spec`);
  // ...so a replay follows the jar after the cookie rotates
  const r = buildRequest(op, { q: "cats" }, { cookies: [cookie("sid", NEXT)], values: sessionValues });
  assert.equal(r.url, `https://api.site.test/v1/search?q=cats&token=${A}&sv=${B}&theme=solarized-dark`);
  assert.deepEqual([r.headers["x-app"], r.headers["x-ctx"]], [NEXT, `v1:${NEXT}`]);
});

test("a per-session field marked public is saved and exported as a reference, with no cookie or storage behind it", async () => {
  const short = "aB3dEf9hK2";
  const requests: [string, Parameters<typeof xhr>[0]][] = [
    ["query:token", { url: `${local}?q=kittens&token=${short}` }],
    [
      "form:token",
      {
        method: "POST",
        url: local,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `q=kittens&token=${short}`,
      },
    ],
    [
      "body > json:/token",
      {
        method: "POST",
        url: local,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: "kittens", token: short }),
      },
    ],
    // a short stored value inside the field: too short to cut out, so the whole field is the reference
    ["query:token", { url: `${local}?q=kittens&token=prefix:${short}:suffix` }],
  ];
  for (const [at, request] of requests) {
    const storage = request.url.includes("prefix") ? { cache: short } : undefined;
    const site = `public-token-${nextId}`;
    const { operation: op } = await add(site, xhr(request), [], storage, ["token"]);
    assert.deepEqual(op.slots.at(-1), { ref: "session:op/token", at: at.split(" > ") }, at);
    const exported = exportSite(site);
    for (const spec of [op, exported.spec])
      assert.ok(!JSON.stringify(spec).includes(short), `${at}: the token is in the saved or exported spec`);
  }
});

/* ------------------------------------------------ a hole has no transform */

test("a cookie sitting unquoted or URL-decoded next to an arg in one leaf is refused, not left literal", () => {
  const bare = "ajax:4815162342108151623";
  const encoded = "eyJpdiI6IkFCQ0RFRkdISUpLTE1OT1AiLCJ2YWx1ZSI6Ing9In0%3D";
  const SID = "q2Fz9kLmT0vXYb7NcW1pReHs3JuQa8Df";
  const cookies = [cookie("JSESSIONID", `"${bare}"`), cookie("XSRF-TOKEN", encoded), cookie("sid", SID)];
  const run = (ctx: string, example: Record<string, unknown> = { q: "nasa" }) =>
    learn([xhr({ url: "https://api.site.test/v1/search?q=nasa", headers: { "x-ctx": ctx } })], [example], { cookies });

  assert.throws(
    () => run(`user=nasa;auth=${bare}`),
    /header:x-ctx holds cookie:JSESSIONID without its quotes.*credential.*Not learned: learn another request .*--pick-request/,
  );
  assert.throws(
    () => run(`user=nasa;xsrf=${decodeURIComponent(encoded)}`),
    /header:x-ctx holds cookie:XSRF-TOKEN URL-decoded.*credential/,
  );
  // the same in a leaf no param is in: only one of its credentials can be transformed when filled
  assert.throws(
    () => run(`${bare}:${decodeURIComponent(encoded)}`),
    /header:x-ctx holds cookie:XSRF-TOKEN URL-decoded/,
  );

  // control: a copy as stored is a hole, and an unquoted copy alone in its leaf is a ref with a transform
  for (const ctx of [`user=nasa;auth="${bare}";s=${SID}`, `v1:${bare}`]) {
    const { operation: op } = run(ctx);
    assert.ok(!JSON.stringify(op).includes(bare) && !JSON.stringify(op).includes(SID), JSON.stringify(op.slots));
    assert.equal(buildRequest(op, { q: "nasa" }, { cookies, values: {} }).headers["x-ctx"], ctx);
  }

  // another cookie holds the same text as stored: it fills the hole exactly, whatever the jar's order
  const both = [cookie("quoted", `"${SID}"`), cookie("raw", SID)];
  const exact = learn(
    [xhr({ url: "https://api.site.test/v1/search?q=nasa", headers: { "x-ctx": `q=nasa;auth=${SID}` } })],
    [{ q: "nasa" }],
    { cookies: both },
  ).operation;
  assert.deepEqual(exact.slots.at(-1), {
    param: "q",
    at: ["header:x-ctx"],
    template: "q={q};auth={cookie:raw}",
  });
  assert.equal(
    buildRequest(exact, { q: "mars" }, { cookies: both, values: {} }).headers["x-ctx"],
    `q=mars;auth=${SID}`,
  );
});

/* --------------------------------------------------- one name, one value */

test("a stored value found inside a longer leaf never takes over another credential's name", () => {
  // storage calls A "token"; the request's own token field holds B, and A rides inside other leaves
  const bodies = [
    { q: "kittens", token: B, ctx: `v1:${A}`, again: `v2:${A}` },
    { q: "kittens", token: B, next: `/search?q=kittens&t=${A}` },
  ];
  for (const body of bodies) {
    const { operation: op, sessionValues } = learn([post(JSON.stringify(body))], [{ q: "kittens" }], {
      storage: { token: A },
    });
    assert.ok(!JSON.stringify(op).includes(A) && !JSON.stringify(op).includes(B));
    assert.deepEqual(Object.values(sessionValues).sort(), [B, A], "each value is stored once, under its own name");
    const r = buildRequest(op, { q: "kittens" }, { cookies: [], values: sessionValues });
    assert.deepEqual(JSON.parse(r.body!), body);
  }
});

/* ------------------------------------------------------- no overlapping */

// A container that is a session value (a JSON header named like a credential, a JSON value a cookie
// or the page's storage holds) is sent whole from the session. Nothing of it is in the spec: not a
// key, not a short leaf, in no encoding.
const OPAQUE = "k7Qm9xLp3Rv8Tz1Wn5Ys6Ub4Hc2Jd0Fa";
const local = "http://127.0.0.1/api/search";
const csrf = (value: unknown, url = `${local}?q=kittens`) =>
  xhr({ url, headers: { "x-csrf-token": JSON.stringify(value) } });
const posted = (body: string, url = local) =>
  xhr({ method: "POST", url, headers: { "content-type": "application/json" }, body });
const capture = (ex: Exchange, cookies: StoredCookie[], storage?: Record<string, string>): CaptureFile => ({
  id: `overlap-${ex.id}`,
  at: new Date().toISOString(),
  url: "http://127.0.0.1/?q=kittens",
  finalUrl: "http://127.0.0.1/?q=kittens",
  exchanges: [ex],
  cookies,
  ...(storage ? { storage } : {}),
});
const add = (site: string, ex: Exchange, cookies: StoredCookie[], storage?: Record<string, string>, pub?: string[]) =>
  addOperation({
    site,
    op: "op",
    trigger: { url: "http://127.0.0.1/?q={q}" },
    examples: [{ q: "kittens" }],
    from: { capture: capture(ex, cookies, storage) },
    ...(pub ? { public: pub } : {}),
  });
const savedBody = JSON.stringify({ q: "kittens", stamp: "aB3dE" });
const bodyCookie = [cookie("last", encodeURIComponent(savedBody))];
// a cookie of the host these requests go to: a replay finds it in the jar
const here = (name: string, value: string): StoredCookie => ({ ...cookie(name, value), domain: "127.0.0.1" });

test("a param inside a container that is a session value refuses the learn, and nothing is saved", async () => {
  const short = [cookie("sess", "aB3dE")];
  const whole = { q: "kittens", [OPAQUE]: "v1" };
  // keys that would keep the cookie's text in the spec if any part of the container were serialized:
  // the cookie as it is, percent-encoded, in base64, with text after it, in base64 twice
  const keys = ["aB3dE", "%61%42%33%64%45", "YUIzZEU=", "aB3dEx", "aB3dE:1", "aB3dEabcd", "%61%42%33%64%45x"];
  const cases: [string, Exchange, StoredCookie[], Record<string, string>?][] = [
    ...[...keys, "YUIzZEV4", "WVVJelpFVT0="].map((k): [string, Exchange, StoredCookie[]] => [
      `the key ${k}`,
      csrf({ q: "kittens", [k]: "v1" }),
      short,
    ]),
    ["an opaque key", csrf(whole), []],
    ["a short cookie beside the param", csrf({ q: "kittens", stamp: "aB3dE" }), short],
  ];
  const before = readdirSync(HOME, { recursive: true }).sort();
  for (const [what, ex, cookies, storage] of cases) {
    const at = ex.request.body ? "body" : "header:x-csrf-token";
    const refusal = new RegExp(
      `^Error: ${at} is a session value \\(.*\\), sent whole .* the param q inside it \\(${at} > json:/q\\) could not be filled` +
        `.* --public ${at.replace("header:", "")}; otherwise learn another request`,
    );
    assert.throws(() => learn([ex], [{ q: "kittens" }], { cookies, storage }), refusal, what);
    await assert.rejects(add("overlap", ex, cookies, storage), refusal, what);
  }
  assert.deepEqual(readdirSync(HOME, { recursive: true }).sort(), before, "a refused add writes nothing");
});

// --public is the caller's word about a name. It turns off the rules that go by the name, so a
// container that was a session value by its header's name stays as captured. A cookie or a stored
// value is a reference under any name, whatever the value looks like.
test("marked public, a container that is in no cookie and no storage stays as captured and its param is filled", async () => {
  const short = [cookie("sess", "aB3dE")];
  const header = await add("public-header", csrf({ q: "kittens", aB3dE: "v1" }), short, undefined, ["x-csrf-token"]);
  assert.deepEqual(header.operation.slots, [
    { param: "q", at: ["query:q"] },
    { param: "q", at: ["header:x-csrf-token", "json:/q"] },
  ]);
  assert.equal(
    buildRequest(header.operation, { q: "puppies" }, noSession).headers["x-csrf-token"],
    '{"q":"puppies","aB3dE":"v1"}',
  );
});

test("under a public name a stored value is a reference, whatever it looks like", async () => {
  // none of these reads as a credential by its storage key or its shape: that is no proof it is none
  const cases: [string, Record<string, string>, string, string][] = [
    ["authorization", { authorization: `Bearer ${A}` }, `Bearer ${A}`, "cache"],
    ["x-app", { "x-app": "aB3dEf9hK2" }, "aB3dEf9hK2", "cache"],
    ["x-app", { "x-app": '{"token":"aB3dE4x"}' }, '{"token":"aB3dE4x"}', "cache"],
    ["x-app", { "x-app": "aB3dEf9hK2" }, '{"access":"aB3dEf9hK2"}', "cache/access"],
    // a setting the page keeps is one too, as it is under any other name
    ["x-theme", { "x-theme": "solarized-dark" }, "solarized-dark", "cache"],
  ];
  for (const [name, headers, cache, ref] of cases) {
    const ex = () => xhr({ url: `${local}?q=kittens`, headers });
    const input = { storage: { cache }, public: [name] };
    const learned = learn([ex()], [{ q: "kittens" }], input);
    const { sessionValues } = learned;
    for (const { operation: op } of [learned, await add(`stored-${nextId}`, ex(), [], input.storage, input.public)]) {
      assert.deepEqual(op.slots.at(-1), { ref: `session:op/${ref}`, at: [`header:${name}`] }, cache);
      assert.equal(op.request.headers[name], "");
      assert.ok(!JSON.stringify(op).includes(headers[name]!.replace(/"/g, '\\"')), `${cache} is in the spec`);
      assert.equal(
        buildRequest(op, { q: "puppies" }, { cookies: [], values: sessionValues }).headers[name],
        headers[name],
      );
    }
  }
});

test("a live cookie inside a public container is a reference, and one no pass can make a reference is refused", async () => {
  const jar = [here("sid", A)];
  const rotated = { cookies: [here("sid", B)], values: {} };
  // a public header: the param and the cookie beside it are both filled, the rest is as captured
  const value = { q: "kittens", token: A, flag: true };
  for (const { operation: op } of [
    learn([csrf(value)], [{ q: "kittens" }], { cookies: jar, public: ["x-csrf-token"] }),
    await add("public-live-header", csrf(value), jar, undefined, ["x-csrf-token"]),
  ]) {
    assert.deepEqual(op.slots, [
      { param: "q", at: ["query:q"] },
      { param: "q", at: ["header:x-csrf-token", "json:/q"] },
      { ref: "cookie:sid", at: ["header:x-csrf-token", "json:/token"] },
    ]);
    assert.ok(!JSON.stringify(op).includes(A), "the cookie is in the spec");
    assert.equal(
      buildRequest(op, { q: "puppies" }, rotated).headers["x-csrf-token"],
      JSON.stringify({ q: "puppies", token: B, flag: true }),
    );
  }

  // too short to be a reference, or in base64: the caller's word does not let a live cookie stay
  const before = readdirSync(HOME, { recursive: true }).sort();
  const stuck: [Record<string, string>, StoredCookie][] = [
    [{ stamp: "aB3dE4x" }, here("sess", "aB3dE4x")],
    [{ stamp: Buffer.from(A).toString("base64") }, here("sess", A)],
  ];
  for (const [inner, c] of stuck) {
    const ex = csrf({ q: "kittens", ...inner });
    const refusal = /keep a credential in the spec: header:x-csrf-token > json:\/stamp holds the live cookie sess\./;
    assert.throws(() => learn([ex], [{ q: "kittens" }], { cookies: [c], public: ["x-csrf-token"] }), refusal);
    await assert.rejects(add("public-stuck", ex, [c], undefined, ["x-csrf-token"]), refusal);
  }
  assert.deepEqual(readdirSync(HOME, { recursive: true }).sort(), before, "a refused add writes nothing");
});

test("a container that is a cookie or a stored value as a whole is sent whole under a public name too", async () => {
  const state = { q: "kittens", lang: "en" };
  // a cookie as the page decodes it, in a header and as a body; a body the page keeps in storage,
  // under a credential's name or any other
  const cases: [string, Exchange, StoredCookie[], Record<string, string>?][] = [
    ["header:x-csrf-token", csrf(state), [cookie("ctx", encodeURIComponent(JSON.stringify(state)))]],
    ["body", posted(savedBody), bodyCookie],
    ["body", posted(savedBody), [], { token: savedBody }],
    ["body", posted(savedBody), [cookie("sess", "aB3dE")], { savedRequest: savedBody }],
  ];
  const before = readdirSync(HOME, { recursive: true }).sort();
  for (const [at, ex, cookies, storage] of cases) {
    // marking it public would change nothing, so the refusal does not offer that
    const refusal = new RegExp(
      `^Error: ${at} is a session value \\(.*\\), sent whole .* the param q inside it \\(${at} > json:/q\\) could not be filled\\. ` +
        "Not learned: learn another request",
    );
    for (const pub of [undefined, [at.replace("header:", "")]]) {
      assert.throws(() => learn([ex], [{ q: "kittens" }], { cookies, storage, public: pub }), refusal, `${at} ${pub}`);
      await assert.rejects(add("overlap", ex, cookies, storage, pub), refusal, `${at} ${pub}`);
    }
  }
  assert.deepEqual(readdirSync(HOME, { recursive: true }).sort(), before, "a refused add writes nothing");
});

test("a container that is a session value with only refs inside is one ref, and none of its text is in the spec", () => {
  const SID = "q2Fz9kLmT0vXYb7NcW1pReHs3JuQa8Df";
  const cookies = [cookie("sid", SID), cookie("sess", "aB3dE")];
  const absent = (op: ReturnType<typeof learn>["operation"], texts: string[]) => {
    for (const text of texts) assert.ok(!JSON.stringify(op).includes(text), `${text} is in the spec`);
  };

  // a header named like a credential: a cookie, an opaque key and a short cookie inside it
  const value = { sid: SID, [OPAQUE]: "leafValue42", innerKey9: { stamp: "aB3dE" } };
  const header = learn([csrf(value)], [{ q: "kittens" }], { cookies });
  assert.deepEqual(header.operation.slots, [
    { param: "q", at: ["query:q"] },
    { ref: "session:op/x-csrf-token", at: ["header:x-csrf-token"] },
  ]);
  assert.equal(header.operation.request.headers["x-csrf-token"], "");
  assert.deepEqual(header.sessionValues, { "op/x-csrf-token": JSON.stringify(value) });
  absent(header.operation, [SID, OPAQUE, "leafValue42", "innerKey9", "stamp", "aB3dE"]);
  const session = { cookies, values: header.sessionValues };
  assert.equal(
    buildRequest(header.operation, { q: "puppies" }, session).headers["x-csrf-token"],
    JSON.stringify(value),
  );

  // a body the page's storage holds whole: a live field, a per-session field and a query id under an opaque key
  const body = JSON.stringify({ sid: SID, csrf: "Ab3dEf9h", [OPAQUE]: { doc_id: "123456789012" } });
  const stored = learn([posted(body, `${local}?q=kittens`)], [{ q: "kittens" }], {
    cookies,
    storage: { savedRequest: body },
  });
  assert.deepEqual(stored.operation.slots, [
    { param: "q", at: ["query:q"] },
    { ref: "session:op/savedRequest", at: ["body"] },
  ]);
  assert.equal(stored.operation.request.body, "");
  assert.deepEqual(stored.operation.volatile, []);
  assert.deepEqual(stored.sessionValues, { "op/savedRequest": body });
  absent(stored.operation, [SID, OPAQUE, "Ab3dEf9h", "doc_id", "123456789012"]);
  assert.equal(buildRequest(stored.operation, { q: "puppies" }, { cookies, values: stored.sessionValues }).body, body);
});

test("a body that is no session value takes a param as it always did", () => {
  // the same body as the saved one, with no copy in storage: an ordinary request body
  const { operation: op } = learn([posted(savedBody)], [{ q: "kittens" }], { cookies: [cookie("sess", "aB3dE")] });
  assert.deepEqual(op.slots, [{ param: "q", at: ["body", "json:/q"] }]);
  assert.equal(buildRequest(op, { q: "puppies" }, noSession).body, '{"q":"puppies","stamp":"aB3dE"}');
});

test("a path segment that is a reference is a wildcard in the match, as a param's is", () => {
  // the session id rides in the path, with a dot so it does not look like a hash on its own
  const first = "u1.q2Fz9kLmT0vXYb7NcW1pReHs3JuQa8Df";
  const next = "u1.Zx9Qw8vLm7Kj6HgF5dS4aP3oI2uY1tRe";
  const run = (sid: string, q: string) => [
    xhr({ url: `https://api.site.test/api/${sid}/search?q=${q}`, headers: { cookie: `sid=${sid}` } }),
  ];
  const captured = run(first, "kittens");
  const { operation: op, warnings } = learn(captured, [{ q: "kittens" }, { q: "puppies" }], {
    cookies: [cookie("sid", first)],
    exchanges2: run(next, "puppies"),
  });
  assert.deepEqual(
    op.slots.find((s) => s.ref),
    { ref: "cookie:sid", at: ["path:1"] },
  );
  assert.equal(op.match.path, "/api/*/search");
  assert.ok(matches(op.match, captured[0]!.request), "the match must fit the request it was learned from");
  assert.ok(!warnings.some((w) => /no matching request/.test(w)), warnings.join("\n"));
  assert.equal(
    buildRequest(op, { q: "cats" }, { cookies: [cookie("sid", next)], values: {} }).url,
    `https://api.site.test/api/${next}/search?q=cats`,
  );
});

/* ------------------------------------------------- query-id field names */

test("a cookie or stored value is a reference under a persisted-query field name too", () => {
  const body = (fields: Record<string, unknown>) => [
    xhr({
      method: "POST",
      url: "http://localhost/v1/search",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "kittens", ...fields }),
    }),
  ];
  // A token the page stores and sends as queryId reads exactly like a query id it caches there:
  // the field's name decides nothing about a value that is known to be live.
  for (const name of ["queryId", "doc_id", "sha256Hash", "hash"]) {
    const at = ["body", `json:/${name}`];
    const inside = learn(body({ [name]: `v1:${A}` }), [{ q: "kittens" }], { storage: { token: A } });
    assert.ok(!JSON.stringify(inside.operation).includes(A), `${name}: the stored token stayed in the spec`);
    assert.deepEqual(inside.operation.slots.at(-1), { ref: "session:op/token", at, template: "v1:{session:op/token}" });
    assert.deepEqual(inside.sessionValues, { "op/token": A });
    assert.equal(JSON.parse(inside.operation.request.body!)[name], "");

    const whole = learn(body({ [name]: A }), [{ q: "kittens" }], { storage: { token: A } });
    assert.deepEqual(whole.operation.slots.at(-1), { ref: "session:op/token", at });
    const jar = learn(body({ [name]: `v1:${A}` }), [{ q: "kittens" }], { cookies: [cookie("sid", A)] });
    assert.deepEqual(jar.operation.slots.at(-1), { ref: "cookie:sid", at, template: "v1:{cookie:sid}" });
    // too short to template: the check refuses it there as anywhere else
    assert.throws(
      () => learn(body({ [name]: "v1:secret123" }), [{ q: "kittens" }], { cookies: [cookie("sess", "secret123")] }),
      new RegExp(`body > json:/${name} holds the live cookie sess`),
    );
  }

  // so a hash the app keeps in storage is a reference as well, whatever it is kept as
  const hash = "e0f2a1b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f";
  const persisted = { extensions: { persistedQuery: { version: 1, sha256Hash: hash } } };
  const stores: [Record<string, string>, string][] = [
    [{ "pq:Search": hash }, "session:op/pq:Search"],
    [{ "apollo-cache": JSON.stringify({ Search: { id: hash } }) }, "session:op/apollo-cache/Search/id"],
  ];
  for (const [storage, ref] of stores) {
    const { operation: op } = learn(body(persisted), [{ q: "kittens" }], { storage });
    assert.deepEqual(op.slots.at(-1), { ref, at: ["body", "json:/extensions/persistedQuery/sha256Hash"] });
    assert.deepEqual(op.volatile, []);
    assert.ok(!JSON.stringify(op).includes(hash));
  }
  // control: a query id that is in no cookie and no storage stays a volatile anchor
  const { operation: plain } = learn(body(persisted), [{ q: "kittens" }], { storage: { theme: "dark-mode" } });
  assert.deepEqual(plain.slots, [{ param: "q", at: ["body", "json:/q"] }]);
  assert.deepEqual(
    plain.volatile.map((v) => v.at),
    [["body", "json:/extensions/persistedQuery/sha256Hash"]],
  );
  assert.ok(plain.request.body!.includes(hash), "the hash stays in the template for the cheap heal to swap");
});

/* ------------------------------------------- the check behind every pass */

test("learning refuses a request it could not clear of a live value, in any encoding the save scan reads", () => {
  const SID = "q2Fz9kLmT0vXYb7NcW1pReHs3JuQa8Df";
  const cases: [string, StoredCookie, Record<string, unknown>][] = [
    ["a cookie too short to template, inside a longer leaf", cookie("sess", "secret123"), { ctx: "v1:secret123" }],
    ["a cookie in base64", cookie("sid", SID), { state: Buffer.from(`sid=${SID}`).toString("base64") }],
    [
      // base64 with / and + all through it: no stretch of it is left as it was for a pass to take out
      "a cookie percent-encoded twice",
      cookie("sid", "q2Fz9kLm/T0vX+Yb7N/cW1pReHs="),
      { next: encodeURIComponent(`/cb?s=${encodeURIComponent("q2Fz9kLm/T0vX+Yb7N/cW1pReHs=")}`) },
    ],
  ];
  for (const [label, c, fields] of cases) {
    assert.throws(
      () => learn([post(JSON.stringify({ q: "kittens", ...fields }))], [{ q: "kittens" }], { cookies: [c] }),
      new RegExp(
        `keep a credential in the spec: body > json:/${Object.keys(fields)[0]} holds the live cookie ${c.name}\\.`,
      ),
      label,
    );
  }
  // where an unbroken token is one part of the cookie (`<token>/=`, `<token>@$`), that part is a reference: the
  // token is in no spec
  for (const rest of ["/=", "@$"]) {
    const twice = encodeURIComponent(`/cb?s=${encodeURIComponent(SID + rest)}`);
    const part = learn([post(JSON.stringify({ q: "kittens", next: twice }))], [{ q: "kittens" }], {
      cookies: [cookie("sid", SID + rest)],
    });
    assert.ok(!JSON.stringify(part.operation).includes(SID), JSON.stringify(part.operation));
    assert.deepEqual(part.sessionValues, { "op/sid": SID });
    assert.equal(
      JSON.parse(buildRequest(part.operation, { q: "x" }, { cookies: [], values: part.sessionValues }).body!).next,
      twice,
    );
  }
  // a session value the learner found by name counts too, where no pass reaches its second copy
  assert.throws(
    () => learn([post(JSON.stringify({ q: "kittens", csrf: "Ab3dEf9h", ctx: "v1:Ab3dEf9h" }))], [{ q: "kittens" }]),
    /keep a credential in the spec: body > json:\/ctx holds the live session value csrf\./,
  );
  // ...and marking the per-session name public changes nothing: it is a reference all the same
  assert.throws(
    () =>
      learn([post(JSON.stringify({ q: "kittens", csrf: "Ab3dEf9h", ctx: "v1:Ab3dEf9h" }))], [{ q: "kittens" }], {
        public: ["csrf", "ctx"],
      }),
    /body > json:\/ctx holds the live session value csrf\. No name marked public waives one/,
  );
  // a cookie is one under any name: the header that holds it is refused though marked public
  const held = xhr({ url: "https://api.site.test/v1/search?q=kittens", headers: { "x-ctx": "v1:secret123" } });
  assert.throws(
    () => learn([held], [{ q: "kittens" }], { cookies: [cookie("sess", "secret123")], public: ["x-ctx"] }),
    /keep a credential in the spec: header:x-ctx holds the live cookie sess\. No name marked public waives one/,
  );
});

test("the scan finds a base64 copy whatever sits before it, and of a value too short to decode on its own", () => {
  const T = "k7Qm9xLp3Rv8Tz1Wn5Ys6Ub4Hc2Jd0Fa";
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const jar = (value: string) => ({ cookies: [cookie("sid", value)], values: {} });
  const found = (text: string, value: string) => scanSecrets({ state: text }, jar(value)).secrets.length > 0;

  // six characters encode to eight, under the length at which a run is decoded as one
  assert.equal(b64("aB3dE4"), "YUIzZEU0");
  assert.ok(found("YUIzZEU0", "aB3dE4"), "the short value's own encoding");
  // text in front of the encoding shifts what decoding the whole run gives
  assert.ok(found(`prefix${b64(T)}`, T), "after a prefix");
  // the value at each byte offset inside encoded text, in both alphabets
  for (const lead of ["", "x", "xy"]) {
    const inside = b64(`${lead}aB3dE4??>>tail`);
    assert.ok(found(inside, "aB3dE4??>>"), `standard alphabet, offset ${lead.length}: ${inside}`);
    assert.ok(
      found(inside.replace(/\+/g, "-").replace(/\//g, "_"), "aB3dE4??>>"),
      `URL-safe alphabet, offset ${lead.length}`,
    );
  }
  // control: other base64 text, and the encoding of a different value
  assert.ok(!found(b64("nothing to see here, move along"), "aB3dE4"));
  assert.ok(!found(b64("aB3dE5"), "aB3dE4"));

  // and learning refuses both of the reviewer's cases
  for (const [value, state] of [
    ["aB3dE4", "YUIzZEU0"],
    [T, `prefix${b64(T)}`],
  ] as const)
    assert.throws(
      () =>
        learn([post(JSON.stringify({ q: "kittens", state }))], [{ q: "kittens" }], { cookies: [cookie("sid", value)] }),
      /keep a credential in the spec: body > json:\/state holds the live cookie sid\./,
    );
});

test("the scan reports a base64 copy only when the bytes there are the value's", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const jar = (value: string) => ({ cookies: [cookie("sid", value)], values: {} });
  const found = (text: string, value: string) => scanSecrets({ cursor: text }, jar(value)).secrets.length > 0;

  // "xqbcdef" shares every character of abcdef's encoding that does not touch a neighbour: only
  // the first byte's top bits differ, and those sit in a character the value shares with what precedes it
  assert.equal(Buffer.from("eHFiY2RlZg==", "base64").toString(), "xqbcdef");
  assert.ok(!found("eHFiY2RlZg==", "abcdef"), "another value with the same middle");
  // ...and learning the request that carries such a cursor is no longer refused
  const { operation: op } = learn(
    [post(JSON.stringify({ q: "kittens", cursor: "eHFiY2RlZg==" }))],
    [{ q: "kittens" }],
    {
      cookies: [cookie("sid", "abcdef")],
    },
  );
  assert.equal(JSON.parse(op.request.body!).cursor, "eHFiY2RlZg==");

  // every byte beside the value changed in turn: the value itself is found, a neighbour of it never
  const value = "aB3dE4-z";
  for (let lead = 0; lead < 3; lead++) {
    for (let tail = 0; tail < 3; tail++) {
      const around = (v: string) => b64("xy".slice(0, lead) + v + "pq".slice(0, tail));
      assert.ok(found(`id=${around(value)}&n=1`, value), `missed at offset ${lead}, ${tail} byte(s) after`);
      for (let i = 0; i < value.length; i++) {
        const other = value.slice(0, i) + String.fromCharCode(value.charCodeAt(i) ^ 0x10) + value.slice(i + 1);
        assert.ok(!found(around(other), value), `flagged ${other} at offset ${lead}, ${tail} byte(s) after`);
      }
    }
  }
});

test("the check knows a stored credential that no pass made a reference, and no stored setting", () => {
  const T = "k7Qm9xLp3Rv8Tz1Wn5Ys6Ub4Hc2Jd0Fa";
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const run = (fields: Record<string, unknown>, extra: Parameters<typeof learn>[2]) =>
    learn([post(JSON.stringify({ q: "kittens", ...fields }))], [{ q: "kittens" }], extra);

  // under a credential's name, and random-looking inside a JSON entry under an ordinary one
  assert.throws(
    () => run({ state: b64(T) }, { storage: { token: T } }),
    /keep a credential in the spec: body > json:\/state holds the live session value storage:token\./,
  );
  assert.throws(
    () => run({ state: b64(T) }, { storage: { cache: JSON.stringify({ user: { id: T } }) } }),
    /body > json:\/state holds the live session value storage:cache\/user\/id\./,
  );
  // A stored value that is one by its storage key's name alone is no ground to refuse a copy no
  // pass could make a reference: the text stays as captured, whichever entry holds it first. The
  // line falls at the value: a short token under `csrf` passes with the theme under `token`.
  const orders: Record<string, string>[] = [
    { saved: "ordinary-value", token: "ordinary-value" },
    { token: "ordinary-value", saved: "ordinary-value" },
    { saved: "ordinary-value", auth: JSON.stringify({ token: "ordinary-value" }) },
  ];
  for (const storage of orders) {
    const kept = run({ state: b64("ordinary-value") }, { storage });
    assert.equal(JSON.parse(kept.operation.request.body!).state, b64("ordinary-value"), JSON.stringify(storage));
  }
  const short = run({ ctx: "v1:Ab3dEf9h" }, { storage: { csrf: "Ab3dEf9h" } });
  assert.equal(JSON.parse(short.operation.request.body!).ctx, "v1:Ab3dEf9h");
  // ...and where the same value can be a reference it is one, as before
  const referenced = run(
    { ctx: "ordinary-value", state: b64("ordinary-value") },
    { storage: { token: "ordinary-value" } },
  );
  assert.deepEqual(referenced.operation.slots.at(-1), { ref: "session:op/token", at: ["body", "json:/ctx"] });

  // a setting is no credential, wherever else it turns up
  const settings = { theme: "dark-mode", prefs: JSON.stringify({ locale: "en-US-posix", tz: "Europe/Berlin" }) };
  const plain = run({ style: "dark-mode-v2", state: b64("en-US-posix|Europe/Berlin") }, { storage: settings });
  assert.deepEqual(plain.operation.slots, [{ param: "q", at: ["body", "json:/q"] }]);
  // ...also once a leaf that equals it has made it a reference: refreshable is not the same as secret
  const locale = "europe-berlin-posix";
  const sent = run({ locale, state: b64(locale) }, { storage: { locale } });
  assert.deepEqual(sent.operation.slots, [
    { param: "q", at: ["body", "json:/q"] },
    { ref: "session:op/locale", at: ["body", "json:/locale"] },
  ]);
  assert.equal(JSON.parse(sent.operation.request.body!).state, b64(locale));
  // but under a credential's name in the request the same stored text is one
  assert.throws(
    () => run({ token: locale, state: b64(locale) }, { storage: { locale } }),
    /holds the live session value locale/,
  );

  // a name marked public exempts no stored credential...
  assert.throws(
    () => run({ state: b64(T) }, { storage: { token: T }, public: ["state"] }),
    /body > json:\/state holds the live session value storage:token\./,
  );
  // ...and no stored setting from being a ref, but the name it is sent under no longer makes it a credential
  const waived = run({ token: locale, state: b64(locale) }, { storage: { locale }, public: ["token"] });
  assert.deepEqual(waived.operation.slots.at(-1), { ref: "session:op/locale", at: ["body", "json:/token"] });
  assert.equal(JSON.parse(waived.operation.request.body!).state, b64(locale));
  // exempt by position: the caller's own example
  const ID = "550e8400-e29b-41d4-a716-446655440000";
  const viewed = learn([xhr({ url: `https://api.site.test/v1/items/${ID}` })], [{ id: ID }], {
    storage: { lastViewed: ID },
  });
  assert.deepEqual(viewed.operation.slots, [{ param: "id", at: ["path:2"] }]);
  // a query-id field name exempts nothing: a stored hash sent there is a ref, and a copy of it elsewhere is found
  const hash = "e0f2a1b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f";
  assert.throws(
    () =>
      run(
        { extensions: { persistedQuery: { sha256Hash: hash } }, state: b64(hash) },
        { storage: { "pq:Search": hash } },
      ),
    /body > json:\/state holds the live session value .*pq:Search/,
  );

  // a container that is a session value is looked for whole, wherever else a copy of it sits
  const whole = JSON.stringify({ n: "ab", m: "cd" });
  const copied = post(JSON.stringify({ q: "kittens", state: b64(whole) }), { "x-csrf-token": whole });
  assert.throws(
    () => learn([copied], [{ q: "kittens" }]),
    /body > json:\/state holds the live session value x-csrf-token\./,
  );
});

test("an encoded copy of a setting stored under a credential's key is kept; of a token or a cookie, refused", async () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const T = "k7Qm9xLp3Rv8Tz1Wn5Ys6Ub4Hc2Jd0Fa";
  const sent = (value: string) => xhr({ url: `${local}?q=kittens&ctx=${encodeURIComponent(b64(value))}` });
  const settings: Record<string, string>[] = [{ token: "solarized-dark" }, { cache: '{"token":"solarized-dark"}' }];
  for (const storage of settings) {
    const site = `setting-${nextId}`;
    const { operation: op } = await add(site, sent("solarized-dark"), [], storage, ["ctx"]);
    assert.deepEqual(op.slots, [{ param: "q", at: ["query:q"] }]);
    assert.deepEqual(exportSite(site).secrets, []);
    assert.equal(
      buildRequest(op, { q: "puppies" }, noSession).url,
      `${local}?q=puppies&ctx=${encodeURIComponent(b64("solarized-dark"))}`,
    );
  }
  const before = readdirSync(HOME, { recursive: true }).sort();
  // the same shape with a value that looks like a credential itself, and with a cookie
  for (const [value, cookies, storage, what] of [
    [T, [], { token: T }, "session value storage:token"],
    [T, [], { cache: JSON.stringify({ token: T }) }, "session value storage:cache/token"],
    ["solarized-dark", [cookie("theme", "solarized-dark")], undefined, "cookie theme"],
  ] as const)
    await assert.rejects(
      add("setting-refused", sent(value), [...cookies], storage, ["ctx"]),
      new RegExp(`query:ctx holds the live ${what}\\.`),
    );
  assert.deepEqual(readdirSync(HOME, { recursive: true }).sort(), before, "a refused add writes nothing");
});

/* --------------------------------------------- the text beside a param */

test("the text beside a param in its leaf is judged by the leaf's name, as a whole leaf would be", () => {
  const T = "k7Qm9xLp3Rv8Tz1Wn5Ys6Ub4Hc2Jd0Fa";
  const search = "https://api.site.test/v1/search?q=";
  // A credential beside the arg cannot be a reference: no later capture could tell where the arg
  // ends and the credential begins. So every shape of it is refused, with the position and what to do.
  const refused: [string, Parameters<typeof xhr>[0]][] = [
    ["header:x-csrf-token", { url: `${search}kittens`, headers: { "x-csrf-token": `kittens.${T}` } }],
    ["query:token", { url: `${search}kittens&token=kittens.${T}` }],
    ["query:api_key", { url: `${search}kittens&api_key=${T}:kittens` }],
    ["query:token", { url: `${search}kittens&token=a1B2c3D4.kittens.${T}` }],
    ["query:token", { url: `${search}kittens&token=kittens${T}` }],
    ["query:token", { url: `${search}kittens&token=https://sso.site.test/${T}/kittens` }],
  ];
  for (const [at, request] of refused) {
    const name = at.slice(at.indexOf(":") + 1);
    assert.throws(
      () => learn([xhr(request)], [{ q: "kittens" }]),
      new RegExp(
        `^Error: ${at} holds a param inside text that is a credential .* --public ${name}; otherwise learn another request`,
      ),
      request.url,
    );
  }
  // ...and the caller's word that the text is public lets it stay
  const marked = learn([xhr(refused[1]![1])], [{ q: "kittens" }], { public: ["token"] });
  assert.deepEqual(marked.operation.slots.at(-1), { param: "q", at: ["query:token"], template: `{q}.${T}` });
  assert.deepEqual(marked.sessionValues, {});

  // an opaque token is one under any name: a UUID beside the arg, under a name that says nothing
  assert.throws(
    () =>
      learn([xhr({ url: `${search}kittens&ctx=kittens|550e8400-e29b-41d4-a716-446655440000` })], [{ q: "kittens" }]),
    /^Error: query:ctx holds a param inside text that is a credential \(an unbroken random-looking run/,
  );

  // every character of the text counts, a NUL the value carries included: nine here, not the seven around them
  assert.throws(
    () => learn([post(JSON.stringify({ q: "kittens", token: "kittens.aB\u0000cD\u0000eF" }))], [{ q: "kittens" }]),
    /^Error: body > json:\/token holds a param inside text that is a credential \(by the leaf's name, token\)/,
  );
  // control: seven characters, NULs counted, are under the rule's eight
  const short = learn([post(JSON.stringify({ q: "kittens", token: "kittens.a\u0000c\u0000eF" }))], [{ q: "kittens" }]);
  assert.equal(short.operation.slots.at(-1)!.template, "{q}.a\u0000c\u0000eF");
});

test("structured text beside a param is no credential, whatever the leaf is called", () => {
  // a name that reads like a credential's, and text long and mixed enough to look random as a whole
  const keys = [
    "search:kittens:page1",
    "query:kittens:page:1:sort:relevance",
    "search:kittens:locale:en-US:v2",
    "search:kittens:page1:sort:updated",
    // words and numbers joined by - or _ are structure too, and so is a path
    "kittens-care-guide-2024-v2",
    "list_kittens_sorted_by_price_desc_v2",
    "/v2/items/kittens/reviews/page/1",
  ];
  for (const cacheKey of keys) {
    const { operation: op, sessionValues } = learn(
      [post(JSON.stringify({ q: "kittens", cache_key: cacheKey }))],
      [{ q: "kittens" }],
    );
    const slot = op.slots.at(-1)!;
    assert.deepEqual(
      [slot.param, slot.at.join(" > "), slot.template],
      ["q", "body > json:/cache_key", cacheKey.replace("kittens", "{q}")],
      cacheKey,
    );
    assert.deepEqual(sessionValues, {});
    assert.deepEqual(JSON.parse(buildRequest(op, { q: "tigers" }, noSession).body!), {
      q: "tigers",
      cache_key: cacheKey.replace("kittens", "tigers"),
    });
  }
});

test("beside a param under an ordinary name, a known live value too short to template is refused by the check", () => {
  const ctx = (value: string) => [
    xhr({ url: "https://api.site.test/v1/search?q=kittens", headers: { "x-ctx": `kittens.${value}` } }),
  ];
  assert.throws(
    () => learn(ctx("secret123"), [{ q: "kittens" }], { cookies: [cookie("sess", "secret123")] }),
    /keep a credential in the spec: header:x-ctx holds the live cookie sess; the template for header:x-ctx holds the live cookie sess\./,
  );
  // a short stored value that is one by its key's name alone stays, as it did before the check existed
  assert.equal(learn(ctx("Ab3dEf9h"), [{ q: "kittens" }], { storage: { csrf: "Ab3dEf9h" } }).operation.slots.length, 2);
  // control: the same leaf with nothing known in it learns
  assert.equal(learn(ctx("Ab3dEf9h"), [{ q: "kittens" }]).operation.slots.length, 2);
});

/* ------------------------------------------- what example 2 disproves */

const noSession = { cookies: [] as StoredCookie[], values: {} as Record<string, string> };
const answer = (q: string) => ({ results: [{ title: `${q} one` }, { title: `${q} two` }] });

test("a place the second example disproves is kept as the constant it is, not filled", () => {
  // "search" is the endpoint's own path segment and the first query; only the query follows in run 2
  const run = (q: string, headers: Record<string, string> = {}) => [
    xhr({ url: `https://site.test/api/search?q=${q}`, headers }, answer(q)),
  ];
  const { operation: op, warnings } = learn(run("search"), [{ q: "search" }, { q: "kitten" }], {
    exchanges2: run("kitten"),
  });
  assert.deepEqual(op.slots, [{ param: "q", at: ["query:q"] }]);
  assert.equal(op.match.path, "/api/search", "the segment is no param, so the match names it");
  assert.equal(buildRequest(op, { q: "puppy" }, noSession).url, "https://site.test/api/search?q=puppy");
  assert.ok(
    warnings.some((w) => /path:1 is "search" in both runs/.test(w)),
    warnings.join("\n"),
  );

  // inside a longer leaf too: the header holds "search" by coincidence and never changes
  const app = { "x-app": "websearch-v2" };
  const templated = learn(run("search", app), [{ q: "search" }, { q: "kitten" }], { exchanges2: run("kitten", app) });
  assert.deepEqual(templated.operation.slots, [{ param: "q", at: ["query:q"] }]);
  assert.equal(buildRequest(templated.operation, { q: "puppy" }, noSession).headers["x-app"], "websearch-v2");

  // a sibling endpoint with the richer answer fits the first match (/api/*) too: run 2 is read on run 1's own path
  const both = (q: string) => [
    ...run(q),
    xhr({ url: `https://site.test/api/suggest?q=${q}` }, { suggestions: Array(40).fill({ text: `${q} and more` }) }),
  ];
  const first = both("search");
  const picked = learn(first, [{ q: "search" }, { q: "kitten" }], { exchanges2: both("kitten"), id: first[0]!.id });
  assert.deepEqual(picked.operation.slots, [{ param: "q", at: ["query:q"] }]);

  // control: one example cannot tell, so both places are filled, with a warning
  const one = learn(run("search"), [{ q: "search" }]);
  assert.equal(one.operation.slots.length, 2);
});

test("a param whose every place the second example disproves is a failure to learn", () => {
  const run = () => [xhr({ url: "https://site.test/api/search?sort=new" }, answer("search"))];
  assert.throws(
    () => learn(run(), [{ q: "search" }, { q: "kitten" }], { exchanges2: run() }),
    /example 2 disproves "q": path:1 is "search" in both runs.*would change nothing/,
  );
});

test("run 2's request is chosen on run 1's evidence: a request that does not answer like it disproves nothing", () => {
  // the path segment is the param; in run 2 the page also pings the first path, which only acknowledges
  const run1 = [xhr({ url: "https://site.test/api/alpha?q=alpha" }, answer("alpha"))];
  const second = (stale: unknown) => [
    xhr({ url: "https://site.test/api/alpha?q=bravo" }, stale),
    xhr({ url: "https://site.test/api/bravo?q=bravo" }, answer("bravo")),
  ];
  const recipe = (e: Exchange) => (e.response?.body ?? "").includes('"results"');
  const cases: [unknown, ((e: Exchange) => boolean) | undefined][] = [
    [{ success: true }, undefined],
    [{ success: true }, recipe],
    // data, but not what the recipe reads
    [{ related: [{ name: "bravo and friends" }, { name: "bravo again" }] }, recipe],
  ];
  for (const [stale, accepts] of cases) {
    const { operation: op } = learn(run1, [{ q: "alpha" }, { q: "bravo" }], { exchanges2: second(stale), accepts });
    assert.deepEqual(op.slots, [
      { param: "q", at: ["path:1"] },
      { param: "q", at: ["query:q"] },
    ]);
    assert.equal(op.match.path, "/api/*");
    assert.equal(buildRequest(op, { q: "charlie" }, noSession).url, "https://site.test/api/charlie?q=charlie");
  }
  // a run 2 with nothing that answers like run 1 is no grounds for dropping a slot
  const alone = learn(run1, [{ q: "alpha" }, { q: "bravo" }], { exchanges2: second({ success: true }).slice(0, 1) });
  assert.equal(alone.operation.slots.length, 2);
  assert.ok(
    alone.warnings.some((w) => /run 2's matching request .* disproves nothing/.test(w)),
    alone.warnings.join("\n"),
  );
});

test("a run 2 request with no answer, or an error for one, is no data answer and disproves nothing", () => {
  const run1 = [xhr({ url: "https://site.test/api/kittens?q=kittens" }, answer("kittens"))];
  const stale = xhr({ url: "https://site.test/api/kittens?q=puppies" });
  const fresh = xhr({ url: "https://site.test/api/puppies?q=puppies" }, answer("puppies"));
  const unanswered: Exchange = { ...stale, response: undefined };
  const failed: Exchange = {
    ...stale,
    response: { ...stale.response!, status: 404, body: '{"error":"no such list"}' },
  };
  for (const old of [unanswered, failed]) {
    const { operation: op } = learn(run1, [{ q: "kittens" }, { q: "puppies" }], { exchanges2: [old, fresh] });
    assert.deepEqual(op.slots, [
      { param: "q", at: ["path:1"] },
      { param: "q", at: ["query:q"] },
    ]);
    assert.equal(buildRequest(op, { q: "tigers" }, noSession).url, "https://site.test/api/tigers?q=tigers");
    // alone, it may show a nonce but takes no slot away
    const alone = learn(run1, [{ q: "kittens" }, { q: "puppies" }], { exchanges2: [old] });
    assert.equal(alone.operation.slots.length, 2);
  }
});

test("a read the caller pinned whose own answer is a flag is its own counterpart in run 2", () => {
  // "is this liked?" answers {"liked":true}: no data by the ranking's lights, and the op all the same
  const liked = (id: number) => [xhr({ url: `https://site.test/api/liked?id=${id}&v=42` }, { liked: true })];
  const { operation: op, warnings } = learn(liked(42), [{ id: 42 }, { id: 43 }], {
    exchanges2: liked(43),
    match: { path: "/api/liked" },
  });
  assert.deepEqual(op.slots, [{ param: "id", at: ["query:id"] }]);
  assert.ok(!warnings.some((w) => /disproves nothing/.test(w)), warnings.join("\n"));
});

/* ------------------------------------------------------ short examples */

// The visitor's own country rides along as gl=US on every request, whatever country is asked for.
const byCountry = (c: string) => [
  xhr({ url: "https://api.site.test/v1/geo?gl=US" }, { stores: Array(60).fill({ city: "Springfield", open: true }) }),
  xhr({ url: `https://api.site.test/v1/top?country=${c}&gl=US&lang=en-${c}` }, answer(`top in ${c}`)),
];

test("a short example is placed where a whole leaf equals it and follows a different second example", () => {
  const { operation: op, exchange } = learn(byCountry("US"), [{ q: "US" }, { q: "CA" }], {
    exchanges2: byCountry("CA"),
  });
  assert.equal(new URL(exchange.request.url).pathname, "/v1/top", "the request whose leaf follows, not the bigger one");
  assert.deepEqual(op.slots, [{ param: "q", at: ["query:country"] }]);
  assert.equal(
    buildRequest(op, { q: "DE" }, noSession).url,
    "https://api.site.test/v1/top?country=DE&gl=US&lang=en-US",
  );

  // a page number: a JSON number beside another 2 that is no page
  const page = (n: number) => [post(JSON.stringify({ q: "kittens", page: n, size: 2 }))];
  const paged = learn(
    page(2),
    [
      { q: "kittens", page: 2 },
      { q: "kittens", page: 3 },
    ],
    { exchanges2: page(3) },
  );
  assert.deepEqual(paged.operation.slots, [
    { param: "q", at: ["body", "json:/q"] },
    { param: "page", at: ["body", "json:/page"] },
  ]);
  assert.equal(paged.operation.params.find((p) => p.name === "page")!.type, "number");
  assert.equal(buildRequest(paged.operation, { q: "cats", page: 7 }, noSession).body, '{"q":"cats","page":7,"size":2}');
  assert.equal(paged.operation.minTier, 1, paged.warnings.join("\n"));
});

test("the evidence for a short example is the same endpoint in run 2, not any request to the host", () => {
  const records = (n: number, of: string) => ({ items: Array.from({ length: n }, (_, i) => ({ id: i, of })) });
  // the feed always asks for US and answers with more; only /top follows the example
  const run = (c: string) => [
    xhr({ url: "https://api.site.test/api/feed?country=US" }, records(100, "US")),
    xhr({ url: `https://api.site.test/api/top?country=${c}` }, records(2, c)),
  ];
  const { operation: op, exchange } = learn(run("US"), [{ country: "US" }, { country: "CA" }], {
    exchanges2: run("CA"),
  });
  assert.equal(new URL(exchange.request.url).pathname, "/api/top");
  assert.deepEqual(op.slots, [{ param: "country", at: ["query:country"] }]);

  // the same endpoint, allowing for path segments that are params themselves
  const posts = (user: string, page: number) => [
    xhr({ url: `https://api.site.test/v1/users/${user}/posts?page=${page}` }, records(3, user)),
  ];
  const paged = learn(
    posts("alice", 2),
    [
      { user: "alice", page: 2 },
      { user: "bobby", page: 3 },
    ],
    { exchanges2: posts("bobby", 3) },
  );
  assert.deepEqual(paged.operation.slots, [
    { param: "user", at: ["path:2"] },
    { param: "page", at: ["query:page"] },
  ]);
  const top = (c: string) => [xhr({ url: `https://api.site.test/v1/top/${c}` }, records(3, c))];
  const segment = learn(top("US"), [{ country: "US" }, { country: "CA" }], { exchanges2: top("CA") });
  assert.deepEqual(segment.operation.slots, [{ param: "country", at: ["path:2"] }]);
});

test("a short example without that evidence is refused, with a hint to pass a second one", () => {
  const hint = /q="US": example values need at least 3 characters.*second example/;
  assert.throws(() => learn(byCountry("US"), [{ q: "US" }]), hint);
  assert.throws(() => learn(byCountry("US"), [{ q: "US" }, { q: "us" }], { exchanges2: byCountry("US") }), hint);
  assert.throws(() => learn(byCountry("US"), [{ q: "US" }, { q: "CA" }]), hint, "a second example needs its run");
  // a second run in which no leaf follows: every US is somebody else's
  assert.throws(
    () =>
      learn(byCountry("US"), [{ q: "US" }, { q: "CA" }], { exchanges2: byCountry("US"), match: { path: "/v1/top" } }),
    /example 2 disproves "q": query:country is "US" in both runs.*query:gl is "US" in both runs/,
  );
  // a second run without the request: nothing confirms the place
  assert.throws(
    () => learn(byCountry("US"), [{ q: "US" }, { q: "CA" }], { exchanges2: [], match: { path: "/v1/top" } }),
    /run 2 produced no request matching .*short example of q/,
  );
  // inside a longer leaf only: a short value is never a part of one
  const lang = (c: string) => [xhr({ url: `https://api.site.test/v1/top?lang=en-${c}` })];
  assert.throws(
    () => learn(lang("US"), [{ q: "US" }, { q: "CA" }], { exchanges2: lang("CA"), match: { path: "/v1/top" } }),
    /"q" \("US"\) is not in the learned request.*whole leaf/,
  );
});

test("a short example in either set asks whole-leaf evidence of both", () => {
  // only the second example is short: it must not be placed inside en-US by way of the first
  const lang = (c: string) => [xhr({ url: `https://api.site.test/v1/top?lang=en-${c}` })];
  assert.throws(
    () => learn(lang("USA"), [{ q: "USA" }, { q: "US" }], { exchanges2: lang("US") }),
    /no captured request carries the example values/,
  );
  assert.throws(
    () => learn(lang("USA"), [{ q: "USA" }, { q: "US" }], { exchanges2: lang("US"), match: { path: "/v1/top" } }),
    /"q" \("USA"\) is not in the learned request.*whole leaf/,
  );
  assert.throws(
    () => learn(lang("USA"), [{ q: "USA" }, { q: "US" }]),
    /example 2 q="US": example values need at least 3 characters.*second example/,
    "a short second example needs its run too",
  );
  // control: whole leaves in both runs
  const whole = (c: string) => [xhr({ url: `https://api.site.test/v1/top?country=${c}&lang=en-${c}` })];
  const { operation: op } = learn(whole("USA"), [{ q: "USA" }, { q: "US" }], { exchanges2: whole("US") });
  assert.deepEqual(op.slots, [{ param: "q", at: ["query:country"] }]);
});

test("add checks a short example before any browser run, and learns one from two captures", async () => {
  const capture = (c: string): CaptureFile => ({
    id: `slots-${c}`,
    at: new Date().toISOString(),
    url: `https://site.test/top?country=${c}`,
    finalUrl: `https://site.test/top?country=${c}`,
    exchanges: byCountry(c),
    cookies: [],
  });
  const add = { site: "slots", op: "top", trigger: { url: "https://site.test/top?country={q}" } };
  // no capture and no Chrome is reached: the check comes first
  await assert.rejects(addOperation({ ...add, examples: [{ q: "US" }] }), /at least 3 characters.*second example/);
  await assert.rejects(
    addOperation({ ...add, examples: [{ q: "US" }, { q: "US" }] }),
    /at least 3 characters.*second example/,
  );
  const r = await addOperation({
    ...add,
    examples: [{ q: "US" }, { q: "CA" }],
    from: { capture: capture("US") },
    from2: capture("CA"),
  });
  assert.deepEqual(r.operation.slots, [{ param: "q", at: ["query:country"] }]);
});

/* ------------------------- a setting in a key, a cookie in a ref's name */

// Issue #25: a page keeps the word "sessions" in a storage entry whose key is scoped by the org id a
// cookie carries. The setting's ref keeps it fresh; neither the query key that spells the setting nor
// the ref's own name may refuse the add.
const ORG = "550e8400-e29b-41d4-a716-446655440000";
const scoped = (leaf: string, org = ORG) =>
  JSON.stringify({ state: { byScope: { sidebar: { [org]: { sections: [{ id: leaf }] } } } } });
const sessionsUrl = "http://127.0.0.1/v1/code/sessions?q=kittens&include_trigger_sessions=true";

test("a stored setting spelled in a query key saves, and a ref's name keeps no cookie its storage key holds", async () => {
  const org = [here("lastActiveOrg", ORG)];
  const { operation: op } = await add("issue25", xhr({ url: sessionsUrl }), org, { store: scoped("sessions") });
  // the org id reached the ref's name through the storage key: hashed, so nothing live is in the spec
  const ref = "session:op/store/state/byScope/sidebar/a3a9e1ed9732/sections/0/id";
  assert.deepEqual(op.slots, [
    { param: "q", at: ["query:q"] },
    { ref, at: ["path:2"] },
  ]);
  assert.ok(!JSON.stringify(op).includes(ORG), "no part of the cookie is in the saved spec");
  // the setting the request spells in a query key is no credential, here or on export
  assert.equal(new URL(op.request.url).searchParams.get("include_trigger_sessions"), "true");
  assert.deepEqual(exportSite("issue25").secrets, []);
  // the ref still resolves, so a replay fills the path from the session
  assert.deepEqual(loadSession("issue25").values, { [ref.slice(8)]: "sessions" });
  // the leaf and the org id the cookie holds sit in one container: siblings, not copies of each other
  assert.deepEqual(loadSession("issue25").kinds, { [ref.slice(8)]: "setting" });
  assert.equal(
    buildRequest(op, { q: "puppies" }, loadSession("issue25")).url,
    sessionsUrl.replace("kittens", "puppies"),
  );
  // the hash is of the storage key alone, so a recapture of the same page finds the same ref
  const again = await add("issue25-again", xhr({ url: sessionsUrl }), org, { store: scoped("sessions") });
  assert.equal(again.operation.slots.at(-1)!.ref, ref);
  // a different org id gives a different name: one ref never means two values
  const other = await add("issue25-other", xhr({ url: sessionsUrl }), [here("lastActiveOrg", B)], {
    store: scoped("sessions", B),
  });
  assert.notEqual(other.operation.slots.at(-1)!.ref, ref);
});

test("a real credential in the same shape is still refused, by its own text and by its storage key", async () => {
  const T = "k7Qm9xLp3Rv8Tz1Wn5Ys6Ub4Hc2Jd0Fa";
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const before = readdirSync(HOME, { recursive: true }).sort();
  // the stored leaf is a token, copied base64 where no pass can make it a ref
  await assert.rejects(
    add("issue25-token", xhr({ url: `${local}?q=kittens&ctx=${b64(T)}` }), [], { store: scoped(T) }),
    /query:ctx holds the live session value storage:store\/state\/byScope\/sidebar\/.*\/sections\/0\/id\./,
  );
  // ...and the same under a credential's key inside the entry, which no ref name hashes
  await assert.rejects(
    add("issue25-named", xhr({ url: `${local}?q=kittens&ctx=${b64(T)}` }), [], {
      store: JSON.stringify({ token: T }),
    }),
    /query:ctx holds the live session value storage:store\/token\./,
  );
  assert.deepEqual(readdirSync(HOME, { recursive: true }).sort(), before, "a refused add writes nothing");
});

test("the save-time scan skips a recorded setting, and looks for everything else", () => {
  const T = "k7Qm9xLp3Rv8Tz1Wn5Ys6Ub4Hc2Jd0Fa";
  const asSettings = (names: string[]) => Object.fromEntries(names.map((n) => [n, "setting" as const]));
  const held = (values: Record<string, string>, settings?: string[]) =>
    scanSecrets(
      { url: `${local}?ctx=${Object.values(values).join("|")}` },
      credentialsOf({ cookies: [], values, ...(settings ? { kinds: asSettings(settings) } : {}) }),
    ).secrets;
  // a session file from before the field, or with nothing recorded, is scanned whole
  assert.deepEqual(held({ "op/theme": "solarized-dark" }), ["$.url holds the live session value op/theme"]);
  assert.deepEqual(held({ "op/theme": "solarized-dark" }, []), ["$.url holds the live session value op/theme"]);
  // recorded as a setting: skipped
  assert.deepEqual(held({ "op/theme": "solarized-dark" }, ["op/theme"]), []);
  // ...unless its own text reads like a credential, whatever the name was recorded as
  assert.deepEqual(held({ "op/theme": T }, ["op/theme"]), ["$.url holds the live session value op/theme"]);
  // ...or a name that is no setting holds the same text: that classification wins
  assert.deepEqual(held({ "a/theme": "solarized-dark", "b/token": "solarized-dark" }, ["a/theme"]), [
    "$.url holds the live session value a/theme",
    "$.url holds the live session value b/token",
  ]);
  // a cookie is never a setting
  assert.deepEqual(
    scanSecrets(
      { url: `${local}?ctx=solarized-dark` },
      credentialsOf({ cookies: [cookie("theme", "solarized-dark")], values: {}, kinds: asSettings(["theme"]) }),
    ).secrets,
    ["$.url holds the live cookie theme"],
  );
});

test("a cookie holding the site's own origin refuses no add or export, and any other URL is still a credential", async () => {
  // an analytics script keeps the last page in a cookie, and the capture's run sets it again: encoded or raw,
  // beside a Referer that carries a param (the origin is then text beside it in that slot's template)
  const referer = { referer: "http://127.0.0.1/search?q=kittens" };
  for (const [site, value] of [
    ["issue27", encodeURIComponent("http://127.0.0.1/")],
    ["issue27-raw", "http://127.0.0.1/"],
  ] as const) {
    const { operation: op } = await add(site, xhr({ url: `${local}?q=kittens`, headers: referer }), [
      here("__ps_lu", value),
    ]);
    assert.ok(!op.slots.some((s) => s.ref?.startsWith("cookie:")), site);
    assert.deepEqual(exportSite(site).secrets, [], site);
  }

  // page storage keeping the site's own host is its address, not a session value: no ref, through the add,
  // a cookie re-import and a retry
  const lastPage = here("__ps_lu", encodeURIComponent("http://127.0.0.1/"));
  const hostAdd = () =>
    add("issue27-host", xhr({ url: `${local}?q=kittens&host=127.0.0.1` }), [lastPage], { host: "127.0.0.1" });
  const noHostRef = (op: { slots: { ref?: string }[] }) =>
    assert.ok(!op.slots.some((s) => s.ref === "session:op/host"));
  noHostRef((await hostAdd()).operation);
  assert.equal(loadSession("issue27-host").kinds?.["op/host"], undefined);
  // the saved operation's origin is the site's own from now on, for every write
  assert.deepEqual(loadSession("issue27-host").origins, ["http://127.0.0.1"]);
  saveSession("issue27-host", { ...loadSession("issue27-host"), cookies: [lastPage] });
  noHostRef((await hostAdd()).operation);
  assert.deepEqual(exportSite("issue27-host").secrets, []);

  // a URL that carries more than the origin is still a credential: its copy becomes a ref
  const magic = here("__ps_lu", encodeURIComponent(`http://127.0.0.1/login?t=${OPAQUE}`));
  const { operation: held } = await add(
    "issue27-magic",
    xhr({ url: `${local}?q=kittens&next=http://127.0.0.1/login?t=${OPAQUE}` }),
    [magic],
  );
  assert.ok(!JSON.stringify(held).includes(OPAQUE));
  assert.ok(held.slots.some((s) => s.ref === "cookie:__ps_lu"));
  // ...and where no ref can reach it (base64), the learn is refused
  const b64 = Buffer.from(`http://127.0.0.1/login?t=${OPAQUE}`).toString("base64");
  await assert.rejects(
    add("issue27-b64", xhr({ url: `${local}?q=kittens&ctx=${b64}` }), [magic]),
    /holds the live cookie __ps_lu/,
  );
  // a refused add records no origin as the site's own
  assert.equal(loadSession("issue27-b64").origins, undefined);
  // so is another host's origin, under a header whatever its name
  const other = "http://k7qm9xlp.x.test/";
  await assert.rejects(
    add(
      "issue27-other",
      xhr({ url: `${local}?q=kittens`, headers: { "x.origin": encodeURIComponent(encodeURIComponent(other)) } }),
      [here("sid", other)],
    ),
    /holds the live cookie sid/,
  );
});

test("a session a refused add left with the setting unclassified still adds", async () => {
  const ref = "op/store/state/byScope/sidebar/a3a9e1ed9732/sections/0/id";
  // what the add that refused before the fix left behind: the value stored, with nothing classified
  saveSession("issue25-stale", { cookies: [], values: { [ref]: "sessions" } });
  const { operation: op } = await add("issue25-stale", xhr({ url: sessionsUrl }), [here("lastActiveOrg", ORG)], {
    store: scoped("sessions"),
  });
  // this learn classifies the name it was already holding, so the query key spelling it is no credential
  assert.deepEqual(loadSession("issue25-stale").kinds, { [ref]: "setting" });
  assert.equal(new URL(op.request.url).searchParams.get("include_trigger_sessions"), "true");
  assert.deepEqual(exportSite("issue25-stale").secrets, []);
});

// A later operation of the same site saves a copy of a value an earlier one recorded as a setting.
// What makes the earlier name a setting is learning's classification; these two say what unmakes it.
const addOp = (
  site: string,
  op: string,
  ex: Exchange,
  storage?: Record<string, string>,
  cookies: StoredCookie[] = [],
) =>
  addOperation({
    site,
    op,
    trigger: { url: "http://127.0.0.1/?q={q}" },
    examples: [{ q: "kittens" }],
    from: { capture: capture(ex, cookies, storage) },
  });
const b64 = (s: string) => Buffer.from(s).toString("base64");

test("a stored JSON container is no setting, so a copy of one is refused with the credential inside it", async () => {
  const T = "k7Qm9xLp3Rv8Tz1Wn5Ys6Ub4Hc";
  // formatted as a page writes its own JSON: the container is no token itself, and holds one
  const held = JSON.stringify({ token: T }, null, 1);
  // op one sends it whole, so the ref for the token inside it is dropped and only the container is stored
  await addOp("c25-whole", "one", xhr({ url: `${local}?q=kittens&state=${encodeURIComponent(held)}` }), {
    cache: held,
  });
  assert.deepEqual(loadSession("c25-whole").values, { "one/cache": held });
  // nothing here reads like a token (a JSON container is never random-looking), but no container is ever
  // left out of the scan, so that is what the classification records
  assert.deepEqual(loadSession("c25-whole").kinds, { "one/cache": "credential" });
  // op two copies the container base64 inside a longer leaf, where no pass can make it a ref
  await assert.rejects(
    addOp("c25-whole", "two", xhr({ url: `${local}?q=kittens&ctx=${encodeURIComponent(`v1:${b64(held)}`)}` })),
    /\$\.request\.url holds the live session value one\/cache/,
  );
  assert.deepEqual(exportSite("c25-whole").secrets, [], "op one itself keeps no copy");
});

test("a setting a credential holds is no setting either: a copy of the text is refused", async () => {
  const token = "ordinary-value";
  // one text, stored as a theme and sent as the bearer: too short and too plain to read as a token
  await addOp(
    "c25-bearer",
    "one",
    xhr({ url: `${local}?q=kittens&theme=${token}`, headers: { authorization: `Bearer ${token}` } }),
    { theme: token },
  );
  const session = loadSession("c25-bearer");
  // the learn read the theme as a setting; the bearer holds its text, so the write records a credential
  assert.deepEqual(session.kinds, { "one/theme": "credential", "one/authorization": "credential" });
  assert.equal(session.values["one/authorization"], `Bearer ${token}`);
  // op two copies it base64 where no pass can make it a ref: the bearer protects the text
  await assert.rejects(
    addOp("c25-bearer", "two", xhr({ url: `${local}?q=kittens&ctx=${b64(token)}` })),
    /\$\.request\.url holds the live session value one\/theme/,
  );
  assert.deepEqual(exportSite("c25-bearer").secrets, [], "op one itself keeps no copy");
});

test("a setting a protected value reaches only through another setting is no setting either", async () => {
  const leaf = "ordinary/value";
  // the page keeps a redirect URL that spells the leaf three percent layers down, and the credential
  // holds that URL base64: four layers from the credential, one more than the scan reads at a time
  const url = `https://example.test/?state=${encodeURIComponent(encodeURIComponent(encodeURIComponent(leaf)))}`;
  const one = `${local}?q=kittens&theme=${leaf}&redirect=${encodeURIComponent(url)}`;
  const two = (site: string) => addOp(site, "two", xhr({ url: `${local}?q=kittens&ctx=${b64(leaf)}` }));
  // op one's learn reads both as settings: a URL is never random-looking, and neither is the leaf
  await addOp("c25-chain", "one", xhr({ url: one, headers: { authorization: `Bearer ${b64(url)}` } }), {
    theme: leaf,
    redirect: url,
  });
  // both were read as settings, and the chain protects both: the write records what the scan keeps
  assert.deepEqual(loadSession("c25-chain").kinds, {
    "one/theme": "credential",
    "one/redirect": "credential",
    "one/authorization": "credential",
  });
  // the bearer protects the redirect, and the redirect then protects the theme
  await assert.rejects(two("c25-chain"), /\$\.request\.url holds the live session value one\/theme/);
  assert.deepEqual(exportSite("c25-chain").secrets, [], "op one itself keeps no copy");
  // the same chain where a cookie, not a session value, is what holds the redirect
  await addOp("c25-chain-cookie", "one", xhr({ url: one }), { theme: leaf, redirect: url }, [here("sid", b64(url))]);
  await assert.rejects(two("c25-chain-cookie"), /\$\.request\.url holds the live session value one\/theme/);
  assert.deepEqual(exportSite("c25-chain-cookie").secrets, [], "op one itself keeps no copy");
});

test("a re-learn reading a stored credential as a setting does not unprotect it", async () => {
  const token = "ordinary-value";
  // op one sends the text under a credential's field name, so the entry that holds it is a credential
  await addOp("c25-sticky", "one", xhr({ url: `${local}?q=kittens&token=${token}` }), { cache: token });
  assert.deepEqual(loadSession("c25-sticky").kinds, { "one/cache": "credential" });
  // learned again after the site renamed the field: the same entry now reads as a setting, and stays protected
  await addOp("c25-sticky", "one", xhr({ url: `${local}?q=kittens&ticket=${token}` }), { cache: token });
  assert.deepEqual(loadSession("c25-sticky").kinds, { "one/cache": "credential" });
  // op two copies it base64 where no pass can make it a ref
  await assert.rejects(
    addOp("c25-sticky", "two", xhr({ url: `${local}?q=kittens&ctx=${b64(token)}` })),
    /\$\.request\.url holds the live session value one\/cache/,
  );
  assert.deepEqual(exportSite("c25-sticky").secrets, [], "op one itself keeps no copy");
});

test("a refresh that changes a setting's value unclassifies it, one that reads it back does not", async () => {
  const token = "ordinary-value";
  // op one stores the theme the page keeps, and the query spells it: a setting, as ever
  await addOp("c25-refresh", "one", xhr({ url: `${local}?q=kittens&ticket=solarized-dark` }), {
    cache: "solarized-dark",
  });
  assert.deepEqual(loadSession("c25-refresh").kinds, { "one/cache": "setting" });
  // a trigger run or a recapture refreshes the stored values without classifying them, and the page can
  // put anything at the slot's position: a changed value is unclassified again, so the scan protects it
  mergeCapture("c25-refresh", [], { from: local, values: { "one/cache": token } });
  assert.equal(loadSession("c25-refresh").values["one/cache"], token);
  assert.equal(loadSession("c25-refresh").kinds?.["one/cache"], undefined);
  // op two copies the refreshed text base64 where no pass can make it a ref
  await assert.rejects(
    addOp("c25-refresh", "two", xhr({ url: `${local}?q=kittens&ctx=${b64(token)}` })),
    /\$\.request\.url holds the live session value one\/cache/,
  );
  assert.deepEqual(exportSite("c25-refresh").secrets, [], "op one itself keeps no copy");
  // a refresh that reads the same value back keeps the classification, so the issue's own shape still saves
  const { operation: op } = await add("c25-same", xhr({ url: sessionsUrl }), [here("lastActiveOrg", ORG)], {
    store: scoped("sessions"),
  });
  const ref = op.slots.at(-1)!.ref!.slice(8);
  mergeCapture("c25-same", [], { from: sessionsUrl, values: { [ref]: "sessions" } });
  assert.deepEqual(loadSession("c25-same").kinds, { [ref]: "setting" });
  await addOp("c25-same", "two", xhr({ url: `${local}?q=kittens&include_trigger_sessions=true` }));
  assert.deepEqual(exportSite("c25-same").secrets, []);
});

// What protects a setting is a relationship between live values, and a session write can replace either
// side of it. The scan's answer is recorded at every write, so a rotation cannot undo it.
test("a rotation of what protects a setting does not unprotect it", async () => {
  const token = "ordinary-value";
  const newer = "different-value";
  const rotations: [string, (site: string) => Promise<unknown>][] = [
    // a learn that reads the name again, and a bare refresh (a trigger run, a recapture)
    [
      "c25-rot-learn",
      (site) => addOp(site, "one", xhr({ url: `${local}?q=kittens`, headers: { authorization: `Bearer ${newer}` } })),
    ],
    [
      "c25-rot-refresh",
      async (site) => mergeCapture(site, [], { from: local, values: { "one/authorization": `Bearer ${newer}` } }),
    ],
  ];
  for (const [site, rotate] of rotations) {
    const one = xhr({ url: `${local}?q=kittens&theme=${token}`, headers: { authorization: `Bearer ${token}` } });
    await addOp(site, "one", one, { theme: token });
    assert.equal(loadSession(site).kinds?.["one/theme"], "credential", "the bearer held the theme's text");
    await rotate(site);
    const after = loadSession(site);
    assert.equal(after.values["one/theme"], token, "the theme still holds the text the old bearer held");
    assert.equal(after.values["one/authorization"], `Bearer ${newer}`);
    assert.equal(after.kinds?.["one/theme"], "credential", "and keeps the protection the first write recorded");
    // op two copies the text base64 where no pass can make it a ref
    await assert.rejects(
      addOp(site, "two", xhr({ url: `${local}?q=kittens&ctx=${b64(token)}` })),
      /\$\.request\.url holds the live session value one\/theme/,
    );
    assert.deepEqual(exportSite(site).secrets, [], "op one itself keeps no copy");
  }
});

test("a cookie re-import does not unprotect a setting the cookie it replaces held", async () => {
  const token = "ordinary-value";
  const sid = (t: string) => here("sid", `v1-${t}-x`);
  const one = xhr({ url: `${local}?q=kittens&theme=${token}` });
  await addOp("c25-rot-cookie", "one", one, { theme: token }, [sid(token)]);
  assert.equal(loadSession("c25-rot-cookie").kinds?.["one/theme"], "credential", "the cookie held the theme's text");
  // what a login or a self-heal re-import writes: the stored values, a fresh jar
  const s = loadSession("c25-rot-cookie");
  saveSession("c25-rot-cookie", { ...s, cookies: [sid("different-value")], source: "chrome:Default" });
  assert.equal(loadSession("c25-rot-cookie").kinds?.["one/theme"], "credential");
  await assert.rejects(
    addOp("c25-rot-cookie", "two", xhr({ url: `${local}?q=kittens&ctx=${b64(token)}` })),
    /\$\.request\.url holds the live session value one\/theme/,
  );
  assert.deepEqual(exportSite("c25-rot-cookie").secrets, [], "op one itself keeps no copy");
});

// A learn sees credentials it does not store: a cookie the request sent, a storage entry no leaf
// repeated. Nothing records that relationship later, so the classification has to carry it.
test("a setting a credential the learn never stored holds is no setting either", async () => {
  const token = "ordinary-value";
  const bearer = b64(token);
  // the credential in storage under a name no leaf repeats, and the same one sent as a cookie
  const live: [string, Record<string, string>, Record<string, string>][] = [
    ["c25-live-stored", { theme: token, token: bearer }, {}],
    ["c25-live-sent", { theme: token }, { cookie: `sid=${bearer}` }],
  ];
  for (const [site, storage, headers] of live) {
    await addOp(site, "one", xhr({ url: `${local}?q=kittens&theme=${token}`, headers }), storage);
    const session = loadSession(site);
    // only the theme is stored, and the learn read the text the credential holds as a credential
    assert.deepEqual(session.values, { "one/theme": token });
    assert.deepEqual(session.cookies, []);
    assert.deepEqual(session.kinds, { "one/theme": "credential" });
    // op two copies the text base64 where no pass can make it a ref
    await assert.rejects(
      addOp(site, "two", xhr({ url: `${local}?q=kittens&ctx=${bearer}` })),
      /\$\.request\.url holds the live session value one\/theme/,
    );
    assert.deepEqual(exportSite(site).secrets, [], "op one itself keeps no copy");
  }
});

test("a rotation does not unprotect a setting a session file written before `kinds` left unclassified", async () => {
  const token = "ordinary-value";
  // what a release before the field wrote: the theme stored, the cookie that holds its text, nothing classified
  saveSession("c25-legacy", { cookies: [here("sid", b64(token))], values: { "one/theme": token } });
  assert.equal(loadSession("c25-legacy").kinds, undefined);
  // the same op learned again, after the cookie rotated: this learn sees no credential holding the theme
  await addOp("c25-legacy", "one", xhr({ url: `${local}?q=kittens&theme=${token}` }), { theme: token }, [
    here("sid", "different-value"),
  ]);
  const after = loadSession("c25-legacy");
  assert.equal(after.values["one/theme"], token);
  // the stored file held the relationship, so classifying the name asks what it protected there too
  assert.deepEqual(after.kinds, { "one/theme": "credential" });
  await assert.rejects(
    addOp("c25-legacy", "two", xhr({ url: `${local}?q=kittens&ctx=${b64(token)}` })),
    /\$\.request\.url holds the live session value one\/theme/,
  );
  assert.deepEqual(exportSite("c25-legacy").secrets, [], "op one itself keeps no copy");
});

// The seal a session write adds (`recordProtection`) can overrule the classification of the learn
// that asked for the write. That same add goes on to scan the op it is saving, so it has to scan
// with what the write kept.
test("the add whose classification the session write overruled scans its op with the write's", async () => {
  const token = "ordinary-value";
  // what a release before the field wrote: the theme stored, the cookie that holds its text, nothing classified
  saveSession("c25-sealed", { cookies: [here("sid", b64(token))], values: { "one/theme": token } });
  // the same op learned again after the cookie rotated, in a request that also copies the text base64
  // where no pass can make it a ref. This learn sees no credential holding the theme, so it alone
  // reads the name as a setting; the stored file holds the relationship, and the write records it.
  await assert.rejects(
    addOp("c25-sealed", "one", xhr({ url: `${local}?q=kittens&theme=${token}&ctx=${b64(token)}` }), { theme: token }, [
      here("sid", "different-value"),
    ]),
    /\$\.request\.url holds the live session value one\/theme/,
  );
  assert.deepEqual(loadSession("c25-sealed").kinds, { "one/theme": "credential" });
  assert.equal(loadSite("c25-sealed"), undefined, "a refused add saves no op");
});

// A link in the chain can be a value the learn only saw live: the page keeps it, no leaf repeats it,
// so nothing stores it and no later write can record what it protects.
test("a setting a credential reaches only through a live value the learn did not store is no setting", async () => {
  const observed = "opaque/session-value";
  const pct = (v: string) => encodeURIComponent(encodeURIComponent(encodeURIComponent(v)));
  // the page keeps a URL spelling the cookie three percent layers down, and another spelling that one
  // three layers further: six from the cookie, twice what the scan reads at a time
  const inner = `https://example.test/?auth=${pct(observed)}`;
  const outer = `https://example.test/?redirect=${pct(inner)}`;
  // the leaf repeats the outer URL, so only that is stored; the cookie came with the request, and the
  // inner URL sits in storage under a name no leaf repeats
  await addOp(
    "c25-link",
    "one",
    xhr({ url: `${local}?q=kittens&redirect=${encodeURIComponent(outer)}`, headers: { cookie: `sid=${observed}` } }),
    { theme: outer, redirect: inner },
  );
  const session = loadSession("c25-link");
  assert.deepEqual(session.values, { "one/theme": outer }, "the inner URL is not persisted");
  assert.deepEqual(session.cookies, [], "a cookie the request sent is not persisted either");
  // the inner URL is the only way from the cookie to the stored one, and the learn saw it: a credential
  assert.deepEqual(session.kinds, { "one/theme": "credential" });
  // op two copies the stored URL where no pass can make it a ref
  await assert.rejects(
    addOp("c25-link", "two", xhr({ url: `${local}?q=kittens&ctx=${encodeURIComponent(outer)}` })),
    /\$\.request\.url holds the live session value one\/theme/,
  );
  assert.deepEqual(exportSite("c25-link").secrets, [], "op one itself keeps no copy");
});
