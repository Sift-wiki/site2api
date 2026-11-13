/**
 * GET /v1/try: the catalog's one request to a site. Upstream is a local server standing in for
 * en.wikipedia.org: fetch is pointed at it, so nothing leaves localhost.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { parseSite } from "../../src/spec.js";
import { CSP } from "../src/pages.js";
import { TRY_OPS, tryOps, tryRefusal } from "../src/try.js";
import { install, op, registry, report, seed, send, site, upload } from "./helpers.js";

const wikipedia = parseSite(JSON.parse(readFileSync(new URL("../../sites/wikipedia.json", import.meta.url), "utf8")));
const WIKI = { name: "wikipedia", domain: "wikipedia.org", baseUrl: wikipedia.baseUrl };
const summaryOp = wikipedia.operations.find((o) => o.name === "getSummary")!;

interface Seen {
  path: string;
  headers: IncomingMessage["headers"];
}
let seen: Seen[] = [];
/** every URL the Worker's fetch was called with, answered or not */
let asked: string[] = [];
let handle: (req: IncomingMessage, res: ServerResponse) => void;
let origin = "";
const server = createServer((req, res) => {
  seen.push({ path: req.url ?? "", headers: req.headers });
  handle(req, res);
});
const realFetch = globalThis.fetch;
const WIKI_ORIGIN = "https://en.wikipedia.org";

const summary = (title: string) =>
  JSON.stringify({
    title,
    description: "a soft-bodied mollusc",
    extract: `${title} is an animal.`,
    pageid: 1,
    timestamp: "2026-01-01T00:00:00Z",
    type: "standard",
    content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title}` } },
  });

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // the Worker's fetch, to the stand-in: only https://en.wikipedia.org is answered, anything else fails loudly
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    asked.push(url.href);
    if (url.origin !== WIKI_ORIGIN) throw new Error(`the test reached for ${url.origin}`);
    return realFetch(`${origin}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  server.close();
});
beforeEach(() => {
  seen = [];
  asked = [];
  handle = (req, res) => {
    const title = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
    res.writeHead(200, { "content-type": "application/json" }).end(summary(title));
  };
});

async function open(vars: Record<string, string> = {}) {
  const r = registry({ TRY_ENABLED: "true", ...vars });
  const s = await seed(r.env, { site: WIKI, operations: wikipedia.operations });
  assert.equal(s.status, 200, s.text);
  return r;
}

const tryIt = (env: ReturnType<typeof registry>["env"], path: string, ip = "198.51.100.7", headers = {}) =>
  send(env, "GET", `/v1/try/${path}`, { ip, headers });

