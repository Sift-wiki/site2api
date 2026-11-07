import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cookieHeaderFor,
  cookieValue,
  home,
  loadSession,
  loggedIn,
  mergeCapture,
  parseCookieHeader,
  renewedSignIn,
  safeName,
  saveSession,
  signInCookies,
  tryLock,
} from "../src/session.js";
import type { StoredCookie } from "../src/types.js";

const X = "https://x.com/i/api/graphql/ID/UserByScreenName";
const c = (name: string, value: string, domain: string, extra: Partial<StoredCookie> = {}): StoredCookie => ({
  name,
  value,
  domain,
  path: "/",
  expires: -1,
  httpOnly: false,
  secure: false,
  ...extra,
});

test("RFC 6265 domain, path, secure and expiry matching", () => {
  const now = 1_800_000_000_000;
  const jar = [
    c("auth_token", "AAA", ".x.com", { secure: true }),
    c("host_only", "B", "x.com"),
    c("scoped", "C", ".x.com", { path: "/i/api" }),
    c("expired", "D", ".x.com", { expires: now / 1000 - 1 }),
    c("future", "E", ".x.com", { expires: now / 1000 + 60 }),
    c("other", "F", ".example.com"),
  ];
  assert.equal(
    cookieHeaderFor(jar, "https://x.com/i/api/graphql", now),
    "scoped=C; auth_token=AAA; host_only=B; future=E",
  );
  assert.equal(
    cookieHeaderFor(jar, "https://api.x.com/1.1/x.json", now),
    "auth_token=AAA; future=E",
    "host-only cookie not sent to a subdomain",
  );
  assert.equal(
    cookieHeaderFor(jar, "http://x.com/i/apiary", now),
    "host_only=B; future=E",
    "no secure cookie over http, /i/api does not match /i/apiary",
  );
  assert.equal(cookieHeaderFor(jar, "https://notx.com/", now), "");
  assert.equal(cookieHeaderFor([c("s", "1", "localhost", { secure: true })], "http://localhost:8080/"), "s=1");
});

test("cookieValue prefers a cookie that would be sent to the URL", () => {
  const jar = [c("ct0", "wrong", ".other.com"), c("ct0", "right", ".x.com")];
  assert.equal(cookieValue(jar, "ct0", "https://x.com/i/api"), "right");
  assert.equal(cookieValue(jar, "ct0"), "wrong");
  assert.equal(cookieValue(jar, "nope"), undefined);
});

test("parseCookieHeader keeps quotes for transforms", () => {
  assert.deepEqual(parseCookieHeader('li_at=abc; JSESSIONID="ajax:123"; bad'), {
    li_at: "abc",
    JSESSIONID: '"ajax:123"',
  });
});

test("loggedIn heuristic and explicit loginCookies", () => {
  const guest = [
    c("guest_id", "v1%3A17000000", ".x.com"),
    c("gt", "1840000000000000000", ".x.com"),
    c("__cf_bm", "xxxxxxxxxxxx", ".x.com"),
  ];
  assert.equal(loggedIn(guest), false);
  assert.equal(loggedIn([...guest, c("auth_token", "0123456789abcdef", ".x.com")]), true);
  assert.equal(loggedIn([c("sessionid", "1234567890%3Aabc", ".instagram.com")]), true);
  assert.equal(loggedIn([c("li_at", "AQEDAxxxxxxxx", ".linkedin.com")], ["li_at", "JSESSIONID"]), false);
  assert.equal(
    loggedIn([c("auth_token", "0123456789abcdef", ".x.com", { expires: 1 })]),
    false,
    "expired does not count",
  );
});

test("a cookie every signed-out visitor is given is no evidence of a sign-in; a pinned loginCookies still wins", () => {
  // what Laravel, Rails, CodeIgniter and GitHub hand a guest, every name matching the login heuristic
  const visitor = [
    c("laravel_session", "eyJpdiI6IkJ4b2V3", ".shop.test"),
    c("_myapp_session", "c2Vzc2lvbi1kYXRh", ".shop.test"),
    c("ci_session", "a1b2c3d4e5f6a7b8", ".shop.test"),
    c("_gh_sess", "Z3Vlc3Qtc2Vzc2lvbg", ".shop.test"),
    c("logged_in", "no", ".shop.test"),
  ];
  const guest = ["_gh_sess", "_myapp_session", "ci_session", "laravel_session", "logged_in"];
  assert.equal(loggedIn(visitor), true, "the name heuristic alone takes a guest's session for a login");
  assert.equal(loggedIn(visitor, undefined, guest), false);
  assert.deepEqual(signInCookies(visitor, undefined, guest), []);
  const member = [...visitor, c("remember_web_59ba36", "eyJpdiI6Ik1lbWJlcg", ".shop.test")];
  assert.equal(loggedIn(member, undefined, guest), true, "a login cookie no visitor is given counts");
  assert.equal(loggedIn([...visitor, c("logged_in", "yes", "shop.test")], undefined, guest), true, "by value");
  assert.equal(loggedIn(visitor, ["laravel_session"], guest), true, "a pinned name is the site's own word");
  assert.equal(
    loggedIn(
      [c("remember_web_59ba36", "eyJpdiI6Ik1lbWJlcg", ".shop.test", { expires: 1 }), ...visitor],
      undefined,
      guest,
    ),
    false,
    "an expired login cookie is none",
  );
});

