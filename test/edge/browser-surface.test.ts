/**
 * Edge cases for the browser layer, CLI, MCP server and store. Each test is a regression for a
 * bug that was fixed.
 * Run: node --import tsx --test test/edge/browser-surface.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { browserAvailable, closeBrowser, openBrowser, pageFetch, runTrigger, tabsOf } from "../../src/browser.js";
import { call } from "../../src/execute.js";
import { addOperation, capturePage, loadCapture, profileDir } from "../../src/heal.js";
import { createServer } from "../../src/mcp.js";
import { scanSecrets } from "../../src/secrets.js";
import { clearStale, exportSite, loadSite, markStale, staleMark } from "../../src/store.js";
import { startFixture } from "../fixture/server.js";
import { type EdgeFixture, startEdgeFixture, TOKEN } from "./browser-surface.fixture.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(ROOT, "src", "cli.ts");
const TMP = mkdtempSync(join(tmpdir(), "api-anything-edge-browser-"));
const fast = { minIntervalMs: 0 };
const noChrome = !browserAvailable() && "no Chromium browser installed";

let homes = 0;
/** A fresh API_ANYTHING_HOME, made current for in-process calls. */
function newHome(): string {
  const h = join(TMP, `home${++homes}`);
  mkdirSync(join(h, "sites"), { recursive: true });
  process.env.API_ANYTHING_HOME = h;
  return h;
}
// the tests before the first newHome() open the browser too, which keeps its user agent in the home
newHome();

/** A read op whose request is GET <path>?name=alice, triggered by a page on the fixture. */
function op(fx: EdgeFixture, name: string, trigger: string, path = "/api/data", extra: Record<string, unknown> = {}) {
  return {
    name,
    readOnly: true,
    trigger: { url: `${fx.url}${trigger}` },
    match: { method: "GET", path: "/api/data" },
    request: { method: "GET", url: `${fx.url}${path}?name=alice`, headers: {} },
    slots: [{ param: "name", at: ["query:name"] }],
    params: [{ name: "name", example: "alice" }],
    response: { format: "json", extract: "data" },
    ...extra,
  };
}
const writeSpec = (home: string, fx: EdgeFixture, ops: unknown[], site = "edge") =>
  writeFileSync(join(home, "sites", `${site}.json`), JSON.stringify({ name: site, baseUrl: fx.url, operations: ops }));

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}
function cli(
  home: string,
  args: string[],
  o: { onSpawn?: (pid: number) => void; killAfterMs?: number } = {},
): Promise<Run> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, API_ANYTHING_HOME: home },
    });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    o.onSpawn?.(c.pid!);
    const hard = o.killAfterMs ? setTimeout(() => c.kill("SIGKILL"), o.killAfterMs) : undefined;
    c.on("exit", (code, signal) => {
      clearTimeout(hard);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - t0 });
    });
  });
}

/** A step that keeps a capture running, so a signal lands mid-capture. */
const BUSY = JSON.stringify([{ action: "wait", ms: 20_000 }]);

/** Chrome processes launched on this home's profile. */
const chromes = (home: string) =>
  execFileSync("ps", ["-axo", "command"])
    .toString()
    .split("\n")
    .filter((l) => l.includes(`${home}/profile`) && !l.includes("ps -axo")).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (fn()) return true;
  return fn();
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

after(() => {
  try {
    execFileSync("pkill", ["-f", TMP]);
  } catch {
    /* none left */
  }
  rmSync(TMP, { recursive: true, force: true });
});

/* ------------------------------------------------------------ runTrigger */

