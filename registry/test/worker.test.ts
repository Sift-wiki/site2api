import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { versionHashText } from "../../src/registry-api.js";
import { IndexSchema } from "../../src/search.js";
import { OperationSchema } from "../../src/spec.js";
import worker from "../src/worker.js";
import { ADMIN, evidence, install, op, registry, report, seed, send, signed, site, upload } from "./helpers.js";

const NET1 = "198.51.100.7";
const NET2 = "192.0.2.44";

describe("signatures", () => {
  test("a valid signature uploads; the hash is sha256 of versionHashText", async () => {
    const { env } = registry();
    const r = await send(env, "POST", "/v1/versions", { as: install(), body: upload() });
    assert.equal(r.status, 201, r.text);
    const expected = createHash("sha256")
      .update(versionHashText("example-com", OperationSchema.parse(op())))
      .digest("hex");
    assert.deepEqual(r.body, { hash: expected, status: "candidate", duplicate: false });
  });

  test("an unsigned upload, a wrong key, a stale timestamp and a tampered body are refused", async () => {
    const { env } = registry();
    const a = install();
    const b = install();
    const body = JSON.stringify(upload());
    const unsigned = await send(env, "POST", "/v1/versions", { body });
    assert.equal(unsigned.status, 401);

    const wrongKey = await send(env, "POST", "/v1/versions", {
      body,
      headers: { ...signed(a, "POST", "/v1/versions", body), "x-aa-key": b.key },
    });
    assert.equal(wrongKey.status, 401);
    assert.match(wrongKey.body.error, /does not match/);

    const stale = await send(env, "POST", "/v1/versions", { as: a, body, ts: Date.now() - 6 * 60_000 });
    assert.equal(stale.status, 401);
    assert.match(stale.body.error, /5 minutes/);

    const tampered = await send(env, "POST", "/v1/versions", {
      body: body.replace("dune", "dunf"),
      headers: signed(a, "POST", "/v1/versions", body),
    });
    assert.equal(tampered.status, 401);

    const partial = await send(env, "POST", "/v1/versions", { body, headers: { "x-aa-key": a.key } });
    assert.equal(partial.status, 401);
  });

  test("a GET signs its path with the query", async () => {
    const { env } = registry();
    const r = await send(env, "GET", "/v1/verify-jobs?limit=3", { as: install() });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { jobs: [] });
  });

  test("a signature over the bare path does not cover a query", async () => {
    const { env } = registry();
    const r = await send(env, "GET", "/v1/verify-jobs?limit=3", {
      headers: signed(install(), "GET", "/v1/verify-jobs", ""),
    });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /does not match/);
  });
});

