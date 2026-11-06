/**
 * Cookie import from a synthetic encrypted Chromium DB, a Firefox DB, and file exports. No real
 * browser, no Keychain: API_ANYTHING_BROWSER_ROOTS injects roots and the Safe Storage password.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AmbiguousProfile, type BrowserRoot, cookiesFromFile, importFromBrowsers } from "../src/import.js";
import {
  guestCookieNames,
  ImportRefused,
  importAllowed,
  importSession,
  importWarning,
  knownGuests,
  reimportIfBrowser,
} from "../src/login.js";
import { loadSession, saveSession } from "../src/session.js";
import { makeChromiumDb, makeFirefoxDb } from "./fixture/cookie-db.js";
import { startFixture } from "./fixture/server.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "aa-import-"));
/** The person at the terminal says yes to a first import. */
const yes = async () => true;
const inject = (roots: BrowserRoot[]) => (process.env.API_ANYTHING_BROWSER_ROOTS = JSON.stringify(roots));
const li = { host_key: ".linkedin.com", name: "li_at", value: "AQEDreallylongtokenvalue" };
const js = { host_key: ".linkedin.com", name: "JSESSIONID", value: '"ajax:1234567890"' };

test("decrypts a v10 Chromium cookie (meta version >= 24 strips the host_key hash)", () => {
  const root = tmp();
  makeChromiumDb(join(root, "Default"), [li, js], { password: "s3cret-keychain-pw", metaVersion: 24 });
  inject([{ name: "Chrome", family: "chromium", root, password: "s3cret-keychain-pw" }]);

  const r = importFromBrowsers({ url: "https://www.linkedin.com", loginCookies: ["li_at", "JSESSIONID"] });
  assert.ok(r);
  assert.equal(r.source, "chrome:Default");
  const byName = Object.fromEntries(r.cookies.map((c) => [c.name, c.value]));
  assert.equal(byName.li_at, "AQEDreallylongtokenvalue");
  assert.equal(byName.JSESSIONID, '"ajax:1234567890"', "quotes preserved for the csrf transform");
});

test("a real-world expires_utc (beyond JS safe-integer range) is read without throwing", () => {
  const root = tmp();
  makeChromiumDb(
    join(root, "Default"),
    [{ host_key: ".linkedin.com", name: "li_at", value: "AQEDtoken12345678", expires_utc: 13399829086694638n }],
    { password: "pw" },
  );
  inject([{ name: "Chrome", family: "chromium", root, password: "pw" }]);
  const r = importFromBrowsers({ url: "https://linkedin.com" });
  const c = r?.cookies.find((x) => x.name === "li_at");
  assert.equal(c?.value, "AQEDtoken12345678");
  assert.ok(
    c && c.expires > 1_700_000_000 && Number.isFinite(c.expires),
    `expires should be a sane unix time, got ${c?.expires}`,
  );
});

test("meta version < 24 does not strip a prefix", () => {
  const root = tmp();
  makeChromiumDb(join(root, "Default"), [{ host_key: ".x.com", name: "auth_token", value: "0123456789abcdef" }], {
    password: "pw",
    metaVersion: 18,
  });
  inject([{ name: "Chrome", family: "chromium", root, password: "pw" }]);
  const r = importFromBrowsers({ url: "https://x.com" });
  assert.equal(r?.cookies.find((c) => c.name === "auth_token")?.value, "0123456789abcdef");
});

test("chooses the profile that has all loginCookies, not merely the most recent one", () => {
  const root = tmp();
  makeChromiumDb(join(root, "Default"), [{ host_key: ".linkedin.com", name: "bcookie", value: "somebrowseridxxxx" }], {
    password: "pw",
  });
  makeChromiumDb(join(root, "Profile 2"), [li, js], { password: "pw" });
  // Make Default the most recently used, so only the loginCookies rule picks Profile 2.
  utimesSync(join(root, "Default", "Network", "Cookies"), new Date(), new Date());
  utimesSync(
    join(root, "Profile 2", "Network", "Cookies"),
    new Date(Date.now() - 100000),
    new Date(Date.now() - 100000),
  );
  inject([{ name: "Chrome", family: "chromium", root, password: "pw" }]);

  const r = importFromBrowsers({ url: "https://www.linkedin.com", loginCookies: ["li_at", "JSESSIONID"] });
  assert.equal(r?.source, "chrome:Profile 2");
});

