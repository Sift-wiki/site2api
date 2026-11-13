/** The registry's defences against a hostile uploader: each test reproduces one way in that used to work. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { requestSig } from "../../src/registry-api.js";
import { OperationSchema, parseSite } from "../../src/spec.js";
import { LIMITS, vetShared } from "../../src/vet.js";
import { search } from "../src/catalog.js";
import worker, { type Env } from "../src/worker.js";
import { ADMIN, evidence, install, op, registry, report, seed, send, site, upload } from "./helpers.js";

/** A site on example.net, its op on www.example.net. */
const net = (name: string, over: Record<string, unknown> = {}) => ({
  site: { name, domain: "example.net", baseUrl: "https://www.example.net", ...over },
  operation: op({
    request: { method: "GET", url: "https://www.example.net/api/search?q=dune", headers: {} },
    trigger: { url: "https://www.example.net/search?q={q}" },
    match: { host: "www.example.net", path: "/api/search" },
  }),
});

async function uploaded(env: Env, body: unknown): Promise<{ hash: string; status: string; reasons?: string[] }> {
  const r = await send(env, "POST", "/v1/versions", { as: install(), body });
  assert.equal(r.status, 201, r.text);
  return r.body;
}

describe("reads that write, sent to review", () => {
  const post = (url: string, body: string, over: Record<string, unknown> = {}) =>
    op({
      request: { method: "POST", url, headers: { "content-type": "application/json" }, body },
      match: { host: "www.example.com", path: new URL(url).pathname },
      ...over,
    });

  test("a read sent as POST is review, unless it carries only GraphQL query documents", async () => {
    const { env } = registry();
    const settings = await uploaded(
      env,
      upload({ operation: post("https://www.example.com/account/settings", '{"email":"a@b.example","q":"dune"}') }),
    );
    assert.equal(settings.status, "review");
    assert.ok(
      settings.reasons?.some((x) => /a read sent as POST, not a GraphQL query/.test(x)),
      JSON.stringify(settings),
    );

    const query = await uploaded(
      env,
      upload({
        operation: post(
          "https://www.example.com/graphql",
          '{"query":"query Search($q: String) { search(q: $q) { title } }","variables":{"q":"dune"}}',
          { name: "gqlSearch", slots: [{ param: "q", at: ["json:/variables/q"] }] },
        ),
      }),
    );
    assert.equal(query.status, "candidate", JSON.stringify(query));

    // a persisted query names no document: it could be a mutation
    const persisted = await uploaded(
      env,
      upload({
        operation: post(
          "https://www.example.com/graphql",
          '{"operationName":"Search","variables":{"q":"dune"},"extensions":{"persistedQuery":{"version":1}}}',
          { name: "gqlPersisted", slots: [{ param: "q", at: ["json:/variables/q"] }] },
        ),
      }),
    );
    assert.equal(persisted.status, "review");
  });

  test("a slot that sends the caller's cookie or session value is review", async () => {
    const { env } = registry();
    const r = await uploaded(
      env,
      upload({
        operation: op({
          request: { method: "GET", url: "https://www.example.com/api/search?q=dune", headers: { "x-csrf": "x" } },
          slots: [
            { param: "q", at: ["query:q"] },
            { ref: "cookie:csrftoken", at: ["header:x-csrf"] },
          ],
        }),
      }),
    );
    assert.equal(r.status, "review");
    assert.ok(
      r.reasons?.some((x) => /caller's own cookie:csrftoken/.test(x)),
      JSON.stringify(r),
    );
  });

  test("a cookie or session ref inside a slot's template is review", async () => {
    const templated = (slot: Record<string, unknown>, header: string) =>
      upload({
        operation: op({
          request: { method: "GET", url: "https://www.example.com/api/search?q=dune", headers: { [header]: "x" } },
          slots: [{ param: "q", at: ["query:q"] }, slot],
        }),
      });
    const bearer = await uploaded(
      registry().env,
      templated({ param: "q", at: ["header:authorization"], template: "Bearer {session:token}" }, "authorization"),
    );
    assert.equal(bearer.status, "review", JSON.stringify(bearer));
    assert.ok(
      bearer.reasons?.some((x) => /caller's own session:token/.test(x)),
      JSON.stringify(bearer),
    );
    const csrf = await uploaded(
      registry().env,
      templated({ param: "q", at: ["header:x-csrftoken"], template: "{cookie:csrftoken}" }, "x-csrftoken"),
    );
    assert.equal(csrf.status, "review", JSON.stringify(csrf));
    assert.ok(
      csrf.reasons?.some((x) => /caller's own cookie:csrftoken/.test(x)),
      JSON.stringify(csrf),
    );
    // a lookup's slot counts as the op's own
    const lookup = await uploaded(
      registry().env,
      upload({
        operation: op({
          request: { method: "GET", url: "https://www.example.com/api/search?q=dune&id=7", headers: {} },
          slots: [
            { param: "q", at: ["query:q"] },
            {
              at: ["query:id"],
              path: "id",
              from: {
                request: { method: "GET", url: "https://www.example.com/api/id?q=dune&t=x", headers: {} },
                slots: [
                  { param: "q", at: ["query:q"] },
                  { param: "q", at: ["query:t"], template: "{cookie:csrftoken}" },
                ],
              },
            },
          ],
        }),
      }),
    );
    assert.ok(
      lookup.reasons?.some((x) => /caller's own cookie:csrftoken/.test(x)),
      JSON.stringify(lookup),
    );
    // an arg's hole and literal braces are no ref
    const plain = await uploaded(
      registry().env,
      templated({ param: "q", at: ["header:x-note"], template: "{q} {{session:token}}" }, "x-note"),
    );
    assert.equal(plain.status, "candidate", JSON.stringify(plain));
  });

  test("a query document beside anything else is review", async () => {
    const gql = "https://www.example.com/graphql";
    const json = { "content-type": "application/json" };
    const variables = [{ param: "q", at: ["body", "json:/variables/q"] }];
    const cases: [string, string, Record<string, string>, string][] = [
      [
        "a decoy query leaf",
        "https://www.example.com/api/account/close",
        json,
        '{"confirm":true,"query":"query Q { viewer { id } }"}',
      ],
      [
        "a batch with a documentless item",
        gql,
        json,
        '[{"query":"{ __typename }"},{"operationName":"CloseAccount","variables":{"confirm":true},"extensions":{"persistedQuery":{"version":1}}}]',
      ],
      [
        "a document beside a persisted query",
        gql,
        json,
        '{"query":"{ __typename }","operationName":"CloseAccount","extensions":{"persistedQuery":{"version":1}}}',
      ],
      [
        "no document under a content type that says graphql",
        "https://www.example.com/api/account/close",
        { "content-type": "application/json; profile=graphql" },
        '{"confirm":true}',
      ],
      [
        "a JSON mutation under application/graphql+json",
        gql,
        { "content-type": "application/graphql+json" },
        '{"query":"mutation { closeAccount { ok } }"}',
      ],
      ["a repeated query key", gql, json, '{"query":"mutation { closeAccount { ok } }","query":"{ __typename }"}'],
      ["a batch item that is no object", gql, json, '[{"query":"{ __typename }"},"closeAccount"]'],
      ["an empty document", gql, json, '{"query":" "}'],
      ["JSON sent as a raw document", gql, { "content-type": "application/graphql" }, '{"confirm":true}'],
    ];
    for (const [what, url, headers, body] of cases) {
      const r = await send(registry().env, "POST", "/v1/versions", {
        as: install(),
        body: upload({
          operation: op({
            name: "viewer",
            request: { method: "POST", url, headers, body },
            slots: [],
            params: [],
            trigger: { url: "https://www.example.com/me" },
            match: { host: "www.example.com", path: new URL(url).pathname },
          }),
        }),
      });
      // the shared rules may refuse it outright; what it must never be is served unreviewed
      if (r.status === 201) assert.equal(r.body.status, "review", `${what}: ${r.text}`);
      else assert.equal(r.status, 422, `${what}: ${r.text}`);
    }

    // what stays a candidate: documents, their variables and their names, and nothing else
    const queries: [string, Record<string, string>, string, unknown[]][] = [
      [
        "a named query",
        json,
        '{"operationName":"Search","query":"query Search($q: String) { search(q: $q) { title } }","variables":{"q":"dune"}}',
        variables,
      ],
      ["a shorthand query", json, '{"query":"{ search(first: 3) { title } }"}', []],
      [
        "a batch of two queries",
        json,
        '[{"query":"query A { a }"},{"query":"query Search($q: String) { search(q: $q) { title } }","variables":{"q":"dune"}}]',
        [{ param: "q", at: ["body", "json:/1/variables/q"] }],
      ],
      [
        "a raw document",
        { "content-type": "application/graphql; charset=utf-8" },
        "query Search { search { title } }",
        [],
      ],
    ];
    for (const [what, headers, body, slots] of queries) {
      const r = await uploaded(
        registry().env,
        upload({
          operation: op({
            name: "gqlSearch",
            request: { method: "POST", url: gql, headers, body },
            slots,
            params: slots.length ? op().params : [],
            trigger: { url: "https://www.example.com/search" },
            match: { host: "www.example.com", path: "/graphql" },
          }),
        }),
      );
      assert.equal(r.status, "candidate", `${what}: ${JSON.stringify(r)}`);
    }
  });

  test("a POST whose document a slot fills is review", async () => {
    // the stored document is a param's placeholder: whatever the param's default says is what a call sends
    const filled = await send(registry().env, "POST", "/v1/versions", {
      as: install(),
      body: upload({
        operation: op({
          name: "viewer",
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
              type: "string",
              required: false,
              default: "mutation { closeAccount(confirm: true) { ok } }",
              example: "{ viewer { id } }",
            },
          ],
          trigger: { url: "https://www.example.com/me" },
          match: { host: "www.example.com", path: "/api/gql" },
          response: { format: "json", extract: "data" },
        }),
      }),
    });
    if (filled.status === 201) assert.equal(filled.body.status, "review", filled.text);
    else assert.equal(filled.status, 422, filled.text);

    // a search API's body has the same shape, so it is a maintainer's call too
    const searchBody = await uploaded(
      registry().env,
      upload({
        operation: op({
          request: {
            method: "POST",
            url: "https://www.example.com/api/search",
            headers: { "content-type": "application/json" },
            body: '{"query":"{q}"}',
          },
          slots: [{ param: "q", at: ["body", "json:/query"] }],
        }),
      }),
    );
    assert.equal(searchBody.status, "review", JSON.stringify(searchBody));
    assert.ok(
      searchBody.reasons?.some((x) => /a read sent as POST, not a GraphQL query/.test(x)),
      JSON.stringify(searchBody),
    );
  });

  test("a GraphQL body another parser would read differently is review", async () => {
    const hidden = '{"query":"{ a }","variables":{"x":"&query=mutation{closeAccount{ok}}&y="}}';
    const form = "application/x-www-form-urlencoded";
    const cases: [string, Record<string, string>, string, unknown[], unknown[]][] = [
      // a form parser reads query=mutation{closeAccount{ok}}
      ["JSON under a form content type", { "content-type": form }, hidden, [], []],
      ["JSON under no content type", {}, hidden, [], []],
      ["JSON under text/plain", { "content-type": "text/plain" }, hidden, [], []],
      [
        "a slot that fills the content type",
        { "content-type": "application/json" },
        hidden,
        [{ param: "ct", at: ["header:content-type"] }],
        [{ name: "ct", type: "string", required: false, default: form }],
      ],
      [
        "a header slot, however it is cased",
        { "content-type": "application/json" },
        hidden,
        [{ param: "ct", at: ["header:Content-Type"] }],
        [{ name: "ct", type: "string", required: false, default: form }],
      ],
      [
        "a form slot on a raw document",
        { "content-type": "application/graphql" },
        "query Search { search { title } }",
        [{ param: "x", at: ["form:x"] }],
        [{ name: "x", type: "string", required: false, default: "1" }],
      ],
      [
        "a form slot on a JSON body",
        { "content-type": "application/json" },
        '{"query":"{ a }"}',
        [{ param: "x", at: ["form[1]:x"] }],
        [{ name: "x", type: "string", required: false, default: "1" }],
      ],
    ];
    for (const [what, headers, body, slots, params] of cases) {
      const r = await send(registry().env, "POST", "/v1/versions", {
        as: install(),
        body: upload({
          operation: op({
            name: "viewer",
            request: { method: "POST", url: "https://www.example.com/graphql", headers, body },
            slots,
            params,
            trigger: { url: "https://www.example.com/me" },
            match: { host: "www.example.com", path: "/graphql" },
          }),
        }),
      });
      if (r.status === 201) assert.equal(r.body.status, "review", `${what}: ${r.text}`);
      else assert.equal(r.status, 422, `${what}: ${r.text}`);
    }
    // JSON as JSON, with its charset, and under the media type that says GraphQL over JSON
    for (const type of ["application/json; charset=utf-8", "application/graphql+json"]) {
      const r = await uploaded(
        registry().env,
        upload({
          operation: op({
            name: "gqlSearch",
            request: {
              method: "POST",
              url: "https://www.example.com/graphql",
              headers: { "content-type": type },
              body: '{"query":"query Search($q: String) { search(q: $q) { title } }","variables":{"q":"dune"}}',
            },
            slots: [{ param: "q", at: ["body", "json:/variables/q"] }],
            trigger: { url: "https://www.example.com/search" },
            match: { host: "www.example.com", path: "/graphql" },
          }),
        }),
      );
      assert.equal(r.status, "candidate", `${type}: ${JSON.stringify(r)}`);
    }
  });

  test("a new op name on a site with a login is review; a new version of an op it has is not", async () => {
    const bookPage = op({ name: "bookPage", match: { host: "www.example.com", path: "/api/book" } });
    const variant = op({ description: "Find books by title words, again" });

    const cookies = registry();
    await seed(cookies.env, { site: { ...site, loginCookies: ["sessionid"] }, operations: [op()] });
    const added = await uploaded(cookies.env, upload({ operation: bookPage }));
    assert.equal(added.status, "review");
    assert.ok(
      added.reasons?.some((x) => /new op on a site with a login: bookPage/.test(x)),
      JSON.stringify(added),
    );
    assert.equal((await uploaded(cookies.env, upload({ operation: variant }))).status, "candidate");

    const loginOp = registry();
    const shelf = op({ name: "shelf", learnedLoggedIn: true, match: { host: "www.example.com", path: "/api/shelf" } });
    await seed(loginOp.env, { site, operations: [op(), shelf] });
    assert.equal((await uploaded(loginOp.env, upload({ operation: bookPage }))).status, "review");

    // a first upload that lists login cookies itself
    const fresh = registry();
    const first = await uploaded(fresh.env, upload({ site: { ...site, loginCookies: ["sessionid"] } }));
    assert.equal(first.status, "review");
  });
});

describe("site names", () => {
  test("a new site's name is its domain with dots as dashes; a seed is exempt", async () => {
    const { env } = registry();
    for (const name of ["github", "example", "examplenet", "example.net"]) {
      const r = await send(env, "POST", "/v1/versions", { as: install(), body: upload(net(name)) });
      assert.equal(r.status, 422, name);
      assert.match(r.body.reasons[0], new RegExp(`domain example\\.net with dots as dashes: example-net, not ${name}`));
    }
    assert.equal(
      (await send(env, "POST", "/v1/versions", { as: install(), body: upload(net("example-net")) })).status,
      201,
    );
    const weather = net("weather");
    assert.equal((await seed(env, { site: weather.site, operations: [weather.operation] })).status, 200);
    // a name already bound to its domain stays welcome
    const again = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ site: weather.site, operation: weather.operation }),
    });
    assert.equal(again.status, 200, again.text);
  });

  test("an uploaded title is ignored: a site nobody seeded is titled by its domain", async () => {
    const { env } = registry();
    await uploaded(env, upload(net("example-net", { displayName: "GitHub", description: "Repositories" })));
    const served = (await send(env, "GET", "/v1/sites/example-net")).body;
    assert.equal(served.displayName, "example.net");
    assert.equal((await seed(env, { site, operations: [op()] })).status, 200);
    assert.equal((await send(env, "GET", "/v1/sites/example-com")).body.displayName, "Books", "a seed keeps its own");
  });
});

