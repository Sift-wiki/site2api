/**
 * Edge-case probes for self-healing (src/heal.ts, src/execute.ts). The first half injects fetch
 * with maxTier 1 (no browser); the second half runs recapture against small local servers in the
 * installed Chrome. Tests that fail assert the correct behaviour and name the bug they expose.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { browserAvailable, closeBrowser } from "../../src/browser.js";
import { call, heal } from "../../src/execute.js";
import { addOperation, rescan } from "../../src/heal.js";
import { loadSession, saveSession } from "../../src/session.js";
import { type Operation, parseSite } from "../../src/spec.js";
import { bundledDir, loadSite, markStale, saveSite, staleMark } from "../../src/store.js";

const HOME = mkdtempSync(join(tmpdir(), "api-anything-edge-heal-"));
process.env.API_ANYTHING_HOME = HOME;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let seen: { url: string; method: string; body?: string }[] = [];
const fake = (h: Handler): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    return h(url, init);
  }) as typeof fetch;
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const html = (s: string, status = 200) => new Response(s, { status, headers: { "content-type": "text/html" } });
const tier1 = (h: Handler) => ({ fetchImpl: fake(h), maxTier: 1 as const, minIntervalMs: 0 });
const heals = (): { site: string; op: string; strategy: string; diff: string }[] => {
  try {
    return readFileSync(join(HOME, "heals.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const setState = (
  patch: (s: {
    stale: Record<string, unknown>;
    tier: Record<string, unknown>;
    healedAt: Record<string, number>;
  }) => void,
) => {
  const file = join(HOME, "state.json");
  const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const full = { stale: s.stale ?? {}, tier: s.tier ?? {}, healedAt: s.healedAt ?? {} };
  patch(full);
  writeFileSync(file, JSON.stringify(full));
};

const OLD = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7H";
const NEW = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3S";
const NEWER = "Qq1Ww2Ee3Rr4Tt5Yy6Uu7I";

/** X-style: queryId in the path, operationName as the next segment. */
const userSite = (name: string, extra: Partial<Operation> = {}) =>
  parseSite({
    name,
    baseUrl: "https://t.test",
    operations: [
      {
        name: "user",
        readOnly: true,
        request: { method: "GET", url: `https://t.test/api/${OLD}/User?name=alice`, headers: {} },
        slots: [{ param: "name", at: ["query:name"] }],
        volatile: [{ at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "User" }],
        trigger: { url: "https://t.test/u/{name}" },
        match: { method: "GET", path: "/api/*/User" },
        params: [{ name: "name", example: "alice" }],
        response: { extract: "user" },
        ...extra,
      },
    ],
  });

/** A site whose bundle names the current id and whose API answers only that id. */
const rotatingHandler =
  (cur: () => string): Handler =>
  (url) => {
    if (url.startsWith("https://t.test/u/")) return html('<html><script src="/static/main.js"></script></html>');
    if (url === "https://t.test/static/main.js")
      return new Response(`var ops=[{queryId:"${cur()}",operationName:"User",operationType:"query"}];`);
    const u = new URL(url);
    if (u.pathname === `/api/${cur()}/User`) return json({ user: { name: u.searchParams.get("name") } });
    if (u.pathname.startsWith("/api/")) return new Response("", { status: 404 });
    return new Response("", { status: 404 });
  };

beforeEach(() => {
  rmSync(join(HOME, "state.json"), { force: true });
  rmSync(join(HOME, "heals.jsonl"), { force: true });
  rmSync(join(HOME, "sessions"), { recursive: true, force: true });
  seen = [];
});