test("two signed-in profiles: refuses to guess (not the most recently used), listing each profile's name and Google account", () => {
  const root = tmp();
  makeChromiumDb(
    join(root, "Default"),
    [{ host_key: ".reddit.com", name: "reddit_session", value: "oldsessionvalue1" }],
    { password: "pw" },
  );
  makeChromiumDb(
    join(root, "Profile 1"),
    [{ host_key: ".reddit.com", name: "reddit_session", value: "newsessionvalue2" }],
    { password: "pw" },
  );
  utimesSync(join(root, "Default", "Network", "Cookies"), new Date(Date.now() - 100000), new Date(Date.now() - 100000));
  utimesSync(join(root, "Profile 1", "Network", "Cookies"), new Date(), new Date());
  writeFileSync(
    join(root, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Work", user_name: "someone.else@example.com" },
          "Profile 1": { name: "Me", user_name: "me@example.com" },
        },
      },
    }),
  );
  inject([{ name: "Chrome", family: "chromium", root, password: "pw" }]);

  let err: unknown;
  try {
    importFromBrowsers({ url: "https://reddit.com" });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof AmbiguousProfile, `expected a refusal, got ${String(err)}`);
  assert.deepEqual(
    err.candidates.sort((a, b) => a.profile.localeCompare(b.profile)),
    [
      { profile: "Chrome/Default", name: "Work", email: "someone.else@example.com" },
      { profile: "Chrome/Profile 1", name: "Me", email: "me@example.com" },
    ],
  );
  // a known site's loginCookies narrow it the same way: both hold them, so still no guess
  assert.throws(
    () => importFromBrowsers({ url: "https://reddit.com", loginCookies: ["reddit_session"] }),
    AmbiguousProfile,
  );
  // the human's pick is honoured, and the chosen profile's name comes back for printing
  const r = importFromBrowsers({ url: "https://reddit.com", pin: { browser: "Chrome", profile: "Profile 1" } });
  assert.equal(r?.source, "chrome:Profile 1");
  assert.equal(r?.cookies[0]?.value, "newsessionvalue2");
  assert.equal(r?.name, "Me");
  assert.equal(r?.email, "me@example.com");
});

test("one profile signed in, another with only tracking cookies: the signed-in one, no question asked", () => {
  const root = tmp();
  makeChromiumDb(join(root, "Default"), [{ host_key: ".reddit.com", name: "csv", value: "trackingcookie1" }], {
    password: "pw",
  });
  makeChromiumDb(
    join(root, "Profile 1"),
    [{ host_key: ".reddit.com", name: "reddit_session", value: "realsessionvalue" }],
    { password: "pw" },
  );
  inject([{ name: "Chrome", family: "chromium", root, password: "pw" }]);
  assert.equal(importFromBrowsers({ url: "https://www.reddit.com" })?.source, "chrome:Profile 1");
});

test("a profile holding only the session cookie every visitor is given is not signed in: the one with a login is chosen", () => {
  const root = tmp();
  const visitor = { host_key: ".myshop.com", name: "laravel_session", value: "eyJpdiI6InZpc2l0b3Ii" };
  makeChromiumDb(join(root, "Default"), [visitor], { password: "pw" });
  makeChromiumDb(
    join(root, "Profile 1"),
    [visitor, { host_key: ".myshop.com", name: "remember_web_59ba36", value: "eyJpdiI6Im1lbWJlciJ9" }],
    { password: "pw" },
  );
  inject([{ name: "Chrome", family: "chromium", root, password: "pw" }]);
  assert.throws(() => importFromBrowsers({ url: "https://www.myshop.com" }), AmbiguousProfile, "by name alone");
  const r = importFromBrowsers({ url: "https://www.myshop.com", guest: ["laravel_session"] });
  assert.equal(r?.source, "chrome:Profile 1");
});