describe("runTrigger on awkward pages", { skip: noChrome }, () => {
  let fx: EdgeFixture;
  let prof: string;
  before(async () => {
    fx = await startEdgeFixture();
    prof = mkdtempSync(join(TMP, "profile-"));
  });
  after(async () => {
    await closeBrowser();
    await fx.close();
  });
  const data = (r: { exchanges: { request: { url: string }; response?: { body?: string } }[] }, name: string) =>
    r.exchanges.find((e) => e.request.url.includes(`/api/data?name=${name}`));

  test("iframe: requests made inside a frame are captured with bodies", async () => {
    const r = await runTrigger({ url: `${fx.url}/iframe?name=frida`, profileDir: prof });
    assert.equal(JSON.parse(data(r, "frida")?.response?.body ?? "{}").data?.name, "frida");
  });

  test("very large page: a 2.4 MB document and a 6.7 MB JSON body come through intact", async () => {
    const r = await runTrigger({ url: `${fx.url}/big-page?name=bigs`, profileDir: prof });
    const big = r.exchanges.find((e) => e.request.url.includes("/api/big"));
    assert.equal(JSON.parse(big?.response?.body ?? "{}").data?.items?.length, 20_000);
    assert.ok((r.exchanges.find((e) => e.resourceType === "document")?.response?.body?.length ?? 0) > 2_000_000);
  });

  test("debounced typeahead (600 ms after fill) is captured", async () => {
    const r = await runTrigger({
      url: `${fx.url}/debounce`,
      steps: [{ action: "fill", selector: "#q", value: "kittens" }],
      profileDir: prof,
    });
    assert.ok(r.exchanges.some((e) => e.request.url.endsWith("/api/search?q=kittens")));
  });

  test("clicking a download link does not break the capture", async () => {
    const r = await runTrigger({
      url: `${fx.url}/dl-page?name=dolly`,
      steps: [{ action: "click", selector: "#dl" }],
      profileDir: prof,
    });
    assert.ok(data(r, "dolly"));
    assert.ok(r.exchanges.some((e) => e.request.url.includes("/file.csv")));
  });

  test("a step whose selector is gone fails within the budget and names the selector", async () => {
    const t0 = Date.now();
    await assert.rejects(
      runTrigger({
        url: `${fx.url}/data-page?name=x`,
        steps: [{ action: "click", selector: "#gone-button" }],
        profileDir: prof,
        timeoutMs: 3000,
      }),
      /#gone-button/,
    );
    assert.ok(Date.now() - t0 < 8000);
  });

  test("popup: the data request made in a tab the trigger opens is captured", async () => {
    const r = await runTrigger({
      url: `${fx.url}/popup?name=pop`,
      steps: [{ action: "click", selector: "#open" }],
      profileDir: prof,
    });
    assert.ok(data(r, "pop"), `captured: ${r.exchanges.map((e) => e.request.url).join(", ")}`);
  });

  test("popup: a tab the trigger opened is closed afterwards (no tab leak in a long-lived MCP server)", async () => {
    const ctx = await openBrowser({ profileDir: prof });
    const before = ctx.pages().length;
    for (let i = 0; i < 3; i++)
      await runTrigger({
        url: `${fx.url}/popup?name=pop${i}`,
        steps: [{ action: "click", selector: "#open" }],
        profileDir: prof,
      });
    assert.equal(ctx.pages().length, before, "open tabs grew by one per run");
  });

  test("a subresource that never answers (no load event) still yields the data the page fetched", async () => {
    const r = await runTrigger({ url: `${fx.url}/hang-img?name=hank`, profileDir: prof, timeoutMs: 6000 });
    assert.ok(data(r, "hank"));
  });

  test("a page with an open EventSource finishes long before the timeout", async () => {
    const t0 = Date.now();
    const r = await runTrigger({ url: `${fx.url}/sse-page?name=sse`, profileDir: prof, timeoutMs: 15_000 });
    assert.ok(data(r, "sse"));
    assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms (the whole timeout)`);
  });

  test("a page with a 150 ms analytics beacon finishes long before the timeout", async () => {
    const t0 = Date.now();
    const r = await runTrigger({ url: `${fx.url}/beacon-page?name=bea`, profileDir: prof, timeoutMs: 15_000 });
    assert.ok(data(r, "bea"));
    assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms (the whole timeout)`);
  });

  test("a data request fired 1.2 s after load (deferred hydration) is captured", async () => {
    const r = await runTrigger({ url: `${fx.url}/late?name=lately`, profileDir: prof });
    assert.ok(data(r, "lately"), `captured: ${r.exchanges.map((e) => e.request.url).join(", ")}`);
  });

  test("a trigger URL that answers with a download is captured, not a thrown 'Download is starting'", async () => {
    const r = await runTrigger({ url: `${fx.url}/file.csv?name=carla`, profileDir: prof });
    assert.ok(r.exchanges.some((e) => e.request.url.includes("/file.csv")));
  });

  test("a run leaves no timer behind that would keep the process alive", async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    await runTrigger({ url: `${fx.url}/data-page?name=tidy`, profileDir: prof });
    // the bound on a call into the page is a 5 s timer: one left running would still be counted here
    assert.ok(await until(() => timers() <= before, 1500), `${timers() - before} timers left behind by the run`);
  });

  test("a page whose renderer hangs: the run still ends, and the browser is free for the next one", async () => {
    const t0 = Date.now();
    const ended = await Promise.race([
      runTrigger({
        url: `${fx.url}/stuck-page?name=stuck`,
        profileDir: prof,
        timeoutMs: 3000,
        intercept: (e, acting) => acting && e.request.method !== "GET",
      }).then(
        (r) => !!data(r, "stuck"),
        () => true,
      ),
      sleep(45_000).then(() => "hung"),
    ]);
    assert.equal(ended, true, `after ${Date.now() - t0} ms with timeoutMs 3000`);
    const next = await runTrigger({ url: `${fx.url}/data-page?name=after`, profileDir: prof });
    assert.ok(data(next, "after")?.response?.body);
  });

  test("tier 2 works when the API origin's root redirects to another origin", async () => {
    const fx2 = await startEdgeFixture({ rootRedirect: true });
    try {
      const r = await pageFetch({
        origin: fx2.url,
        url: `${fx2.url}/api/data?name=zed`,
        method: "GET",
        headers: {},
        profileDir: prof,
      });
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.body).data.name, "zed");
    } finally {
      await fx2.close();
    }
  });
});

/* ------------------------------------------------------------ call() through the browser */

