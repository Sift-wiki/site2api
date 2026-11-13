/**
 * The read deadline: synchronous work stopped from outside, and what call() answers when reading an
 * answer, or testing its args against the op's patterns, runs past it. An injected fetch, no browser.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { verifySite } from "../src/checks.js";
import { judge } from "../src/classify.js";
import { cleanCall } from "../src/clean.js";
import { DEADLINE, DeadlineExceeded, within } from "../src/deadline.js";
import { call } from "../src/execute.js";
import { parsePage } from "../src/extract.js";
import { judgeExchange } from "../src/heal.js";
import { planCall } from "../src/host.js";
import { resolver } from "../src/http.js";
import { parseSite } from "../src/spec.js";
import { saveSite } from "../src/store.js";

const realLookup = resolver.lookup;
const browserWas = process.env.API_ANYTHING_BROWSER;
const limits = { ...DEADLINE };
beforeEach(() => {
  process.env.API_ANYTHING_HOME = mkdtempSync(join(tmpdir(), "aa-deadline-"));
  process.env.API_ANYTHING_BROWSER = "/nonexistent/chromium";
  // no DNS query leaves the machine
  resolver.lookup = async () => [{ address: "93.184.215.14" }];
  Object.assign(DEADLINE, limits);
  seen.length = 0;
});
after(() => {
  resolver.lookup = realLookup;
  Object.assign(DEADLINE, limits);
  if (browserWas === undefined) delete process.env.API_ANYTHING_BROWSER;
  else process.env.API_ANYTHING_BROWSER = browserWas;
});

const seen: string[] = [];
const opts = (answer: (url: string) => Response) => ({
  fetchImpl: (async (input: string | URL | Request) => {
    seen.push(String(input));
    return answer(String(input));
  }) as typeof fetch,
  minIntervalMs: 0,
});
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });

/** What `fn` threw, and how long it held the thread. */
const stopped = (fn: () => unknown): [unknown, number] => {
  const t0 = performance.now();
  try {
    fn();
  } catch (e) {
    return [e, performance.now() - t0];
  }
  return [undefined, performance.now() - t0];
};

// seven general-sibling steps whose first compound matches nothing: every chain of seven earlier rows is tried
const SLOW_ITEMS = `nomatch${" ~ tr".repeat(7)}`;
const rows = (n: number) =>
  `<html><body><table><tbody>${"<tr><td>r</td></tr>".repeat(n)}</tbody></table></body></html>`;
// exponential in the run of a's: about 3 s for 29 of them, twice that for each one more
const SLOW_PATTERN = "((a+))+";
const slowText = (n: number) => `${"a".repeat(n)}!`;

const site = (ops: Record<string, unknown>[]) =>
  parseSite({
    name: "slow",
    baseUrl: "https://t.test",
    operations: ops.map((o) => ({
      readOnly: true,
      request: { method: "GET", url: "https://t.test/list?q=alice", headers: {} },
      slots: [{ param: "q", at: ["query:q"] }],
      params: [{ name: "q", example: "alice" }],
      trigger: { url: "https://t.test/list?q={q}" },
      match: { host: "t.test", path: "/list" },
      response: { format: "html", html: { items: "tr", fields: { cell: "td" } } },
      ...o,
    })),
  });
const slowRead = { name: "slow", response: { format: "html", html: { items: SLOW_ITEMS, fields: { cell: "td" } } } };

test("a backtracking regex, a slow selector and a loop are stopped at the limit, and a timer set before then fires", async () => {
  const slow = site([slowRead]).operations[0]!;
  const work: [string, () => unknown][] = [
    ["a regex", () => new RegExp(`^(?:${SLOW_PATTERN})$`).test(slowText(40))],
    ["a selector", () => judge(slow, { status: 200, headers: { "content-type": "text/html" }, body: rows(60) })],
    [
      "a loop",
      () => {
        for (;;);
      },
    ],
  ];
  let fired = false;
  setTimeout(() => {
    fired = true;
  }, 0);
  for (const [what, fn] of work) {
    const [e, ms] = stopped(() => within(fn, 100));
    assert.ok(e instanceof DeadlineExceeded, `${what}: ${e}`);
    assert.match((e as Error).message, /took over 100 ms and was stopped/);
    assert.ok(ms >= 90 && ms < 2000, `${what}: ${Math.round(ms)} ms`);
  }
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fired, true);
});