describe("drive-by ops on established sites", () => {
  const follow = op({
    name: "follow",
    description: "List follows",
    request: { method: "GET", url: "https://www.example.com/api/friendships/create?screen_name=x", headers: {} },
    slots: [{ param: "q", at: ["query:screen_name"] }],
    trigger: { url: "https://www.example.com/{q}" },
    match: { host: "www.example.com", path: "/api/friendships/create" },
  });

  test("a new op name on a seeded or live site is review; a new version of an op it has is not", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    const added = await uploaded(env, upload({ operation: follow }));
    assert.equal(added.status, "review");
    assert.ok(
      added.reasons?.some((x) => /new op on an established site: follow/.test(x)),
      JSON.stringify(added),
    );
    const variant = op({ description: "Find books by title words, again" });
    assert.equal((await uploaded(env, upload({ operation: variant }))).status, "candidate");

    // live by the crowd, not seeded, counts too
    const crowd = registry();
    const first = await uploaded(crowd.env, upload(net("example-net")));
    await send(crowd.env, "POST", `/v1/admin/versions/${(first as { hash?: string }).hash}`, {
      body: { status: "live" },
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const extra = { ...net("example-net").operation, name: "extra", match: { host: "www.example.net", path: "/x" } };
    assert.equal(
      (await uploaded(crowd.env, upload({ site: net("example-net").site, operation: extra }))).status,
      "review",
    );
  });

  test("a second name for an established domain is no way around it", async () => {
    const { env } = registry();
    // the seed named it books; the upload rule names it example-com
    await seed(env, { site: { ...site, name: "books" }, operations: [op()] });
    const r = await uploaded(env, upload({ operation: follow }));
    assert.equal(r.status, "review");
    assert.equal((await uploaded(env, upload())).status, "review", "every op of a parallel site is new to it");
  });
});

describe("an op name no live version holds is still new", () => {
  const servedNames = async (env: Env) =>
    (await send(env, "GET", "/v1/sites/example-com")).body.operations.map(
      (o: { operation: { name: string }; status: string }) => `${o.operation.name}:${o.status}`,
    );
  const at = (name: string, path: string, description: string) =>
    op({
      name,
      description,
      request: { method: "GET", url: `https://www.example.com${path}?q=dune`, headers: {} },
      match: { host: "www.example.com", path },
    });

  test("a second upload under a name only a review version holds is review, on an established site", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    const first = await uploaded(env, upload({ operation: at("follow", "/api/friendships/create", "List follows") }));
    assert.equal(first.status, "review");
    const again = await uploaded(
      env,
      upload({ operation: at("follow", "/api/friendships/create", "List follows, again") }),
    );
    assert.equal(again.status, "review", JSON.stringify(again));
    assert.ok(
      again.reasons?.some((x) => /new op on an established site: follow/.test(x)),
      JSON.stringify(again),
    );
    assert.deepEqual(await servedNames(env), ["searchBooks:live"]);
  });

  test("the same on a site with a login, seeded or not", async () => {
    const login = { ...site, loginCookies: ["sessionid"] };
    const seeded = registry();
    await seed(seeded.env, { site: login, operations: [op()] });
    const book = (d: string) => upload({ operation: at("bookPage", "/api/book", d) });
    assert.equal((await uploaded(seeded.env, book("A book"))).status, "review");
    assert.equal((await uploaded(seeded.env, book("A book, again"))).status, "review");

    const fresh = registry();
    const own = (d: string) => upload({ site: login, operation: at("bookPage", "/api/book", d) });
    assert.equal((await uploaded(fresh.env, own("A book"))).status, "review");
    const again = await uploaded(fresh.env, own("A book, again"));
    assert.equal(again.status, "review", JSON.stringify(again));
    assert.ok(
      again.reasons?.some((x) => /new op on a site with a login: bookPage/.test(x)),
      JSON.stringify(again),
    );
  });

  test("a re-upload under the name of a blocked op, or of one the seed dropped, is review", async () => {
    const { env } = registry();
    const first = (await seed(env, { site, operations: [op(), at("legacy", "/api/legacy", "Legacy")] })).body
      .operations;
    const hash = first.find((o: { name: string }) => o.name === "searchBooks").hash;
    await send(env, "POST", `/v1/admin/versions/${hash}`, {
      body: { status: "blocked" },
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const blocked = await uploaded(
      env,
      upload({ operation: at("searchBooks", "/psettings/close-account", "Find books") }),
    );
    assert.equal(blocked.status, "review", JSON.stringify(blocked));

    // the next seed no longer has legacy: its version is archived
    await seed(env, { site, operations: [at("other", "/api/other", "Other")] });
    const dropped = await uploaded(env, upload({ operation: at("legacy", "/psettings/close-account", "Legacy") }));
    assert.equal(dropped.status, "review", JSON.stringify(dropped));
    assert.deepEqual(await servedNames(env), ["other:live"]);
  });

  test("a version of a live op that keeps its match is a candidate, as is anything on a site with no live op", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    assert.equal((await uploaded(env, upload({ operation: op({ description: "repaired" }) }))).status, "candidate");

    const fresh = registry();
    assert.equal((await uploaded(fresh.env, upload())).status, "candidate");
    assert.equal((await uploaded(fresh.env, upload({ operation: op({ description: "again" }) }))).status, "candidate");
    const second = at("second", "/api/second", "Second");
    assert.equal((await uploaded(fresh.env, upload({ operation: second }))).status, "candidate");
  });
});

describe("takeover of a live op", () => {
  test("the incumbent is served ahead of any newer live version until it degrades", async () => {
    const { env } = registry();
    const live = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const served = async () => (await send(env, "GET", "/v1/sites/example-com")).body.operations[0];
    const ok = (hash: string, asn: number, ip: string) =>
      send(env, "POST", "/v1/reports", { as: install(), ip, asn, body: { reports: [{ hash, outcome: "ok" }] } });

    // three keys on two ASNs: a heal claim with its own failure, then two oks
    const evil = install();
    await send(env, "POST", "/v1/reports", {
      as: evil,
      ip: "203.0.113.1",
      body: { reports: [{ hash: live.hash, outcome: "fail" }] },
    });
    const attack = op({ description: "ATTACKER", response: { format: "json", pick: ["title"] } });
    const up = await send(env, "POST", "/v1/versions", {
      as: evil,
      ip: "203.0.113.1",
      body: upload({ operation: attack, parent: live.hash, evidence: { ...evidence, healedFrom: live.hash } }),
    });
    await ok(up.body.hash, 64500, "198.51.100.1");
    await ok(up.body.hash, 64501, "192.0.2.1");
    const now = await served();
    assert.equal(now.hash, live.hash, "the incumbent, though the newcomer has the better rate");
    assert.equal(now.operation.description, op().description);

    // a plain upload promoted the same way changes nothing either
    const plain = await send(env, "POST", "/v1/versions", {
      as: install(),
      ip: "203.0.113.2",
      body: upload({ operation: op({ description: "ATTACKER 2" }) }),
    });
    await ok(plain.body.hash, 64502, "198.51.100.2");
    await ok(plain.body.hash, 64503, "192.0.2.2");
    assert.equal((await served()).hash, live.hash);

    // failures from three networks degrade the incumbent: then the oldest newer live version is served
    for (const ip of ["100.64.1.1", "100.64.2.1", "100.64.3.1"]) await report(env, install(), live.hash, "fail", ip);
    assert.equal((await served()).hash, up.body.hash);
  });

  test("a version of an established op with another match is review, even once the incumbent degrades", async () => {
    const { env, raw } = registry();
    const li = { name: "linkedin", domain: "example.com", baseUrl: "https://www.example.com" };
    const at = (path: string, description = "Search people") =>
      op({
        name: "search",
        description,
        request: { method: "GET", url: `https://www.example.com${path}?q=dune`, headers: {} },
        match: { host: "www.example.com", path },
      });
    const live = (await seed(env, { site: li, operations: [at("/api/search")] })).body.operations[0];
    const close = await uploaded(env, upload({ site: li, operation: at("/psettings/close-account", "ATTACKER") }));
    assert.equal(close.status, "review");
    assert.ok(
      close.reasons?.some((x) => /match .*close-account.* differs from the live version's .*\/api\/search/.test(x)),
      JSON.stringify(close),
    );
    // a heal keeps its match: a candidate as before
    const heal = at("/api/search", "Search people, repaired");
    assert.equal((await uploaded(env, upload({ site: li, operation: heal }))).status, "candidate");
    // degrading the incumbent first moves nothing
    raw.prepare("UPDATE versions SET status = 'degraded' WHERE hash = ?").run(live.hash);
    const again = await uploaded(env, upload({ site: li, operation: at("/psettings/close-account", "ATTACKER 2") }));
    assert.equal(again.status, "review");
  });

  test("a site the crowd made live stays established while its only live op is degraded", async () => {
    const { env, raw } = registry();
    const first = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body;
    await report(env, install(), first.hash, "ok", "198.51.100.1");
    await report(env, install(), first.hash, "ok", "192.0.2.1");
    const served = async () => (await send(env, "GET", "/v1/sites/example-com")).body.operations;
    assert.equal((await served())[0].status, "live");
    raw.prepare("UPDATE versions SET status = 'degraded' WHERE hash = ?").run(first.hash);

    const moved = op({
      description: "ATTACKER",
      request: { method: "GET", url: "https://www.example.com/psettings/close-account?q=dune", headers: {} },
      match: { host: "www.example.com", path: "/psettings/close-account" },
    });
    const close = await uploaded(env, upload({ operation: moved }));
    assert.equal(close.status, "review", JSON.stringify(close));
    const extra = op({ name: "follow", match: { host: "www.example.com", path: "/api/follow" } });
    assert.equal((await uploaded(env, upload({ operation: extra }))).status, "review");
    assert.deepEqual(
      (await served()).map((o: { hash: string }) => o.hash),
      [first.hash],
      "the degraded incumbent is still what callers get",
    );
    // a heal that keeps the match and the request is a candidate, as on any established site
    assert.equal((await uploaded(env, upload({ operation: op({ description: "repaired" }) }))).status, "candidate");
  });
});

describe("a site that had a live op", () => {
  test("stays established once the daily job archives its degraded op", async () => {
    const { env, raw } = registry();
    const first = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body;
    await report(env, install(), first.hash, "ok", "198.51.100.1");
    await report(env, install(), first.hash, "ok", "192.0.2.1");
    const status = () =>
      (raw.prepare("SELECT status FROM versions WHERE hash = ?").get(first.hash) as { status: string }).status;
    assert.equal(status(), "live");
    // it stops working: failures from three networks, and no ok for 40 days
    for (const ip of ["100.64.1.1", "100.64.2.1", "100.64.3.1"]) await report(env, install(), first.hash, "fail", ip);
    assert.equal(status(), "degraded");
    raw
      .prepare("UPDATE versions SET last_ok_at = ? WHERE hash = ?")
      .run(new Date(Date.now() - 40 * 86_400_000).toISOString(), first.hash);
    await worker.scheduled({ scheduledTime: Date.now() }, env);
    assert.equal(status(), "archived");

    const moved = op({
      description: "ATTACKER",
      request: { method: "GET", url: "https://www.example.com/psettings/close-account?q=dune", headers: {} },
      match: { host: "www.example.com", path: "/psettings/close-account" },
    });
    const close = await uploaded(env, upload({ operation: moved }));
    assert.equal(close.status, "review", JSON.stringify(close));
    const extra = op({ name: "follow", match: { host: "www.example.com", path: "/api/follow" } });
    assert.equal((await uploaded(env, upload({ operation: extra }))).status, "review");
    // a second name for its domain gets around nothing
    const alias = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ site: { ...site, name: "example-books" }, operation: moved }),
    });
    if (alias.status === 201) assert.equal(alias.body.status, "review", alias.text);
    else assert.equal(alias.status, 422, alias.text);
  });

  test("a site whose versions were only ever candidates is not established", async () => {
    const { env } = registry();
    await uploaded(env, upload());
    const extra = op({ name: "bookPage", match: { host: "www.example.com", path: "/api/book" } });
    assert.equal((await uploaded(env, upload({ operation: extra }))).status, "candidate");
  });
});

