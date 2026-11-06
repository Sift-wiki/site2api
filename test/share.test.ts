/**
 * The client side of the shared registry against a stand-in for the service on localhost: what
 * shareOps uploads and when, publish, reports, the heal-back, background verification and the
 * bundled upgrade. No request leaves this machine: each op's site answers through an injected fetch.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readUpload } from "../registry/src/upload.js";
import { DAILY_JOBS, verifyCandidates } from "../src/background.js";
import { verifySite } from "../src/checks.js";
import { cleanCall } from "../src/clean.js";
import { call } from "../src/execute.js";
import { resolver } from "../src/http.js";
import { ensureKey, saveSettings, signedHeaders } from "../src/identity.js";
import { embedReadback, plan, registryName } from "../src/publish.js";
import { adopt } from "../src/registry.js";
import { anonymous, fingerprintText } from "../src/registry-api.js";
import { settle } from "../src/report.js";
import { mergeCapture, saveSession } from "../src/session.js";
import { answerClaims, HOLDOUT_PURPOSE, shareOps } from "../src/share.js";
import { parseSite, type Site } from "../src/spec.js";
import { exportSite, loadSite, registryDir, saveSite, userSitesDir } from "../src/store.js";
import { vetShared } from "../src/vet.js";
import { type FakeRegistry, hashOf, served, startRegistry } from "./fixture/registry.js";

let fake: FakeRegistry;
let onUpload: FakeRegistry["onUpload"];
const realLookup = resolver.lookup;
/** what each host resolves to: a public address unless a test says otherwise; no DNS query leaves the machine */
const dns = new Map<string, string>();
before(async () => {
  fake = await startRegistry();
  onUpload = fake.onUpload;
  process.env.API_ANYTHING_REGISTRY = fake.url;
  resolver.lookup = async (host) => [{ address: dns.get(host) ?? "93.184.215.14" }];
});
after(() => {
  resolver.lookup = realLookup;
});
after(() => fake.close());
beforeEach(() => {
  process.env.API_ANYTHING_HOME = mkdtempSync(join(tmpdir(), "aa-share-"));
  fake.onUpload = onUpload;
  fake.sites.clear();
  fake.raw.clear();
  fake.jobs = [];
  fake.wanted = [];
  fake.received.length = 0;
  fake.down = false;
  fake.hang = false;
  fake.abandoned = 0;
  dns.clear();
});

const shareOn = (share = true) => saveSettings({ share, askedAt: "2026-10-25T00:00:00.000Z" });

const site = (op: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Site =>
  parseSite({
    name: "demo",
    baseUrl: "https://www.example.com",
    operations: [
      {
        name: "search",
        request: { method: "GET", url: "https://www.example.com/api/search?q=kittens", headers: {} },
        slots: [{ param: "q", at: ["query:q"] }],
        params: [{ name: "q", example: "puppies" }],
        trigger: { url: "https://www.example.com/search?q={q}" },
        match: { host: "www.example.com", path: "/api/search" },
        response: { extract: "hits" },
        readOnly: true,
        ...op,
      },
    ],
    ...over,
  });

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const uploads = () => fake.received.filter((r) => r.path === "/v1/versions");
const reportRequests = () => fake.received.filter((r) => r.path === "/v1/reports");

/* ------------------------------------------------------------ shareOps */

test("whole-site exports keep links but one-op uploads omit their unavailable targets", () => {
  const spec = site();
  const read = structuredClone(spec.operations[0]!);
  read.name = "detail";
  spec.operations.push(read);
  spec.operations[0]!.links = [{ from: "id", to: { op: "detail", arg: "q" } }];
  saveSite(spec);
  assert.deepEqual(vetShared(spec).errors, []);
  assert.deepEqual(exportSite("demo").spec.operations[0]!.links, spec.operations[0]!.links);
  const preview = plan("demo", { ops: ["search"] });
  assert.equal(preview.ops[0]!.upload.operation.links, undefined);
  assert.ok(preview.stripped.some((s) => /operation links/.test(s)));
  assert.equal(
    preview.errors.some((s) => /link target/.test(s)),
    false,
  );
  assert.deepEqual(loadSite("demo")!.site.operations[0]!.links, spec.operations[0]!.links);
  // the registry's version of the op replaces it, the links it could not carry kept
  const version = { ...preview.ops[0]!.upload.operation, description: "served" };
  adopt("demo", spec.operations[0]!, version);
  const now = loadSite("demo")!.site.operations[0]!;
  assert.equal(now.description, "served");
  assert.deepEqual(now.links, spec.operations[0]!.links);
});

test("shareOps: a public read goes automatically, signed, and the local op records its version", async () => {
  shareOn();
  saveSite(site());
  const [out] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  // a site learned here goes up under the name the registry gives a new site: its domain, dots as dashes
  assert.deepEqual(out, {
    site: "demo",
    as: "example-com",
    op: "search",
    shared: true,
    hash: out!.hash,
    status: "candidate",
  });
  const [u] = fake.uploads();
  assert.equal(out!.hash, hashOf("example-com", u!.operation), "the hash is the service's, over the op as sent");
  assert.deepEqual(u!.evidence, {
    clientVersion: u!.evidence.clientVersion,
    learnedLoggedIn: false,
    cleanReplay: "ok",
  });
  assert.match(u!.evidence.clientVersion, /^\d+\.\d+\.\d+/);
  assert.deepEqual(
    { name: u!.site.name, domain: u!.site.domain, baseUrl: u!.site.baseUrl },
    { name: "example-com", domain: "example.com", baseUrl: "https://www.example.com" },
  );
  assert.equal(u!.operation.params[0]!.example, "puppies");
  assert.equal(u!.operation.response.shape, undefined);
  assert.deepEqual(loadSite("demo")!.site.operations[0]!.version, { hash: out!.hash, status: "candidate" });
  assert.equal(uploads()[0]!.verified, true, "signed, and the signature verifies");
});

test("shareOps: an op whose recorded check fails on this version is refused, as publish refuses it", async () => {
  shareOn();
  saveSite(site({ checks: [{ args: { q: "zzzz" }, expect: "empty" }] }));
  const fetchImpl = (async () => json({ hits: [{ title: "something" }] })) as typeof fetch;
  await verifySite("demo", { maxTier: 1, minIntervalMs: 0, fetchImpl });
  const [out] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.equal(out!.shared, false, JSON.stringify(out));
  assert.match(out!.reason!, /refused: .*check 1 \(q=zzzz\) expects empty, and answered result/);
  assert.equal(uploads().length, 0);
});

test("shareOps: a read whose clean replay met a bot wall is public too, and goes automatically", async () => {
  shareOn();
  saveSite(site());
  const [out] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "blocked" } });
  assert.equal(out!.shared, true, JSON.stringify(out));
  assert.equal(fake.uploads()[0]!.evidence.cleanReplay, "blocked");
});

