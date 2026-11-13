import assert from "node:assert/strict";
import { test } from "node:test";
import { getAt, walk } from "../src/codec.js";
import { buildRequest } from "../src/http.js";
import { arrayAround, learnOperation, matches, rankCandidates } from "../src/learn.js";
import { scanSecrets } from "../src/secrets.js";
import type { Exchange, StoredCookie } from "../src/types.js";

const cookie = (name: string, value: string, domain = ".x.com"): StoredCookie => ({
  name,
  value,
  domain,
  path: "/",
  expires: -1,
  httpOnly: false,
  secure: true,
});

const X_COOKIES = [
  cookie("ct0", "c0ffee0123456789abcdef"),
  cookie("auth_token", "a1b2c3d4e5f60718293a"),
  cookie("gt", "1840000000000000001"),
];
const BEARER = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7";

function xExchanges(handle: string, txn: string, id0 = 1): Exchange[] {
  const variables = JSON.stringify({ screen_name: handle, withSafetyMode: true });
  const features = JSON.stringify({ hidden_profile_subscriptions_enabled: true });
  return [
    {
      id: id0,
      resourceType: "document",
      request: {
        method: "GET",
        url: `https://x.com/${handle}`,
        headers: { "user-agent": "Mozilla/5.0 Chrome/153.0.0.0" },
      },
      response: {
        status: 200,
        headers: {},
        body: `<html><title>${handle} / X</title></html>`,
        contentType: "text/html; charset=utf-8",
      },
    },
    {
      id: id0 + 1,
      resourceType: "script",
      request: { method: "GET", url: "https://abs.twimg.com/responsive-web/main.abc.js", headers: {} },
      response: { status: 200, headers: {}, body: "var x", contentType: "application/javascript" },
    },
    {
      id: id0 + 2,
      resourceType: "xhr",
      request: {
        method: "POST",
        url: `https://www.google-analytics.com/g/collect?v=2&dl=https%3A%2F%2Fx.com%2F${handle}`,
        headers: {},
      },
      response: { status: 204, headers: {}, contentType: "" },
    },
    {
      id: id0 + 3,
      resourceType: "xhr",
      request: {
        method: "GET",
        url: `https://x.com/i/api/graphql/Gb-d6r0vxPOADdG62OEBpQ/UserByScreenName?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`,
        headers: {
          ":authority": "x.com",
          accept: "*/*",
          "accept-encoding": "gzip, deflate, br, zstd",
          authorization: BEARER,
          cookie: "ct0=c0ffee0123456789abcdef; auth_token=a1b2c3d4e5f60718293a; gt=1840000000000000001",
          "x-csrf-token": "c0ffee0123456789abcdef",
          "x-guest-token": "1840000000000000001",
          "x-client-transaction-id": txn,
          "x-twitter-auth-type": "OAuth2Session",
          referer: `https://x.com/${handle}`,
          "sec-fetch-site": "same-origin",
          "user-agent": "Mozilla/5.0 Chrome/153.0.0.0",
        },
      },
      response: {
        status: 200,
        headers: {},
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          data: {
            user: {
              result: {
                rest_id: "11348282",
                legacy: { screen_name: handle.toUpperCase(), name: "Name", followers_count: 1 },
              },
            },
          },
        }),
      },
    },
  ];
}

const trigger = { url: "https://x.com/{screen_name}" };

test("structured params cannot cover session refs, but sibling refs still replay", () => {
  const token = "aB3dEf9hK2Lm8Np5";
  for (const encoded of [false, true]) {
    const learn = (filter: Record<string, unknown>, sibling = false) => {
      const json = JSON.stringify({ filter, ...(sibling ? { token } : {}) });
      const state = encoded ? Buffer.from(json).toString("base64url") : json;
      return learnOperation({
        name: "filter",
        readOnly: true,
        trigger: { url: "https://fixture.test/search" },
        match: { path: "/api/search" },
        examples: [{ filter }],
        cookies: [cookie("sid", token, ".fixture.test")],
        exchanges: [
          {
            id: 1,
            resourceType: "fetch",
            request: {
              method: "GET",
              url: `https://fixture.test/api/search?state=${encodeURIComponent(state)}`,
              headers: {},
            },
            response: {
              status: 200,
              headers: {},
              contentType: "application/json",
              body: '{"results":[{"name":"nasa"}]}',
            },
          },
        ],
      });
    };
    assert.throws(() => learn({ name: "nasa", token }), /param filter .* contains a session value.*Not learned/);
    const { operation } = learn({ name: "nasa" }, true);
    assert.ok(!JSON.stringify(operation).includes(token));
    const filled = buildRequest(
      operation,
      { filter: { name: "esa" } },
      { cookies: [cookie("sid", token, ".fixture.test")], values: {} },
    );
    const root = ["query:state", ...(encoded ? ["b64"] : [])];
    assert.deepEqual(getAt(filled, [...root, "json:/filter"]), { name: "esa" });
    assert.equal(getAt(filled, [...root, "json:/token"]), token);
  }
});

test("structured examples inside base64 JSON keep the encoding and unrelated bytes when filled", () => {
  for (const example of [{ name: "nasa", count: 5 }, ["nasa", "spacex"]]) {
    for (const encoding of ["base64", "base64url"] as const) {
      const data = Buffer.from(JSON.stringify({ filter: example, constant: "unchanged" })).toString(encoding);
      const { operation } = learnOperation({
        name: "filter",
        readOnly: true,
        trigger: { url: "https://fixture.test/search" },
        match: { path: "/api/search" },
        examples: [{ filter: example }],
        cookies: [],
        exchanges: [
          {
            id: 1,
            resourceType: "fetch",
            request: {
              method: "GET",
              url: `https://fixture.test/api/search?data=${encodeURIComponent(data)}&constant=%2f%2F`,
              headers: {},
            },
            response: {
              status: 200,
              headers: {},
              contentType: "application/json",
              body: '{"results":[{"name":"nasa"}]}',
            },
          },
        ],
      });
      assert.deepEqual(
        operation.slots.filter((s) => s.param),
        [{ param: "filter", at: ["query:data", "b64", "json:/filter"] }],
      );
      const replacement = Array.isArray(example) ? ["jpl", "esa"] : { name: "jpl", count: 8 };
      const request = buildRequest(operation, { filter: replacement }, { cookies: [], values: {} });
      assert.deepEqual(getAt(request, ["query:data", "b64", "json:/filter"]), replacement);
      assert.equal(getAt(request, ["query:data", "b64", "json:/constant"]), "unchanged");
      assert.ok(request.url.endsWith("&constant=%2f%2F"));
    }
  }
});