describe("a version that keeps the incumbent's match and sends elsewhere", () => {
  const li = { name: "linkedin", domain: "example.com", baseUrl: "https://www.example.com" };
  const search = (over: Record<string, unknown> = {}) =>
    op({
      name: "search",
      description: "Search people",
      request: { method: "GET", url: "https://www.example.com/api/search?q=dune", headers: {} },
      match: { host: "www.example.com", path: "/api/search" },
      ...over,
    });
  const moved = /its request .*differs from the live version's .*under the same match/;
  const judged = async (incumbent: unknown, next: unknown) => {
    const { env } = registry();
    assert.equal((await seed(env, { site: li, operations: [incumbent] })).status, 200);
    return uploaded(env, upload({ site: li, operation: next }));
  };
  const review = async (what: string, incumbent: unknown, next: unknown) => {
    const r = await judged(incumbent, next);
    assert.equal(r.status, "review", `${what}: ${JSON.stringify(r)}`);
    assert.ok(
      r.reasons?.some((x) => moved.test(x)),
      `${what}: ${JSON.stringify(r)}`,
    );
  };
  const elsewhere = { method: "GET", url: "https://www.example.com/psettings/close-account?q=dune", headers: {} };

  test("a request moved under the same match is review", async () => {
    await review("another path", search(), search({ description: "ATTACKER", request: elsewhere }));
    // the template stays put; the params' defaults move it on every call that leaves them out
    await review(
      "path slots with defaults",
      search(),
      search({
        slots: [
          { param: "q", at: ["query:q"] },
          { param: "a", at: ["path:0"] },
          { param: "b", at: ["path:1"] },
        ],
        params: [
          { name: "q", type: "string", required: true, example: "dune" },
          { name: "a", type: "string", required: false, default: "psettings" },
          { name: "b", type: "string", required: false, default: "close-account" },
        ],
      }),
    );
    // fetch resolves the dot segments, and the slots fill what is left of them
    await review(
      "dot segments",
      search(),
      search({
        request: { method: "GET", url: "https://www.example.com/x/../api/search?q=dune", headers: {} },
        slots: [
          { param: "q", at: ["query:q"] },
          { param: "a", at: ["path:2"] },
          { param: "b", at: ["path:3"] },
        ],
        params: [
          { name: "q", type: "string", required: true, example: "dune" },
          { name: "a", type: "string", required: false, default: "psettings" },
          { name: "b", type: "string", required: false, default: "close-account" },
        ],
      }),
    );
  });

  test("a trigger moved under the same request is review; a heal keeps its trigger", async () => {
    const elsewhere = /its trigger differs from the live version's/;
    const steps = [
      { action: "fill", selector: "#q", value: "{q}" },
      { action: "press", value: "Enter" },
    ];
    const cases: [string, unknown, unknown][] = [
      [
        "another page, opened at tier 3",
        op(),
        op({
          minTier: 3,
          trigger: { url: "https://www.example.com/psettings/close-account?confirm=1&q={q}" },
        }),
      ],
      [
        "added steps",
        op(),
        op({
          minTier: 3,
          trigger: {
            url: op().trigger.url,
            steps: [{ action: "goto", value: "https://www.example.com/psettings/close-account" }, ...steps],
          },
        }),
      ],
      [
        "a page loaded first",
        op(),
        op({ trigger: { ...op().trigger, softFrom: "https://www.example.com/psettings" } }),
      ],
      [
        "another step among the same ones",
        op({ trigger: { url: op().trigger.url, steps } }),
        op({ trigger: { url: op().trigger.url, steps: [steps[0], { action: "press", value: "Delete" }] } }),
      ],
    ];
    for (const [what, incumbent, next] of cases) {
      const { env } = registry();
      assert.equal((await seed(env, { site, operations: [incumbent] })).status, 200);
      const r = await send(env, "POST", "/v1/versions", { as: install(), body: upload({ operation: next }) });
      if (r.status === 201) {
        assert.equal(r.body.status, "review", `${what}: ${r.text}`);
        assert.ok(
          r.body.reasons.some((x: string) => elsewhere.test(x)),
          `${what}: ${r.text}`,
        );
      } else assert.equal(r.status, 422, `${what}: ${r.text}`);
    }

    // a heal as heal.ts builds one: the request and its slots repaired, the op's own trigger kept
    const healed = (trigger: unknown) =>
      op({
        request: { method: "GET", url: "https://www.example.com/api/search?query=dune", headers: {} },
        slots: [{ param: "q", at: ["query:query"] }],
        minTier: 2,
        trigger,
      });
    const plain = registry().env;
    await seed(plain, { site, operations: [op()] });
    const heal = await uploaded(plain, upload({ operation: healed(op().trigger) }));
    assert.equal(heal.status, "candidate", JSON.stringify(heal));
    // the same trigger, whatever order its keys are written in
    const stepped = registry().env;
    await seed(stepped, { site, operations: [op({ trigger: { url: op().trigger.url, steps } })] });
    const reordered = {
      steps: steps.map((s) => Object.fromEntries(Object.entries(s).reverse())),
      url: op().trigger.url,
    };
    const same = await uploaded(stepped, upload({ operation: healed(reordered) }));
    assert.equal(same.status, "candidate", JSON.stringify(same));
  });

  test("a match that names no path or no host hides nothing", async () => {
    const anyPath = { match: { host: "www.example.com" } };
    await review("no path", search(anyPath), search({ ...anyPath, request: elsewhere }));
    const anyHost = { match: { path: "/api/search" } };
    await review(
      "no host",
      search(anyHost),
      search({
        ...anyHost,
        request: { method: "GET", url: "https://files.example.com/api/search?q=dune", headers: {} },
      }),
    );
    for (const loose of [anyPath, anyHost]) {
      const heal = await judged(search(loose), search({ ...loose, description: "Search people, repaired" }));
      assert.equal(heal.status, "candidate", JSON.stringify(heal));
    }
  });

  test("a GraphQL body that names another operation under the same match is review", async () => {
    const gql = (body: string, over: Record<string, unknown> = {}) =>
      search({
        request: {
          method: "POST",
          url: "https://www.example.com/graphql",
          headers: { "content-type": "application/json" },
          body,
        },
        slots: [{ param: "q", at: ["body", "json:/variables/q"] }],
        trigger: { url: "https://www.example.com/search?q={q}" },
        match: { host: "www.example.com", path: "/graphql", operationName: "Search" },
        ...over,
      });
    const live = gql(
      '{"operationName":"Search","query":"query Search($q: String) { search(q: $q) { title } }","variables":{"q":"dune"}}',
    );
    await review(
      "another name",
      live,
      gql(
        '{"operationName":"Viewer","query":"query Viewer($q: String) { viewer { email addresses(q: $q) { line1 } } }","variables":{"q":"dune"}}',
      ),
    );
    // the stored name stays; a param's default picks the document's other operation
    await review(
      "a name a slot fills",
      live,
      gql(
        '{"operationName":"Search","query":"query Search($q: String) { search(q: $q) { title } } query Viewer { viewer { email } }","variables":{"q":"dune"}}',
        {
          slots: [
            { param: "q", at: ["body", "json:/variables/q"] },
            { param: "which", at: ["body", "json:/operationName"] },
          ],
          params: [
            { name: "q", type: "string", required: true, example: "dune" },
            { name: "which", type: "string", required: false, default: "Viewer" },
          ],
        },
      ),
    );
    const heal = await judged(
      live,
      gql(
        '{"operationName":"Search","query":"query Search($q: String) { search(q: $q) { title author } }","variables":{"q":"dune"}}',
      ),
    );
    assert.equal(heal.status, "candidate", JSON.stringify(heal));
  });

  test("a heal that sends the same request is a candidate, across a segment its match wildcards too", async () => {
    const same = await judged(search(), search({ description: "Search people, repaired" }));
    assert.equal(same.status, "candidate", JSON.stringify(same));
    const hashed = (hash: string, path = `/api/${hash}/search`) =>
      search({
        request: { method: "GET", url: `https://www.example.com${path}?q=dune`, headers: {} },
        match: { host: "www.example.com", path: "/api/*/search" },
      });
    const rotated = await judged(hashed("Zx81kQp0aLm3TyU7"), hashed("Bq7mN2x0Rk5WvE9a"));
    assert.equal(rotated.status, "candidate", JSON.stringify(rotated));
    await review(
      "the wildcard covers one segment only",
      hashed("Zx81kQp0aLm3TyU7"),
      hashed("", "/psettings/x/close-account"),
    );
    // a segment a param fills is the caller's on both sides
    const byId = (description: string) =>
      search({
        description,
        request: { method: "GET", url: "https://www.example.com/people/dune", headers: {} },
        slots: [{ param: "q", at: ["path:1"] }],
        match: { host: "www.example.com", path: "/people/*" },
      });
    assert.equal((await judged(byId("A person"), byId("A person, repaired"))).status, "candidate");
  });

  test("an incumbent stored before the rule is read from its operation, not its stored signature", async () => {
    const { env, raw } = registry();
    await seed(env, { site: li, operations: [search()] });
    assert.equal(raw.prepare("SELECT sig FROM versions").get()?.sig, '["GET","www.example.com","/api/search",""]');
    const r = await uploaded(
      env,
      upload({ site: li, operation: search({ description: "ATTACKER", request: elsewhere }) }),
    );
    assert.ok(
      r.reasons?.some((x) => moved.test(x)),
      JSON.stringify(r),
    );
  });

  test("the request's signature reads the URL as fetch does", () => {
    const sig = (url: string, slots: { param: string; at: string[] }[] = [], path = "/api/search") =>
      requestSig(
        OperationSchema.parse(search({ request: { method: "GET", url, headers: {} }, slots, match: { path } })),
      );
    const plain = sig("https://www.example.com/api/search?q=dune");
    assert.equal(plain, '["GET","https://www.example.com","/api/search",""]');
    assert.equal(sig("https://www.example.com/api/search?q=other#x"), plain, "the query is no part of it");
    for (const url of [
      "https://www.example.com/x/../api/search",
      "https://www.example.com/api/./search",
      "https://www.example.com/api/%2e%2e/api/search",
      "https://www.example.com\\@www.example.com/api/search",
      "https://www.example.com:8443/api/search",
      "https://files.example.com/api/search",
      "http://www.example.com/api/search",
      "https://www.example.com/api/search/",
    ])
      assert.notEqual(sig(url), plain, url);
    // a slot past the path's end, or one on a segment the URL parser folds away, never reads as the plain path
    assert.notEqual(sig("https://www.example.com/api/search", [{ param: "q", at: ["path:5"] }]), plain);
    assert.notEqual(sig("https://www.example.com/api/search", [{ param: "q", at: ["path:1"] }]), plain);
    assert.equal(
      sig("https://www.example.com/api/search", [{ param: "q", at: ["path:1"] }]),
      sig("https://www.example.com/api/find", [{ param: "q", at: ["path:1"] }]),
    );
    // a literal * is no wildcard
    assert.notEqual(
      sig("https://www.example.com/api/*", [], "/api/*x"),
      sig("https://www.example.com/api/search", [{ param: "q", at: ["path:1"] }], "/api/*x"),
    );
  });
});