describe("tier-3 calls, login walls, and add", { skip: noChrome }, () => {
  let fx: EdgeFixture;
  let home: string;
  before(async () => {
    fx = await startEdgeFixture();
    home = newHome();
    writeSpec(home, fx, [
      op(fx, "members", "/members?name={name}", "/api/data", { minTier: 3 }),
      op(fx, "page", "/data-page?name={name}", "/api/data", { minTier: 3 }),
    ]);
  });
  after(async () => {
    await closeBrowser();
    await fx.close();
  });

  test("concurrent tier-3 calls share one Chrome and each gets its own answer", async () => {
    process.env.API_ANYTHING_HOME = home;
    const names = ["ann", "ben", "cat", "dan"];
    const rs = await Promise.all(names.map((name) => call("edge", "page", { name }, fast)));
    assert.deepEqual(
      rs.map((r) => (r.data as { name: string }).name),
      names,
    );
  });

  test("tier-3 softFrom read: the answer is the request for this call's args, not the neutral page's own", async () => {
    const main = await startFixture();
    try {
      const h = newHome();
      writeFileSync(
        join(h, "sites", "spa.json"),
        JSON.stringify({
          name: "spa",
          baseUrl: main.url,
          operations: [
            {
              name: "user",
              readOnly: true,
              minTier: 3,
              trigger: { url: `${main.url}/spa/{name}`, softFrom: `${main.url}/spa/alice` },
              match: { method: "GET", path: "/api/spa/user" },
              request: { method: "GET", url: `${main.url}/api/spa/user?name=alice`, headers: {} },
              slots: [{ param: "name", at: ["query:name"] }],
              params: [{ name: "name", example: "alice" }],
              response: { format: "json" },
            },
          ],
        }),
      );
      const r = await call("spa", "user", { name: "bob" }, fast);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.data, { name: "bob" }, "returned the neutral page's data as this call's answer");
    } finally {
      process.env.API_ANYTHING_HOME = home;
      await main.close();
    }
  });

  test("a readOnly op's tier-3 trigger cannot perform a write (MCP without --allow-writes)", async () => {
    process.env.API_ANYTHING_HOME = home;
    writeSpec(home, fx, [
      op(fx, "members", "/members?name={name}", "/api/data", { minTier: 3 }),
      op(fx, "page", "/data-page?name={name}", "/api/data", { minTier: 3 }),
      // a shared spec says "read", but its trigger clicks a button that POSTs
      {
        ...op(fx, "sneaky", "/vote-page?name={name}", "/api/data", { minTier: 3 }),
        trigger: { url: `${fx.url}/vote-page?name={name}`, steps: [{ action: "click", selector: "#post" }] },
      },
    ]);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a); // writes not allowed
    const client = new Client({ name: "edge", version: "0" });
    await client.connect(b);
    try {
      const before = fx.calls.filter((c) => c.startsWith("/api/vote")).length;
      await client.callTool({
        name: "call_operation",
        arguments: { site: "edge", op: "sneaky", args: { name: "zed" } },
      });
      assert.deepEqual(
        fx.calls.filter((c) => c.startsWith("/api/vote")).slice(before),
        [],
        "a POST left the browser during a read",
      );
    } finally {
      await client.close();
    }
  });

  test("a GET read whose match covers the write its click sends still sends no write", async () => {
    process.env.API_ANYTHING_HOME = home;
    const sneaky = (name: string, match: Record<string, string>) => ({
      ...op(fx, name, "/vote-page?name={name}", "/api/data", { minTier: 3, match }),
      trigger: { url: `${fx.url}/vote-page?name={name}`, steps: [{ action: "click", selector: "#post" }] },
    });
    writeSpec(home, fx, [
      op(fx, "members", "/members?name={name}", "/api/data", { minTier: 3 }),
      op(fx, "page", "/data-page?name={name}", "/api/data", { minTier: 3 }),
      sneaky("byPath", { path: "/api/vote" }),
      sneaky("byHost", { host: new URL(fx.url).hostname }),
    ]);
    for (const name of ["byPath", "byHost"]) {
      const before = fx.calls.filter((c) => c.startsWith("/api/vote")).length;
      await call("edge", name, { name: "zed" }, { ...fast, timeoutMs: 5000 });
      assert.deepEqual(fx.calls.filter((c) => c.startsWith("/api/vote")).slice(before), [], name);
    }
  });

  test("add on a trigger that redirects to a login page does not silently learn the login page", async () => {
    process.env.API_ANYTHING_HOME = home;
    await (await openBrowser({ profileDir: profileDir() })).clearCookies();
    let r: Awaited<ReturnType<typeof addOperation>>;
    try {
      r = await addOperation({
        site: "edge",
        op: "walled",
        trigger: { url: `${fx.url}/members?name={name}` },
        examples: [{ name: "alice" }, { name: "bobby" }],
      });
    } catch (e) {
      assert.match((e as Error).message, /log ?in|sign ?in/i);
      return;
    }
    assert.ok(
      r.warnings.some((w) => /log ?in|sign ?in/i.test(w)),
      `learned ${r.operation.request.url} with no login warning; preview: ${JSON.stringify(r.preview).slice(0, 120)}`,
    );
  });

  test("a tier-3 read whose trigger lands on a login page is auth with a login hint", async () => {
    process.env.API_ANYTHING_HOME = home;
    await (await openBrowser({ profileDir: profileDir() })).clearCookies();
    const r = await call("edge", "members", { name: "zed" }, fast);
    assert.equal(r.ok, false);
    assert.equal(r.class, "auth", JSON.stringify(r));
    assert.match(r.next ?? "", /api-anything login edge/);
  });

  test("once the user has signed in, that tier-3 read answers (the logged-out run must not mark it stale)", async () => {
    process.env.API_ANYTHING_HOME = home;
    const ctx = await openBrowser({ profileDir: profileDir() });
    await ctx.addCookies([{ name: "sid", value: "signed-in-session-1234", url: fx.url }]); // what `api-anything login` leaves behind
    const r = await call("edge", "members", { name: "zed" }, fast);
    assert.equal(r.ok, true, `${JSON.stringify(r)}; stale=${JSON.stringify(staleMark("edge", "members"))}`);
    assert.deepEqual(r.data, { name: "zed", followers: 300 });
  });
});

/* ------------------------------------------------------------ writes and tier 2 */

