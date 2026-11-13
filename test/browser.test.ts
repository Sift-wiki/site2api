import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  browserAvailable,
  closeBrowser,
  headlessUserAgent,
  pageFetch,
  runTrigger,
  waitReport,
} from "../src/browser.js";
import { learnGuard } from "../src/heal.js";
import { type Fixture, PUBLIC_BEARER, startFixture } from "./fixture/server.js";

// the browser keeps what it learned about the installed Chrome under the home: not the user's own
const HOME = mkdtempSync(join(tmpdir(), "api-anything-browser-"));
process.env.API_ANYTHING_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

describe("fixture site (plain http)", () => {
  let fx: Fixture;
  before(async () => (fx = await startFixture()));
  after(() => fx.close());

  test("stale queryId and old bundle 404 after rotate", async () => {
    const { userQueryId, build } = fx.state;
    fx.rotate();
    assert.notEqual(fx.state.userQueryId, userQueryId);
    assert.match(fx.state.userQueryId, /^[\w-]{22}$/);
    const stale = await fetch(`${fx.url}/api/graphql/${userQueryId}/UserByName?variables=%7B%7D`);
    assert.equal(stale.status, 404);
    assert.equal(await stale.text(), "");
    assert.equal((await fetch(`${fx.url}/static/app.${build}.js`)).status, 404);
    const js = await (await fetch(`${fx.url}/static/app.${fx.state.build}.js`)).text();
    assert.ok(js.includes(`{queryId:"${fx.state.userQueryId}",operationName:"UserByName"`));
  });

  test("login wall, rate limit, html list", async () => {
    const wall = await fetch(`${fx.url}/private`);
    assert.equal(wall.status, 200);
    assert.match(wall.headers.get("content-type") ?? "", /html/);
    const ok = await fetch(`${fx.url}/private`, { headers: { cookie: "session=abc" } });
    assert.deepEqual(await ok.json(), { data: { secret: "only for you" } });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(`${fx.url}/api/limited`)).status);
    assert.deepEqual(codes, [200, 200, 429]);
    assert.match(
      await (await fetch(`${fx.url}/list`)).text(),
      /<li class="user"><a class="name" href="\/u\/alice">alice<\/a>/,
    );
  });
});