describe("re-import", () => {
  const url = "https://www.myshop.com/";
  const root = tmp();
  const visitor = (value: string) => ({ host_key: ".myshop.com", name: "laravel_session", value });
  const login = (value: string) => ({ host_key: ".myshop.com", name: "remember_web_59ba36", value });
  const profile = (...rows: { host_key: string; name: string; value: string }[]) =>
    makeChromiumDb(join(root, "Profile 3"), rows, { password: "pw" });
  const work = 'Chrome profile "Work" (me@work.example)';
  before(() => {
    process.env.API_ANYTHING_HOME = tmp();
    process.env.API_ANYTHING_BROWSER = "no-such-browser"; // nothing pushed into a browser profile
    writeFileSync(
      join(root, "Local State"),
      JSON.stringify({ profile: { info_cache: { "Profile 3": { name: "Work", user_name: "me@work.example" } } } }),
    );
  });
  beforeEach(() => inject([{ name: "Chrome", family: "chromium", root, password: "pw" }]));
  after(() => delete process.env.API_ANYTHING_BROWSER);

  test("the same login cookies again are no recovery: the hint names the profile to sign in to", async () => {
    saveSession("myshop", { cookies: [], values: {}, guestCookies: ["laravel_session"] });
    profile(visitor("eyJ2aXNpdG9yIjoxfQ"), login("eyJsb2dpbiI6MX0xx"));
    const first = await importSession("myshop", url, { pushProfile: false, confirm: yes });
    assert.equal(first?.signedIn, true);
    assert.equal(first?.renewed, true);
    assert.equal(importWarning(url, first!), undefined);

    // the site ended that sign-in, and the browser still holds its cookie
    assert.deepEqual(await reimportIfBrowser("myshop", url), {
      renewed: false,
      signIn: `sign in to myshop.com in ${work}`,
      profile: "Chrome/Profile 3",
    });
    const again = await importSession("myshop", url, { pushProfile: false });
    assert.equal(again?.renewed, false);
    assert.match(
      importWarning(url, again!) ?? "",
      /imported from Chrome profile "Work" .*are the ones the session already held: nothing was renewed.*sign in to myshop\.com in Chrome profile "Work"/,
    );
    // a page load renews the visitor's cookie, not the login
    profile(visitor("eyJ2aXNpdG9yIjoyfQ"), login("eyJsb2dpbiI6MX0xx"));
    assert.equal((await reimportIfBrowser("myshop", url)).renewed, false);
    // signed in again in that profile
    profile(visitor("eyJ2aXNpdG9yIjoyfQ"), login("eyJsb2dpbiI6Mn0xx"));
    assert.equal((await reimportIfBrowser("myshop", url)).renewed, true);
    // signed out there: only the visitor's cookie is left
    profile(visitor("eyJ2aXNpdG9yIjozfQ"));
    assert.deepEqual(await reimportIfBrowser("myshop", url), {
      renewed: false,
      signIn: `sign in to myshop.com in ${work}`,
      profile: "Chrome/Profile 3",
    });
    const out = await importSession("myshop", url, { pushProfile: false });
    assert.equal(out?.signedIn, false);
    assert.match(
      importWarning(url, out!) ?? "",
      /none of the cookies imported from Chrome profile "Work" .*shows a sign-in/,
    );
  });

  test("a site whose login cookie no rule can name: any changed cookie is worth one retry, the same jar is not", async () => {
    saveSession("plain", { cookies: [], values: {} });
    const uid = (value: string) => ({ host_key: ".plainsite.com", name: "uid", value });
    makeChromiumDb(join(root, "Profile 3"), [uid("1001")], { password: "pw" });
    await importSession("plain", "https://plainsite.com/", { pushProfile: false, confirm: yes });
    assert.equal((await reimportIfBrowser("plain", "https://plainsite.com/")).renewed, false);
    makeChromiumDb(join(root, "Profile 3"), [uid("1002")], { password: "pw" });
    assert.equal((await reimportIfBrowser("plain", "https://plainsite.com/")).renewed, true);
  });
});