test("X-like GraphQL GET: params, cookie/session refs, volatile anchor, match, headers, response", () => {
  const {
    operation: op,
    warnings,
    sessionValues,
  } = learnOperation({
    exchanges: xExchanges("nasa", "txnAAAAAAAAAAAAAAAAAAAAAAA"),
    exchanges2: xExchanges("spacex", "txnBBBBBBBBBBBBBBBBBBBBBBB", 10),
    examples: [{ screen_name: "nasa" }, { screen_name: "spacex" }],
    cookies: X_COOKIES,
    name: "getUser",
    trigger,
    readOnly: true,
  });

  assert.ok(op.request.url.startsWith("https://x.com/i/api/graphql/Gb-d6r0vxPOADdG62OEBpQ/UserByScreenName?"));
  assert.deepEqual(
    op.slots.filter((s) => s.param),
    [
      { param: "screen_name", at: ["query:variables", "json:/screen_name"] },
      { param: "screen_name", at: ["header:referer"], template: "https://x.com/{screen_name}" },
    ],
  );
  assert.deepEqual(
    op.slots
      .filter((s) => s.ref)
      .map((s) => [s.ref, s.at.join()])
      .sort(),
    [
      ["cookie:ct0", "header:x-csrf-token"],
      ["cookie:gt", "header:x-guest-token"],
      ["session:getUser/authorization", "header:authorization"],
      ["session:getUser/x-client-transaction-id", "header:x-client-transaction-id"],
    ],
  );
  assert.deepEqual(sessionValues, {
    "getUser/authorization": BEARER,
    "getUser/x-client-transaction-id": "txnAAAAAAAAAAAAAAAAAAAAAAA",
  });

  // header policy: verbatim minus pseudo/cookie/accept-encoding; per-op headers like x-twitter-auth-type stay
  assert.deepEqual(Object.keys(op.request.headers).sort(), [
    "accept",
    "authorization",
    "referer",
    "sec-fetch-site",
    "user-agent",
    "x-client-transaction-id",
    "x-csrf-token",
    "x-guest-token",
    "x-twitter-auth-type",
  ]);
  const serialized = JSON.stringify(op);
  for (const secret of ["c0ffee0123456789abcdef", "a1b2c3d4e5f60718293a", "1840000000000000001", "1Zv7", "txnAAAA"]) {
    assert.ok(!serialized.includes(secret), `spec must not hold ${secret}`);
  }

  assert.deepEqual(op.volatile, [
    { at: ["path:3"], shape: { charset: "base64url", length: 22 }, anchor: "UserByScreenName" },
  ]);
  assert.deepEqual(op.match, { method: "GET", host: "x.com", path: "/i/api/graphql/*/UserByScreenName" });
  assert.equal(op.minTier, 1);
  assert.equal(op.learnedLoggedIn, true);
  assert.deepEqual(op.params, [{ name: "screen_name", type: "string", required: true, example: "nasa" }]);
  assert.equal(op.response.format, "json");
  assert.equal(op.response.extract, "data.user.result.legacy");
  assert.equal(op.response.shape!["data.user.result.rest_id"], "string");
  assert.ok(!warnings.some((w) => /nonce|ambiguous|run 2 has/.test(w)), warnings.join("\n"));

  // replay with a new arg and a live session
  const req = buildRequest(op, { screen_name: "esa" }, { cookies: X_COOKIES, values: sessionValues });
  assert.deepEqual(getAt(req, ["query:variables", "json:"]), { screen_name: "esa", withSafetyMode: true });
  assert.equal(req.headers.referer, "https://x.com/esa");
  assert.equal(req.headers["x-csrf-token"], "c0ffee0123456789abcdef");
  assert.equal(req.headers["x-guest-token"], "1840000000000000001");
  assert.equal(req.headers.authorization, BEARER);
  assert.match(req.headers.cookie!, /auth_token=a1b2c3d4e5f60718293a/);
});

test("learned signed in only on a login cookie no signed-out visitor is given", () => {
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: "shop.test",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
  });
  const learn = (cookies: ReturnType<typeof cookie>[]) =>
    learnOperation({
      name: "items",
      readOnly: true,
      trigger: { url: "https://shop.test/items" },
      match: { path: "/api/items" },
      examples: [{}],
      cookies,
      guestCookies: ["app_session"],
      exchanges: [
        {
          id: 1,
          resourceType: "fetch",
          request: { method: "GET", url: "https://shop.test/api/items", headers: {} },
          response: { status: 200, headers: {}, contentType: "application/json", body: '{"items":[1]}' },
        },
      ],
    }).operation.learnedLoggedIn;
  assert.equal(learn([cookie("app_session", "visitor-session-0001")]), false);
  assert.equal(learn([cookie("app_session", "visitor-session-0001"), cookie("auth_token", "member-token-0001")]), true);
});

test("rankCandidates drops noise and puts the XHR carrying the args first", () => {
  const ranked = rankCandidates(xExchanges("nasa", "t"), { screen_name: "nasa" });
  assert.deepEqual(
    ranked.map((c) => c.id),
    [4, 1],
  );
  assert.deepEqual(ranked[0]!.hits, ["screen_name"]);
  assert.equal(ranked[1]!.resourceType, "document");
  assert.deepEqual(
    rankCandidates(xExchanges("nasa", "t")).map((c) => c.id),
    [4, 1],
  );
});

test("matches uses stable identity only", () => {
  const req = xExchanges("nasa", "t")[3]!.request;
  assert.ok(matches({ method: "GET", host: "x.com", path: "/i/api/graphql/*/UserByScreenName" }, req));
  assert.ok(!matches({ path: "/i/api/graphql/*/UserTweets" }, req));
  assert.ok(!matches({ method: "POST" }, req));
  assert.ok(
    !matches({ operationName: "UserByScreenName" }, req),
    "operationName comes from the body/form, not the path",
  );
});

function flights(origin: string, dest: string, reqid: string, id: number, bgr: string): Exchange {
  const inner = JSON.stringify([
    [null, null, null, "HKUJcc"],
    [
      null,
      null,
      1,
      [
        [[[[origin, 0]]], [[[dest, 0]]], null, 0, null, null, "2026-11-12"],
        [[[[dest, 0]]], [[[origin, 0]]], null, 0, null, null, "2026-11-16"],
      ],
    ],
  ]);
  return {
    id,
    resourceType: "xhr",
    request: {
      method: "POST",
      url: `https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults?f.sid=-5170&bl=boq_travel-frontend-flights-ui_20260922.02_p0&hl=en-US&_reqid=${reqid}&rt=c`,
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-goog-batchexecute-bgr": bgr,
        "x-same-domain": "1",
      },
      body: `f.req=${encodeURIComponent(JSON.stringify([null, inner]))}&`,
    },
    response: {
      status: 200,
      headers: {},
      contentType: "application/json; charset=utf-8",
      body: `)]}'\n\n120\n[["wrb.fr",null,"[[\\"United\\",\\"${dest}\\"]]"]]\n`,
    },
  };
}

