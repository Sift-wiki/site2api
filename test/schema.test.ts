import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { hostSite } from "../src/host.js";
import { createServer, type ServerOptions } from "../src/mcp.js";
import { callResultSchema, opDataSchema, orTable } from "../src/schema.js";
import { type Operation, parseSite } from "../src/spec.js";
import { saveSite } from "../src/store.js";

const ITEMS = Array.from({ length: 40 }, (_, i) => ({
  title: `a book with a long enough title, number ${i}`,
  n: `${i * 3} votes`,
  tags: ["fiction", "classic"],
}));
const HTML = `<ul>${[1, 2, 3].map((i) => `<li><a href="/b/${i}">Book ${i}</a><span>x</span><span>y</span></li>`).join("")}</ul>`;

/** One route per answer a site gives: data, a list page, each failure, one held until release(), a write. */
async function localSite() {
  const held: (() => void)[] = [];
  let released = false;
  const server = httpServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
    if (path === "/list") return json(200, { items: ITEMS });
    if (path === "/one") return json(200, { book: { title: "One", n: "4 votes" } });
    if (path === "/html") return res.writeHead(200, { "content-type": "text/html" }).end(HTML);
    if (path === "/auth") return json(401, { error: "sign in" });
    if (path === "/rate") return json(429, { error: "slow down" }, { "retry-after": "30" });
    if (path === "/error") return res.writeHead(500, { "content-type": "text/plain" }).end("boom");
    if (path === "/blocked")
      return res
        .writeHead(403, { "content-type": "text/html" })
        .end("<html><title>Just a moment...</title>cf-chl captcha</html>");
    if (path === "/drift") return json(200, { other: 1 });
    if (path === "/slow") {
      const answer = () => json(200, { items: ITEMS.slice(0, 2) });
      return void (released ? answer() : held.push(answer));
    }
    if (path === "/vote") return json(200, { voted: true });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const release = () => {
    released = true;
    for (const answer of held.splice(0)) answer();
  };
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    release,
    close: () => {
      release();
      server.close();
    },
  };
}

const LIST = { format: "json", extract: "items[*]", pick: ["title", "votes=n~(\\d+)", "tags"] };

const read = (base: string, name: string, path = `/${name}`, response: unknown = LIST) => ({
  name,
  readOnly: true,
  request: { method: "GET", url: `${base}${path}?q=x` },
  slots: [{ param: "q", at: ["query:q"] }],
  params: [{ name: "q", example: "x" }],
  response,
  trigger: { url: `${base}/` },
});

function saveSites(base: string): void {
  saveSite(
    parseSite({
      name: "fx",
      baseUrl: base,
      operations: [
        read(base, "list"),
        read(base, "one", "/one", { format: "json", extract: "book", pick: ["title", "votes=n~(\\d+)"] }),
        read(base, "html", "/html", {
          format: "html",
          html: { items: "li", fields: { name: "a", href: "a@href", tags: "all:span" } },
        }),
        {
          name: "vote",
          readOnly: false,
          request: {
            method: "POST",
            url: `${base}/vote`,
            headers: { "content-type": "application/json" },
            body: '{"id":"1"}',
          },
          slots: [{ param: "id", at: ["body", "json:/id"] }],
          params: [{ name: "id" }],
          trigger: { url: `${base}/` },
        },
      ],
    }),
  );
  // one site per failure: a rate limit cools its whole site down
  for (const name of ["auth", "rate", "error", "blocked", "drift", "slow"])
    saveSite(parseSite({ name: `fx-${name}`, baseUrl: base, operations: [read(base, name)] }));
}

/**
 * A client connected to a server made with `opts`, after tools/list, so the SDK's own client checks
 * every answer against the tool's outputSchema; `answer` checks it again, on the JSON text as sent.
 */