describe("a first import from a browser profile needs a person", () => {
  const url = "https://www.linkedin.com/";
  let root: string;
  const asked: string[] = [];
  const answer = (yes: boolean) => async (q: string) => {
    asked.push(q);
    return yes;
  };
  const savedAllow = process.env.API_ANYTHING_ALLOW_IMPORT;
  beforeEach(() => {
    process.env.API_ANYTHING_HOME = tmp();
    process.env.API_ANYTHING_BROWSER = "no-such-browser";
    delete process.env.API_ANYTHING_ALLOW_IMPORT;
    asked.length = 0;
    root = tmp();
    makeChromiumDb(join(root, "Default"), [li, js], { password: "pw" });
    makeChromiumDb(join(root, "Profile 2"), [{ host_key: ".linkedin.com", name: "lang", value: "v=2&lang=en-us" }], {
      password: "pw",
    });
    inject([{ name: "Chrome", family: "chromium", root, password: "pw" }]);
  });
  after(() => {
    delete process.env.API_ANYTHING_BROWSER;
    if (savedAllow === undefined) delete process.env.API_ANYTHING_ALLOW_IMPORT;
    else process.env.API_ANYTHING_ALLOW_IMPORT = savedAllow;
  });

  test("with no one to ask, nothing is read: not even the cookie names", async () => {
    // a cookie database that cannot be opened: a scan would throw something else
    writeFileSync(join(root, "Default", "Network", "Cookies"), "not a database");
    await assert.rejects(
      importSession("linkedin", url, { pushProfile: false }),
      (e) => e instanceof ImportRefused && !e.declined && /needs a yes from a person at a terminal/.test(e.message),
    );
    // --profile is no way around it: an agent can pass it
    await assert.rejects(
      importSession("linkedin", url, { pushProfile: false, profile: "Chrome/Default" }),
      ImportRefused,
    );
    assert.deepEqual(loadSession("linkedin").cookies, []);
  });

  test("the person is asked which profile, before any value is read; a no keeps nothing", async () => {
    await assert.rejects(
      importSession("linkedin", url, { pushProfile: false, confirm: answer(false) }),
      (e) => e instanceof ImportRefused && e.declined,
    );
    assert.deepEqual(asked, ['Import linkedin.com cookies from Chrome profile "Default"?']);
    assert.deepEqual(loadSession("linkedin").cookies, []);
    const r = await importSession("linkedin", url, { pushProfile: false, confirm: answer(true) });
    assert.equal(r?.source, "chrome:Default");
    assert.equal(loadSession("linkedin").source, "chrome:Default");
  });

  test("the profile chosen before is read again with no question: login again, a re-import on auth", async () => {
    await importSession("linkedin", url, { pushProfile: false, confirm: answer(true) });
    asked.length = 0;
    assert.ok(await importSession("linkedin", url, { pushProfile: false }));
    assert.ok(await importSession("linkedin", url, { pushProfile: false, profile: "Chrome/Default" }));
    assert.equal((await reimportIfBrowser("linkedin", url)).profile, "Chrome/Default");
    assert.deepEqual(asked, []);
    // another profile is a new choice: asked again, or refused with no one to ask
    await assert.rejects(
      importSession("linkedin", url, { pushProfile: false, profile: "Chrome/Profile 2" }),
      (e) => e instanceof ImportRefused && /Chrome profile "Profile 2"/.test(e.message),
    );
    assert.ok(
      await importSession("linkedin", url, { pushProfile: false, profile: "Chrome/Profile 2", confirm: answer(true) }),
    );
    assert.deepEqual(asked, ['Import linkedin.com cookies from Chrome profile "Profile 2"?']);
  });

  test("a session from a sign-in window is no browser profile: the first import still asks", async () => {
    saveSession("linkedin", { cookies: [], values: {}, source: "window" });
    await assert.rejects(importSession("linkedin", url, { pushProfile: false }), ImportRefused);
  });

  test("API_ANYTHING_ALLOW_IMPORT pre-approves its hosts, for automation the user set up", async () => {
    process.env.API_ANYTHING_ALLOW_IMPORT = "github.com, www.linkedin.com";
    assert.equal(importAllowed("https://linkedin.com/feed"), true);
    assert.equal(importAllowed("https://github.com"), true);
    assert.equal(importAllowed("https://x.com"), false);
    assert.equal((await importSession("linkedin", url, { pushProfile: false }))?.source, "chrome:Default");
    process.env.API_ANYTHING_ALLOW_IMPORT = "linkedin.com.evil.example";
    saveSession("linkedin", { cookies: [], values: {} });
    await assert.rejects(importSession("linkedin", url, { pushProfile: false }), ImportRefused);
  });

  test("a cookies file needs no one", async () => {
    const file = join(process.env.API_ANYTHING_HOME!, "c.json");
    writeFileSync(file, JSON.stringify([{ name: "li_at", value: "fromafile", domain: ".linkedin.com" }]));
    assert.equal((await importSession("linkedin", url, { pushProfile: false, file }))?.source, "file");
  });

  test("CLI login with no terminal reads nothing, and says to run it in a terminal or use --window", async () => {
    const fx = await startFixture();
    try {
      // a cookie for the fixture's host, which login would import if it read the profile
      makeChromiumDb(
        join(root, "Default"),
        [{ host_key: "127.0.0.1", name: "auth_token", value: "member-token-0001" }],
        {
          password: "pw",
        },
      );
      const run = (env: Record<string, string> = {}) =>
        new Promise<{ code: number; out: Record<string, unknown>; stderr: string }>((resolve) =>
          execFile(
            process.execPath,
            ["--import", "tsx", join(ROOT, "src", "cli.ts"), "login", `${fx.url}/members`],
            { cwd: ROOT, env: { ...process.env, ...env } },
            (err, stdout, stderr) =>
              resolve({ code: err ? Number(err.code ?? 1) : 0, out: JSON.parse(stdout.trim()), stderr }),
          ),
        );
      const refused = await run();
      assert.equal(refused.code, 1);
      assert.match(String(refused.out.error), /needs a yes from a person at a terminal/);
      assert.match(refused.stderr, /in a terminal: api-anything login 127\.0\.0\.1.*--window/);
      assert.deepEqual(loadSession("127.0.0.1").cookies, []);
      const allowed = await run({ API_ANYTHING_ALLOW_IMPORT: "127.0.0.1" });
      assert.equal(allowed.code, 0, allowed.stderr);
      assert.equal(allowed.out.profile, "Chrome/Default");
    } finally {
      await fx.close();
    }
  });
});