describe("heal without a browser (maxTier 1)", () => {
  test("single rotation heals by rescan; the stored template is sent first", async () => {
    saveSite(userSite("rot1"));
    const r = await call("rot1", "user", { name: "bob" }, tier1(rotatingHandler(() => NEW)));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.healed, true);
    assert.deepEqual(r.data, { name: "bob" });
    assert.ok(seen[0]!.url.includes(`/api/${OLD}/User`), "healing is reactive: the stored template goes first");
    assert.equal(loadSite("rot1")!.site.operations[0]!.request.url.includes(NEW), true);
  });

  test("repeated rotation: a second rotation more than 10 min after the first heal heals again", async () => {
    saveSite(userSite("rot2"));
    let cur = NEW;
    assert.equal((await call("rot2", "user", { name: "bob" }, tier1(rotatingHandler(() => cur)))).healed, true);
    setState((s) => (s.healedAt["rot2/user"] = Date.now() - 11 * 60_000));
    cur = NEWER;
    const r = await call("rot2", "user", { name: "bob" }, tier1(rotatingHandler(() => cur)));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.healed, true);
    assert.deepEqual(
      heals().map((h) => h.strategy),
      ["rescan", "rescan"],
    );
  });

  test("an expired stale mark no longer blocks a heal; a live one does", async () => {
    saveSite(userSite("ttl"));
    setState((s) => (s.stale["ttl/user"] = { until: Date.now() + 60_000, reason: "test" }));
    const blocked = await call("ttl", "user", { name: "bob" }, tier1(rotatingHandler(() => NEW)));
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason ?? "", /stale until/);
    assert.equal(heals().length, 0);
    setState((s) => (s.stale["ttl/user"] = { until: Date.now() - 1, reason: "test" }));
    const r = await call("ttl", "user", { name: "bob" }, tier1(rotatingHandler(() => NEW)));
    assert.equal(r.healed, true, JSON.stringify(r));
    assert.equal(staleMark("ttl", "user"), undefined, "a successful heal clears the mark");
  });

  test("a stale mark written by another process is honoured by this one", async () => {
    saveSite(userSite("xproc"));
    const script = `import { markStale } from ${JSON.stringify(join(ROOT, "src", "store.ts"))}; markStale("xproc", "user", "set by another process");`;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: ROOT,
      env: { ...process.env, API_ANYTHING_HOME: HOME },
    });
    const r = await call("xproc", "user", { name: "bob" }, tier1(rotatingHandler(() => NEW)));
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /set by another process/);
    assert.equal(heals().length, 0);
  });

  test("forced heal ignores a stale mark and clears it on success", async () => {
    saveSite(userSite("force"));
    markStale("force", "user", "old failure");
    const r = await heal("force", "user", { name: "alice" }, tier1(rotatingHandler(() => NEW)));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.strategy, "rescan");
    assert.equal(staleMark("force", "user"), undefined);
  });

  test("path and body queryIds rotate together; both are swapped, the body keeps its encoding", async () => {
    saveSite(
      parseSite({
        name: "both",
        baseUrl: "https://t.test",
        operations: [
          {
            name: "user",
            readOnly: true,
            request: {
              method: "POST",
              url: `https://t.test/api/${OLD}/User`,
              headers: { "content-type": "application/json" },
              body: `{"queryId":"${OLD}","variables":{"name":"alice"}}`,
            },
            slots: [{ param: "name", at: ["body", "json:/variables/name"] }],
            volatile: [
              { at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "User" },
              { at: ["body", "json:/queryId"], shape: { charset: "base64url", length: 22 }, anchor: "User" },
            ],
            trigger: { url: "https://t.test/u/{name}" },
            params: [{ name: "name", example: "alice" }],
            response: { extract: "user" },
          },
        ],
      }),
    );
    const h: Handler = (url, init) => {
      if (url.startsWith("https://t.test/u/")) return html('<script src="/main.js"></script>');
      if (url.endsWith("/main.js")) return new Response(`{queryId:"${NEW}",operationName:"User"}`);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.endsWith(`/api/${NEW}/User`) && body.queryId === NEW)
        return json({ user: { name: body.variables.name } });
      return new Response("", { status: 404 });
    };
    const r = await call("both", "user", { name: "bob" }, tier1(h));
    assert.equal(r.ok, true, JSON.stringify(r));
    const op = loadSite("both")!.site.operations[0]!;
    assert.equal(op.request.body, `{"queryId":"${NEW}","variables":{"name":"alice"}}`);
  });

  test("a numeric doc_id in a JSON body is swapped as a JSON number, not a string", async () => {
    const OLD_DOC = "1111111111111111";
    const NEW_DOC = "9876543210987654";
    saveSite(
      parseSite({
        name: "numdoc",
        baseUrl: "https://t.test",
        operations: [
          {
            name: "q",
            readOnly: true,
            request: {
              method: "POST",
              url: "https://t.test/api/graphql",
              headers: { "content-type": "application/json" },
              body: `{"doc_id":${OLD_DOC},"variables":{"name":"alice"}}`,
            },
            slots: [{ param: "name", at: ["body", "json:/variables/name"] }],
            volatile: [
              { at: ["body", "json:/doc_id"], shape: { charset: "digits", length: 16 }, anchor: "ProfileQuery" },
            ],
            trigger: { url: "https://t.test/u/{name}" },
            params: [{ name: "name", example: "alice" }],
            response: { extract: "user" },
          },
        ],
      }),
    );
    const h: Handler = (url, init) => {
      if (url.startsWith("https://t.test/u/")) return html(`<script>var ProfileQuery={docId:${NEW_DOC}}</script>`);
      const body = String(init?.body ?? "");
      if (body.includes(`"doc_id":${NEW_DOC}`)) return json({ user: { name: JSON.parse(body).variables.name } });
      return json({ errors: [{ message: "PersistedQueryNotFound" }], data: null }, 400);
    };
    const r = await call("numdoc", "q", { name: "bob" }, tier1(h));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(
      loadSite("numdoc")!.site.operations[0]!.request.body,
      `{"doc_id":${NEW_DOC},"variables":{"name":"alice"}}`,
    );
  });

  // Was a bug: nearestToken() matches the anchor as a raw substring, so "Followers" also hits
  // "FollowersYouKnow"; on a distance tie the first occurrence in the bundle wins. The wrong
  // queryId answers 200 with the same shape, so validation passes and wrong data is saved.
  test("anchor that is a prefix of another operation's name: the rescan must take the exact operation's queryId", async () => {
    const RIGHT = "Rr1Ii2Gg3Hh4Tt5Ff6Oo7L";
    const YOU_KNOW = "Yy1Oo2Uu3Kk4Nn5Oo6Ww7Z";
    saveSite(
      parseSite({
        name: "fol",
        baseUrl: "https://t.test",
        operations: [
          {
            name: "followers",
            readOnly: true,
            request: { method: "GET", url: `https://t.test/graphql/${OLD}/Followers?userId=12345678`, headers: {} },
            slots: [{ param: "userId", at: ["query:userId"] }],
            volatile: [{ at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "Followers" }],
            trigger: { url: "https://t.test/u/{userId}/followers" },
            match: { method: "GET", path: "/graphql/*/Followers" },
            params: [{ name: "userId", example: "12345678" }],
            response: {
              extract: "data.user.timeline.users",
              shape: {
                data: "object",
                "data.user": "object",
                "data.user.timeline": "object",
                "data.user.timeline.users": "array",
                "data.user.timeline.users[]": "object",
                "data.user.timeline.users[].name": "string",
              },
            },
          },
        ],
      }),
    );
    const list = (names: string[]) =>
      json({ data: { user: { timeline: { users: names.map((name) => ({ name })) } } } });
    const h: Handler = (url) => {
      if (url.includes("/u/")) return html('<script src="/main.js"></script>');
      if (url.endsWith("/main.js")) {
        return new Response(
          `e.exports={queryId:"${YOU_KNOW}",operationName:"FollowersYouKnow",operationType:"query"};` +
            `e.exports={queryId:"${RIGHT}",operationName:"Followers",operationType:"query"};`,
        );
      }
      if (url.includes(`/graphql/${RIGHT}/`)) return list(["everyone", "who", "follows"]);
      if (url.includes(`/graphql/${YOU_KNOW}/`)) return list(["only-mutuals"]);
      return new Response("", { status: 404 });
    };
    const r = await call("fol", "followers", { userId: "87654321" }, tier1(h));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(
      r.data,
      [{ name: "everyone" }, { name: "who" }, { name: "follows" }],
      `healed onto the wrong operation: ${heals().at(-1)?.diff}`,
    );
  });

  // Was a bug: Meta-style bundles put each doc_id in its own module right after the previous module's
  // doc_id, so the previous operation's id sits ~14 chars before the anchor while the op's own id is
  // ~64 chars after it. The rescan takes the neighbour's id; validation passes on a same-shaped answer.
  test("Meta-style module layout: the rescan must take the doc_id of the anchor's own module, not the previous module's", async () => {
    const OLD_DOC = "1111111111111111";
    const FEED_DOC = "2222222222222222";
    const PROFILE_DOC = "3333333333333333";
    saveSite(
      parseSite({
        name: "meta",
        baseUrl: "https://m.test",
        operations: [
          {
            name: "profile",
            readOnly: true,
            request: {
              method: "POST",
              url: "https://m.test/api/graphql/",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: `doc_id=${OLD_DOC}&fb_api_req_friendly_name=PolarisProfileQuery&variables=${encodeURIComponent('{"username":"alice"}')}`,
            },
            slots: [{ param: "username", at: ["form:variables", "json:/username"] }],
            volatile: [
              { at: ["form:doc_id"], shape: { charset: "digits", length: 16 }, anchor: "PolarisProfileQuery" },
            ],
            trigger: { url: "https://m.test/{username}/" },
            match: { method: "POST", path: "/api/graphql/", operationName: "PolarisProfileQuery" },
            params: [{ name: "username", example: "alice" }],
            response: {
              extract: "data.user",
              shape: {
                data: "object",
                "data.user": "object",
                "data.user.username": "string",
                "data.user.full_name": "string",
              },
            },
          },
        ],
      }),
    );
    const h: Handler = (url, init) => {
      if (!init?.body) {
        if (url.endsWith(".js")) {
          return new Response(
            `__d("PolarisFeedQuery_instagramRelayOperation",[],(function(a,b,c,d,e,f){e.exports="${FEED_DOC}"}),null);` +
              `__d("PolarisProfileQuery_instagramRelayOperation",[],(function(a,b,c,d,e,f){e.exports="${PROFILE_DOC}"}),null);`,
          );
        }
        return html('<script src="/rsrc/bundle.js"></script>');
      }
      const form = new URLSearchParams(String(init.body));
      const username = JSON.parse(form.get("variables")!).username;
      if (form.get("doc_id") === PROFILE_DOC)
        return json({ data: { user: { username, full_name: `${username} (profile)` } } });
      if (form.get("doc_id") === FEED_DOC) return json({ data: { user: { username, feed: [{ id: "p1" }] } } });
      return json({ errors: [{ message: "PersistedQueryNotFound" }], data: null }, 400);
    };
    const r = await call("meta", "profile", { username: "bob" }, tier1(h));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(
      r.data,
      { username: "bob", full_name: "bob (profile)" },
      `healed onto the neighbour's doc_id: ${heals().at(-1)?.diff}`,
    );
  });

  // Was a bug: a write's rescan candidate is validated by performing it. With the anchor
  // matched as a substring, "CreateTweet" resolves to CreateTweetDownvote's queryId, and that other
  // mutation is sent for real.
  test("write heal: a rescan guess must never send a different mutation", async () => {
    const RIGHT = "Cc1Rr2Ee3Aa4Tt5Ee6Tt7W";
    const DOWNVOTE = "Dd1Oo2Ww3Nn4Vv5Oo6Tt7E";
    saveSite(
      parseSite({
        name: "wr",
        baseUrl: "https://w.test",
        operations: [
          {
            name: "createTweet",
            readOnly: false,
            request: {
              method: "POST",
              url: `https://w.test/graphql/${OLD}/CreateTweet`,
              headers: { "content-type": "application/json" },
              body: `{"variables":{"tweet_text":"hello"},"queryId":"${OLD}"}`,
            },
            slots: [{ param: "text", at: ["body", "json:/variables/tweet_text"] }],
            volatile: [
              { at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "CreateTweet" },
              { at: ["body", "json:/queryId"], shape: { charset: "base64url", length: 22 }, anchor: "CreateTweet" },
            ],
            trigger: { url: "https://w.test/compose" },
            match: { method: "POST", path: "/graphql/*/CreateTweet" },
            params: [{ name: "text", example: "hello" }],
          },
        ],
      }),
    );
    const executed: string[] = [];
    const h: Handler = (url, init) => {
      if (url === "https://w.test/compose") return html('<script src="/main.js"></script>');
      if (url.endsWith("/main.js")) {
        return new Response(
          `e.exports={queryId:"${DOWNVOTE}",operationName:"CreateTweetDownvote",operationType:"mutation"};` +
            `e.exports={queryId:"${RIGHT}",operationName:"CreateTweet",operationType:"mutation"};`,
        );
      }
      if (init?.method === "POST" && url.includes(`/graphql/${DOWNVOTE}/`)) {
        executed.push("CreateTweetDownvote");
        return json({ data: { downvoted: true } });
      }
      if (init?.method === "POST" && url.includes(`/graphql/${RIGHT}/`)) {
        executed.push("CreateTweet");
        return json({ data: { create_tweet: { id: "1" } } });
      }
      return new Response("", { status: 404 });
    };
    await call("wr", "createTweet", { text: "hi there" }, { ...tier1(h), allowWrites: true });
    assert.deepEqual(
      executed.filter((x) => x !== "CreateTweet"),
      [],
      "a mutation other than the op's own was performed",
    );
  });

  test("a write is sent at most once by the heal: the one validation after a definite 404", async () => {
    const RIGHT = "Cc1Rr2Ee3Aa4Tt5Ee6Tt7W";
    saveSite(
      parseSite({
        name: "wr1",
        baseUrl: "https://w.test",
        operations: [
          {
            name: "post",
            readOnly: false,
            request: {
              method: "POST",
              url: `https://w.test/graphql/${OLD}/CreatePost`,
              headers: { "content-type": "application/json" },
              body: '{"text":"hello"}',
            },
            slots: [{ param: "text", at: ["body", "json:/text"] }],
            volatile: [{ at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "CreatePost" }],
            trigger: { url: "https://w.test/compose" },
            params: [{ name: "text", example: "hello" }],
          },
        ],
      }),
    );
    const h: Handler = (url, init) => {
      if (url === "https://w.test/compose")
        return html(`<script>x={queryId:"${RIGHT}",operationName:"CreatePost"}</script>`);
      if (init?.method === "POST" && url.includes(RIGHT)) return new Response("", { status: 502 });
      return new Response("", { status: 404 });
    };
    const r = await call("wr1", "post", { text: "hi there" }, { ...tier1(h), allowWrites: true });
    assert.equal(r.ok, false);
    assert.equal(
      seen.filter((s) => s.method === "POST").length,
      2,
      "the stored template (404) and one validation; the ambiguous 502 is not retried",
    );
    assert.match(r.next ?? "", /may have (gone through|run)/);
  });

  // Was a bug: the rescan looks for clues by fetching the trigger page with plain fetch. When the trigger is the
  // write's own address (a GET vote link), that fetch is the write: performed before any validation, uncounted,
  // with none of the browser's interception.
  const voteOp = (base: string, trigger: string) => ({
    name: "vote",
    readOnly: false,
    request: { method: "GET", url: `${base}/vote?id=1&auth=${OLD}`, headers: {} },
    slots: [{ param: "id", at: ["query:id"] }],
    volatile: [{ at: ["query:auth"], shape: { charset: "base64url" as const, length: 22 }, anchor: "auth" }],
    trigger: { url: `${base}${trigger}` },
    match: { method: "GET", path: "/vote" },
    params: [{ name: "id", example: "1" }],
  });

  test("write heal: the rescan does not fetch a page that is the write itself (a GET vote link as its own trigger)", async () => {
    saveSite(
      parseSite({ name: "wget", baseUrl: "https://w.test", operations: [voteOp("https://w.test", "/vote?id={id}")] }),
    );
    const votes: string[] = [];
    const h: Handler = (url) => {
      const u = new URL(url);
      if (u.pathname !== "/vote" || u.searchParams.get("auth") === OLD) return new Response("", { status: 404 });
      votes.push(u.search);
      return html("<p>voted</p>");
    };
    const r = await call("wget", "vote", { id: "7" }, { ...tier1(h), allowWrites: true });
    assert.deepEqual(votes, [], "the heal performed the write while looking for clues");
    assert.equal(r.ok, false);
    assert.deepEqual(
      seen.map((s) => new URL(s.url).search),
      [`?id=7&auth=${OLD}`],
      "only the stored template was sent",
    );
  });

  test("write heal: the rescan does not follow a redirect to the write itself; a read's still follows", async () => {
    let votes = 0;
    const server = createServer((req, res) => {
      const p = new URL(req.url!, "http://x").pathname;
      if (p === "/go") return void res.writeHead(302, { location: "/vote?id=7" }).end();
      if (p !== "/vote") return void res.writeHead(404).end();
      votes++;
      res.writeHead(200, { "content-type": "text/html" }).end(`<script>x={auth:"${NEW}"}</script>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const op = parseSite({ name: "wgo", baseUrl: base, operations: [voteOp(base, "/go?id={id}")] }).operations[0]!;
      assert.equal(await rescan("wgo", op, { id: "7" }), undefined);
      assert.equal(votes, 0, "the heal performed the write by following a redirect to it");
      // the same pages for a read are only pages: fetched, redirect and all
      const read = await rescan("wgo", { ...op, readOnly: true }, { id: "7" });
      assert.equal(read?.diff, `query:auth: ${OLD} -> ${NEW}`);
    } finally {
      server.close();
    }
  });

  test("a read's rescan follows a long chain of redirects, and takes only a redirect status for one", async () => {
    const server = createServer((req, res) => {
      const u = new URL(req.url!, "http://x");
      const n = Number(u.searchParams.get("n") ?? 0);
      const page = `<script>x={queryId:"${NEW}",operationName:"User"}</script>`;
      if (u.pathname === "/u/far" && n < 6) return void res.writeHead(302, { location: `/u/far?n=${n + 1}` }).end();
      // not a redirect, whatever its Location says
      if (u.pathname === "/u/cached") return void res.writeHead(304, { location: "/u/far?n=6" }).end();
      res.writeHead(200, { "content-type": "text/html" }).end(page);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const op = { ...userSite("far6").operations[0]!, trigger: { url: `${base}/u/{name}` } };
      assert.equal((await rescan("far6", op, { name: "far" }))?.diff, `path:1: ${OLD} -> ${NEW}`);
      assert.equal(await rescan("far6", op, { name: "cached" }), undefined);
    } finally {
      server.close();
    }
  });

  // Was a bug: a write whose heal failed is marked stale; the next drift's `next` tells the agent to
  // force `api-anything heal`, which refuses every write.
  test("a stale write's next hint does not point at `api-anything heal` (which refuses writes)", async () => {
    saveSite(
      parseSite({
        name: "wst",
        baseUrl: "https://w.test",
        operations: [
          {
            name: "post",
            readOnly: false,
            request: {
              method: "POST",
              url: `https://w.test/graphql/${OLD}/CreatePost`,
              headers: {},
              body: '{"text":"hello"}',
            },
            slots: [{ param: "text", at: ["body", "json:/text"] }],
            volatile: [{ at: ["path:1"], shape: { charset: "base64url", length: 22 }, anchor: "CreatePost" }],
            trigger: { url: "https://w.test/compose" },
            params: [{ name: "text", example: "hello" }],
          },
        ],
      }),
    );
    markStale("wst", "post", "heal failed earlier");
    const r = await call(
      "wst",
      "post",
      { text: "hi there" },
      { ...tier1(() => new Response("", { status: 404 })), allowWrites: true },
    );
    assert.equal(r.ok, false);
    const forced = await heal("wst", "post", { text: "hi there" });
    assert.equal(forced.class, "refused");
    assert.doesNotMatch(r.next ?? "", /api-anything heal/, `next: ${r.next}`);
  });

  test("logged out: 401, GraphQL auth errors and a login redirect are auth, never healed", async () => {
    saveSite(userSite("auth"));
    for (const res of [
      () => json({ errors: [{ message: "unauthorized" }] }, 401),
      () => json({ errors: [{ message: "Could not authenticate you" }], data: null }),
      () => new Response(null, { status: 302, headers: { location: "https://t.test/login?next=/api" } }),
      () => html('<html><form><input type="password"></form></html>'),
    ]) {
      seen = [];
      const h: Handler = (url) =>
        url.includes("/api/")
          ? res()
          : url.includes("/login")
            ? html('<html><form><input type="password"></form></html>')
            : rotatingHandler(() => NEW)(url);
      const r = await call("auth", "user", { name: "bob" }, tier1(h));
      assert.equal(r.class, "auth", JSON.stringify(r));
      assert.equal(heals().length, 0);
      assert.ok(
        !seen.some((s) => s.url.includes("/u/") || s.url.endsWith(".js")),
        `no rescan when logged out: ${JSON.stringify(seen)}`,
      );
    }
  });

  // Was a bug: DESIGN step 7 records learnedLoggedIn so a changed session state is recognised,
  // but nothing reads it. An op learned logged in, called with a jar that holds no login cookie,
  // gets "no data" (the site hides it from guests), is healed as drift, and is told to heal/re-add,
  // never to log in.
  test("op learned logged in, jar now logged out, data missing: the failure points at login instead of heal/re-add", async () => {
    const site = userSite("lo", {
      learnedLoggedIn: true,
      volatile: [],
      request: { method: "GET", url: "https://t.test/api/Feed?name=alice", headers: {} },
      match: { method: "GET", path: "/api/Feed" },
    });
    saveSite({ ...site, loginCookies: ["sessionid"] });
    saveSession("lo", { cookies: [], values: {} });
    const r = await call(
      "lo",
      "user",
      { name: "bob" },
      tier1((url) => (url.includes("/api/") ? json({ data: {} }) : html("<html></html>"))),
    );
    assert.equal(r.ok, false);
    assert.ok(
      r.class === "auth" || /login/.test(r.next ?? ""),
      `logged-out failure does not mention login: ${JSON.stringify(r)}`,
    );
  });

  test("rate limited on the first try: reported as rate, no heal, one request", async () => {
    saveSite(userSite("rate0"));
    const r = await call(
      "rate0",
      "user",
      { name: "bob" },
      tier1(() => json({ message: "Too many requests" }, 429)),
    );
    assert.equal(r.class, "rate");
    assert.equal(seen.length, 1);
    assert.equal(staleMark("rate0", "user"), undefined);
  });

  // Was a bug: the example-args replay that tells "no such user" from drift can itself be rate
  // limited; that 429 is ignored and the heal runs anyway (fetching the page and up to 40 bundles).
  test("rate limited during the example-args replay: stop and report rate, do not heal", async () => {
    saveSite(userSite("rate1"));
    let n = 0;
    const h: Handler = (url) => {
      if (url.includes("/api/"))
        return n++ === 0 ? json({ nothing: true }) : json({ message: "Too many requests" }, 429);
      return rotatingHandler(() => NEW)(url);
    };
    const r = await call("rate1", "user", { name: "bob" }, tier1(h));
    assert.ok(
      !seen.some((s) => s.url.includes("/u/") || s.url.endsWith(".js")),
      `heal ran while rate limited: ${seen.map((s) => s.url).join(", ")}`,
    );
    assert.equal(r.class, "rate", JSON.stringify(r));
  });

  // Was a bug: when the rescan candidate's replay is rate limited, the failure reason says the rescan
  // "found nothing new", which is false and hides that the candidate was never really checked.
  test("rate limited while validating a rescan candidate: class rate, and the reason does not claim the rescan found nothing", async () => {
    saveSite(userSite("rate2"));
    const h: Handler = (url) => {
      if (url.includes(`/api/${NEW}/`)) return json({ message: "Too many requests" }, 429);
      return rotatingHandler(() => NEW)(url);
    };
    const r = await call("rate2", "user", { name: "bob" }, tier1(h));
    assert.equal(r.class, "rate", JSON.stringify(r));
    assert.doesNotMatch(r.reason ?? "", /found nothing new/);
  });

  test("404 with the param in the path and a volatile in the path: example replay separates not-found from drift", async () => {
    const site = parseSite({
      name: "nd",
      baseUrl: "https://t.test",
      operations: [
        {
          name: "user",
          readOnly: true,
          request: { method: "GET", url: `https://t.test/_next/data/${OLD}/u/alice.json`, headers: {} },
          slots: [{ param: "name", at: ["path:4"], template: "{name}.json" }],
          volatile: [{ at: ["path:2"], shape: { charset: "base64url", length: 22 }, anchor: "buildId" }],
          trigger: { url: "https://t.test/u/{name}" },
          params: [{ name: "name", example: "alice" }],
          response: { extract: "pageProps.user" },
        },
      ],
    });
    saveSite(site);
    let build = OLD;
    const h: Handler = (url) => {
      if (url.startsWith("https://t.test/u/"))
        return html(`<script id="__NEXT_DATA__">{"buildId":"${build}"}</script>`);
      const m = new URL(url).pathname.match(/^\/_next\/data\/([^/]+)\/u\/([^/]+)\.json$/);
      if (m && m[1] === build && ["alice", "bob"].includes(m[2]!)) return json({ pageProps: { user: { name: m[2] } } });
      return new Response("not found", { status: 404 });
    };
    const nf = await call("nd", "user", { name: "nosuchuser" }, tier1(h));
    assert.equal(nf.class, "input", JSON.stringify(nf));
    assert.equal(heals().length, 0);
    build = NEW;
    const r = await call("nd", "user", { name: "bob" }, tier1(h));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.healed, true);
  });

  test("the heal log carries no credential and is 0600; the healed spec is written whole with no temp file left", async () => {
    const SECRET_COOKIE = "s3cr3tAuthTokenValue0123456789";
    const SECRET_CSRF = "csrfValue0123456789abcdef";
    saveSite(
      userSite("sec", {
        request: { method: "GET", url: `https://t.test/api/${OLD}/User?name=alice`, headers: { "x-csrf-token": "" } },
        slots: [
          { param: "name", at: ["query:name"] },
          { ref: "cookie:ct0", at: ["header:x-csrf-token"] },
        ],
      }),
    );
    saveSession("sec", {
      cookies: [
        {
          name: "auth_token",
          value: SECRET_COOKIE,
          domain: ".t.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
        },
        { name: "ct0", value: SECRET_CSRF, domain: ".t.test", path: "/", expires: -1, httpOnly: false, secure: true },
      ],
      values: {},
    });
    const r = await call("sec", "user", { name: "bob" }, tier1(rotatingHandler(() => NEW)));
    assert.equal(r.healed, true, JSON.stringify(r));
    const log = readFileSync(join(HOME, "heals.jsonl"), "utf8");
    const spec = readFileSync(join(HOME, "sites", "sec.json"), "utf8");
    for (const s of [SECRET_COOKIE, SECRET_CSRF]) {
      assert.ok(!log.includes(s), "heal log holds a credential");
      assert.ok(!spec.includes(s), "healed spec holds a credential");
    }
    assert.equal(statSync(join(HOME, "heals.jsonl")).mode & 0o777, 0o600);
    assert.equal(statSync(join(HOME, "sites", "sec.json")).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(join(HOME, "sites")).filter((f) => f.endsWith(".tmp")),
      [],
    );
    assert.doesNotThrow(() => parseSite(JSON.parse(spec)));
  });

  test("heal of a bundled spec writes a user copy that wins afterwards; the bundled file is untouched", async () => {
    const bundled = join(bundledDir(), "x.json");
    const before = createHash("sha256").update(readFileSync(bundled)).digest("hex");
    const op = loadSite("x")!.site.operations.find((o) => o.name === "getUser")!;
    assert.equal(loadSite("x")!.source, "bundled");
    const OLDX = new URL(op.request.url).pathname.split("/")[2]!;
    const NEWX = "Nn1Ee2Ww3Xx4Qq5Uu6Ee7R";
    // a body with every learned key path, so the shape check sees a healthy answer
    const body: Record<string, unknown> = {};
    for (const [path, type] of Object.entries(op.response.shape ?? {})) {
      if (path.includes("[]")) continue;
      const keys = path.split(".");
      let o = body as Record<string, unknown>;
      for (const k of keys.slice(0, -1)) {
        o[k] ??= {};
        o = o[k] as Record<string, unknown>;
      }
      const last = keys.at(-1)!;
      if (o[last] === undefined)
        o[last] =
          type === "object"
            ? {}
            : type === "array"
              ? []
              : type === "number"
                ? 1
                : type === "boolean"
                  ? true
                  : type === "null"
                    ? null
                    : "x";
    }
    const h: Handler = (url) => {
      if (url === "https://x.com/nasa")
        return html('<script src="https://abs.twimg.com/responsive-web/client-web/main.abc.js"></script>');
      if (url.endsWith("main.abc.js"))
        return new Response(`e.exports={queryId:"${NEWX}",operationName:"UserByScreenName",operationType:"query"}`);
      if (url.includes(`/graphql/${NEWX}/UserByScreenName`)) return json(body);
      if (url.includes(`/graphql/${OLDX}/`)) return new Response("", { status: 404 });
      return new Response("", { status: 404 });
    };
    const r = await call("x", "getUser", { screen_name: "nasa" }, tier1(h));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.healed, true);
    const after = loadSite("x")!;
    assert.equal(after.source, "user");
    assert.ok(after.site.operations.find((o) => o.name === "getUser")!.request.url.includes(NEWX));
    assert.equal(
      after.site.operations.length,
      loadSite("x", join(HOME, "no-such-dir"))!.site.operations.length,
      "the user copy keeps every other op",
    );
    assert.equal(createHash("sha256").update(readFileSync(bundled)).digest("hex"), before, "bundled spec modified");
  });

  test("concurrent heals of one op in one process both answer correctly and leave one consistent spec", async () => {
    saveSite(userSite("conc"));
    const h = rotatingHandler(() => NEW);
    const [a, b] = await Promise.all([
      call("conc", "user", { name: "bob" }, tier1(h)),
      call("conc", "user", { name: "carol" }, tier1(h)),
    ]);
    assert.deepEqual([a.ok, b.ok], [true, true], JSON.stringify([a, b]));
    assert.deepEqual([a.data, b.data], [{ name: "bob" }, { name: "carol" }]);
    assert.ok(loadSite("conc")!.site.operations[0]!.request.url.includes(NEW));
    assert.ok(heals().length >= 1);
  });

  // Was a bug: rescan resolves script src against the trigger URL, not the document's final URL, so
  // a redirected page (locale prefix, trailing-slash or app-path redirects) with a relative src loses its bundle.
  test("rescan resolves script paths against the redirected document URL", async () => {
    const server = createServer((req, res) => {
      const p = new URL(req.url!, "http://x").pathname;
      if (p === "/u/bob") return void res.writeHead(302, { location: "/en/app/u/bob" }).end();
      if (p === "/en/app/u/bob")
        return void res
          .writeHead(200, { "content-type": "text/html" })
          .end('<script src="../static/main.js"></script>');
      if (p === "/en/app/static/main.js")
        return void res.writeHead(200).end(`x={queryId:"${NEW}",operationName:"User"}`);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const op = { ...userSite("redir").operations[0]!, trigger: { url: `${base}/u/{name}` } };
      const r = await rescan("redir", op, { name: "bob" });
      assert.equal(r?.diff, `path:1: ${OLD} -> ${NEW}`);
    } finally {
      server.close();
    }
  });

  test("rescan ignores a token that overlaps or is the anchor, and a token farther than ~300 chars", async () => {
    const op = userSite("far").operations[0]!;
    const h: Handler = (url) => {
      if (url.startsWith("https://t.test/u/"))
        return html(`<script>x={queryId:"${NEW}",pad:"${"-".repeat(400)}",operationName:"User"}</script>`);
      return new Response("", { status: 404 });
    };
    assert.equal(await rescan("far", op, { name: "bob" }, fake(h)), undefined);
  });

  // Issue #25: the healed spec is scanned against the site's session, which holds settings a ref keeps
  // fresh as well as credentials. A setting the template spells must not block the heal.
  test("a healed spec is scanned for the session's credentials, not for a setting a ref keeps fresh", async () => {
    const themed = (name: string) =>
      userSite(name, {
        request: { method: "GET", url: `https://t.test/api/${OLD}/User?name=alice&theme=solarized-dark`, headers: {} },
      });
    saveSite(themed("healset"));
    saveSession("healset", {
      cookies: [],
      values: { "user/theme": "solarized-dark" },
      kinds: { "user/theme": "setting" },
    });
    const r = await call("healset", "user", { name: "bob" }, tier1(rotatingHandler(() => NEW)));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.healed, true);
    assert.ok(loadSite("healset")!.site.operations[0]!.request.url.includes(NEW));
    // the same value recorded as no setting is a credential the heal refuses to save
    saveSite(themed("healcred"));
    saveSession("healcred", { cookies: [], values: { "user/theme": "solarized-dark" } });
    const refused = await call("healcred", "user", { name: "bob" }, tier1(rotatingHandler(() => NEW)));
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(refused.reason ?? "", /refusing to save a healed spec containing a credential/);
    assert.ok(loadSite("healcred")!.site.operations[0]!.request.url.includes(OLD), "nothing was saved");
  });
});