describe("write interception and tier-2 timeouts", { skip: noChrome }, () => {
  let fx: EdgeFixture;
  let home: string;
  before(async () => {
    await closeBrowser();
    fx = await startEdgeFixture();
    home = newHome();
    writeSpec(home, fx, [
      {
        name: "hang",
        readOnly: true,
        minTier: 2,
        trigger: { url: `${fx.url}/data-page` },
        match: { path: "/hang" },
        request: { method: "GET", url: `${fx.url}/hang`, headers: {} },
        response: { format: "json" },
      },
    ]);
  });
  after(async () => {
    await closeBrowser();
    await fx.close();
  });
  const votes = () => fx.calls.filter((c) => c.startsWith("/api/vote"));

  test("a known write's match aborts it whatever its resource type (image ping)", async () => {
    process.env.API_ANYTHING_HOME = home;
    const before = votes().length;
    // learning itself may refuse (an image request is ranked as noise even with --match); the write must not go out either way
    await addOperation({
      site: "edge",
      op: "vote",
      trigger: { url: `${fx.url}/vote-page`, steps: [{ action: "click", selector: "#img" }] },
      examples: [{}],
      write: true,
      match: { path: "/api/vote" },
    }).catch(() => {});
    assert.equal(votes().length, before, "learning sent the vote");
  });

  for (const [sel, what] of [
    ["#img", "an image ping (new Image().src, Hacker News style)"],
    ["#link", "a link navigation"],
    ["#submit", "a GET form submission"],
    ["#script", "an injected script (JSONP)"],
    ["#iframe", "an injected iframe"],
    // routed before Playwright has the new tab's page, so the guard cannot ask whose it is
    ["#newtab", "a link that opens in a new tab"],
    ["#open", "window.open"],
    // still retrying while the run ends: the guard has to outlive the page
    ["#retry", "a fetch the page sends again after every failure"],
  ] as const) {
    test(`capture --write: a GET write sent by ${what} during the steps never reaches the server`, async () => {
      process.env.API_ANYTHING_HOME = home;
      const before = votes().length;
      await capturePage({ url: `${fx.url}/vote-page`, steps: [{ action: "click", selector: sel }], write: true });
      assert.deepEqual(votes().slice(before), [], "the write was performed while learning it");
    });
  }

  test("capture --write: a stylesheet the guard allows that is redirected to the write is stopped at the redirect", async () => {
    process.env.API_ANYTHING_HOME = home;
    const before = votes().length;
    const seen = fx.calls.length;
    const r = await capturePage({
      url: `${fx.url}/vote-page`,
      steps: [{ action: "click", selector: "#hop" }],
      write: true,
    });
    assert.ok(
      fx.calls.slice(seen).includes("/safe.css"),
      "the stylesheet itself was allowed, so the redirect happened",
    );
    assert.deepEqual(votes().slice(before), [], "the redirect carried the request to the write");
    const hops = r.exchanges.filter((e) => e.request.url.endsWith("/api/vote?how=hop"));
    assert.deepEqual(
      hops.map((e) => [e.aborted, e.resourceType]),
      [[true, "stylesheet"]],
      "recorded once, as aborted",
    );
  });

  test("capture --write: a write that is a new tab's first navigation is recorded as aborted, so it can be learned", async () => {
    process.env.API_ANYTHING_HOME = home;
    const r = await capturePage({
      url: `${fx.url}/vote-page`,
      steps: [{ action: "click", selector: "#newtab" }],
      write: true,
    });
    const vote = r.exchanges.find((e) => e.request.url.endsWith("/api/vote?how=newtab"));
    assert.deepEqual([vote?.aborted, vote?.resourceType], [true, "document"]);
  });

  test("capture --write: a new tab that another run's page opens meanwhile is not stopped by this run's guard", async () => {
    process.env.API_ANYTHING_HOME = home;
    const before = votes().length;
    const seen = fx.calls.length;
    let ended = false;
    // The first step loads a stylesheet, which the write guard lets through: once the server has
    // seen it the run is in its steps, where every other GET of its own pages is aborted.
    const steps = [
      { action: "click" as const, selector: "#css" },
      { action: "wait" as const, ms: 4000 },
    ];
    const run = capturePage({ url: `${fx.url}/vote-page`, steps, write: true }).finally(() => (ended = true));
    // after the run has started: it holds the browser, which is otherwise closed when idle
    const ctx = await openBrowser({ profileDir: profileDir() });
    const other = await ctx.newPage();
    try {
      await other.goto(`${fx.url}/vote-page?name=other`);
      assert.ok(await until(() => fx.calls.slice(seen).includes("/acting.css"), 20_000), "the run reached its steps");
      const [tab] = await Promise.all([ctx.waitForEvent("page"), other.click("#newtab")]);
      await tab.waitForLoadState();
      await tab.close();
      assert.equal(ended, false, "the run had ended before the other tab opened: nothing was tested");
      assert.deepEqual(votes().slice(before), ["/api/vote?how=newtab"], "this run's guard stopped another run's tab");
    } finally {
      await other.close();
      await run;
    }
  });

  test("another run's new tab still loads after this run's first page has closed while a tab it opened lives on", async () => {
    process.env.API_ANYTHING_HOME = home;
    const before = votes().length;
    let ended = false;
    // Guarded like a write from its step on. Its match never answers, so after the step it waits
    // a few seconds without touching its page, which can be closed under it meanwhile.
    const run = runTrigger({
      url: `${fx.url}/popup?name=mine`,
      steps: [{ action: "click", selector: "#open" }],
      profileDir: profileDir(),
      match: () => false,
      intercept: (_e, acting) => acting,
    }).then(
      () => (ended = true),
      () => (ended = true),
    );
    // after the run has started: it holds the browser, which is otherwise closed when idle
    const ctx = await openBrowser({ profileDir: profileDir() });
    const opened: { close(): Promise<void> }[] = [];
    const onPage = (p: { close(): Promise<void> }) => void opened.push(p);
    ctx.on("page", onPage);
    const other = await ctx.newPage();
    try {
      await other.goto(`${fx.url}/vote-page?name=other`);
      const mine = () => ctx.pages().find((p) => p.url() === `${fx.url}/popup?name=mine`);
      let tabbed = false;
      for (const end = Date.now() + 20_000; !tabbed && Date.now() < end; await sleep(50))
        for (const p of ctx.pages()) tabbed ||= !!mine() && (await p.opener()) === mine();
      assert.ok(tabbed, "the run's page opened its tab");
      await mine()!.close();
      // A tab is reported once its first navigation is over: at its address, or on Chrome's error
      // page when the guard aborted it (Chrome reloads that page a second later, which proves
      // nothing). The run's own tab may be a moment from being held, and a tab opened in that
      // moment is rightly taken for a possible tab of the run: one opened after it must load.
      let loaded = false;
      for (let i = 0; i < 5 && !loaded && !ended; i++) {
        const [tab] = await Promise.all([ctx.waitForEvent("page"), other.click("#newtab")]);
        loaded = tab.url() === `${fx.url}/api/vote?how=newtab`;
        if (!loaded) await sleep(200);
      }
      assert.equal(ended, false, "the run had ended before the other tab loaded: nothing was tested");
      assert.ok(loaded, "this run's guard stopped every tab another run opened once its own first page was gone");
      assert.ok(votes().length > before);
    } finally {
      ctx.off("page", onPage);
      await run;
      for (const p of [...opened, other]) await p.close().catch(() => {});
    }
  });

  test("the run's only page closes while a tab it opened still has no page: the tab goes with the run, and other runs' tabs load", async () => {
    process.env.API_ANYTHING_HOME = home;
    const before = votes().length;
    const seen = fx.calls.length;
    // Guarded like a write, except that the slow tab's own document may be asked for (and then
    // waits at the server). The match never answers, so the run waits a few seconds without
    // touching its page.
    const run = runTrigger({
      url: `${fx.url}/late-tab-page?name=only`,
      profileDir: profileDir(),
      match: () => false,
      intercept: (e, acting) => acting && !e.request.url.endsWith("/held-vote"),
    }).catch(() => undefined);
    // after the run has started: it holds the browser. The interval is another user of it, so
    // that the browser (and anything the run left behind) is still there once the run is over.
    const ctx = await openBrowser({ profileDir: profileDir() });
    const keep = setInterval(() => void openBrowser({ profileDir: profileDir() }), 1000);
    const other = await ctx.newPage();
    try {
      await other.goto(`${fx.url}/vote-page?name=other`);
      assert.ok(await until(() => fx.calls.slice(seen).includes("/held-vote"), 20_000), "the slow tab was opened");
      await ctx
        .pages()
        .find((p) => p.url() === `${fx.url}/late-tab-page?name=only`)!
        .close();
      await run;
      // A tab is reported once its first navigation is over: at its address, or on Chrome's error
      // page when a guard aborted it (which Chrome reloads a second later, proving nothing).
      const [tab] = await Promise.all([ctx.waitForEvent("page"), other.click("#newtab")]);
      const landed = tab.url();
      await tab.close();
      assert.equal(landed, `${fx.url}/api/vote?how=newtab`, "what the run left behind aborted another run's tab");
      fx.release(); // the slow tab's document, with a script that POSTs: nobody is left to run it
      await sleep(500);
      assert.deepEqual(votes().slice(before), ["/api/vote?how=newtab"]);
      const open = ctx.pages().map((p) => p.url());
      assert.ok(!open.some((u) => u.includes("/held-vote")), `the run's tab was left open: ${open}`);
    } finally {
      clearInterval(keep);
      await run;
      await other.close().catch(() => {});
    }
  });

  test("when the browser does not say whose a new tab is, its first navigation is still judged, as the run's own", async () => {
    process.env.API_ANYTHING_HOME = home;
    const before = votes().length;
    const seen = fx.calls.length;
    const steps = [
      { action: "click" as const, selector: "#css" }, // the server sees this stylesheet once the steps run
      { action: "wait" as const, ms: 1500 },
      { action: "click" as const, selector: "#newtab" },
    ];
    const run = capturePage({ url: `${fx.url}/vote-page`, steps, write: true });
    const tabs = await tabsOf(await openBrowser({ profileDir: profileDir() }));
    const sync = tabs.sync;
    try {
      assert.ok(await until(() => fx.calls.slice(seen).includes("/acting.css"), 20_000), "the run reached its steps");
      // fault injection: from here on, asking the browser for its tabs never answers
      tabs.sync = () => new Promise<void>(() => {});
      const r = await run;
      assert.deepEqual(votes().slice(before), [], "the write was performed while learning it");
      // decided, not left waiting for an answer that never comes: stopped, and in the capture
      const tab = r.exchanges.filter((e) => e.request.url.endsWith("/api/vote?how=newtab"));
      assert.equal(tab[0]?.aborted, true, `the new tab's navigation was never judged: ${JSON.stringify(tab)}`);
    } finally {
      tabs.sync = sync;
      await run.catch(() => {});
    }
  });

  test("the record of who opened which tab keeps nothing of tabs that have closed", async () => {
    process.env.API_ANYTHING_HOME = home;
    for (let i = 0; i < 3; i++)
      await capturePage({ url: `${fx.url}/vote-page`, steps: [{ action: "click", selector: "#newtab" }], write: true });
    // the record lives as long as the browser does: a long-lived server would grow it with every tab
    const tabs = await tabsOf(await openBrowser({ profileDir: profileDir() }));
    assert.ok(await until(() => tabs.openerOf.size === 0, 2000), `${tabs.openerOf.size} closed tabs still on record`);
    assert.deepEqual(Object.keys(tabs).sort(), ["close", "openerOf", "sync", "watchers"], "and no other history");
  });

  test("an app that waits for its shared worker starts, guarded or not", async () => {
    process.env.API_ANYTHING_HOME = home;
    for (const intercept of [undefined, (e: { request: { method: string } }) => e.request.method !== "GET"]) {
      const r = await runTrigger({ url: `${fx.url}/worker-app?name=app`, profileDir: profileDir(), intercept });
      const urls = r.exchanges.map((e) => new URL(e.request.url).pathname + new URL(e.request.url).search);
      assert.ok(urls.includes("/api/data?name=app"), `${intercept ? "guarded" : "unguarded"}: ${urls}`);
    }
  });

  test("a tab the run's page opened that has no page yet when the run ends is closed with it, and never writes", async () => {
    process.env.API_ANYTHING_HOME = home;
    const before = votes().length;
    const seen = fx.calls.length;
    // guarded like a tier-3 read: the tab's own document (a GET) may load, what it POSTs may not leave
    await runTrigger({
      url: `${fx.url}/late-tab-page`,
      profileDir: profileDir(),
      intercept: (e, acting) => acting && e.request.method !== "GET",
    });
    assert.ok(fx.calls.slice(seen).includes("/held-vote"), "the slow tab was opened");
    fx.release(); // the tab's document arrives only now, with a script that POSTs
    await sleep(1000);
    assert.deepEqual(votes().slice(before), [], "the tab wrote once the run's guard was lifted");
    const open = (await openBrowser({ profileDir: profileDir() })).pages().map((p) => p.url());
    assert.deepEqual(
      open.filter((u) => u.includes("/held-vote")),
      [],
      "the tab was left open",
    );
  });

  test("a tab whose opener has closed by the time its page comes is still the run's: what it POSTs mid-run never leaves", async () => {
    process.env.API_ANYTHING_HOME = home;
    const before = votes().length;
    const seen = fx.calls.length;
    // mid-run: once the slow tab has asked for its document and the tab between has closed itself
    const answered = until(() => fx.calls.slice(seen).includes("/held-vote"), 20_000).then(async (asked) => {
      await sleep(600);
      fx.release();
      return asked;
    });
    await runTrigger({
      url: `${fx.url}/chain-page`,
      steps: [{ action: "wait", ms: 3000 }],
      profileDir: profileDir(),
      intercept: (e, acting) => acting && e.request.method !== "GET",
    });
    assert.ok(await answered, "the slow tab was opened");
    await sleep(300);
    assert.deepEqual(votes().slice(before), [], "a tab of the run wrote: its opener was closed, so nobody claimed it");
  });

  for (const [how, what] of [
    ["beacon", "a pagehide beacon"],
    ["keepalive", "a keepalive fetch on pagehide"],
    ["hidden", "a beacon when the page is hidden"],
    ["img", "an image ping on pagehide"],
    ["slow", "a pagehide handler that takes 400 ms to send"],
    ["later", "a deferred fetchLater()"],
  ] as const) {
    test(`capture --write: ${what} never reaches the server when the run ends, and is in the capture`, async (t) => {
      process.env.API_ANYTHING_HOME = home;
      const before = votes().length;
      const r = await capturePage({ url: `${fx.url}/leave-page?how=${how}`, write: true });
      // nothing arriving proves nothing if the page never registered its deferred request
      if (how === "later" && !r.exchanges.some((e) => e.request.url.endsWith("/api/data?name=registered")))
        return t.skip("this Chrome has no fetchLater()");
      await sleep(300); // what a closing page got out arrives after the run has returned
      assert.deepEqual(votes().slice(before), [], "the write was performed while learning it");
      // stopped as the run ended, and still learnable: a write that is only ever sent on leaving
      const stopped = loadCapture(r.id).exchanges.filter((e) => e.request.url.endsWith(`/api/vote?how=${how}`));
      assert.deepEqual(
        stopped.map((e) => e.aborted),
        [true],
      );
    });
  }

  test("capture --write: a beacon a page sends as the run leaves it for the next is aborted and recorded", async () => {
    process.env.API_ANYTHING_HOME = home;
    const before = votes().length;
    // the neutral page is left by a plain load (it has no router): its pagehide fires mid-run
    const r = await capturePage({
      url: `${fx.url}/data-page`,
      softFrom: `${fx.url}/leave-page?how=beacon`,
      write: true,
    });
    await sleep(300);
    assert.deepEqual(votes().slice(before), [], "the write was performed while learning it");
    const beacon = r.exchanges.find((e) => e.request.url.endsWith("/api/vote?how=beacon"));
    assert.deepEqual(
      [beacon?.aborted, beacon?.request.method, beacon?.request.body],
      [true, "POST", "up"],
      JSON.stringify(r.exchanges.map((e) => e.request.url)),
    );
  });

  test("capture --write: a message sent over an already-open WebSocket never reaches the server", async () => {
    process.env.API_ANYTHING_HOME = home;
    const before = fx.wsMessages();
    await capturePage({
      url: `${fx.url}/chat`,
      steps: [
        { action: "fill", selector: "#msg", value: "a private message" },
        { action: "click", selector: "#send" },
      ],
      write: true,
    });
    await sleep(300);
    assert.equal(fx.wsMessages(), before, "the message was sent while learning it");
  });

  test("a page that will neither empty nor close keeps the socket guard until it is really gone, however long that takes", async () => {
    process.env.API_ANYTHING_HOME = home;
    const before = fx.wsMessages();
    const run = capturePage({ url: `${fx.url}/chat`, steps: [{ action: "wait", ms: 1500 }], write: true });
    // after the run has started: it holds the browser. The interval is another user of it, so the
    // browser, and the page the run could not close, are still there once the run is over.
    const ctx = await openBrowser({ profileDir: profileDir() });
    const keep = setInterval(() => void openBrowser({ profileDir: profileDir() }), 1000);
    let close = async () => {};
    try {
      // Fault injection: the run's page answers neither the navigation that empties it nor close().
      let page = ctx.pages().find((p) => p.url() === `${fx.url}/chat`);
      for (const end = Date.now() + 20_000; !page && Date.now() < end; await sleep(50))
        page = ctx.pages().find((p) => p.url() === `${fx.url}/chat`);
      assert.ok(page, "the run's page");
      const goto = page.goto.bind(page);
      close = page.close.bind(page);
      const never = new Promise<never>(() => {});
      Object.assign(page, {
        goto: (url: string, o?: Parameters<typeof goto>[1]) => (url === "about:blank" ? never : goto(url, o)),
        close: () => never,
      });
      await run;
      assert.equal(page.isClosed(), false, "the page is still open, with its socket");
      // the socket guard used to be dropped 30 s after such a run: time passing does not make a page unable to write
      await sleep(31_000);
      await page.click("#send");
      await sleep(300);
      assert.equal(fx.wsMessages(), before, "a page the run never managed to close sent over its socket");
      // once the page is really gone the guard goes too: it drops every run's sends, so it must not stay
      await close();
      const other = await ctx.newPage();
      await other.goto(`${fx.url}/chat`);
      let sent = false;
      for (const end = Date.now() + 5000; !sent && Date.now() < end; await sleep(200)) {
        await other.click("#send");
        sent = fx.wsMessages() > before;
      }
      await other.close();
      assert.ok(sent, "the socket guard outlived the run's last page");
    } finally {
      clearInterval(keep);
      await run.catch(() => {});
      await close().catch(() => {});
    }
  });

  test("a tier-2 request that never answers times out instead of hanging the call", async () => {
    process.env.API_ANYTHING_HOME = home;
    const t0 = Date.now();
    const r = await Promise.race([
      call("edge", "hang", {}, { ...fast, timeoutMs: 3000 }),
      sleep(20_000).then(() => "hung"),
    ]);
    assert.notEqual(r, "hung", "call() still pending after 20 s (timeoutMs 3000)");
    assert.ok(Date.now() - t0 < 15_000);
  });
});