test("renewedSignIn names the login cookies that appeared or changed, never a visitor's", () => {
  const guest = ["app_session"];
  const before = [c("app_session", "visitor-000000001", "x.test"), c("auth_token", "dead-token-0000001", "x.test")];
  assert.deepEqual(renewedSignIn(before, before, undefined, guest), [], "the same cookies renew nothing");
  const rotated = [c("app_session", "visitor-000000002", "x.test"), before[1]!];
  assert.deepEqual(renewedSignIn(before, rotated, undefined, guest), [], "a visitor's cookie rotating is not a login");
  assert.deepEqual(
    renewedSignIn(before, [rotated[0]!, c("auth_token", "fresh-token-000001", "x.test")], undefined, guest),
    ["auth_token"],
  );
  assert.deepEqual(renewedSignIn([], [c("auth_token", "fresh-token-000001", "x.test")], undefined, guest), [
    "auth_token",
  ]);
});

test("guest cookie names live in the session file, kept by every merge", () => {
  process.env.API_ANYTHING_HOME = mkdtempSync(join(tmpdir(), "aa-"));
  saveSession("g", { cookies: [], values: {}, guestCookies: ["app_session"] });
  mergeCapture("g", [c("auth_token", "0123456789abcdef", "x.test")]);
  assert.deepEqual(loadSession("g").guestCookies, ["app_session"]);
  assert.equal(loadSession("g").cookies.length, 1);
});