describe("try: the answer", () => {
  test("a CallResult from one live read, via the catalog, with how to install", async () => {
    const { env } = await open();
    const r = await tryIt(env, "wikipedia/getSummary?title=Alan_Turing", "198.51.100.7", {
      cookie: "session=visitor",
      authorization: "Bearer visitor",
      "x-visitor": "1",
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const { ms, next, data, ...rest } = r.body;
    assert.deepEqual(rest, { ok: true, class: "ok", tier: 1, via: "catalog-try" });
    assert.equal(typeof ms, "number");
    assert.equal(data.title, "Alan_Turing");
    assert.equal(data.url, "https://en.wikipedia.org/wiki/Alan_Turing");
    assert.match(next, /npx -y api-anything setup/);
    assert.match(next, /api-anything call wikipedia getSummary title=Alan_Turing/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.path, "/api/rest_v1/page/summary/Alan_Turing");
    const h = seen[0]!.headers;
    assert.equal(h.cookie, undefined, "no cookie is sent");
    assert.equal(h.authorization, undefined, "nothing of the visitor's request is sent");
    assert.equal(h["x-visitor"], undefined);
    assert.equal(h["cf-connecting-ip"], undefined);
    assert.equal(h["user-agent"], summaryOp.request.headers["user-agent"], "the op's own headers are");
  });

  test("with no args it runs the op's examples; a bad arg is input and sends nothing", async () => {
    const { env } = await open();
    const r = await tryIt(env, "wikipedia/getSummary");
    assert.equal(r.body.data.title, "Octopus");
    const bad = await tryIt(env, "wikipedia/getSummary?nope=1");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.class, "input");
    assert.match(bad.body.reason, /unknown arg nope/);
    const twice = await tryIt(env, "wikipedia/getSummary?title=a&title=b");
    assert.equal(twice.status, 400);
    const long = await tryIt(env, `wikipedia/getSummary?title=${"a".repeat(501)}`);
    assert.equal(long.status, 400);
    assert.equal(seen.length, 1);
  });

  test("the call in `next` spells an arg only when every shell reads it alike, else a placeholder", async () => {
    const { env } = await open();
    const call = async (title: string) =>
      /`(api-anything call [^`]*)`/.exec(
        (await tryIt(env, `wikipedia/getSummary?title=${encodeURIComponent(title)}`)).body.next,
      )?.[1];
    assert.equal(await call("Tom & Jerry's"), "api-anything call wikipedia getSummary title=<title>");
    assert.equal(await call("100%_USERNAME%"), "api-anything call wikipedia getSummary title=<title>");
    assert.equal(await call("Alan Turing"), 'api-anything call wikipedia getSummary "title=Alan Turing"');
  });

  test("a site's answer that is not its data is judged as the client judges it", async () => {
    const { env } = await open();
    handle = (_req, res) => res.writeHead(429, { "retry-after": "30" }).end("slow down");
    const r = await tryIt(env, "wikipedia/getSummary?title=X");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.class, "rate");
    assert.equal(r.body.via, "catalog-try");
  });
});

describe("try: what may run", () => {
  test("the allowlist names bundled public reads, each passing every rule, pinned to its own origin", () => {
    for (const [name, ops] of Object.entries(TRY_OPS)) {
      const spec = parseSite(JSON.parse(readFileSync(new URL(`../../sites/${name}.json`, import.meta.url), "utf8")));
      for (const o of Object.keys(ops)) {
        const operation = spec.operations.find((x) => x.name === o);
        assert.ok(operation, `${name} ${o} is bundled`);
        assert.equal(
          tryRefusal({ name, baseUrl: spec.baseUrl, operations: spec.operations }, operation),
          undefined,
          `${name} ${o}`,
        );
        const bundled = tryOps().get(`${name}/${o}`);
        assert.ok(bundled, `${name} ${o} runs`);
        assert.deepEqual(bundled.op, operation, "the op runs as it is in sites/");
        const own = new URL(operation.request.url).origin;
        assert.deepEqual([...bundled.origins], [own, ...ops[o]!]);
        for (const at of bundled.origins) assert.match(at, /^https:\/\/[a-z0-9.-]+$/, "https, no port");
      }
    }
    assert.equal(tryOps().size, Object.values(TRY_OPS).flatMap(Object.keys).length);
  });

  test("an op not on the allowlist is refused before anything is read or sent", async () => {
    const { env } = await open();
    await seed(env, { site, operations: [op()] });
    for (const path of ["example-com/searchBooks", "wikipedia/getSections", "nosuch/getSummary"]) {
      const r = await tryIt(env, path);
      assert.equal(r.status, 404, path);
      assert.equal(r.body.class, "refused");
      assert.equal(r.body.via, "catalog-try");
    }
    assert.equal(seen.length, 0);
  });

  test("an allowlisted name holding a cookie ref, a write, or another port is refused", () => {
    const live = (over: Record<string, unknown>, allow = TRY_OPS) =>
      tryRefusal({ ...WIKI, operations: wikipedia.operations }, { ...summaryOp, ...over } as typeof summaryOp, allow);
    const slot = summaryOp.slots[0]!;
    assert.match(live({ slots: [slot, { ref: "cookie:sid", at: ["header:x-sid"] }] })!, /cookie, a session value/);
    assert.match(
      live({ slots: [slot, { template: "Bearer {session:token}", at: ["header:authorization"] }] })!,
      /cookie, a session value/,
    );
    assert.match(live({ readOnly: false })!, /it writes/);
    assert.match(live({ request: { ...summaryOp.request, method: "POST" } })!, /not GET/);
    assert.match(live({ minTier: 2 })!, /needs a browser/);
    assert.match(live({ learnedLoggedIn: true })!, /signed in/);
    assert.match(
      live({ request: { ...summaryOp.request, url: "https://evil-example.com/api/{title}" } })!,
      /off its own site/,
    );
    assert.match(live({ request: { ...summaryOp.request, url: "http://en.wikipedia.org/x/{title}" } })!, /not https/);
    assert.match(
      live({
        request: { ...summaryOp.request, url: "https://en.wikipedia.org:8443/api/rest_v1/page/summary/{title}" },
      })!,
      /not https on port 443/,
    );
    const odd = { ...TRY_OPS, wikipedia: { getSummary: ["https://upload.wikimedia.org:8443"] } };
    assert.match(live({}, odd)!, /extra origin .* not an https origin on port 443/);
    assert.equal(live({}), undefined);
  });

  test("a replacement promoted live through uploads and reports is never run: the bundled op is", async () => {
    const { env } = await open();
    // the same op with its request's address changed under the same match: held for a maintainer
    const moved = {
      ...summaryOp,
      request: { ...summaryOp.request, url: "https://internal.wikipedia.org:8443/admin/metadata/x/%7Btitle%7D" },
    };
    const held = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ site: WIKI, operation: moved }),
    });
    assert.equal(held.body.status, "review", held.text);
    // what the review rules still take without one: the same method, origin and path, with a query of its own
    const evil = { ...summaryOp, request: { ...summaryOp.request, url: `${summaryOp.request.url}?action=purge` } };
    const up = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ site: WIKI, operation: evil }),
    });
    assert.equal(up.status, 201, up.text);
    assert.equal(up.body.status, "candidate", up.text);
    const getSummary = async () =>
      (await send(env, "GET", "/v1/sites/wikipedia")).body.operations.find(
        (o: { operation: { name: string } }) => o.operation.name === "getSummary",
      );
    const incumbent = (await getSummary()).hash;
    for (const ip of ["198.51.100.7", "192.0.2.1", "203.0.113.5"]) {
      await report(env, install(), up.body.hash, "ok", ip);
      await report(env, install(), incumbent, "fail", ip);
    }
    const replaced = await getSummary();
    assert.equal(replaced.status, "live", "the replacement is what the registry serves");
    assert.match(replaced.operation.request.url, /action=purge/);

    const r = await tryIt(env, "wikipedia/getSummary?title=Octopus", "203.0.113.5");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.data.title, "Octopus");
    assert.deepEqual(asked, [`${WIKI_ORIGIN}/api/rest_v1/page/summary/Octopus`]);
  });

  test("TRY_ENABLED off, or unset, refuses every try and shows no form", async () => {
    for (const vars of [{ TRY_ENABLED: "false" }, {}] as Record<string, string>[]) {
      const { env } = registry(vars);
      await seed(env, { site: WIKI, operations: wikipedia.operations });
      const r = await tryIt(env, "wikipedia/getSummary");
      assert.equal(r.status, 503);
      assert.match(r.body.reason, /switched off/);
      const page = await send(env, "GET", "/sites/wikipedia");
      assert.doesNotMatch(page.text, / data-try>/);
    }
    assert.equal(seen.length, 0);
  });

  test("an allowlisted site's page has a form with the example args, and no other site's does", async () => {
    const { env } = await open();
    await seed(env, { site, operations: [op()] });
    const page = await send(env, "GET", "/sites/wikipedia");
    assert.equal(page.headers.get("content-security-policy"), CSP);
    assert.match(CSP, /connect-src 'self'/);
    assert.match(page.text, /<form method="get" action="\/v1\/try\/wikipedia\/getSummary" data-try>/);
    assert.match(page.text, /<input name="title" value="Octopus"/);
    assert.match(page.text, /<form method="get" action="\/v1\/try\/wikipedia\/searchArticles" data-try>/);
    assert.doesNotMatch(page.text, /\/v1\/try\/wikipedia\/getSections/);
    assert.match(
      page.text,
      /curl -s &#39;https:\/\/registry\.test\/v1\/try\/wikipedia\/getSummary\?title=Octopus&#39;/,
    );
    assert.equal(page.text.match(/<script>/g)?.length, 1);
    const other = await send(env, "GET", "/sites/example-com");
    assert.doesNotMatch(other.text, / data-try>/);
  });
});

describe("try: limits", () => {
  test("per network: a minute's and a day's budget, answered 429 with Retry-After", async () => {
    const { env } = await open({ TRY_PER_MINUTE: "2", TRY_PER_DAY: "3" });
    assert.equal((await tryIt(env, "wikipedia/getSummary", "198.51.100.7")).status, 200);
    assert.equal((await tryIt(env, "wikipedia/getSummary", "198.51.100.8")).status, 200, "the same /24");
    const third = await tryIt(env, "wikipedia/getSummary", "198.51.100.9");
    assert.equal(third.status, 429);
    assert.equal(third.body.class, "rate");
    assert.match(third.body.reason, /2 tries a minute/);
    assert.ok(Number(third.headers.get("retry-after")) <= 60);
    assert.equal((await tryIt(env, "wikipedia/getSummary", "192.0.2.1")).status, 200, "another network has its own");
    const { env: daily, raw } = await open({ TRY_PER_MINUTE: "100", TRY_PER_DAY: "2" });
    await tryIt(daily, "wikipedia/getSummary");
    await tryIt(daily, "wikipedia/getSummary");
    const over = await tryIt(daily, "wikipedia/getSummary");
    assert.equal(over.status, 429);
    assert.match(over.body.reason, /2 tries a day/);
    assert.ok(Number(over.headers.get("retry-after")) > 0);
    const rows = raw.prepare("SELECT subject FROM rates").all() as { subject: string }[];
    assert.ok(
      rows.every((r) => /^(net:[0-9a-f]{32}|all)$/.test(r.subject)),
      "a network is counted by its hash, never its address",
    );
  });

  test("a global daily cap on sends", async () => {
    const { env } = await open({ TRY_PER_DAY_ALL: "2" });
    assert.equal((await tryIt(env, "wikipedia/getSummary?title=A", "198.51.100.7")).status, 200);
    assert.equal((await tryIt(env, "wikipedia/getSummary?title=B", "192.0.2.1")).status, 200);
    const r = await tryIt(env, "wikipedia/getSummary?title=C", "203.0.113.5");
    assert.equal(r.status, 503);
    assert.equal(r.body.class, "rate");
    assert.match(r.body.reason, /at most 2 sends a day/);
    assert.equal(seen.length, 2);
  });

  test("each redirect hop takes a send from the global cap", async () => {
    const { env } = await open({ TRY_PER_DAY_ALL: "3" });
    // /summary/<t> redirects once to /summary/<t>_
    handle = (req, res) => {
      const title = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
      if (title.endsWith("_")) res.writeHead(200, { "content-type": "application/json" }).end(summary(title));
      else res.writeHead(302, { location: `/api/rest_v1/page/summary/${title}_` }).end();
    };
    const first = await tryIt(env, "wikipedia/getSummary?title=A", "198.51.100.7");
    assert.equal(first.body.ok, true, first.text);
    assert.equal(first.body.data.title, "A_");
    assert.equal(seen.length, 2, "two sends for one try");
    const second = await tryIt(env, "wikipedia/getSummary?title=B", "192.0.2.1");
    assert.equal(second.status, 503, "the cap is reached at the redirect");
    assert.match(second.body.reason, /at most 3 sends a day/);
    assert.equal(seen.length, 3, "the hop over the cap is not sent");
    const third = await tryIt(env, "wikipedia/getSummary?title=C", "203.0.113.5");
    assert.equal(third.status, 503);
    assert.equal(seen.length, 3);
  });

  test("an upstream that does not answer in time is an error, after the timeout", async () => {
    const { env } = await open({ TRY_TIMEOUT_MS: "200" });
    handle = () => {}; // never answers
    const t0 = Date.now();
    const r = await tryIt(env, "wikipedia/getSummary");
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(r.status, 504);
    assert.equal(r.body.class, "error");
    assert.match(r.body.reason, /no answer from the site within 200 ms/);
  });

  test("an answer over the size cap is refused, declared or streamed", async () => {
    const { env } = await open({ TRY_MAX_BYTES: "1000" });
    const big = JSON.stringify({ title: "x".repeat(5000) });
    handle = (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(big);
    const declared = await tryIt(env, "wikipedia/getSummary?title=A");
    assert.equal(declared.status, 502);
    assert.match(declared.body.reason, /over 1000 bytes/);
    handle = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(big.slice(0, 800));
      res.end(big.slice(800));
    };
    const streamed = await tryIt(env, "wikipedia/getSummary?title=B");
    assert.equal(streamed.status, 502);
    assert.match(streamed.body.reason, /over 1000 bytes/);
  });

  test("a redirect anywhere but the op's exact origin is not followed", async () => {
    const { env } = await open({ TRY_PER_MINUTE: "100" });
    for (const [location, shown] of [
      ["https://evil.example/steal", "https://evil.example"],
      ["https://internal.wikipedia.org/admin/metadata", "https://internal.wikipedia.org"],
      ["https://en.wikipedia.org:8443/admin/metadata", "https://en.wikipedia.org:8443"],
      ["http://en.wikipedia.org/api/rest_v1/page/summary/Octopus", "http://en.wikipedia.org"],
    ] as const) {
      seen = [];
      asked = [];
      handle = (_req, res) => res.writeHead(302, { location }).end();
      const r = await tryIt(env, "wikipedia/getSummary");
      assert.equal(r.status, 502, location);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.reason, `the site redirected to ${shown}, which the catalog does not follow`);
      assert.equal(seen.length, 1);
      assert.deepEqual(asked, [`${WIKI_ORIGIN}/api/rest_v1/page/summary/Octopus`], "only the op's origin was asked");
    }
  });

  test("at most 2 redirects, on the op's origin", async () => {
    const { env } = await open();
    // /summary/<t> redirects to /summary/<t>_ until the title ends in `ends` underscores
    let ends = 2;
    handle = (req, res) => {
      const title = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
      if (title.endsWith("_".repeat(ends)))
        res.writeHead(200, { "content-type": "application/json" }).end(summary(title));
      else res.writeHead(301, { location: `${WIKI_ORIGIN}/api/rest_v1/page/summary/${title}_` }).end();
    };
    const two = await tryIt(env, "wikipedia/getSummary?title=A");
    assert.equal(two.body.ok, true, two.text);
    assert.equal(two.body.data.title, "A__");
    assert.equal(seen.length, 3);
    ends = 3;
    seen = [];
    const three = await tryIt(env, "wikipedia/getSummary?title=B");
    assert.equal(three.body.ok, false);
    assert.match(three.body.reason, /redirected more than 2 times/);
    assert.equal(seen.length, 3);
  });

  test("an ok answer is cached for ten minutes by its filled URL; a failure is not", async () => {
    const { env } = await open();
    const store = new Map<string, Response>();
    const ttl: string[] = [];
    const g = globalThis as { caches?: unknown };
    g.caches = {
      default: {
        match: async (r: Request) => store.get(r.url)?.clone(),
        put: async (r: Request, res: Response) => {
          ttl.push(res.headers.get("cache-control") ?? "");
          store.set(r.url, res);
        },
      },
    };
    try {
      const first = await tryIt(env, "wikipedia/getSummary?title=Octopus");
      assert.equal(first.body.cached, undefined);
      const again = await tryIt(env, "wikipedia/getSummary", "192.0.2.1");
      assert.equal(again.status, 200);
      assert.equal(again.body.cached, true, "the examples fill the same URL");
      assert.deepEqual(again.body.data, first.body.data);
      assert.equal(seen.length, 1);
      assert.deepEqual(ttl, ["public, max-age=600"]);
      handle = (_req, res) => res.writeHead(500).end("down");
      await tryIt(env, "wikipedia/getSummary?title=Squid");
      await tryIt(env, "wikipedia/getSummary?title=Squid");
      assert.equal(seen.length, 3, "a failure is sent again");
      assert.equal(store.size, 1);
    } finally {
      delete g.caches;
    }
  });
});