describe("degrading a busy op", () => {
  test("failing networks must outnumber the networks it worked on this week", async () => {
    const { env } = registry();
    const live = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const status = async () => (await send(env, "GET", "/v1/sites/example-com")).body.operations[0].status;
    for (let i = 1; i <= 3; i++) await report(env, install(), live.hash, "ok", `198.18.${i}.1`);
    // five failing installs of eight, on three networks: every other rule holds, but no more networks failed than worked
    for (const n of [1, 1, 2, 2, 3]) await report(env, install(), live.hash, "fail", `100.64.${n}.1`);
    assert.equal(await status(), "live", "3 failing networks against 3 that worked");
    await report(env, install(), live.hash, "fail", "100.64.4.1");
    assert.equal(await status(), "degraded", "4 against 3");
  });
});

describe("search poisoning", () => {
  test("a site with no live op is found only by its domain", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    // anyone can upload a site that says it is the books site
    const poison = await uploaded(env, upload(net("example-net", { description: "Book ratings, the real ones" })));
    assert.equal(poison.status, "candidate");
    const matches = async (q: string) => (await send(env, "GET", `/v1/search?q=${encodeURIComponent(q)}`)).body.matches;
    const names = async (q: string) => (await matches(q)).map((m: { name: string }) => m.name);
    assert.deepEqual(await names("book ratings"), ["example-com"]);
    assert.deepEqual(await names("example net"), ["example-com"]);
    assert.deepEqual(await names("example.net"), ["example-net"]);
    assert.deepEqual(await names("https://www.example.net/search?q=x"), ["example-net"]);
    // every match says which domain it calls
    assert.equal((await matches("example.net"))[0].domain, "example.net");
    assert.equal((await matches("book ratings"))[0].domain, "example.com");

    const index = (await send(env, "GET", "/v1/index")).body.sites.map((s: { site: string }) => s.site);
    assert.deepEqual(index, ["example-com"]);
    const home = (await send(env, "GET", "/")).text;
    assert.match(home, /href="\/sites\/example-com"/);
    assert.doesNotMatch(home, /href="\/sites\/example-net"/);
    assert.doesNotMatch((await send(env, "GET", "/?q=book%20ratings")).text, /href="\/sites\/example-net"/);
    assert.doesNotMatch((await send(env, "GET", "/sitemap.xml")).text, /sites\/example-net</);
    // its own page renders, kept out of search engines
    const page = await send(env, "GET", "/sites/example-net");
    assert.equal(page.status, 200);
    assert.match(page.text, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch((await send(env, "GET", "/sites/example-com")).text, /noindex/);
  });

  test("a site with a live op ranks above one with only candidates, whatever the score", () => {
    const served = (name: string, status: "live" | "candidate") => ({
      name,
      domain: "example.net",
      baseUrl: "https://www.example.net",
      operations: [
        {
          hash: "a".repeat(64),
          status,
          confirmations: 0,
          operation: OperationSchema.parse(net(name).operation),
        },
      ],
    });
    const found = search([served("example-net", "candidate"), served("weather", "live")], "example.net", 5);
    assert.deepEqual(
      found.map((m) => m.name),
      ["weather", "example-net"],
    );
  });
});