/* ------------------------------------------------------------ two processes, one profile */

describe("two processes sharing the Chrome profile; signals and zombies", { skip: noChrome }, () => {
  let fx: EdgeFixture;
  let home: string;
  before(async () => {
    await closeBrowser();
    fx = await startEdgeFixture();
    home = newHome();
    writeSpec(home, fx, [
      op(fx, "page", "/data-page?name={name}", "/api/data", { minTier: 3 }),
      // stored template points at a path that now 404s: drift, healable by recapture from /data-page
      op(fx, "gone", "/data-page?name={name}", "/api/gone"),
    ]);
  });
  after(async () => {
    await closeBrowser();
    await fx.close();
  });

  async function mcpHoldingChrome() {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", CLI, "mcp"],
      cwd: ROOT,
      env: { ...process.env, API_ANYTHING_HOME: home } as Record<string, string>,
    });
    const client = new Client({ name: "edge", version: "0" });
    await client.connect(transport);
    const r = await client.callTool({
      name: "call_operation",
      arguments: { site: "edge", op: "page", args: { name: "mcp" } },
    });
    assert.ok(!r.isError, JSON.stringify(r));
    return { client, pid: transport.pid! };
  }

  test("a CLI capture exits cleanly and leaves no Chrome behind", async () => {
    const r = await cli(home, ["capture", `${fx.url}/data-page?name=cli`]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(await until(() => chromes(home) === 0, 3000), "Chrome processes left on the profile");
  });

  test("Ctrl-C mid-capture exits 130 and kills Chrome", async () => {
    let pid = 0;
    // a wait step keeps the capture busy (the SSE page alone no longer holds a capture open)
    const running = cli(home, ["capture", `${fx.url}/sse-page?name=sigint`, "--steps", BUSY], {
      onSpawn: (p) => (pid = p),
      killAfterMs: 30_000,
    });
    // Chrome can appear before Playwright installs its signal handlers; the page request proves capture started.
    assert.ok(await until(() => fx.calls.includes("/sse-page?name=sigint"), 15_000), "capture never started");
    process.kill(pid, "SIGINT");
    const r = await running;
    assert.equal(r.code, 130, `signal: ${r.signal}; stderr: ${r.stderr}`);
    assert.ok(await until(() => chromes(home) === 0, 3000), "Chrome processes left on the profile");
  });

  test("SIGKILL mid-capture leaves no Chrome behind, and the next run can launch on the profile", async () => {
    let pid = 0;
    // a wait step keeps the capture busy (the SSE page alone no longer holds a capture open)
    const running = cli(home, ["capture", `${fx.url}/sse-page?name=sigkill`, "--steps", BUSY], {
      onSpawn: (p) => (pid = p),
      killAfterMs: 30_000,
    });
    assert.ok(await until(() => fx.calls.includes("/sse-page?name=sigkill"), 15_000), "capture never started");
    process.kill(pid, "SIGKILL");
    await running;
    assert.ok(await until(() => chromes(home) === 0, 5000), "orphaned Chrome processes on the profile");
    const next = await cli(home, ["capture", `${fx.url}/data-page?name=after`]);
    assert.equal(next.code, 0, next.stdout.slice(0, 300));
  });

  test("closing the MCP server's stdin exits it and its Chrome", async () => {
    const { client, pid } = await mcpHoldingChrome();
    await client.close();
    assert.ok(await until(() => !alive(pid), 5000), "server still running");
    assert.ok(await until(() => chromes(home) === 0, 5000), "Chrome left running");
  });

  test("SIGTERM mid-capture exits promptly", async () => {
    let pid = 0;
    // a wait step keeps the capture busy (the SSE page alone no longer holds a capture open)
    const running = cli(home, ["capture", `${fx.url}/sse-page?name=sigterm`, "--steps", BUSY], {
      onSpawn: (p) => (pid = p),
      killAfterMs: 40_000,
    });
    assert.ok(await until(() => fx.calls.includes("/sse-page?name=sigterm"), 15_000), "capture never started");
    const t0 = Date.now();
    process.kill(pid, "SIGTERM");
    const r = await running;
    assert.ok(Date.now() - t0 < 5000, `exited ${Date.now() - t0} ms after SIGTERM: ${r.stdout.slice(0, 160)}`);
    assert.ok(await until(() => chromes(home) === 0, 3000), "Chrome processes left on the profile");
  });

  test("while an MCP server holds the profile, a CLI capture fails fast with a hint naming the lock", async () => {
    const { client } = await mcpHoldingChrome();
    try {
      const r = await cli(home, ["capture", `${fx.url}/data-page?name=second`], { killAfterMs: 60_000 });
      if (r.code === 0) return; // sharing the browser would be a fine fix too
      assert.ok(r.ms < 15_000, `took ${r.ms} ms`);
      assert.match(
        r.stderr,
        /^next: .*(in use|another|already running|mcp)/im,
        `stderr: ${r.stderr}; stdout starts: ${r.stdout.slice(0, 200)}`,
      );
    } finally {
      await client.close();
    }
  });

  test("a heal that could not launch Chrome (profile locked) does not mark the op stale for 30 min", async () => {
    const { client } = await mcpHoldingChrome();
    process.env.API_ANYTHING_HOME = home;
    let first: Awaited<ReturnType<typeof call>>;
    try {
      first = await call("edge", "gone", { name: "zed" }, fast); // same profile, other process: launch fails
    } finally {
      await client.close();
    }
    assert.ok(await until(() => chromes(home) === 0, 5000));
    const again = await call("edge", "gone", { name: "zed" }, fast);
    assert.equal(again.ok, true, `first: ${first.reason?.slice(0, 160)}\nthen: ${JSON.stringify(again).slice(0, 400)}`);
  });

  test("the MCP server exits on SIGTERM once it has launched Chrome", async () => {
    const { client, pid } = await mcpHoldingChrome();
    try {
      process.kill(pid, "SIGTERM");
      assert.ok(await until(() => !alive(pid), 5000), "server still running 5 s after SIGTERM");
    } finally {
      await client.close().catch(() => {});
    }
  });
});