test("Google Flights: triple-encoded form params, value in several roles, counter vs nonce, XSSI", () => {
  const learned = learnOperation({
    exchanges: [flights("SFO", "JFK", "4521", 1, '[";u6W4pcHQ-one"]')],
    exchanges2: [flights("OAK", "LAX", "8837", 2, '[";u6W4pcHQ-two"]')],
    examples: [
      { origin: "SFO", destination: "JFK" },
      { origin: "OAK", destination: "LAX" },
    ],
    cookies: [],
    name: "search",
    trigger: { url: "https://www.google.com/travel/flights?q={origin}+to+{destination}" },
    readOnly: true,
  });
  const op = learned.operation;
  const byParam = (p: string) => op.slots.filter((s) => s.param === p).map((s) => s.at.slice(2).join());
  assert.deepEqual(byParam("origin"), ["json:/1/3/0/0/0/0/0", "json:/1/3/1/1/0/0/0"]);
  assert.deepEqual(byParam("destination"), ["json:/1/3/0/1/0/0/0", "json:/1/3/1/0/0/0/0"]);
  assert.ok(learned.warnings.some((w) => /"destination" appears in 2 places/.test(w)));
  assert.ok(learned.warnings.some((w) => /query:_reqid varies between runs/.test(w)));
  assert.equal(op.minTier, 1);
  assert.deepEqual(learned.sessionValues, { "search/x-goog-batchexecute-bgr": '[";u6W4pcHQ-one"]' });
  assert.equal(op.response.xssiPrefix, ")]}'");

  const req = buildRequest(op, { origin: "SEA", destination: "BOS" }, { cookies: [], values: learned.sessionValues });
  const inner = JSON.parse(JSON.parse(new URLSearchParams(req.body).get("f.req")!)[1]);
  assert.deepEqual(inner[1][3][0].slice(0, 2), [[[["SEA", 0]]], [[["BOS", 0]]]]);
  assert.deepEqual(inner[1][3][1].slice(0, 2), [[[["BOS", 0]]], [[["SEA", 0]]]]);
  assert.equal(req.headers["x-goog-batchexecute-bgr"], '[";u6W4pcHQ-one"]');
});

test("a high-entropy value that changes without an arg change is a nonce: minTier 3", () => {
  const ex = (q: string, sig: string, id: number): Exchange => ({
    id,
    resourceType: "fetch",
    request: { method: "GET", url: `https://shop.test/api/search?q=${q}&sig=${sig}`, headers: {} },
    response: {
      status: 200,
      headers: {},
      contentType: "application/json",
      body: `{"items":[{"name":"${q} one"},{"name":"${q} two"}]}`,
    },
  });
  const { operation, warnings } = learnOperation({
    exchanges: [ex("kettle", "f3a9c1d2e4b5a6c7", 1)],
    exchanges2: [ex("toaster", "0b1c2d3e4f5a6b7c", 2)],
    examples: [{ q: "kettle" }, { q: "toaster" }],
    cookies: [],
    name: "search",
    trigger: { url: "https://shop.test/?q={q}" },
    readOnly: true,
  });
  assert.equal(operation.minTier, 3);
  assert.ok(warnings.some((w) => /nonce.*query:sig/.test(w)));
  assert.equal(operation.response.extract, "items");
});

test("LinkedIn-style quoted JSESSIONID echoed without quotes -> strip-quotes cookie ref", () => {
  const { operation } = learnOperation({
    exchanges: [
      {
        id: 1,
        resourceType: "fetch",
        request: {
          method: "GET",
          url: "https://www.linkedin.com/voyager/api/graphql?variables=(start:0,query:(keywords:rustacean))&queryId=voyagerSearchDashClusters.52fec77d08aa4598c8a056ca6bce6c11",
          headers: { "csrf-token": "ajax:4815162342", cookie: 'JSESSIONID="ajax:4815162342"; li_at=AQEDAxxxxxxxxxx' },
        },
        response: {
          status: 200,
          headers: {},
          contentType: "application/vnd.linkedin.normalized+json+2.1",
          body: '{"included":[{"title":"rustacean"}]}',
        },
      },
    ],
    examples: [{ keywords: "rustacean" }],
    cookies: [],
    name: "searchPeople",
    trigger: { url: "https://www.linkedin.com/search/results/people/?keywords={keywords}" },
    readOnly: true,
  });
  assert.deepEqual(
    operation.slots.find((s) => s.ref),
    { ref: "cookie:JSESSIONID", transform: "strip-quotes", at: ["header:csrf-token"] },
  );
  assert.deepEqual(operation.slots[0], {
    param: "keywords",
    at: ["query:variables"],
    template: "(start:0,query:(keywords:{keywords}))",
  });
  assert.equal(operation.request.headers["csrf-token"], "");
  const req = buildRequest(
    operation,
    { keywords: "zig" },
    { cookies: [cookie("JSESSIONID", '"ajax:1"', ".linkedin.com")], values: {} },
  );
  assert.ok(req.url.includes("variables=(start:0,query:(keywords:zig))&queryId="), req.url);
  assert.equal(req.headers["csrf-token"], "ajax:1");
});

test("Instagram-style form POST: friendly name is the anchor and the match operationName; JSON number params", () => {
  // variables carries a bare 19-digit JSON number, which URLSearchParams can't produce from a JS object
  const variables = '{"first":12345,"username":"nasa","id":2085462611575857621}';
  const body = `av=0&__user=0&fb_api_req_friendly_name=PolarisProfilePostsTabContentQuery&variables=${encodeURIComponent(variables)}&doc_id=27553725110923321`;
  const { operation } = learnOperation({
    exchanges: [
      {
        id: 7,
        resourceType: "xhr",
        request: {
          method: "POST",
          url: "https://www.instagram.com/api/graphql",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-ig-app-id": "936619743392459",
            "x-fb-lsd": "AVqbxe3J_YA",
          },
          body,
        },
        response: {
          status: 200,
          headers: {},
          contentType: "text/javascript; charset=utf-8",
          body: '{"data":{"user":{"edges":[{"n":1},{"n":2}]}}}',
        },
      },
    ],
    examples: [{ username: "nasa", first: 12345, id: "2085462611575857621" }],
    cookies: [],
    name: "posts",
    trigger: { url: "https://www.instagram.com/{username}/" },
    readOnly: true,
  });
  assert.deepEqual(operation.volatile, [
    { at: ["form:doc_id"], shape: { charset: "digits", length: 17 }, anchor: "PolarisProfilePostsTabContentQuery" },
  ]);
  assert.deepEqual(operation.match, {
    method: "POST",
    host: "www.instagram.com",
    path: "/api/graphql",
    operationName: "PolarisProfilePostsTabContentQuery",
  });
  const types = Object.fromEntries(operation.params.map((p) => [p.name, p.type]));
  assert.deepEqual(types, { username: "string", first: "number", id: "number" });
  assert.equal(operation.request.headers["x-ig-app-id"], "936619743392459");
  const req = buildRequest(
    operation,
    { username: "esa", first: "12", id: "1999999999999999999" },
    { cookies: [], values: {} },
  );
  assert.equal(
    new URLSearchParams(req.body).get("variables"),
    '{"first":12,"username":"esa","id":1999999999999999999}',
  );
});