describe("abuse limits", () => {
  const mk = (i: number) =>
    upload({ operation: op({ name: `op${i}`, match: { host: "www.example.com", path: `/api/${i}` } }) });
  const post = (env: Env, as: ReturnType<typeof install>, ip: string, i: number) =>
    send(env, "POST", "/v1/versions", { as, ip, body: mk(i) });

  test("a key new this hour uploads at most 5 versions", async () => {
    const { env, raw } = registry();
    const k = install();
    for (let i = 0; i < 5; i++) assert.equal((await post(env, k, `100.64.${i}.1`, i)).status, 201);
    const over = await post(env, k, "100.64.9.1", 9);
    assert.equal(over.status, 429);
    assert.match(over.body.error, /new this hour/);
    const wait = Number(over.headers.get("retry-after"));
    assert.ok(wait > 3500 && wait <= 3600, String(wait));
    const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
    raw.prepare("UPDATE keys SET first_seen = ? WHERE key = ?").run(earlier, k.key);
    assert.equal((await post(env, k, "100.64.9.1", 10)).status, 201);
  });

  test("a circuit breaker caps uploads across all keys, with Retry-After", async () => {
    const { env } = registry({ UPLOADS_PER_HOUR_ALL: "3" });
    for (let i = 0; i < 3; i++) assert.equal((await post(env, install(), `100.64.${i}.1`, i)).status, 201);
    const over = await post(env, install(), "100.64.9.1", 9);
    assert.equal(over.status, 429);
    assert.match(over.body.error, /at most 3 uploads an hour/);
    assert.ok(Number(over.headers.get("retry-after")) > 0);
  });

  test("rate limits count an IPv6 /32 as one network", async () => {
    const { env } = registry({ UPLOADS_PER_HOUR: "2" });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await post(env, install(), `2001:db8:${i + 1}::1`, i)).status);
    assert.deepEqual(codes, [201, 201, 429]);
  });

  test("a site stays pullable whatever other installs add to it", async () => {
    const roomy = { NEW_KEY_UPLOADS: "1000", UPLOADS_PER_HOUR: "1000", UPLOADS_PER_HOUR_ALL: "1000" };
    /** What src/registry.ts pull() holds a served site to; answers the names it serves. */
    const pulled = async (env: Env, name = "example-com") => {
      const served = (await send(env, "GET", `/v1/sites/${name}`)).body;
      const spec = parseSite({
        name,
        baseUrl: served.baseUrl,
        ...(served.displayName ? { displayName: served.displayName } : {}),
        operations: served.operations.map((o: { operation: object; hash: string; status: string }) => ({
          ...o.operation,
          version: { hash: o.hash, status: o.status },
        })),
      });
      assert.deepEqual(vetShared(spec).errors, []);
      const size = Buffer.byteLength(JSON.stringify(spec, null, 2));
      assert.ok(size <= LIMITS.file, `${size} bytes`);
      return spec.operations.map((o) => o.name);
    };
    const first = async () => {
      const r = registry(roomy);
      const { hash } = await uploaded(r.env, upload());
      // uploads within one millisecond are ordered by hash: the first install's is plainly the oldest
      r.raw.prepare("UPDATE versions SET created_at = '2026-01-01T00:00:00.000Z' WHERE hash = ?").run(hash);
      return r.env;
    };
    const wide = (name: string, params: number) =>
      op({
        name,
        match: { host: "www.example.com", path: `/api/${name}` },
        params: [
          ...op().params,
          ...Array.from({ length: params }, (_, p) => ({
            name: `p${p}`,
            required: false,
            enum: Array.from({ length: 100 }, (_, v) => `${v}`.padStart(50, "x")),
          })),
        ],
      });

    // by count: one name more than a shared spec may hold
    const many = await first();
    for (let i = 0; i < 50; i++) assert.equal((await post(many, install(), `100.64.${i}.1`, i)).status, 201);
    const names = await pulled(many);
    assert.equal(names.length, 50);
    assert.ok(names.includes("searchBooks"), "the op that was served first stays");

    // by size: each upload is within the body cap, two of them are over the spec's
    const big = await first();
    for (const name of ["big0", "big1"]) {
      assert.equal((await uploaded(big, upload({ operation: wide(name, 25) }))).status, "candidate");
      assert.ok((await pulled(big)).includes("searchBooks"));
    }
    assert.equal((await pulled(big)).length, 2);

    // one op that alone is over it once written out is not served, and a site with nothing else has no answer
    const huge = await first();
    assert.equal((await uploaded(huge, upload({ operation: wide("huge", 45) }))).status, "candidate");
    assert.deepEqual(await pulled(huge), ["searchBooks"]);
    const alone = { name: "example-net", domain: "example.net", baseUrl: "https://www.example.net" };
    const theirs = {
      ...wide("huge", 45),
      ...net("example-net").operation,
      name: "huge",
      params: wide("huge", 45).params,
    };
    assert.equal((await uploaded(huge, upload({ site: alone, operation: theirs }))).status, "candidate");
    assert.equal((await send(huge, "GET", "/v1/sites/example-net")).status, 404);
    assert.deepEqual((await send(huge, "GET", "/v1/search?q=example.net")).body.matches, []);
  });
});