describe("uploads", () => {
  test("refuses a spec that fails the schema, the domain check, the shared rules or the credential check", async () => {
    const { env } = registry();
    const as = install();
    const post = (body: unknown) => send(env, "POST", "/v1/versions", { as, body });

    const schema = await post(upload({ operation: { ...op(), readOnly: undefined } }));
    assert.equal(schema.status, 422);
    assert.ok(
      schema.body.reasons.some((r: string) => r.startsWith("operation.readOnly")),
      schema.text,
    );

    const domain = await post(upload({ site: { ...site, domain: "example.org" } }));
    assert.equal(domain.status, 422);
    assert.match(domain.body.reasons[0], /not baseUrl's site example.com/);

    const http = await post(upload({ site: { ...site, baseUrl: "http://www.example.com" }, operation: op() }));
    assert.equal(http.status, 422);
    assert.ok(
      http.body.reasons.some((r: string) => /not https/.test(r)),
      http.text,
    );

    const credential = await post(
      upload({
        operation: op({
          request: {
            method: "GET",
            url: "https://www.example.com/api/search?q=dune",
            headers: { authorization: "Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0" },
          },
        }),
      }),
    );
    assert.equal(credential.status, 422);
    assert.ok(
      credential.body.reasons.some((r: string) => /literal credential/.test(r)),
      credential.text,
    );

    const badName = await post(upload({ site: { ...site, name: "Books!" } }));
    assert.equal(badName.status, 422);

    const big = await post({ ...upload(), padding: "x".repeat(257 * 1024) });
    assert.equal(big.status, 413);

    // a fresh key: `as` has spent its first hour's uploads
    const notJson = await send(env, "POST", "/v1/versions", { as: install(), body: "{nope" });
    assert.equal(notJson.status, 400);
  });

  test("a body is cut off at the cap while streaming, whatever content-length says", async () => {
    const { env } = registry();
    const big = JSON.stringify({ ...upload(), padding: "x".repeat(300 * 1024) });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const request = new Request("https://registry.test/v1/versions", {
      method: "POST",
      headers: { "cf-connecting-ip": NET1, ...signed(install(), "POST", "/v1/versions", big) },
      body: stream,
      duplex: "half",
    } as RequestInit);
    assert.equal(request.headers.get("content-length"), null);
    const r = await worker.fetch(request, env);
    assert.equal(r.status, 413);
  });

  test("an unsigned or stale upload is refused before its body is read", async () => {
    const { env } = registry();
    let pulled = false;
    // no queue to fill, so pull runs only when someone reads
    const body = () =>
      new ReadableStream(
        {
          pull(c) {
            pulled = true;
            c.close();
          },
        },
        { highWaterMark: 0 },
      );
    const post = (headers: Record<string, string>) =>
      worker.fetch(
        new Request("https://registry.test/v1/versions", {
          method: "POST",
          headers,
          body: body(),
          duplex: "half",
        } as RequestInit),
        env,
      );
    assert.equal((await post({})).status, 401);
    const stale = signed(install(), "POST", "/v1/versions", "", Date.now() - 10 * 60_000);
    assert.equal((await post(stale)).status, 401);
    assert.equal(pulled, false);
  });

  test("the first upload binds a site name to its domain", async () => {
    const { env } = registry();
    const as = install();
    assert.equal((await send(env, "POST", "/v1/versions", { as, body: upload() })).status, 201);
    const other = { ...site, domain: "example.org", baseUrl: "https://www.example.org" };
    const r = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({
        site: other,
        operation: op({
          request: { method: "GET", url: "https://www.example.org/api/search?q=dune", headers: {} },
          trigger: { url: "https://www.example.org/search?q={q}" },
          match: { host: "www.example.org", path: "/api/search" },
        }),
      }),
    });
    assert.equal(r.status, 409);
    assert.match(r.body.reasons[0], /bound to example.com/);
    // the same domain under that name is welcome, with a new op
    const same = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ operation: op({ name: "bookPage", match: { host: "www.example.com", path: "/api/book" } }) }),
    });
    assert.equal(same.status, 201);
  });

  test("each reason makes a version review", async () => {
    const cases: [string, ReturnType<typeof upload>, RegExp][] = [
      [
        "off-site host",
        upload({
          operation: op({
            trigger: { url: "https://www.example.com/search?q={q}", softFrom: "https://cdn.example.net/" },
          }),
        }),
        /cdn\.example\.net, off its site/,
      ],
      ["login (op)", upload({ operation: op({ learnedLoggedIn: true }) }), /signed in/],
      ["login (evidence)", upload({ evidence: { ...evidence, learnedLoggedIn: true } }), /signed in/],
      [
        "write",
        upload({
          operation: op({
            readOnly: false,
            request: { method: "DELETE", url: "https://www.example.com/api/shelf/1", headers: {} },
          }),
        }),
        /a write/,
      ],
      [
        "public names",
        upload({
          operation: op({
            public: ["x-api-key"],
            request: {
              method: "GET",
              url: "https://www.example.com/api/search?q=dune",
              headers: { "x-api-key": "Zx81Kq0pLm2Nb7Vc" },
            },
          }),
        }),
        /public values: x-api-key/,
      ],
      ["clean replay", upload({ evidence: { ...evidence, cleanReplay: "failed" } }), /clean replay was failed/],
      [
        "derived slot",
        upload({
          operation: op({
            request: { method: "GET", url: "https://www.example.com/api/search?q=dune&shelf=7", headers: {} },
            slots: [
              { param: "q", at: ["query:q"] },
              {
                at: ["query:shelf"],
                from: {
                  request: { method: "GET", url: "https://www.example.com/api/me?v=1", headers: { "x-sid": "s" } },
                  slots: [{ ref: "cookie:sid", at: ["header:x-sid"] }],
                },
                path: "shelf.id",
              },
            ],
          }),
        }),
        /fills query:shelf from a lookup sent with the caller's cookies/,
      ],
    ];
    for (const [why, body, reason] of cases) {
      const { env } = registry();
      const r = await send(env, "POST", "/v1/versions", { as: install(), body });
      assert.equal(r.status, 201, `${why}: ${r.text}`);
      assert.equal(r.body.status, "review", why);
      assert.ok(
        r.body.reasons.some((x: string) => reason.test(x)),
        `${why}: ${r.text}`,
      );
    }
  });

  test("a write's readback goes up as the read it runs, held to the read rules; one naming a read is refused", async () => {
    const { readOnly: _r, description: _d, params: _p, ...read } = op();
    const write = (readback: Record<string, unknown>) =>
      upload({
        operation: op({
          name: "addBook",
          readOnly: false,
          request: { method: "POST", url: "https://www.example.com/api/shelf", headers: {}, body: "title=dune" },
          slots: [{ param: "title", at: ["body", "form:title"] }],
          params: [{ name: "title" }],
          trigger: { url: "https://www.example.com/shelf" },
          match: { host: "www.example.com", path: "/api/shelf" },
          readback,
        }),
      });
    const carried = { read: { ...read, params: [{ name: "q" }] }, args: { q: "{title}" } };
    const { env } = registry();
    const ok = await send(env, "POST", "/v1/versions", { as: install(), body: write(carried) });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.status, "review");

    const named = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: write({ op: "searchBooks", args: { q: "{title}" } }),
    });
    assert.equal(named.status, 422, named.text);
    assert.match(named.body.reasons.join("\n"), /readback names searchBooks/);

    const http = {
      ...carried,
      read: { ...carried.read, request: { ...read.request, url: "http://www.example.com/x" } },
    };
    const insecure = await send(env, "POST", "/v1/versions", { as: install(), body: write(http) });
    assert.equal(insecure.status, 422, insecure.text);
    assert.match(insecure.body.reasons.join("\n"), /readback searchBooks: request .* is not https/);

    const away = { ...carried, read: { ...carried.read, trigger: { url: "https://cdn.example.net/s?q={q}" } } };
    const off = await send(env, "POST", "/v1/versions", { as: install(), body: write(away) });
    assert.equal(off.status, 201, off.text);
    assert.ok(
      off.body.reasons.some((x: string) => /cdn\.example\.net, off its site/.test(x)),
      off.text,
    );
  });

  test("a clean replay a bot wall answered counts as public: the data is behind the wall, not behind a login", async () => {
    const { env } = registry();
    const r = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ evidence: { ...evidence, cleanReplay: "blocked" } }),
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, "candidate", r.text);
  });

  test("a client's own `version` record does not change the hash", async () => {
    const { env } = registry();
    const a = await send(env, "POST", "/v1/versions", { as: install(), body: upload() });
    const b = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({
        operation: { ...op(), version: { hash: "0".repeat(64), status: "live" }, learnedAt: "2026-01-01" },
      }),
    });
    assert.equal(b.body.hash, a.body.hash);
    assert.equal(b.body.duplicate, true);
  });
});

