/**
 * The MCP login tool's address rule: page text may steer the agent, so what the tool asks from Node
 * and opens is a known site's own address or an https page on a public host, as learn_site's trigger is.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { guestCookieNames, knownGuests } from "../src/login.js";
import { createServer, type ServerOptions } from "../src/mcp.js";
import { parseSite } from "../src/spec.js";
import { saveSite } from "../src/store.js";

/** A local service that records each request; `/go` redirects to `to`. */
async function service(to?: () => string) {
  const hits: string[] = [];
  const server = httpServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith("/go") && to) {
      res.writeHead(302, { location: to(), "set-cookie": "first=1; Path=/" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "visitor=1; Path=/" });
    res.end("<html>ok</html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("MCP login probes and opens only a site's own address or an https page on a public host", async () => {
  const home = mkdtempSync(join(tmpdir(), "aa-mcp-login-"));
  process.env.API_ANYTHING_HOME = home;
  const a = await service();
  const b = await service();
  const opened: { site: string; url: string; publicOnly?: boolean }[] = [];
  const window: NonNullable<ServerOptions["run"]>["window"] = async (site, url, o) => {
    opened.push({ site, url, ...(o?.publicOnly !== undefined ? { publicOnly: o.publicOnly } : {}) });
    return { ok: true, cookies: [], renewed: ["sid"] };
  };
  // a site the user has, on this machine
  saveSite(parseSite({ name: "mine", baseUrl: a.base, operations: [] }));
  const client = new Client({ name: "probe", version: "0" });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await createServer({ run: { window } }).connect(x);
  await client.connect(y);
  const login = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "login", arguments: args });
    return { isError: r.isError === true, ...JSON.parse((r.content as { text: string }[])[0]!.text) };
  };
  try {
    for (const [what, args] of [
      ["a loopback url", { url: `${b.base}/device/restart?confirm=1`, mode: "window" }],
      ["the same in site", { site: `${b.base}/via-site-field`, mode: "window" }],
      ["another port of a known site's host", { url: `${b.base}/other-port/reset?x=1`, mode: "window" }],
      ["another path of a known site", { url: `${a.base}/admin/reset`, mode: "window" }],
      ["a private address", { url: "https://192.168.1.1/", mode: "window" }],
      ["a local name", { url: "https://router.lan/", mode: "window" }],
      ["plain http on a public host", { url: "http://www.example.com/", mode: "window" }],
      ["import mode, the same loopback url", { url: `${a.base}/admin/reset` }],
    ] as const) {
      const r = await login(args);
      assert.deepEqual([r.isError, r.ok], [true, false], `${what}: ${JSON.stringify(r)}`);
      assert.match(r.error, /over MCP, login opens only a site's own address or an https page on a public host/, what);
      assert.match(r.next, /api-anything login <url> --window/, what);
      assert.ok(!JSON.stringify(r).includes("/device/restart"), "the caller's address is not spelled in a command");
    }
    assert.deepEqual(opened, [], "no window was opened");
    assert.deepEqual([a.hits, b.hits], [[], []], "and nothing was asked from Node");

    // the user's own site, by name: its own address, as the CLI opens it
    assert.equal((await login({ site: "mine", mode: "window" })).ok, true);
    // an https page on a public host: opened, its probe held to public addresses
    assert.equal((await login({ url: "https://www.example.com/login", mode: "window" })).ok, true);
    assert.deepEqual(opened, [
      { site: "mine", url: a.base, publicOnly: false },
      { site: "example.com", url: "https://www.example.com/login", publicOnly: true },
    ]);
  } finally {
    await client.close();
    await a.close();
    await b.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("the sign-in probe follows no redirect to an address its hop check refuses", async () => {
  const lan = await service();
  const front = await service(() => `${lan.base}/lan-hop`);
  try {
    // as the CLI probes: the redirect is followed, and both answers' cookies are seen
    assert.deepEqual(await guestCookieNames(`${front.base}/go`), ["first", "visitor"]);
    assert.deepEqual([front.hits.length, lan.hits.length], [1, 1]);
    // with a hop check that refuses the second address: one request, and the first answer's cookie only
    const refuse = async (url: string) => (url.startsWith(lan.base) ? "is refused" : undefined);
    assert.deepEqual(await guestCookieNames(`${front.base}/go`, fetch, refuse), ["first"]);
    assert.deepEqual([front.hits.length, lan.hits.length], [2, 1], "the redirect's target was not asked");
    // refused at the first address: nothing is asked at all
    assert.deepEqual(await guestCookieNames(`${lan.base}/x`, fetch, refuse), []);
    assert.equal(lan.hits.length, 1);
    // as a login passes it on
    process.env.API_ANYTHING_HOME = mkdtempSync(join(tmpdir(), "aa-mcp-login-"));
    assert.deepEqual(await knownGuests("front", `${front.base}/go`, undefined, fetch, refuse), ["first"]);
    assert.equal(lan.hits.length, 1);
    rmSync(process.env.API_ANYTHING_HOME, { recursive: true, force: true });
  } finally {
    await front.close();
    await lan.close();
  }
});