test("HTML document op and an aborted write both learn", () => {
  const doc = learnOperation({
    exchanges: [
      {
        id: 1,
        resourceType: "document",
        request: { method: "GET", url: "https://news.ycombinator.com/from?site=github.com", headers: {} },
        response: {
          status: 200,
          headers: {},
          contentType: "text/html; charset=utf-8",
          body: "<tr class=athing>github.com</tr>",
        },
      },
    ],
    examples: [{ site: "github.com" }],
    cookies: [],
    name: "fromSite",
    trigger: { url: "https://news.ycombinator.com/from?site={site}" },
    readOnly: true,
  });
  assert.equal(doc.operation.response.format, "html");
  assert.ok(doc.warnings.some((w) => /response is HTML/.test(w)));

  const write = learnOperation({
    exchanges: [
      {
        id: 3,
        resourceType: "fetch",
        aborted: true,
        request: {
          method: "POST",
          url: "https://x.com/i/api/graphql/znCaGhOrM6q7DbrQdOYgPw/CreateTweet",
          headers: { "content-type": "application/json" },
          body: '{"variables":{"tweet_text":"hello from api-anything"},"queryId":"znCaGhOrM6q7DbrQdOYgPw"}',
        },
      },
    ],
    examples: [{ text: "hello from api-anything" }],
    cookies: [],
    name: "post",
    trigger: { url: "https://x.com/compose/post" },
    readOnly: false,
  });
  assert.deepEqual(write.operation.slots, [{ param: "text", at: ["body", "json:/variables/tweet_text"] }]);
  assert.equal(write.operation.readOnly, false);
  assert.deepEqual(write.operation.response, { format: "json" });
  assert.equal(write.operation.learnedLoggedIn, false);
});

test("example validation and pick errors", () => {
  const base = { exchanges: xExchanges("nasa", "t"), cookies: [], name: "g", trigger, readOnly: true };
  assert.throws(() => learnOperation({ ...base, examples: [{ screen_name: "na" }] }), /at least 3 characters/);
  assert.throws(() => learnOperation({ ...base, examples: [{ a: "nasa", b: "NASA" }] }), /must be distinct/);
  assert.throws(
    () => learnOperation({ ...base, examples: [{ screen_name: "nobody-here" }] }),
    /no captured request carries/,
  );
  assert.throws(
    () => learnOperation({ ...base, examples: [{ screen_name: "nasa" }], id: 99 }),
    /no captured request with id 99/,
  );
  const byId = learnOperation({ ...base, examples: [{ screen_name: "nasa" }], id: 1 });
  assert.equal(byId.operation.request.url, "https://x.com/nasa");
  assert.deepEqual(byId.operation.slots, [{ param: "screen_name", at: ["path:0"] }]);
  assert.deepEqual(byId.operation.match.path, "/*");
});

test("per-session form tokens (Google at, Meta fb_dtsg) become session refs, and a public header can stay literal", () => {
  const AT = "AJpMio3qL0x-Vw8nZ2rT9kYb4HsE:1727430000000";
  const DTSG = "NAcNq8Yx2b3LmPq:17:1727430000";
  const body = `f.req=${encodeURIComponent(JSON.stringify([[["rpc1", JSON.stringify(["paris"]), null, "generic"]]]))}&at=${encodeURIComponent(AT)}&fb_dtsg=${encodeURIComponent(DTSG)}&`;
  const exchanges: Exchange[] = [
    {
      id: 1,
      resourceType: "xhr",
      request: {
        method: "POST",
        url: "https://www.google.test/_/rpc?rpcids=rpc1",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: BEARER },
        body,
      },
      response: { status: 200, headers: {}, contentType: "application/json", body: '[["paris",1]]' },
    },
  ];
  const base = {
    exchanges,
    examples: [{ city: "paris" }] as [Record<string, unknown>],
    cookies: [],
    name: "s",
    trigger: { url: "https://www.google.test/s?q={city}" },
    readOnly: true,
  };
  const { operation: op, sessionValues } = learnOperation(base);
  assert.ok(op.slots.some((s) => s.ref === "session:s/at" && s.at[0] === "form:at"));
  assert.ok(op.slots.some((s) => s.ref === "session:s/fb_dtsg"));
  assert.equal(sessionValues["s/at"], AT);
  assert.ok(
    !op.request.body!.includes(encodeURIComponent(AT)) && !op.request.body!.includes(encodeURIComponent(DTSG)),
    op.request.body!,
  );
  assert.equal(op.request.headers.authorization, "", "authorization is a session ref by default");

  const pub = learnOperation({ ...base, public: ["Authorization"] }).operation;
  assert.equal(pub.request.headers.authorization, BEARER);
  assert.deepEqual(pub.public, ["authorization"]);
  assert.ok(!pub.slots.some((s) => s.ref === "session:s/authorization"));
});

test("an example value not in the chosen request is an error, not a param that changes nothing", () => {
  const exchanges: Exchange[] = [
    {
      id: 1,
      resourceType: "fetch",
      request: { method: "GET", url: "https://a.test/api/feed", headers: {} },
      response: { status: 200, headers: {}, contentType: "application/json", body: '{"items":[{"q":"sqlite"}]}' },
    },
  ];
  assert.throws(
    () =>
      learnOperation({
        exchanges,
        examples: [{ q: "sqlite" }],
        cookies: [],
        name: "s",
        trigger: { url: "https://a.test/?q={q}" },
        readOnly: true,
        id: 1,
      }),
    /"q" \("sqlite"\) is not in the learned request/,
  );
});

