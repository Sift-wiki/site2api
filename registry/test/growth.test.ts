/** What the catalog shows search engines and visitors: site page metadata, wanted pages, public stats, credit. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { CSP } from "../src/pages.js";
import { funnel } from "../src/stats.js";
import type { D1Database } from "../src/store.js";
import { d1, evidence, install, op, registry, report, seed, send, site } from "./helpers.js";

const NET1 = "198.51.100.7";
const NET2 = "192.0.2.44";
const NET3 = "203.0.113.80";
const DAY = 86_400_000;
type Env = ReturnType<typeof registry>["env"];

const ask = (env: Env, q: string, ip: string) => send(env, "GET", `/v1/search?q=${encodeURIComponent(q)}`, { ip });

/** A site an install shared, on example.org, promoted by installs on two other networks. */
async function community(env: Env) {
  const host = "www.example.org";
  const operation = op({
    name: "getShelf",
    request: { method: "GET", url: `https://${host}/api/shelf?q=dune`, headers: {} },
    trigger: { url: `https://${host}/shelf?q={q}` },
    match: { host, path: "/api/shelf" },
  });
  const ours = { name: "example-org", domain: "example.org", baseUrl: `https://${host}` };
  const uploader = install();
  const up = await send(env, "POST", "/v1/versions", { as: uploader, body: { site: ours, operation, evidence } });
  assert.equal(up.status, 201, up.text);
  await report(env, install(), up.body.hash, "ok", NET1);
  await report(env, install(), up.body.hash, "ok", NET2);
  return { hash: up.body.hash as string, uploader };
}

/** The JSON-LD blocks of a page, parsed. */
const structured = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1]!));

