import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OMITTED } from "../src/secrets.js";
import { saveSession } from "../src/session.js";
import type { Site } from "../src/spec.js";
import {
  appendHeal,
  beginWrite,
  clearCoolDown,
  clearStale,
  coolDown,
  cooling,
  lastHealAt,
  listSites,
  loadSite,
  markStale,
  rememberedTier,
  rememberTier,
  reserveSend,
  saveSite,
  settleWrite,
  siteNotes,
  staleList,
  staleMark,
} from "../src/store.js";

const site = (description: string): Site => ({
  name: "demo",
  baseUrl: "https://demo.test",
  description,
  operations: [
    {
      name: "get",
      request: { method: "GET", url: "https://demo.test/a", headers: {} },
      slots: [],
      volatile: [],
      trigger: { url: "https://demo.test/" },
      match: {},
      response: { format: "json" },
      params: [],
      readOnly: true,
      minTier: 1,
      learnedLoggedIn: false,
    },
  ],
});

function fresh() {
  process.env.API_ANYTHING_HOME = mkdtempSync(join(tmpdir(), "aa-store-"));
  const bundled = mkdtempSync(join(tmpdir(), "aa-bundled-"));
  return { home: process.env.API_ANYTHING_HOME, bundled };
}

test("resolution: user copy wins over bundled; save writes a user copy", () => {
  const { home, bundled } = fresh();
  writeFileSync(join(bundled, "demo.json"), JSON.stringify({ ...site("bundled"), unknownField: 1 }));
  writeFileSync(join(bundled, "other.json"), JSON.stringify({ ...site("other"), name: "other" }));
  const b = loadSite("demo", bundled)!;
  assert.equal(b.source, "bundled");
  assert.equal(b.site.description, "bundled");
  assert.equal((b.site as Record<string, unknown>).unknownField, undefined, "unknown fields stripped");

  const path = saveSite(site("healed"));
  assert.equal(path, join(home, "sites", "demo.json"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const u = loadSite("demo", bundled)!;
  assert.equal(u.source, "user");
  assert.equal(u.site.description, "healed");
  assert.deepEqual(listSites(bundled), ["demo", "other"]);
  assert.equal(loadSite("missing", bundled), undefined);
  assert.throws(() => loadSite("../x", bundled), /invalid site name/);

  mkdirSync(join(home, "sites"), { recursive: true });
  writeFileSync(join(home, "sites", "bad.json"), JSON.stringify({ name: "bad" }));
  assert.throws(() => loadSite("bad", bundled), /bad\.json: invalid site spec/);
});

test("a spec that is not JSON is named in the error, never quoted", () => {
  const { home, bundled } = fresh();
  mkdirSync(join(home, "sites"), { recursive: true });
  const path = join(home, "sites", "broken.json");
  writeFileSync(path, '{"k":SECRETX}');
  assert.throws(
    () => loadSite("broken", bundled),
    (e: unknown) => e instanceof Error && e.message === `${path} is corrupt (not valid JSON); fix or delete it`,
  );
});

test("site notes stop at the Maintainer notes heading; the user's copy wins", () => {
  const { home, bundled } = fresh();
  writeFileSync(
    join(bundled, "demo.md"),
    "Airport codes only.\n\n- First page only.\n\n## Maintainer notes\n\nVerified 2026-09-27.\n\n## How it works\n\nA POST.\n",
  );
  assert.equal(siteNotes("demo", { bundledDir: bundled }), "Airport codes only.\n\n- First page only.");
  // only that heading on a line of its own ends the notes
  const whole =
    "See ## Maintainer notes below.\n\n## Maintainer notes for callers\n\n## Known limits\n\nFirst page only.";
  writeFileSync(join(bundled, "whole.md"), `${whole}\n`);
  assert.equal(siteNotes("whole", { bundledDir: bundled }), whole);
  writeFileSync(join(bundled, "internal.md"), "## Maintainer notes\n\nNothing for callers.\n");
  assert.equal(siteNotes("internal", { bundledDir: bundled }), "");
  assert.equal(siteNotes("missing", { bundledDir: bundled }), undefined);

  // a user's own file, with the heading capitalized another way
  mkdirSync(join(home, "sites"), { recursive: true });
  writeFileSync(join(home, "sites", "demo.md"), "Mine.\n\n## Maintainer Notes\n\nMy own history.\n");
  assert.equal(siteNotes("demo", { bundledDir: bundled }), "Mine.");
});

test("heal log appends JSONL and records the heal time", () => {
  const { home } = fresh();
  appendHeal({ site: "x", op: "getUser", strategy: "rescan", diff: "queryId A -> B" }, 1000);
  appendHeal({ site: "x", op: "getUser", strategy: "recapture", diff: "header added" }, 2000);
  const lines = readFileSync(join(home, "heals.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].strategy, "recapture");
  assert.equal(lastHealAt("x", "getUser"), 2000);
  assert.equal(lastHealAt("x", "other"), undefined);
});

test("stale marks expire after their TTL and carry a reason; tiers are remembered", () => {
  fresh();
  markStale("x", "getUser", "healed twice in 10 min", 30 * 60_000, 0);
  assert.deepEqual(staleMark("x", "getUser", 1000), { until: 30 * 60_000, reason: "healed twice in 10 min" });
  assert.equal(staleMark("x", "getUser", 30 * 60_000), undefined);
  assert.deepEqual(staleList(1000), [
    { site: "x", op: "getUser", until: 30 * 60_000, reason: "healed twice in 10 min" },
  ]);
  clearStale("x", "getUser");
  assert.equal(staleMark("x", "getUser", 1000), undefined);

  assert.equal(rememberedTier("x", "getUser"), undefined);
  rememberTier("x", "getUser", 2);
  assert.equal(rememberedTier("x", "getUser"), 2);
});

test("a stale mark and the heal log never keep a live session value", () => {
  const { home } = fresh();
  const live = "Qa7Ws2Ed9Rf4Tg6Yh1Uj";
  saveSession("x", {
    cookies: [{ name: "sid", value: live, domain: "x.test", path: "/", expires: -1, httpOnly: true, secure: true }],
    values: {},
  });
  markStale("x", "getUser", `heal failed: HTTP 401: bad session ${live}`);
  assert.equal(staleMark("x", "getUser")?.reason, "heal failed: HTTP 401: bad session [redacted]");
  appendHeal({ site: "x", op: "getUser", strategy: "recapture", diff: `token ${encodeURIComponent(live)} -> ref` });
  const log = readFileSync(join(home, "heals.jsonl"), "utf8");
  assert.ok(!log.includes(live) && log.includes("[redacted]"), log);
  // an encoding the replacements miss: the response is left out
  markStale("x", "getUser", `heal failed: HTTP 401: bad session %25${live.charCodeAt(0).toString(16)}${live.slice(1)}`);
  assert.equal(staleMark("x", "getUser")?.reason, `heal failed: ${OMITTED}`);
});

test("write ledger: an unsettled write holds back its repeat, under a local key and without the args", () => {
  const { home } = fresh();
  const args = { comment: "nice post" };
  const first = beginWrite("x", "comment", args, {}, 1000);
  assert.equal(first.send, true);
  // the same args in another key order are the same write; it is still "sending"
  const repeat = beginWrite("x", "comment", { ...args }, {}, 2000);
  assert.deepEqual([repeat.send, !repeat.send && repeat.why], [false, "duplicate"]);
  assert.equal(beginWrite("x", "comment", { comment: "other" }, {}, 2000).send, true);
  assert.equal(beginWrite("x", "comment", args, { again: true }, 2000).send, true);
  if (first.send) settleWrite(first.id, "not_applied", { ok: false, class: "auth" });

  const text = readFileSync(join(home, "writes.json"), "utf8");
  assert.ok(!text.includes("nice post") && !text.includes("other"), text);
  assert.equal(statSync(join(home, "writes.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, "write.key")).mode & 0o777, 0o600);
  // another machine's key gives another digest: the digest cannot be checked against guessed args elsewhere
  const digest = (JSON.parse(text) as { digest: string }[])[0]!.digest;
  writeFileSync(join(home, "write.key"), "00".repeat(32));
  beginWrite("x", "comment", args, { again: true }, 3000);
  const after = JSON.parse(readFileSync(join(home, "writes.json"), "utf8")) as { digest: string }[];
  assert.notEqual(after.at(-1)!.digest, digest);
  // older than a day: dropped
  beginWrite("x", "other", {}, {}, 3000 + 25 * 60 * 60_000);
  assert.equal(JSON.parse(readFileSync(join(home, "writes.json"), "utf8")).length, 1);
});

test("write ledger: processes racing to send the same write let exactly one through", async () => {
  const { home } = fresh();
  const store = new URL("../src/store.ts", import.meta.url).href;
  const script = `const { beginWrite } = await import(${JSON.stringify(store)}); process.stdout.write(String(beginWrite("x", "vote", { id: 7 }).send));`;
  const runs = Array.from(
    { length: 6 },
    () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          { env: { ...process.env, API_ANYTHING_HOME: home } },
          (e, out) => (e ? reject(e) : resolve(out)),
        );
      }),
  );
  const sent = await Promise.all(runs);
  assert.equal(sent.filter((s) => s === "true").length, 1, sent.join(","));
});

test("secret scan: exact live values are secrets; heuristics only warn, and URL paths do not trip them", async () => {
  const { scanSecrets } = await import("../src/secrets.js");
  const session = {
    cookies: [
      { name: "sid", value: '"abc123secret"', domain: "x.test", path: "/", expires: -1, httpOnly: true, secure: true },
    ],
    values: { authorization: "Bearer zzzzzzzz" },
  };
  const spec = {
    url: "https://x.test/api/graphql/SfvBzVjFV1WLibrBOSdD6w/UserByScreenNameAndMore/extra/segments",
    h: { a: "abc123secret", b: "eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl" },
  };
  const r = scanSecrets(spec, session);
  assert.deepEqual(r.secrets, ["$.h.a holds the live cookie sid"]);
  assert.deepEqual(r.warnings, ["$.h.b looks like a JWT (eyJhbGciOi.eyJzdWIiOiIx....); check it is public"]);
});

test("secret scan: a live value that is the spec's own origin is not looked for; any other URL is", async () => {
  const { besideOrigins, scanSecrets } = await import("../src/secrets.js");
  const T = "k7Qm9xLp3Rv8Tz1Wn5Ys6Ub4Hc2Jd0Fa";
  const url = "https://www.x.test/services/graphql/?operationName=Q&ssr=0";
  const b64 = (v: string) => Buffer.from(v).toString("base64");
  const held = (value: string, spec: Record<string, unknown> = {}) =>
    scanSecrets(
      { url, ...spec },
      besideOrigins(
        {
          cookies: [
            { name: "__ps_lu", value, domain: "x.test", path: "/", expires: -1, httpOnly: false, secure: true },
          ],
          values: {},
        },
        [url],
      ),
    ).secrets;
  // an analytics cookie keeping the last page, percent-encoded or raw, with or without the slash, quoted:
  // the spec spells it as its host, so a copy anywhere carries nothing new
  for (const v of ["https%3A%2F%2Fwww.x.test%2F", "https://www.x.test/", "https://www.x.test", '"https://www.x.test/"'])
    assert.deepEqual(held(v, { body: '{"from":"https://www.x.test/"}', ctx: b64("https://www.x.test/") }), [], v);
  // ...and the same as a session value
  const values = { "op/last": "https://www.x.test/", "op/token": T };
  assert.deepEqual(besideOrigins({ cookies: [], values }, [url]).values, { "op/token": T });
  // the spec's host or a parent domain of it (a cookie's domain copied into a value), and a browser's
  // User-Agent kept in page storage: the spec spells the host and sends the browser's headers
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0";
  for (const v of ["www.x.test", ".x.test", "x.test", "X.TEST", UA])
    assert.deepEqual(held(v, { host: "www.x.test", ua: UA }), [], v);
  assert.deepEqual(
    besideOrigins({ cookies: [], values: { "op/domain": ".x.test", "op/ua": UA, "op/token": T } }, [url]).values,
    { "op/token": T },
  );

  // any other URL is looked for, wherever it is copied
  const flagged = "$.ctx holds the live cookie __ps_lu";
  for (const v of [
    "https://k7qm9xlp.x.test/", // another host: a capability host is no origin the spec spells
    "k7qm9xlp.x.test", // ...nor as a bare host
    "https://www.x.test:8443/", // another port
    `https://www.x.test/reset/${T}/`, // a path
    "https://www.x.test/?token=abc123", // a query
    "https://www.x.test/#access_token=abc123", // a fragment
    "https://user:hunter22@www.x.test/", // user info
  ]) {
    assert.deepEqual(held(v, { ctx: b64(v) }), [flagged], v);
    assert.deepEqual(held(encodeURIComponent(v), { ctx: b64(v) }), [flagged], v);
  }
  // a quoted value: the unquoted form is looked for, its quote lets nothing off
  assert.deepEqual(held(`https://${T}"`, { ctx: b64(`https://${T}`) }), [flagged]);
});

test("a spec's file name is its name, so saving never overwrites another site's file", () => {
  const { home } = fresh();
  mkdirSync(join(home, "sites"), { recursive: true });
  writeFileSync(join(home, "sites", "work.json"), JSON.stringify({ ...site("copy"), name: "prod" }));
  writeFileSync(join(home, "sites", "prod.json"), JSON.stringify(site("prod")));
  const r = loadSite("work")!;
  assert.equal(r.site.name, "work");
  saveSite(r.site);
  assert.equal(JSON.parse(readFileSync(join(home, "sites", "prod.json"), "utf8")).description, "prod");
});

test("export: shapes and typed example values stripped, examples kept on request, public headers allowed", async () => {
  const { exportSite } = await import("../src/store.js");
  const { saveSession } = await import("../src/session.js");
  fresh();
  const spec: Site = {
    ...site("x"),
    operations: [
      {
        ...site("x").operations[0]!,
        request: {
          method: "POST",
          url: "https://demo.test/a",
          headers: { authorization: "Bearer PUBLICBEARERPUBLICBEARER" },
          body: '{"id":1234567,"q":"alpha"}',
        },
        slots: [
          { param: "id", at: ["body", "json:/id"] },
          { param: "q", at: ["body", "json:/q"] },
        ],
        params: [
          { name: "id", type: "number", required: true, example: 1234567 },
          { name: "q", type: "string", required: true, example: "alpha" },
        ],
        response: { format: "json", shape: { "viewer.accounts.jane.doe@corp.example": "object" } },
        public: ["authorization"],
      },
    ],
  };
  saveSite(spec);
  saveSession("demo", { cookies: [], values: { authorization: "Bearer PUBLICBEARERPUBLICBEARER" } });
  const r = exportSite("demo");
  const op = r.spec.operations[0]!;
  assert.equal(op.request.body, '{"id":null,"q":"{q}"}');
  assert.equal(op.response.shape, undefined);
  assert.equal(op.params[0]!.example, undefined);
  assert.deepEqual(r.secrets, [], "the public header is allowed");
  assert.equal(exportSite("demo", { keepExamples: true }).spec.operations[0]!.params[1]!.example, "alpha");
  saveSite({ ...spec, operations: [{ ...spec.operations[0]!, public: undefined }] });
  assert.deepEqual(exportSite("demo").secrets, [
    "$.operations[0].request.headers.authorization holds the live session value authorization",
  ]);
});

test("export refuses a hand-written step that types a password, which no live session holds", async () => {
  const { exportSite } = await import("../src/store.js");
  fresh();
  const op = site("x").operations[0]!;
  const steps = [{ action: "fill" as const, selector: "#pw", value: "Hunter2-RealPassw0rd!" }];
  saveSite({ ...site("x"), operations: [{ ...op, trigger: { ...op.trigger, steps } }] });
  assert.deepEqual(exportSite("demo").secrets, [
    "$.operations[0].trigger steps[0] fills a password or one-time-code field (#pw): a sign-in is the user's: ask them to run api-anything login <site> (it imports the cookies of the browser they are signed in with, no password)",
  ]);
});

test("send slots: each moves the site's next send on by the interval ±30%, kept on disk, any one corrupt file aside", () => {
  const { home } = fresh();
  const now = 1_000_000;
  const at = [reserveSend("a", 1000, now)];
  for (let i = 0; i < 20; i++) at.push(reserveSend("a", 1000, now));
  const gaps = at.slice(1).map((t, i) => t - at[i]!);
  assert.equal(at[0], now, "an idle site sends at once");
  assert.ok(
    gaps.every((g) => g >= 700 && g <= 1300),
    gaps.join(","),
  );
  assert.ok(new Set(gaps).size > 1, "not one fixed period");
  assert.equal(reserveSend("b", 1000, now), now, "another site has its own slot");
  // another process reads the same slot
  assert.equal(JSON.parse(readFileSync(join(home, "pace.json"), "utf8")).a > at.at(-1)!, true);
  writeFileSync(join(home, "pace.json"), "{not json");
  assert.equal(reserveSend("a", 1000, now), now);
});

test("cool-downs: one per site, until it runs out or a login clears it; the wait is capped", () => {
  fresh();
  const now = Date.now();
  coolDown("Demo", { class: "rate", reason: "HTTP 429" }, 60_000, now);
  assert.deepEqual(cooling("demo", now + 1)?.class, "rate");
  assert.equal(cooling("demo", now + 60_001), undefined);
  coolDown("demo", { class: "blocked", reason: "x", status: 451 }, 365 * 24 * 3600_000, now);
  assert.equal(cooling("demo", now)?.until, now + 30 * 60_000);
  assert.equal(cooling("demo", now)?.status, 451);
  clearCoolDown("demo");
  assert.equal(cooling("demo", now), undefined);
});
