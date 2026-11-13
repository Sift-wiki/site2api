/**
 * What a browser run lets out besides the op's own request: a write's tier-3 run stops any unsafe
 * request its learning did not record (a redesign that put "Delete account" where Buy was), and a
 * read's learning stops the unsafe requests its steps send (a click that places an order).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { browserAvailable, closeBrowser, TRIGGER_BUDGET_MS } from "../src/browser.js";
import { setAt } from "../src/codec.js";
import { call } from "../src/execute.js";
import { addOperation, capturePage, cutShort, readGuard, stoppedIn } from "../src/heal.js";
import { buildRequest } from "../src/http.js";
import { type Match, type Operation, parseSite, type Site } from "../src/spec.js";
import { saveSite, staleMark, updateSite } from "../src/store.js";
import type { CaptureResult } from "../src/types.js";
import { vetShared } from "../src/vet.js";
import { type Fixture, startFixture } from "./fixture/server.js";

const HOME = mkdtempSync(join(tmpdir(), "api-anything-guards-"));
process.env.API_ANYTHING_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

describe("the shared rules on a write's companions", () => {
  const site = (companions: unknown, readOnly = false): Site =>
    parseSite({
      name: "shop",
      baseUrl: "https://shop.example.com",
      operations: [
        {
          name: "order",
          readOnly,
          request: { method: "POST", url: "https://api.shop.example.com/order", headers: {}, body: "{}" },
          slots: [],
          volatile: [],
          trigger: {
            url: "https://shop.example.com/item/1",
            steps: [{ action: "click", selector: "#buy" }],
            companions,
          },
          match: { method: "POST", host: "api.shop.example.com", path: "/order" },
        },
      ],
    });
  const errors = (s: Site) => vetShared(s).errors.filter((e) => /compan/.test(e));

  test("a write's few unsafe companions on its own site pass", () => {
    assert.deepEqual(errors(site([{ method: "PUT", host: "www.shop.example.com", path: "/cart/*" }])), []);
    assert.deepEqual(errors(site([])), []);
  });

  test("a read's, too many, another site's, a safe or unnamed one do not", () => {
    const cart = { method: "PUT", host: "shop.example.com", path: "/cart" };
    assert.match(errors(site([cart], true)).join("\n"), /a read sends no companion requests/);
    assert.match(errors(site(Array(9).fill(cart))).join("\n"), /9 companion requests; at most 8/);
    assert.match(
      errors(site([{ method: "DELETE", host: "evil.example", path: "/account" }])).join("\n"),
      /companion 1 \(DELETE evil\.example\/account\) is off the op's own site example\.com/,
    );
    for (const bad of [
      { method: "GET", host: "shop.example.com", path: "/cart" },
      { host: "shop.example.com", path: "/cart" },
      { method: "POST", path: "/cart" },
      { method: "POST", host: "shop.example.com" },
    ])
      assert.match(errors(site([bad])).join("\n"), /names no unsafe method, host and path/, JSON.stringify(bad));
  });
});

describe("a read's tier-3 guard", () => {
  const read = (match: Match, method = "GET", url = "https://www.example.com/api/account") => ({
    match,
    request: { method, url, headers: {} },
    slots: [],
    volatile: [],
  });
  const sent = (method: string, url: string, body?: string, headers: Record<string, string> = {}) => ({
    id: 0,
    resourceType: "xhr",
    request: { method, url, headers, ...(body ? { body } : {}) },
  });

  test("a GET read exempts no unsafe request, whatever its match covers", () => {
    const account = "https://www.example.com/api/account";
    for (const shared of [true, false])
      for (const match of [
        { host: "www.example.com" },
        { host: "www.example.com", path: "/api/account" },
        { path: "/api/account" },
      ]) {
        const guard = readGuard(read(match), shared);
        const why = `${JSON.stringify(match)} shared=${shared}`;
        assert.equal(guard(sent("DELETE", account), true), true, why);
        assert.equal(guard(sent("POST", "https://www.example.com/account/close"), true), true, why);
        assert.equal(guard(sent("GET", account), true), false, why);
        assert.equal(guard(sent("DELETE", account), false), false, "nothing is stopped while the page loads");
      }
  });

  test("a POST read exempts its own method only", () => {
    const guard = readGuard(read({ path: "/api/account" }, "POST"));
    assert.equal(guard(sent("POST", "https://www.example.com/api/account"), true), false);
    assert.equal(guard(sent("DELETE", "https://www.example.com/api/account"), true), true);
    assert.equal(guard(sent("PUT", "https://www.example.com/api/account"), true), true);
  });

  test("a POST read's own request and its redirect hops leave; someone else's keeps to its host and sends no mutation", () => {
    const mine = readGuard(read({ method: "POST", path: "/read" }, "POST", "http://127.0.0.1:4010/read"));
    const own = sent("POST", "http://127.0.0.1:4010/read", "initial");
    assert.equal(mine(own, true), false);
    assert.equal(
      mine(sent("POST", "http://localhost:4011/answer", "initial"), true, own),
      false,
      "a 307 hop of it, on any origin",
    );
    assert.equal(mine(sent("POST", "http://127.0.0.1:4010/api/track", "x"), true), true);

    const gql = (doc: string, url = "https://api.example.com/graphql") =>
      sent("POST", url, JSON.stringify({ query: doc }));
    const q = read({ operationName: "Q" }, "POST", "https://api.example.com/graphql");
    const theirs = readGuard({ ...q, request: gql("query Q { me { id } }").request }, true);
    assert.equal(theirs(gql("query Q { me { name } }"), true), false);
    assert.equal(theirs(gql("mutation Q { deleteAccount }"), true), true);
    assert.equal(theirs(gql("query Q { me { name } }", "https://other.example.com/graphql"), true), true, "its host");
    assert.equal(theirs(sent("DELETE", "https://api.example.com/graphql"), true), true);
    assert.equal(
      theirs(sent("POST", "https://collector.example.org/x"), false, gql("query Q { me { name } }")),
      true,
      "a hop off its site, before the steps too",
    );
    // the user's own spec with the same loose match: the match is their own text
    const loose = readGuard(read({ operationName: "Q" }, "POST", "https://api.example.com/graphql"));
    assert.equal(loose(gql("query Q { me { name } }", "https://other.example.com/graphql"), true), false);
  });

  const JSON_TYPE = { "content-type": "application/json" };
  const FORM_TYPE = { "content-type": "application/x-www-form-urlencoded" };
  const post = (url: string, body: string, slots: Operation["slots"] = [], volatile: Operation["volatile"] = []) => ({
    match: { host: new URL(url).hostname },
    request: { method: "POST", url, headers: JSON_TYPE, body },
    slots,
    volatile,
  });

  test("someone else's POST read with a host-only match lets out the request at its own address only", () => {
    const search = "https://www.example.com/api/search";
    const op = post(search, '{"q":"x"}', [{ param: "q", at: ["body", "json:/q"] }]);
    const theirs = readGuard(op, true);
    assert.equal(theirs(sent("POST", search, '{"q":"lamp"}', JSON_TYPE), true), false, "its own request");
    assert.equal(
      theirs(sent("POST", search, '{"q":"lamp"}', { "content-type": "application/json; charset=utf-8" }), true),
      false,
      "its own request, the charset named",
    );
    const mutation = '{"query":"mutation { deleteAccount }"}';
    const stopped: [string, ReturnType<typeof sent>][] = [
      ["a REST write on its host", sent("POST", "https://www.example.com/api/account/delete", "{}", JSON_TYPE)],
      [
        "a form the click submits",
        { ...sent("POST", "https://www.example.com/account/close", "confirm=1", FORM_TYPE), resourceType: "document" },
      ],
      [
        "a persisted mutation",
        sent(
          "POST",
          "https://www.example.com/graphql",
          '{"operationName":"DeleteAccount","extensions":{"persistedQuery":{"version":1,"sha256Hash":"abc"}}}',
          JSON_TYPE,
        ),
      ],
      [
        "a multipart mutation",
        sent(
          "POST",
          "https://www.example.com/graphql",
          `--b\r\nContent-Disposition: form-data; name="operations"\r\n\r\n${mutation}\r\n--b--`,
          { "content-type": "multipart/form-data; boundary=b" },
        ),
      ],
      ["a method override elsewhere", sent("POST", "https://www.example.com/account", "_method=DELETE", FORM_TYPE)],
      ["a method override in a field, at its own address", sent("POST", search, "_method=DELETE", FORM_TYPE)],
      [
        "a method override in a header, at its own address",
        sent("POST", search, '{"q":"x"}', { ...JSON_TYPE, "x-http-method-override": "DELETE" }),
      ],
      ["a form submitted to its own address", sent("POST", search, "q=x&confirm=1", FORM_TYPE)],
      [
        "a multipart mutation at its own address",
        sent("POST", search, `--b\r\nContent-Disposition: form-data; name="operations"\r\n\r\n${mutation}\r\n--b--`, {
          "content-type": "multipart/form-data; boundary=b",
        }),
      ],
      ["another port", sent("POST", "https://www.example.com:8443/api/search", '{"q":"x"}', JSON_TYPE)],
      ["plain http", sent("POST", "http://www.example.com/api/search", '{"q":"x"}', JSON_TYPE)],
      ["a longer path", sent("POST", `${search}/delete`, '{"q":"x"}', JSON_TYPE)],
    ];
    for (const [what, e] of stopped) assert.equal(theirs(e, true), true, what);
    // the user's own spec: its match is their own text, and covers what it says
    const mine = readGuard(op);
    assert.equal(mine(stopped[0]![1], true), false);
  });

  test("someone else's POST read: a path segment a slot or a rotating token fills is any segment", () => {
    const op = post(
      "https://www.example.com/api/v3/Search/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/shoes",
      '{"page":1}',
      [{ param: "q", at: ["path:4"] }],
      [{ at: ["path:3"], shape: { charset: "hex", length: 64 }, anchor: "Search" }],
    );
    const theirs = readGuard(op, true);
    const at = (path: string) => sent("POST", `https://www.example.com${path}`, '{"page":2}', JSON_TYPE);
    assert.equal(theirs(at(`/api/v3/Search/${"b".repeat(64)}/red%20boots`), true), false);
    assert.equal(theirs(at(`/api/v3/Delete/${"b".repeat(64)}/shoes`), true), true);
    assert.equal(theirs(at(`/api/v3/Search/${"b".repeat(64)}`), true), true);
  });

  test("someone else's GraphQL read: the same operation name or document passes, another operation does not", () => {
    const url = "https://api.example.com/graphql";
    const doc = "query Search($q: String!) { search(q: $q) { name } }";
    const body = (o: Record<string, unknown>) => JSON.stringify(o);
    const op = post(url, body({ operationName: "Search", variables: { q: "x" }, query: doc }), [
      { param: "q", at: ["body", "json:/variables/q"] },
    ]);
    const theirs = readGuard(op, true);
    const e = (o: unknown) => sent("POST", url, JSON.stringify(o), JSON_TYPE);
    assert.equal(theirs(e({ operationName: "Search", variables: { q: "lamp" }, query: doc }), true), false);
    assert.equal(theirs(e({ variables: { q: "lamp" }, query: doc }), true), false, "its stored document");
    assert.equal(
      theirs(e({ operationName: "Search", query: "query Search($q: String!) { search(q: $q) { name price } }" }), true),
      false,
      "its operation name, the document changed after a deploy",
    );
    const hash = { persistedQuery: { version: 1, sha256Hash: "c".repeat(64) } };
    for (const [what, o] of [
      ["another query", { operationName: "Me", query: "query Me { me { name } }" }],
      ["a mutation under its name", { operationName: "Search", query: "mutation Search { deleteAccount }" }],
      ["a persisted operation under its name", { operationName: "Search", variables: {}, extensions: hash }],
      ["a persisted operation", { operationName: "DeleteAccount", variables: {}, extensions: hash }],
      [
        "a batch with a persisted operation beside it",
        [
          { operationName: "Search", query: doc },
          { operationName: "DeleteAccount", extensions: hash },
        ],
      ],
    ] as [string, unknown][])
      assert.equal(theirs(e(o), true), true, what);
    assert.equal(
      theirs(
        sent(
          "POST",
          url,
          '--b\r\nContent-Disposition: form-data; name="operations"\r\n\r\n{"query":"mutation { deleteAccount }"}\r\n--b--',
          { "content-type": "multipart/form-data; boundary=b" },
        ),
        true,
      ),
      true,
      "a multipart mutation",
    );
  });

  test("someone else's persisted GraphQL read: a request with no document passes only as the op's own template", () => {
    const url = "https://api.example.com/graphql";
    const persisted = (name: string, hash: string, q = "x") =>
      JSON.stringify({
        operationName: name,
        variables: { q },
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
      });
    const [A, B] = ["a".repeat(64), "b".repeat(64)];
    const slots = [{ param: "q", at: ["body", "json:/variables/q"] }];
    const theirs = readGuard(post(url, persisted("Search", A), slots), true);
    const e = (body: string) => sent("POST", url, body, JSON_TYPE);
    assert.equal(theirs(e(persisted("Search", A, "lamp")), true), false, "its own, with other variables");
    assert.equal(theirs(e(persisted("Search", B)), true), true, "another document under its name");
    assert.equal(theirs(e(persisted("DeleteAccount", A)), true), true, "another name");
    assert.equal(theirs(e('{"operationName":"Search","variables":{"q":"x"}}'), true), true, "no hash at all");
    // a hash the op holds as a rotating token (learned as volatile) is the same operation after a deploy
    const rotating = readGuard(
      post(url, persisted("Search", A), slots, [
        {
          at: ["body", "json:/extensions/persistedQuery/sha256Hash"],
          shape: { charset: "hex", length: 64 },
          anchor: "Search",
        },
      ]),
      true,
    );
    assert.equal(rotating(e(persisted("Search", B, "lamp")), true), false);
    assert.equal(rotating(e(persisted("DeleteAccount", B)), true), true);
  });

  test("a search text that reads like a GraphQL document, where the op takes a param, is no document", () => {
    const url = "https://search.example.com/1/indexes/items/query";
    const op = post(url, '{"query":"sqlite","page":0}', [{ param: "query", at: ["body", "json:/query"] }]);
    const theirs = readGuard(op, true);
    for (const q of ["query planner", "{ braces", "mutation testing"])
      assert.equal(theirs(sent("POST", url, JSON.stringify({ query: q, page: 0 }), JSON_TYPE), true), false, q);
  });

  test("every bundled read sent as POST passes its own request, as the user's spec and as someone else's", () => {
    const dir = new URL("../sites/", import.meta.url);
    const reads: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const site = parseSite(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
      for (const op of site.operations) {
        if (!op.readOnly || /^(GET|HEAD)$/i.test(op.request.method)) continue;
        const name = `${site.name} ${op.name}`;
        reads.push(name);
        // its examples; a required param that has none gets a value of its kind
        const args = Object.fromEntries(
          op.params.flatMap((p) => {
            const v = p.example ?? (p.required ? (p.enum?.[0] ?? (p.type === "number" ? 12345 : "value")) : undefined);
            return v === undefined ? [] : [[p.name, v]];
          }),
        );
        // session values the page would send: any text
        const values = Object.fromEntries(
          op.slots.flatMap((s) => (s.ref?.startsWith("session:") ? [[s.ref.slice(8), "value"]] : [])),
        );
        let request = buildRequest(op, args, { cookies: [], values });
        // a rotating token is another value on the next deploy
        for (const v of op.volatile) request = setAt(request, v.at, "0".repeat(v.shape.length));
        const own = { id: 1, resourceType: "fetch", request };
        for (const shared of [true, false]) {
          const guard = readGuard(op, shared);
          assert.equal(guard(own, true), false, `${name} shared=${shared}`);
          const elsewhere = { ...own, request: { ...request, url: new URL("/account/delete", request.url).href } };
          if (shared) assert.equal(guard(elsewhere, true), true, `${name}: a POST to another path of its host`);
        }
      }
    }
    assert.ok(reads.length >= 7, reads.join(", "));
  });
});

describe("a trigger run that ran out of time in its steps", () => {
  const capture = (cut?: number): CaptureResult => ({
    exchanges: [],
    cookies: [],
    finalUrl: "https://www.example.com/search?q=secret",
    wait: { ended: "deadline", open: 0, status: 200 },
    ...(cut === undefined ? {} : { cut }),
  });
  const steps = [
    { action: "wait" as const, ms: 2000 },
    { action: "click" as const, selector: "#go" },
    { action: "wait" as const, ms: 4000 },
  ];

  test("it says which step it reached, and is an error with no heal to follow, not drift", () => {
    const op = { trigger: { url: "https://www.example.com/search", steps }, readOnly: true };
    const a = cutShort(op, capture(1));
    assert.equal(a?.class, "error");
    assert.equal(a?.tier, 3);
    assert.match(
      a?.reason ?? "",
      /^the trigger's steps were cut short at steps\[1\] of 3 \(click\): the time ran out on https:\/\/www\.example\.com\/search \(HTTP 200\)/,
    );
    assert.doesNotMatch(a?.reason ?? "", /secret/);
    assert.match(a?.hint ?? "", /^retry once: a browser run has 30 s/);
    // a write may have left with the click: nothing says to send it again
    assert.equal(cutShort({ ...op, readOnly: false }, capture(1))?.hint, undefined);
    assert.equal(cutShort(op, capture()), undefined, "a run that finished its steps");
  });

  test("the budget leaves the bundled specs' step waits room: no spec's waits take a third of it", () => {
    const dir = new URL("../sites/", import.meta.url);
    let longest = 0;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const site = parseSite(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
      for (const op of site.operations) {
        const waits = (op.trigger.steps ?? []).reduce(
          (n, s) => n + (s.action === "wait" && !s.selector ? (s.ms ?? 1000) : 0),
          0,
        );
        longest = Math.max(longest, waits);
        assert.ok(waits * 3 <= TRIGGER_BUDGET_MS, `${site.name} ${op.name} waits ${waits} ms in its steps`);
      }
    }
    assert.ok(longest >= 5000, "the bundled specs do have step waits");
  });
});

describe("unsafe requests in browser runs", { skip: !browserAvailable() && "no Chromium browser installed" }, () => {
  let fx: Fixture;
  before(async () => (fx = await startFixture()));
  after(async () => {
    await closeBrowser();
    await fx.close();
  });
  const sent = (path: string) => fx.calls.filter((c) => c.path.startsWith(path)).map((c) => `${c.method} ${c.path}`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const buy = { url: "", steps: [{ action: "click" as const, selector: "#buy" }] };

  test("a write is learned with its companion recorded, and a tier-3 call sends both, once, and says so", async () => {
    const r = await addOperation({
      site: "shop",
      op: "order",
      trigger: { ...buy, url: `${fx.url}/shop/{item}` },
      examples: [{ item: "fridge" }, { item: "toaster" }],
      match: { method: "POST", path: "/api/order" },
      write: true,
    });
    await sleep(300);
    assert.deepEqual([...sent("/api/cart"), ...sent("/api/order")], [], "learning sent the order or the cart");
    // the item in the cart's path is the example's: a wildcard, like a param's segment in a match
    assert.deepEqual(r.operation.trigger.companions, [{ method: "PUT", host: "127.0.0.1", path: "/api/cart/*" }]);

    updateSite("shop", (s) => ({ ...s!, operations: s!.operations.map((o) => ({ ...o, minTier: 3 as const })) }));
    const res = await call("shop", "order", { item: "kettle" }, { minIntervalMs: 0, allowWrites: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.tier, 3);
    assert.deepEqual([...sent("/api/cart"), ...sent("/api/order")], ["PUT /api/cart/kettle", "POST /api/order"]);
    assert.match(res.reason ?? "", /the page also sent PUT \/api\/cart\/kettle, as it did when this write was learned/);
  });

  test("after a redesign whose button deletes the account, a tier-3 call stops the DELETE and names it", async () => {
    updateSite("shop", (s) => ({
      ...s!,
      operations: s!.operations.map((o) => ({
        ...o,
        trigger: { ...o.trigger, url: `${fx.url}/shop/{item}?redesign=1` },
      })),
    }));
    const res = await call("shop", "order", { item: "fridge-t3" }, { minIntervalMs: 0, allowWrites: true });
    await sleep(300);
    assert.deepEqual(sent("/api/account"), [], "the DELETE reached the site");
    assert.equal(res.ok, false);
    assert.equal(res.class, "drift");
    assert.match(res.reason ?? "", /fired no request matching/);
    assert.match(
      res.reason ?? "",
      /the page also tried to send DELETE \/api\/account, which this write's learning did not see the trigger send: stopped in the browser, nothing of it was sent/,
    );
  });

  test("a write learned before companions were recorded still lets them out, and names each", async () => {
    updateSite("shop", (s) => ({
      ...s!,
      operations: s!.operations.map(({ trigger: { companions: _c, ...t }, ...o }) => ({ ...o, trigger: t })),
    }));
    const res = await call("shop", "order", { item: "fridge-old" }, { minIntervalMs: 0, allowWrites: true });
    await sleep(300);
    assert.deepEqual(sent("/api/account"), ["DELETE /api/account"]);
    assert.match(
      res.reason ?? "",
      /the page also sent DELETE \/api\/account: order was learned before api-anything recorded what else a write's trigger sends, so nothing else was stopped; learn it again with add --write/,
    );
  });

  test("a read add whose click places an order stops it, fails before run 2, and saves nothing", async () => {
    const before = fx.calls.length;
    await assert.rejects(
      addOperation({
        site: "shop",
        op: "item",
        trigger: { ...buy, url: `${fx.url}/shop/{item}` },
        examples: [{ item: "fridge" }, { item: "toaster" }],
      }),
      (e: Error) => {
        assert.match(
          e.message,
          /^PUT \/api\/cart\/fridge, POST \/api\/order, sent once the steps ran, were stopped in the browser: nothing was sent\. If it is an action \(an order, a post, a change\), add it again with --write, which never sends it\. Only if it changes nothing \(a search the site sends as PUT\), add it with --match method=PUT --match path=\/api\/cart\/fridge: a pinned request is sent for real on each learning run and saved as a read\. item was not saved$/,
        );
        return true;
      },
    );
    await sleep(300);
    const calls = fx.calls.slice(before).map((c) => `${c.method} ${c.path}`);
    // the page's own load went out, once: run 2 never ran
    assert.deepEqual(calls, ["GET /api/item?id=fridge"]);
  });

  test("capture without --write stops what the steps send, and says so", async () => {
    const before = fx.calls.length;
    const c = await capturePage({ url: `${fx.url}/shop/oven`, steps: buy.steps });
    await sleep(300);
    assert.deepEqual(
      fx.calls.slice(before).map((x) => `${x.method} ${x.path}`),
      ["GET /api/item?id=oven"],
    );
    assert.deepEqual(stoppedIn(c, c.url), { site: ["PUT /api/cart/oven", "POST /api/order"], elsewhere: [] });
    // learning the stopped order from it leads with --write; --match is offered only for what changes nothing
    const order = c.exchanges.find((e) => e.aborted && e.request.url.endsWith("/api/order"))!;
    await assert.rejects(
      addOperation({ site: "shop", op: "item", from: { capture: c, id: order.id }, examples: [{ item: "oven" }] }),
      (e: Error) => {
        assert.match(
          e.message,
          /was stopped in the browser as a possible write, so it has no answer to learn\. If it is an action \(an order, a post, a change\), add it with --write, which never sends it\. Only if it changes nothing \(a search the site sends as POST\), add it with --match method=POST --match path=\/api\/order and --trigger instead of --from: a pinned request is sent for real on each learning run and saved as a read$/,
        );
        return true;
      },
    );
  });

  test("reads sent as POST on a click: a GraphQL query passes, a pinned --match passes with the beacon beside it stopped", async () => {
    const steps = (button: string) => [
      { action: "fill" as const, selector: "#q", value: "{q}" },
      { action: "click" as const, selector: button },
    ];
    const gql = await addOperation({
      site: "finder",
      op: "findGql",
      trigger: { url: `${fx.url}/finder`, steps: steps("#gql") },
      examples: [{ q: "lamp" }, { q: "chair" }],
    });
    assert.equal(gql.operation.readOnly, true);
    assert.match(gql.operation.request.url, /\/api\/gql$/);

    await assert.rejects(
      addOperation({
        site: "finder",
        op: "find",
        trigger: { url: `${fx.url}/finder`, steps: steps("#go") },
        examples: [{ q: "lamp" }, { q: "chair" }],
      }),
      /POST \/api\/track, POST \/api\/find, sent once the steps ran, were stopped|POST \/api\/find, POST \/api\/track, sent once the steps ran, were stopped/,
    );
    const tracked = sent("/api/track").length;
    const pinned = await addOperation({
      site: "finder",
      op: "find",
      trigger: { url: `${fx.url}/finder`, steps: steps("#go") },
      examples: [{ q: "lamp" }, { q: "chair" }],
      match: { method: "POST", path: "/api/find" },
    });
    assert.equal(pinned.operation.readOnly, true);
    assert.match(pinned.operation.request.url, /\/api\/find$/);
    assert.ok(
      pinned.warnings.some((w) =>
        /the steps also sent POST \/api\/track, stopped in the browser \(nothing was sent\)/.test(w),
      ),
      pinned.warnings.join("\n"),
    );
    await sleep(300);
    assert.equal(sent("/api/track").length, tracked, "the beacon left");
    assert.equal(tracked, 0);
  });

  const since = (n: number, path: string) =>
    fx.calls
      .slice(n)
      .filter((c) => c.path.startsWith(path))
      .map((c) => `${c.method} ${c.path}`);

  test("a read with a method-less match answers from its own GET: the click's POST to that address is stopped and is no answer", async () => {
    saveSite(
      parseSite({
        name: "mail",
        baseUrl: fx.url,
        operations: [
          {
            name: "inbox",
            readOnly: true,
            request: { method: "GET", url: `${fx.url}/api/inbox?box=work`, headers: {} },
            slots: [{ param: "box", at: ["query:box"] }],
            params: [{ name: "box", example: "work" }],
            trigger: { url: `${fx.url}/inbox/{box}`, steps: [{ action: "click", selector: "#mark" }] },
            match: { path: "/api/inbox" },
            response: { format: "json", extract: "messages" },
            minTier: 3,
          },
        ],
      }),
    );
    const n = fx.calls.length;
    const res = await call("mail", "inbox", { box: "news" }, { minIntervalMs: 0 });
    await sleep(300);
    assert.deepEqual(since(n, "/api/inbox"), ["GET /api/inbox?box=news"], "the POST left, from the page or a heal");
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.tier, 3);
    assert.deepEqual(res.data, [{ subject: "news one" }, { subject: "news two" }]);
  });

  test("a read whose match covers the write its click sends: the stopped request is not learned, and no heal replays it", async () => {
    saveSite(
      parseSite({
        name: "closer",
        baseUrl: fx.url,
        operations: [
          {
            name: "item",
            readOnly: true,
            request: { method: "GET", url: `${fx.url}/api/item?id=fridge`, headers: {} },
            slots: [{ param: "item", at: ["query:id"] }],
            params: [{ name: "item", example: "fridge" }],
            trigger: { url: `${fx.url}/shop/{item}`, steps: buy.steps },
            match: { path: "/api/order" },
            // a recipe that drifted: the call goes to heal
            response: { format: "json", extract: "gone" },
          },
        ],
      }),
    );
    const n = fx.calls.length;
    const res = await call("closer", "item", { item: "kettle" }, { minIntervalMs: 0 });
    await sleep(300);
    assert.deepEqual(since(n, "/api/order"), [], "the order was sent");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /fired no request matching/);
    assert.match(res.reason ?? "", /POST \/api\/order matched and was stopped in the browser/);
  });

  test("a read whose steps outlast the run's time is an error naming the step: no drift, no heal, nothing stale", async () => {
    saveSite(
      parseSite({
        name: "slow",
        baseUrl: fx.url,
        operations: [
          {
            name: "item",
            readOnly: true,
            request: { method: "GET", url: `${fx.url}/api/never?id=fridge`, headers: {} },
            slots: [{ param: "item", at: ["query:id"] }],
            params: [{ name: "item", example: "fridge" }],
            trigger: {
              url: `${fx.url}/shop/{item}`,
              steps: [{ action: "wait", ms: TRIGGER_BUDGET_MS + 10_000 }, ...buy.steps],
            },
            match: { path: "/api/never" },
            minTier: 3,
          },
        ],
      }),
    );
    const n = fx.calls.length;
    const res = await call("slow", "item", { item: "kettle" }, { minIntervalMs: 0 });
    assert.equal(res.ok, false);
    assert.equal(res.class, "error", JSON.stringify(res));
    assert.match(
      res.reason ?? "",
      /^the trigger's steps were cut short at steps\[0\] of 2 \(wait\): the time ran out on /,
    );
    // one browser run: a heal's recapture would have loaded the page again
    assert.deepEqual(since(n, "/api/item"), ["GET /api/item?id=kettle"]);
    assert.equal(staleMark("slow", "item"), undefined);
  });

  test("a read's heal never turns a GET into a POST the page sent while loading", async () => {
    saveSite(
      parseSite({
        name: "loader",
        baseUrl: fx.url,
        operations: [
          {
            name: "scoped",
            readOnly: true,
            request: { method: "GET", url: `${fx.url}/api/scoped?q=pizza`, headers: {} },
            slots: [{ param: "q", at: ["query:q"] }],
            params: [{ name: "q", example: "pizza" }],
            trigger: { url: `${fx.url}/early?q={q}` },
            match: { path: "/api/find" },
            response: { format: "json", extract: "gone" },
          },
        ],
      }),
    );
    const n = fx.calls.length;
    const res = await call("loader", "scoped", { q: "sushi" }, { minIntervalMs: 0 });
    await sleep(300);
    // the page's own load sends one in the heal's browser run, as a visit does: none from the heal itself
    assert.deepEqual(since(n, "/api/find"), ["POST /api/find"]);
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /the page's request is a POST, and scoped reads with GET/);
  });
});