/* ------------------------------------------------------------------ browser */

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const sendJson = (res: ServerResponse, v: unknown, status = 200) =>
  void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
const sendHtml = (res: ServerResponse, s: string, status = 200) =>
  void res.writeHead(status, { "content-type": "text/html" }).end(s);
const sendJs = (res: ServerResponse, s: string) =>
  void res.writeHead(200, { "content-type": "application/javascript" }).end(s);
const fast = { minIntervalMs: 0 };

describe("heal with the browser (recapture)", { skip: !browserAvailable() && "no Chromium browser installed" }, () => {
  const servers: Server[] = [];
  after(async () => {
    await closeBrowser();
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
    rmSync(HOME, { recursive: true, force: true });
  });
  const start = async (h: Parameters<typeof serve>[0]) => {
    const s = await serve(h);
    servers.push(s.server);
    return s.base;
  };

  test("queryId only in a lazily loaded chunk: rescan finds nothing, recapture heals", async () => {
    let qid = OLD;
    const base = await start((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (u.pathname.startsWith("/u/"))
        return sendHtml(res, '<html><body><script type="module" src="/main.js"></script></body></html>');
      if (u.pathname === "/main.js")
        return sendJs(res, 'import("/chunk-user.js").then(m=>m.load(location.pathname.split("/")[2]));');
      if (u.pathname === "/chunk-user.js")
        return sendJs(res, `export function load(n){fetch("/api/${qid}/User?name="+encodeURIComponent(n))}`);
      if (u.pathname === `/api/${qid}/User`) return sendJson(res, { user: { name: u.searchParams.get("name") } });
      sendJson(res, {}, 404);
    });
    await addOperation({
      site: "lazy",
      op: "user",
      trigger: { url: `${base}/u/{name}` },
      examples: [{ name: "alice" }, { name: "bobby" }],
      response: { extract: "user" },
    });
    assert.equal(loadSite("lazy")!.site.operations[0]!.volatile.length, 1);
    qid = NEW;
    const r = await call("lazy", "user", { name: "carol" }, fast);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.healed, true);
    assert.deepEqual(
      heals().map((h) => h.strategy),
      ["recapture"],
    );
    const again = await call("lazy", "user", { name: "dave" }, fast);
    assert.equal(again.tier, 1);
    assert.deepEqual(again.data, { name: "dave" });
  });

  test("rotation while the anchor moved away from the id (rescan picks a wrong nearby hash): recapture still heals", async () => {
    let qid = OLD;
    const DECOY = "Dd9Ee8Cc7Oo6Yy5Hh4Aa3S";
    const base = await start((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (u.pathname.startsWith("/u/"))
        return sendHtml(res, '<html><body><script src="/main.js"></script></body></html>');
      if (u.pathname === "/main.js") {
        // after the deploy, the op name sits next to an unrelated chunk hash; the id is far away
        const registry =
          qid === OLD
            ? `{queryId:"${qid}",operationName:"User"}`
            : `{chunk:"${DECOY}",operationName:"User"};${" ".repeat(600)}var ids={a:"${qid}"}`;
        const id = qid === OLD ? JSON.stringify(qid) : "ids.a";
        // the path is assembled so the op name never sits next to the id in the source
        return sendJs(
          res,
          `var reg=${registry};fetch("/api/"+${id}+"/"+reg.operationName+"?name="+encodeURIComponent(location.pathname.split("/")[2]));`,
        );
      }
      if (u.pathname === `/api/${qid}/User`) return sendJson(res, { user: { name: u.searchParams.get("name") } });
      sendJson(res, {}, 404);
    });
    await addOperation({
      site: "moved",
      op: "user",
      trigger: { url: `${base}/u/{name}` },
      examples: [{ name: "alice" }, { name: "bobby" }],
      response: { extract: "user" },
    });
    qid = NEW;
    const r = await call("moved", "user", { name: "carol" }, fast);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.healed, true);
    assert.deepEqual(
      heals().map((h) => h.strategy),
      ["recapture"],
    );
    assert.ok(!loadSite("moved")!.site.operations[0]!.request.url.includes(DECOY));
  });

  // Was a bug: recapture learns the new template's session refs but throws away their values
  // (learnOperation's sessionValues); runOpTrigger only stores values for the OLD op's refs. A
  // deploy that adds or renames an auth/anti-bot header (x-*-token, x-csrf-*) can then never heal:
  // the validation replay drops the header because the session store has no value for it.
  test("recapture of a template that gained a session header stores that header's value, so validation can send it", async () => {
    let version = 1;
    const TOKEN = "pageToken-5f2a9c1e7b3d";
    const base = await start((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (u.pathname.startsWith("/u/")) {
        const js =
          version === 1
            ? `fetch("/api/User?name="+encodeURIComponent(location.pathname.split("/")[2]))`
            : `fetch("/api/User?name="+encodeURIComponent(location.pathname.split("/")[2]),{headers:{"x-api-token":"${TOKEN}"}})`;
        return sendHtml(res, `<html><body><script>${js}</script></body></html>`);
      }
      if (u.pathname === "/api/User") {
        if (version === 2 && req.headers["x-api-token"] !== TOKEN)
          return sendJson(res, { error: "unknown operation" }, 404);
        return sendJson(res, { user: { name: u.searchParams.get("name") } });
      }
      sendJson(res, {}, 404);
    });
    await addOperation({
      site: "hdr",
      op: "user",
      trigger: { url: `${base}/u/{name}` },
      examples: [{ name: "alice" }, { name: "bobby" }],
      response: { extract: "user" },
    });
    version = 2;
    const r = await call("hdr", "user", { name: "carol" }, fast);
    assert.equal(r.ok, true, JSON.stringify(r));
    const op = loadSite("hdr")!.site.operations[0]!;
    assert.equal(
      r.healed,
      true,
      `${JSON.stringify(r)}\nslots now: ${JSON.stringify(op.slots)}\nsession values: ${JSON.stringify(loadSession("hdr").values)}`,
    );
    const later = await call("hdr", "user", { name: "dave" }, fast);
    assert.equal(later.tier, 1, JSON.stringify(later));
    assert.deepEqual(later.data, { name: "dave" });
  });

  // Was a bug: a renamed response field (user -> account) is response drift, not bad args: the
  // example args fail too. The recapture learns the same request, so the heal says "identical" and
  // call() reports class "input" with "check the args", and nothing tells the agent to fix --extract.
  test("response field renamed: reported as drift with a re-add hint, not as input", async () => {
    let renamed = false;
    const base = await start((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (u.pathname.startsWith("/u/"))
        return sendHtml(
          res,
          '<html><body><script>fetch("/api/User?name="+encodeURIComponent(location.pathname.split("/")[2]))</script></body></html>',
        );
      if (u.pathname === "/api/User") {
        const who = { name: u.searchParams.get("name"), followers: 3 };
        return sendJson(res, renamed ? { account: who } : { user: who });
      }
      sendJson(res, {}, 404);
    });
    await addOperation({
      site: "ren",
      op: "user",
      trigger: { url: `${base}/u/{name}` },
      examples: [{ name: "alice" }, { name: "bobby" }],
      response: { extract: "user" },
    });
    renamed = true;
    const r = await call("ren", "user", { name: "carol" }, fast);
    assert.equal(r.ok, false);
    assert.notEqual(r.class, "input", `field rename reported as bad args: ${JSON.stringify(r)}`);
    assert.match(r.next ?? "", /add/);
  });

  test("the trigger page now 404s and fires nothing: heal fails, op is stale, next call runs no browser", async () => {
    let gone = false;
    let pageLoads = 0;
    const base = await start((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (u.pathname.startsWith("/u/")) {
        if (req.headers["sec-fetch-dest"] === "document") pageLoads++;
        if (gone) return sendHtml(res, "<html><body>Not found</body></html>", 404);
        return sendHtml(
          res,
          `<html><body><script>fetch("/api/${OLD}/User?name="+encodeURIComponent(location.pathname.split("/")[2]))</script></body></html>`,
        );
      }
      if (!gone && u.pathname === `/api/${OLD}/User`)
        return sendJson(res, { user: { name: u.searchParams.get("name") } });
      sendJson(res, {}, 404);
    });
    await addOperation({
      site: "p404",
      op: "user",
      trigger: { url: `${base}/u/{name}` },
      examples: [{ name: "alice" }, { name: "bobby" }],
      response: { extract: "user" },
    });
    gone = true;
    const r = await call("p404", "user", { name: "carol" }, fast);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /heal failed/);
    assert.ok(staleMark("p404", "user"));
    const loads = pageLoads;
    const again = await call("p404", "user", { name: "dave" }, fast);
    assert.equal(again.ok, false);
    assert.match(again.reason ?? "", /stale/);
    assert.equal(pageLoads, loads);
  });

  test("write drift heals by recapture without the write leaving the browser; exactly one send executes", async () => {
    let qid = OLD;
    const executed: string[] = [];
    const base = await start((req, res, body) => {
      const u = new URL(req.url!, "http://x");
      if (u.pathname === "/compose") {
        return sendHtml(
          res,
          `<html><body><input id="t"><button id="go">Post</button><script>document.getElementById("go").onclick=()=>fetch("/api/${qid}/CreatePost",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:document.getElementById("t").value})})</script></body></html>`,
        );
      }
      if (req.method === "POST" && u.pathname === `/api/${qid}/CreatePost`) {
        executed.push(JSON.parse(body).text);
        return sendJson(res, { ok: 1 });
      }
      sendJson(res, {}, 404);
    });
    const steps = [
      { action: "fill" as const, selector: "#t", value: "{text}" },
      { action: "click" as const, selector: "#go" },
    ];
    await addOperation({
      site: "wb",
      op: "post",
      trigger: { url: `${base}/compose`, steps },
      examples: [{ text: "first post" }],
      write: true,
    });
    assert.deepEqual(executed, [], "learning a write must not send it");
    qid = NEW;
    const r = await call("wb", "post", { text: "second post" }, { ...fast, allowWrites: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.healed, true);
    assert.deepEqual(executed, ["second post"], "only the validation send executed");
  });

  // Was a bug: a rate-limited validation doesn't stop the heal: a read spends its second try on a
  // browser recapture against the rate-limiting site, then the op is marked stale for 30 minutes.
  test("rate limited while validating the rescan candidate: no browser recapture and no stale mark", async () => {
    let qid = OLD;
    let pageLoads = 0;
    const base = await start((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (u.pathname.startsWith("/u/")) {
        if (req.headers["sec-fetch-dest"] === "document") pageLoads++; // browser loads only, not the rescan's fetch
        return sendHtml(
          res,
          `<html><body><script>var r={queryId:"${qid}",operationName:"User"};fetch("/api/${qid}/User?name="+encodeURIComponent(location.pathname.split("/")[2]))</script></body></html>`,
        );
      }
      if (u.pathname === `/api/${qid}/User`) {
        if (qid === NEW) return sendJson(res, { message: "Too many requests" }, 429);
        return sendJson(res, { user: { name: u.searchParams.get("name") } });
      }
      sendJson(res, {}, 404);
    });
    await addOperation({
      site: "rateb",
      op: "user",
      trigger: { url: `${base}/u/{name}` },
      examples: [{ name: "alice" }, { name: "bobby" }],
      response: { extract: "user" },
    });
    qid = NEW;
    const loads = pageLoads;
    const r = await call("rateb", "user", { name: "carol" }, fast);
    assert.equal(r.class, "rate", JSON.stringify(r));
    assert.equal(
      pageLoads - loads,
      0,
      `a browser run was spent on a rate-limited site; stale mark: ${JSON.stringify(staleMark("rateb", "user"))}`,
    );
    assert.equal(staleMark("rateb", "user"), undefined, "rate limiting marked the op stale for 30 min");
  });
  // Was a bug: Chrome locks a profile to one process. While another api-anything process (the
  // MCP server keeps its context open until stdin closes) holds ~/.api-anything/profile, a heal's
  // recapture in this process cannot launch: the call fails and the op is marked stale for 30 min
  // with tier 3 disabled, though nothing about the site is wrong.
  test("a heal in a second process while this process holds the browser profile still heals", async () => {
    let version = 1;
    const base = await start((req, res) => {
      const u = new URL(req.url!, "http://x");
      const key = version === 1 ? "q" : "term";
      if (u.pathname === "/s")
        return sendHtml(
          res,
          `<html><body><script>fetch("/api/search?${key}="+encodeURIComponent(new URLSearchParams(location.search).get("q")))</script></body></html>`,
        );
      if (u.pathname === "/api/search") {
        if (!u.searchParams.has(key)) return sendJson(res, { error: "unknown argument" }, 404);
        return sendJson(res, { results: [{ q: u.searchParams.get(key) }, { q: "x" }] });
      }
      sendJson(res, {}, 404);
    });
    // this process opens the shared profile, as a running MCP server does
    await addOperation({
      site: "xp",
      op: "search",
      trigger: { url: `${base}/s?q={q}` },
      examples: [{ q: "hello" }, { q: "world" }],
      response: { extract: "results" },
    });
    version = 2;
    const script = `import { call } from ${JSON.stringify(join(ROOT, "src", "execute.ts"))}; import { closeBrowser } from ${JSON.stringify(join(ROOT, "src", "browser.ts"))};
const r = await call("xp", "search", { q: "cats" }, { minIntervalMs: 0 }); await closeBrowser(); console.log(JSON.stringify(r));`;
    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { cwd: ROOT, env: { ...process.env, API_ANYTHING_HOME: HOME }, timeout: 120_000 },
        (err, stdout, stderr) => (err && !stdout ? reject(new Error(stderr)) : resolve(stdout)),
      ),
    );
    const r = JSON.parse(out.trim().split("\n").at(-1)!);
    assert.equal(r.ok, true, `${JSON.stringify(r)}\nstale mark: ${JSON.stringify(staleMark("xp", "search"))}`);
    assert.equal(staleMark("xp", "search"), undefined, `op marked stale: ${JSON.stringify(staleMark("xp", "search"))}`);
  });
  // Was a bug: recapture learns from the call's own args whenever they are 3+ chars and distinct.
  // An arg that equals a constant part of the request (q="search" vs the path /api/search) becomes a
  // slot there too; the replay with the same args passes, so the template is saved and every later
  // call with other args sends its query into the URL path.
  test("recapture with a call arg that collides with a constant (q=search in /api/search) does not template the constant", async () => {
    let version = 1;
    const base = await start((req, res) => {
      const u = new URL(req.url!, "http://x");
      const key = version === 1 ? "q" : "term";
      if (u.pathname === "/s")
        return sendHtml(
          res,
          `<html><body><script>fetch("/api/search?${key}="+encodeURIComponent(new URLSearchParams(location.search).get("q")))</script></body></html>`,
        );
      if (u.pathname === "/api/search" && u.searchParams.has(key))
        return sendJson(res, { results: [{ q: u.searchParams.get(key) }, { q: "x" }] });
      sendJson(res, { error: "not found" }, 404);
    });
    await addOperation({
      site: "coll",
      op: "search",
      trigger: { url: `${base}/s?q={q}` },
      examples: [{ q: "hello" }, { q: "world" }],
      response: { extract: "results" },
    });
    version = 2;
    const healed = await call("coll", "search", { q: "search" }, fast);
    assert.equal(healed.ok, true, JSON.stringify(healed));
    const later = await call("coll", "search", { q: "cats" }, fast);
    const slots = JSON.stringify(loadSite("coll")!.site.operations[0]!.slots);
    assert.equal(later.ok, true, `${JSON.stringify(later)}\nslots after the heal: ${slots}`);
    assert.equal(later.tier, 1, `slots after the heal: ${JSON.stringify(loadSite("coll")!.site.operations[0]!.slots)}`);
    assert.deepEqual((later.data as unknown[])[0], { q: "cats" });
  });
  // Was a bug: the example-args replay only runs for "missing" drift. A REST API that answers 404
  // for an unknown entity named in the query (/api/user?name=nosuch) is drift, so the heal runs a
  // browser recapture; the site renders its own 404 page without firing the API, so the heal
  // "fails" and the op is marked stale for 30 min (tier 3 off) because a user does not exist.
  test("404 for an unknown entity in a query param: input via the example replay, no browser run, no stale mark", async () => {
    let pageLoads = 0;
    const known = new Set(["alice", "bobby", "carol"]);
    const base = await start((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (u.pathname.startsWith("/u/")) {
        if (req.headers["sec-fetch-dest"] === "document") pageLoads++;
        const name = decodeURIComponent(u.pathname.slice(3));
        if (!known.has(name)) return sendHtml(res, "<html><body>This account does not exist</body></html>", 404);
        return sendHtml(res, `<html><body><script>fetch("/api/user?name=${name}")</script></body></html>`);
      }
      if (u.pathname === "/api/user") {
        const name = u.searchParams.get("name")!;
        return known.has(name) ? sendJson(res, { user: { name } }) : sendJson(res, { error: "user not found" }, 404);
      }
      sendJson(res, {}, 404);
    });
    await addOperation({
      site: "nf404",
      op: "user",
      trigger: { url: `${base}/u/{name}` },
      examples: [{ name: "alice" }, { name: "bobby" }],
      response: { extract: "user" },
    });
    const loads = pageLoads;
    const r = await call("nf404", "user", { name: "nosuchuser" }, fast);
    assert.equal(r.ok, false);
    assert.equal(r.class, "input", JSON.stringify(r));
    assert.equal(
      staleMark("nf404", "user"),
      undefined,
      `an unknown user marked the op stale: ${JSON.stringify(staleMark("nf404", "user"))}`,
    );
    assert.equal(pageLoads - loads, 0, "a browser run was spent on a not-found lookup");
  });
});