test("a learned template keeps the leaf's own {name} text (minified GraphQL selection)", () => {
  const body = JSON.stringify({ query: 'query{repository(owner:"octocat",name:"hello-world"){name}}' });
  const L = learnOperation({
    exchanges: [
      {
        id: 1,
        resourceType: "fetch",
        request: {
          method: "POST",
          url: "https://g.test/graphql",
          headers: { "content-type": "application/json" },
          body,
        },
        response: {
          status: 200,
          headers: {},
          contentType: "application/json",
          body: '{"data":{"repository":{"name":"hello-world"}}}',
        },
      },
    ],
    examples: [{ owner: "octocat", name: "hello-world" }],
    cookies: [],
    name: "repo",
    trigger: { url: "https://g.test/{owner}/{name}" },
    readOnly: true,
  });
  const out = buildRequest(L.operation, { owner: "torvalds", name: "linux" }, { cookies: [], values: {} }).body!;
  assert.equal(JSON.parse(out).query, 'query{repository(owner:"torvalds",name:"linux"){name}}');
});

test("telemetry that logs the page URL does not count as carrying the args", () => {
  const ex = (id: number, url: string, body?: string): Exchange => ({
    id,
    resourceType: "xhr",
    request: { method: body ? "POST" : "GET", url, headers: {}, ...(body ? { body } : {}) },
    response: { status: 200, headers: {}, contentType: "application/json", body: "{}" },
  });
  const ranked = rankCandidates(
    [
      ex(1, "https://x.test/1.1/viewer_context.json", JSON.stringify({ page: "https://x.test/nasa" })),
      ex(2, "https://api.x.test/User?screen_name=nasa"),
    ],
    {
      screen_name: "nasa",
    },
  );
  assert.deepEqual(
    ranked.map((c) => [c.id, c.hits]),
    [
      [2, ["screen_name"]],
      [1, []],
    ],
  );
  const video: Exchange = {
    ...ex(3, "https://video.test/seg-1.m4s?nasa"),
    response: { status: 200, headers: {}, contentType: "video/mp4", body: "x" },
  };
  assert.deepEqual(rankCandidates([video], { screen_name: "nasa" }), [], "media fetched by XHR is noise");
});

test("a short example found by chance inside a random header token is not a slot; the same value standing alone is", () => {
  const exchanges: Exchange[] = [
    {
      id: 1,
      resourceType: "xhr",
      request: {
        method: "GET",
        url: "https://g.test/api/calendar?origin=SFO&dest=JFK",
        // Google's x-goog-batchexecute-bgr: a random blob that happens to hold "SFO"
        headers: { "x-goog-batchexecute-bgr": "q7ZkSFOb2Xw9LmT4pRvN8cYd", "x-route": "k9Qz2Lw7Rt4Xy8/SFO/Mn3Vb6" },
      },
      response: {
        status: 200,
        headers: {},
        contentType: "application/json",
        body: '{"days":[{"from":"SFO","price":80},{"from":"SFO","price":95}]}',
      },
    },
  ];
  const { operation } = learnOperation({
    exchanges,
    examples: [{ origin: "SFO" }],
    cookies: [],
    name: "cal",
    trigger: { url: "https://g.test/" },
    readOnly: true,
  });
  const at = operation.slots.filter((s) => s.param === "origin").map((s) => s.at[0]);
  assert.deepEqual(at.sort(), ["header:x-route", "query:origin"]);
});

test("a response that is itself a list of results is learned whole, not as its first item", () => {
  const list = [
    { bookId: "1", title: "Dune" },
    { bookId: "2", title: "Dune Messiah" },
  ];
  const learned = learnOperation({
    exchanges: [
      {
        id: 1,
        resourceType: "xhr",
        request: { method: "GET", url: "https://books.example/auto_complete?format=json&q=dune", headers: {} },
        response: { status: 200, headers: {}, contentType: "application/json", body: JSON.stringify(list) },
      },
    ],
    examples: [{ q: "dune" }],
    cookies: [],
    name: "search",
    trigger: { url: "https://books.example/auto_complete?format=json&q={q}" },
    readOnly: true,
  });
  assert.equal(learned.operation.response.extract, undefined);
});

test("heal: a param the page did not send keeps the op's own place, only where that place still holds the same kind of value", () => {
  // a date picker asks for its own range: the caller's end is in no request it sends (issue #21)
  const exchange = (range: unknown): Exchange[] => [
    {
      id: 1,
      resourceType: "xhr",
      request: {
        method: "POST",
        url: "https://g.test/rpc/Calendar?bl=build_20261007",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: `f.req=${encodeURIComponent(JSON.stringify([null, JSON.stringify([["SFO", "JFK"], range])]))}`,
      },
      response: { status: 200, headers: {}, contentType: "application/json", body: '[["2027-04-01",209]]' },
    },
  ];
  type Established = NonNullable<Parameters<typeof learnOperation>[0]["established"]>;
  const input = (range: unknown, established?: Established, storage?: Record<string, string>) => ({
    exchanges: exchange(range),
    examples: [{ origin: "SFO", destination: "JFK", start: "2027-04-01", end: "2027-04-30" }] as [
      Record<string, string>,
    ],
    cookies: [],
    ...(storage ? { storage } : {}),
    name: "cal",
    trigger: { url: "https://g.test/cal?start={start}" },
    readOnly: true,
    match: { method: "POST", path: "/rpc/Calendar" },
    ...(established ? { established } : {}),
  });
  const start = ["form:f.req", "json:/1", "json:/1/0"];
  const end = ["form:f.req", "json:/1", "json:/1/1"];
  // the op's own places, as heal reads them from its own request: where each sits among its neighbours
  const established = (old: unknown[]): Established => {
    const was = walk({ ...exchange(old)[0]!.request });
    const placed = new Set([JSON.stringify(start), JSON.stringify(end)]);
    const place = (param: string, at: string[], value: string) => ({
      slot: { param, at },
      type: "string" as const,
      value,
      pattern: "\\d{4}-\\d{2}-\\d{2}",
      around: arrayAround(was, at, placed),
    });
    return [place("start", start, "2026-10-21"), place("end", end, "2026-10-31")];
  };
  const own = established(["2026-10-21", "2026-10-31"]);
  // add stays strict: an example the request does not carry is refused
  assert.throws(() => learnOperation(input(["2027-04-01", "2027-05-31"])), /example value for "end"/);
  const { operation, warnings } = learnOperation(input(["2027-04-01", "2027-05-31"], own));
  assert.deepEqual(operation.slots.find((s) => s.param === "end")?.at, end);
  assert.ok(
    warnings.some((w) => w.includes('"end"') && w.includes("kept there")),
    warnings.join("\n"),
  );
  const sent = buildRequest(
    operation,
    { origin: "LAX", destination: "BOS", start: "2027-06-01", end: "2027-06-10" },
    { cookies: [], values: {} },
  );
  const inner = JSON.parse(getAt(sent, ["form:f.req", "json:/1"]) as string);
  assert.deepEqual(inner, [
    ["LAX", "BOS"],
    ["2027-06-01", "2027-06-10"],
  ]);
  const refused = /example value for "end"/;
  // the request changed under it: the place is gone, or holds a number
  assert.throws(() => learnOperation(input(["2027-04-01"], own)), refused);
  assert.throws(() => learnOperation(input(["2027-04-01", 61], own)), refused);
  // fields reordered: the place holds a string of another kind ([start, locale, end])
  assert.throws(() => learnOperation(input(["2027-04-01", "en-US", "2027-05-31"], own)), refused);
  // a field inserted beside it ([start, cutoff, end]): the old place holds a date of the same kind, but not end
  assert.throws(() => learnOperation(input(["2027-04-01", "2027-06-30", "2027-05-31"], own)), refused);
  // a constant date beside it traded places with it ([start, end, cutoff] -> [start, cutoff, end])
  const own3 = established(["2026-10-21", "2026-10-31", "2026-12-31"]);
  assert.throws(() => learnOperation(input(["2027-04-01", "2026-12-31", "2027-05-31"], own3)), refused);
  assert.deepEqual(
    learnOperation(input(["2027-04-01", "2027-05-31", "2026-12-31"], own3)).operation.slots.find(
      (s) => s.param === "end",
    )?.at,
    end,
    "the same layout keeps it",
  );
  // the same kind but outside the param's pattern
  assert.throws(() => learnOperation(input(["2027-04-01", "2027-5-31"], own)), refused);
  // a credential the page keeps now sits there: never a param's place, so never saved as a literal
  const token = "2027-05-31";
  assert.throws(() => learnOperation(input(["2027-04-01", token], own, { auth_token: token })), refused);
  // a param that also sat inside a longer text cannot keep that place: refuse rather than leave it stale
  const templated: Established = [
    ...own,
    { slot: { param: "end", at: ["query:bl"], template: "build_{end}" }, type: "string", value: "build_2026-10-31" },
  ];
  assert.throws(() => learnOperation(input(["2027-04-01", "2027-05-31"], templated)), refused);
});