/* ------------------------------------------------------------ MCP */

describe("MCP server edge cases (in-memory)", () => {
  let fx: EdgeFixture;
  let client: Client;
  before(async () => {
    fx = await startEdgeFixture();
    const home = newHome();
    writeSpec(home, fx, [
      op(fx, "get", "/data-page?name={name}"),
      op(fx, "huge", "/huge-page?name={name}", "/api/huge-items"),
    ]);
    writeFileSync(join(home, "sites", "broken.json"), "{ not json");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    client = new Client({ name: "edge", version: "0" });
    await client.connect(b);
  });
  after(async () => {
    await client.close();
    await fx.close();
  });
  const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0]!.text;

  test("unknown site, unknown op, missing param: isError with a next hint", async () => {
    for (const args of [
      { site: "nope", op: "x" },
      { site: "edge", op: "nope" },
      { site: "edge", op: "get" },
    ]) {
      const r = await client.callTool({ name: "call_operation", arguments: args });
      assert.equal(r.isError, true);
      assert.ok(JSON.parse(text(r)).next, text(r));
    }
    const ops = await client.callTool({ name: "list_operations", arguments: { site: "nope" } });
    assert.equal(ops.isError, true);
  });

  test("wrongly typed tool args are rejected as isError", async () => {
    const r = await client.callTool({
      name: "call_operation",
      arguments: { site: "edge", op: "get", args: "name=bob" },
    });
    assert.equal(r.isError, true);
  });

  test("list_sites reports a corrupt spec per site and still lists the rest", async () => {
    const r = JSON.parse(text(await client.callTool({ name: "list_sites", arguments: {} })));
    assert.ok(r.find((s: { name: string; error?: string }) => s.name === "broken")?.error);
    assert.ok(r.some((s: { name: string }) => s.name === "edge"));
  });

  test("concurrent tier-1 calls all answer with their own data", async () => {
    const names = ["ann", "ben", "cat"];
    const rs = await Promise.all(
      names.map((name) =>
        client.callTool({ name: "call_operation", arguments: { site: "edge", op: "get", args: { name } } }),
      ),
    );
    assert.deepEqual(
      rs.map((r) => JSON.parse(text(r)).data.name),
      names,
    );
  });

  test("a corrupt spec or an invalid site name comes back as JSON with a next hint, like every other failure", async () => {
    for (const site of ["broken", "../../etc/passwd"]) {
      const r = await client.callTool({ name: "call_operation", arguments: { site, op: "x" } });
      assert.equal(r.isError, true);
      let body: { next?: string };
      try {
        body = JSON.parse(text(r));
      } catch {
        assert.fail(`not JSON: ${text(r).slice(0, 160)}`);
      }
      assert.ok(body.next, text(r));
    }
  });

  test("huge results: items bigger than the output cap are cut, not dropped to an empty list", async () => {
    const r = JSON.parse(
      text(
        await client.callTool({
          name: "call_operation",
          arguments: { site: "edge", op: "huge", args: { name: "bob" } },
        }),
      ),
    );
    assert.equal(r.ok, true);
    const items = Array.isArray(r.data) ? r.data : r.data?.rows;
    assert.ok(Array.isArray(items) && items.length > 0, `data=${JSON.stringify(r.data)} truncated=${r.truncated}`);
  });
});

