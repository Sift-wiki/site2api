import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { judge } from "../src/classify.js";
import { type CallResult, call as libraryCall } from "../src/execute.js";
import { buildRequest } from "../src/http.js";
import { asTable, createServer, createToolset, type ServerOptions } from "../src/mcp.js";
import { MAX_OP_PATHS, openApiDocument, opResponseSchema } from "../src/openapi.js";
import { opDataSchema } from "../src/schema.js";
import { BODY_MAX, type Served, type ServeOptions, sameToken, serve, serveToken, tokenFile } from "../src/serve.js";
import { parseSite } from "../src/spec.js";
import { saveSite } from "../src/store.js";
import { type FakeRegistry, startRegistry } from "./fixture/registry.js";
import { type Fixture, startFixture } from "./fixture/server.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "a".repeat(64);
const SITE = "fx";

let fx: Fixture;
let registry: FakeRegistry;
let home: string;
const saved = { home: process.env.API_ANYTHING_HOME, registry: process.env.API_ANYTHING_REGISTRY };

before(async () => {
  home = mkdtempSync(join(tmpdir(), "aa-serve-"));
  process.env.API_ANYTHING_HOME = home;
  fx = await startFixture();
  registry = await startRegistry();
  process.env.API_ANYTHING_REGISTRY = registry.url;
  saveSite(
    parseSite({
      name: SITE,
      baseUrl: fx.url,
      description: "the fixture",
      operations: [
        {
          name: "user",
          description: "a user by name",
          readOnly: true,
          request: { method: "GET", url: `${fx.url}/api/spa/user?name=alice` },
          slots: [{ param: "name", at: ["query:name"] }],
          params: [{ name: "name", description: "the user's name", example: "alice" }],
          response: { pick: ["name"] },
          trigger: { url: `${fx.url}/spa/{name}` },
        },
        {
          name: "items",
          description: "a list of items",
          readOnly: true,
          request: { method: "GET", url: `${fx.url}/api/result-list` },
          response: { extract: "items", pick: ["id", "title"] },
          trigger: { url: fx.url },
        },
        {
          name: "order",
          readOnly: false,
          request: {
            method: "POST",
            url: `${fx.url}/api/order`,
            headers: { "content-type": "application/json" },
            body: '{"item":"x"}',
          },
          slots: [{ param: "item", at: ["body", "json:/item"] }],
          params: [{ name: "item" }],
          trigger: { url: fx.url },
        },
      ],
    }),
  );
});

after(async () => {
  await fx.close();
  await registry.close();
  for (const [k, v] of [
    ["API_ANYTHING_HOME", saved.home],
    ["API_ANYTHING_REGISTRY", saved.registry],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  rmSync(home, { recursive: true, force: true });
});

async function started(o: ServeOptions = {}): Promise<Served> {
  return serve({ port: 0, token: TOKEN, log: () => {}, ...o });
}

// biome-ignore lint/suspicious/noExplicitAny: answers and the OpenAPI document are walked as untyped JSON
type Doc = any;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Doc;
}

/** A request with full control of its headers (fetch would not send another Host). */
function http(
  s: Served,
  method: string,
  path: string,
  o: {
    headers?: Record<string, string>;
    body?: unknown;
    raw?: string | Buffer;
    /** sent in these pieces, chunked: no content-length */
    pieces?: Buffer[];
    auth?: boolean;
  } = {},
): Promise<Answer> {
  const payload = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: "127.0.0.1",
        port: s.port,
        method,
        path,
        headers: {
          ...(o.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
          ...(payload !== undefined ? { "content-type": "application/json" } : {}),
          ...o.headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: text ? JSON.parse(text) : undefined }),
        );
      },
    );
    r.on("error", reject);
    for (const piece of o.pieces ?? []) r.write(piece);
    r.end(payload);
  });
}

/** An in-process MCP client of a server made with `opts`: what the tool answers, as JSON. */
async function mcpClient(opts: ServerOptions = {}) {
  const client = new Client({ name: "probe", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(opts).connect(a);
  await client.connect(b);
  return {
    tool: async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse((r.content as { text: string }[])[0]!.text);
    },
    close: () => client.close(),
  };
}

/**
 * A REST answer as MCP sends the same one: REST's data is call()'s records, which MCP sends through
 * asTable, and only REST adds nextRequest.
 */
const asMcp = (v: Doc): Doc => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const { nextRequest: _, ...rest } = v;
  return {
    ...rest,
    ...("data" in rest ? { data: asTable(rest.data) } : {}),
    ...(Array.isArray(rest.results) ? { results: rest.results.map(asMcp) } : {}),
  };
};

/** Timings differ between two runs of one call: every `ms` goes. */
const noMs = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(noMs)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (k === "ms" ? [] : [[k, noMs(x)]])))
      : v;

test("serve: sameToken compares in constant time over any lengths", () => {
  assert.equal(sameToken(TOKEN, TOKEN), true);
  assert.equal(sameToken(`${TOKEN.slice(0, -1)}b`, TOKEN), false);
  assert.equal(sameToken("short", TOKEN), false, "a different length is a plain no, never a throw");
  assert.equal(sameToken("", TOKEN), false);
});

test("serve: the token file is made once, 0600, and API_ANYTHING_TOKEN wins over it", () => {
  const before = process.env.API_ANYTHING_TOKEN;
  delete process.env.API_ANYTHING_TOKEN;
  try {
    const first = serveToken();
    assert.equal(first.file, tokenFile());
    assert.match(first.token, /^[0-9a-f]{64}$/);
    assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
    assert.deepEqual(serveToken(), first, "a second start reads the same token");
    process.env.API_ANYTHING_TOKEN = "from-the-environment";
    assert.deepEqual(serveToken(), { token: "from-the-environment" });
  } finally {
    if (before === undefined) delete process.env.API_ANYTHING_TOKEN;
    else process.env.API_ANYTHING_TOKEN = before;
  }
});

