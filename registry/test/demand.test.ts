/** What agents asked for and nobody shared: by domain only, never the words of a search, one count per network. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evidence, install, op, registry, send, site } from "./helpers.js";

const search = (env: ReturnType<typeof registry>["env"], q: string, ip = "198.51.100.7") =>
  send(env, "GET", `/v1/search?q=${encodeURIComponent(q)}`, { ip });

test("a domain or URL search that finds nothing is demand; the words of a search never are", async () => {
  const { env } = registry();
  await search(env, "https://www.zillow.com/homedetails/123-main-st");
  await search(env, "zillow.com", "198.51.100.99");
  await search(env, "zillow.com", "192.0.2.44");
  await search(env, "price history for my house on main street");
  await search(env, "redfin.com", "203.0.113.80");
  const r = await send(env, "GET", "/v1/demand");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.demand.map((d: { domain: string; networks: number }) => [d.domain, d.networks]),
    [
      ["zillow.com", 2],
      ["redfin.com", 1],
    ],
    "one network counts once; free text is not kept",
  );
});

test("a domain leaves the list once a site for it is shared, and the home page shows the list", async () => {
  const { env } = registry();
  await search(env, "https://bookshop.example.org/search?q=dune");
  await search(env, "example.com/books");
  const home = await send(env, "GET", "/");
  assert.match(home.text, /Asked for, not shared yet/);
  assert.match(home.text, /example\.org/);
  const up = await send(env, "POST", "/v1/versions", { as: install(), body: { site, operation: op(), evidence } });
  assert.equal(up.status, 201, up.text);
  const r = await send(env, "GET", "/v1/demand");
  assert.deepEqual(
    r.body.demand.map((d: { domain: string }) => d.domain),
    ["example.org"],
  );
});

test("at the edge, a search that recorded demand is not cached, so every network asking is counted", async () => {
  const { env } = registry();
  const store = new Map<string, Response>();
  const g = globalThis as { caches?: unknown };
  g.caches = {
    default: {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => void store.set(r.url, res),
    },
  };
  try {
    for (const ip of ["198.51.100.7", "192.0.2.44", "203.0.113.80"]) await search(env, "zillow.com", ip);
    const r = await send(env, "GET", "/v1/demand");
    assert.equal(r.body.demand[0].networks, 3);
  } finally {
    delete g.caches;
  }
});

test("searches are budgeted per network: past the hour's limit answers 429 with Retry-After", async () => {
  const { env } = registry({ SEARCHES_PER_HOUR: "2" });
  assert.equal((await search(env, "first", "198.51.100.20")).status, 200);
  assert.equal((await search(env, "second", "198.51.100.20")).status, 200);
  const over = await search(env, "third", "198.51.100.20");
  assert.equal(over.status, 429, over.text);
  assert.match(over.body.error, /2 searches an hour from this network/);
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  // another network has its own budget
  assert.equal((await search(env, "fourth", "203.0.113.21")).status, 200);
});