describe("edge cache", () => {
  test("public reads are cached 60 s by URL; signed ones and errors never", async () => {
    const store = new Map<string, Response>();
    const g = globalThis as { caches?: unknown };
    const before = g.caches;
    g.caches = {
      default: {
        match: async (r: Request) => store.get(r.url)?.clone(),
        put: async (r: Request, res: Response) => {
          store.set(r.url, res);
        },
      },
    };
    try {
      const { env } = registry();
      const { hash } = (await seed(env, { site, operations: [op()] })).body.operations[0];
      const first = await send(env, "GET", "/v1/search?q=book%20ratings");
      assert.equal(first.body.matches.length, 1);
      assert.equal(first.headers.get("cache-control"), "public, max-age=60");
      for (const path of ["/v1/sites/example-com", "/v1/index", "/", "/sitemap.xml"])
        assert.equal((await send(env, "GET", path)).status, 200);
      assert.deepEqual([...store.keys()].map((u) => new URL(u).pathname).sort(), [
        "/",
        "/sitemap.xml",
        "/v1/index",
        "/v1/search",
        "/v1/sites/example-com",
      ]);

      await send(env, "POST", `/v1/admin/versions/${hash}`, {
        body: { status: "blocked" },
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      const again = await send(env, "GET", "/v1/search?q=book%20ratings");
      assert.equal(again.body.matches.length, 1, "from the cache");
      const other = await send(env, "GET", "/v1/search?q=book%20ratings&limit=3");
      assert.equal(other.body.matches.length, 0, "another URL");
      const signedRead = await send(env, "GET", "/v1/search?q=book%20ratings", { as: install() });
      assert.equal(signedRead.body.matches.length, 0, "a signed read skips the cache");
      assert.equal((await send(env, "GET", "/v1/search")).status, 400);
      assert.equal(store.has("https://registry.test/v1/search"), false, "an error is not cached");
    } finally {
      g.caches = before;
    }
  });
});