describe("verification by the crowd", () => {
  test("a re-upload counts as its uploader's confirmation", async () => {
    const { env } = registry();
    const first = await send(env, "POST", "/v1/versions", { as: install(), body: upload() });
    const again = await send(env, "POST", "/v1/versions", { as: install(), ip: NET1, body: upload() });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { hash: first.body.hash, status: "candidate", duplicate: true });
    const third = await send(env, "POST", "/v1/versions", { as: install(), ip: NET2, body: upload() });
    assert.equal(third.body.status, "live");
  });

  test("promotion takes 2 installs on 2 networks, not counting the uploader", async () => {
    const { env } = registry();
    const uploader = install();
    const { hash } = (await send(env, "POST", "/v1/versions", { as: uploader, body: upload() })).body;
    const status = async () => (await send(env, "GET", "/v1/sites/example-com")).body.operations[0];

    await report(env, uploader, hash, "ok", NET2);
    await report(env, install(), hash, "ok", NET1);
    assert.equal((await status()).status, "candidate");
    await report(env, install(), hash, "ok", NET1);
    assert.equal((await status()).status, "candidate", "two installs on one network");
    const r = await report(env, install(), hash, "ok", NET2);
    assert.deepEqual(r.body, { accepted: 1, ignored: 0 });
    const served = await status();
    assert.equal(served.status, "live");
    assert.equal(served.confirmations, 3);
    assert.equal(served.successRate, 1);
    assert.ok(served.lastOkAt);
  });

  test("the ASN, when Cloudflare gives one, is the network", async () => {
    const { env } = registry();
    const { hash } = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body;
    await send(env, "POST", "/v1/reports", {
      as: install(),
      ip: NET1,
      asn: 7922,
      body: { reports: [{ hash, outcome: "ok" }] },
    });
    await send(env, "POST", "/v1/reports", { as: install(), ip: NET2, asn: 7922, body: [{ hash, outcome: "ok" }] });
    assert.equal((await send(env, "GET", "/v1/sites/example-com")).body.operations[0].status, "candidate");
  });

  test("an install counts once, by its latest outcome", async () => {
    const { env } = registry();
    const { hash } = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body;
    const k = install();
    for (let i = 0; i < 3; i++) await report(env, k, hash, "ok", NET1);
    await report(env, k, hash, "fail", NET1);
    const served = (await send(env, "GET", "/v1/sites/example-com")).body.operations[0];
    assert.equal(served.confirmations, 0);
    assert.equal(served.successRate, 0);
  });

  test("a heal: fewer installs only for a version failing for its uploader or degraded, never fewer networks", async () => {
    // three installs promote a new version; a heal takes PROMOTE_HEAL_KEYS (1), but still 2 networks
    const { env, raw } = registry({ PROMOTE_KEYS: "3" });
    const live = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const variant = (v: number) =>
      op({ request: { method: "GET", url: `https://www.example.com/api/search?q=dune&v=${v}`, headers: {} } });
    const row = (hash: string) =>
      raw.prepare("SELECT status, heal FROM versions WHERE hash = ?").get(hash) as { status: string; heal: number };
    const healOf = (as: ReturnType<typeof install>, v: number, from = live.hash) =>
      send(env, "POST", "/v1/versions", {
        as,
        body: upload({ operation: variant(v), parent: from, evidence: { ...evidence, healedFrom: from } }),
      });

    // the takeover: a claim on a live version that never failed for this key is no heal
    const claim = (await healOf(install(), 2)).body.hash;
    assert.equal(row(claim).heal, 0);
    await report(env, install(), claim, "ok", NET1);
    await report(env, install(), claim, "ok", NET2);
    assert.equal(row(claim).status, "candidate", "two installs do not promote a new version here");

    // a real heal: its uploader's own calls of the live version failed this week
    const fixer = install();
    await report(env, fixer, live.hash, "fail", NET1);
    const fix = (await healOf(fixer, 3)).body.hash;
    assert.equal(row(fix).heal, 1);
    await report(env, install(), fix, "ok", NET1);
    await report(env, install(), fix, "ok", NET1);
    assert.equal(row(fix).status, "candidate", "one network is never enough, heal or not");
    await report(env, install(), fix, "ok", NET2);
    assert.equal(row(fix).status, "live");

    // a failure older than a week does not count
    const late = install();
    await report(env, late, live.hash, "fail", NET2);
    raw
      .prepare("UPDATE reports SET at = ? WHERE key = ?")
      .run(new Date(Date.now() - 8 * 86_400_000).toISOString(), late.key);
    assert.equal(row((await healOf(late, 4)).body.hash).heal, 0);

    // a degraded version needs no failure of the uploader's own
    raw.prepare("UPDATE versions SET status = 'degraded' WHERE hash = ?").run(live.hash);
    assert.equal(row((await healOf(install(), 5)).body.hash).heal, 1);

    // nor is a version of another op name healed
    const other = op({ name: "bookPage", match: { host: "www.example.com", path: "/api/book" } });
    const up = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ operation: other, evidence: { ...evidence, healedFrom: live.hash } }),
    });
    assert.equal(row(up.body.hash).heal, 0);
  });

  test("a wrong report outweighs two oks", async () => {
    const { env } = registry();
    const { hash } = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body;
    await report(env, install(), hash, "wrong", NET1);
    await report(env, install(), hash, "ok", NET1);
    await report(env, install(), hash, "ok", NET2);
    const status = async () => (await send(env, "GET", "/v1/sites/example-com")).body.operations[0];
    assert.equal((await status()).status, "candidate");
    await report(env, install(), hash, "ok", "203.0.113.200");
    assert.equal((await status()).status, "candidate");
    await report(env, install(), hash, "ok", "100.64.1.1");
    assert.equal((await status()).status, "live");
    assert.equal((await status()).successRate, 0.8);
  });

  test("wrong reports from fresh keys on one network count once", async () => {
    const { env } = registry();
    const { hash } = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body;
    for (let i = 0; i < 3; i++) await report(env, install(), hash, "wrong", NET1);
    const status = async () => (await send(env, "GET", "/v1/sites/example-com")).body.operations[0].status;
    for (const ip of [NET2, "203.0.113.200", "100.64.1.1"]) await report(env, install(), hash, "ok", ip);
    assert.equal(await status(), "candidate", "one network's wrong still outweighs two oks");
    await report(env, install(), hash, "ok", "100.64.2.1");
    assert.equal(await status(), "live", "three keys on one network are one voice against it");
  });

  test("auth, rate, blocked and input reports say nothing about the op", async () => {
    const { env } = registry();
    const { hash } = (await seed(env, { site, operations: [op()] })).body.operations[0];
    for (const outcome of ["auth", "rate", "blocked", "input", "input"]) await report(env, install(), hash, outcome);
    const served = (await send(env, "GET", "/v1/sites/example-com")).body.operations[0];
    assert.equal(served.status, "live");
    assert.equal(served.successRate, undefined);
  });
});