test("serve: health needs no token, everything else does", async () => {
  const s = await started();
  try {
    const health = await http(s, "GET", "/v1/health", { auth: false });
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(typeof health.body.version, "string");
    for (const path of ["/v1/sites", "/openapi.json", "/v1/jobs/x"]) {
      const none = await http(s, "GET", path, { auth: false });
      assert.equal(none.status, 401, path);
      assert.equal(none.body.ok, false);
      assert.equal(typeof none.body.error, "string");
    }
    const wrong = await http(s, "GET", "/v1/sites", { auth: false, headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    const basic = await http(s, "GET", "/v1/sites", { auth: false, headers: { authorization: `Basic ${TOKEN}` } });
    assert.equal(basic.status, 401);
    const mcp = await http(s, "POST", "/mcp", { auth: false, body: {} });
    assert.equal(mcp.status, 401, "MCP over HTTP needs the token too");
    assert.equal((await http(s, "GET", "/v1/sites")).status, 200);
  } finally {
    await s.close();
  }
});

test("serve: refuses an Origin not listed and a Host that is not loopback; a listed origin gets CORS", async () => {
  const s = await started({ cors: ["https://app.example.com"] });
  try {
    const evil = await http(s, "GET", "/v1/sites", { headers: { origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.ok, false);
    const evilHealth = await http(s, "GET", "/v1/health", { headers: { origin: "https://evil.example" } });
    assert.equal(evilHealth.status, 403, "a page cannot even probe the server");
    const ok = await http(s, "GET", "/v1/sites", { headers: { origin: "https://app.example.com" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["access-control-allow-origin"], "https://app.example.com");
    const preflight = await http(s, "OPTIONS", "/v1/call/fx/user", {
      auth: false,
      headers: { origin: "https://app.example.com", "access-control-request-method": "POST" },
    });
    assert.equal(preflight.status, 204);
    assert.match(String(preflight.headers["access-control-allow-headers"]), /authorization/);

    const rebound = await http(s, "GET", "/v1/sites", { headers: { host: `evil.example:${s.port}` } });
    assert.equal(rebound.status, 403, "DNS rebinding: a name that resolves to 127.0.0.1 is still refused");
    for (const host of [`localhost:${s.port}`, `127.0.0.1:${s.port}`, `[::1]:${s.port}`])
      assert.equal((await http(s, "GET", "/v1/health", { headers: { host } })).status, 200, host);
    assert.equal((await http(s, "GET", "/v1/health", { headers: { host: "localhost:1" } })).status, 403);
  } finally {
    await s.close();
  }
  await assert.rejects(() => started({ cors: ["*"] }), /not \*/);
  const tunnel = await started({ publicUrl: "https://abc.trycloudflare.com" });
  try {
    const via = await http(tunnel, "GET", "/v1/health", { headers: { host: "abc.trycloudflare.com" } });
    assert.equal(via.status, 200, "--public-url's host is accepted");
  } finally {
    await tunnel.close();
  }
});

test("serve: each endpoint answers what the MCP tool answers for the same input, with data as records", async () => {
  const s = await started();
  const m = await mcpClient();
  try {
    const sites = await http(s, "GET", "/v1/sites");
    assert.equal(sites.status, 200);
    assert.deepEqual(sites.body, await m.tool("list_sites"));
    assert.ok(sites.body.some((x: { name: string }) => x.name === SITE));

    const ops = await http(s, "GET", `/v1/sites/${SITE}`);
    assert.deepEqual(asMcp(ops.body), await m.tool("list_operations", { site: SITE }));
    assert.deepEqual(
      ops.body.operations.map((o: { name: string }) => o.name),
      ["user", "items"],
      "writes stay hidden without --allow-writes",
    );
    assert.equal(ops.body.operations[0].inputSchema.type, "object");

    const find = await http(s, "GET", "/v1/find?q=fixture");
    assert.equal(find.status, 200);
    assert.deepEqual(asMcp(find.body), await m.tool("find_sites", { query: "fixture" }));
    assert.equal((await http(s, "GET", "/v1/find")).status, 400, "q is required");

    const call = await http(s, "POST", `/v1/call/${SITE}/user`, { body: { args: { name: "bob" } } });
    assert.equal(call.status, 200);
    assert.equal(call.body.ok, true);
    assert.deepEqual(call.body.data, { name: "bob" });
    assert.deepEqual(
      noMs(asMcp(call.body)),
      noMs(await m.tool("call_operation", { site: SITE, op: "user", args: { name: "bob" } })),
    );
    const tier1 = await http(s, "POST", `/v1/call/${SITE}/user`, {
      body: { args: { name: "carol" }, maxTier: 1, maxAgeMs: 1000, changes: true, changesOnly: false, watch: "w" },
    });
    assert.equal(tier1.body.tier, 1);

    // the read cache and comparison reach call(): a first comparison, then a kept answer
    const watched = await http(s, "POST", `/v1/call/${SITE}/user`, { body: { args: { name: "fern" }, changes: true } });
    assert.deepEqual(watched.body.changes?.first, true, JSON.stringify(watched.body));
    const kept = await http(s, "POST", `/v1/call/${SITE}/user`, { body: { args: { name: "fern" }, maxAgeMs: 60_000 } });
    assert.equal(kept.body.cached, true, JSON.stringify(kept.body));
    const batchWatched = await http(s, "POST", "/v1/batch", {
      body: { calls: [{ site: SITE, op: "user", args: { name: "fern" } }], changesOnly: true },
    });
    assert.ok(batchWatched.body.results[0].changes, JSON.stringify(batchWatched.body));
    assert.equal(batchWatched.body.results[0].data, undefined, "changesOnly leaves data out");
    const tooOld = await http(s, "POST", `/v1/call/${SITE}/user`, { body: { args: { name: "x" }, maxAgeMs: -1 } });
    assert.equal(tooOld.status, 400, "call_operation's own schema checks them");

    // a list of records: the library's records over REST, where MCP sends {columns, rows}
    const list = await http(s, "POST", `/v1/call/${SITE}/items`, { body: {} });
    const library = await libraryCall(SITE, "items", {}, { maxTier: 1 });
    assert.ok(Array.isArray(list.body.data) && list.body.data.length >= 2, JSON.stringify(list.body));
    assert.equal(list.body.columns, undefined);
    assert.deepEqual(list.body.data, library.data);
    const listViaMcp = await m.tool("call_operation", { site: SITE, op: "items" });
    assert.deepEqual(Object.keys(listViaMcp.data), ["columns", "rows"], "MCP keeps its table");
    assert.deepEqual(noMs(asMcp(list.body)), noMs(listViaMcp));

    // a failed call ran: 200, with ok and class saying how
    const bad = await http(s, "POST", `/v1/call/${SITE}/user`, { body: { args: { nope: 1 } } });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.class, "input");
    assert.deepEqual(
      noMs(asMcp(bad.body)),
      noMs(await m.tool("call_operation", { site: SITE, op: "user", args: { nope: 1 } })),
    );

    const view = { maxChars: 256 };
    const cut = await http(s, "POST", `/v1/call/${SITE}/items`, { body: { view } });
    assert.ok(cut.body.resultId, "a capped answer is kept");
    assert.ok(Array.isArray(cut.body.data), "a cut list is records too");
    assert.equal(cut.body.nextRequest.method, "GET");
    assert.equal(
      cut.body.nextRequest.path,
      `/v1/results/${cut.body.resultId}?offset=${cut.body.more.offset}&maxChars=${view.maxChars}`,
      "the rest, as GET /v1/results with more's offset",
    );
    const rest = await http(s, "GET", cut.body.nextRequest.path);
    assert.equal(rest.body.ok, true, JSON.stringify(rest.body));
    assert.notDeepEqual(rest.body.data[0], cut.body.data[0], "it continues where the cut answer stopped");
    const viaMcp = await m.tool("get_result", { resultId: cut.body.resultId, offset: 2, fields: ["title"] });
    const viaRest = await http(s, "GET", `/v1/results/${cut.body.resultId}?offset=2&fields=title`);
    assert.equal(viaRest.status, 200);
    assert.ok(Array.isArray(viaRest.body.data), JSON.stringify(viaRest.body));
    assert.deepEqual(asMcp(viaRest.body), viaMcp);
    assert.equal((await http(s, "GET", `/v1/results/${cut.body.resultId}?offset=-1`)).status, 400);

    const items = [
      { site: SITE, op: "user", args: { name: "dan" } },
      { id: "w", site: SITE, op: "order", args: { item: "y" } },
      { site: SITE, op: "items" },
    ];
    const batch = await http(s, "POST", "/v1/batch", { body: { calls: items, concurrency: 1 } });
    assert.equal(batch.status, 200);
    assert.deepEqual(noMs(asMcp(batch.body)), noMs(await m.tool("call_batch", { items, concurrency: 1 })));
    assert.equal(batch.body.results[1].class, "input", "writes are not batched");
    assert.deepEqual(batch.body.results[2].data, library.data, "a batch's list is records too");

    const job = await http(s, "GET", "/v1/jobs/deadbeef");
    assert.equal(job.status, 200);
    assert.deepEqual(asMcp(job.body), await m.tool("get_job", { job: "deadbeef" }));
  } finally {
    await m.close();
    await s.close();
  }
});

test("serve: malformed bodies and args that fail the schema are 400; unknown routes 404 JSON", async () => {
  const s = await started();
  try {
    const cases: [string, string, Parameters<typeof http>[3]][] = [
      ["POST", `/v1/call/${SITE}/user`, { raw: "{not json" }],
      ["POST", `/v1/call/${SITE}/user`, { body: [1, 2] }],
      ["POST", `/v1/call/${SITE}/user`, { body: { args: "name=bob" } }],
      ["POST", `/v1/call/${SITE}/user`, { body: { arg: { name: "bob" } } }],
      ["POST", `/v1/call/${SITE}/user`, { body: { maxTier: 4 } }],
      ["POST", `/v1/call/${SITE}/user`, { body: { view: { maxChars: 1 } } }],
      ["POST", "/v1/batch", { body: { calls: Array.from({ length: 21 }, () => ({ site: SITE, op: "user" })) } }],
      ["POST", "/v1/batch", { body: { calls: [{ site: SITE }] } }],
      ["POST", "/v1/batch", { body: { calls: [], concurrency: 9 } }],
    ];
    for (const [method, path, o] of cases) {
      const r = await http(s, method, path, o);
      assert.equal(r.status, 400, `${method} ${path} ${o?.raw ?? JSON.stringify(o?.body)}`);
      assert.equal(r.body.ok, false);
      assert.equal(typeof r.body.error, "string");
    }
    for (const path of ["/", "/v2/sites", "/v1/nope", "/v1/call/fx", "/v1/call/fx/user/extra"]) {
      const r = await http(s, "GET", path);
      assert.equal(r.status, 404, path);
      assert.equal(r.headers["content-type"], "application/json");
      assert.equal(r.body.ok, false);
    }
    assert.equal((await http(s, "GET", `/v1/call/${SITE}/user`)).status, 405);
  } finally {
    await s.close();
  }
});

test("serve: a body over 1 MB is a 413 the client reads, with or without a declared length", async () => {
  const s = await started();
  try {
    const big = Buffer.alloc(BODY_MAX + 1, 0x20);
    // the answer comes before the upload ends: a socket closed under the sender would be a reset
    for (let i = 0; i < 10; i++) {
      const r = await http(s, "POST", `/v1/call/${SITE}/user`, { raw: big });
      assert.equal(r.status, 413);
      assert.equal(r.body.ok, false);
      const piece = Buffer.alloc(256 * 1024, 0x20);
      const chunked = await http(s, "POST", `/v1/call/${SITE}/user`, { pieces: Array(8).fill(piece) });
      assert.equal(chunked.status, 413);
    }
    const fits = await http(s, "POST", `/v1/call/${SITE}/user`, {
      raw: `{"args":{"name":"eve"}}${" ".repeat(1000)}`,
    });
    assert.equal(fits.status, 200);
  } finally {
    await s.close();
  }
});

test("serve: /v1/write exists only with allowWrites, and a write through /v1/call is refused", async () => {
  const off = await started();
  try {
    const r = await http(off, "POST", `/v1/write/${SITE}/order`, { body: { args: { item: "z" } } });
    assert.equal(r.status, 404);
    const calls = fx.calls.length;
    const read = await http(off, "POST", `/v1/call/${SITE}/order`, { body: { args: { item: "z" } } });
    assert.equal(read.status, 200);
    assert.equal(read.body.class, "refused");
    assert.equal(fx.calls.length, calls, "nothing was sent");
  } finally {
    await off.close();
  }
  const on = await started({ allowWrites: true });
  const m = await mcpClient({ allowWrites: true });
  try {
    const sent = await http(on, "POST", `/v1/write/${SITE}/order`, {
      body: { args: { item: "z" }, idempotencyKey: "k1" },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);
    assert.equal(sent.body.write, "accepted");
    const viaCall = await http(on, "POST", `/v1/call/${SITE}/order`, { body: { args: { item: "z" } } });
    assert.equal(viaCall.body.nextCall.tool, "call_write_operation", "the read tool points at the write tool");
    const readThere = await http(on, "POST", `/v1/write/${SITE}/user`, { body: { args: { name: "x" } } });
    assert.deepEqual(
      asMcp(readThere.body),
      await m.tool("call_write_operation", { site: SITE, op: "user", args: { name: "x" } }),
    );
    assert.deepEqual(
      readThere.body.nextRequest,
      { method: "POST", path: `/v1/call/${SITE}/user`, body: { args: { name: "x" } } },
      "the step as a REST request: the read endpoint",
    );
    const doc = (await http(on, "GET", "/openapi.json")).body;
    assert.ok(doc.paths["/v1/write/{site}/{op}"]);
    assert.equal(doc.paths[`/v1/call/${SITE}/order`], undefined, "no per-op path for a write");
  } finally {
    await m.close();
    await on.close();
  }
});

test("serve: a call still running at the deadline answers pending, and /v1/jobs follows it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let runs = 0;
  const slow = async (): Promise<CallResult> => {
    runs++;
    await gate;
    return { ok: true, class: "ok", data: { slow: true }, tier: 1, ms: 1 };
  };
  const s = await started({ waitMs: 50, run: { call: slow } });
  try {
    const first = await http(s, "POST", `/v1/call/${SITE}/user`, { body: { args: { name: "x" } } });
    assert.equal(first.status, 200);
    assert.equal(first.body.class, "pending");
    assert.equal(first.body.ok, false);
    const id = first.body.job;
    assert.equal(typeof id, "string");
    assert.deepEqual(first.body.nextRequest, { method: "GET", path: `/v1/jobs/${id}` });
    assert.equal(first.body.nextCall.tool, "get_job", "nextCall stays MCP's");
    const again = await http(s, "POST", `/v1/call/${SITE}/user`, { body: { args: { name: "x" } } });
    assert.equal(again.body.job, id, "an identical call joins the job");
    assert.equal(runs, 1);
    const still = await http(s, "GET", first.body.nextRequest.path);
    assert.equal(still.body.class, "pending");
    release();
    const done = await http(s, "GET", still.body.nextRequest.path);
    assert.equal(done.body.ok, true);
    assert.deepEqual(done.body.data, { slow: true });
  } finally {
    release();
    await s.close();
  }
});

test("serve: a write still on its way is joined whatever maxTier the second caller gives, never sent twice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let sends = 0;
  const slow = async (): Promise<CallResult> => {
    sends++;
    await gate;
    return { ok: true, class: "ok", write: "accepted", tier: 1, ms: 1 };
  };
  const s = await started({ allowWrites: true, waitMs: 50, run: { call: slow } });
  try {
    const first = await http(s, "POST", `/v1/write/${SITE}/order`, { body: { args: { item: "q" }, maxTier: 1 } });
    assert.equal(first.body.class, "pending");
    const second = await http(s, "POST", `/v1/write/${SITE}/order`, { body: { args: { item: "q" } } });
    assert.equal(second.body.job, first.body.job);
    assert.equal(sends, 1);
  } finally {
    release();
    await s.close();
  }
});

/** Structural problems of an OpenAPI 3.1 document; empty when it holds together. */
function openApiProblems(doc: Doc): string[] {
  const out: string[] = [];
  if (!/^3\.1\.\d+$/.test(doc.openapi ?? "")) out.push(`openapi ${doc.openapi}`);
  if (typeof doc.info?.title !== "string" || typeof doc.info?.version !== "string") out.push("info");
  if (!Array.isArray(doc.servers) || !doc.servers.every((s: Doc) => /^https?:\/\//.test(s.url))) out.push("servers");
  const schemes = doc.components?.securitySchemes ?? {};
  const security = (list: Doc[] | undefined, where: string) => {
    for (const req of list ?? [])
      for (const k of Object.keys(req)) if (!schemes[k]) out.push(`${where}: no scheme ${k}`);
  };
  security(doc.security, "root");
  const resolve = (ref: string) => {
    const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
    return m ? doc.components?.schemas?.[m[1]!] : undefined;
  };
  const schema = (s: Doc, where: string): void => {
    if (!s || typeof s !== "object" || Array.isArray(s)) return void out.push(`${where}: schema is not an object`);
    if (s.$ref !== undefined && !resolve(s.$ref)) out.push(`${where}: unresolved ${s.$ref}`);
    for (const [k, v] of Object.entries(s.properties ?? {})) schema(v, `${where}.${k}`);
    if (s.items !== undefined) schema(s.items, `${where}[]`);
    for (const key of ["anyOf", "oneOf", "allOf"])
      for (const [i, v] of (s[key] ?? []).entries()) schema(v, `${where}.${key}${i}`);
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean")
      schema(s.additionalProperties, `${where}.additionalProperties`);
    if (
      s.required !== undefined &&
      (!Array.isArray(s.required) || s.required.some((r: unknown) => typeof r !== "string"))
    )
      out.push(`${where}: required`);
  };
  for (const [name, s] of Object.entries(doc.components?.schemas ?? {})) schema(s, `components.${name}`);
  const ids = new Set<string>();
  for (const [path, item] of Object.entries<Doc>(doc.paths ?? {})) {
    if (!path.startsWith("/")) out.push(`${path}: not absolute`);
    const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const [method, op] of Object.entries<Doc>(item)) {
      const at = `${method.toUpperCase()} ${path}`;
      if (!["get", "post", "put", "delete", "patch", "options", "head"].includes(method)) out.push(`${at}: method`);
      if (typeof op.operationId !== "string" || !/^[A-Za-z0-9_]+$/.test(op.operationId))
        out.push(`${at}: operationId ${op.operationId}`);
      else if (ids.has(op.operationId)) out.push(`${at}: duplicate operationId ${op.operationId}`);
      else ids.add(op.operationId);
      for (const name of templated)
        if (!(op.parameters ?? []).some((p: Doc) => p.in === "path" && p.name === name && p.required === true))
          out.push(`${at}: path parameter ${name} not declared`);
      for (const p of op.parameters ?? []) schema(p.schema, `${at} param ${p.name}`);
      for (const [type, c] of Object.entries<Doc>(op.requestBody?.content ?? {}))
        schema(c.schema, `${at} body ${type}`);
      if (!op.responses || !Object.keys(op.responses).length) out.push(`${at}: no responses`);
      for (const [code, r] of Object.entries<Doc>(op.responses ?? {})) {
        if (typeof r.description !== "string") out.push(`${at} ${code}: description`);
        for (const [type, c] of Object.entries<Doc>(r.content ?? {})) schema(c.schema, `${at} ${code} ${type}`);
      }
      security(op.security, at);
    }
  }
  return out;
}

/** Whether `v` fits `s`, for the keywords the document uses. */
function fits(doc: Doc, s: Doc, v: unknown): boolean {
  if (s.$ref) return fits(doc, doc.components.schemas[s.$ref.split("/").pop()], v);
  if (s.anyOf) return s.anyOf.some((x: Doc) => fits(doc, x, v));
  const is = (t: string) =>
    t === "array"
      ? Array.isArray(v)
      : t === "object"
        ? !!v && typeof v === "object" && !Array.isArray(v)
        : t === "integer"
          ? Number.isInteger(v)
          : t === "null"
            ? v === null
            : typeof v === t;
  if (s.type && ![s.type].flat().some(is)) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (is("object") && s.type === "object") {
    const o = v as Record<string, unknown>;
    if ((s.required ?? []).some((k: string) => !(k in o))) return false;
    for (const [k, x] of Object.entries<Doc>(s.properties ?? {})) if (k in o && !fits(doc, x, o[k])) return false;
    if (s.additionalProperties === false && Object.keys(o).some((k) => !(k in (s.properties ?? {})))) return false;
  }
  if (Array.isArray(v) && s.items) return v.every((x) => fits(doc, s.items, x));
  return true;
}

test("serve: /openapi.json is a well-formed OpenAPI 3.1 document, and its per-op paths call as declared", async () => {
  const s = await started();
  try {
    const all = await http(s, "GET", "/openapi.json");
    assert.equal(all.status, 200);
    const doc = all.body;
    assert.deepEqual(openApiProblems(doc), []);
    assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc, "the document round-trips through JSON");
    assert.deepEqual(doc.security, [{ bearer: [] }]);
    assert.deepEqual(doc.components.securitySchemes.bearer, { type: "http", scheme: "bearer" });
    assert.deepEqual(doc.paths["/v1/health"].get.security, [], "health needs no token");
    const perOp = Object.keys(doc.paths).filter((p) => /^\/v1\/call\/[^{]/.test(p));
    assert.ok(perOp.length > 1 && perOp.length <= MAX_OP_PATHS, `${perOp.length} per-op paths`);
    for (const p of Object.values<Doc>(doc.paths))
      for (const op of Object.values<Doc>(p)) {
        assert.ok((op.description ?? "").length <= 300, `${op.operationId}: a custom GPT takes 300 characters`);
      }

    const only = await started({ sites: [SITE] });
    try {
      const mine = (await http(only, "GET", "/openapi.json")).body;
      assert.deepEqual(openApiProblems(mine), []);
      assert.deepEqual(
        Object.keys(mine.paths).filter((p) => /^\/v1\/call\/[^{]/.test(p)),
        [`/v1/call/${SITE}/user`, `/v1/call/${SITE}/items`],
      );
      assert.equal(mine.servers[0].url, only.url);
      const user = mine.paths[`/v1/call/${SITE}/user`].post;
      assert.equal(user.operationId, "fx__user");
      assert.match(user.description, /a user by name/);
      const bodySchema = user.requestBody.content["application/json"].schema;
      assert.deepEqual(bodySchema.properties.args.required, ["name"]);
      // the round trip: a request built from the document, an answer that fits what it declares
      const ajv = new AjvJsonSchemaValidator();
      for (const [path, item] of Object.entries<Doc>(mine.paths)) {
        if (!/^\/v1\/call\/[^{]/.test(path)) continue;
        const op = item.post;
        const args = op.requestBody.content["application/json"].schema.properties.args;
        const example = Object.fromEntries(
          Object.entries<Doc>(args.properties ?? {}).flatMap(([k, p]) => (p.examples ? [[k, p.examples[0]]] : [])),
        );
        const url = new URL(path, mine.servers[0].url);
        const r = await http(only, "POST", url.pathname, { body: { args: example } });
        assert.equal(r.status, 200, path);
        assert.equal(r.body.ok, true, `${path}: ${JSON.stringify(r.body)}`);
        const declared = op.responses["200"].content["application/json"].schema;
        assert.ok(fits(mine, declared, r.body), `${path}: the answer fits its schema: ${JSON.stringify(r.body)}`);
        const check = ajv.getValidator(declared)(r.body);
        assert.ok(check.valid, `${path}: ${check.errorMessage}: ${JSON.stringify(r.body)}`);
        assert.ok(declared.properties.data.properties || declared.properties.data.items, `${path}: data is described`);
        assert.ok(declared.properties.nextRequest, `${path}: nextRequest is declared`);
      }
    } finally {
      await only.close();
    }
  } finally {
    await s.close();
  }
});

test("serve: MCP over Streamable HTTP lists the tools and calls one, answering as REST does", async () => {
  const s = await started();
  const client = new Client({ name: "probe", version: "0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const t of ["list_sites", "find_sites", "list_operations", "call_operation", "get_job", "learn_site"])
      assert.ok(names.includes(t), t);
    assert.ok(!names.includes("call_write_operation"));
    const r = await client.callTool({
      name: "call_operation",
      arguments: { site: SITE, op: "user", args: { name: "zed" } },
    });
    const viaMcp = JSON.parse((r.content as { text: string }[])[0]!.text);
    const viaRest = await http(s, "POST", `/v1/call/${SITE}/user`, { body: { args: { name: "zed" } } });
    assert.deepEqual(noMs(viaMcp), noMs(asMcp(viaRest.body)));
    const list = await client.callTool({ name: "call_operation", arguments: { site: SITE, op: "items" } });
    const listViaMcp = JSON.parse((list.content as { text: string }[])[0]!.text);
    assert.deepEqual(Object.keys(listViaMcp.data), ["columns", "rows"], "MCP over HTTP keeps MCP's table");
    const unknown = await http(s, "POST", "/mcp", {
      headers: { "mcp-session-id": "nope", accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    assert.equal(unknown.status, 404);
  } finally {
    await client.close();
    await s.close();
  }
});

test("serve: the CLI prints one JSON line when listening, keeps the token off stdout, and stops on SIGTERM", async () => {
  const cliHome = mkdtempSync(join(tmpdir(), "aa-serve-cli-"));
  const env: NodeJS.ProcessEnv = { ...process.env, API_ANYTHING_HOME: cliHome, API_ANYTHING_REGISTRY: registry.url };
  delete env.API_ANYTHING_TOKEN;
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", "0", "--no-learn"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout! });
    const first = await new Promise<string>((resolve, reject) => {
      rl.on("line", (l) => {
        lines.push(l);
        if (lines.length === 1) resolve(l);
      });
      child.once("exit", (code) => reject(new Error(`exited ${code} before listening`)));
    });
    const line = JSON.parse(first);
    assert.deepEqual(Object.keys(line), ["ok", "version", "url", "mcp", "openapi", "tokenFile"]);
    assert.equal(line.ok, true);
    assert.match(line.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(line.url, "http://127.0.0.1:0");
    assert.equal(line.mcp, `${line.url}/mcp`);
    assert.equal(line.openapi, `${line.url}/openapi.json`);
    assert.equal(line.tokenFile, join(cliHome, "serve-token"));
    assert.equal(statSync(line.tokenFile).mode & 0o777, 0o600);
    const health = await fetch(`${line.url}/v1/health`);
    assert.equal(health.status, 200);
    const token = serveTokenAt(cliHome);
    const sites = await fetch(`${line.url}/v1/sites`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(sites.status, 200);
    const learn = await fetch(`${line.url}/v1/learn`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    assert.equal(learn.status, 404, "--no-learn hides /v1/learn");
    const port = Number(new URL(line.url).port);
    assert.match(await rawRequest(port, `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`), /^HTTP\/1\.1 400 /);
    assert.equal((await fetch(`${line.url}/v1/health`)).status, 200, "the bad request did not end the process");
    assert.equal(child.exitCode, null);
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
    assert.equal(code, 0);
    assert.equal(lines.length, 1, "nothing but the startup line on stdout");
    assert.ok(!lines[0]!.includes(token));
  } finally {
    child.kill("SIGKILL");
    rmSync(cliHome, { recursive: true, force: true });
  }
});

/** `head` (a request line and headers, no blank line) sent on a raw socket, with Connection: close: the answer as text. */
function rawRequest(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(`${head}Connection: close\r\n\r\n`));
    let text = "";
    sock.on("data", (d) => (text += d));
    sock.on("close", () => resolve(text));
    sock.on("error", reject);
  });
}

test("serve: a request target URL() cannot parse is a 400, with or without a token, and the server keeps serving", async () => {
  const s = await started();
  try {
    const host = `Host: 127.0.0.1:${s.port}\r\n`;
    for (const target of ["//[", "//[::1", "http://[x/v1/sites"]) {
      const anon = await rawRequest(s.port, `GET ${target} HTTP/1.1\r\n${host}`);
      assert.match(anon, /^HTTP\/1\.1 400 /, `${target}: ${anon}`);
      assert.match(anon, /"ok":false/);
      const signed = await rawRequest(s.port, `GET ${target} HTTP/1.1\r\n${host}Authorization: Bearer ${TOKEN}\r\n`);
      assert.match(signed, /^HTTP\/1\.1 400 /, target);
    }
    assert.equal((await http(s, "GET", "/v1/health")).status, 200);
    assert.equal((await http(s, "GET", "/v1/sites")).status, 200);
  } finally {
    await s.close();
  }
});

test("serve: guardProcess logs an unhandled rejection instead of letting it end the process", async () => {
  // in a process of its own: node:test fails any test whose process sees an unhandled rejection
  const dir = mkdtempSync(join(tmpdir(), "aa-serve-guard-"));
  try {
    const script = join(dir, "guard.mts");
    writeFileSync(
      script,
      [
        `import { guardProcess } from ${JSON.stringify(pathToFileURL(join(ROOT, "src/serve.ts")).href)};`,
        `guardProcess();`,
        `void Promise.reject(new Error("a handler's bug"));`,
        `setTimeout(() => process.stdout.write("alive\\n"), 100);`,
      ].join("\n"),
    );
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (err += d));
    const [code] = await once(child, "exit");
    assert.equal(code, 0, err);
    assert.equal(out, "alive\n");
    assert.match(err, /unhandled rejection: Error: a handler's bug/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve: an idle socket is closed after idleMs; the default is 120 s", async () => {
  const s = await started({ idleMs: 200 });
  try {
    assert.equal(s.server.timeout, 200);
    const sock = connect(s.port, "127.0.0.1");
    await once(sock, "connect");
    const t = Date.now();
    sock.write("GET /v1/health HTTP/1.1\r\n"); // and then nothing more
    sock.resume();
    await once(sock, "close");
    assert.ok(Date.now() - t < 5000, `closed after ${Date.now() - t} ms`);
  } finally {
    await s.close();
  }
  const d = await started();
  try {
    assert.equal(d.server.timeout, 120_000);
  } finally {
    await d.close();
  }
});

test("serve: past maxConcurrent a new call is a 429 at once and runs nothing; a permit is held until its job settles", async () => {
  const gates = new Map<string, () => void>();
  let open = false;
  let runs = 0;
  const slow = async (_site: string, _op: string, args: Record<string, unknown>): Promise<CallResult> => {
    runs++;
    if (!open) await new Promise<void>((r) => gates.set(String(args.name), r));
    return { ok: true, class: "ok", data: { name: args.name }, tier: 1, ms: 1 };
  };
  const s = await started({ waitMs: 50, maxConcurrent: 2, run: { call: slow as never } });
  const client = new Client({ name: "probe", version: "0" });
  const callOf = (name: string) => http(s, "POST", `/v1/call/${SITE}/user`, { body: { args: { name } } });
  try {
    const a = await callOf("a");
    const b = await callOf("b");
    assert.equal(a.body.class, "pending");
    assert.equal(b.body.class, "pending", "both answered: their permits stay held while they run");
    assert.equal(runs, 2);

    const c = await callOf("c");
    assert.equal(c.status, 429);
    assert.equal(c.headers["retry-after"], "2");
    assert.equal(c.body.ok, false);
    assert.equal(c.body.class, "rate");
    assert.equal(c.body.reason, "server busy");
    assert.equal(typeof c.body.retryAfterMs, "number");
    assert.equal(runs, 2, "refused before it ran");

    const joined = await callOf("a");
    assert.equal(joined.status, 200, "joining a running job takes no permit");
    assert.equal(joined.body.job, a.body.job);

    const batch = await http(s, "POST", "/v1/batch", { body: { calls: [{ site: SITE, op: "user" }] } });
    assert.equal(batch.status, 429);
    assert.equal(batch.body.class, "rate");

    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const viaMcp = await client.callTool({
      name: "call_operation",
      arguments: { site: SITE, op: "user", args: { name: "m" } },
    });
    const busy = JSON.parse((viaMcp.content as { text: string }[])[0]!.text);
    assert.equal(viaMcp.isError, true);
    assert.equal(busy.class, "rate");
    assert.equal(busy.reason, "server busy");
    assert.equal(runs, 2, "MCP over HTTP shares the limit");

    gates.get("a")!();
    assert.equal((await http(s, "GET", `/v1/jobs/${a.body.job}`)).body.ok, true);
    // one permit free: a batch running two calls at once needs two
    const wide = await http(s, "POST", "/v1/batch", {
      body: {
        calls: [
          { site: SITE, op: "user", args: { name: "d1" } },
          { site: "other", op: "user", args: { name: "d2" } },
        ],
        concurrency: 2,
      },
    });
    assert.equal(wide.status, 429, "a batch takes one permit per call it runs at once");
    const c2 = await callOf("c");
    assert.equal(c2.status, 200);
    assert.equal(c2.body.class, "pending");
    assert.equal(runs, 3);
    assert.equal((await callOf("e")).status, 429);
    gates.get("b")!();
    gates.get("c")!();
    await http(s, "GET", `/v1/jobs/${b.body.job}`);
    await http(s, "GET", `/v1/jobs/${c2.body.job}`);
    open = true;
    const after = await callOf("e");
    assert.equal(after.status, 200);
    assert.equal(after.body.ok, true, JSON.stringify(after.body));
  } finally {
    open = true;
    for (const release of gates.values()) release();
    await client.close();
    await s.close();
  }
});

test("serve: the token file is never seen half-written: 16 servers starting at once keep one token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aa-serve-race-"));
  try {
    const go = join(dir, "go");
    const script = join(dir, "start.mts");
    writeFileSync(
      script,
      [
        `import fs, { existsSync } from "node:fs";`,
        `import { syncBuiltinESMExports } from "node:module";`,
        // each write of a token is slow, so any start reading a file another is still writing sees it
        `const write = fs.writeFileSync;`,
        `fs.writeFileSync = (path, data, o) => {`,
        `  if (!String(path).includes("serve-token")) return write(path, data, o);`,
        `  const fd = fs.openSync(path, o?.flag ?? "w", o?.mode);`,
        `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);`,
        `  fs.writeSync(fd, data);`,
        `  fs.closeSync(fd);`,
        `};`,
        `syncBuiltinESMExports();`,
        `const { serveToken } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src/serve.ts")).href)});`,
        `process.stdout.write("ready\\n");`,
        `const wait = new Int32Array(new SharedArrayBuffer(4));`,
        `while (!existsSync(${JSON.stringify(go)})) Atomics.wait(wait, 0, 0, 1);`,
        `try { process.stdout.write(JSON.stringify(serveToken()) + "\\n"); } catch (e) { process.stdout.write(JSON.stringify({ error: String(e) }) + "\\n"); }`,
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, API_ANYTHING_HOME: join(dir, "home") };
    delete env.API_ANYTHING_TOKEN;
    const children = Array.from({ length: 16 }, () =>
      spawn(process.execPath, ["--import", "tsx", script], { cwd: ROOT, env, stdio: ["ignore", "pipe", "inherit"] }),
    );
    const outputs = children.map((child) => {
      const lines: string[] = [];
      const rl = createInterface({ input: child.stdout! });
      const ready = new Promise<void>((resolve) => {
        rl.on("line", (l) => {
          lines.push(l);
          if (l === "ready") resolve();
        });
        child.once("close", () => resolve());
      });
      return { ready, done: once(child, "close").then(() => lines) };
    });
    await Promise.all(outputs.map((o) => o.ready));
    writeFileSync(go, "");
    const answers = (await Promise.all(outputs.map((o) => o.done))).map((lines) => JSON.parse(lines.at(-1)!));
    const file = join(dir, "home", "serve-token");
    const token = readFileSync(file, "utf8").trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      answers,
      answers.map(() => ({ token, file })),
      "every start read the one token that won",
    );
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(join(dir, "home")).filter((f) => f.startsWith("serve-token")),
      ["serve-token"],
      "no temp file is left behind",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve: every bundled read's OpenAPI answer schema takes its recorded answers, youtube.suggest's strings and shapes it cannot know", () => {
  const ajv = new AjvJsonSchemaValidator();
  const noSession = { cookies: [], values: {} };
  const bundled = readdirSync(join(ROOT, "sites")).filter((f) => f.endsWith(".json"));
  const siteOf = (name: string) => parseSite(JSON.parse(readFileSync(join(ROOT, "sites", `${name}.json`), "utf8")));
  let reads = 0;
  for (const file of bundled) {
    const site = siteOf(file.slice(0, -5));
    for (const op of site.operations) {
      if (!op.readOnly) continue;
      const at = `${site.name}.${op.name}`;
      const valid = ajv.getValidator(opResponseSchema(op));
      const fits = (data: unknown) => valid({ ok: true, class: "ok", tier: 1, ms: 1, data }).valid;
      assert.ok(valid({ ok: false, class: "rate", reason: "server busy", retryAfterMs: 2000 }).valid, at);
      const data = opDataSchema(op);
      // what the recipe does not fix is open: a single result of any shape, items of any shape
      if (data.type !== "array")
        for (const one of [{}, "text", 1]) assert.ok(fits(one), `${at}: ${JSON.stringify(one)}`);
      if ((data.items as Doc)?.type !== "object")
        for (const list of [["text"], [1, 2], [{}]]) assert.ok(fits(list), `${at}: ${JSON.stringify(list)}`);
      reads++;
    }
  }
  assert.ok(reads > 300, String(reads));

  // the recorded answers, against the document's own per-op paths
  const fixtureDir = join(ROOT, "test", "fixture", "sites");
  const names = readdirSync(fixtureDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
  const tools = createToolset({});
  const doc: Doc = openApiDocument(tools, {
    url: "http://127.0.0.1:1",
    version: "0",
    allowWrites: false,
    learn: false,
    sites: names,
  });
  const declared = (site: string, op: string) =>
    doc.paths[`/v1/call/${site}/${op}`].post.responses["200"].content["application/json"].schema;
  let recorded = 0;
  for (const name of names) {
    const site = siteOf(name);
    const fixtures = JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8")) as Doc[];
    for (const f of fixtures) {
      const op = site.operations.find((o) => o.name === f.op)!;
      const j = judge(op, {
        status: f.status,
        headers: { "content-type": f.contentType },
        body: typeof f.body === "string" ? f.body : JSON.stringify(f.body),
        url: buildRequest(op, f.args, noSession).url,
      });
      assert.equal(j.class, "ok", `${name}.${f.op}: ${j.reason}`);
      const answer = { ok: true, class: "ok", tier: 1, ms: 1, data: j.data };
      const check = ajv.getValidator(declared(name, f.op))(answer);
      assert.ok(check.valid, `${name}.${f.op}: ${check.errorMessage}`);
      recorded++;
    }
  }
  assert.ok(recorded >= 8, String(recorded));

  // youtube.suggest answers a list of strings
  const suggest = siteOf("youtube").operations.find((o) => o.name === "suggest")!;
  const j = judge(suggest, {
    status: 200,
    headers: { "content-type": "text/javascript; charset=UTF-8" },
    body: 'window.google.ac.h(["kit",[["kittens",0,[512]],["kitten videos",0,[512,433]]],{"k":1,"q":"x"}])',
  });
  assert.equal(j.class, "ok", j.reason);
  assert.deepEqual(j.data, ["kittens", "kitten videos"]);
  const check = ajv.getValidator(declared("youtube", "suggest"))({
    ok: true,
    class: "ok",
    tier: 1,
    ms: 1,
    data: j.data,
  });
  assert.ok(check.valid, String(check.errorMessage));
});

function serveTokenAt(dir: string): string {
  const before = process.env.API_ANYTHING_HOME;
  const env = process.env.API_ANYTHING_TOKEN;
  process.env.API_ANYTHING_HOME = dir;
  delete process.env.API_ANYTHING_TOKEN;
  try {
    return serveToken().token;
  } finally {
    process.env.API_ANYTHING_HOME = before;
    if (env !== undefined) process.env.API_ANYTHING_TOKEN = env;
  }
}
