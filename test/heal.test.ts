/**
 * Heal edge cases against small local servers: which args a recapture learns from, what a failed
 * heal leaves behind, what validates a candidate, and that call() never throws.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { browserAvailable, closeBrowser } from "../src/browser.js";
import { call } from "../src/execute.js";
import { addOperation, type CaptureFile, refPart } from "../src/heal.js";
import { parseSite } from "../src/spec.js";
import { loadSite, markStale, saveSite, staleMark } from "../src/store.js";
import type { Exchange } from "../src/types.js";
import { type Fixture, startFixture } from "./fixture/server.js";

const HOME = mkdtempSync(join(tmpdir(), "api-anything-heal-"));
process.env.API_ANYTHING_HOME = HOME;
const fast = { minIntervalMs: 0 };

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** A capture of `page` as a browser makes it: the document, then the request its script sends. */
async function captureOf(fx: Fixture, page: string, api: string): Promise<CaptureFile> {
  const exchange = async (id: number, resourceType: string, path: string): Promise<Exchange> => {
    const res = await fetch(`${fx.url}${path}`);
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    return {
      id,
      resourceType,
      request: { method: "GET", url: `${fx.url}${path}`, headers: {} },
      response: { status: res.status, headers: { "content-type": contentType }, body, contentType },
    };
  };
  const url = `${fx.url}${page}`;
  return {
    id: `c-heal-${captureCount++}`,
    at: new Date().toISOString(),
    url,
    finalUrl: url,
    cookies: [],
    exchanges: [await exchange(1, "document", page), await exchange(2, "fetch", api)],
  };
}
let captureCount = 0;