test("shareOps: learn_site's holdout check does not hold back an automatic share; a check the user recorded does", async () => {
  shareOn();
  saveSite(site({ checks: [{ args: { q: "kittens" }, expect: "result", purpose: HOLDOUT_PURPOSE }] }));
  const [out] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.equal(out!.shared, true, JSON.stringify(out));
  assert.match(out!.personal!.join("\n"), /checks\[0\] sends q=kittens/);

  // api-anything check records one with the user's own values, or with any other purpose: their yes first
  for (const checks of [
    [{ args: { q: "my-own-query" }, expect: "result" }],
    [{ args: { q: "my-own-query" }, expect: "result", purpose: "my order" }],
    [
      { args: { q: "kittens" }, expect: "result", purpose: HOLDOUT_PURPOSE },
      { args: { q: "my-own-query" }, expect: "result" },
    ],
  ]) {
    fake.received.length = 0;
    saveSite(site({ checks }));
    const [held] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
    assert.deepEqual([held!.shared, held!.needsConsent], [false, true], JSON.stringify(held));
    assert.match(held!.personal!.join("\n"), /my-own-query/);
    assert.equal(uploads().length, 0, "nothing went up");
    const [yes] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" }, consent: true });
    assert.equal(yes!.shared, true);
  }
});

test("shareOps: an automatic share sends no notes the user wrote; consent does, and a pulled site's notes go back with a heal", async () => {
  shareOn();
  saveSite(site());
  writeFileSync(join(userSitesDir(), "demo.md"), "My own notes about my account.\n");
  await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.equal(fake.uploads()[0]!.site.notes, undefined, "the user's own notes stay here");
  await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" }, consent: true });
  assert.equal(fake.uploads()[1]!.site.notes, "My own notes about my account.");

  // a pulled site's notes came from the registry: they go back up with its healed op
  rmSync(join(userSitesDir(), "demo.md"));
  mkdirSync(registryDir(), { recursive: true });
  writeFileSync(join(registryDir(), "demo.md"), "Search is stories only.\n");
  await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.equal(fake.uploads()[2]!.site.notes, "Search is stories only.");
});

test("shareOps: anything that is not a public read waits for the user's yes", async () => {
  shareOn();
  const cases: [string, Site, Record<string, unknown>][] = [
    ["no clean replay", site(), { cleanReplay: "skipped" }],
    ["the clean replay failed", site(), { cleanReplay: "failed" }],
    ["learned signed in", site({ learnedLoggedIn: true }), { cleanReplay: "ok" }],
    ["signed in, by the evidence", site(), { cleanReplay: "ok", learnedLoggedIn: true }],
    [
      "a write",
      site({
        readOnly: false,
        request: { method: "POST", url: "https://www.example.com/api/save", headers: {}, body: '{"q":"x"}' },
        slots: [{ param: "q", at: ["body", "json:/q"] }],
        match: { host: "www.example.com", path: "/api/save" },
      }),
      { cleanReplay: "ok" },
    ],
    [
      "a host off its site",
      site({
        request: { method: "GET", url: "https://search.other-example.net/q?q=kittens", headers: {} },
        match: { host: "search.other-example.net", path: "/q" },
      }),
      { cleanReplay: "ok" },
    ],
    ["a public name", site({ public: ["x-api-key"] }), { cleanReplay: "ok" }],
  ];
  for (const [what, s, evidence] of cases) {
    saveSite(s);
    const [out] = await shareOps("demo", ["search"], { evidence });
    assert.equal(out!.shared, false, what);
    assert.equal(out!.needsConsent, true, what);
    // an op learned signed in also goes up by its fingerprint alone, never its body
    const expected =
      what === "learned signed in" ? /only its fingerprint .* or now with the user's yes/ : /only with the user's yes/;
    assert.match(out!.reason ?? "", expected, what);
  }
  assert.equal(uploads().length, 0, "nothing was sent");

  // with the user's yes, each goes up, and the registry decides it is reviewed
  saveSite(site({ learnedLoggedIn: true }));
  const [yes] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" }, consent: true });
  assert.deepEqual([yes!.shared, yes!.status], [true, "review"]);
  assert.equal(fake.uploads()[0]!.evidence.learnedLoggedIn, true);
});

/** A read whose example is in its request, and a write whose readback names it. */
const withReadback = (readback: Record<string, unknown> = { op: "lookup", args: { title: "{title}" } }): Site =>
  parseSite({
    name: "demo",
    baseUrl: "https://www.example.com",
    operations: [
      {
        name: "lookup",
        request: { method: "GET", url: "https://www.example.com/posts?title=kittens", headers: {} },
        slots: [{ param: "title", at: ["query:title"] }],
        params: [{ name: "title", example: "kittens", description: "words of the title" }],
        trigger: { url: "https://www.example.com/search" },
        match: { host: "www.example.com", path: "/posts" },
        readOnly: true,
      },
      {
        name: "post",
        request: {
          method: "POST",
          url: "https://www.example.com/posts",
          headers: { "content-type": "application/json" },
          body: '{"title":"kittens"}',
        },
        slots: [{ param: "title", at: ["body", "json:/title"] }],
        params: [{ name: "title", example: "kittens" }],
        trigger: { url: "https://www.example.com/new" },
        match: { host: "www.example.com", path: "/posts" },
        readOnly: false,
        readback: { ...readback, find: { field: "title", equals: "{title}" } },
      },
    ],
  });

test("a shared write carries the read its readback runs, never the read's examples; the local spec keeps the name", async () => {
  saveSite(withReadback());
  const p = plan("demo", { ops: ["post"], consent: true });
  assert.deepEqual(p.errors, []);
  const sent = p.ops[0]!.upload.operation;
  const rb = sent.readback!;
  assert.ok("read" in rb && !("op" in rb), JSON.stringify(rb));
  assert.equal(rb.read.name, "lookup");
  assert.equal(decodeURI(rb.read.request.url), "https://www.example.com/posts?title={title}");
  assert.doesNotMatch(JSON.stringify(rb), /kittens|words of the title/);
  assert.deepEqual(rb.args, { title: "{title}" });
  assert.deepEqual(
    vetShared(parseSite({ name: "demo", baseUrl: "https://www.example.com", operations: [sent] })).errors,
    [],
  );
  // the registry takes it as it is sent, and refuses one that names the read
  const read = await readUpload(JSON.parse(JSON.stringify(p.ops[0]!.upload)));
  assert.ok(!("errors" in read), JSON.stringify(read));
  const named = await readUpload({ ...p.ops[0]!.upload, operation: withReadback().operations[1] });
  assert.match(("errors" in named ? named.errors : []).join("\n"), /readback names lookup/);

  const [out] = await shareOps("demo", ["post"], { evidence: {}, consent: true });
  assert.equal(out!.shared, true, JSON.stringify(out));
  assert.ok("read" in fake.uploads()[0]!.operation.readback!);
  const local = loadSite("demo")!.site.operations[1]!;
  assert.deepEqual(local.readback, {
    op: "lookup",
    args: { title: "{title}" },
    find: { field: "title", equals: "{title}" },
  });
  assert.equal(local.version?.hash, out!.hash);
});