test("heal: a param found only where the op had it keeps its other places, which the page filled with its own value", () => {
  // Google's picker: the chosen day on its own, and the page's range from the first of that month
  const exchanges: Exchange[] = [
    {
      id: 1,
      resourceType: "xhr",
      request: {
        method: "POST",
        url: "https://g.test/rpc/Calendar",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: `f.req=${encodeURIComponent(JSON.stringify([["SFO", "JFK"], ["2027-04-01", "2027-06-09"], "2027-04-10"]))}`,
      },
      response: { status: 200, headers: {}, contentType: "application/json", body: '[["2027-04-10",209]]' },
    },
  ];
  type Established = NonNullable<Parameters<typeof learnOperation>[0]["established"]>;
  const at = (p: string) => ["form:f.req", `json:${p}`];
  const date = "\\d{4}-\\d{2}-\\d{2}";
  const own: Established = [
    { slot: { param: "start", at: at("/1/0") }, type: "string", value: "2026-10-21", pattern: date },
    { slot: { param: "start", at: at("/2") }, type: "string", value: "2026-10-21", pattern: date },
    { slot: { param: "end", at: at("/1/1") }, type: "string", value: "2026-10-31", pattern: date },
  ];
  const input = (established: Established, ex = exchanges) => ({
    exchanges: ex,
    examples: [{ origin: "SFO", destination: "JFK", start: "2027-04-10", end: "2027-04-20" }] as [
      Record<string, string>,
    ],
    cookies: [],
    name: "cal",
    trigger: { url: "https://g.test/cal?start={start}" },
    readOnly: true,
    match: { method: "POST", path: "/rpc/Calendar" },
    established,
  });
  const { operation } = learnOperation(input(own));
  const sent = buildRequest(
    operation,
    { origin: "LAX", destination: "BOS", start: "2027-06-03", end: "2027-06-08" },
    { cookies: [], values: {} },
  );
  assert.deepEqual(JSON.parse(getAt(sent, ["form:f.req"]) as string), [
    ["LAX", "BOS"],
    ["2027-06-03", "2027-06-08"],
    "2027-06-03",
  ]);
  // the range's first day now holds something else: refuse rather than send the page's value
  const moved = structuredClone(exchanges);
  moved[0]!.request.body = `f.req=${encodeURIComponent(JSON.stringify([["SFO", "JFK"], ["en-US", "2027-06-09"], "2027-04-10"]))}`;
  assert.throws(() => learnOperation(input(own, moved)), /"start" was also at .*now sends something else/);
  // a place inside a longer text ("from:{start}") that the page filled with its own value cannot stay
  const texts = structuredClone(exchanges);
  texts[0]!.request.body = `f.req=${encodeURIComponent(JSON.stringify([["SFO", "JFK"], "from:2027-04-01", "2027-04-10"]))}`;
  const templated: Established = [
    { slot: { param: "start", at: at("/1"), template: "from:{start}" }, type: "string", value: "from:2026-10-21" },
    { slot: { param: "start", at: at("/2") }, type: "string", value: "2026-10-21", pattern: date },
  ];
  assert.throws(
    () =>
      learnOperation({
        ...input(templated, texts),
        examples: [{ origin: "SFO", destination: "JFK", start: "2027-04-10" }] as [Record<string, string>],
      }),
    /"start" was also at form:f.req > json:\/1, where the page now sends something else/,
  );
});

test("heal keeps a place the page filled with the site's own origin, beside a cookie holding that origin", () => {
  // the page fills `dest` with its own address, and an analytics cookie keeps the same one
  const ex: Exchange = {
    id: 1,
    resourceType: "fetch",
    request: {
      method: "GET",
      url: `https://g.test/rpc/go?q=kittens&dest=${encodeURIComponent("https://g.test/")}`,
      headers: {},
    },
    response: { status: 200, headers: {}, contentType: "application/json", body: '{"results":[{"id":1},{"id":2}]}' },
  };
  const input = (cookies: StoredCookie[]) => ({
    exchanges: [ex],
    examples: [{ q: "kittens", dest: "https://elsewhere.test/" }] as [Record<string, string>],
    cookies,
    name: "go",
    trigger: { url: "https://g.test/go?q={q}" },
    readOnly: true,
    established: [
      { slot: { param: "dest", at: ["query:dest"] }, type: "string" as const, value: "https://other.test/" },
    ],
  });
  for (const cookies of [[], [cookie("__ps_lu", encodeURIComponent("https://g.test/"), "g.test")]]) {
    const { operation } = learnOperation(input(cookies));
    assert.deepEqual(operation.slots.find((s) => s.param === "dest")?.at, ["query:dest"], `${cookies.length} cookies`);
  }
});