describe("site pages for search engines", () => {
  const hostile = '</script><script>alert("x")</script>';

  test("title, description, canonical, OpenGraph, Twitter and JSON-LD, all escaped", async () => {
    const { env } = registry();
    await seed(env, {
      site: { ...site, displayName: `Books ${hostile}`, description: `Ratings & "reviews" ${hostile}` },
      operations: [op(), op({ name: "get_book_details", description: "One book" })],
    });
    const r = await send(env, "GET", "/sites/example-com");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-security-policy"), CSP, "the CSP is unchanged");
    assert.match(
      r.text,
      /<title>Books &lt;\/script&gt;.* API for AI agents: get book details, search books \| API Anything<\/title>/,
    );
    assert.match(r.text, /<meta name="description" content="Unofficial Books &lt;\/script&gt;/);
    assert.match(r.text, /<link rel="canonical" href="https:\/\/registry\.test\/sites\/example-com">/);
    assert.match(r.text, /<meta property="og:url" content="https:\/\/registry\.test\/sites\/example-com">/);
    assert.match(r.text, /<meta name="twitter:card" content="summary">/);
    assert.match(r.text, /<meta name="twitter:title" content="Books &lt;/);
    assert.equal(r.text.match(/<script>/g)?.length, 1, "the copy buttons' script is the only one that runs");
    assert.equal(r.text.match(/<\/script>/g)?.length, 2, "no spec string closes a script element");
    const [ld] = structured(r.text);
    const api = ld["@graph"].find((n: { "@type": string }) => n["@type"] === "WebAPI");
    assert.equal(api.name, `Books ${hostile} API (unofficial)`, "the JSON escapes read back as the text");
    assert.equal(api.url, "https://registry.test/sites/example-com");
    assert.equal(api.about.url, "https://example.com");
    assert.ok(ld["@graph"].some((n: { "@type": string }) => n["@type"] === "BreadcrumbList"));
  });

  test("a seeded site says so; a site an install shared carries the badge, on its page and the home list", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    const { uploader } = await community(env);
    const seeded = await send(env, "GET", "/sites/example-com");
    assert.match(seeded.text, /Seeded by the maintainers\./);
    assert.doesNotMatch(seeded.text, /taught by an install/);
    const ours = await send(env, "GET", "/sites/example-org");
    assert.equal(ours.status, 200);
    assert.match(ours.text, /taught by an install<\/span> First shared by an API Anything install/);
    assert.ok(!ours.text.includes(uploader.key), "the uploader's key is never shown");
    const home = await send(env, "GET", "/");
    const row = (name: string) => home.text.split(`href="/sites/${name}"`)[1]!.split("</li>")[0]!;
    assert.match(row("example-org"), /taught by an install/);
    assert.doesNotMatch(row("example-com"), /taught by an install/);
  });
});

describe("wanted pages", () => {
  test("a domain in demand has a page with the commands to teach it, linked from home and the sitemap", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    await ask(env, "https://www.zillow.com/homedetails/1", NET1);
    await ask(env, "zillow.com", NET2);
    await ask(env, "redfin.com", NET3);
    const r = await send(env, "GET", "/wanted/zillow.com");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers.get("content-security-policy"), CSP);
    assert.match(r.text, /<title>zillow\.com API for AI agents: asked for on 2 networks, nobody has taught it yet/);
    assert.match(r.text, /<link rel="canonical" href="https:\/\/registry\.test\/wanted\/zillow\.com">/);
    assert.doesNotMatch(r.text, /noindex/);
    assert.match(r.text, /npx -y api-anything setup/);
    assert.match(
      r.text,
      /npx -y api-anything learn &#39;https:\/\/zillow\.com\/search\?q=\{q\}&#39; --args q=&lt;value&gt; --args2 q=&lt;another value&gt; --args3 q=&lt;a third&gt;/,
    );
    assert.match(r.text, /href="\/#wanted"/);
    const one = await send(env, "GET", "/wanted/redfin.com");
    assert.equal(one.status, 200);
    assert.match(one.text, /<meta name="robots" content="noindex">/, "one network is too thin to index");
    const home = await send(env, "GET", "/");
    assert.match(home.text, /<a href="\/wanted\/zillow\.com">zillow\.com<\/a>/);
    assert.match(home.text, /<a href="\/wanted\/redfin\.com">redfin\.com<\/a>/);
    const map = await send(env, "GET", "/sitemap.xml");
    assert.match(map.text, /<loc>https:\/\/registry\.test\/wanted\/zillow\.com<\/loc>/);
    assert.doesNotMatch(map.text, /wanted\/redfin/, "a page marked noindex is not in the sitemap");
  });

  test("no page for a domain nobody asked for, anything but a clean registrable domain, or old demand", async () => {
    const { env, raw } = registry();
    await ask(env, "zillow.com", NET1);
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const insert = raw.prepare("INSERT INTO demand (domain, network, at) VALUES (?, ?, ?)");
    insert.run("stale.com", "n1", old);
    for (const junk of ["<script>alert(1)</script>.com", "localhost", "a..b.com", "www.zillow.com", "zillow.com:80"])
      insert.run(junk, "n1", new Date().toISOString());
    for (const path of [
      "/wanted/booking.com",
      "/wanted/stale.com",
      "/wanted/www.zillow.com",
      "/wanted/a..b.com",
      "/wanted/localhost",
      "/wanted/ZILLOW.COM",
      "/wanted/zillow.com.",
      "/wanted/1.2.3.4",
      `/wanted/${encodeURIComponent("<script>alert(1)</script>.com")}`,
    ])
      assert.equal((await send(env, "GET", path)).status, 404, path);
    const home = await send(env, "GET", "/");
    assert.doesNotMatch(home.text, /<script>alert|a\.\.b|localhost|zillow\.com:80/, "unclean demand is not listed");
    assert.match(home.text, /href="\/wanted\/zillow\.com"/);
    const map = await send(env, "GET", "/sitemap.xml");
    assert.doesNotMatch(map.text, /wanted\//);
  });

  test("once a site covers the domain, its wanted page moves to the site's page", async () => {
    const { env } = registry();
    await ask(env, "example.org", NET1);
    await ask(env, "example.org", NET2);
    assert.equal((await send(env, "GET", "/wanted/example.org")).status, 200);
    await community(env);
    const r = await send(env, "GET", "/wanted/example.org");
    assert.equal(r.status, 301);
    assert.equal(r.headers.get("location"), "/sites/example-org");
  });
});

