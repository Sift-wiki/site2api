/**
 * End to end against the offline fixture site, in a temp API_ANYTHING_HOME, through the public
 * entry points: addOperation (what `api-anything add` runs), call, the CLI, and the MCP server.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Page } from "playwright-core";
import { browserAvailable, closeBrowser, openBrowser, runTrigger } from "../src/browser.js";
import { call, heal } from "../src/execute.js";
import { addOperation, capturePage, profileDir } from "../src/heal.js";
import { importSession, windowLogin } from "../src/login.js";
import { loadSession, saveSession } from "../src/session.js";
import { clearCoolDown, rememberedTier, staleMark } from "../src/store.js";
import { makeChromiumDb } from "./fixture/cookie-db.js";
import { type Fixture, PUBLIC_BEARER, startFixture } from "./fixture/server.js";

const HOME = mkdtempSync(join(tmpdir(), "api-anything-e2e-"));
process.env.API_ANYTHING_HOME = HOME;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli.ts");
const SITE = "fixture";
const fast = { minIntervalMs: 0 };

const heals = (): { op: string; strategy: string }[] => {
  try {
    return readFileSync(join(HOME, "heals.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const specFile = () => join(HOME, "sites", `${SITE}.json`);

function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // async on purpose: the fixture server lives in this process and must keep answering
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      { cwd: ROOT, env: { ...process.env, API_ANYTHING_HOME: HOME } },
      (err, stdout, stderr) => resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
    ),
  );
}

describe("e2e", { skip: !browserAvailable() && "no Chromium browser installed" }, () => {
  let fx: Fixture;
  before(async () => (fx = await startFixture()));
  after(async () => {
    await closeBrowser();
    await fx.close();
    rmSync(HOME, { recursive: true, force: true });
  });

  test("1. add getUser from /u/{name} with two examples; call it for a new name at tier 1", async () => {
    const r = await addOperation({
      site: SITE,
      op: "getUser",
      trigger: { url: `${fx.url}/u/{name}` },
      examples: [{ name: "alice" }, { name: "bob" }],
      response: { extract: "data.user", pick: ["name", "followers", "posts[0].text"] },
    });
    assert.equal(r.operation.minTier, 1, r.warnings.join("\n"));
    assert.deepEqual(r.operation.match, { method: "GET", host: "127.0.0.1", path: "/api/graphql/*/UserByName" });
    assert.deepEqual(
      r.operation.volatile.map((v) => v.anchor),
      ["UserByName"],
    );

    const res = await call(SITE, "getUser", { name: "carol" }, fast);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.tier, 1);
    assert.deepEqual(res.data, { name: "carol", followers: 500, "posts[0].text": "hello from carol" });

    const ct0 = loadSession(SITE).cookies.find((c) => c.name === "ct0");
    assert.ok(ct0, "the jar holds the CSRF cookie");
    assert.ok(!readFileSync(specFile(), "utf8").includes(ct0.value), "the spec never holds a credential");
  });

  test("2. after rotate() the call heals by rescan (no browser) and logs it", async () => {
    fx.rotate();
    const res = await call(SITE, "getUser", { name: "dave" }, fast);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.healed, true);
    assert.equal(res.tier, 1);
    assert.deepEqual(
      heals().map((h) => [h.op, h.strategy]),
      [["getUser", "rescan"]],
    );
    assert.ok(readFileSync(specFile(), "utf8").includes(fx.state.userQueryId));
  });

  test("2b. a handle that doesn't exist is input (the example still answers): no heal, no browser", async () => {
    const before = heals().length;
    const res = await call(SITE, "getUser", { name: "nobody_zz" }, fast);
    assert.equal(res.class, "input", JSON.stringify(res));
    assert.match(res.next ?? "", /do not heal/);
    assert.equal(heals().length, before);
  });

  test("3. heal-loop guard, then a heal by recapture when rescan cannot work", async () => {
    await addOperation({
      site: SITE,
      op: "getUser2",
      trigger: { url: `${fx.url}/u/{name}` },
      examples: [{ name: "alice" }, { name: "bob" }],
    });
    const spec = JSON.parse(readFileSync(specFile(), "utf8"));
    for (const v of spec.operations.find((o: { name: string }) => o.name === "getUser2").volatile)
      v.anchor = "NoSuchAnchor";
    writeFileSync(specFile(), JSON.stringify(spec));
    fx.rotate();

    // getUser healed minutes ago: drifting again marks it stale instead of re-healing; the read still answers via the trigger.
    const guarded = await call(SITE, "getUser", { name: "erin" }, fast);
    assert.equal(guarded.ok, true, JSON.stringify(guarded));
    assert.equal(guarded.tier, 3);
    assert.equal(guarded.healed, undefined);
    assert.ok(staleMark(SITE, "getUser"));
    assert.equal(heals().length, 1);

    const res = await call(SITE, "getUser2", { name: "frank" }, fast);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.healed, true);
    assert.deepEqual(heals().at(-1), { ...heals().at(-1), op: "getUser2", strategy: "recapture" });
    const again = await call(SITE, "getUser2", { name: "grace" }, fast);
    assert.equal(again.tier, 1, "the healed template replays at tier 1");
  });

  test("4. a write is learned without being performed and runs only with allowWrites, exactly once", async () => {
    const writes = () => fx.calls.filter((c) => c.path.includes("/CreatePost")).length;
    const r = await addOperation({
      site: SITE,
      op: "createPost",
      trigger: {
        url: `${fx.url}/compose`,
        steps: [
          { action: "fill", selector: "#text", value: "{text}" },
          { action: "click", selector: "#post" },
        ],
      },
      examples: [{ text: "first draft here" }, { text: "second draft here" }],
      write: true,
    });
    assert.equal(r.operation.readOnly, false);
    assert.equal(writes(), 0, "learning sent no write");

    const refused = await call(SITE, "createPost", { text: "not allowed" }, fast);
    assert.equal(refused.class, "refused");
    assert.equal(writes(), 0);

    const res = await call(SITE, "createPost", { text: "hello from api-anything" }, { ...fast, allowWrites: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(writes(), 1);
    assert.match(JSON.stringify(res.data), /hello from api-anything/);
  });

  test("5. a per-request signature pins the op to tier 3, which answers through the trigger", async () => {
    fx.setRequireSignature(true);
    const r = await addOperation({
      site: SITE,
      op: "feed",
      trigger: { url: `${fx.url}/feed` },
      examples: [{}],
      match: { path: "/api/signed/feed" },
    });
    assert.equal(r.operation.minTier, 3, r.warnings.join("\n"));
    const res = await call(SITE, "feed", {}, fast);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.tier, 3);
    assert.equal(
      rememberedTier(SITE, "feed"),
      undefined,
      "the spec's own minTier is not remembered, so editing it takes effect",
    );
    assert.deepEqual(res.data, [
      { id: "f1", text: "first" },
      { id: "f2", text: "second" },
    ]);
  });

  test("6. a login wall served as 200 HTML is auth, with a login hint", async () => {
    await runTrigger({ url: `${fx.url}/login`, profileDir: profileDir() }); // stands in for `api-anything login`
    await addOperation({
      site: SITE,
      op: "secret",
      trigger: { url: `${fx.url}/private` },
      examples: [{}],
      match: { path: "/private" },
    });
    assert.deepEqual((await call(SITE, "secret", {}, fast)).data, { data: { secret: "only for you" } });

    // log out everywhere: the profile and the jar
    await (await openBrowser({ profileDir: profileDir() })).clearCookies();
    saveSession(SITE, { cookies: [], values: {} });
    const res = await call(SITE, "secret", {}, fast);
    assert.equal(res.ok, false);
    assert.equal(res.class, "auth", JSON.stringify(res));
    assert.match(res.next ?? "", /api-anything login fixture/);
  });

  test("7. a rate limit is reported as rate, with no heal and no retry (via the CLI)", async () => {
    await addOperation({
      site: SITE,
      op: "limited",
      trigger: { url: `${fx.url}/api/limited` },
      examples: [{}],
      match: { path: "/api/limited" },
    });
    const hits = () => fx.calls.filter((c) => c.path === "/api/limited").length;
    const before = hits();
    const healCount = heals().length;
    const r = await cli("call", SITE, "limited");
    assert.equal(r.code, 1);
    const res = JSON.parse(r.stdout);
    assert.equal(res.class, "rate");
    assert.match(r.stderr, /^next: rate limited/m);
    assert.equal(hits(), before + 1);
    assert.equal(heals().length, healCount);
    // the site said stop: the next call sends nothing, and --force does
    const held = await cli("call", SITE, "limited");
    assert.match(JSON.parse(held.stdout).reason, /^not sent: fixture answered rate/);
    assert.equal(hits(), before + 1);
    await cli("call", SITE, "limited", "--force");
    assert.equal(hits(), before + 2);
    clearCoolDown(SITE); // the rest of this file calls the same site
  });

  test("8. layered f.req form encoding with the XSSI prefix works for a new query", async () => {
    const r = await addOperation({
      site: SITE,
      op: "search",
      trigger: { url: `${fx.url}/search?q={q}` },
      examples: [{ q: "kittens" }, { q: "puppies" }],
    });
    assert.ok(
      r.operation.slots.some((s) => s.param === "q" && s.at[0] === "form:f.req" && s.at.length === 3),
      JSON.stringify(r.operation.slots),
    );
    assert.equal(r.operation.response.xssiPrefix, ")]}'");
    const res = await call(SITE, "search", { q: 'red "pandas" & co' }, fast);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(r.operation.response.extract, "[0][2][0]", "the suggestion steps into the JSON-encoded payload");
    assert.deepEqual((res.data as string[][])[0], [
      'red "pandas" & co result 1',
      "https://example.test/red%20%22pandas%22%20%26%20co/1",
    ]);
  });

  test("9. the html recipe on a server-rendered list returns picked items", async () => {
    const added = await addOperation({
      site: SITE,
      op: "listUsers",
      trigger: { url: `${fx.url}/list` },
      examples: [{}],
      match: { path: "/list" },
      response: {
        html: { items: "li.user", fields: { name: "a.name", followers: "span.followers", href: "a.name@href" } },
        pick: ["name", "href"],
      },
    });
    assert.ok(
      !added.warnings.some((w) => /response is HTML/.test(w)),
      "no 'set response.html' warning when --html was given",
    );
    assert.deepEqual(added.preview, { count: 3, first: { name: "alice", href: `${fx.url}/u/alice` } });
    assert.equal(added.captures.length, 2, "both trigger runs are saved as captures");
    const res = await call(SITE, "listUsers", {}, fast);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.data, [
      { name: "alice", href: `${fx.url}/u/alice` },
      { name: "bob", href: `${fx.url}/u/bob` },
      { name: "carol", href: `${fx.url}/u/carol` },
    ]);
  });

  test("10. the MCP server lists its meta-tools, calls reads, and hides and refuses writes", async () => {
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", CLI, "mcp"],
        cwd: ROOT,
        env: { ...process.env, API_ANYTHING_HOME: HOME } as Record<string, string>,
      }),
    );
    try {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
        "call_batch",
        "call_operation",
        "find_sites",
        "get_job",
        "get_result",
        "learn_site",
        "list_operations",
        "list_sites",
        "login",
        "site_status",
      ]);
      assert.equal(tools.tools.find((t) => t.name === "call_operation")?.annotations?.readOnlyHint, true);
      // the agent is told which sites it can call before it picks web search
      assert.match(client.getInstructions() ?? "", new RegExp(`\\b${SITE}\\b`));

      const text = (r: Awaited<ReturnType<typeof client.callTool>>) =>
        JSON.parse((r.content as { text: string }[])[0]!.text);
      const ops = text(await client.callTool({ name: "list_operations", arguments: { site: SITE } }));
      assert.ok(ops.operations.some((o: { name: string }) => o.name === "search"));
      assert.ok(!ops.operations.some((o: { name: string }) => o.name === "createPost"), "writes are hidden");

      const ok = await client.callTool({
        name: "call_operation",
        arguments: { site: SITE, op: "search", args: { q: "otters" } },
      });
      assert.ok(!ok.isError, JSON.stringify(ok));
      assert.ok(JSON.stringify(text(ok).data).includes("otters result 1"));

      const refused = await client.callTool({
        name: "call_operation",
        arguments: { site: SITE, op: "createPost", args: { text: "nope" } },
      });
      assert.equal(refused.isError, true);
      assert.equal(text(refused).class, "refused");

      const batch = await client.callTool({
        name: "call_batch",
        arguments: {
          items: [
            { id: "read", site: SITE, op: "search", args: { q: "otters" } },
            { id: "write", site: SITE, op: "createPost", args: { text: "nope" } },
          ],
        },
      });
      assert.equal(batch.isError, true);
      assert.deepEqual(
        text(batch).results.map((r: { id: string; class: string }) => [r.id, r.class]),
        [
          ["read", "ok"],
          ["write", "input"],
        ],
      );
      assert.equal(text(batch).results[1].reason, "writes are not batched");
    } finally {
      await client.close();
    }
  });

  test("11. a missing session value (clean home) is auth; one trigger run refreshes it, then tier 1 works", async () => {
    await addOperation({
      site: SITE,
      op: "getUser3",
      trigger: { url: `${fx.url}/u/{name}` },
      examples: [{ name: "alice" }, { name: "bob" }],
      response: { extract: "data.user.name" },
    });
    const s = loadSession(SITE);
    saveSession(SITE, { ...s, values: {} }); // as from a bundled spec on a fresh machine
    const r = await call(SITE, "getUser3", { name: "heidi" }, fast);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tier, 3);
    assert.match(r.reason ?? "", /refreshed the session/);
    assert.equal(loadSession(SITE).values["getUser3/authorization"], PUBLIC_BEARER);
    const again = await call(SITE, "getUser3", { name: "ivan" }, fast);
    assert.equal(again.tier, 1, JSON.stringify(again));
  });

  test("12. --public keeps a public bearer literal: works with no session values, and export allows it", async () => {
    await addOperation({
      site: SITE,
      op: "getUserPublic",
      trigger: { url: `${fx.url}/u/{name}` },
      examples: [{ name: "alice" }, { name: "bob" }],
      public: ["authorization"],
      response: { extract: "data.user.name" },
    });
    saveSession(SITE, { ...loadSession(SITE), values: {} });
    const r = await call(SITE, "getUserPublic", { name: "judy" }, { ...fast, maxTier: 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data, "judy");
    saveSession(SITE, { ...loadSession(SITE), values: { authorization: PUBLIC_BEARER } }); // the export scan sees it live
    const out = await cli("export", SITE, "--keep-examples");
    const spec = JSON.parse(out.stdout);
    const op = spec.operations.find((o: { name: string }) => o.name === "getUserPublic");
    assert.equal(op.request.headers.authorization, PUBLIC_BEARER);
    assert.equal(op.params[0].example, "alice");
  });

  test("13. a write sent as a GET by a button is learned without being sent; --from a non-write capture is refused", async () => {
    const follows = () => fx.calls.filter((c) => c.path.startsWith("/api/follow")).length;
    const r = await addOperation({
      site: SITE,
      op: "follow",
      trigger: { url: `${fx.url}/follow/{user}`, steps: [{ action: "click", selector: "#follow" }] },
      examples: [{ user: "alice" }, { user: "carol" }],
      write: true,
    });
    assert.equal(r.operation.request.method, "GET");
    assert.equal(follows(), 0, "learning sent no write");
    const cap = await capturePage({ url: `${fx.url}/list` });
    await assert.rejects(
      addOperation({ site: SITE, op: "w2", examples: [{}], write: true, from: { capture: cap } }),
      /ran without --write/,
    );
  });

  test("14. ids that differ per page load but replay fine are session-scoped: minTier stays 1", async () => {
    const r = await addOperation({
      site: SITE,
      op: "scoped",
      trigger: { url: `${fx.url}/scoped?q={q}` },
      examples: [{ q: "kittens" }, { q: "puppies" }],
      response: { extract: "data.results" },
    });
    assert.equal(r.operation.minTier, 1, r.warnings.join("\n"));
    assert.ok(r.warnings.some((w) => /session-scoped/.test(w)));
    const res = await call(SITE, "scoped", { q: "otters" }, fast);
    assert.deepEqual(res.data, ["otters one", "otters two"]);
    assert.equal(res.tier, 1);
  });

  test("15. add --from a saved run re-learns without a browser, templating step selectors", async () => {
    const cap = await capturePage({
      url: `${fx.url}/follow/alice`,
      steps: [
        { action: "click", selector: "#follow" },
        { action: "wait", selector: 'a[href="/u/alice"], #follow' },
      ],
      write: true,
    });
    const r = await addOperation({
      site: SITE,
      op: "follow2",
      examples: [{ user: "alice" }],
      write: true,
      from: { capture: cap },
    });
    assert.equal(r.operation.trigger.url, `${fx.url}/follow/{user}`);
    assert.equal(r.operation.trigger.steps?.[1]?.selector, 'a[href="/u/{user}"], #follow');
    assert.deepEqual(r.captures, []);
  });

  test("21. the page's own Idempotency-Key is made fresh per call, not replayed: a second order is a second order", async () => {
    const sent = () => fx.calls.filter((c) => c.path === "/api/checkout");
    const r = await addOperation({
      site: SITE,
      op: "order",
      trigger: {
        url: `${fx.url}/checkout/{item}`,
        steps: [
          { action: "click", selector: "#buy" },
          { action: "wait", ms: 300 },
        ],
      },
      examples: [{ item: "fridge" }, { item: "toaster" }],
      write: true,
    });
    assert.equal(sent().length, 0, "learning sent no order");
    assert.deepEqual(
      r.operation.slots.find((s) => s.at[0] === "header:idempotency-key"),
      { gen: "uuid", at: ["header:idempotency-key"] },
    );
    assert.equal(r.operation.minTier, 1);
    const w = { ...fast, allowWrites: true, maxTier: 1 as const };
    const a = await call(SITE, "order", { item: "fridge" }, w);
    const b = await call(SITE, "order", { item: "toaster" }, w);
    assert.deepEqual([a.ok, b.ok], [true, true], JSON.stringify([a, b]));
    assert.notDeepEqual((a.data as { orderId: string }).orderId, (b.data as { orderId: string }).orderId);
    const keys = sent().map((c) => c.headers["idempotency-key"]);
    assert.equal(new Set(keys).size, 2, JSON.stringify(keys));
    // the caller's key reaches the site: sent again on purpose, the site itself answers with the same order
    const k1 = await call(SITE, "order", { item: "kettle" }, { ...w, idempotencyKey: "kettle-1" });
    const k2 = await call(SITE, "order", { item: "kettle" }, { ...w, idempotencyKey: "kettle-1", again: true });
    assert.equal(sent().length, 4);
    assert.equal(sent()[2]!.headers["idempotency-key"], sent()[3]!.headers["idempotency-key"]);
    assert.deepEqual((k2.data as { orderId: string }).orderId, (k1.data as { orderId: string }).orderId);
  });

  test("16. a site that walls plain HTTP answers at tier 2, and the result says why", async () => {
    await addOperation({
      site: SITE,
      op: "walled",
      trigger: { url: `${fx.url}/walled` },
      examples: [{}],
      match: { path: "/api/walled" },
    });
    const r = await call(SITE, "walled", {}, fast);
    assert.equal(r.tier, 2, JSON.stringify(r));
    assert.match(r.reason ?? "", /tier 1 was blocked \(Cloudflare/);
    const again = await call(SITE, "walled", {}, fast);
    assert.equal(again.tier, 2);
    assert.match(again.reason ?? "", /started at tier 2/);
    assert.equal(rememberedTier(SITE, "walled"), 2);
  });

  test("18. login imports the session from the browser; a revoke + fresh cookie self-heals by re-import", async () => {
    const host = new URL(fx.url).hostname; // 127.0.0.1
    const browserRoot = mkdtempSync(join(tmpdir(), "aa-e2e-browser-"));
    const writeSession = (token: string) =>
      makeChromiumDb(join(browserRoot, "Default"), [{ host_key: host, name: "session", value: token }], {
        password: "pw",
      });
    const first = fx.mintSession();
    writeSession(first);
    process.env.API_ANYTHING_BROWSER_ROOTS = JSON.stringify([
      { name: "Chrome", family: "chromium", root: browserRoot, password: "pw" },
    ]);
    try {
      // Learn the op while the profile is signed in, so its response format is JSON not the login wall.
      await runTrigger({ url: `${fx.url}/login`, profileDir: profileDir() });
      await addOperation({
        site: SITE,
        op: "secret2",
        trigger: { url: `${fx.url}/private` },
        examples: [{}],
        match: { path: "/private" },
        response: { extract: "data" },
      });

      // login by import: browserless, no Keychain (password injected), no profile push
      const imported = await importSession(SITE, `${fx.url}/`, { pushProfile: false, confirm: async () => true });
      assert.equal(imported?.source, "chrome:Default");
      assert.equal(loadSession(SITE).source, "chrome:Default");

      let res = await call(SITE, "secret2", {}, { ...fast, maxTier: 1 });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.deepEqual(res.data, { secret: "only for you" });

      // the server logs the session out; the human re-signs in, so the browser DB now holds a fresh cookie
      fx.revoke(first);
      writeSession(fx.mintSession());
      res = await call(SITE, "secret2", {}, { ...fast, maxTier: 1 });
      assert.equal(res.ok, true, JSON.stringify(res), "self-healed by re-importing from the same profile");
    } finally {
      delete process.env.API_ANYTHING_BROWSER_ROOTS;
      rmSync(browserRoot, { recursive: true, force: true });
    }
  });

  test("20. a window sign-in counts only when a login cookie appears while it is open", async () => {
    const url = `${fx.url}/members`;
    const site = "members";
    // the session a failed window sign-in must leave as it was
    saveSession(site, { cookies: [], values: {}, source: "chrome:Default" });
    /**
     * Open the window, let the user do `act` in it as soon as it shows the site, then close it as the
     * user would. Closing Chrome's last window on Linux or Windows quits it, and a read of a quitting
     * Chrome's jar misses its session cookies (app_session has no expiry; CI's Linux run lost it). Here
     * that holds on every OS, for a read that starts once the page has closed and for one in flight
     * across the close, made sure of by a response just before it: neither may count.
     */
    const inWindow = async (act: (page: Page) => Promise<unknown> = async () => {}) => {
      const pending = windowLogin(site, url, { waitForEnter: false });
      let page: Page | undefined;
      let ctx: Awaited<ReturnType<typeof openBrowser>> | undefined;
      for (let i = 0; i < 300 && !page; i++) {
        await new Promise((r) => setTimeout(r, 100));
        ctx = await openBrowser({ profileDir: profileDir(), headless: false });
        page = ctx.pages().find((p) => p.url() === url);
      }
      assert.ok(page && ctx, "the window opened on the site");
      const shown = page;
      await act(shown);
      // from here every read of the jar answers only once the page has closed, and then empty
      let closed = false;
      let reads = 0;
      shown.once("close", () => {
        closed = true;
      });
      ctx.cookies = () => {
        reads++;
        return new Promise((resolve) => (closed ? resolve([]) : shown.once("close", () => resolve([]))));
      };
      const before = reads;
      await shown.evaluate(() => fetch("/members?late").then((r) => r.text()));
      for (let i = 0; i < 100 && reads === before; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(reads > before, "a read of the jar is in flight as the window closes");
      await shown.close({ runBeforeUnload: true }); // as a human closing it: the page may ask first
      return pending;
    };

    const nothing = await inWindow();
    assert.equal(nothing.ok, false);
    assert.match(
      !nothing.ok ? nothing.reason : "",
      /no sign-in seen: .*app_session every visitor is given does not count.*the stored session is unchanged/,
    );
    assert.deepEqual(
      loadSession(site),
      { cookies: [], values: {}, source: "chrome:Default", updatedAt: loadSession(site).updatedAt },
      "the previous session is kept as it was",
    );

    const signedIn = await inWindow((page) => page.goto(`${fx.url}/members/signin`));
    assert.equal(signedIn.ok, true, JSON.stringify(signedIn));
    assert.deepEqual(signedIn.ok && signedIn.renewed, ["auth_token"]);
    assert.equal(loadSession(site).source, "window");
    assert.deepEqual(loadSession(site).guestCookies, ["app_session"]);
    assert.ok(loadSession(site).cookies.some((c) => c.name === "auth_token"));

    // the profile already holds the login: opening and closing the window proves nothing about it
    // and a page that asks before it is left still closes: the window's dialog answer lets it go
    const again = await inWindow(async (page) => {
      await page.click("body");
      await page.evaluate(() =>
        addEventListener("beforeunload", (e) => {
          e.preventDefault();
          e.returnValue = "";
        }),
      );
    });
    assert.equal(again.ok, false);
    assert.match(!again.ok ? again.reason : "", /no new sign-in: the window already held auth_token when it opened/);
  });

  test("19. a picker with its own range: a failure status in a 200 body is not drift, and a heal keeps the place the page left out", async () => {
    const r = await addOperation({
      site: SITE,
      op: "calendar",
      trigger: { url: `${fx.url}/cal?from={from}&to={to}&start={start}` },
      // on the first of a month the page's range is start to 60 days later, so the examples are in it
      examples: [
        { from: "SFO", to: "JFK", start: "2027-04-01", end: "2027-05-31" },
        { from: "LAX", to: "BOS", start: "2027-06-01", end: "2027-07-31" },
      ],
      response: { extract: "[0][0][2][0]", pick: ["date=[0]", "price=[1][1]"] },
    });
    assert.equal(r.operation.minTier, 1, r.warnings.join("\n"));
    const april = { from: "SFO", to: "JFK", start: "2027-04-10", end: "2027-04-20" };
    const days = (res: { data?: unknown }) => (res.data as { date: string }[]).map((d) => d.date);
    const ok = await call(SITE, "calendar", april, fast);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(days(ok).length, 11);

    // the server's own failure, as HTTP 200 with a status where the payload goes: no heal, nothing stale
    const before = fx.calls.length;
    fx.failCalendar(13);
    const failed = await call(SITE, "calendar", april, fast);
    assert.equal(failed.class, "error", JSON.stringify(failed));
    assert.match(failed.reason ?? "", /batchexecute error 13 \(INTERNAL\)/);
    assert.equal(fx.calls.length, before + 1, "one request: no example replay, no heal");
    assert.equal(staleMark(SITE, "calendar"), undefined);

    // a deploy: the old build is gone ([5]). The heal's page asks for its own range, without the caller's end.
    fx.rotate();
    // the server fails for the page and for the candidate's check: nothing was learned, so nothing is stale
    fx.failCalendar(13, 13);
    const busy = await call(SITE, "calendar", april, fast);
    assert.equal(busy.class, "error", JSON.stringify(busy));
    assert.match(busy.reason ?? "", /heal stopped/);
    assert.equal(staleMark(SITE, "calendar"), undefined);
    const healed = await call(SITE, "calendar", april, fast);
    assert.equal(healed.ok, true, JSON.stringify(healed));
    assert.equal(healed.healed, true);
    // the page sent its own first day (2027-04-01) and last; both stay the caller's
    assert.deepEqual([days(healed)[0], days(healed).at(-1)], ["2027-04-10", "2027-04-20"], "the caller's range");
    assert.equal(
      heals()
        .filter((h) => h.op === "calendar")
        .at(-1)?.strategy,
      "recapture",
    );
    const june = await call(SITE, "calendar", { from: "LAX", to: "BOS", start: "2027-06-01", end: "2027-06-10" }, fast);
    assert.equal(june.tier, 1, JSON.stringify(june));
    assert.equal(days(june).length, 10);
    // a forced heal that re-learns the same template replays it, with the caller's args, and says so
    const current = await heal(
      SITE,
      "calendar",
      { from: "LAX", to: "BOS", start: "2027-06-01", end: "2027-06-10" },
      fast,
    );
    assert.equal(current.ok, true, JSON.stringify(current));
    assert.equal(current.healed, false);
    assert.deepEqual([days(current)[0], days(current).at(-1)], ["2027-06-01", "2027-06-10"]);
  });

  test("17. capture's next hint points at inspect and --html when the best candidate is the page itself", async () => {
    await closeBrowser(); // the CLI launches its own Chrome on the same profile
    const r = await cli("capture", `${fx.url}/list`, "--example", "q=alice");
    const out = JSON.parse(r.stdout);
    assert.equal(out.candidates[0].kind, "document");
    assert.match(out.next, /inspect .* --html/);
  });

  test("21. a step that types into a password or one-time-code field fails the run and saves nothing; capture shows a live token as its ref", async () => {
    const before = readFileSync(specFile(), "utf8");
    // the selectors say nothing of a password: the page's own type and autocomplete do
    for (const selector of ["input[name=secret]", "#code"])
      await assert.rejects(
        addOperation({
          site: SITE,
          op: "signIn",
          trigger: {
            url: `${fx.url}/signin-box`,
            steps: [
              { action: "fill", selector: "#user", value: "{user}" },
              { action: "fill", selector, value: "Hunter2-RealPassw0rd!" },
              { action: "fill", selector: "#q", value: "{q}" },
              { action: "click", selector: "#find" },
            ],
          },
          examples: [
            { user: "jane", q: "pizza" },
            { user: "jdoe", q: "pasta" },
          ],
        }),
        /fills a password or one-time-code field .*a sign-in is the user's: ask them to run api-anything login/,
        selector,
      );
    assert.equal(readFileSync(specFile(), "utf8"), before, "nothing saved");
    assert.ok(!readFileSync(join(HOME, "sessions", `${SITE}.json`), "utf8").includes("Hunter2"));

    await closeBrowser(); // the CLI launches its own Chrome on the same profile
    const r = await cli("capture", `${fx.url}/signin-box?q=pizza`, "--example", "q=pizza");
    const found = JSON.parse(r.stdout).candidates.find((c: { url: string }) => c.url.includes("/api/scoped"));
    assert.match(found.url, /\/api\/scoped\?q=pizza&access_token=\[cookie:ct0\]$/);
  });
});