test("publish refuses a readback that does not fit the read it names on this machine", () => {
  saveSite(withReadback({ op: "lookup", args: { title: "{title}", page: "2" } }));
  assert.match(
    plan("demo", { ops: ["post"] }).errors.join("\n"),
    /post: readback sets page, which is no param of lookup/,
  );
  saveSite(withReadback({ op: "gone", args: { title: "{title}" } }));
  assert.match(plan("demo", { ops: ["post"] }).errors.join("\n"), /post: readback op gone is no operation of demo/);
});

test("a carried read keeps its paging: an omitted cursor asks for page one, as the named read does", async () => {
  // learned from page 2's request, so its template holds that page's cursor
  const s = withReadback({ op: "lookup", args: {} });
  const lookup = s.operations[0]!;
  const paged = parseSite({
    ...s,
    operations: [
      {
        ...lookup,
        request: { ...lookup.request, url: "https://www.example.com/posts?cursor=second-page" },
        slots: [{ param: "cursor", at: ["query:cursor"] }],
        params: [{ name: "cursor", required: false }],
        response: { extract: "items" },
        paging: { param: "cursor", next: "next" },
      },
      s.operations[1]!,
    ],
  });
  saveSite(paged);
  let urls: string[] = [];
  const fetchImpl = async (u: string | URL | Request, i?: RequestInit) => {
    urls.push(String(u));
    if (i?.method === "POST") return json({ ok: true });
    return new URL(String(u)).searchParams.get("cursor")
      ? json({ error: "invalid cursor" }, 400)
      : json({ items: [{ title: "milk" }], next: null });
  };
  const o = { maxTier: 1 as const, minIntervalMs: 0, fetchImpl, allowWrites: true, again: true };
  const named = await call("demo", "post", { title: "milk" }, o);
  assert.equal(named.write, "applied", JSON.stringify(named));

  const p = plan("demo", { ops: ["post"], consent: true });
  assert.deepEqual(p.errors, []);
  const sent = p.ops[0]!.upload.operation;
  assert.ok(sent.readback && "read" in sent.readback);
  assert.deepEqual(sent.readback.read.paging, { param: "cursor", next: "next" });
  saveSite({ ...paged, operations: [sent] });
  urls = [];
  const carried = await call("demo", "post", { title: "milk" }, o);
  assert.equal(carried.write, "applied", JSON.stringify(carried));
  assert.ok(!urls.some((u) => decodeURIComponent(u).includes("{cursor}")), urls.join("\n"));

  // the carried read is vetted as a read: a required paging param is refused there too
  const bad = structuredClone(sent);
  if (bad.readback && "read" in bad.readback)
    bad.readback.read.params = [{ name: "cursor", type: "string", required: true }];
  assert.match(
    vetShared(parseSite({ name: "demo", baseUrl: "https://www.example.com", operations: [bad] })).errors.join("\n"),
    /readback lookup: paging param cursor is required/,
  );
});

test("a carried read drops a field it does not know; the outer shapes stay apart", () => {
  const s = withReadback();
  const sent = embedReadback(s, s.operations[1]!);
  assert.ok(sent.readback && "read" in sent.readback);
  const later = { ...sent.readback, read: { ...sent.readback.read, futureField: 1 } };
  const parsed = parseSite({ ...s, operations: [{ ...sent, readback: later }] }).operations[0]!.readback!;
  assert.ok("read" in parsed && !("futureField" in parsed.read), JSON.stringify(parsed));
  const ref = parseSite(s).operations[1]!.readback!;
  assert.ok("op" in ref && !("read" in ref), JSON.stringify(ref));
  // a ref with a carried read beside it, or a carried read with an op name, is neither shape
  assert.throws(() =>
    parseSite({ ...s, operations: [s.operations[0], { ...s.operations[1], readback: { ...later, op: "lookup" } }] }),
  );
});

test("shareOps with sharing never asked or off sends nothing on its own, and says which; consent still sends", async () => {
  saveSite(site());
  const [unasked] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.deepEqual(unasked, {
    site: "demo",
    as: "example-com",
    op: "search",
    shared: false,
    reason: unasked!.reason,
  });
  assert.match(unasked!.reason!, /never asked.*setup --yes --share-only/);
  shareOn(false);
  const [off] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.equal(off!.shared, false);
  assert.match(off!.reason!, /sharing is off: the user said no/);
  assert.equal(uploads().length, 0);
  const [yes] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" }, consent: true });
  assert.equal(yes!.shared, true);
  assert.deepEqual(await shareOps("demo", [], { evidence: {}, consent: true }), [], "no names is no ops");
  assert.equal(uploads().length, 1);
});

test("shareOps refuses an op holding a live value, consent or not, and shows what may be the user's own", async () => {
  shareOn();
  const token = "Zx9Qw8vLm7Kj6HgF5dS4aP3oI2uY1tRe";
  saveSite(
    site({
      request: { method: "GET", url: "https://www.example.com/api/search?q=kittens", headers: { "x-api-key": token } },
      public: ["x-api-key"],
    }),
  );
  mergeCapture("demo", [], { from: "https://www.example.com/api", values: { "search/x-api-key": token } });
  const [out] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" }, consent: true });
  assert.equal(out!.shared, false);
  assert.match(out!.reason!, /^refused: .*holds the live session value search\/x-api-key/);
  assert.equal(uploads().length, 0);

  // what may be the user's own: a public read holding it waits for a yes, and a consented one shows it
  saveSession("demo", { cookies: [], values: {} });
  saveSite(site({ description: "my searches, ask me@mail.example.com" }));
  const [held] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.deepEqual([held!.shared, held!.needsConsent], [false, true]);
  assert.match(held!.personal!.join("\n"), /holds an email address \(me@mail\.example\.com\)/);
  const [yes] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" }, consent: true });
  assert.equal(yes!.shared, true);
  assert.match(yes!.personal!.join("\n"), /me@mail\.example\.com/);
});

test("shareOps passes on what the registry refused, and a registry that cannot be reached", async () => {
  shareOn();
  saveSite(site());
  fake.onUpload = () => ({
    status: 409,
    body: { error: "the name demo is bound to another domain", reasons: ["demo is example.org"] },
  });
  const [refused] = await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.equal(refused!.shared, false);
  assert.match(refused!.reason!, /answered 409: the name demo is bound to another domain; demo is example\.org/);
  fake.down = true;
  assert.match((await shareOps("demo", ["search"], { evidence: { cleanReplay: "ok" } }))[0]!.reason!, /answered 503/);
  assert.equal(loadSite("demo")!.site.operations[0]!.version, undefined);
  const [none] = await shareOps("demo", ["nosuch"], { evidence: {} });
  assert.match(none!.reason!, /no operation "nosuch" on demo/);
});