describe("maintenance by the crowd", () => {
  test("a failing live version is degraded and the next best is served", async () => {
    const { env } = registry();
    const live = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const next = op({ request: { method: "GET", url: "https://www.example.com/api/search?q=dune&v=2", headers: {} } });
    const cand = (await send(env, "POST", "/v1/versions", { as: install(), body: upload({ operation: next }) })).body;
    const served = async () => (await send(env, "GET", "/v1/sites/example-com")).body.operations[0];
    assert.equal((await served()).hash, live.hash);

    await report(env, install(), live.hash, "ok");
    await report(env, install(), live.hash, "fail", "100.64.1.1");
    await report(env, install(), live.hash, "fail", "100.64.2.1");
    assert.equal((await served()).hash, live.hash, "two failures are not enough");
    // fresh keys on networks that already failed it are cheap
    for (let i = 0; i < 3; i++) await report(env, install(), live.hash, "fail", "100.64.2.1");
    assert.equal((await served()).hash, live.hash, "failures from two networks are not enough");
    await report(env, install(), live.hash, "wrong", "100.64.3.1");
    const now = await served();
    assert.equal(now.hash, cand.hash);
    assert.equal(now.status, "candidate");

    // more installs that work again bring it back
    for (let i = 0; i < 8; i++) await report(env, install(), live.hash, "ok");
    assert.equal((await served()).hash, live.hash);
  });

  test("counts are kept beside each version: a version many installs report is recounted once a minute, and daily", async () => {
    const { env, raw } = registry({ STATS_LIVE_UP_TO: "2" });
    const live = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const confirmations = async () =>
      (await send(env, "GET", "/v1/sites/example-com")).body.operations[0].confirmations;

    await report(env, install(), live.hash, "ok", NET1);
    await report(env, install(), live.hash, "ok", NET2);
    assert.equal(await confirmations(), 2, "under STATS_LIVE_UP_TO installs, every report recounts");
    await report(env, install(), live.hash, "ok", "203.0.113.9");
    assert.equal(await confirmations(), 2, "counted under a minute ago");
    const stored = raw.prepare("SELECT COUNT(*) AS n FROM reports WHERE hash = ?").get(live.hash) as { n: number };
    assert.equal(stored.n, 3, "the report itself is kept");

    raw
      .prepare("UPDATE versions SET stats_at = ? WHERE hash = ?")
      .run(new Date(Date.now() - 2 * 60_000).toISOString(), live.hash);
    await report(env, install(), live.hash, "ok", "100.64.1.1");
    assert.equal(await confirmations(), 4, "a minute on, the next report recounts");

    await report(env, install(), live.hash, "ok", "100.64.2.1");
    assert.equal(await confirmations(), 4);
    await worker.scheduled({ scheduledTime: Date.now() }, env);
    assert.equal(await confirmations(), 5, "the daily job recounts every version");
  });

  test("a status change held back on a popular version waits for the minute job, not for another report", async () => {
    const { env, raw } = registry({ STATS_LIVE_UP_TO: "1" });
    const live = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const status = () =>
      raw.prepare("SELECT status, pending FROM versions WHERE hash = ?").get(live.hash) as {
        status: string;
        pending: number;
      };

    await report(env, install(), live.hash, "ok", NET1);
    for (const ip of ["100.64.1.1", "100.64.2.1", "100.64.3.1"]) await report(env, install(), live.hash, "fail", ip);
    assert.deepEqual({ ...status() }, { status: "live", pending: 1 }, "three failures, held back and marked");

    await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env);
    assert.deepEqual({ ...status() }, { status: "degraded", pending: 0 });
  });

  test("a review version is served only to its uploader", async () => {
    const { env } = registry();
    const uploader = install();
    const r = await send(env, "POST", "/v1/versions", {
      as: uploader,
      body: upload({ operation: op({ learnedLoggedIn: true }) }),
    });
    assert.equal(r.body.status, "review");
    assert.equal((await send(env, "GET", "/v1/sites/example-com")).status, 404);
    assert.equal((await send(env, "GET", "/v1/sites/example-com", { as: install() })).status, 404);
    const own = await send(env, "GET", "/v1/sites/example-com", { as: uploader });
    assert.equal(own.status, 200);
    assert.equal(own.body.operations[0].status, "review");
    const found = await send(env, "GET", "/v1/search?q=books");
    assert.deepEqual(found.body.matches, []);
    assert.doesNotMatch((await send(env, "GET", "/")).text, /href="\/sites\/example-com"/);
  });

  test("verify-jobs: candidates this key neither uploaded nor reported, with example args", async () => {
    // four installs promote, so three oks leave a candidate a candidate
    const { env } = registry({ PROMOTE_KEYS: "4" });
    const me = install();
    const other = install();
    const mk = (name: string, over: Record<string, unknown> = {}) =>
      op({ name, match: { host: "www.example.com", path: `/api/${name}` }, ...over });
    const post = async (as: typeof me, operation: unknown, ev: Record<string, unknown> = evidence) =>
      (await send(env, "POST", "/v1/versions", { as, body: upload({ operation, evidence: ev }) })).body.hash;
    const wanted = await post(
      other,
      mk("wanted", {
        params: [
          { name: "q", required: true, example: "dune" },
          { name: "page", type: "number", required: false, default: 1 },
        ],
      }),
    );
    await post(me, mk("mine"));
    const reported = await post(other, mk("reported"));
    await report(env, me, reported, "fail");
    await post(other, mk("review"), { ...evidence, cleanReplay: "skipped" });
    await post(other, mk("noExample", { params: [{ name: "q", required: true }] }));
    // needs a browser: background checks are plain HTTP
    await post(install(), mk("browser", { minTier: 2 }));
    await seed(env, { site, operations: [mk("seeded")] });
    // shadowed by the live version of its op, so never served: nothing to check
    await post(install(), mk("seeded", { description: "Find books, a shadow" }));
    // a site with no live op: a stranger's fresh site would send every install to a host it watches
    const stranger = {
      name: "example-net",
      domain: "example.net",
      baseUrl: "https://www.example.net",
    };
    const theirs = op({
      request: { method: "GET", url: "https://track.example.net/p?q=dune", headers: {} },
      trigger: { url: "https://track.example.net/s?q={q}" },
      match: { host: "track.example.net", path: "/p" },
    });
    const uploader = install();
    const fresh = await send(env, "POST", "/v1/versions", {
      as: uploader,
      ip: NET1,
      body: upload({ site: stranger, operation: theirs }),
    });
    assert.equal(fresh.body.status, "candidate", fresh.text);

    const sent = async () => (await send(env, "GET", "/v1/verify-jobs?limit=20", { as: me })).body.jobs;
    // each job carries its version and the site's baseUrl: /v1/sites serves only each op's best
    const [job] = await sent();
    assert.equal(job.baseUrl, "https://www.example.com");
    assert.equal(createHash("sha256").update(versionHashText("example-com", job.operation)).digest("hex"), wanted);
    const jobs = async () => (await sent()).map(({ operation: _o, baseUrl: _b, ...j }: Record<string, unknown>) => j);
    const want = { hash: wanted, site: "example-com", op: "wanted", args: { q: "dune", page: 1 } };
    assert.deepEqual(await jobs(), [want]);
    // the uploader's own friends on its network found nothing
    await report(env, install(), fresh.body.hash, "ok", NET1);
    assert.deepEqual(await jobs(), [want]);
    // one other network is one VPS away
    await report(env, install(), fresh.body.hash, "ok", NET2);
    assert.deepEqual(await jobs(), [want]);
    // installs on two other networks found it by themselves, and it worked: now the crowd checks it
    await report(env, install(), fresh.body.hash, "ok", "100.64.7.1");
    assert.deepEqual((await jobs()).map((j: { site: string }) => j.site).sort(), ["example-com", "example-net"]);
    assert.equal((await send(env, "GET", "/v1/verify-jobs")).status, 401);
  });

  test("verify-jobs: a candidate an install called wrong, or three installs could not confirm, is no job", async () => {
    const { env } = registry();
    const jobs = async (as = install()) =>
      (await send(env, "GET", "/v1/verify-jobs?limit=20", { as })).body.jobs.map((j: { hash: string }) => j.hash);
    const fresh = (name: string, domain: string, operation: unknown, as: ReturnType<typeof install>) =>
      send(env, "POST", "/v1/versions", {
        as,
        ip: NET1,
        body: upload({ site: { name, domain, baseUrl: `https://www.${domain}` }, operation }),
      });
    const on = (domain: string, name: string) =>
      op({
        name,
        request: { method: "GET", url: `https://www.${domain}/api/${name}?q=dune`, headers: {} },
        trigger: { url: `https://www.${domain}/${name}?q={q}` },
        match: { host: `www.${domain}`, path: `/api/${name}` },
      });

    // the uploader's own wrong holds its version at candidate while its two other keys keep the gate's count met
    const watcher = install();
    const held = (await fresh("example-net", "example.net", on("example.net", "probe"), watcher)).body.hash;
    await report(env, watcher, held, "wrong", NET1);
    await report(env, install(), held, "ok", NET2);
    await report(env, install(), held, "ok", "100.64.7.1");
    assert.equal((await send(env, "GET", "/v1/sites/example-net")).body.operations[0].status, "candidate");
    assert.deepEqual(await jobs(), []);

    // a sibling op the same keys promoted opens the site's other candidates: to three installs, then no more
    const owner = install();
    const a = (await fresh("example-org", "example.org", on("example.org", "opA"), owner)).body.hash;
    const b = (await fresh("example-org", "example.org", on("example.org", "opB"), owner)).body;
    assert.equal(b.status, "candidate", JSON.stringify(b));
    await report(env, install(), a, "ok", NET2);
    await report(env, install(), a, "ok", "100.64.7.1");
    const verifiers = ["203.0.113.200", "203.0.114.200", "203.0.115.200"];
    for (const [i, outcome] of ["rate", "blocked", "error"].entries()) {
      const verifier = install();
      assert.deepEqual(await jobs(verifier), [b.hash]);
      await report(env, verifier, b.hash, outcome, verifiers[i]);
    }
    assert.deepEqual(await jobs(), []);
  });

  test("verify-jobs: one key's wrong, or one network's errors, takes nobody else's candidate off the list", async () => {
    const { env } = registry();
    const jobs = async () =>
      (await send(env, "GET", "/v1/verify-jobs?limit=20", { as: install() })).body.jobs
        .map((j: { hash: string }) => j.hash)
        .sort();
    const named = (name: string) => op({ name, match: { host: "www.example.com", path: `/api/${name}` } });
    const owner = install();
    const post = async (name: string) =>
      (await send(env, "POST", "/v1/versions", { as: owner, ip: NET1, body: upload({ operation: named(name) }) })).body
        .hash as string;
    const [live, disputed, failing] = [await post("opA"), await post("opB"), await post("opC")];
    // the site has a live op, so no count of oks is what admits its other candidates
    await report(env, install(), live, "ok", NET2);
    await report(env, install(), live, "ok", "100.64.7.1");
    const both = [disputed, failing].sort();
    assert.deepEqual(await jobs(), both);

    // a stranger's fresh key calls one wrong, and three more on one network cannot confirm the other
    await report(env, install(), disputed, "wrong", "203.0.113.200");
    for (let i = 0; i < 3; i++) await report(env, install(), failing, "error", "203.0.113.200");
    assert.deepEqual(await jobs(), both);

    // three networks that could not confirm one are the cap, the wrong among them
    await report(env, install(), disputed, "error", "203.0.114.200");
    await report(env, install(), disputed, "fail", "203.0.115.200");
    assert.deepEqual(await jobs(), [failing]);
  });

  test("the daily job archives stale candidates and degraded versions, and a degraded one a newer live one replaced; never a live one", async () => {
    const { env, raw } = registry();
    const OLD = "2026-01-01T00:00:00.000Z";
    const age = (hash: string, status?: string) =>
      raw
        .prepare(`UPDATE versions SET created_at = ?${status ? ", status = ?" : ""} WHERE hash = ?`)
        .run(...(status ? [OLD, status, hash] : [OLD, hash]));
    const named = (name: string) => op({ name, match: { host: "www.example.com", path: `/api/${name}` } });
    const post = async (operation: unknown) =>
      (await send(env, "POST", "/v1/versions", { as: install(), body: upload({ operation }) })).body.hash as string;

    // uploaded before the seed: a new op on a seeded site would be review
    const staleCandidate = await post(named("stale"));
    const freshCandidate = await post(named("fresh"));
    const staleDegraded = await post(named("degraded"));
    const live = (await seed(env, { site, operations: [op(), named("quiet")] })).body.operations;
    for (const v of live) age(v.hash);
    age(staleCandidate);
    age(staleDegraded, "degraded");
    // a newer version of searchBooks goes live: it may be a takeover, so the seed's stays live
    const heal = await post(
      op({ request: { method: "GET", url: "https://www.example.com/api/search?q=dune&v=2", headers: {} } }),
    );
    await send(env, "POST", `/v1/admin/versions/${heal}`, {
      body: { status: "live" },
      headers: { authorization: `Bearer ${ADMIN}` },
    });

    await worker.scheduled({ scheduledTime: Date.now() }, env);
    const status = (hash: string) =>
      (raw.prepare("SELECT status FROM versions WHERE hash = ?").get(hash) as { status: string }).status;
    assert.equal(status(live[0].hash), "live", "a live version is never archived, even with a newer live one");
    assert.equal(status(heal), "live");
    assert.equal(status(live[1].hash), "live", "a live version never times out");
    assert.equal(status(staleCandidate), "archived");
    assert.equal(status(staleDegraded), "archived");
    assert.equal(status(freshCandidate), "candidate");

    // once the old one degrades, the newer live version has replaced it
    raw
      .prepare("UPDATE versions SET status = 'degraded', last_ok_at = ? WHERE hash = ?")
      .run(new Date().toISOString(), live[0].hash);
    await worker.scheduled({ scheduledTime: Date.now() }, env);
    assert.equal(status(live[0].hash), "archived");

    await worker.scheduled({ scheduledTime: Date.now() + 31 * 86_400_000 }, env);
    assert.equal(status(freshCandidate), "archived");
    assert.equal(status(live[1].hash), "live");
  });

  test("the daily job deletes versions archived over 30 days ago, with their reports", async () => {
    const { env, raw } = registry();
    const named = (name: string) => op({ name, match: { host: "www.example.com", path: `/api/${name}` } });
    const [old, recent] = (await seed(env, { site, operations: [named("old"), named("recent")] })).body.operations;
    await report(env, install(), old.hash, "ok");
    await report(env, install(), recent.hash, "ok");
    const archived = (hash: string, days: number) =>
      raw
        .prepare("UPDATE versions SET status = 'archived', updated_at = ? WHERE hash = ?")
        .run(new Date(Date.now() - days * 86_400_000).toISOString(), hash);
    archived(old.hash, 31);
    archived(recent.hash, 29);
    await worker.scheduled({ scheduledTime: Date.now() }, env);
    const versions = (hash: string) =>
      (raw.prepare("SELECT COUNT(*) AS n FROM versions WHERE hash = ?").get(hash) as { n: number }).n;
    const reports = (hash: string) =>
      (raw.prepare("SELECT COUNT(*) AS n FROM reports WHERE hash = ?").get(hash) as { n: number }).n;
    assert.equal(versions(old.hash), 0);
    assert.equal(reports(old.hash), 0);
    assert.equal(versions(recent.hash), 1);
    assert.equal(reports(recent.hash), 1);
  });
});