describe("add: what it refuses to save, and what it doubts", () => {
  let fx: Fixture;
  before(async () => (fx = await startFixture()));
  after(() => fx.close());

  test("a server that answers both examples with the same data: saved with a warning, and marked unproven", async () => {
    const r = await addOperation({
      site: "stores",
      op: "near",
      examples: [{ city: "Sydney" }, { city: "Hobart" }],
      from: { capture: await captureOf(fx, "/stores?city=Sydney", "/api/stores?city=Sydney") },
      from2: await captureOf(fx, "/stores?city=Hobart", "/api/stores?city=Hobart"),
      response: { extract: "stores" },
    });
    const w = r.warnings.find((x) => /example 1's data/.test(x));
    assert.ok(w, r.warnings.join(" | "));
    assert.match(w, /example 2 \(city=Hobart\) was answered with example 1's data/);
    assert.match(w, /excludes something example 1 returned/);
    assert.deepEqual(r.operation.unproven?.params, ["city"]);
    assert.deepEqual(loadSite("stores")!.site.operations[0]!.unproven, r.operation.unproven);
  });

  test("example 2 changing two params: each is sent alone, and only the one that leaves the answer alone is unproven", async () => {
    const from = { capture: await captureOf(fx, "/stores?city=Sydney&open=yes", "/api/stores?city=Sydney&open=yes") };
    const from2 = await captureOf(fx, "/stores?city=Hobart&open=no", "/api/stores?city=Hobart&open=no");
    const before = fx.calls.length;
    const r = await addOperation({
      site: "stores-filter",
      op: "near",
      examples: [
        { city: "Sydney", open: "yes" },
        { city: "Hobart", open: "no" },
      ],
      from,
      from2,
      response: { extract: "stores" },
    });
    // open=no answered one store to example 1's two, so the whole-answer check sees nothing
    assert.deepEqual(r.operation.unproven?.params, ["city"]);
    assert.match(r.operation.unproven!.reason, /example 1's args with only city=Hobart from example 2 was answered/);
    const w = r.warnings.find((x) => /example 1's data/.test(x));
    assert.ok(w, r.warnings.join(" | "));
    assert.match(w, /may not read city from this request/);
    assert.match(w, /example 2 whose city alone excludes something example 1 returned/);
    // one tier-1 read per changed param, each example 1's args with that one value from example 2
    const probes = fx.calls.slice(before).map((c) => c.path);
    assert.deepEqual(probes.sort(), ["/api/stores?city=Hobart&open=yes", "/api/stores?city=Sydney&open=no"]);
    assert.deepEqual(loadSite("stores-filter")!.site.operations[0]!.unproven, r.operation.unproven);
  });

  test("examples answered with different data prove nothing is ignored: no mark", async () => {
    const r = await addOperation({
      site: "scoped",
      op: "search",
      examples: [{ q: "kittens" }, { q: "puppies" }],
      from: { capture: await captureOf(fx, "/scoped?q=kittens", "/api/scoped?q=kittens") },
      from2: await captureOf(fx, "/scoped?q=puppies", "/api/scoped?q=puppies"),
    });
    assert.equal(r.operation.unproven, undefined);
    assert.equal(
      r.warnings.some((x) => /example 1's data/.test(x)),
      false,
      r.warnings.join(" | "),
    );
  });

  test("allowed values are set at add, must fit the examples, and stay with checks when the op is learned again", async () => {
    const from = async () => ({ capture: await captureOf(fx, "/scoped?q=kittens", "/api/scoped?q=kittens") });
    await assert.rejects(
      addOperation({
        site: "allowed",
        op: "search",
        examples: [{ q: "kittens" }],
        from: await from(),
        allowed: { q: { enum: ["cats", "dogs"] } },
      }),
      /example q=kittens is not a value q allows: it must be one of "cats", "dogs"/,
    );
    await assert.rejects(
      addOperation({
        site: "allowed",
        op: "search",
        examples: [{ q: "kittens" }],
        from: await from(),
        allowed: { page: { max: 5 } },
      }),
      /page is no param of search; its params are q/,
    );
    const r = await addOperation({
      site: "allowed",
      op: "search",
      examples: [{ q: "kittens" }],
      from: await from(),
      allowed: { q: { enum: ["kittens", "puppies"] } },
    });
    assert.deepEqual(r.operation.params[0]!.enum, ["kittens", "puppies"]);
    const site = loadSite("allowed")!.site;
    site.operations[0]!.checks = [{ args: { q: "puppies" }, expect: "result" }];
    site.operations[0]!.links = [{ from: "q", to: { op: "search", arg: "q" } }];
    saveSite(site);
    const again = await addOperation({
      site: "allowed",
      op: "search",
      examples: [{ q: "kittens" }],
      from: await from(),
    });
    assert.deepEqual(again.operation.params[0]!.enum, ["kittens", "puppies"]);
    assert.deepEqual(again.operation.checks, [{ args: { q: "puppies" }, expect: "result" }]);
    assert.deepEqual(again.operation.links, site.operations[0]!.links);
  });

  test("an op learned from a sign-in page is not saved: add says to log in, then add again", async () => {
    await assert.rejects(
      addOperation({
        site: "walled-add",
        op: "secret",
        examples: [{ q: "kittens" }],
        from: { capture: await captureOf(fx, "/stores?city=x", "/private?q=kittens"), id: 2 },
        response: { html: { items: "li", fields: { name: "" } } },
      }),
      /refusing to save .*sign-in page.*api-anything login walled-add.*then add again/,
    );
    assert.equal(loadSite("walled-add"), undefined);
  });
});

describe("refPart: the text a templated ref holds in a leaf the page sent", () => {
  /** What refPart was: one lazy wildcard per hole, which backtracks through every split of a leaf that does not fit. */
  const byRegex = (template: string, ref: string, leaf: string): string | undefined => {
    const re = template
      .split(/(\{\{|\}\}|\{[^{}]+\})/)
      .map((p) =>
        p === "{{"
          ? "\\{"
          : p === "}}"
            ? "\\}"
            : p === `{${ref}}`
              ? "(.*?)"
              : /^\{[^{}]+\}$/.test(p)
                ? ".*?"
                : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    return new RegExp(`^${re}$`, "s").exec(leaf)?.[1];
  };

  test("a leaf that does not fit is read in time linear in its length, whatever the holes", () => {
    const timed = (template: string, leaf: string) => {
      const t0 = performance.now();
      assert.equal(refPart(template, "session:t", leaf), undefined);
      return performance.now() - t0;
    };
    const dots = timed("{session:t}.{a}.{b}!", ".".repeat(5000));
    assert.ok(dots < 250, `3 holes on 5000 dots: ${Math.round(dots)} ms`);
    const letters = timed("{session:t}{q}{q}{q}{q}{q}{q}!", "a".repeat(48));
    assert.ok(letters < 50, `7 holes on 48 letters: ${Math.round(letters)} ms`);
    const long = timed("{session:t}.{a}.{b}.{c}.{d}.{e}.{f}!", ".".repeat(1_000_000));
    assert.ok(long < 250, `7 holes on a million dots: ${Math.round(long)} ms`);
  });

  test("the answers are the lazy pattern's", () => {
    assert.equal(refPart("v1:{session:t}", "session:t", "v1:abc"), "abc");
    assert.equal(refPart("{session:t}.{a}.{b}!", "session:t", "x.y.z!"), "x");
    assert.equal(refPart("{session:t}.{a}.{b}!", "a", "x.y.z!"), "y");
    assert.equal(refPart("{session:t}.{a}.{b}!", "b", "x.y.z.w!"), "z.w");
    assert.equal(refPart("{a}{session:t}", "a", "xy"), "");
    assert.equal(refPart("{a}{session:t}", "session:t", "xy"), "xy");
    assert.equal(refPart("{{{session:t}}}", "session:t", "{k}"), "k");
    assert.equal(refPart("{session:t}", "session:t", "line1\nline2"), "line1\nline2");
    assert.equal(refPart("a{session:t}a", "session:t", "a"), undefined, "the ends may not overlap");
    assert.equal(refPart("v1:{session:t}", "session:t", "v2:abc"), undefined);
    assert.equal(refPart("{session:t}.{a}!", "session:t", "x.y"), undefined);
    assert.equal(refPart("v1:{a}", "session:t", "v1:abc"), undefined, "a ref the template does not hold");
    assert.equal(refPart("q={session:t}", "session:t", "q=a%20b", "url"), "a b");
    assert.equal(refPart("q={session:t}", "session:t", "q=%E0%A4%A", "url"), "%E0%A4%A", "a bad escape stays raw");
    assert.equal(refPart('"{session:t}"', "session:t", '"a\\"b"', "json"), 'a"b');
  });

  test("the scan and the lazy pattern agree on random templates and leaves", () => {
    // a small alphabet, so that literals recur inside the holes' text and every split is in play
    let seed = 0x2f6e2b1;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const text = (max: number) => Array.from({ length: rand(max + 1) }, () => "ab.{}"[rand(5)]!).join("");
    const piece = () => [() => "{h}", () => "{o}", () => "{{", () => "}}", () => "ab."[rand(3)]!][rand(5)]!();
    let fit = 0;
    for (let i = 0; i < 100_000; i++) {
      const template = Array.from({ length: 1 + rand(7) }, piece).join("");
      const leaf = text(8);
      const want = byRegex(template, "h", leaf);
      assert.equal(refPart(template, "h", leaf), want, JSON.stringify({ template, leaf }));
      if (want !== undefined) fit++;
    }
    assert.ok(fit > 5000, `only ${fit} leaves fit a template`);
  });
});

describe("heal", { skip: !browserAvailable() && "no Chromium browser installed" }, () => {
  const servers: Server[] = [];
  const fixtures: Fixture[] = [];
  after(async () => {
    await closeBrowser();
    for (const f of fixtures) await f.close();
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
    rmSync(HOME, { recursive: true, force: true });
  });

  // A search API that renames q -> term after a deploy; the page JS follows along.
  let version = "v1";
  let pageLoads = 0;
  const search = () =>
    serve((req, res) => {
      const u = new URL(req.url!, "http://x");
      const key = version === "v1" ? "q" : version === "v2" ? "term" : "gone";
      if (u.pathname.startsWith("/api/")) {
        if (!u.searchParams.has(key))
          return void res.writeHead(400, { "content-type": "application/json" }).end('{"error":"unknown argument"}');
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(
          JSON.stringify({ results: [{ q: u.searchParams.get(key), page: u.searchParams.get("page") }, { q: "x" }] }),
        );
      }
      pageLoads++;
      res.writeHead(200, { "content-type": "text/html" });
      if (version === "v3") return void res.end("<html><body>search is down</body></html>");
      res.end(`<html><body><script>const p=new URLSearchParams(location.search);
fetch("/api/search?${key}="+encodeURIComponent(p.get("q"))+"&page="+encodeURIComponent(p.get("page")||"1"))</script></body></html>`);
    });

  test("recapture with an omitted optional arg keeps every param's slot (defaults filled)", async () => {
    const { server, base } = await search();
    servers.push(server);
    version = "v1";
    await addOperation({
      site: "s1",
      op: "search",
      trigger: { url: `${base}/s?q={q}&page={page}` },
      examples: [
        { q: "hello", page: "100" },
        { q: "world", page: "200" },
      ],
      response: { extract: "results" },
    });
    const site = loadSite("s1")!.site;
    site.operations[0]!.params[1] = { ...site.operations[0]!.params[1]!, required: false, default: "100" };
    site.operations[0]!.links = [{ from: "q", to: { op: "search", arg: "q" } }];
    saveSite(site);
    version = "v2";
    const r = await call("s1", "search", { q: "cats" }, fast);
    assert.equal(r.healed, true, JSON.stringify(r));
    const op = loadSite("s1")!.site.operations[0]!;
    assert.deepEqual(op.links, site.operations[0]!.links);
    assert.deepEqual([...new Set(op.slots.flatMap((s) => (s.param ? [s.param] : [])))].sort(), ["page", "q"]);
    const later = await call("s1", "search", { q: "dogs", page: "250" }, fast);
    assert.deepEqual((later.data as unknown[])[0], { q: "dogs", page: "250" });
  });

  test("recapture with a short arg (page=2) learns from the op's examples instead", async () => {
    const { server, base } = await search();
    servers.push(server);
    version = "v1";
    await addOperation({
      site: "s2",
      op: "search",
      trigger: { url: `${base}/s?q={q}&page={page}` },
      examples: [
        { q: "hello", page: "100" },
        { q: "world", page: "200" },
      ],
      response: { extract: "results" },
    });
    version = "v2";
    const r = await call("s2", "search", { q: "cats", page: "2" }, fast);
    assert.equal(r.healed, true, JSON.stringify(r));
    assert.deepEqual((r.data as unknown[])[0], { q: "cats", page: "2" });
  });

  test("a recapture whose answer lost a picked field is not saved: the call is drift naming it", async () => {
    let v2 = false;
    const { server, base } = await serve((req, res) => {
      const u = new URL(req.url!, "http://x");
      const key = v2 ? "term" : "q";
      if (u.pathname.startsWith("/api/")) {
        if (!u.searchParams.has(key))
          return void res.writeHead(400, { "content-type": "application/json" }).end('{"error":"unknown argument"}');
        const q = u.searchParams.get(key);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ results: [v2 ? { q, cost: 3 } : { q, price: 3 }] }));
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<html><body><script>fetch("/api/search?${key}="+encodeURIComponent(new URLSearchParams(location.search).get("q")))</script></body></html>`,
      );
    });
    servers.push(server);
    await addOperation({
      site: "p1",
      op: "search",
      trigger: { url: `${base}/s?q={q}` },
      examples: [{ q: "hello" }, { q: "world" }],
      response: { extract: "results", pick: ["q", "price"] },
    });
    v2 = true;
    const r = await call("p1", "search", { q: "cats" }, fast);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.class, "drift");
    assert.match(r.reason ?? "", /picked field price disappeared/);
    assert.match(loadSite("p1")!.site.operations[0]!.request.url, /[?&]q=/, "the candidate was not saved");
  });

  test("a failed heal marks the op stale, so the next call skips the browser", async () => {
    const { server, base } = await search();
    servers.push(server);
    version = "v2";
    await addOperation({
      site: "s3",
      op: "search",
      trigger: { url: `${base}/s?q={q}&page={page}` },
      examples: [
        { q: "hello", page: "100" },
        { q: "world", page: "200" },
      ],
      response: { extract: "results" },
    });
    version = "v3"; // the page no longer fires the request: nothing can heal
    const loads = pageLoads;
    const failed = await call("s3", "search", { q: "cats", page: "3" }, fast);
    assert.equal(failed.ok, false);
    assert.match(failed.reason ?? "", /heal failed/);
    assert.ok(staleMark("s3", "search"), "a failed heal leaves a stale mark");
    const between = pageLoads;
    const again = await call("s3", "search", { q: "cats", page: "4" }, fast);
    assert.equal(again.ok, false);
    assert.match(again.reason ?? "", /stale/);
    assert.ok(between > loads);
    assert.equal(pageLoads, between, "no browser run while stale (the trigger never answered either)");
  });

  test("a tier-3 op's heal candidate is validated by replaying it, not by rerunning the site's trigger", async () => {
    const QID = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7H";
    const DECOY = "Qq1Rr2Ss3Tt4Uu5Vv6Ww7X";
    const apiPaths: string[] = [];
    let n = 0;
    const { server, base } = await serve((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (u.pathname.startsWith("/api/")) {
        apiPaths.push(u.pathname);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(n++ === 0 ? { hiccup: true } : { user: { name: "bob" } }));
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><script>var unrelated={id:"${DECOY}",operationName:"User"};
fetch("/api/"+"${QID.slice(0, 11)}"+"${QID.slice(11)}"+"/User?name="+location.pathname.split("/")[2]);</script></body></html>`);
    });
    servers.push(server);
    saveSite(
      parseSite({
        name: "m",
        baseUrl: base,
        operations: [
          {
            name: "user",
            readOnly: true,
            minTier: 3,
            request: { method: "GET", url: `${base}/api/${QID}/User?name=alice`, headers: {} },
            slots: [{ param: "name", at: ["query:name"] }],
            volatile: [{ at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "User" }],
            trigger: { url: `${base}/u/{name}` },
            match: { method: "GET", path: "/api/*/User" },
            params: [{ name: "name" }],
            response: { extract: "user" },
          },
        ],
      }),
    );
    await call("m", "user", { name: "bob" }, fast);
    assert.ok(apiPaths.includes(`/api/${DECOY}/User`), `the candidate itself was sent: ${JSON.stringify(apiPaths)}`);
  });

  test("a trigger page that answers 500 learned nothing about the op: the heal stops, and nothing is stale", async () => {
    const { server, base } = await serve((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (u.pathname.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end("{}"); // the data is gone
      }
      // the page redirects to where it fails; the final address keeps a #fragment the request never carries
      if (u.pathname === "/page") return void res.writeHead(302, { location: "/down#retry" }).end();
      res.writeHead(500, { "content-type": "text/html" });
      res.end("<html><body>Internal Server Error</body></html>");
    });
    servers.push(server);
    saveSite(
      parseSite({
        name: "down",
        baseUrl: base,
        operations: [
          {
            name: "get",
            readOnly: true,
            request: { method: "GET", url: `${base}/api/thing?q=abc`, headers: {} },
            slots: [{ param: "q", at: ["query:q"] }],
            trigger: { url: `${base}/page?q={q}` },
            match: { method: "GET", path: "/api/thing" },
            params: [{ name: "q", example: "abc" }],
            response: { extract: "items" },
          },
        ],
      }),
    );
    const r = await call("down", "get", { q: "xyz" }, fast);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /heal stopped: the trigger page answered HTTP 500/);
    assert.equal(staleMark("down", "get"), undefined);
  });

  test("a candidate whose replay gets no answer still returns the site's own answer for these args, and nothing is stale", async () => {
    const { server, base } = await serve((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (u.pathname === "/api/old") return void res.writeHead(404).end();
      if (u.pathname === "/api/new") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ data: [{ q: u.searchParams.get("q") }] }));
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<script>fetch("/api/new?q="+new URLSearchParams(location.search).get("q"))</script>');
    });
    servers.push(server);
    saveSite(
      parseSite({
        name: "reset",
        baseUrl: base,
        operations: [
          {
            name: "op",
            readOnly: true,
            request: { method: "GET", url: `${base}/api/old?q=alice`, headers: {} },
            slots: [{ param: "q", at: ["query:q"] }],
            params: [{ name: "q", example: "alice" }],
            match: { method: "GET", path: "/api/*" },
            trigger: { url: `${base}/page?q={q}` },
            response: { extract: "data" },
          },
        ],
      }),
    );
    // the candidate's replay from Node meets a reset; the page's own request answered
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/new") throw new TypeError("fetch failed: connection reset");
      return fetch(input, init);
    }) as typeof fetch;
    const r = await call("reset", "op", { q: "bob" }, { ...fast, fetchImpl });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.data, [{ q: "bob" }]);
    assert.match(r.reason ?? "", /answered by the site's own request/);
    assert.equal(staleMark("reset", "op"), undefined);
  });

  test("call() never throws when the heal's browser run fails", async () => {
    saveSite(
      parseSite({
        name: "d",
        baseUrl: "http://127.0.0.1:9",
        operations: [
          {
            name: "get",
            readOnly: true,
            request: { method: "GET", url: "http://api.d.test/v1/thing?q=abc", headers: {} },
            slots: [{ param: "q", at: ["query:q"] }],
            trigger: { url: "http://127.0.0.1:9/page?q={q}" },
            params: [{ name: "q" }],
          },
        ],
      }),
    );
    const fetchImpl = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const r = await call("d", "get", { q: "abc" }, { ...fast, fetchImpl });
    assert.equal(r.ok, false);
    // the trigger page never loaded: nothing was learned about the op, so it is not stale
    assert.equal(r.class, "error");
    assert.match(r.reason ?? "", /heal stopped: the browser run failed/);
    assert.equal(staleMark("d", "get"), undefined);
  });

  // The trigger page is a bot challenge that never solves (about 15 s per run while it waits).
  const challenged = async (name: string, over: Record<string, unknown> = {}) => {
    const fx = await startFixture();
    fixtures.push(fx);
    saveSite(
      parseSite({
        name,
        baseUrl: fx.url,
        operations: [
          {
            name: "get",
            readOnly: true,
            request: { method: "GET", url: `${fx.url}/api/scoped?q=abc`, headers: {} },
            slots: [{ param: "q", at: ["query:q"] }],
            trigger: { url: `${fx.url}/challenged?q={q}` },
            match: { method: "GET", path: "/api/scoped" },
            params: [{ name: "q", example: "abc" }],
            response: { extract: "data.items" }, // gone from the answer: drift
            ...over,
          },
        ],
      }),
    );
  };
  const walled = (r: Awaited<ReturnType<typeof call>>) => {
    assert.equal(r.class, "blocked", JSON.stringify(r));
    assert.match(r.reason ?? "", /bot challenge \(Cloudflare challenge page \(HTTP 403\)\)/);
    assert.match(r.next ?? "", /clear the challenge/);
    assert.deepEqual([r.nextCall?.action, r.nextCall?.mode, r.retry], ["login", "window", "after_fix"]);
  };

  test("a recapture that meets a challenge that never solves is blocked: the heal stops, and nothing is stale", async () => {
    await challenged("cha");
    const r = await call("cha", "get", { q: "xyz" }, fast);
    walled(r);
    assert.match(r.reason ?? "", /heal stopped/);
    assert.equal(staleMark("cha", "get"), undefined);
  });

  test("a bare 403 at every tier says the site refuses this machine; the site is then left alone for a while", async () => {
    const fx = await startFixture();
    fixtures.push(fx);
    saveSite(
      parseSite({
        name: "refusing",
        baseUrl: fx.url,
        operations: [
          {
            name: "get",
            readOnly: true,
            request: { method: "GET", url: `${fx.url}/api/shut-out?q=abc`, headers: {} },
            slots: [{ param: "q", at: ["query:q"] }],
            trigger: { url: `${fx.url}/shut-out?q={q}` },
            match: { method: "GET", path: "/api/shut-out" },
            params: [{ name: "q", example: "abc" }],
            response: { extract: "items" },
          },
        ],
      }),
    );
    const refused = () => fx.calls.filter((c) => c.path.startsWith("/api/shut-out")).length;
    const r = await call("refusing", "get", { q: "xyz" }, fast);
    assert.deepEqual([r.class, r.tier], ["blocked", 3], JSON.stringify(r));
    assert.match(r.next ?? "", /refuses requests from this machine or network/);
    assert.match(r.next ?? "", /api-anything login refusing --window/);
    assert.doesNotMatch(r.next ?? "", /challenging/);
    assert.deepEqual([r.nextCall?.action, r.nextCall?.mode], ["login", "window"]);
    const sent = refused();
    assert.ok(sent >= 3, `every tier was tried (${sent} requests)`);

    const again = await call("refusing", "get", { q: "xyz" }, fast);
    assert.equal(refused(), sent, "nothing sent, and no browser run, while the site cools down");
    assert.equal(again.class, "blocked");
    assert.ok(again.retryAfterMs! > 9 * 60_000, String(again.retryAfterMs));
    assert.match(again.next ?? "", /login refusing --window \(a login ends the wait\)/);
    assert.ok(again.ms < 1000, `answered at once (${again.ms} ms)`);
  });

  test("a tier-3 run that meets a challenge that never solves is blocked, and a stale op keeps its tier-3 try", async () => {
    await challenged("chb", { minTier: 3, response: { extract: "data.results" } });
    walled(await call("chb", "get", { q: "xyz" }, fast));
    assert.equal(staleMark("chb", "get"), undefined);

    await challenged("chc");
    markStale("chc", "get", "heal failed earlier");
    const r = await call("chc", "get", { q: "xyz" }, fast);
    assert.equal(r.ok, false);
    assert.notEqual(staleMark("chc", "get")?.tier3, false, "a challenge is no proof the trigger does not answer");
  });
});