test("signed headers carry this install's key and verify with WebCrypto; a changed body does not", async () => {
  const body = JSON.stringify({ reports: [] });
  const h = signedHeaders("POST", "/v1/reports", body);
  assert.equal(h["x-aa-key"], ensureKey().publicKey);
  const send = (text: string) =>
    fetch(`${fake.url}/v1/reports`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: text,
    });
  await send(body);
  await send(JSON.stringify({ reports: [{ hash: "x", outcome: "ok" }] }));
  assert.deepEqual(
    reportRequests().map((r) => r.verified),
    [true, false],
  );
  // a signed GET signs its query, and the empty body
  shareOn();
  await verifyCandidates();
  const jobs = fake.received.find((r) => r.path.startsWith("/v1/verify-jobs"))!;
  assert.equal(jobs.path, `/v1/verify-jobs?limit=${DAILY_JOBS}`);
  assert.equal(jobs.verified, true);
});

/* ------------------------------------------------------------ publish */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
function cli(...args: string[]): Promise<{ code: number; out: Record<string, unknown> & { [k: string]: never } }> {
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      ["--import", "tsx", join(ROOT, "src", "cli.ts"), ...args],
      { cwd: ROOT, env: { ...process.env } },
      (err, stdout) => resolve({ code: err ? Number(err.code ?? 1) : 0, out: JSON.parse(stdout) }),
    ),
  );
}

test("publish previews each upload, what may be yours and the warnings, and --yes sends them with consent", async () => {
  saveSite(
    site(
      {},
      {
        operations: [
          site().operations[0]!,
          { ...site({ name: "mine", learnedLoggedIn: true, description: "ask me@mail.example.com" }).operations[0]! },
        ],
      },
    ),
  );
  const preview = await cli("publish", "demo");
  assert.equal(preview.code, 0, JSON.stringify(preview.out));
  const ups = preview.out.uploads as unknown as { operation: { name: string }; evidence: { cleanReplay: string } }[];
  assert.deepEqual(
    ups.map((u) => u.operation.name),
    ["search", "mine"],
  );
  assert.match((preview.out.personal as unknown as string[]).join("\n"), /me@mail\.example\.com/);
  assert.match((preview.out.warnings as unknown as string[]).join("\n"), /learned while signed in/);
  assert.match(String(preview.out.next), /explicit OK: api-anything publish demo --yes/);
  assert.equal(uploads().length, 0, "a preview sends nothing");

  const one = await cli("publish", "demo", "mine", "--yes");
  assert.equal(one.code, 0, JSON.stringify(one.out));
  const shared = one.out.shared as unknown as { op: string; shared: boolean; status: string }[];
  assert.deepEqual(
    shared.map((s) => [s.op, s.shared, s.status]),
    [["mine", true, "review"]],
  );
  assert.equal(uploads().length, 1);
  assert.equal(uploads()[0]!.verified, true);
  assert.equal(loadSite("demo")!.site.operations.find((o) => o.name === "mine")!.version?.status, "review");

  const unknown = await cli("publish", "demo", "nosuch");
  assert.equal(unknown.code, 1);
  assert.match(String(unknown.out.error), /no operation "nosuch" on demo/);
});

/* ------------------------------------------------------------ reports */

test("a call of a registry version is reported after it returns, with its outcome, tier and time", async () => {
  shareOn();
  saveSite(site({ version: { hash: "a".repeat(64), status: "live" } }));
  const answers: Response[] = [
    json({ hits: [{ t: 1 }] }),
    new Response("slow down", { status: 429 }),
    new Response("boom", { status: 500 }),
  ];
  for (const r of answers) {
    // each one sent: the 429's cool-down would answer the next without sending, and report nothing
    const res = await call(
      "demo",
      "search",
      { q: "x" },
      { maxTier: 1, minIntervalMs: 0, ignoreCoolDown: true, fetchImpl: async () => r },
    );
    assert.ok(res.class, JSON.stringify(res));
  }
  // an unknown arg is the caller's mistake: reported as input
  await call("demo", "search", { nope: "x" }, { maxTier: 1, minIntervalMs: 0 });
  assert.equal(reportRequests().length, 0, "the calls did not wait for a report");
  await settle(5000);
  const sent = fake.reports();
  assert.deepEqual(
    sent.map((r) => [r.hash, r.outcome, r.tier]),
    [
      ["a".repeat(64), "ok", 1],
      ["a".repeat(64), "rate", 1],
      ["a".repeat(64), "fail", 1],
      ["a".repeat(64), "input", undefined],
    ],
  );
  assert.ok(sent.every((r) => typeof r.ms === "number"));
  assert.equal(reportRequests().length, 1, "one batch");
  assert.ok(reportRequests().every((r) => r.verified));
});

test("a write's carried read is its proof, not a call of its own: only the write is reported", async () => {
  shareOn();
  const s = withReadback();
  const write = { ...embedReadback(s, s.operations[1]!), version: { hash: "c".repeat(64), status: "review" } };
  saveSite({ ...s, operations: [write] });
  const answer = async (_u: string | URL | Request, i?: RequestInit) =>
    i?.method === "POST" ? json({ ok: true }) : json({ unexpected: true });
  const r = await call(
    "demo",
    "post",
    { title: "milk" },
    { maxTier: 1, minIntervalMs: 0, fetchImpl: answer, allowWrites: true },
  );
  assert.deepEqual([r.ok, r.write], [true, "accepted"], JSON.stringify(r));
  await settle(5000);
  assert.deepEqual(
    fake.reports().map((x) => [x.hash, x.outcome]),
    [["c".repeat(64), "ok"]],
  );
});

test("a spent budget and a malformed API_ANYTHING_PACE are no word from the site: neither is reported", async () => {
  shareOn();
  saveSite(site({ version: { hash: "d".repeat(64), status: "live" } }));
  const fetchImpl = async () => json({ hits: [{ t: 1 }] });
  const o = { maxTier: 1 as const, minIntervalMs: 0, fetchImpl };
  try {
    process.env.API_ANYTHING_PACE = "demo:perHour=1";
    assert.equal((await call("demo", "search", { q: "x" }, o)).ok, true);
    const spent = await call("demo", "search", { q: "y" }, o);
    assert.deepEqual([spent.class, spent.budget], ["rate", true]);
    process.env.API_ANYTHING_PACE = "perHour=lots";
    const bad = await call("demo", "search", { q: "z" }, o);
    assert.equal(bad.class, "error");
    assert.match(bad.reason!, /API_ANYTHING_PACE/);
  } finally {
    delete process.env.API_ANYTHING_PACE;
  }
  await settle(5000);
  assert.deepEqual(
    fake.reports().map((r) => [r.hash, r.outcome]),
    [["d".repeat(64), "ok"]],
  );
});