test("guest cookie names: what a cookie-less visit is given, across the site's redirects, kept as a union", async () => {
  process.env.API_ANYTHING_HOME = tmp();
  const fx = await startFixture();
  try {
    assert.deepEqual(await guestCookieNames(`${fx.url}/members`), ["app_session"]);
    // /community redirects to /forum, whose page hands out ct0
    assert.ok((await guestCookieNames(`${fx.url}/community`))?.includes("ct0"));
    saveSession("members", { cookies: [], values: {}, guestCookies: ["older"] });
    const guest = await knownGuests("members", `${fx.url}/members`);
    assert.deepEqual(guest, ["app_session", "older"]);
    assert.deepEqual(loadSession("members").guestCookies, ["older"], "saved only with a login that uses them");
    // pinned login cookies decide alone: no probe
    assert.deepEqual(await knownGuests("members", `${fx.url}/members`, ["auth_token"]), ["older"]);
    // a login saves them with its cookies
    writeFileSync(join(process.env.API_ANYTHING_HOME!, "c.json"), JSON.stringify([{ name: "a", value: "1" }]));
    await importSession("members", `${fx.url}/`, {
      file: join(process.env.API_ANYTHING_HOME!, "c.json"),
      guest,
      pushProfile: false,
    });
    assert.deepEqual(loadSession("members").guestCookies, ["app_session", "older"]);
  } finally {
    await fx.close();
  }
  // no answer: nothing learned, nothing dropped
  assert.equal(await guestCookieNames("http://127.0.0.1:1/"), undefined);
  assert.deepEqual(await knownGuests("members", "http://127.0.0.1:1/"), ["app_session", "older"]);
});

test("--profile pin overrides selection; a missing pin throws", () => {
  const root = tmp();
  makeChromiumDb(join(root, "Default"), [li, js], { password: "pw" });
  makeChromiumDb(join(root, "Profile 2"), [{ host_key: ".linkedin.com", name: "li_at", value: "differentprofilexx" }], {
    password: "pw",
  });
  inject([{ name: "Chrome", family: "chromium", root, password: "pw" }]);

  assert.equal(
    importFromBrowsers({ url: "https://linkedin.com", pin: { profile: "Profile 2" } })?.cookies[0]?.value,
    "differentprofilexx",
  );
  assert.throws(
    () => importFromBrowsers({ url: "https://linkedin.com", pin: { browser: "chrome", profile: "Nope" } }),
    /no browser profile/,
  );
});