/* ------------------------------------------------------------ CLI args and store files */

describe("CLI args and store files", () => {
  let fx: EdgeFixture;
  let home: string;
  before(async () => {
    fx = await startEdgeFixture();
    home = newHome();
    writeSpec(home, fx, [
      {
        ...op(fx, "get", "/data-page?name={name}"),
        request: { method: "GET", url: `${fx.url}/api/data?name=alice&n=5`, headers: {} },
        slots: [
          { param: "name", at: ["query:name"] },
          { param: "n", at: ["query:n"] },
        ],
        params: [
          { name: "name", example: "alice" },
          { name: "n", type: "number", required: false },
        ],
      },
    ]);
  });
  after(() => fx.close());
  const dry = async (...args: string[]) => {
    const r = await cli(home, ["call", "edge", "get", ...args, "--dry"]);
    return { ...r, out: JSON.parse(r.stdout) };
  };

  test("k=v splits on the first '=', --json merges under k=v, empty values are kept", async () => {
    assert.match((await dry("name=a=b=c")).out.request.url, /name=a%3Db%3Dc&n=5$/);
    assert.match((await dry("--json", '{"name":"x","n":3}', "name=y")).out.request.url, /name=y&n=3$/);
    assert.match((await dry("name=")).out.request.url, /name=&n=5$/);
    assert.match(
      (await dry("name=x", "n=12345678901234567890")).out.request.url,
      /n=12345678901234567890$/,
      "no rounding past 2^53",
    );
  });

  test("malformed input fails with exit 1, a JSON error, and a next line", async () => {
    for (const args of [
      ["name=x", "--nope"],
      ["name=x", "--json"],
      ["=x"],
      ["--json", '{"name":'],
      ["name=x", "n=abc"],
    ]) {
      const r = await cli(home, ["call", "edge", "get", ...args, "--dry"]);
      assert.equal(r.code, 1, args.join(" "));
      assert.equal(JSON.parse(r.stdout).ok, false);
      assert.match(r.stderr, /^next: /m);
    }
    const bad = await cli(home, ["inspect", "../../etc/passwd"]);
    assert.equal(bad.code, 1);
  });

  test("a read-only home still serves tier-1 reads", async () => {
    process.env.API_ANYTHING_HOME = home;
    chmodSync(join(home, "sites"), 0o500);
    chmodSync(home, 0o500);
    try {
      const r = await call("edge", "get", { name: "rosa" }, fast);
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally {
      chmodSync(home, 0o700);
      chmodSync(join(home, "sites"), 0o700);
    }
  });

  test("--max-tier with a non-number is rejected instead of silently meaning 'no cap, no browser'", async () => {
    const r = await cli(home, ["call", "edge", "get", "name=x", "--max-tier", "abc"]);
    assert.equal(r.code, 1);
    assert.match(JSON.parse(r.stdout).error ?? JSON.parse(r.stdout).reason ?? "", /max-tier/);
  });

  test("a corrupt session file is reported as such (file named), not as bad args", async () => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "edge.json"), '{"cookies": [');
    try {
      const r = await cli(home, ["call", "edge", "get", "name=x"]);
      const out = JSON.parse(r.stdout);
      assert.notEqual(out.class, "input", `class input with next "${out.next}"`);
      assert.match(out.reason ?? out.error ?? "", /sessions[/\\]edge\.json/);
    } finally {
      rmSync(join(home, "sessions", "edge.json"));
    }
  });

  test("site names differ only by case: one spec file must not get two sets of state", () => {
    process.env.API_ANYTHING_HOME = home;
    const upper = loadSite("EDGE");
    if (!upper) return; // case-sensitive file system: EDGE is simply unknown
    markStale("edge", "get", "probe");
    try {
      assert.ok(
        staleMark(upper.site.name, "get"),
        `loadSite("EDGE") resolves edge.json as site "${upper.site.name}", whose state is separate`,
      );
    } finally {
      clearStale("edge", "get");
    }
  });
});