describe("public stats", () => {
  test("aggregate counts only, and the home page shows them", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    const { hash, uploader } = await community(env);
    const failing = install();
    await report(env, failing, hash, "fail", NET3);
    await report(env, install(), hash, "auth", NET3);
    await ask(env, "zillow.com", NET1);
    const r = await send(env, "GET", "/v1/stats");
    assert.equal(r.status, 200, r.text);
    const { generated, ...counts } = r.body;
    assert.ok(Date.parse(generated));
    const { seen, countedAt, ...installs } = counts.installs;
    assert.equal(countedAt, generated);
    assert.equal(seen.total, 5);
    assert.equal(seen.perDay.length, 30);
    assert.deepEqual(seen.perDay.at(-1), { day: generated.slice(0, 10), new: 5 });
    assert.deepEqual(installs, {
      last7Days: 5,
      last30Days: 5,
      activated: { total: 4, last7Days: 4, last30Days: 4, ok: { total: 2, last7Days: 2, last30Days: 2 } },
      sharing: { last30Days: 5 },
    });
    delete counts.installs;
    assert.deepEqual(counts, {
      calls: { last7Days: 4, ok: 2, okRate: 0.667 },
      sites: { live: 2, operations: 2 },
      community: { sites: 1, operations: 1, uploadsLast30Days: 1 },
      wanted: 1,
    });
    for (const secret of [uploader.key, failing.key]) assert.ok(!r.text.includes(secret), "no key is served");
    assert.doesNotMatch(r.text, /[0-9a-f]{64}/, "no hash is served");
    const home = await send(env, "GET", "/");
    assert.match(
      home.text,
      /<p class="proof">5 installs active this week · 4 calls this week · 2 of 5 installs seen made a call that worked · 1 site taught by the community<\/p>/,
    );
  });

  test("an empty registry answers zeros, with no ok rate", async () => {
    const { env } = registry();
    const r = await send(env, "GET", "/v1/stats");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.calls, { last7Days: 0, ok: 0 });
    const { perDay, ...seen } = r.body.installs.seen;
    assert.deepEqual(seen, { total: 0, last30Days: 0 });
    assert.ok(perDay.every((d: { new: number }) => d.new === 0));
    assert.deepEqual(r.body.installs.activated, {
      total: 0,
      last7Days: 0,
      last30Days: 0,
      ok: { total: 0, last7Days: 0, last30Days: 0 },
    });
    assert.deepEqual(r.body.installs.sharing, { last30Days: 0 });
    assert.equal(r.body.installs.last7Days, 0);
  });

  test("the install funnel: seen per day, activated by report, sharing by upload or report, windows by time", async () => {
    const { env, raw } = registry();
    const now = Date.now();
    const at = (days: number) => new Date(now - days * DAY).toISOString();
    const key = raw.prepare(
      "INSERT INTO keys (key, first_seen, uploads, reports, activated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const rep = raw.prepare(
      "INSERT INTO reports (hash, key, network, outcome, tier, ms, at) VALUES (?, ?, 'n', ?, 1, 10, ?)",
    );
    // seen 40 days ago, reported ok 20 days ago: activated in 30 days, not 7
    key.run("old", at(40), 0, 3, at(20));
    rep.run("h1", "old", "ok", at(20));
    // seen 2 days ago, a fail this week: activated, never ok
    key.run("failing", at(2), 0, 1, null);
    rep.run("h1", "failing", "fail", at(1));
    // seen today, ok today, on two versions: counted once
    key.run("works", at(0), 0, 2, at(0));
    rep.run("h1", "works", "ok", at(0));
    rep.run("h2", "works", "ok", at(0));
    // seen 5 days ago and only uploaded: sharing, not activated
    key.run("uploader", at(5), 1, 0, null);
    await seed(env, { site, operations: [op()] });
    raw.prepare("UPDATE versions SET uploader = 'uploader', created_at = ?").run(at(5));
    // reports purged with an archived version 60 days ago, one of them ok: still activated, and ok
    key.run("purged", at(70), 0, 4, at(65));
    // ok 10 days ago, then a fail on the same version this week: ok for good
    key.run("flipped", at(12), 0, 2, at(10));
    rep.run("h1", "flipped", "fail", at(2));
    // a report that sent nothing known: seen, not activated
    key.run("idle", at(3), 0, 0, null);

    const s = (await send(env, "GET", "/v1/stats")).body.installs;
    assert.equal(s.seen.total, 7);
    assert.equal(s.seen.last30Days, 5, "old and purged were first seen before the window");
    const day = (d: number) => s.seen.perDay.find((x: { day: string }) => x.day === at(d).slice(0, 10)).new;
    assert.deepEqual([day(0), day(2), day(3), day(5), day(12), day(29)], [1, 1, 1, 1, 1, 0]);
    assert.equal(s.seen.perDay[0].day, at(29).slice(0, 10));
    assert.deepEqual(s.activated, {
      total: 5,
      last7Days: 3,
      last30Days: 4,
      ok: { total: 4, last7Days: 1, last30Days: 2 },
    });
    assert.deepEqual(s.sharing, { last30Days: 5 });
    const text = JSON.stringify(s);
    for (const k of ["old", "failing", "works", "uploader", "purged", "flipped", "idle"])
      assert.ok(!text.includes(`"${k}"`), "no key is served");
  });

  test("a key with reports or uploads but no keys row is still seen, so no count exceeds installs seen", async () => {
    const { env, raw } = registry();
    const now = new Date().toISOString();
    raw.prepare("INSERT INTO keys (key, first_seen, uploads, reports) VALUES ('rowed', ?, 0, 1)").run(now);
    const rep = raw.prepare(
      "INSERT INTO reports (hash, key, network, outcome, tier, ms, at) VALUES (?, ?, 'n', ?, 1, 10, ?)",
    );
    rep.run("h1", "rowed", "ok", now);
    rep.run("h1", "rowless", "ok", now);
    await seed(env, { site, operations: [op()] });
    raw.prepare("UPDATE versions SET uploader = 'uploadonly', created_at = ?").run(now);
    const s = (await send(env, "GET", "/v1/stats")).body.installs;
    assert.equal(s.seen.total, 3);
    assert.equal(s.activated.ok.total, 2);
    assert.ok(s.sharing.last30Days <= s.seen.total);
    assert.ok(s.activated.ok.last30Days <= s.activated.ok.total);
  });

  test("an install that reported ok stays activated: after a fail, and after its version is purged", async () => {
    const { env, raw } = registry();
    await seed(env, { site, operations: [op()] });
    const hash = (await send(env, "GET", "/v1/sites/example-com")).body.operations[0].hash;
    const k = install();
    const stamp = () =>
      (raw.prepare("SELECT activated_at FROM keys WHERE key = ?").get(k.key) as { activated_at: string | null })
        .activated_at;
    await report(env, k, hash, "fail", NET1);
    assert.equal(stamp(), null, "a fail does not activate");
    await report(env, k, hash, "ok", NET1);
    const first = stamp();
    assert.ok(first);
    await report(env, k, hash, "ok", NET1);
    assert.equal(stamp(), first, "set once");
    await report(env, k, hash, "fail", NET1);
    assert.equal(stamp(), first);
    raw.prepare("DELETE FROM reports").run();
    raw.prepare("DELETE FROM snapshots").run();
    const s = (await send(env, "GET", "/v1/stats")).body.installs;
    assert.equal(s.activated.ok.total, 1);
    assert.equal(s.activated.total, 1);
  });

  test("migration 0009 backfills activated_at from the earliest ok report each key holds", () => {
    const raw = new DatabaseSync(":memory:");
    const dir = new URL("../migrations/", import.meta.url);
    const files = readdirSync(dir).sort();
    const at = files.indexOf("0009_funnel.sql");
    for (const f of files.slice(0, at)) raw.exec(readFileSync(new URL(f, dir), "utf8"));
    const key = raw.prepare("INSERT INTO keys (key, first_seen, uploads, reports) VALUES (?, '2026-01-01', 0, 1)");
    const rep = raw.prepare("INSERT INTO reports (hash, key, network, outcome, at) VALUES (?, ?, 'n', ?, ?)");
    key.run("twice");
    rep.run("h1", "twice", "ok", "2026-03-01T00:00:00.000Z");
    rep.run("h2", "twice", "ok", "2026-02-01T00:00:00.000Z");
    rep.run("h3", "twice", "fail", "2026-01-15T00:00:00.000Z");
    key.run("failed");
    rep.run("h1", "failed", "fail", "2026-02-01T00:00:00.000Z");
    key.run("none");
    for (const f of files.slice(at)) raw.exec(readFileSync(new URL(f, dir), "utf8"));
    const rows = raw.prepare("SELECT key, activated_at FROM keys ORDER BY key").all();
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { key: "failed", activated_at: null },
        { key: "none", activated_at: null },
        { key: "twice", activated_at: "2026-02-01T00:00:00.000Z" },
      ],
    );
  });

  test("concurrent reads of a stale or missing funnel run exactly one recount", async () => {
    const { db, raw } = d1();
    let recounts = 0;
    const spied: D1Database = {
      ...db,
      prepare(sql) {
        if (sql.includes("FROM keys WHERE first_seen >= ?")) recounts++;
        return db.prepare(sql);
      },
    };
    raw.prepare("INSERT INTO keys (key, first_seen) VALUES ('k', ?)").run(new Date().toISOString());
    const now = Date.now();
    const cold = await Promise.all(Array.from({ length: 20 }, () => funnel(spied, now)));
    assert.equal(recounts, 1, "no snapshot yet: one recount");
    assert.equal(cold.filter((f) => f.countedAt).length, 1, "the others answer uncounted zeros");
    assert.ok(cold.filter((f) => !f.countedAt).every((f) => f.seen.total === 0 && f.seen.perDay.length === 30));

    raw.prepare("INSERT INTO keys (key, first_seen) VALUES ('k2', ?)").run(new Date().toISOString());
    const later = now + 61 * 60_000;
    recounts = 0;
    const stale = await Promise.all(Array.from({ length: 20 }, () => funnel(spied, later)));
    assert.equal(recounts, 1, "a stale snapshot: one recount");
    assert.deepEqual(stale.map((f) => f.seen.total).sort(), [...Array(19).fill(1), 2], "the others serve the previous");
    assert.equal((await funnel(spied, later)).seen.total, 2);
    assert.equal(recounts, 1);
    assert.equal((raw.prepare("SELECT lease FROM snapshots").get() as { lease: string | null }).lease, null);

    // a recount whose request died holds its lease, then the lease lapses
    raw
      .prepare("UPDATE snapshots SET at = ?, lease = ?")
      .run(new Date(later - 2 * 3_600_000).toISOString(), new Date(later + 60_000).toISOString());
    recounts = 0;
    await funnel(spied, later);
    assert.equal(recounts, 0, "held by a live lease");
    await funnel(spied, later + 120_000);
    assert.equal(recounts, 1, "the lease lapsed");
  });

  test("the funnel is counted at most once an hour, then recounted", async () => {
    const { env, raw } = registry();
    const first = await send(env, "GET", "/v1/stats");
    assert.equal(first.body.installs.seen.total, 0);
    raw.prepare("INSERT INTO keys (key, first_seen) VALUES ('k', ?)").run(new Date().toISOString());
    const held = await send(env, "GET", "/v1/stats");
    assert.equal(held.body.installs.seen.total, 0, "an hour has not passed");
    assert.equal(held.body.installs.countedAt, first.body.installs.countedAt);
    raw.prepare("UPDATE snapshots SET at = ?").run(new Date(Date.now() - 61 * 60_000).toISOString());
    const recounted = await send(env, "GET", "/v1/stats");
    assert.equal(recounted.body.installs.seen.total, 1);
  });

  test("the stats and wanted pages are cached at the edge like the other public reads", async () => {
    const { env } = registry();
    await ask(env, "zillow.com", NET1);
    const store = new Map<string, Response>();
    const g = globalThis as { caches?: unknown };
    g.caches = {
      default: {
        match: async (r: Request) => store.get(r.url)?.clone(),
        put: async (r: Request, res: Response) => void store.set(r.url, res),
      },
    };
    try {
      await send(env, "GET", "/v1/stats");
      await send(env, "GET", "/wanted/zillow.com");
      assert.deepEqual([...store.keys()].sort(), [
        "https://registry.test/v1/stats",
        "https://registry.test/wanted/zillow.com",
      ]);
    } finally {
      delete g.caches;
    }
  });
});
