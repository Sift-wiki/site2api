/**
 * What a heal's rescan may fetch and how much of it it reads: a page names its scripts and a server its
 * redirects, and neither chooses an address on this machine or network, nor how much is buffered.
 * No browser, an injected fetch, and a stubbed resolver.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { rescan } from "../src/heal.js";
import { MAX_BODY_BYTES, resolver } from "../src/http.js";
import { parseSite } from "../src/spec.js";

const HOME = mkdtempSync(join(tmpdir(), "api-anything-rescan-"));
process.env.API_ANYTHING_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

const OLD = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7H";
const NEW = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3S";
const TOKEN = `x={queryId:"${NEW}",operationName:"User"}`;
const HEALED = `path:1: ${OLD} -> ${NEW}`;

const userOp = (origin = "https://t.test") =>
  parseSite({
    name: "t",
    baseUrl: origin,
    operations: [
      {
        name: "user",
        readOnly: true,
        request: { method: "GET", url: `${origin}/api/${OLD}/User?name=alice`, headers: {} },
        slots: [{ param: "name", at: ["query:name"] }],
        volatile: [{ at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "User" }],
        trigger: { url: `${origin}/u/{name}` },
        params: [{ name: "name", example: "alice" }],
      },
    ],
  }).operations[0]!;

type Handler = (url: string) => Response;
let asked: string[] = [];
const fake = (h: Handler) =>
  (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    return h(url);
  }) as typeof fetch;
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
const tags = (...srcs: string[]) => html(srcs.map((s) => `<script src="${s}"></script>`).join(""));
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

const lookup = resolver.lookup;
let lookups: string[] = [];
beforeEach(() => {
  asked = [];
  lookups = [];
  resolver.lookup = async (host) => {
    lookups.push(host);
    return [{ address: host === "inward.example.net" ? "10.0.0.7" : "203.0.113.5" }];
  };
});
afterEach(() => {
  resolver.lookup = lookup;
});

const INSIDE = [
  "http://127.0.0.1:9/x.js",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]:9/x.js",
  "https://192.168.0.1/admin/status.js",
  "https://inward.example.net/a.js",
  "http://cdn.example.net/plain.js",
  "ftp://cdn.example.net/x.js",
];

test("a rescan fetches a page-named address only on the trigger's origin or on a public https host, at first and after a redirect", async () => {
  const page = (cdn: string): Handler => {
    return (url) => {
      if (url === "https://t.test/u/bob") return tags(...INSIDE, "https://hop.example.net/r.js", cdn);
      if (url === "https://hop.example.net/r.js") return redirect("http://127.0.0.1:9/y.js");
      if (url === "https://cdn.example.net/app.js") return new Response(TOKEN);
      if (url === "https://cdn.example.net/empty.js") return new Response("x=1");
      // everything else is an address inside: the token is there for the taking
      return new Response(TOKEN);
    };
  };
  assert.equal(await rescan("t", userOp(), { name: "bob" }, fake(page("https://cdn.example.net/empty.js"))), undefined);
  assert.deepEqual(asked.sort(), [
    "https://cdn.example.net/empty.js",
    "https://hop.example.net/r.js",
    "https://t.test/u/bob",
  ]);
  assert.deepEqual(lookups.sort(), ["cdn.example.net", "hop.example.net", "inward.example.net"]);

  asked = [];
  const healed = await rescan("t", userOp(), { name: "bob" }, fake(page("https://cdn.example.net/app.js")));
  assert.equal(healed?.diff, HEALED, "a public https script still heals");
  assert.ok(!asked.some((u) => INSIDE.includes(u) || u.includes("127.0.0.1")), asked.join("\n"));
});

test("a trigger that answers with a redirect inward is not followed; one to a public https host is", async () => {
  const inward: Handler = (url) => (url === "https://t.test/u/bob" ? redirect("http://127.0.0.1:9/") : html(TOKEN));
  assert.equal(await rescan("t", userOp(), { name: "bob" }, fake(inward)), undefined);
  assert.deepEqual(asked, ["https://t.test/u/bob"]);

  asked = [];
  const moved: Handler = (url) =>
    url === "https://t.test/u/bob"
      ? redirect("https://www.t.example.com/u/bob")
      : url === "https://www.t.example.com/u/bob"
        ? html(`<script>${TOKEN}</script>`)
        : new Response("", { status: 404 });
  assert.equal((await rescan("t", userOp(), { name: "bob" }, fake(moved)))?.diff, HEALED);
});

test("the trigger's own origin costs no lookup, on a public name or on this machine", async () => {
  for (const origin of ["https://t.test", "http://127.0.0.1:4010", "http://localhost:4010"]) {
    const h: Handler = (url) =>
      url === `${origin}/u/bob`
        ? tags("/static/main.js")
        : url === `${origin}/static/main.js`
          ? new Response(TOKEN)
          : new Response("", { status: 404 });
    const healed = await rescan("t", userOp(origin), { name: "bob" }, fake(h));
    assert.equal(healed?.diff, HEALED, origin);
  }
  assert.deepEqual(lookups, []);
  // another port of this machine is another origin: its script is not read
  const other: Handler = (url) =>
    url === "http://127.0.0.1:4010/u/bob" ? tags("http://127.0.0.1:4011/main.js") : new Response(TOKEN);
  assert.equal(await rescan("t", userOp("http://127.0.0.1:4010"), { name: "bob" }, fake(other)), undefined);
  assert.deepEqual(asked.slice(-1), ["http://127.0.0.1:4010/u/bob"]);
});

const MIB = new Uint8Array(1024 * 1024).fill(0x20);
/** A body of `mib` MiB of spaces, then `tail`, streamed; `pulled` counts what was asked of it. */
const big = (mib: number, tail: string, pulled: { bytes: number }) => {
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (sent < mib) {
            sent++;
            pulled.bytes += MIB.byteLength;
            c.enqueue(MIB);
          } else {
            c.enqueue(new TextEncoder().encode(tail));
            c.close();
          }
        },
      },
      { highWaterMark: 0 },
    ),
  );
};