describe("browser", { skip: !browserAvailable() && "no Chromium browser installed" }, () => {
  let fx: Fixture;
  let profileDir: string;
  before(async () => {
    fx = await startFixture();
    profileDir = await mkdtemp(join(tmpdir(), "api-anything-profile-"));
  });
  after(async () => {
    await closeBrowser();
    await fx.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  let gqlUrl = "";
  let csrf = "";

  test("runTrigger captures the GraphQL read with wire headers and bodies", async () => {
    const r = await runTrigger({ url: `${fx.url}/u/alice`, profileDir });
    const gql = r.exchanges.find((e) => e.request.url.includes("/UserByName?"));
    assert.ok(gql, "UserByName exchange captured");
    const ct0 = r.cookies.find((c) => c.name === "ct0");
    assert.ok(ct0);
    assert.equal(gql.request.headers["x-csrf-token"], ct0.value);
    assert.match(gql.request.headers.cookie ?? "", /ct0=/);
    assert.equal(gql.request.headers["x-app-version"], "2026.09.27-a1b2c3");
    assert.equal(gql.request.headers["sec-fetch-site"], "same-origin");
    assert.doesNotMatch(gql.request.headers["user-agent"] ?? "", /HeadlessChrome/);
    assert.doesNotMatch(gql.request.headers["sec-ch-ua"] ?? "", /Headless/);
    assert.equal(gql.response?.status, 200);
    assert.equal(JSON.parse(gql.response?.body ?? "").data.user.name, "alice");

    const doc = r.exchanges.find((e) => e.resourceType === "document");
    assert.match(doc?.response?.body ?? "", new RegExp(`/static/app\\.${fx.state.build}\\.js`));
    assert.equal(r.finalUrl, `${fx.url}/u/alice`);
    gqlUrl = gql.request.url;
    csrf = ct0.value;
  });

  test("softFrom reaches the target by an in-page navigation", async () => {
    const r = await runTrigger({ url: `${fx.url}/u/bob`, softFrom: `${fx.url}/`, profileDir });
    const gql = r.exchanges.find((e) => e.request.url.includes("/UserByName?"));
    assert.match(decodeURIComponent(gql?.request.url ?? ""), /"name":"bob"/);
    assert.equal(r.finalUrl, `${fx.url}/u/bob`);
  });

  test("softFrom on a client-routed SPA stays in the app: through its own link, or history + popstate", async () => {
    for (const name of ["bob", "dave"]) {
      // bob has a link the app rendered; dave has none, so only the history API can route there
      const r = await runTrigger({ url: `${fx.url}/spa/${name}`, softFrom: `${fx.url}/spa/alice`, profileDir });
      assert.equal(r.exchanges.filter((e) => e.resourceType === "document").length, 1, `${name}: no second page load`);
      assert.ok(
        r.exchanges.some((e) => e.request.url.endsWith(`/api/spa/user?name=${name}`)),
        `${name}: the route's XHR fired`,
      );
      assert.equal(r.finalUrl, `${fx.url}/spa/${name}`);
    }
  });

  test("write interception covers service workers and GETs sent by a UI action", async () => {
    const hits = () => fx.calls.filter((c) => c.path === "/api/sw-write" || c.path.startsWith("/api/follow")).length;
    const guard = (e: { request: { method: string }; resourceType: string }, acting: boolean) =>
      e.request.method !== "GET" || (acting && ["xhr", "fetch"].includes(e.resourceType));
    // A worker installed on an earlier visit would proxy fetches past page routing; api-anything blocks workers.
    await runTrigger({ url: `${fx.url}/sw`, profileDir, intercept: guard });
    const sw = await runTrigger({ url: `${fx.url}/sw`, profileDir, intercept: guard });
    const follow = await runTrigger({
      url: `${fx.url}/follow/alice`,
      steps: [{ action: "click", selector: "#follow" }],
      profileDir,
      intercept: guard,
    });
    assert.equal(hits(), 0, "no write reached the server");
    assert.ok(sw.exchanges.some((e) => e.request.url.endsWith("/api/sw-write") && e.aborted));
    assert.ok(follow.exchanges.some((e) => e.request.url.endsWith("/api/follow?user=alice") && e.aborted));
  });

  test("intercept aborts the write before it reaches the server", async () => {
    const r = await runTrigger({
      url: `${fx.url}/compose`,
      profileDir,
      steps: [
        { action: "fill", selector: "#text", value: "hello world" },
        { action: "click", selector: "#post" },
      ],
      intercept: (e) => e.request.method === "POST" && e.request.url.includes("/CreatePost"),
    });
    const w = r.exchanges.find((e) => e.request.url.includes("/CreatePost"));
    assert.ok(w);
    assert.equal(w.aborted, true);
    assert.equal(w.response, undefined);
    assert.deepEqual(JSON.parse(w.request.body ?? "").variables, { text: "hello world" });
    assert.equal(fx.calls.filter((c) => c.path.includes("CreatePost")).length, 0);
  });

  /** The rejections nothing handled while `run` ran, and a moment after: a closed page rejects what was left pending. */
  const unhandledDuring = async (run: () => Promise<void>) => {
    const seen: unknown[] = [];
    const on = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", on);
    try {
      await run();
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      process.off("unhandledRejection", on);
    }
    return seen.map(String);
  };

  test("a trigger step does not outlast the run's budget, and one given up on raises nothing when its page closes", async () => {
    await runTrigger({ url: `${fx.url}/u/alice`, profileDir }); // the browser's start is not the run's
    const unhandled = await unhandledDuring(async () => {
      const t0 = Date.now();
      const r = await runTrigger({
        url: `${fx.url}/u/alice`,
        profileDir,
        timeoutMs: 1500,
        steps: [
          { action: "wait", ms: 10_000 },
          { action: "wait", ms: 10_000 },
        ],
      });
      const ms = Date.now() - t0;
      assert.ok(ms < 8000, `the run took ${ms} ms on a budget of 1500`);
      assert.equal(r.wait?.ended, "deadline");
      // the run says where it stopped: the first wait did not finish, and the second never started
      assert.equal(r.cut, 0);
      assert.match(waitReport(r), /^the time ran out on /);
      assert.ok(
        r.exchanges.some((e) => e.request.url.includes("/UserByName?")),
        "what the page sent is still returned",
      );
    });
    assert.deepEqual(unhandled, []);
  });

  test("a request the guard cannot judge (a body nested too deep to walk) does not leave, and the run ends", async () => {
    const posts: number[] = [];
    const server = createServer((req, res) => {
      if (req.method === "POST") {
        let n = 0;
        req.on("data", (d: Buffer) => (n += d.length));
        req.on("end", () => posts.push(n));
        return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
      // a read by GraphQL's rules (a query with its document), with `depth` arrays beside it
      const body = `'{"query":"{ viewer { id } }","v":' + '['.repeat(n) + ']'.repeat(n) + '}'`;
      const send = `const n = Number(new URLSearchParams(location.search).get('depth')); fetch('/api/deep', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${body} })`;
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(`<button id="go">go</button><script>document.getElementById('go').onclick = () => { ${send} }</script>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const run = (depth: number) =>
      runTrigger({
        url: `${base}/page?depth=${depth}`,
        profileDir,
        timeoutMs: 5000,
        steps: [{ action: "click", selector: "#go" }],
        intercept: learnGuard(),
      });
    try {
      const unhandled = await unhandledDuring(async () => {
        const shallow = await run(50);
        assert.equal(posts.length, 1, "a query that can be read leaves");
        assert.equal(shallow.exchanges.find((e) => e.request.method === "POST")?.aborted, undefined);

        const deep = await run(20_000);
        const post = deep.exchanges.find((e) => e.request.method === "POST");
        assert.ok((post?.request.body?.length ?? 0) > 40_000, "the guard was given the body");
        assert.equal(post?.aborted, true);
        assert.equal(posts.length, 1, "the request the guard could not judge reached the server");
      });
      assert.deepEqual(unhandled, []);
    } finally {
      server.close();
    }
  });

  test("layered form encoding and per-request signatures come through", async () => {
    const s = await runTrigger({ url: `${fx.url}/search?q=pizza`, profileDir });
    const rpc = s.exchanges.find((e) => e.request.url.includes("/api/rpc"));
    assert.equal(rpc?.resourceType, "xhr");
    assert.match(decodeURIComponent(rpc?.request.body ?? ""), /pizza/);
    assert.ok(rpc?.response?.body?.startsWith(")]}'"));

    fx.setRequireSignature(true);
    const f = await runTrigger({ url: `${fx.url}/feed`, profileDir });
    const feed = f.exchanges.find((e) => e.request.url.endsWith("/api/signed/feed"));
    assert.equal(feed?.response?.status, 200);
    const replay = await pageFetch({
      origin: fx.url,
      url: feed!.request.url,
      method: "GET",
      headers: { "x-sig": feed!.request.headers["x-sig"] },
      profileDir,
    });
    assert.equal(replay.status, 403, "a reused signature is rejected");
    fx.setRequireSignature(false);
  });

  test("pageFetch runs fetch() on the site origin with the profile's cookies", async () => {
    const r = await pageFetch({
      origin: fx.url,
      url: gqlUrl,
      method: "GET",
      headers: { "x-csrf-token": csrf, authorization: PUBLIC_BEARER },
      profileDir,
    });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).data.user.name, "alice");
    assert.match(r.headers["content-type"], /json/);
    assert.equal(typeof r.ms, "number");
    const call = fx.calls.at(-1);
    assert.doesNotMatch(String(call?.headers["user-agent"]), /HeadlessChrome/);
  });

  test("the headless user agent is asked of the browser once per installed browser, then read from disk", async () => {
    const file = join(HOME, "chrome-ua.json");
    rmSync(file, { force: true });
    // nothing on disk: Chrome is started to ask, and the answer is kept
    const probed = await headlessUserAgent();
    assert.match(probed, /Chrome\/\d/);
    assert.doesNotMatch(probed, /Headless/);
    const kept = JSON.parse(readFileSync(file, "utf8")) as { key: string; ua: string };
    assert.equal(kept.ua, probed);
    // what is on disk answers next: a marked copy comes back, which no Chrome would have said
    writeFileSync(file, JSON.stringify({ ...kept, ua: `${probed} marked` }));
    assert.equal(await headlessUserAgent(), `${probed} marked`);
    // one that names another Chrome (an update changes the binary) is not believed, and is replaced
    writeFileSync(file, JSON.stringify({ key: `${kept.key}0`, ua: `${probed} marked` }));
    assert.equal(await headlessUserAgent(), probed);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), kept);
    // nor is one that cannot be read, or that does not hold a user agent
    for (const junk of ["{not json", JSON.stringify({ key: kept.key, ua: "HeadlessChrome/1" })]) {
      writeFileSync(file, junk);
      assert.equal(await headlessUserAgent(), probed, junk);
    }
  });
});
