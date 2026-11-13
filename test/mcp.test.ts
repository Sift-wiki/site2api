import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEADLINE } from "../src/deadline.js";
import { type CallResult, call } from "../src/execute.js";
import { Jobs } from "../src/jobs.js";
import {
  asTable,
  createServer,
  inputSchema,
  mcpNext,
  mcpNextCall,
  READ_HINTS,
  type ServerOptions,
  TOOL_NAME_MAX,
  toolName,
  UNTRUSTED_NOTE,
  WRITE_HINTS,
} from "../src/mcp.js";
import { saveSession } from "../src/session.js";
import { type Operation, parseSite } from "../src/spec.js";
import { loadSite, saveSite } from "../src/store.js";

/** A fresh home and a client connected to a server made with `opts`; `done` undoes both. */
async function connect(opts: ServerOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), "aa-mcp-"));
  const before = process.env.API_ANYTHING_HOME;
  process.env.API_ANYTHING_HOME = home;
  const client = new Client({ name: "probe", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    return { isError: r.isError === true, ...JSON.parse(text) };
  };
  return {
    client,
    tool,
    /** connects once the test saved its sites: the server reads them as it starts */
    start: async (o: ServerOptions = opts) => {
      await createServer(o).connect(a);
      await client.connect(b);
    },
    done: async () => {
      await client.close();
      process.env.API_ANYTHING_HOME = before;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A site with one read and one write against `base`; `readback`: the write is read back with the read. */
function saveMixed(base: string, name = "mw", readback = false): void {
  saveSite(
    parseSite({
      name,
      baseUrl: base,
      operations: [
        {
          name: "find",
          description: "find things by kind",
          readOnly: true,
          request: { method: "GET", url: `${base}/api/find?kind=book&page=1` },
          slots: [
            { param: "kind", at: ["query:kind"] },
            { param: "page", at: ["query:page"] },
          ],
          params: [
            { name: "kind", description: "what to find", enum: ["book", "film"], example: "book" },
            { name: "page", type: "number", required: false, default: 1, min: 1, max: 50 },
          ],
          paging: { param: "page", next: "next" },
          trigger: { url: `${base}/` },
        },
        {
          name: "vote",
          readOnly: false,
          request: {
            method: "POST",
            url: `${base}/api/vote`,
            headers: { "content-type": "application/json" },
            body: '{"id":"1"}',
          },
          slots: [{ param: "id", at: ["body", "json:/id"] }],
          params: [{ name: "id", pattern: "\\d+", hint: "digits" }],
          ...(readback ? { readback: { op: "find", args: { kind: "book" } } } : {}),
          trigger: { url: `${base}/` },
        },
      ],
    }),
  );
}

/** A site with one operation, for checking how --sites names and routes its per-op tool. */
function saveOne(name: string, op: string, readOnly: boolean): void {
  saveSite(
    parseSite({
      name,
      baseUrl: "https://example.test",
      operations: [
        {
          name: op,
          readOnly,
          request: { method: readOnly ? "GET" : "POST", url: `https://example.test/${name}/${op}` },
          trigger: { url: "https://example.test/" },
        },
      ],
    }),
  );
}

async function localSite() {
  let hits = 0;
  const server = httpServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" }).end('[{"title":"a"}]');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: () => hits,
    close: () => server.close(),
  };
}

const LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

test("MCP gives every tool every hint: reads read-only and idempotent, writes on a tool of their own", async () => {
  for (const allowWrites of [false, true]) {
    const s = await connect();
    try {
      await s.start({ allowWrites });
      const { tools } = await s.client.listTools();
      const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
      assert.deepEqual(hints.list_sites, LOCAL);
      assert.deepEqual(hints.list_operations, LOCAL);
      assert.deepEqual(hints.get_job, LOCAL);
      // a read is advertised as a read whether or not writes are on, so a client need not ask for each
      assert.deepEqual(hints.call_operation, READ_HINTS);
      // a sign-in changes the local session, never the site, and a repeat joins the first
      assert.deepEqual(hints.login, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      assert.deepEqual(hints.call_write_operation, allowWrites ? WRITE_HINTS : undefined);
      const callOp = tools.find((t) => t.name === "call_operation")!;
      assert.equal("again" in (callOp.inputSchema.properties ?? {}), false);
    } finally {
      await s.done();
    }
  }
  assert.deepEqual(READ_HINTS, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(WRITE_HINTS, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
});

test("MCP call_operation never sends a write, and points a writes-enabled server's caller at call_write_operation", async () => {
  const site = await localSite();
  const s = await connect();
  try {
    saveMixed(site.base);
    await s.start({ allowWrites: true });
    const r = await s.tool("call_operation", { site: "mw", op: "vote", args: { id: "9" } });
    assert.equal(site.hits(), 0);
    assert.deepEqual([r.ok, r.class, r.write, r.isError], [false, "refused", "not_sent", true]);
    assert.deepEqual(r.nextCall, {
      action: "allow_writes",
      site: "mw",
      op: "vote",
      tool: "call_write_operation",
      args: { site: "mw", op: "vote", args: { id: "9" } },
    });
    assert.match(r.next, /call_write_operation/);
    // and the write tool does not run a read: its hints would make a client ask for every one
    const read = await s.tool("call_write_operation", { site: "mw", op: "find", args: { kind: "book" } });
    assert.equal(site.hits(), 0);
    assert.deepEqual([read.ok, read.class, read.nextCall.tool], [false, "input", "call_operation"]);
  } finally {
    await s.done();
    site.close();
  }
});

test("MCP call_write_operation: a write's status, a duplicate refused with its next step, and the again argument", async () => {
  const site = await localSite();
  const s = await connect();
  try {
    saveMixed(site.base);
    await s.start({ allowWrites: true });
    const vote = (extra: Record<string, unknown> = {}) =>
      s.tool("call_write_operation", { site: "mw", op: "vote", args: { id: "9" }, ...extra });
    const first = await vote();
    assert.deepEqual([first.ok, first.write, first.isError], [true, "accepted", false]);
    const dup = await vote();
    assert.equal(site.hits(), 1);
    assert.deepEqual([dup.class, dup.write, dup.retry], ["duplicate", "not_sent", "no"]);
    assert.equal(dup.nextCall.action, "check_site");
    assert.match(dup.next, /again: true/);
    const again = await vote({ again: true });
    assert.equal(again.ok, true);
    assert.equal(site.hits(), 2);
    // a key added to a repeat of the keyless write is still that write
    const keyed = await vote({ idempotencyKey: "k0" });
    assert.deepEqual([keyed.class, site.hits()], ["duplicate", 2]);
    await vote({ args: { id: "10" }, idempotencyKey: "k1" });
    const replay = await vote({ args: { id: "10" }, idempotencyKey: "k1" });
    assert.equal(site.hits(), 3);
    assert.match(replay.reason, /that call's record/);
  } finally {
    await s.done();
    site.close();
  }
});

test("MCP names the tool for a next step one of its tools takes, with the call's own args for a retry", () => {
  assert.deepEqual(mcpNextCall({ action: "login", site: "x", op: "get", mode: "window" }), {
    action: "login",
    site: "x",
    op: "get",
    mode: "window",
    tool: "login",
    args: { site: "x", mode: "window" },
  });
  // a hint that asks for the window names that mode, with nothing of the CLI's flag left over
  const windowed = mcpNext(
    "ask the user to run api-anything login x --window and clear the challenge, then retry once",
  );
  assert.match(windowed, /the login tool \{"site":"x","mode":"window"\} \(the user signs in or clears the challenge/);
  assert.doesNotMatch(windowed, /--window/);
  // x was never imported, so the tool's import has nothing to refresh: the user runs it in a terminal
  assert.match(
    mcpNext("ask the user to run: api-anything login x; then retry once"),
    /^ask the user to run in a terminal: api-anything login x \(it imports/,
  );
  assert.equal(mcpNextCall({ action: "fix_args", site: "x" }).tool, "list_operations");
  // with no site (learn_site's own args) there is no list_operations call to make: one without its site is invalid
  assert.deepEqual(mcpNextCall({ action: "fix_args" }), { action: "fix_args" });
  assert.deepEqual(mcpNextCall({ action: "retry", site: "x", op: "get" }).args, { site: "x", op: "get" });
  const again = { tool: "x__get", args: { q: "a" } };
  assert.deepEqual(mcpNextCall({ action: "retry", site: "x", op: "get" }, again), {
    action: "retry",
    site: "x",
    op: "get",
    ...again,
  });
  assert.equal(mcpNextCall({ action: "relearn", site: "x", op: "get" }).tool, undefined);
  // the user signs in again in their own browser; login would only import the same cookies again
  assert.deepEqual(mcpNextCall({ action: "sign_in_browser", site: "x", op: "get", profile: "Chrome/Profile 1" }), {
    action: "sign_in_browser",
    site: "x",
    op: "get",
    profile: "Chrome/Profile 1",
  });
});

test("MCP points an auth failure at the login tool only for a session the user imported; else at the terminal", async () => {
  // a site whose one read always answers 401, as a signed-out session gets
  const server = httpServer((_req, res) => res.writeHead(401, { "content-type": "application/json" }).end("{}"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const s = await connect();
  try {
    for (const name of ["fresh", "imported"])
      saveSite(
        parseSite({
          name,
          baseUrl: base,
          operations: [
            {
              name: "me",
              readOnly: true,
              learnedLoggedIn: true,
              request: { method: "GET", url: `${base}/api/me` },
              trigger: { url: `${base}/` },
            },
          ],
        }),
      );
    saveSession("imported", { cookies: [], values: {}, source: "chrome:Default" });
    // plain HTTP only: the browser would only meet the same 401
    await s.start({ run: { call: (site, op, args, o) => call(site, op, args, { ...o, maxTier: 1 }) } });

    // never imported: the login tool would answer "MCP can only refresh a session the user imported"
    const r = await s.tool("call_operation", { site: "fresh", op: "me" });
    assert.equal(r.class, "auth", JSON.stringify(r));
    assert.deepEqual([r.nextCall.action, r.nextCall.tool], ["login", undefined]);
    assert.match(r.next, /ask the user to run in a terminal: api-anything login fresh \(.*no password\)/);
    assert.match(r.next, /api-anything login fresh --window to sign in by hand/);
    assert.doesNotMatch(r.next, /login tool/);
    const login = await s.tool("login", { site: "fresh" });
    assert.match(login.error, /only refresh a session the user imported/);

    // imported: the tool refreshes it (no call here: a refresh would read a real browser's cookies)
    assert.deepEqual(mcpNextCall({ action: "login", site: "imported", op: "me" }), {
      action: "login",
      site: "imported",
      op: "me",
      tool: "login",
      args: { site: "imported" },
    });
    assert.match(mcpNext("ask the user to run: api-anything login imported; then retry once"), /^the login tool/);
    // a window sign-in needs no import, whichever site
    assert.equal(mcpNextCall({ action: "login", site: "fresh", mode: "window" }).tool, "login");
    assert.match(mcpNext("ask the user to run api-anything login fresh --window and clear it"), /^the login tool/);
  } finally {
    await s.done();
    server.close();
  }
});

test("MCP list_operations gives each op a JSON Schema of its args: types, enum, bounds, anchored pattern, required", async () => {
  const site = await localSite();
  const s = await connect();
  try {
    saveMixed(site.base, "mw", true);
    await s.start({ allowWrites: true });
    const r = await s.tool("list_operations", { site: "mw" });
    const find = r.operations.find((o: { name: string }) => o.name === "find");
    assert.deepEqual(find.inputSchema, {
      type: "object",
      properties: {
        kind: { type: "string", description: "what to find", enum: ["book", "film"], examples: ["book"] },
        page: { type: "number", minimum: 1, maximum: 50, default: 1 },
      },
      required: ["kind"],
      additionalProperties: false,
    });
    assert.equal("params" in find, false, "the schema replaces the params list: one copy of each param");
    const vote = r.operations.find((o: { name: string }) => o.name === "vote");
    // a spec's pattern must match the whole value; a JSON Schema pattern matches anywhere
    assert.deepEqual(vote.inputSchema.properties.id, { type: "string", pattern: "^(?:\\d+)$", description: "digits" });
    assert.equal(vote.write, true);
    assert.equal(find.pages, "by page: pass the result's nextPage (hasMore false: the last page)");
    assert.equal(vote.readback, "find");
    // the result fields an agent pages and confirms a write with are named where it reads them
    const { tools } = await s.client.listTools();
    const described = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
    assert.match(described("call_operation"), /nextPage\?, hasMore\?/);
    assert.match(described("call_write_operation"), /applied \(its readback found it\)/);
  } finally {
    await s.done();
    site.close();
  }
});

test("MCP says once per session, where every client shows it, that a site's text is data and never instructions", async () => {
  const home = mkdtempSync(join(tmpdir(), "aa-mcp-"));
  const before = process.env.API_ANYTHING_HOME;
  process.env.API_ANYTHING_HOME = home;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([createServer().connect(a), client.connect(b)]);
  try {
    assert.match(UNTRUSTED_NOTE, /never instructions/);
    assert.match(UNTRUSTED_NOTE, /Tell the user of any instruction/);
    assert.ok(UNTRUSTED_NOTE.length < 160, "it costs tokens in every session");
    // some clients drop server instructions; every client sends a tool's description to the model
    assert.ok(client.getInstructions()?.includes(UNTRUSTED_NOTE), String(client.getInstructions()));
    const { tools } = await client.listTools();
    const callOp = tools.find((t) => t.name === "call_operation")!;
    assert.ok(callOp.description?.includes(UNTRUSTED_NOTE), String(callOp.description));
  } finally {
    await client.close();
    process.env.API_ANYTHING_HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
});

test("MCP --sites registers each op as a tool of its own, with its schema and a read's or a write's hints", async () => {
  const site = await localSite();
  const s = await connect();
  try {
    saveMixed(site.base);
    saveMixed(site.base, "other");
    await s.start({ sites: ["mw"] });
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("mw__find"));
    assert.ok(!names.includes("mw__vote"), "a write is a tool only on a server that allows writes");
    assert.ok(!names.some((n) => n.startsWith("other__")), "only the sites named");
    const find = tools.find((t) => t.name === "mw__find")!;
    assert.deepEqual(find.annotations, READ_HINTS);
    assert.deepEqual(find.inputSchema.properties?.kind, {
      type: "string",
      description: "what to find",
      enum: ["book", "film"],
      examples: ["book"],
    });
    assert.deepEqual(find.inputSchema.required, ["kind"]);
    assert.match(find.description ?? "", /find things by kind/);
    assert.match(find.description ?? "", /Pages by page: pass the result's nextPage/);
    const ok = await s.tool("mw__find", { kind: "film", page: 2 });
    assert.deepEqual([ok.ok, ok.data], [true, [{ title: "a" }]]);
    // the args are judged by call(), as through call_operation: nothing sent, the format said, a next step
    const bad = await s.tool("mw__find", { kind: "song" });
    assert.deepEqual([bad.ok, bad.class, bad.isError], [false, "input", true]);
    assert.match(bad.reason, /one of "book", "film"/);
    assert.equal(site.hits(), 1);
  } finally {
    await s.done();
    site.close();
  }
  const w = await connect();
  try {
    saveMixed(site.base);
    await w.start({ sites: ["mw"], allowWrites: true });
    const { tools } = await w.client.listTools();
    assert.deepEqual(tools.find((t) => t.name === "mw__vote")?.annotations, WRITE_HINTS);
  } finally {
    await w.done();
  }
});

test("MCP per-op tool names fit every client's limit and characters, and stay distinct when cut", () => {
  const op = (name: string) => ({ name }) as Pick<Operation, "name">;
  assert.equal(toolName("hacker-news", op("search")), "hacker-news__search");
  assert.match(toolName("hn.demo", op("links")), /^_hn_demo__links_[0-9a-f]{8}$/);
  assert.notEqual(toolName("hn.demo", op("links")), toolName("hn_demo", op("links")));
  assert.notEqual(toolName("a", op("b__c")), toolName("a__b", op("c")));
  assert.notEqual(toolName("a_", op("b")), toolName("a", op("_b")));
  const long = "x".repeat(80);
  const a = toolName("site", op(`${long}a`));
  const b = toolName("site", op(`${long}b`));
  for (const n of [a, b]) {
    assert.ok(n.length <= TOOL_NAME_MAX, n);
    assert.match(n, /^[a-zA-Z0-9_-]+$/);
  }
  assert.notEqual(a, b);
});

test("MCP lists portable output hints and prepares declared links without sending any request", async () => {
  const site = await localSite();
  const s = await connect();
  try {
    saveMixed(site.base);
    const spec = loadSite("mw")!.site;
    const find = spec.operations[0]!;
    find.response = {
      format: "json",
      pick: ["title"],
      shape: { "[].title": "string" },
    };
    find.links = [
      { from: "title", to: { op: "find", arg: "kind" } },
      { from: "title", to: { op: "vote", arg: "id" } },
    ];
    saveSite(spec);
    await s.start({ allowWrites: true });
    const listed = await s.tool("list_operations", { site: "mw" });
    assert.deepEqual(listed.operations[0].output, {
      cardinality: "list",
      fields: { title: { type: "string", source: "observed" } },
    });
    assert.deepEqual(listed.operations[0].links, find.links);
    const prepared = await s.tool("list_operations", {
      site: "mw",
      prepare: { op: "find", link: 0, item: { title: "book" } },
    });
    assert.deepEqual(prepared.nextCall, {
      tool: "call_operation",
      args: { site: "mw", op: "find", args: { kind: "book", page: 1 } },
    });
    const write = await s.tool("list_operations", {
      site: "mw",
      prepare: { op: "find", link: 1, item: { title: "123" } },
    });
    assert.equal(write.isError, true);
    assert.match(write.reason, /only offers links to read/);
    const missing = await s.tool("list_operations", {
      site: "mw",
      prepare: { op: "find", link: 0, item: {} },
    });
    assert.equal(missing.class, "input");
    assert.doesNotMatch(missing.reason, /book/);
    const absent = await s.tool("list_operations", {
      site: "uninstalled-contracts",
      prepare: { op: "find", link: 0, item: {} },
    });
    assert.equal(absent.missing, true);
    assert.equal(site.hits(), 0, "preparing never fetches, executes, or follows the link");
  } finally {
    await s.done();
    site.close();
  }
});

test("MCP prepares a link under the args limit: a transform's regex slow on the item is an error, not input", async () => {
  const site = await localSite();
  const s = await connect();
  const was = DEADLINE.args;
  try {
    saveMixed(site.base);
    const spec = loadSite("mw")!.site;
    // exponential in the run of a's: seconds without a limit
    spec.operations[0]!.links = [{ from: "title", to: { op: "find", arg: "kind" }, transform: "~((a+))+b" }];
    saveSite(spec);
    await s.start({ allowWrites: true });
    DEADLINE.args = 100;
    const t0 = performance.now();
    const slow = await s.tool("list_operations", {
      site: "mw",
      prepare: { op: "find", link: 0, item: { title: `${"a".repeat(29)}!` } },
    });
    assert.ok(performance.now() - t0 < 1500, `${Math.round(performance.now() - t0)} ms`);
    assert.deepEqual([slow.isError, slow.class], [true, "error"], JSON.stringify(slow));
    assert.match(slow.reason, /the link was not prepared: it took over 100 ms/);
    assert.equal(site.hits(), 0);
  } finally {
    DEADLINE.args = was;
    await s.done();
    site.close();
  }
});

test("MCP --sites keeps punctuation and separator-ambiguous operations distinct and routes each one", async () => {
  const pairs = [
    { site: "demo.site", op: "search", readOnly: true },
    { site: "demo_site", op: "search", readOnly: false },
    { site: "a", op: "b__c", readOnly: true },
    { site: "a__b", op: "c", readOnly: false },
  ];
  const expectedNames = pairs.map(({ site, op }) => toolName(site, { name: op } as Operation));
  assert.equal(new Set(expectedNames).size, pairs.length);

  const listed: string[][] = [];
  for (const order of [pairs, [...pairs].reverse()]) {
    const calls: string[] = [];
    const call = (async (site: string, op: string) => {
      calls.push(`${site}/${op}`);
      return { ok: true, class: "ok", data: [{ site, op }], tier: 1, ms: 0 };
    }) as unknown as NonNullable<ServerOptions["run"]>["call"];
    const s = await connect();
    try {
      for (const pair of pairs) saveOne(pair.site, pair.op, pair.readOnly);
      await s.start({ sites: order.map(({ site }) => site), allowWrites: true, run: { call } });
      const { tools } = await s.client.listTools();
      const perOp = tools.filter((t) => expectedNames.includes(t.name));
      listed.push(perOp.map((t) => t.name).sort());
      assert.equal(perOp.length, pairs.length);
      for (const [i, pair] of pairs.entries()) {
        const name = expectedNames[i]!;
        assert.deepEqual(tools.find((t) => t.name === name)?.annotations, pair.readOnly ? READ_HINTS : WRITE_HINTS);
        const result = await s.tool(name);
        assert.deepEqual(result.data, [{ site: pair.site, op: pair.op }]);
      }
      assert.deepEqual(
        calls,
        pairs.map(({ site, op }) => `${site}/${op}`),
      );
    } finally {
      await s.done();
    }
  }
  assert.deepEqual(listed[0], listed[1]);
});

test("MCP inputSchema keeps a number's enum as numbers, and an op with no params takes none", () => {
  const schema = inputSchema({
    params: [
      { name: "n", type: "number", required: true, enum: ["1", "2", "many"] },
      { name: "both", type: "boolean", required: false, enum: ["true", "false"] },
      { name: "yes", type: "boolean", required: false, enum: ["true"] },
      { name: "no", type: "boolean", required: false, enum: ["false"] },
      { name: "text", type: "string", required: false, enum: ["true", "false"] },
      { name: "plain", type: "boolean", required: false },
      { name: "invalid", type: "boolean", required: false, enum: ["true", "yes"] },
    ],
  } as unknown as Operation);
  assert.deepEqual(schema.properties, {
    n: { type: "number", enum: [1, 2, "many"] },
    both: { type: "boolean", enum: [true, false] },
    yes: { type: "boolean", enum: [true] },
    no: { type: "boolean", enum: [false] },
    text: { type: "string", enum: ["true", "false"] },
    plain: { type: "boolean" },
    invalid: { type: "boolean", enum: [true, "yes"] },
  });
  assert.deepEqual(inputSchema({ params: [] } as unknown as Operation), {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
});

test("MCP advertises typed boolean enums through list_operations and a per-op tool without weakening calls", async () => {
  const site = await localSite();
  const s = await connect();
  try {
    saveSite(
      parseSite({
        name: "flags",
        baseUrl: site.base,
        operations: [
          {
            name: "read",
            readOnly: true,
            request: { method: "GET", url: `${site.base}/api/flags?enabled=true` },
            slots: [{ param: "enabled", at: ["query:enabled"] }],
            params: [
              { name: "enabled", type: "boolean", enum: ["true", "false"] },
              { name: "trueOnly", type: "boolean", required: false, enum: ["true"] },
              { name: "falseOnly", type: "boolean", required: false, enum: ["false"] },
              { name: "count", type: "number", required: false, enum: ["1", "2", "many"] },
              { name: "mode", type: "string", required: false, enum: ["true", "false"] },
              { name: "plain", type: "boolean", required: false },
              { name: "invalid", type: "boolean", required: false, enum: ["yes"] },
            ],
            trigger: { url: `${site.base}/` },
          },
        ],
      }),
    );
    await s.start({ sites: ["flags"] });
    const listed = await s.tool("list_operations", { site: "flags" });
    const listedSchema = listed.operations[0].inputSchema;
    const { tools } = await s.client.listTools();
    const toolSchema = tools.find((t) => t.name === "flags__read")!.inputSchema;
    assert.deepEqual(toolSchema.properties, listedSchema.properties);
    assert.deepEqual(listedSchema.properties, {
      enabled: { type: "boolean", enum: [true, false] },
      trueOnly: { type: "boolean", enum: [true] },
      falseOnly: { type: "boolean", enum: [false] },
      count: { type: "number", enum: [1, 2, "many"] },
      mode: { type: "string", enum: ["true", "false"] },
      plain: { type: "boolean" },
      invalid: { type: "boolean", enum: ["yes"] },
    });

    assert.equal((await s.tool("flags__read", { enabled: true })).ok, true);
    assert.equal((await s.tool("flags__read", { enabled: "false" })).ok, true);
    const disallowed = await s.tool("flags__read", { enabled: true, falseOnly: true });
    assert.deepEqual([disallowed.ok, disallowed.class], [false, "input"]);
    assert.match(disallowed.reason, /one of "false"/);
    const invalid = await s.tool("flags__read", { enabled: true, invalid: true });
    assert.deepEqual([invalid.ok, invalid.class], [false, "input"]);
    assert.match(invalid.reason, /one of "yes"/);
    assert.equal(site.hits(), 2);
  } finally {
    await s.done();
    site.close();
  }
});

/** A call() that answers when `release` is called, counting how often it ran. */
function slowCall() {
  let runs = 0;
  let release: (r: CallResult) => void = () => {};
  const call = (() => {
    runs++;
    return new Promise<CallResult>((r) => (release = r));
  }) as unknown as NonNullable<ServerOptions["run"]>["call"];
  return { call, runs: () => runs, release: (r: CallResult) => release(r) };
}

test("MCP answers a call still running at its deadline with a job, and get_job reads it without running it again", async () => {
  const slow = slowCall();
  const s = await connect();
  try {
    await s.start({ waitMs: 20, run: { call: slow.call } });
    const pending = await s.tool("call_operation", { site: "x", op: "get", args: { q: "a" } });
    assert.deepEqual([pending.ok, pending.class, pending.isError, pending.retry], [false, "pending", false, "no"]);
    assert.match(pending.job, /^[0-9a-f]{8}$/);
    assert.deepEqual(pending.nextCall, { action: "get_job", tool: "get_job", args: { job: pending.job } });
    // the same call while it runs joins it: one run
    const joined = await s.tool("call_operation", { site: "x", op: "get", args: { q: "a" } });
    assert.equal(joined.job, pending.job);
    const still = await s.tool("get_job", { job: pending.job });
    assert.deepEqual([still.class, still.job], ["pending", pending.job]);
    slow.release({ ok: true, class: "ok", data: [1], tier: 1, ms: 5 });
    const done = await s.tool("get_job", { job: pending.job });
    assert.deepEqual([done.ok, done.data, done.isError], [true, [1], false]);
    // read again: the result stays, and nothing runs again
    assert.deepEqual((await s.tool("get_job", { job: pending.job })).data, [1]);
    assert.equal(slow.runs(), 1);
    const unknown = await s.tool("get_job", { job: "00000000" });
    assert.deepEqual([unknown.ok, unknown.isError], [false, true]);
    assert.match(unknown.next, /check the site/);
  } finally {
    await s.done();
  }
});

test("MCP answers a call that ends within its deadline directly, with no job", async () => {
  const s = await connect();
  try {
    const call = (async () => ({ ok: false, class: "drift", reason: "gone", ms: 1 })) as unknown as NonNullable<
      ServerOptions["run"]
    >["call"];
    await s.start({ waitMs: 1000, run: { call } });
    const r = await s.tool("call_operation", { site: "x", op: "get" });
    assert.deepEqual([r.class, r.job, r.isError], ["drift", undefined, true]);
    // the same answer as fields: a client gives its model one of the two, a program reads the fields
    const raw = await s.client.callTool({ name: "call_operation", arguments: { site: "x", op: "get" } });
    assert.deepEqual(raw.structuredContent, JSON.parse((raw.content as { text: string }[])[0]!.text));
    // a list is text only: before the 2026-07-28 revision structuredContent is an object
    const sites = await s.client.callTool({ name: "list_sites", arguments: {} });
    assert.equal(sites.structuredContent, undefined);
  } finally {
    await s.done();
  }
});

test("MCP login while a sign-in window for the site is open returns its job and opens no second window", async () => {
  let windows = 0;
  let close: () => void = () => {};
  const window = async () => {
    windows++;
    await new Promise<void>((r) => (close = r));
    return { ok: true as const, cookies: [], renewed: ["sid"] };
  };
  const s = await connect();
  try {
    await s.start({ waitMs: 20, run: { window } });
    const first = await s.tool("login", { url: "https://example.com/", mode: "window" });
    assert.equal(first.class, "pending");
    assert.match(first.next, /close it/);
    const second = await s.tool("login", { url: "https://example.com/", mode: "window" });
    const viaImport = await s.tool("login", { url: "https://example.com/" });
    assert.deepEqual([second.job, viaImport.job], [first.job, first.job]);
    assert.equal(windows, 1);
    close();
    const done = await s.tool("get_job", { job: first.job });
    assert.deepEqual([done.ok, done.site, done.source, done.renewed], [true, "example.com", "window", ["sid"]]);
  } finally {
    await s.done();
  }
});

test("jobs: a rejected job with no one waiting does not crash, and its error reaches the next reader", async () => {
  const jobs = new Jobs<string>(10);
  let fail: (e: Error) => void = () => {};
  const started = await jobs.start("k", "", () => new Promise<string>((_, rej) => (fail = rej)));
  assert.ok("job" in started);
  fail(new Error("boom"));
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(jobs.wait(started.job, 10), /boom/);
  // a finished key starts afresh
  const again = await jobs.start("k", "", async () => "ok");
  assert.deepEqual(again, { result: "ok" });
});

test("MCP sends a list of records as {columns, rows}, keys once, null for a missing field", () => {
  const data = [
    { airline: ["JetBlue"], price: 209, via: ["BOS"] },
    { airline: ["Delta"], price: 219 },
    { airline: ["United"], price: 229 },
  ];
  assert.deepEqual(asTable(data), {
    columns: ["airline", "price", "via"],
    rows: [
      [["JetBlue"], 209, ["BOS"]],
      [["Delta"], 219, null],
      [["United"], 229, null],
    ],
  });
});

test("MCP sends anything that is not a list of two or more records unchanged", () => {
  for (const data of [[{ a: 1 }], [], [1, 2], [[1], [2]], [{ a: 1 }, null], { a: 1 }, "text", null, undefined]) {
    assert.deepEqual(asTable(data), data);
  }
});

test("MCP keeps sparse records within the original answer's size instead of allocating missing cells", () => {
  const data = Array.from({ length: 1000 }, (_, i) => ({ [`k${i}`]: i }));
  const result = asTable(data);
  assert.equal(result, data);
  assert.equal(JSON.stringify(result).length, JSON.stringify(data).length);
});

test("MCP keeps small records when the table envelope would grow the answer", () => {
  for (const data of [
    [{ a: 1 }, { a: 2 }],
    [{}, {}],
    [{ a: 1 }, { b: 2 }],
  ])
    assert.equal(asTable(data), data);
});

test("MCP call_operation of an op the site lacks points at list_operations for that site, a call that runs as given", async () => {
  const s = await connect();
  try {
    await s.start();
    const r = await s.tool("call_operation", { site: "hacker-news", op: "nope" });
    assert.equal(r.class, "input");
    assert.deepEqual([r.nextCall.tool, r.nextCall.args], ["list_operations", { site: "hacker-news" }]);
    const listed = await s.tool(r.nextCall.tool, r.nextCall.args);
    assert.equal(listed.isError, false);
    assert.equal(listed.site, "hacker-news");
  } finally {
    await s.done();
  }
});