test("what the work returns or throws passes through, and one limit may sit inside another", () => {
  const value = { rows: [1, 2] };
  assert.equal(
    within(() => value, 100),
    value,
  );
  const mine = new TypeError("mine");
  assert.equal(
    stopped(() =>
      within(() => {
        throw mine;
      }, 100),
    )[0],
    mine,
  );
  const spin = () => {
    for (;;);
  };
  // the inner limit ends its own work and the outer goes on
  assert.equal(
    within(() => (stopped(() => within(spin, 50))[0] instanceof DeadlineExceeded ? "inner" : "none"), 2000),
    "inner",
  );
  // the outer limit ends the inner work too, and says its own limit
  const [outer, ms] = stopped(() => within(() => within(spin, 5000), 50));
  assert.match(String((outer as Error).message), /took over 50 ms/);
  assert.ok(ms < 2000, `${Math.round(ms)} ms`);
  assert.equal(
    within(() => 7, 100),
    7,
  );
});

test("after a stop the same code answers as before: a page parsed next keeps its first element's id and classes", () => {
  const read = site([{ name: "rows" }]).operations[0]!;
  const slow = site([slowRead]).operations[0]!;
  const answer = (body: string) => ({ status: 200, headers: { "content-type": "text/html" }, body });
  assert.ok(stopped(() => within(() => judge(slow, answer(rows(60))), 50))[0] instanceof DeadlineExceeded);
  assert.deepEqual(judge(read, answer(rows(2))).data, [{ cell: "r" }, { cell: "r" }]);
  // A parse stopped while it reads a tag's attributes leaves the parser's shared pattern part way through
  // that tag. Stops are tried across the parse's own time, so some land there.
  const attributes = `<div ${'id="x" '.repeat(200_000)}>`;
  const t0 = performance.now();
  parsePage(attributes);
  const whole = performance.now() - t0;
  for (let i = 1; i <= 24; i++) {
    stopped(() => within(() => parsePage(attributes), Math.max(1, Math.round((whole * i) / 24))));
    const first = parsePage('<p id="a" class="k">x</p>').querySelector("p");
    assert.deepEqual([first?.id, first?.classList.contains("k")], ["a", true], `stop ${i}`);
  }
});