test("an example whose lower case is longer (İstanbul) still leaves a hole in its template", () => {
  const request = { method: "GET", url: `http://localhost/api?q=${encodeURIComponent("from:İstanbul")}`, headers: {} };
  const { operation } = learnOperation({
    name: "search",
    readOnly: true,
    cookies: [],
    examples: [{ city: "İstanbul" }],
    trigger: { url: "http://localhost/search" },
    id: 1,
    exchanges: [
      {
        id: 1,
        resourceType: "xhr",
        request,
        response: { status: 200, contentType: "application/json", headers: {}, body: '[{"id":1}]' },
      },
    ],
  });
  assert.equal(operation.slots[0]!.template, "from:{city}");
  const url = buildRequest(operation, { city: "Ankara" }, { cookies: [], values: {} }).url;
  assert.equal(new URL(url).searchParams.get("q"), "from:Ankara");

  // lower case still reads context where the length holds: the frontend's "σερρες" is the example "ΣΕΡΡΕΣ"
  const greek = learnOperation({
    name: "search",
    readOnly: true,
    cookies: [],
    examples: [{ city: "ΣΕΡΡΕΣ" }],
    trigger: { url: "http://localhost/search" },
    id: 1,
    exchanges: [
      {
        id: 1,
        resourceType: "xhr",
        request: { ...request, url: `http://localhost/api?q=${encodeURIComponent("σερρες")}` },
        response: { status: 200, contentType: "application/json", headers: {}, body: '[{"id":1}]' },
      },
    ],
  }).operation;
  assert.deepEqual(greek.slots[0]?.at, ["query:q"]);
});

test("a UUID the page makes for each request is a gen slot: no session ref, no nonce, nothing kept", () => {
  const page = (item: string, id: number, body = `<h1>${item}</h1>`): Exchange => ({
    id,
    resourceType: "document",
    request: { method: "GET", url: `https://shop.test/p/${item}`, headers: {} },
    response: { status: 200, headers: {}, contentType: "text/html", body },
  });
  const order = (item: string, key: string, req: string, id: number): Exchange => ({
    id,
    resourceType: "fetch",
    request: {
      method: "POST",
      url: "https://shop.test/api/order",
      headers: { "content-type": "application/json", "idempotency-key": key, "x-request-id": req },
      body: JSON.stringify({ item, qty: 1 }),
    },
  });
  const K1 = "3b241101-e2bb-4255-8caf-4136c566a962";
  const K2 = "9f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f";
  const R1 = "0d6f2c1e-7a3b-4f5e-8d9c-2b1a0e9f8d7c";
  const R2 = "6e5d4c3b-2a19-4807-a6f5-e4d3c2b1a098";
  const input = (doc1?: string) => ({
    exchanges: [page("fridge", 1, doc1), order("fridge", K1, R1, 2)],
    exchanges2: [page("toaster", 3), order("toaster", K2, R2, 4)],
    examples: [{ item: "fridge" }, { item: "toaster" }] as [Record<string, unknown>, Record<string, unknown>],
    cookies: [],
    match: { method: "POST", path: "/api/order" },
    name: "order",
    trigger: { url: "https://shop.test/p/{item}", steps: [{ action: "click" as const, selector: "#buy" }] },
    readOnly: false,
  });
  const learned = learnOperation(input());
  const op = learned.operation;
  assert.deepEqual(
    op.slots.filter((s) => s.gen).map((s) => [s.gen, s.at]),
    [
      ["uuid", ["header:idempotency-key"]],
      ["uuid", ["header:x-request-id"]],
    ],
  );
  assert.ok(!op.slots.some((s) => s.ref), JSON.stringify(op.slots));
  assert.deepEqual(learned.sessionValues, {});
  assert.equal(op.minTier, 1, "the page's own UUID is no signature");
  const serialized = JSON.stringify(op);
  for (const v of [K1, K2, R1, R2]) assert.ok(!serialized.includes(v), `${v} stayed in the spec`);

  // filled per seed: the same seed (one call's retries, or one idempotency key) gives the same value
  const none = { cookies: [], values: {} };
  const a = buildRequest(op, { item: "kettle" }, none, "seed-a");
  const again = buildRequest(op, { item: "kettle" }, none, "seed-a");
  const b = buildRequest(op, { item: "kettle" }, none, "seed-b");
  assert.match(a.headers["idempotency-key"]!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a.headers["idempotency-key"], again.headers["idempotency-key"]);
  assert.notEqual(a.headers["idempotency-key"], b.headers["idempotency-key"]);
  assert.notEqual(a.headers["idempotency-key"], a.headers["x-request-id"]);
  assert.equal(JSON.parse(a.body!).item, "kettle");

  // one the site handed the page (in the document before the request) is the site's: no gen slot
  const issued = learnOperation(input(`<h1>fridge</h1><script>window.key="${K1}"</script>`)).operation;
  assert.ok(!issued.slots.some((s) => s.gen && s.at[0] === "header:idempotency-key"), JSON.stringify(issued.slots));
});

test("a token the page takes out of a structured cookie becomes a session ref: no credential in the serialized spec", () => {
  const TICKET = "vRf7Qm2ZkL9xT4cN8bW1yH6pD3sJ5gUa";
  const learnWith = (value: string, headers: Record<string, string>, query = "") =>
    learnOperation({
      exchanges: [
        {
          id: 1,
          resourceType: "fetch",
          request: {
            method: "GET",
            url: `https://www.shop.test/api/search?q=lanterns${query}`,
            headers: { ...headers, cookie: `userinfo=${value}` },
          },
          response: {
            status: 200,
            headers: {},
            contentType: "application/json",
            body: '{"items":[{"title":"lantern one","price":12},{"title":"lantern two","price":14}]}',
          },
        },
      ],
      examples: [{ q: "lanterns" }],
      cookies: [cookie("userinfo", value, "www.shop.test")],
      name: "search",
      trigger: { url: "https://www.shop.test/search?q={q}" },
      readOnly: true,
    });
  for (const [what, value] of [
    ["URL-encoded JSON", encodeURIComponent(JSON.stringify({ id: 42, name: "Jane Dummy", ticket: TICKET }))],
    ["k=v text", encodeURIComponent(`uid=42&name=Jane Dummy&ticket=${TICKET}`)],
    ["a|b", `42|${TICKET}`],
    ["base64 of JSON", Buffer.from(JSON.stringify({ id: 42, ticket: TICKET })).toString("base64")],
  ] as const) {
    // a header named like no credential, and the same token inside a longer field
    const learned = learnWith(value, { "x-member-ticket": TICKET }, `&ctx=member:${TICKET}`);
    const op = learned.operation;
    assert.ok(!JSON.stringify(op).includes(TICKET), `${what}: the token stayed in the spec`);
    assert.deepEqual(
      op.slots.filter((s) => s.ref),
      [
        { ref: "session:search/userinfo", at: ["header:x-member-ticket"] },
        { ref: "session:search/userinfo", at: ["query:ctx"], template: "member:{session:search/userinfo}" },
      ],
      what,
    );
    assert.deepEqual(learned.sessionValues, { "search/userinfo": TICKET }, what);
    assert.deepEqual(learned.settings, [], `${what}: kept as a credential`);
    const req = buildRequest(op, { q: "teapots" }, { cookies: [], values: learned.sessionValues });
    assert.equal(req.headers["x-member-ticket"], TICKET);
    assert.equal(new URL(req.url).searchParams.get("ctx"), `member:${TICKET}`);
  }
  // sent whole, the cookie keeps its cookie: ref
  const whole = learnWith(TICKET, { "x-member-ticket": TICKET }).operation;
  assert.deepEqual(
    whole.slots.filter((s) => s.ref),
    [{ ref: "cookie:userinfo", at: ["header:x-member-ticket"] }],
  );
  // where no pass can make a ref of it (base64 of the token in a field), the learn is refused
  assert.throws(
    () => learnWith(`42|${TICKET}`, {}, `&ctx=${Buffer.from(`member:${TICKET}`).toString("base64url")}`),
    /would keep a credential in the spec: query:ctx holds the live cookie userinfo/,
  );
});