test("a rescan stops reading a script past the body cap, and a declared length over it is not read at all", async () => {
  const over = MAX_BODY_BYTES / MIB.byteLength;
  const pulled = { bytes: 0 };
  const streamed: Handler = (url) => (url === "https://t.test/u/bob" ? tags("/big.js") : big(over, TOKEN, pulled));
  assert.equal(await rescan("t", userOp(), { name: "bob" }, fake(streamed)), undefined);
  assert.ok(pulled.bytes <= MAX_BODY_BYTES + 2 * MIB.byteLength, `read ${pulled.bytes} bytes`);

  pulled.bytes = 0;
  const declared: Handler = (url) => {
    if (url === "https://t.test/u/bob") return tags("/big.js");
    const r = big(1, TOKEN, pulled);
    return new Response(r.body, { headers: { "content-length": String(MAX_BODY_BYTES + 1) } });
  };
  assert.equal(await rescan("t", userOp(), { name: "bob" }, fake(declared)), undefined);
  assert.equal(pulled.bytes, 0);

  // the document itself is held to the same cap
  pulled.bytes = 0;
  const doc: Handler = () => big(over, `<script>${TOKEN}</script>`, pulled);
  assert.equal(await rescan("t", userOp(), { name: "bob" }, fake(doc)), undefined);
  assert.ok(pulled.bytes <= MAX_BODY_BYTES + 2 * MIB.byteLength, `read ${pulled.bytes} bytes`);
});

test("one rescan reads at most the body cap in all, and still uses what fit", async () => {
  const pulled = { bytes: 0 };
  const names = Array.from({ length: 8 }, (_, i) => `/chunk${i}.js`);
  const h: Handler = (url) => {
    if (url === "https://t.test/u/bob") return tags("/small.js", ...names);
    if (url === "https://t.test/small.js") return new Response(TOKEN);
    return big(8, "x=1", pulled); // 8 scripts of 8 MiB: twice the cap together
  };
  const healed = await rescan("t", userOp(), { name: "bob" }, fake(h));
  assert.ok(pulled.bytes <= MAX_BODY_BYTES + names.length * 2 * MIB.byteLength, `read ${pulled.bytes} bytes`);
  assert.equal(healed?.diff, HEALED, "the small script that fit still heals");
});

test("a rescan reads a document of unclosed script and link tags in linear time", async () => {
  const shapes = [
    "<script ",
    "<link ",
    `<script ${'src="'.repeat(400)}`,
    // an address that never closes, with a place to stop at every fourth character
    `<link href="${".js?".repeat(500)}`,
  ];
  for (const shape of shapes) {
    const doc = shape.repeat(Math.ceil(2_000_000 / shape.length));
    const t0 = performance.now();
    assert.equal(
      await rescan(
        "t",
        userOp(),
        { name: "bob" },
        fake(() => html(doc)),
      ),
      undefined,
    );
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${shape.slice(0, 20)}: ${Math.round(ms)} ms`);
  }
});

test("a rescan takes the same script and link addresses as before", async () => {
  const doc = [
    '<script src="/a.js"></script>',
    "<SCRIPT type='module' SRC='b.mjs?v=1'></SCRIPT>",
    '<script\n  defer\n  data-x="1"\n  src="https://cdn.example.net/c.js"></script>',
    '<script>var inline = "<script";</script>',
    '<script data-src="/lazy.js" async></script>',
    '<scripty src="/not-a-script.js"></scripty>',
    '<link rel="modulepreload" href="/d.mjs">',
    '<link rel="preload" as="script" href="/e.js?build=7">',
    '<link rel="stylesheet" href="/style.css">',
    '<link rel="icon" href="/js/icon.png">',
    '<a href="/page.js">not a link tag</a>',
    '<script src="/a.js"></script>',
  ].join("\n");
  const before = [
    ...doc.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ...doc.matchAll(/<link\b[^>]*\bhref=["']([^"']+\.m?js(?:\?[^"']*)?)["']/gi),
  ].map((m) => new URL(m[1]!, "https://t.test/u/bob").href);
  await rescan(
    "t",
    userOp(),
    { name: "bob" },
    fake((url) => (url === "https://t.test/u/bob" ? html(doc) : html(""))),
  );
  assert.deepEqual(asked.slice(1).sort(), [...new Set(before)].sort());
  assert.equal(new Set(before).size, 6);
});

test("a rescan fetches at most 40 addresses a document names, scripts first", async () => {
  const doc =
    Array.from({ length: 30 }, (_, i) => `<link rel="modulepreload" href="/l${i}.js">`).join("") +
    Array.from({ length: 30 }, (_, i) => `<script src="/s${i}.js"></script>`).join("");
  await rescan(
    "t",
    userOp(),
    { name: "bob" },
    fake((url) => (url === "https://t.test/u/bob" ? html(doc) : html(""))),
  );
  const fetched = asked.slice(1);
  assert.equal(fetched.length, 40);
  assert.equal(fetched.filter((u) => /\/s\d+\.js$/.test(u)).length, 30);
});