test("a pinned import never opens another profile or browser's cookie database", () => {
  const root = tmp();
  makeChromiumDb(join(root, "Default"), [li], { password: "pw" });
  mkdirSync(join(root, "Profile 2", "Network"), { recursive: true });
  writeFileSync(join(root, "Profile 2", "Network", "Cookies"), "not a database");
  const other = tmp();
  mkdirSync(join(other, "Default", "Network"), { recursive: true });
  writeFileSync(join(other, "Default", "Network", "Cookies"), "not a database");
  inject([
    { name: "Chrome", family: "chromium", root, password: "pw" },
    { name: "Brave", family: "chromium", root: other, password: "pw" },
  ]);
  const r = importFromBrowsers({ url: "https://linkedin.com", pin: { browser: "chrome", profile: "Default" } });
  assert.equal(r?.source, "chrome:Default");
  assert.equal(r?.cookies[0]?.value, li.value);
});

test("a profile pin without a browser still refuses matching accounts in different browsers", () => {
  const roots = [tmp(), tmp()];
  for (const root of roots) makeFirefoxDb(join(root, "shared"), [li]);
  inject([
    { name: "Firefox", family: "firefox", root: roots[0]! },
    { name: "Other Firefox", family: "firefox", root: roots[1]! },
  ]);
  assert.throws(
    () => importFromBrowsers({ url: "https://linkedin.com", pin: { profile: "shared" } }),
    AmbiguousProfile,
  );
  assert.equal(
    importFromBrowsers({ url: "https://linkedin.com", pin: { browser: "firefox", profile: "shared" } })?.source,
    "firefox:shared",
  );
});

test("only the site's own cookies are read", () => {
  const root = tmp();
  makeChromiumDb(join(root, "Default"), [li, { host_key: ".evil.com", name: "li_at", value: "shouldnotappearxx" }], {
    password: "pw",
  });
  inject([{ name: "Chrome", family: "chromium", root, password: "pw" }]);
  const r = importFromBrowsers({ url: "https://linkedin.com" });
  assert.deepEqual(
    r?.cookies.map((c) => c.domain),
    [".linkedin.com"],
  );
});

test("a wrong Safe Storage password skips cookies rather than failing", () => {
  const root = tmp();
  makeChromiumDb(join(root, "Default"), [li], { password: "the-real-pw" });
  inject([{ name: "Chrome", family: "chromium", root, password: "the-wrong-pw" }]);
  // decryption yields garbage or throws per-cookie; the import returns undefined (nothing usable).
  const r = importFromBrowsers({ url: "https://linkedin.com" });
  assert.ok(!r || r.cookies.every((c) => c.value !== "AQEDreallylongtokenvalue"));
});

test("Firefox plaintext moz_cookies", () => {
  const root = tmp();
  makeFirefoxDb(join(root, "abc.default-release"), [
    { host_key: "www.linkedin.com", name: "li_at", value: "firefoxtokenvalue", expires_utc: 2000000000 },
  ]);
  inject([{ name: "Firefox", family: "firefox", root }]);
  const r = importFromBrowsers({ url: "https://linkedin.com" });
  assert.equal(r?.source, "firefox:abc.default-release");
  assert.equal(r?.cookies[0]?.value, "firefoxtokenvalue");
  assert.equal(r?.cookies[0]?.expires, 2000000000);
});

test("cookiesFromFile parses Netscape and JSON exports", () => {
  const netscape = [
    "# Netscape HTTP Cookie File",
    "#HttpOnly_.linkedin.com\tTRUE\t/\tTRUE\t2000000000\tli_at\tAQEDtoken",
    "www.linkedin.com\tFALSE\t/\tFALSE\t0\tlang\ten",
  ].join("\n");
  const parsed = cookiesFromFile(netscape, "https://linkedin.com");
  const liAt = parsed.find((c) => c.name === "li_at")!;
  assert.deepEqual(
    [liAt.value, liAt.path, liAt.secure, liAt.httpOnly, liAt.expires],
    ["AQEDtoken", "/", true, true, 2000000000],
  );
  assert.equal(parsed.find((c) => c.name === "lang")!.secure, false);

  const json = JSON.stringify([
    {
      name: "li_at",
      value: "AQEDjson",
      domain: ".linkedin.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expirationDate: 1999999999.5,
    },
  ]);
  const fromJson = cookiesFromFile(json, "https://linkedin.com");
  assert.deepEqual(fromJson[0], {
    name: "li_at",
    value: "AQEDjson",
    domain: ".linkedin.com",
    path: "/",
    expires: 1999999999,
    httpOnly: true,
    secure: true,
    sameSite: undefined,
  });
});