describe("rate limits", () => {
  test("uploads per key and per network an hour, with Retry-After", async () => {
    const { env } = registry({ UPLOADS_PER_HOUR: "2" });
    const k = install();
    const mk = (i: number) =>
      upload({ operation: op({ name: `op${i}`, match: { host: "www.example.com", path: `/api/${i}` } }) });
    assert.equal((await send(env, "POST", "/v1/versions", { as: k, ip: NET1, body: mk(1) })).status, 201);
    assert.equal((await send(env, "POST", "/v1/versions", { as: k, ip: NET2, body: mk(2) })).status, 201);
    const over = await send(env, "POST", "/v1/versions", { as: k, ip: "100.64.0.1", body: mk(3) });
    assert.equal(over.status, 429);
    const wait = Number(over.headers.get("retry-after"));
    assert.ok(wait > 0 && wait <= 3600, String(wait));
    // other keys on one network
    assert.equal(
      (await send(env, "POST", "/v1/versions", { as: install(), ip: "100.64.0.2", body: mk(4) })).status,
      201,
    );
    assert.equal(
      (await send(env, "POST", "/v1/versions", { as: install(), ip: "100.64.0.3", body: mk(5) })).status,
      429,
    );
  });

  test("reports count one by one", async () => {
    const { env } = registry({ REPORTS_PER_HOUR: "3" });
    const { hash } = (await seed(env, { site, operations: [op()] })).body.operations[0];
    const k = install();
    const four = Array(4).fill({ hash, outcome: "ok" });
    assert.equal((await send(env, "POST", "/v1/reports", { as: k, body: { reports: four } })).status, 429);
    const many = Array(51).fill({ hash, outcome: "ok" });
    assert.equal((await send(env, "POST", "/v1/reports", { as: install(), body: { reports: many } })).status, 400);
    const unknown = await send(env, "POST", "/v1/reports", {
      as: install(),
      ip: NET2,
      body: { reports: [{ hash: "a".repeat(64), outcome: "ok" }] },
    });
    assert.deepEqual(unknown.body, { accepted: 0, ignored: 1 });
  });

  test("an empty report batch counts as one", async () => {
    const { env, raw } = registry({ REPORTS_PER_HOUR: "3" });
    const statuses: number[] = [];
    for (const body of [{ reports: [] }, [], { reports: [] }, { reports: [] }, []])
      statuses.push((await send(env, "POST", "/v1/reports", { as: install(), ip: NET1, body })).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM keys").get() as { n: number }).n, 3);
  });
});

describe("admin", () => {
  test("a maintainer blocks a version; nobody else can", async () => {
    const { env } = registry();
    const { hash } = (await send(env, "POST", "/v1/versions", { as: install(), body: upload() })).body;
    const path = `/v1/admin/versions/${hash}`;
    assert.equal((await send(env, "POST", path, { body: { status: "blocked" } })).status, 403);
    assert.equal(
      (await send(env, "POST", path, { body: { status: "blocked" }, headers: { authorization: "Bearer nope" } }))
        .status,
      403,
    );
    const ok = await send(env, "POST", path, {
      body: { status: "blocked" },
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.deepEqual(ok.body, { hash, status: "blocked" });
    assert.equal((await send(env, "GET", "/v1/sites/example-com")).status, 404);
    const unknown = await send(env, "POST", `/v1/admin/versions/${"b".repeat(64)}`, {
      body: { status: "live" },
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(unknown.status, 404);
  });

  test("a maintainer can promote a review version", async () => {
    const { env } = registry();
    const r = await send(env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ operation: op({ learnedLoggedIn: true }) }),
    });
    await send(env, "POST", `/v1/admin/versions/${r.body.hash}`, {
      body: { status: "live" },
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal((await send(env, "GET", "/v1/sites/example-com")).body.operations[0].status, "live");
  });

  test("seed inserts the site context and its ops live, and a re-seed replaces what changed", async () => {
    const { env } = registry();
    const notes = "Search by title words.";
    const first = await seed(env, {
      site: { ...site, notes },
      operations: [op(), op({ name: "bookPage", match: { host: "www.example.com", path: "/api/book" } })],
    });
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(
      first.body.operations.map((o: { status: string }) => o.status),
      ["live", "live"],
    );
    const served = (await send(env, "GET", "/v1/sites/example-com")).body;
    assert.equal(served.notes, notes);
    assert.equal(served.operations[0].lastOkAt, undefined, "a seed is no ok report");
    assert.equal(served.domain, "example.com");
    assert.deepEqual(
      served.operations.map((o: { status: string; operation: { name: string } }) => [o.operation.name, o.status]),
      [
        ["bookPage", "live"],
        ["searchBooks", "live"],
      ],
    );
    const changed = op({ description: "Find books, better" });
    const again = await seed(env, { site, operations: [changed] });
    const after = (await send(env, "GET", "/v1/sites/example-com")).body.operations;
    assert.deepEqual(
      after.map((o: { hash: string }) => o.hash),
      [again.body.operations[0].hash],
    );
    assert.equal((await send(env, "POST", "/v1/admin/seed", { body: { site, operations: [op()] } })).status, 403);
    const bad = await seed(env, { site: { ...site, domain: "example.org" }, operations: [op()] });
    assert.equal(bad.status, 422);
  });

  test("a site's pace is stored with its context and served with it; one the shared rules refuse is not", async () => {
    const { env } = registry();
    const pace = { minIntervalMs: 2000, perHour: 60 };
    const seeded = await seed(env, { site: { ...site, pace }, operations: [op()] });
    assert.equal(seeded.status, 200, seeded.text);
    assert.deepEqual((await send(env, "GET", "/v1/sites/example-com")).body.pace, pace);
    for (const bad of [{ minIntervalMs: 120_000 }, { perHour: 0 }, { perHour: 5000 }, { every: 1 }])
      assert.ok(
        [400, 422].includes((await seed(env, { site: { ...site, pace: bad }, operations: [op()] })).status),
        JSON.stringify(bad),
      );
    // an upload's first context sets it too, under the same rules
    const fresh = registry().env;
    const as = install();
    const up = await send(fresh, "POST", "/v1/versions", { body: upload({ site: { ...site, pace } }), as });
    assert.equal(up.status, 201, up.text);
    const own = await send(fresh, "GET", "/v1/sites/example-com", { as });
    assert.deepEqual(own.body.pace, pace);
    const refused = await send(registry().env, "POST", "/v1/versions", {
      body: upload({ site: { ...site, pace: { minIntervalMs: 120_000 } } }),
      as: install(),
    });
    assert.ok(refused.status >= 400, refused.text);
  });

  test("a seeded write is held to an upload's rule: its readback carries the read, never names one", async () => {
    const { readOnly: _r, description: _d, params: _p, ...read } = op();
    const write = (readback: Record<string, unknown>) =>
      op({
        name: "addBook",
        readOnly: false,
        request: { method: "POST", url: "https://www.example.com/api/shelf", headers: {}, body: "title=dune" },
        slots: [{ param: "title", at: ["body", "form:title"] }],
        params: [{ name: "title" }],
        trigger: { url: "https://www.example.com/shelf" },
        match: { host: "www.example.com", path: "/api/shelf" },
        readback,
      });
    const { env } = registry();
    for (const name of ["searchBooks", "nope"]) {
      const named = await seed(env, { site, operations: [op(), write({ op: name, args: { q: "{title}" } })] });
      assert.equal(named.status, 422, named.text);
      assert.match(named.body.reasons.join("\n"), new RegExp(`readback names ${name}`));
    }
    const carried = write({ read: { ...read, params: [{ name: "q" }] }, args: { q: "{title}" } });
    const ok = await seed(env, { site, operations: [op(), carried] });
    assert.equal(ok.status, 200, ok.text);
  });
});

describe("serving", () => {
  test("search refuses a query longer than its cap, since each listed op repeats the query's words", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const r = await send(env, "GET", `/v1/search?q=${encodeURIComponent(long)}`);
    assert.equal(r.status, 400, r.text);
    assert.equal((await send(env, "GET", `/v1/search?q=${encodeURIComponent("book ratings")}`)).status, 200);
  });

  test("search answers SearchMatch with FoundOp params", async () => {
    const { env } = registry();
    const seeded = await seed(env, { site, operations: [op()] });
    await seed(env, {
      site: { name: "weather", domain: "example.net", baseUrl: "https://www.example.net", description: "Forecasts" },
      operations: [
        op({
          name: "forecast",
          description: "The forecast for a city",
          request: { method: "GET", url: "https://www.example.net/api/forecast?city=paris", headers: {} },
          slots: [{ param: "city", at: ["query:city"] }],
          trigger: { url: "https://www.example.net/?city={city}" },
          match: { host: "www.example.net", path: "/api/forecast" },
          params: [{ name: "city", required: true, example: "paris" }],
        }),
      ],
    });
    const r = await send(env, "GET", "/v1/search?q=book%20ratings");
    assert.equal(r.status, 200);
    assert.equal(r.body.matches.length, 1);
    const [m] = r.body.matches;
    assert.equal(m.name, "example-com");
    assert.equal(m.domain, "example.com");
    assert.equal(m.displayName, "Books");
    assert.deepEqual(m.operations, [
      {
        name: "searchBooks",
        signature: "searchBooks(q) -> title, avgRating",
        description: "Find books by title words, with their ratings",
        status: "live",
        confirmations: 0,
        registry: { hash: seeded.body.operations[0].hash, status: "live", confirmations: 0 },
        matched: ["book", "rating"],
        unmatched: [],
        params: [{ name: "q", type: "string", required: true, description: "title words", example: "dune" }],
      },
    ]);
    assert.equal((await send(env, "GET", "/v1/search?q=example.net")).body.matches[0].name, "weather");
    assert.equal((await send(env, "GET", "/v1/search")).status, 400);
  });

  test("search and pull expose only stored aggregate health, including unknown health on a seed", async () => {
    const { env } = registry();
    const seeded = await seed(env, { site, operations: [op()] });
    const hash = seeded.body.operations[0].hash;
    let served = (await send(env, "GET", "/v1/sites/example-com")).body.operations[0];
    assert.deepEqual(served.registry, { hash, status: "live", confirmations: 0 });
    const page = await send(env, "GET", "/sites/example-com");
    assert.match(page.text, /success unknown/);
    assert.match(page.text, /last worked unknown/);
    const caller = install();
    await send(env, "POST", "/v1/reports", {
      as: caller,
      body: { reports: [{ hash, outcome: "ok", tier: 2, ms: 123 }] },
    });
    served = (await send(env, "GET", "/v1/sites/example-com")).body.operations[0];
    assert.equal(served.registry.successRate, 1);
    assert.equal(served.registry.confirmations, 1);
    assert.equal(served.registry.lastOkAt, served.lastOkAt);
    const match = (await send(env, "GET", "/v1/search?q=book")).body.matches[0].operations[0];
    assert.deepEqual(match.registry, served.registry);
    assert.equal(match.lastOkAt, served.lastOkAt);
    assert.deepEqual(Object.keys(match.registry).sort(), [
      "confirmations",
      "hash",
      "lastOkAt",
      "status",
      "successRate",
    ]);
    assert.ok(!JSON.stringify(match).includes(caller.key), "no caller identity reaches search");
    assert.equal(match.registry.tier, undefined, "the store has no tier aggregate");
    assert.equal(match.registry.ms, undefined, "the store has no latency aggregate");
  });

  test("partial search explains each op without making unconfirmed sites visible by words", async () => {
    const { env } = registry();
    await seed(env, {
      site,
      operations: [op({ name: "searchRecipes", description: "Search recipes" }), op({ name: "searchAuthors" })],
    });
    const r = await send(env, "GET", "/v1/search?q=vegetarian%20pasta%20recipes");
    assert.equal(r.body.matches.length, 1);
    assert.deepEqual(r.body.matches[0].matched, ["recipe"]);
    assert.deepEqual(r.body.matches[0].unmatched, ["vegetarian", "pasta"]);
    const recipe = r.body.matches[0].operations.find((o: { name: string }) => o.name === "searchRecipes");
    assert.deepEqual(recipe.matched, ["recipe"]);
    assert.deepEqual(recipe.unmatched, ["vegetarian", "pasta"]);

    const fresh = registry();
    await send(fresh.env, "POST", "/v1/versions", {
      as: install(),
      body: upload({ operation: op({ name: "searchRecipes", description: "Search recipes" }) }),
    });
    assert.deepEqual((await send(fresh.env, "GET", "/v1/search?q=vegetarian%20recipes")).body.matches, []);
    assert.equal((await send(fresh.env, "GET", "/v1/search?q=example.com")).body.matches[0].name, "example-com");
  });

  test("the index is a RegistryIndex of the best ops", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    const r = await send(env, "GET", "/v1/index");
    const index = IndexSchema.parse(r.body);
    assert.equal(index.sites[0]!.site, "example-com");
    assert.deepEqual(index.sites[0]!.domains, ["example.com"]);
  });

  test("distinct ops on one endpoint are both served; versions of one op name are one", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op(), op({ name: "searchAuthors" })] });
    const names = (await send(env, "GET", "/v1/sites/example-com")).body.operations.map(
      (o: { operation: { name: string } }) => o.operation.name,
    );
    assert.deepEqual(names, ["searchAuthors", "searchBooks"]);
  });

  test("unknown routes and methods", async () => {
    const { env } = registry();
    assert.equal((await send(env, "GET", "/v1/nothing")).status, 404);
    assert.equal((await send(env, "GET", "/v1/versions")).status, 405);
    assert.equal((await send(env, "GET", "/v1/sites/nobody")).status, 404);
  });
});