test("an answer that takes too long to read is error, asked once, with no heal and nothing to retry", async () => {
  saveSite(site([slowRead, { name: "rows" }]));
  DEADLINE.read = 200;
  // about 6 s to read without a limit, and a drift after it: a heal would fetch the trigger's page
  const t0 = performance.now();
  const r = await call(
    "slow",
    "slow",
    { q: "bob" },
    opts(() => html(rows(40))),
  );
  const ms = performance.now() - t0;
  assert.deepEqual([r.ok, r.class], [false, "error"], JSON.stringify(r).slice(0, 400));
  assert.match(r.reason ?? "", /the answer was not read: it took over 200 ms and was stopped/);
  assert.match(r.next ?? "", /^do not retry: reading the site's answer takes longer than api-anything allows/);
  assert.equal(r.nextCall?.action, "report");
  assert.equal(seen.length, 1, "the same answer comes back: asked once, and no heal reads the page");
  assert.ok(ms < 3000, `${Math.round(ms)} ms`);
  // the next call is read as any other
  const next = await call(
    "slow",
    "rows",
    { q: "bob" },
    opts(() => html(rows(3))),
  );
  assert.deepEqual([next.ok, next.data], [true, [{ cell: "r" }, { cell: "r" }, { cell: "r" }]], JSON.stringify(next));
});

test("a write whose answer takes too long to read may have run: check the site, never send it again", async () => {
  saveSite(
    site([
      {
        ...slowRead,
        name: "post",
        readOnly: false,
        request: { method: "POST", url: "https://t.test/list?q=alice", headers: {} },
      },
    ]),
  );
  DEADLINE.read = 200;
  const r = await call("slow", "post", { q: "bob" }, { ...opts(() => html(rows(40))), allowWrites: true });
  assert.deepEqual([r.ok, r.class], [false, "error"], JSON.stringify(r).slice(0, 400));
  assert.match(r.next ?? "", /^the write may have run: check the site first\. Do not retry: reading the site's answer/);
  assert.equal(r.nextCall?.action, "check_site");
  assert.equal(seen.length, 1);
});

test("args that take the op's pattern too long to test are refused before anything is sent", async () => {
  saveSite(site([{ name: "rows", params: [{ name: "q", example: "alice", pattern: `${SLOW_PATTERN}|bob` }] }]));
  DEADLINE.args = 100;
  const t0 = performance.now();
  const r = await call(
    "slow",
    "rows",
    { q: slowText(29) },
    opts(() => html(rows(3))),
  );
  const ms = performance.now() - t0;
  assert.deepEqual([r.ok, r.class], [false, "error"], JSON.stringify(r).slice(0, 400));
  assert.match(r.reason ?? "", /the args were not tested against rows's patterns: it took over 100 ms and was stopped/);
  assert.match(r.next ?? "", /^do not retry: /);
  assert.equal(r.nextCall?.action, "report");
  assert.equal(seen.length, 0, "nothing was sent");
  assert.ok(ms < 1500, `${Math.round(ms)} ms`);
  const ok = await call(
    "slow",
    "rows",
    { q: "bob" },
    opts(() => html(rows(1))),
  );
  assert.deepEqual([ok.ok, ok.data], [true, [{ cell: "r" }]], JSON.stringify(ok));
});

test("the example args a refused call is checked against are held to the same limit", async () => {
  // a bare 403 replays the example args once: the spec's own text against the spec's own pattern
  saveSite(site([{ name: "rows", params: [{ name: "q", example: slowText(29), pattern: `${SLOW_PATTERN}|bob` }] }]));
  DEADLINE.args = 100;
  const t0 = performance.now();
  const r = await call("slow", "rows", { q: "bob" }, { ...opts(() => html("no", 403)), maxTier: 1 as const });
  const ms = performance.now() - t0;
  assert.equal(r.class, "blocked", JSON.stringify(r).slice(0, 400));
  assert.equal(seen.length, 1, "the example args were not sent");
  assert.ok(ms < 1500, `${Math.round(ms)} ms`);
});

test("the cookie-less replay that checks a stranger's candidate in the background reads its answer under the limit", async () => {
  DEADLINE.read = 200;
  const op = site([slowRead]).operations[0]!;
  const t0 = performance.now();
  const r = await cleanCall(op, { q: "bob" }, { site: "slow", ...opts(() => html(rows(40))) });
  const ms = performance.now() - t0;
  assert.equal(r.class, "error", JSON.stringify(r));
  assert.match(r.reason, /the answer was not read: it took over 200 ms and was stopped/);
  assert.ok(ms < 3000, `${Math.round(ms)} ms`);
});

test("a tier-3 answer is read under the limit, and a stop is never a drift", () => {
  DEADLINE.read = 200;
  const op = site([slowRead]).operations[0]!;
  const exchange: Parameters<typeof judgeExchange>[1] = {
    id: 1,
    resourceType: "fetch",
    request: { method: "GET", url: "https://t.test/list?q=bob", headers: {} },
    response: { status: 200, headers: { "content-type": "text/html" }, contentType: "text/html", body: rows(40) },
  };
  const [e, ms] = stopped(() => judgeExchange(op, exchange));
  assert.ok(e instanceof DeadlineExceeded, String(e));
  assert.ok(ms < 3000, `${Math.round(ms)} ms`);
});

test("a host's plan and verify's preflight test the args against the op's patterns under the limit", async () => {
  saveSite(site([{ name: "rows", params: [{ name: "q", example: "alice", pattern: `${SLOW_PATTERN}|bob|alice` }] }]));
  DEADLINE.args = 100;
  let t0 = performance.now();
  const plan = planCall("slow", "rows", { q: slowText(29) });
  assert.ok(performance.now() - t0 < 1500, `${Math.round(performance.now() - t0)} ms`);
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.result.class, "error", JSON.stringify(plan.result));
  assert.match(plan.result.reason ?? "", /the args were not tested against rows's patterns: it took over 100 ms/);
  assert.equal(seen.length, 0);
  // a write's preflight builds its request from the example args: the spec's own text against its own pattern
  saveSite(
    site([
      {
        name: "post",
        readOnly: false,
        request: { method: "POST", url: "https://t.test/list?q=alice", headers: {} },
        params: [{ name: "q", example: slowText(29), pattern: `${SLOW_PATTERN}|bob` }],
      },
    ]),
  );
  t0 = performance.now();
  const v = await verifySite("slow");
  assert.ok(performance.now() - t0 < 1500, `${Math.round(performance.now() - t0)} ms`);
  const pre = v.results.find((r) => r.op === "post");
  assert.ok(pre && "preflight" in pre, JSON.stringify(v));
  assert.equal(pre.preflight.builds, false);
  assert.match(
    pre.preflight.reason ?? "",
    /the example args were not tested against the patterns: it took over 100 ms/,
  );
  assert.equal(seen.length, 0);
});
