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

const listed = async (env: ReturnType<typeof registry>["env"]) =>
  (await send(env, "GET", "/v1/demand")).body.demand.map((d: { domain: string }) => d.domain);

test("one network adds at most DEMAND_PER_HOUR domains an hour, and the search is still answered", async () => {
  const { env, raw } = registry();
  for (let i = 0; i < 25; i++) {
    const r = await search(env, `wanted-site-${i}.com`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { matches: [] });
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.equal((await listed(env)).length, 20);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM demand").get() as { n: number }).n, 20);
  // another network still has its own
  await search(env, "redfin.com", "192.0.2.44");
  assert.ok((await listed(env)).includes("redfin.com"));
  // a name domainOf reads and no domain can have
  await search(env, "under_score.com", "203.0.113.80");
  assert.ok(!(await listed(env)).includes("under_score.com"));
});

test("every network together adds at most DEMAND_PER_HOUR_ALL domains an hour", async () => {
  const { env } = registry({ DEMAND_PER_HOUR: "2", DEMAND_PER_HOUR_ALL: "3" });
  // the first network's third is refused, and takes nothing from everyone's budget
  for (let i = 0; i < 3; i++) await search(env, `wanted-site-${i}.com`, "198.51.100.7");
  for (let i = 3; i < 6; i++) await search(env, `wanted-site-${i}.com`, `100.64.${i}.1`);
  assert.deepEqual((await listed(env)).sort(), ["wanted-site-0.com", "wanted-site-1.com", "wanted-site-3.com"]);
});

test("a host that is not public is never demand, and one recorded before the rule is not listed", async () => {
  const { env, raw } = registry();
  const internal = [
    "https://jira.corp-zeta.internal/browse/SEC-1?token=t",
    "wiki.corp-zeta.internal",
    "https://printer.home.arpa/status",
    "7.168.192.in-addr.arpa",
    "nas.local",
    "router.lan",
    "app.test",
    "shop.example",
    "old.invalid",
    "http://192.168.7.20:8080/admin",
    "http://localhost:3000/debug",
    "intranet",
  ];
  for (const q of internal) assert.equal((await search(env, q)).status, 200, q);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM demand").get() as { n: number }).n, 0);

  // rows an earlier version stored
  const insert = raw.prepare("INSERT INTO demand (domain, network, at) VALUES (?, ?, ?)");
  for (const domain of ["corp-zeta.internal", "printer.home.arpa", "zillow.com"])
    for (const network of ["n1", "n2"]) insert.run(domain, network, new Date().toISOString());
  assert.deepEqual(await listed(env), ["zillow.com"]);
  const home = (await send(env, "GET", "/")).text;
  assert.match(home, /zillow\.com/);
  assert.doesNotMatch(home, /corp-zeta|home\.arpa/);
  assert.equal((await send(env, "GET", "/wanted/corp-zeta.internal")).status, 404);
  assert.equal((await send(env, "GET", "/wanted/printer.home.arpa")).status, 404);
  assert.equal((await send(env, "GET", "/wanted/zillow.com")).status, 200);
  const map = (await send(env, "GET", "/sitemap.xml")).text;
  assert.match(map, /wanted\/zillow\.com/);
  assert.doesNotMatch(map, /corp-zeta|home\.arpa/);
});