async function connect(opts: ServerOptions) {
  const client = new Client({ name: "probe", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(opts).connect(a);
  await client.connect(b);
  const { tools } = await client.listTools();
  const ajv = new AjvJsonSchemaValidator();
  const validators = new Map(
    tools.flatMap((t) => (t.outputSchema ? [[t.name, ajv.getValidator(t.outputSchema)] as const] : [])),
  );
  const seen = new Set<string>();
  const classes = new Set<string>();
  const answer = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const sent = JSON.parse((r.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    assert.deepEqual(r.structuredContent, sent, name);
    const check = validators.get(name)!(sent);
    assert.ok(check.valid, `${name} ${JSON.stringify(args)}: ${check.errorMessage}\n${JSON.stringify(sent)}`);
    seen.add(name);
    if (typeof sent.class === "string") classes.add(sent.class);
    return { ...sent, isError: r.isError === true } as Record<string, unknown> & { isError: boolean };
  };
  return { client, tools, answer, seen, classes };
}

test("every MCP tool's answers match its declared outputSchema: success, each failure class, a job, a cut answer", async () => {
  const env = {
    browser: process.env.API_ANYTHING_BROWSER,
    registry: process.env.API_ANYTHING_REGISTRY,
  };
  const home = mkdtempSync(join(tmpdir(), "aa-schema-"));
  process.env.API_ANYTHING_HOME = home;
  // no Chrome, so a page run fails at once, and a registry that refuses: nothing leaves localhost
  process.env.API_ANYTHING_BROWSER = join(home, "no-chrome");
  process.env.API_ANYTHING_REGISTRY = "http://127.0.0.1:1";
  const site = await localSite();
  const servers: Client[] = [];
  let closeWindow: () => void = () => {};
  try {
    saveSites(site.base);
    const window: NonNullable<ServerOptions["run"]>["window"] = async (name) =>
      name === "fx"
        ? { ok: true, cookies: [], renewed: ["sid"] }
        : { ok: false, cookies: [], renewed: [], reason: "the window was closed before a sign-in" };
    const s = await connect({ allowWrites: true, sites: ["fx"], waitMs: 30_000, run: { window } });
    servers.push(s.client);
    const declared = s.tools.filter((t) => t.outputSchema).map((t) => t.name);
    // a list is sent as text only, and a client requires structuredContent of a tool with a schema
    assert.equal(s.tools.find((t) => t.name === "list_sites")!.outputSchema, undefined);
    for (const name of ["call_operation", "call_batch", "get_job", "get_result", "fx__list", "learn_site"])
      assert.ok(declared.includes(name), name);

    // reads, through each tool that sends one
    const ok = await s.answer("call_operation", { site: "fx", op: "list", args: { q: "a" } });
    assert.deepEqual([ok.ok, ok.class], [true, "ok"]);
    assert.ok((ok.data as { columns?: string[] }).columns, "a list of records is sent as a table");
    assert.equal((await s.answer("fx__list", { q: "a" })).ok, true);
    assert.equal((await s.answer("fx__one", { q: "a" })).ok, true);
    assert.equal((await s.answer("fx__html", { q: "a" })).ok, true);

    // a cut answer, then its rest, kept locally
    const cut = await s.answer("call_operation", { site: "fx", op: "list", args: { q: "b" }, view: { maxChars: 256 } });
    assert.ok(cut.truncated && cut.resultId && cut.more, JSON.stringify(cut));
    const rest = await s.answer("get_result", cut.more as Record<string, unknown>);
    assert.equal(rest.ok, true);
    const fragment = await s.answer("get_result", { resultId: cut.resultId, format: "json", maxChars: 256 });
    assert.equal(fragment.encoding, "json");
    assert.equal((await s.answer("get_result", { resultId: "nope" })).class, "input");
    assert.equal((await s.answer("get_result", { resultId: "00000000-0000-0000-0000-000000000000" })).isError, true);

    // every failure class a call can end in offline
    for (const name of ["auth", "rate", "error", "blocked", "drift"]) {
      const r = await s.answer("call_operation", { site: `fx-${name}`, op: name, args: { q: "a" } });
      assert.deepEqual([r.ok, r.class, r.isError], [false, name, true]);
    }
    // the cool-down a rate limit starts: nothing sent
    assert.equal((await s.answer("call_operation", { site: "fx-rate", op: "rate", args: { q: "a" } })).cooling, true);
    assert.equal((await s.answer("call_operation", { site: "fx", op: "list", args: { nope: 1 } })).class, "input");
    assert.equal((await s.answer("fx__list", { nope: 1 })).class, "input");
    assert.equal((await s.answer("call_operation", { site: "fx", op: "vote", args: { id: "1" } })).class, "refused");
    assert.equal((await s.answer("call_operation", { site: "nowhere", op: "x" })).ok, false);

    // writes: sent, then held back as a duplicate, and a read refused by the write tool
    const vote = await s.answer("call_write_operation", { site: "fx", op: "vote", args: { id: "2" } });
    assert.deepEqual([vote.ok, vote.write], [true, "accepted"]);
    assert.equal(
      (await s.answer("call_write_operation", { site: "fx", op: "vote", args: { id: "2" } })).class,
      "duplicate",
    );
    assert.equal((await s.answer("fx__vote", { id: "2" })).class, "duplicate");
    assert.equal((await s.answer("call_write_operation", { site: "fx", op: "list", args: { q: "a" } })).class, "input");

    // a batch that partly fails
    const batch = await s.answer("call_batch", {
      items: [
        { site: "fx", op: "list", args: { q: "c" } },
        { id: "w", site: "fx", op: "vote", args: { id: "3" } },
        { site: "fx-auth", op: "auth", args: { q: "a" } },
      ],
    });
    assert.deepEqual(
      (batch.results as { ok: boolean }[]).map((r) => r.ok),
      [true, false, false],
    );

    // the listing tools, their errors included
    assert.ok(((await s.answer("list_operations", { site: "fx" })).operations as unknown[]).length);
    assert.equal(
      (await s.answer("list_operations", { site: "fx", prepare: { op: "list", link: 0, item: {} } })).class,
      "input",
    );
    assert.equal((await s.answer("list_operations", { site: "nowhere" })).isError, true);
    const found = await s.answer("find_sites", { query: "fx" });
    assert.ok(found.registryError && Array.isArray(found.matches), JSON.stringify(found));
    assert.equal((await s.answer("site_status", {})).ok, true);
    assert.equal((await s.answer("site_status", { site: "fx-rate" })).ok, true);
    assert.equal((await s.answer("site_status", { site: "nowhere" })).isError, true);
    assert.equal((await s.answer("login", {})).isError, true);
    assert.equal((await s.answer("login", { site: "fx" })).ok, false, "no import the user made");
    assert.equal((await s.answer("login", { site: "fx", mode: "window" })).ok, true);
    assert.equal((await s.answer("login", { site: "fx-auth", mode: "window" })).ok, false);
    assert.equal((await s.answer("get_job", { job: "00000000" })).isError, true);
    const learn = await s.answer("learn_site", {
      trigger: "http://127.0.0.1:1/s?q={q}",
      args: { q: "a" },
      args2: { q: "b" },
      args3: { q: "c" },
    });
    assert.deepEqual([learn.ok, learn.class], [false, "refused"]);

    // jobs: a call, a per-op tool, a batch and a sign-in still running at the deadline, then their results
    const slowWindow: NonNullable<ServerOptions["run"]>["window"] = async () => {
      await new Promise<void>((r) => (closeWindow = r));
      return { ok: true, cookies: [], renewed: [] };
    };
    const j = await connect({ sites: ["fx-slow"], waitMs: 20, run: { window: slowWindow } });
    servers.push(j.client);
    const jobs = [
      await j.answer("call_operation", { site: "fx-slow", op: "slow", args: { q: "a" } }),
      await j.answer("fx-slow__slow", { q: "b" }),
      await j.answer("call_batch", { items: [{ site: "fx-slow", op: "slow", args: { q: "c" } }] }),
      await j.answer("login", { site: "fx-slow", mode: "window" }),
    ];
    for (const p of jobs) assert.deepEqual([p.class, p.isError], ["pending", false], JSON.stringify(p));
    assert.equal((await j.answer("get_job", { job: jobs[0]!.job })).class, "pending");
    site.release();
    closeWindow();
    for (const p of jobs) {
      let r = await j.answer("get_job", { job: p.job });
      while (r.class === "pending") r = await j.answer("get_job", { job: p.job });
      assert.equal(r.ok, true, JSON.stringify(r));
    }

    for (const name of declared) assert.ok(s.seen.has(name) || j.seen.has(name), `${name} was not exercised`);
    const classes = new Set([...s.classes, ...j.classes]);
    for (const c of ["ok", "auth", "rate", "error", "blocked", "drift", "input", "refused", "duplicate", "pending"])
      assert.ok(classes.has(c), `no ${c} answer was checked`);
  } finally {
    site.release();
    closeWindow();
    for (const c of servers) await c.close();
    site.close();
    // API_ANYTHING_HOME stays on the removed home: a job a failed assertion left running writes there, not to a real one
    for (const [k, v] of [
      ["API_ANYTHING_BROWSER", env.browser],
      ["API_ANYTHING_REGISTRY", env.registry],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    rmSync(home, { recursive: true, force: true });
  }
});

const op = (response: unknown) =>
  parseSite({
    name: "s",
    baseUrl: "https://example.test",
    operations: [
      {
        name: "o",
        readOnly: true,
        request: { method: "GET", url: "https://example.test/" },
        response,
        trigger: { url: "https://example.test/" },
      },
    ],
  }).operations[0]! as Operation;

test("opDataSchema types only what the response recipe fixes: a list, its fields, a regex's string, an HTML field", () => {
  assert.deepEqual(opDataSchema(op({ format: "json" })), {});
  // a learned shape is one capture's: it types nothing
  assert.deepEqual(opDataSchema(op({ format: "json", extract: "a", shape: { a: "array", "a[].x": "number" } })), {});
  assert.deepEqual(opDataSchema(op({ format: "json", extract: "items[*]" })), { type: "array", items: {} });
  const list = opDataSchema(op(LIST)) as { type: string; items: { type?: string; properties: object } };
  assert.equal(list.type, "array");
  // a pick keeps a non-object item as it is
  assert.equal(list.items.type, undefined);
  assert.deepEqual(list.items.properties, { title: {}, votes: { type: "string" }, tags: {} });
  const html = opDataSchema(
    op({ format: "html", html: { items: "li", fields: { name: "a", href: "a@href", tags: "all:span" } } }),
  ) as { items: { type: string; properties: object } };
  assert.equal(html.items.type, "object");
  assert.deepEqual(html.items.properties, {
    name: { type: "string" },
    href: { type: "string" },
    tags: { type: "array" },
  });
  // no [*]: the pick's object, or a list of them
  const one = opDataSchema(op({ format: "json", extract: "book", pick: ["title", "ids=list[*].id"] }));
  assert.equal(one.type, undefined);
  assert.deepEqual(one.properties, { title: {}, ids: { type: "array" } });
  assert.deepEqual((one.items as { properties: object }).properties, one.properties);
  assert.deepEqual(orTable({}), {}, "data the recipe says nothing of stays unconstrained");
});

test("callResultSchema requires only ok, and hostSite gives each op its result schema beside params", () => {
  const schema = callResultSchema();
  assert.deepEqual(schema.required, ["ok"]);
  // no object closes itself to fields it does not name
  assert.ok(!JSON.stringify(schema).includes("additionalProperties"));
  const home = mkdtempSync(join(tmpdir(), "aa-schema-host-"));
  const before = process.env.API_ANYTHING_HOME;
  process.env.API_ANYTHING_HOME = home;
  try {
    saveSites("http://127.0.0.1:1");
    const d = hostSite("fx")!.operations.find((o) => o.op === "list")!;
    assert.deepEqual(d.resultSchema, callResultSchema(opDataSchema(op(LIST))));
  } finally {
    if (before === undefined) delete process.env.API_ANYTHING_HOME;
    else process.env.API_ANYTHING_HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
});