test("a site's pace goes up with its context, and comes back down with it", async () => {
  saveSite(site({}, { pace: { minIntervalMs: 2000, perHour: 60 } }));
  const p = plan("demo");
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.ops[0]!.upload.site.pace, { minIntervalMs: 2000, perHour: 60 });
  // a pace the shared rules refuse never leaves
  saveSite(site({}, { pace: { minIntervalMs: 120_000 } }));
  assert.match(plan("demo").errors.join("\n"), /pace minIntervalMs is 120000/);
});

test("shutdown lets a library caller's process exit soon after its last call, the registry hanging", async () => {
  // a bundled site called with sharing on starts its upgrade from the registry in the background
  const server = createServer((_req, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end('{"hits":[{"t":1}]}'),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = process.env.API_ANYTHING_HOME!;
  const bundled = mkdtempSync(join(tmpdir(), "aa-bundled-"));
  const local = site({ request: { method: "GET", url: `${base}/api/search?q=kittens`, headers: {} } });
  writeFileSync(join(bundled, "demo.json"), JSON.stringify({ ...local, baseUrl: base }));
  shareOn();
  fake.hang = true;
  const src = (f: string) => JSON.stringify(fileURLToPath(new URL(`../src/${f}`, import.meta.url)));
  const script = `const { setBundledDir } = await import(${src("store.ts")});
const { call, shutdown } = await import(${src("index.ts")});
setBundledDir(${JSON.stringify(bundled)});
const r = await call("demo", "search", { q: "x" }, { maxTier: 1, minIntervalMs: 0 });
console.log(JSON.stringify({ ok: r.ok, reason: r.reason, at: Date.now() }));
await shutdown();`;
  try {
    const t0 = Date.now();
    const out = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, API_ANYTHING_HOME: home, API_ANYTHING_REGISTRY: fake.url },
      timeout: 30_000,
    });
    const exited = Date.now();
    const last = JSON.parse(out.stdout.trim().split("\n").at(-1)!);
    assert.equal(last.ok, true, last.reason);
    assert.ok(exited - last.at < 3000, `exited ${exited - last.at} ms after its last call (${exited - t0} ms in all)`);
    assert.ok(
      fake.received.some((r) => r.path === "/v1/sites/demo"),
      "the upgrade did ask the registry",
    );
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(bundled, { recursive: true, force: true });
  }
});