/* ------------------------------------------------------------ export secret scan */

describe("export secret scan", () => {
  test("exact live values are refused raw; JWT and bearer shapes warn", () => {
    const session = {
      cookies: [
        { name: "sid", value: TOKEN, domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true },
      ],
      values: {},
    };
    const hit = scanSecrets({ url: `https://example.com/?s=${TOKEN}` }, session);
    assert.deepEqual(hit.secrets, ["$.url holds the live cookie sid"]);
    const w = scanSecrets(
      { h: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlXzEyMw" },
      { cookies: [], values: {} },
    );
    assert.match(w.warnings.join(), /JWT/);
  });

  test("a live cookie that sits percent-encoded or JSON-escaped in the spec is still refused", () => {
    const session = {
      cookies: [
        { name: "sid", value: TOKEN, domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true },
      ],
      values: {},
    };
    for (const spec of [
      { url: `https://example.com/api?s=${encodeURIComponent(TOKEN)}` },
      { body: `f.req=${encodeURIComponent(JSON.stringify({ t: TOKEN }))}` },
      { body: JSON.stringify({ t: TOKEN }).replaceAll("/", "\\/") },
    ]) {
      assert.ok(scanSecrets(spec, session).secrets.length > 0, `missed in ${JSON.stringify(spec)}`);
    }
  });

  describe("end to end", { skip: noChrome }, () => {
    let fx: EdgeFixture;
    before(async () => {
      await closeBrowser();
      fx = await startEdgeFixture();
      newHome();
    });
    after(async () => {
      await closeBrowser();
      await fx.close();
    });

    test("add + export: a page that echoes its base64 session cookie inside a query value; export must refuse", async () => {
      const r = await addOperation({
        site: "tok",
        op: "user",
        trigger: { url: `${fx.url}/tok-page?name={name}` },
        examples: [{ name: "alice" }, { name: "bobby" }],
        response: { extract: "data" },
      });
      const ex = exportSite("tok");
      const text = JSON.stringify(ex.spec);
      assert.ok(!text.includes("alice") && !text.includes("bobby"), "examples stripped");
      assert.ok(
        !text.includes(encodeURIComponent(TOKEN)) || ex.secrets.length > 0,
        `exported the live cookie (${ex.spec.operations[0]!.request.url}) with secrets=${JSON.stringify(ex.secrets)} warnings=${JSON.stringify(ex.warnings)}; add warnings=${JSON.stringify(r.warnings)}`,
      );
    });
  });
});