describe("pages", () => {
  const hostile = '<script>alert("x")</script>';
  const evil = {
    ...site,
    displayName: `Books ${hostile}`,
    description: `Ratings <img src=x onerror=alert(1)> "quoted"`,
    notes: `- a note with ${hostile} and [a link](javascript:alert(1))\n\n**bold** \`<b>code</b>\``,
  };

  test("a landing page escapes every spec string and runs only its own script", async () => {
    const { env } = registry();
    await seed(env, { site: evil, operations: [op({ description: `Find </td>${hostile}` })] });
    const r = await send(env, "GET", "/sites/example-com");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /text\/html/);
    assert.match(r.headers.get("content-security-policy")!, /script-src 'sha256-/);
    assert.doesNotMatch(r.text, /<script>alert|<img src=x|href="javascript:/);
    assert.match(r.text, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.equal(r.text.match(/<script>/g)?.length, 1);
    assert.match(r.text, /npx -y api-anything setup/);
    assert.match(r.text, /api-anything call example-com searchBooks q=dune/);
    assert.match(r.text, /searchBooks\(q\) -&gt; title, avgRating/);
    assert.match(r.text, /Live/);
    assert.match(r.text, /<strong>bold<\/strong>/);
  });

  test("the copyable call spells an example only when every shell reads it alike, else a placeholder", async () => {
    const { env } = registry();
    const examples = {
      amp: "a&calc&rem ",
      quote: "x';calc;'y",
      pct: "%USERNAME%",
      ctl: "1\u0003\ncalc",
      two: "two words",
    };
    const params = [
      ...op().params,
      ...Object.entries(examples).map(([name, example]) => ({ name, required: false, example })),
    ];
    const seeded = await seed(env, { site, operations: [op({ params })] });
    assert.equal(seeded.status, 200, seeded.text);
    const page = (await send(env, "GET", "/sites/example-com")).text;
    const entities: Record<string, string> = { quot: '"', lt: "<", gt: ">", amp: "&", "#39": "'" };
    const call = /api-anything call example-com [^<]*/.exec(page)![0].replace(/&(#?\w+);/g, (_, e) => entities[e]!);
    assert.equal(
      call.trimEnd(),
      'api-anything call example-com searchBooks q=dune amp=<amp> quote=<quote> pct=<pct> ctl=<ctl> "two=two words"',
    );
  });

  test("the home page lists and searches the sites, escaped", async () => {
    const { env } = registry();
    await seed(env, { site: evil, operations: [op()] });
    const home = await send(env, "GET", "/");
    assert.equal(home.status, 200);
    assert.match(home.text, /href="\/sites\/example-com"/);
    assert.doesNotMatch(home.text, /<script>alert|<img src=x/);
    const q = await send(env, "GET", `/?q=${encodeURIComponent(`ratings ${hostile}`)}`);
    assert.doesNotMatch(q.text, /<script>alert/);
    assert.match(q.text, /href="\/sites\/example-com"/);
    const none = await send(env, "GET", "/?q=zzzzzz");
    assert.match(none.text, /No shared site matches/);
    assert.equal((await send(env, "GET", "/sites/nobody")).status, 404);
  });

  test("the sitemap lists every served site", async () => {
    const { env } = registry();
    await seed(env, { site, operations: [op()] });
    const r = await send(env, "GET", "/sitemap.xml");
    assert.match(r.headers.get("content-type")!, /xml/);
    assert.match(r.text, /<loc>https:\/\/registry\.test\/sites\/example-com<\/loc>/);
  });
});