test("reports are never sent with sharing off, and never hold a call or the exit up", async () => {
  saveSite(site({ version: { hash: "b".repeat(64), status: "live" } }));
  const fetchImpl = async () => json({ hits: [{ t: 1 }] });
  await call("demo", "search", { q: "x" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  await settle(2000);
  shareOn(false);
  await call("demo", "search", { q: "x" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  await settle(2000);
  assert.equal(reportRequests().length, 0, "sharing off: nothing sent");

  shareOn();
  fake.hang = true;
  const r = await call("demo", "search", { q: "x" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  assert.equal(r.ok, true);
  const t0 = Date.now();
  await settle(300);
  assert.ok(Date.now() - t0 < 1500, "a registry that does not answer is given up on");
  // and the report on its way is stopped, so it does not hold the process open until its timeout
  for (let i = 0; i < 50 && !fake.abandoned; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.abandoned, 1);
  fake.hang = false;
  fake.down = true;
  const down = await call("demo", "search", { q: "x" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  assert.equal(down.ok, true, "a registry that is down changes nothing about the call");
  await settle(2000);
});

/* ------------------------------------------------------------ heal back */

const QID = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7H";
const NEW = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3S";

test("a call that heals a registry version reports it failed, and shares the healed op back with its parent", async () => {
  shareOn();
  const parent = "c".repeat(64);
  saveSite(
    site({
      request: { method: "GET", url: `https://www.example.com/api/${QID}/search?q=kittens`, headers: {} },
      volatile: [{ at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "Search" }],
      trigger: { url: "https://www.example.com/s/{q}" },
      match: { host: "www.example.com", path: "/api/*/search" },
      version: { hash: parent, status: "live" },
    }),
  );
  const cookies: (string | null)[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://www.example.com/s/"))
      return new Response('<script src="/app.js"></script>', { headers: { "content-type": "text/html" } });
    if (url === "https://www.example.com/app.js") return new Response(`r=[{id:"${NEW}",name:"Search"}]`);
    if (url.includes(`/api/${NEW}/search`)) {
      cookies.push(new Headers(init?.headers).get("cookie"));
      return json({ hits: [{ q: new URL(url).searchParams.get("q") }] });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  saveSession("demo", {
    cookies: [
      {
        name: "sid",
        value: "s3cr3t-session",
        domain: "www.example.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ],
    values: {},
  });
  const r = await call("demo", "search", { q: "bob" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  assert.equal(r.healed, true, JSON.stringify(r));
  await settle(5000);
  assert.deepEqual(
    fake.reports().map((x) => [x.hash, x.outcome]),
    [[parent, "fail"]],
    "the version as it was drifted",
  );
  const [u] = fake.uploads();
  assert.equal(u?.parent, parent);
  assert.equal(u?.evidence.healedFrom, parent);
  // the registry counts a heal only after the uploader's fail report on its parent: the report goes first
  const paths = fake.received.map((x) => x.path);
  assert.ok(
    paths.indexOf("/v1/reports") >= 0 && paths.indexOf("/v1/reports") < paths.indexOf("/v1/versions"),
    paths.join(", "),
  );
  assert.equal(u?.evidence.cleanReplay, "ok");
  assert.match(u!.operation.request.url, new RegExp(`/api/${NEW}/search`));
  assert.equal(cookies.at(-1), null, "the clean replay sent no cookie");
  const op = loadSite("demo")!.site.operations[0]!;
  assert.deepEqual(op.version, { hash: hashOf("example-com", u!.operation), status: "candidate" });
});

test("a heal of a version that is not public is not shared back, and the healed op is no longer that version", async () => {
  shareOn();
  saveSite(
    site({
      request: { method: "GET", url: `https://www.example.com/api/${QID}/search?q=kittens`, headers: {} },
      volatile: [{ at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "Search" }],
      trigger: { url: "https://www.example.com/s/{q}" },
      match: { host: "www.example.com", path: "/api/*/search" },
      learnedLoggedIn: true,
      version: { hash: "d".repeat(64), status: "review" },
    }),
  );
  saveSession("demo", {
    cookies: [
      {
        name: "sid",
        value: "s3cr3t-session",
        domain: "www.example.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ],
    values: {},
    source: "window",
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://www.example.com/s/"))
      return new Response(`<script>r={id:"${NEW}",name:"Search"}</script>`, {
        headers: { "content-type": "text/html" },
      });
    if (url.includes(`/api/${NEW}/search`)) return json({ hits: [{ q: 1 }] });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const r = await call("demo", "search", { q: "bob" }, { maxTier: 1, minIntervalMs: 0, fetchImpl });
  assert.equal(r.healed, true, JSON.stringify(r));
  await settle(5000);
  assert.equal(fake.uploads().length, 0);
  assert.equal(loadSite("demo")!.site.operations[0]!.version, undefined);
});

/* ------------------------------------------------- background verification */

test("background verification calls each candidate with no cookies over plain HTTP, reports it, and stops at 20 a day", async () => {
  const cand = site();
  fake.sites.set("demo", served(cand, undefined, "candidate"));
  const hash = hashOf("demo", cand.operations[0]!);
  fake.jobs = Array.from({ length: 25 }, (_, i) => ({ hash, site: "demo", op: "search", args: { q: `q${i}` } }));
  // the user's own session for that site is never sent
  saveSession("demo", {
    cookies: [
      {
        name: "sid",
        value: "s3cr3t-session",
        domain: "www.example.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ],
    values: { "search/authorization": "Bearer s3cr3t-value" },
  });
  const sent: { url: string; cookie: string | null; auth: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    sent.push({ url: String(input), cookie: h.get("cookie"), auth: h.get("authorization") });
    return json({ hits: [{ t: 1 }] });
  }) as typeof fetch;

  assert.equal(await verifyCandidates({ fetchImpl, minIntervalMs: 0 }), 0, "sharing off: none");
  assert.equal(fake.received.length, 0);

  shareOn();
  const now = new Date("2026-10-25T12:00:00Z");
  assert.equal(await verifyCandidates({ fetchImpl, minIntervalMs: 0, now }), DAILY_JOBS);
  assert.equal(sent.length, DAILY_JOBS);
  assert.ok(
    sent.every((s) => s.cookie === null && s.auth === null),
    "no cookie, no session value",
  );
  assert.equal(sent[0]!.url, "https://www.example.com/api/search?q=q0");
  assert.equal(loadSite("demo"), undefined, "the candidate was not installed");
  const reports = fake.reports();
  assert.equal(reports.length, DAILY_JOBS);
  assert.deepEqual(reports[0], { hash, outcome: "ok", tier: 1, ms: reports[0]!.ms });
  assert.equal(await verifyCandidates({ fetchImpl, minIntervalMs: 0, now }), 0, "today's are spent");
  assert.equal(
    await verifyCandidates({ fetchImpl, minIntervalMs: 0, now: new Date("2026-10-26T12:00:00Z") }),
    DAILY_JOBS,
    "a new day",
  );

  // a job whose candidate the registry does not serve, or one off the shared rules, is skipped
  fake.jobs = [{ hash: "e".repeat(64), site: "demo", op: "search", args: { q: "x" } }];
  fake.sites.set(
    "bad",
    served(site({ request: { method: "GET", url: "http://www.example.com/api?q=x", headers: {} } }, { name: "bad" })),
  );
  fake.jobs.push({ hash: fake.sites.get("bad")!.operations[0]!.hash, site: "bad", op: "search", args: { q: "x" } });
  sent.length = 0;
  assert.equal(await verifyCandidates({ fetchImpl, minIntervalMs: 0, now: new Date("2026-10-27T12:00:00Z") }), 0);
  assert.equal(sent.length, 0);
});

test("background verification checks the version a job names, even one its site does not serve as the op's best", async () => {
  shareOn();
  const best = site();
  fake.sites.set("demo", served(best, undefined, "candidate"));
  // a second candidate of the same op, ranked below the first: /v1/sites does not serve it
  const other = site({ request: { method: "GET", url: "https://www.example.com/api/v2/search?q=x", headers: {} } });
  const op = other.operations[0]!;
  const hash = hashOf("demo", op);
  const job = { hash, site: "demo", op: "search", args: { q: "kept" } };
  const sent: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    sent.push(String(input));
    return json({ hits: [{ t: 1 }] });
  }) as typeof fetch;
  const now = new Date("2026-10-28T12:00:00Z");

  fake.jobs = [{ ...job, operation: op, baseUrl: other.baseUrl }];
  assert.equal(await verifyCandidates({ fetchImpl, minIntervalMs: 0, now }), 1);
  assert.deepEqual(sent, ["https://www.example.com/api/v2/search?q=kept"]);
  assert.deepEqual(fake.reports().at(-1), { hash, outcome: "ok", tier: 1, ms: fake.reports().at(-1)!.ms });

  // a copy that does not hash to the job's hash is not used: the served site has no such version
  sent.length = 0;
  const tampered = { ...op, request: { ...op.request, url: "https://www.example.com/elsewhere?q=x" } };
  fake.jobs = [{ ...job, operation: tampered, baseUrl: other.baseUrl }];
  assert.equal(await verifyCandidates({ fetchImpl, minIntervalMs: 0, now }), 0);
  assert.deepEqual(sent, []);
});

test("background verification stops when the client goes away", async () => {
  shareOn();
  const cand = site();
  fake.sites.set("demo", served(cand, undefined, "candidate"));
  const hash = hashOf("demo", cand.operations[0]!);
  fake.jobs = Array.from({ length: 5 }, (_, i) => ({ hash, site: "demo", op: "search", args: { q: `q${i}` } }));
  const stop = new AbortController();
  let calls = 0;
  const fetchImpl = (async () => {
    if (++calls === 2) stop.abort();
    return json({ hits: [{ t: 1 }] });
  }) as typeof fetch;
  await verifyCandidates({ fetchImpl, minIntervalMs: 0, signal: stop.signal });
  assert.ok(calls <= 2, `ran ${calls} jobs after the stop`);
});

/* ------------------------------------------------------- bundled upgrade */

test("a bundled site called with sharing on is upgraded once to the registry's copy, without the agent mark", async () => {
  const bundled = loadSite("hacker-news")!;
  assert.equal(bundled.source, "bundled");
  fake.sites.set("hacker-news", served(bundled.site, readFileSync(join(ROOT, "sites", "hacker-news.md"), "utf8")));
  const opts = { maxTier: 1 as const, minIntervalMs: 0, fetchImpl: async () => new Response("down", { status: 500 }) };

  await call("hacker-news", "frontPage", {}, opts);
  await settle(5000);
  assert.equal(loadSite("hacker-news")!.source, "bundled", "sharing off: no upgrade");
  assert.equal(fake.received.length, 0);

  shareOn();
  await call("hacker-news", "frontPage", {}, opts);
  await settle(5000);
  const now = loadSite("hacker-news")!;
  assert.equal(now.source, "registry");
  assert.equal(now.site.shared?.by, undefined, "the package already trusted it");
  const version = now.site.operations.find((o) => o.name === "frontPage")!.version!;
  assert.equal(version.status, "live");

  // later calls carry the version and report
  await call("hacker-news", "frontPage", {}, opts);
  await settle(5000);
  assert.deepEqual(
    fake.reports().map((r) => [r.hash, r.outcome]),
    [[version.hash, "fail"]],
  );
  assert.equal(fake.received.filter((r) => r.path === "/v1/sites/hacker-news").length, 1, "once");
});

test("a bundled site the registry does not have is asked about once, not on every call", async () => {
  shareOn();
  const opts = { maxTier: 1 as const, minIntervalMs: 0, fetchImpl: async () => new Response("down", { status: 500 }) };
  await call("hacker-news", "frontPage", {}, opts);
  await settle(5000);
  await call("hacker-news", "frontPage", {}, opts);
  await settle(5000);
  assert.equal(fake.received.filter((r) => r.path === "/v1/sites/hacker-news").length, 1);
  assert.equal(loadSite("hacker-news")!.source, "bundled");
});

test("background verification skips a candidate that needs the browser, and sends only to public addresses", async () => {
  shareOn();
  const browserOnly = site({ minTier: 2 }, { name: "paged" });
  const inside = site({
    request: { method: "GET", url: "https://intranet.example.com/api/search?q=kittens", headers: {} },
    match: { host: "intranet.example.com", path: "/api/search" },
  });
  const moved = site(
    {
      request: { method: "GET", url: "https://www.example.org/api/search?q=kittens", headers: {} },
      trigger: { url: "https://www.example.org/search?q={q}" },
      match: { host: "www.example.org", path: "/api/search" },
    },
    { name: "moved", baseUrl: "https://www.example.org" },
  );
  for (const s of [browserOnly, inside, moved]) fake.sites.set(s.name, served(s, undefined, "candidate"));
  fake.jobs = [browserOnly, inside, moved].map((s) => ({
    hash: hashOf(s.name, s.operations[0]!),
    site: s.name,
    op: "search",
    args: { q: "x" },
  }));
  dns.set("intranet.example.com", "192.168.0.10");
  const sent: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    sent.push(String(input));
    // the attacker's server answers with a redirect into this machine
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin/reboot" } });
  }) as typeof fetch;

  assert.equal(await verifyCandidates({ fetchImpl, minIntervalMs: 0 }), 2, "the browser-only candidate is not run");
  assert.deepEqual(sent, ["https://www.example.org/api/search?q=x"], "nothing inside the network was fetched");
  const reports = fake.reports();
  assert.deepEqual(
    reports.map((r) => r.outcome),
    ["fail", "fail"],
  );
  assert.equal(
    reports.some((r) => r.hash === fake.jobs[0]!.hash),
    false,
    "no false fail for the candidate plain HTTP cannot run",
  );
});

test("cleanCall with publicOnly refuses a redirect into the network, and a host that resolves into it, before sending", async () => {
  const op = site().operations[0]!;
  const seen: string[] = [];
  const to = (location: string) =>
    (async (input: string | URL | Request) => {
      seen.push(String(input));
      return String(input).startsWith("https://www.example.com/")
        ? new Response(null, { status: 302, headers: { location } })
        : json({ hits: [{ t: 1 }] });
    }) as typeof fetch;
  for (const location of [
    "http://127.0.0.1:9/admin",
    "https://10.0.0.1/",
    "https://printer.local/",
    "https://[::1]/",
  ]) {
    seen.length = 0;
    const r = await cleanCall(
      op,
      { q: "x" },
      { site: "demo", fetchImpl: to(location), minIntervalMs: 0, publicOnly: true },
    );
    assert.equal(r.class, "error", location);
    assert.match(r.reason, /not following the HTTP 302 redirect/, location);
    assert.equal(seen.length, 1, location);
  }
  dns.set("www.example.com", "169.254.169.254");
  seen.length = 0;
  const meta = await cleanCall(
    op,
    { q: "x" },
    { site: "demo", fetchImpl: to("https://x"), minIntervalMs: 0, publicOnly: true },
  );
  assert.match(meta.reason, /non-public address 169\.254\.169\.254/);
  assert.equal(seen.length, 0);
  // learn_site's own clean replay of the user's own op is not limited
  const own = await cleanCall(
    op,
    { q: "x" },
    { site: "demo", fetchImpl: to("http://127.0.0.1:9/api"), minIntervalMs: 0 },
  );
  assert.equal(own.class, "ok");
});

test("registryName: a site the registry holds keeps its name; any other goes up under its domain's slug", () => {
  assert.equal(registryName(site({}, { name: "demo" })), "example-com");
  assert.equal(registryName(site({}, { name: "anything", baseUrl: "https://search.lobste.rs" })), "lobste-rs");
  assert.equal(registryName(site({}, { name: "example-com" })), "example-com");
  const pulled = site({}, { name: "news", shared: { from: "https://registry/v1/sites/news", sha256: "0".repeat(64) } });
  assert.equal(registryName(pulled), "news", "pulled: bound to that name already");
  assert.equal(
    registryName(site({}, { name: "hacker-news", baseUrl: "https://news.ycombinator.com" })),
    "hacker-news",
    "bundled: the registry was seeded with it",
  );
});

test("shareOps uploads a site under the name the registry serves its domain under, else under the slug", async () => {
  shareOn();
  saveSite(site({}, { name: "booksite", baseUrl: "https://www.example.com" }));
  fake.matches = [{ name: "booksite", domain: "example.com", operations: [] }];
  const [held] = await shareOps("booksite", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.equal(held!.shared, true, JSON.stringify(held));
  assert.equal(held!.as, undefined);
  assert.equal(fake.uploads()[0]!.site.name, "booksite");

  // the registry knows no site of that name for the domain: the slug
  fake.matches = [{ name: "booksite", domain: "booksite.com", operations: [] }];
  const [slug] = await shareOps("booksite", ["search"], { evidence: { cleanReplay: "ok" } });
  assert.equal(slug!.as, "example-com");
  assert.equal(fake.uploads()[1]!.site.name, "example-com");
  fake.matches = [];
});

/* ------------------------------------------------- another install's fix */

/** The site renamed its search param from q to query: a version still sending q gets no list. */
const renamed = (async (input: string | URL | Request) => {
  const u = new URL(String(input));
  if (!u.pathname.startsWith("/api/search")) return new Response("", { status: 404 });
  const q = u.searchParams.get("query");
  return q ? json({ hits: [{ q }] }) : json({ message: "missing query" });
}) as typeof fetch;

/** The repair as the registry serves it, under the name it holds the site by: example-com for a site learned here as demo. */
const repaired = (status: "live" | "candidate" = "live", op: Record<string, unknown> = {}) =>
  served(
    site(
      {
        request: { method: "GET", url: "https://www.example.com/api/search?query=kittens", headers: {} },
        slots: [{ param: "q", at: ["query:query"] }],
        ...op,
      },
      { name: "example-com" },
    ),
    undefined,
    status,
  );

test("a drifted registry version takes the version the registry serves now, before any heal of its own", async () => {
  shareOn();
  const parent = "d".repeat(64);
  saveSite(site({ version: { hash: parent, status: "live" } }));
  const fix = repaired();
  // learned here as demo, shared as example-com: the repair is asked for by the registry's name
  fake.sites.set("example-com", fix);
  const r = await call("demo", "search", { q: "bob" }, { maxTier: 1, minIntervalMs: 0, fetchImpl: renamed });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.healed, true);
  assert.match(r.reason!, /the registry now serves another version of search/);
  assert.deepEqual(r.data, [{ q: "bob" }]);
  const now = loadSite("demo")!.site.operations[0]!;
  assert.deepEqual(now.version, { hash: fix.operations[0]!.hash, status: "live" });
  await settle(5000);
  assert.deepEqual(
    fake
      .reports()
      .map((x) => [x.hash, x.outcome])
      .sort(),
    [
      [parent, "fail"],
      [fix.operations[0]!.hash, "ok"],
    ].sort(),
  );
  assert.equal(uploads().length, 0, "the registry's own version is not shared back as a heal");
});

test("the registry's version is not taken when it is no live one, sends to another endpoint, or needs a tier the caller does not allow", async () => {
  shareOn();
  const parent = "e".repeat(64);
  for (const fix of [
    repaired("candidate"),
    repaired("live", { match: { host: "www.example.com", path: "/api/find" } }),
    // it needs the browser's page fetch, and the caller allows plain HTTP only
    repaired("live", { minTier: 2 }),
  ]) {
    saveSite(site({ version: { hash: parent, status: "live" } }));
    fake.sites.set("example-com", fix);
    const r = await call("demo", "search", { q: "bob" }, { maxTier: 1, minIntervalMs: 0, fetchImpl: renamed });
    assert.equal(r.ok, false);
    assert.equal(loadSite("demo")!.site.operations[0]!.version?.hash, parent, "the op is as it was");
  }
  await settle(2000);
});

/* ------------------------------------------------ ops learned signed in */

const signedInSite = () =>
  site(
    {
      description: "my reading list",
      learnedLoggedIn: true,
      params: [{ name: "q", example: "my secret search", description: "what I look for" }],
    },
    { description: "the books I own" },
  );

test("an op learned signed in sends only its fingerprint, then its anonymous body when the registry asks", async () => {
  shareOn();
  saveSite(signedInSite());
  const [out] = await shareOps("demo", ["search"], { evidence: {} });
  assert.equal(out!.shared, false);
  assert.equal(out!.needsConsent, true, "the user can still say yes now");
  assert.match(out!.reason!, /only its fingerprint went to the registry/);
  assert.equal(uploads().length, 0, "no body went up");
  const [claim] = fake.received.filter((r) => r.path === "/v1/claims");
  assert.ok(claim?.verified, "the claim is signed");
  const body = claim!.body as { site: { name: string }; fingerprint: string; nameHash: string };
  assert.deepEqual(Object.keys(body).sort(), ["fingerprint", "nameHash", "site"]);
  assert.doesNotMatch(JSON.stringify(body), /secret|reading list|books I own/);

  // three installs hold the op, under names that differ: the learner's own name never leaves
  fake.wanted = [{ site: body.site.name, fingerprint: body.fingerprint, named: false }];
  const answered = await answerClaims();
  assert.deepEqual(
    answered.map((a) => [a.op, a.status]),
    [["search", "review"]],
  );
  const [u] = fake.uploads() as (ReturnType<typeof fake.uploads>[number] & { claim?: string })[];
  assert.equal(u!.claim, body.fingerprint);
  assert.equal(u!.operation.name, `op_${body.fingerprint.slice(0, 8)}`, "a name k installs did not choose stays home");
  assert.equal(u!.operation.description, undefined);
  assert.equal(u!.operation.params[0]!.example, undefined, "the user's own args stay home");
  assert.equal(u!.operation.params[0]!.description, undefined);
  assert.equal(u!.site.description, undefined);
  assert.equal(
    createHash("sha256")
      .update(fingerprintText(u!.site.name, anonymous(u!.operation)))
      .digest("hex"),
    body.fingerprint,
  );
});

test("a registry that asks for a fingerprint this install never claimed gets nothing; with sharing off nothing is claimed", async () => {
  shareOn();
  saveSite(signedInSite());
  fake.wanted = [{ site: "example-com", fingerprint: "f".repeat(64), named: true }];
  await shareOps("demo", ["search"], { evidence: {} });
  assert.equal(uploads().length, 0);
  assert.deepEqual(await answerClaims(), []);
  assert.equal(uploads().length, 0);

  fake.received.length = 0;
  shareOn(false);
  await shareOps("demo", ["search"], { evidence: {} });
  assert.equal(fake.received.filter((r) => r.path === "/v1/claims").length, 0);
});

test("a claim is answered under the name the site went up under, and with its own name once k installs chose it", async () => {
  shareOn();
  saveSite(signedInSite());
  // the registry already serves example.com as demo, so the site goes up as demo, not example-com
  fake.matches = [{ name: "demo", domain: "example.com", operations: [] }];
  try {
    await shareOps("demo", ["search"], { evidence: {} });
    const [claim] = fake.received.filter((r) => r.path === "/v1/claims");
    const body = claim!.body as { site: { name: string }; fingerprint: string };
    assert.equal(body.site.name, "demo");
    fake.wanted = [{ site: "demo", fingerprint: body.fingerprint, named: true }];
    const answered = await answerClaims();
    assert.deepEqual(
      answered.map((a) => a.op),
      ["search"],
      "the upload is rebuilt under demo, so it still hashes to the fingerprint",
    );
    const [u] = fake.uploads();
    assert.equal(u!.site.name, "demo");
    assert.equal(u!.operation.name, "search");
  } finally {
    fake.matches = [];
  }
});

/* ------------------------------------------------- sites' own interfaces */

test("search passes on a site's own interfaces, and drops a malformed one without dropping the match", async () => {
  const { search } = await import("../src/registry.js");
  fake.matches = [
    {
      name: "weather-example-org",
      domain: "weather-example.org",
      operations: [],
      interfaces: [
        { kind: "openapi", url: "https://api.weather-example.org/openapi.json", confirmations: 2 },
        { kind: "mcp", url: "http://10.0.0.2/mcp", confirmations: 9 },
      ],
    },
  ];
  try {
    const r = await search("weather-example.org", { local: [] });
    assert.deepEqual(r.matches[0]?.interfaces, [
      { kind: "openapi", url: "https://api.weather-example.org/openapi.json", confirmations: 2 },
    ]);
  } finally {
    fake.matches = [];
  }
});

test("an installed site shows the interfaces the registry knows for its domain, and an eleventh interface drops no match", async () => {
  const { search } = await import("../src/registry.js");
  const many = Array.from({ length: 12 }, (_, i) => ({
    kind: "mcp" as const,
    url: `https://mcp${i}.example.com/sse`,
    confirmations: 2,
  }));
  fake.matches = [{ name: "example-com", domain: "example.com", operations: [], interfaces: many }];
  try {
    const r = await search("example.com", { local: [site()] });
    const here = r.matches.find((m) => m.site === "demo");
    assert.ok(here, "the installed site is still the match");
    assert.equal(here!.installed, true);
    assert.equal(here!.operations[0]!.name, "search", "its own operations stay");
    assert.equal(here!.interfaces?.length, 10, "at most ten, the rest dropped, not the match");
  } finally {
    fake.matches = [];
  }
});