test("session store: API_ANYTHING_HOME override, 0700 dirs, 0600 files, merge by name/domain/path", () => {
  process.env.API_ANYTHING_HOME = mkdtempSync(join(tmpdir(), "aa-"));
  assert.equal(home(), process.env.API_ANYTHING_HOME);
  assert.deepEqual(loadSession("x"), { cookies: [], values: {}, source: undefined, updatedAt: undefined });
  mergeCapture("x", [c("ct0", "one", ".x.com"), c("old", "gone", ".x.com", { expires: 1 })], {
    from: X,
    values: { authorization: "Bearer A" },
  });
  const s = mergeCapture("x", [c("ct0", "two", ".x.com")], { from: X, values: { "x-guest-token": "123" } });
  assert.deepEqual(
    s.cookies.map((k) => k.value),
    ["two"],
  );
  assert.deepEqual(s.values, { authorization: "Bearer A", "x-guest-token": "123" });
  // each value is bound to the host of the request it was captured from
  assert.deepEqual(s.valueHosts, { authorization: "x.com", "x-guest-token": "x.com" });
  assert.equal(s.kinds, undefined);
  // A learn classifies every value it stored. A merge without a classification records nothing new.
  assert.deepEqual(
    mergeCapture("x", [], { from: X, values: { theme: "dark", at: "T" } }, { settings: ["theme"] }).kinds,
    {
      theme: "setting",
      at: "credential",
    },
  );
  assert.deepEqual(mergeCapture("x", [], { from: X, values: { locale: "en-GB" } }).kinds, {
    theme: "setting",
    at: "credential",
  });
  // a name no learn classified yet becomes a setting when one reads it as one...
  assert.deepEqual(mergeCapture("x", [], { from: X, values: { locale: "en-GB" } }, { settings: ["locale"] }).kinds, {
    theme: "setting",
    at: "credential",
    locale: "setting",
  });
  // ...but a credential stays one, however a later learn reads the same name
  assert.deepEqual(
    mergeCapture("x", [], { from: X, values: { at: "T", theme: "dark" } }, { settings: ["at", "theme"] }).kinds,
    {
      theme: "setting",
      at: "credential",
      locale: "setting",
    },
  );
  assert.deepEqual(mergeCapture("x", [], { from: X, values: { theme: "dark" } }, { settings: [] }).kinds, {
    theme: "credential",
    at: "credential",
    locale: "setting",
  });
  // A refresh replaces values without classifying them: a value read back unchanged keeps its kind, and
  // a credential stays one whatever the page now puts there...
  assert.deepEqual(mergeCapture("x", [], { from: X, values: { locale: "en-GB", at: "T2", theme: "x" } }).kinds, {
    theme: "credential",
    at: "credential",
    locale: "setting",
  });
  // ...but a setting whose value changed is unclassified again, so the scan protects the new text
  assert.deepEqual(mergeCapture("x", [], { from: X, values: { locale: "de-DE" } }).kinds, {
    theme: "credential",
    at: "credential",
  });
  assert.deepEqual(
    loadSession("x").cookies.map((k) => k.value),
    ["two"],
  );
  const file = join(home(), "sessions", "x.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(home(), "sessions")).mode & 0o777, 0o700);
  assert.throws(() => loadSession("../etc"), /invalid site name/);
  assert.throws(() => safeName("a/b"));
});

test("cookieValue never hands a cookie to another site, nor a Secure one over http", () => {
  const bank = [c("sid", "SECURE-ONLY-SESSION", ".bank.test", { secure: true, httpOnly: true })];
  assert.equal(cookieValue(bank, "sid", "http://evil.test/"), undefined);
  assert.equal(cookieValue(bank, "sid", "http://www.bank.test/"), undefined, "Secure cookie over http");
  const host = [c("csrftoken", "tok123456", "www.site.test")];
  assert.equal(
    cookieValue(host, "csrftoken", "https://api.site.test/v1"),
    "tok123456",
    "same site: page JS echoes it to its API host",
  );
});

test("an operation's origins count as the site's own for its learn's write only, and for good once it is saved", async () => {
  const { recordOrigins } = await import("../src/session.js");
  process.env.API_ANYTHING_HOME = mkdtempSync(join(tmpdir(), "api-anything-origins-"));
  const page = "https://private-value.test/";
  const urls = ["https://private-value.test/api?q={q}"];
  const host = { from: page, values: { "one/host": "private-value.test" } };
  // the learn's write: the cookie holding its origin does not protect the setting it holds
  mergeCapture("o", [c("lu", encodeURIComponent(page), "private-value.test")], host, { settings: ["one/host"], urls });
  assert.deepEqual(loadSession("o").kinds, { "one/host": "setting" });
  assert.equal(loadSession("o").origins, undefined);
  // that save was refused: a second learn's write rotating the cookie keeps what the file protected
  mergeCapture("o", [c("lu", "rotated", "private-value.test")], host, { settings: ["one/host"], urls });
  assert.deepEqual(loadSession("o").kinds, { "one/host": "credential" });

  // once saved, the origin is the site's own for every write: a cookie import does not promote the setting
  mergeCapture("p", [c("lu", encodeURIComponent(page), "private-value.test")], host, { settings: ["one/host"], urls });
  recordOrigins("p", urls);
  assert.deepEqual(loadSession("p").origins, ["https://private-value.test"]);
  mergeCapture("p", [c("lu", "rotated", "private-value.test")]);
  assert.deepEqual(loadSession("p").kinds, { "one/host": "setting" });
});

test("a lock is taken over only when its writer is gone, not when it is merely old", () => {
  process.env.API_ANYTHING_HOME = mkdtempSync(join(tmpdir(), "api-anything-lock-"));
  const file = join(home(), "lock-test.json");
  const lock = `${file}.lock`;
  let ran = 0;
  const run = () => {
    ran++;
    return "ran";
  };

  // a live writer keeps its lock past the old 10 s cutoff: a save can wait 15 s on the key store
  writeFileSync(lock, String(process.ppid));
  const old = new Date(Date.now() - 15_000);
  utimesSync(lock, old, old);
  assert.equal(tryLock(file, run, 100), undefined, "a live writer's lock is not stolen");
  assert.equal(ran, 0);

  // its writer is gone: the lock is stale and the next caller takes it
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  writeFileSync(lock, String(dead));
  utimesSync(lock, old, old);
  assert.deepEqual(tryLock(file, run, 100), { value: "ran" });

  // a lock still being written (no pid yet) is left alone for two seconds, then taken
  writeFileSync(lock, "");
  assert.equal(tryLock(file, run, 100), undefined, "a lock being written is left alone");
  const stale = new Date(Date.now() - 3_000);
  utimesSync(lock, stale, stale);
  assert.deepEqual(tryLock(file, run, 100), { value: "ran" });
});