/** One search request of www.shop.test, learned with the cookies the request sent. */
const learnSearch = (
  cookies: StoredCookie[],
  o: { q?: string; host?: string; headers?: Record<string, string>; page?: string; api?: string } = {},
) => {
  const { q = "lanterns", host = "www.shop.test" } = o;
  return learnOperation({
    exchanges: [
      {
        id: 1,
        resourceType: "fetch",
        request: {
          method: "GET",
          url: `https://${host}${o.api ?? "/api/search"}?q=${encodeURIComponent(q)}`,
          headers: { ...o.headers, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
        },
        response: {
          status: 200,
          headers: {},
          contentType: "application/json",
          body: '{"items":[{"title":"lantern one","price":12},{"title":"lantern two","price":14}]}',
        },
      },
    ],
    examples: [{ q }],
    cookies,
    name: "search",
    trigger: { url: o.page ?? `https://${host}/search?q={q}` },
    readOnly: true,
  });
};

test("a token a cookie holds beside other text is a session ref, however the cookie joins them: no credential in the serialized spec", () => {
  const TICKET = "vRf7Qm2ZkL9xT4cN8bW1yH6pD3sJ5gUa";
  const json = (ticket: string) => encodeURIComponent(JSON.stringify({ id: 42, ticket }));
  for (const [what, value, sent] of [
    ["token.signature", `${TICKET}.Zx81kkQpLm20asDFgh77qwErTy`, TICKET],
    ["id-token", `42-${TICKET}`, TICKET],
    ["v1_token", `v1_${TICKET}`, TICKET],
    ["id!token", `42!${TICKET}`, TICKET],
    ["id~token", `42~${TICKET}`, TICKET],
    ["24 digits", json("839201746501928374650192"), "839201746501928374650192"],
    ["lowercase letters", json("qwertyuiopasdfghjklzxcvbnm"), "qwertyuiopasdfghjklzxcvbnm"],
    ["15 characters", json("aB3dE5fG7hJ9kL2"), "aB3dE5fG7hJ9kL2"],
    ["base64 with short pieces", json("aB3d/E5fG7hJ9+k/L2mN4pQ6rS8tU0"), "aB3d/E5fG7hJ9+k/L2mN4pQ6rS8tU0"],
    ["a \\u escape in the cookie's JSON", `{"t":"vRf\\u0037${TICKET.slice(4)}"}`, TICKET],
    [
      "base64 of base64",
      Buffer.from(Buffer.from(JSON.stringify({ t: TICKET })).toString("base64")).toString("base64"),
      TICKET,
    ],
  ] as const) {
    const cookies = [cookie("userinfo", value, "www.shop.test")];
    const learned = learnSearch(cookies, { headers: { "x-member-ticket": sent } });
    assert.ok(!JSON.stringify(learned.operation).includes(sent), `${what}: the token stayed in the spec`);
    assert.deepEqual(
      learned.operation.slots.filter((s) => s.ref),
      [{ ref: "session:search/userinfo", at: ["header:x-member-ticket"] }],
      what,
    );
    assert.deepEqual(learned.sessionValues, { "search/userinfo": sent }, what);
    assert.deepEqual(scanSecrets(learned.operation, { cookies, values: learned.sessionValues }).secrets, [], what);
  }
});

test("a cookie that keeps the page's address or what the caller asked for refuses no learn", () => {
  const consent = (landing: string) =>
    `isGpcEnabled=0&datestamp=Thu+Nov+12+2026+10%3A00%3A00+GMT-0800&version=202403.1.0&hosts=&landingPath=${encodeURIComponent(landing)}&groups=C0001%3A1%2CC0002%3A1`;
  const uuid = "3f2b8c1e-9d4a-4e7b-8a6f-1c2d3e4f5a6b";
  const id = "4Z8W4fKeB5YxbusRsdQVPb";
  const cases: [string, StoredCookie, Parameters<typeof learnSearch>[1]][] = [
    [
      "a host with a digit in a consent cookie's landing page",
      cookie("OptanonConsent", consent("https://www.forever21.com/us/shop"), "www.forever21.com"),
      { host: "www.forever21.com" },
    ],
    [
      "the example in the landing page's address",
      cookie("OptanonConsent", consent("https://www.shop.test/search?q=garden-lanterns-2026"), "www.shop.test"),
      { q: "garden-lanterns-2026" },
    ],
    [
      "a slug in a landing-page cookie",
      cookie("_landing_page", encodeURIComponent("/products/apple-iphone-15-pro-max-256gb?ref=home"), "www.shop.test"),
      { q: "apple-iphone-15-pro-max-256gb" },
    ],
    [
      "a UUID the caller asked for, kept as the last one viewed",
      cookie("ws", encodeURIComponent(JSON.stringify({ last: uuid, theme: "dark" })), "www.shop.test"),
      { q: uuid },
    ],
    [
      "an id in the page address the caller gave",
      cookie("OptanonConsent", consent(`https://www.shop.test/artist/${id}/albums?q=lanterns`), "www.shop.test"),
      { page: `https://www.shop.test/artist/${id}/albums?q={q}`, api: `/api/artist/${id}/albums` },
    ],
  ];
  for (const [what, c, o] of cases) {
    const learned = learnSearch([c], o);
    const op = learned.operation;
    assert.deepEqual(op.slots, [{ param: "q", at: ["query:q"] }], what);
    assert.deepEqual(learned.sessionValues, {}, what);
    // and the saved op passes the scan a save, a heal, an export and an upload run
    assert.deepEqual(scanSecrets(op, { cookies: [c], values: {} }).secrets, [], what);
  }
});
