import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { addCookiesToProfile, browserAvailable, closeBrowser, profileCookies, runTrigger } from "../src/browser.js";
import { CaptureUnavailable, loadCapture, profileDir } from "../src/heal.js";
import { logout, resolveLoginTarget } from "../src/login.js";
import { loadSession, saveSession, sessionFile, writePrivate } from "../src/session.js";
import { parseSite } from "../src/spec.js";
import { saveSite } from "../src/store.js";
import type { StoredCookie } from "../src/types.js";
import { startFixture } from "./fixture/server.js";

const home = mkdtempSync(join(tmpdir(), "aa-logout-"));
process.env.API_ANYTHING_HOME = home;
after(async () => {
  await closeBrowser();
  rmSync(home, { recursive: true, force: true });
});

const cookie = (domain: string): StoredCookie => ({
  name: "sid",
  value: "synthetic-session-value",
  domain,
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
});

/** A home of its own, with no browser to find unless `browser` names one, for `body`. */
async function apart(body: (home: string) => Promise<void>, browser = "/nonexistent/chromium"): Promise<void> {
  const own = mkdtempSync(join(tmpdir(), "aa-logout-own-"));
  const was = process.env.API_ANYTHING_BROWSER;
  process.env.API_ANYTHING_HOME = own;
  process.env.API_ANYTHING_BROWSER = browser;
  try {
    await body(own);
  } finally {
    process.env.API_ANYTHING_HOME = home;
    if (was === undefined) delete process.env.API_ANYTHING_BROWSER;
    else process.env.API_ANYTHING_BROWSER = was;
    rmSync(own, { recursive: true, force: true });
  }
}

/** A capture file as a browser run saves one, holding the run's cookies. */
function capture(home: string, id: string, url: string, cookies: StoredCookie[]): void {
  mkdirSync(join(home, "captures"), { recursive: true });
  writeFileSync(
    join(home, "captures", `${id}.json`),
    JSON.stringify({ id, at: new Date().toISOString(), url, finalUrl: url, cookies, exchanges: [] }),
  );
}

/** The profile's cookie database as Chrome keeps it, with these (host, name) rows. */
function profileCookieDb(rows: [string, string][]): void {
  const file = join(profileDir(), "Default", "Network", "Cookies");
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT)");
  const insert = db.prepare("INSERT INTO cookies (host_key, name) VALUES (?, ?)");
  for (const [host, name] of rows) insert.run(host, name);
  db.close();
}

test("logout deletes the saved captures: no copy of the site's cookies can be learned from again", () =>
  apart(async (own) => {
    saveSession("shop", { cookies: [cookie(".shop.test")], values: {} });
    capture(own, "cap1", "https://www.shop.test/s?q=alice", [cookie(".shop.test")]);
    capture(own, "cap2", "https://www.shop.test/s?q=bobby", [cookie(".shop.test")]);
    assert.equal(loadCapture("cap1").cookies.length, 1, "loadable before the logout");
    const r = await logout("shop");
    assert.deepEqual([r.site, r.session], ["shop", true]);
    assert.ok(!existsSync(sessionFile("shop")));
    for (const id of ["cap1", "cap2"])
      assert.throws(
        () => loadCapture(id),
        (e: unknown) => e instanceof CaptureUnavailable && /no capture/.test(e.message),
        id,
      );
  }));

test("logout takes what login takes: a www. host, a known site's domain; a name that is neither throws", () =>
  apart(async () => {
    // a new site is named after its host without www.
    const www = resolveLoginTarget("www.dummy.test").site;
    assert.equal(www, "dummy.test");
    saveSession(www, { cookies: [cookie(".dummy.test")], values: {}, source: "chrome:Default" });
    assert.deepEqual(await logout("www.dummy.test"), { site: "dummy.test", session: true, profile: "none" });
    assert.ok(!existsSync(sessionFile("dummy.test")));

    // a known site's domain is that site
    saveSite(parseSite({ name: "dummyshop", baseUrl: "https://www.dummyshop.test", operations: [] }));
    assert.equal(resolveLoginTarget("dummyshop.test").site, "dummyshop");
    saveSession("dummyshop", { cookies: [cookie(".dummyshop.test")], values: {} });
    assert.equal((await logout("dummyshop.test")).site, "dummyshop");
    assert.ok(!existsSync(sessionFile("dummyshop")));
    // again: nothing left to remove, and no error
    assert.deepEqual(await logout("dummyshop"), { site: "dummyshop", session: false, profile: "none" });

    // a session file's own name comes first, spec or not: `status` and a seal error list those names
    saveSession("plain", { cookies: [cookie(".elsewhere.test")], values: {} });
    assert.deepEqual(await logout("plain"), { site: "plain", session: true, profile: "none" });

    await assert.rejects(() => logout("nosuchsite"), /no site "nosuchsite"/);
    assert.ok(!existsSync(sessionFile("nosuchsite")), "nothing was made for a name that is no site");
  }));

test("logout says when the profile kept the site's cookies", async () => {
  // no browser found here: the profile's cookie stays, and logout says so
  await apart(async () => {
    saveSession("dummy.test", { cookies: [cookie(".dummy.test")], values: {} });
    profileCookieDb([[".dummy.test", "sid"]]);
    const r = await logout("dummy.test");
    assert.deepEqual([r.site, r.session, r.profile], ["dummy.test", true, "kept"]);
    assert.match(r.why ?? "", /no Chromium browser/);
    assert.ok(!existsSync(sessionFile("dummy.test")), "the session file is removed all the same");
  });
  // the profile holds no cookie of the site that could carry an account: nothing was kept
  await apart(async () => {
    saveSession("dummy.test", { cookies: [cookie(".dummy.test")], values: {} });
    profileCookieDb([
      [".other.test", "sid"],
      [".dummy.test", "_ga"],
    ]);
    assert.equal((await logout("dummy.test")).profile, "none");
  });
  // a browser that does not start: kept, with its reason
  const stub = join(home, "no-start.sh");
  writeFileSync(stub, "#!/bin/sh\necho 'cannot start here' >&2\nexit 1\n");
  chmodSync(stub, 0o755);
  await apart(async () => {
    saveSession("dummy.test", { cookies: [cookie(".dummy.test")], values: {} });
    profileCookieDb([[".dummy.test", "sid"]]);
    const r = await logout("dummy.test");
    assert.equal(r.profile, "kept");
    assert.ok(r.why, "it says why");
  }, stub);
  // no profile folder at all (a server or CI home): nothing to clear, and no browser is launched
  await apart(async () => {
    saveSession("dummy.test", { cookies: [cookie(".dummy.test")], values: {} });
    assert.deepEqual(await logout("dummy.test"), { site: "dummy.test", session: true, profile: "none" });
    assert.ok(!existsSync(profileDir()));
  });
});

test("logout never answers none for a site whose domain it cannot know: a sign-in in the profile is kept, with a next", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  // an unreadable spec: the name `linkedin` is no domain, and the cookie is on linkedin.com
  await apart(async (own) => {
    writePrivate(join(own, "sites/linkedin.json"), "{ not JSON");
    saveSession("linkedin", { cookies: [{ ...cookie(".linkedin.com"), name: "li_at" }], values: {} });
    profileCookieDb([[".linkedin.com", "li_at"]]);
    const r = await logout("linkedin");
    assert.deepEqual([r.site, r.session, r.profile], ["linkedin", true, "kept"]);
    assert.match(r.why ?? "", /domain of linkedin is not known/);
    assert.match(r.next ?? "", /api-anything logout <domain>/);
    assert.ok(!existsSync(sessionFile("linkedin")));
    // the CLI: exit 1, and the next is the one that works here, not "run it where a browser is found"
    saveSession("linkedin", { cookies: [], values: {} });
    const out = await new Promise<{ code: number; stderr: string }>((resolve) =>
      execFile(
        process.execPath,
        ["--import", "tsx", join(root, "src", "cli.ts"), "logout", "linkedin"],
        { cwd: root, env: process.env },
        (err, _stdout, stderr) => resolve({ code: err ? Number(err.code ?? 1) : 0, stderr }),
      ),
    );
    assert.equal(out.code, 1);
    assert.match(out.stderr, /next: .*api-anything logout <domain>/);
    // by the domain, the same profile is read for that domain
    assert.equal((await logout("linkedin.com")).profile, "kept");
  });
  // a session with no spec at all, under a name that is no domain
  await apart(async () => {
    saveSession("plain", { cookies: [cookie(".elsewhere.test")], values: {} });
    profileCookieDb([[".elsewhere.test", "sid"]]);
    assert.equal((await logout("plain")).profile, "kept");
  });
  // a profile that holds no cookie able to carry an account, of any site: nothing was kept
  await apart(async () => {
    saveSession("plain", { cookies: [cookie(".elsewhere.test")], values: {} });
    profileCookieDb([[".elsewhere.test", "_ga"]]);
    assert.deepEqual(await logout("plain"), { site: "plain", session: true, profile: "none" });
  });
});

test("the CLI's logout names the site it logged out, and exits 1 with a next when the profile kept the cookies or the name is no site", () =>
  apart(async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const cli = (...args: string[]) =>
      new Promise<{ code: number; out: Record<string, unknown>; stderr: string }>((resolve) =>
        execFile(
          process.execPath,
          ["--import", "tsx", join(root, "src", "cli.ts"), ...args],
          { cwd: root, env: process.env },
          (err, stdout, stderr) =>
            resolve({ code: err ? Number(err.code ?? 1) : 0, out: JSON.parse(stdout || "{}"), stderr }),
        ),
      );
    saveSession("dummy.test", { cookies: [cookie(".dummy.test")], values: {} });
    const done = await cli("logout", "www.dummy.test");
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(done.out, { ok: true, site: "dummy.test", loggedOut: true, session: true, profile: "none" });

    saveSession("dummy.test", { cookies: [cookie(".dummy.test")], values: {} });
    profileCookieDb([[".dummy.test", "sid"]]);
    const kept = await cli("logout", "dummy.test");
    assert.equal(kept.code, 1);
    assert.deepEqual(
      [kept.out.ok, kept.out.site, kept.out.loggedOut, kept.out.session, kept.out.profile],
      [false, "dummy.test", false, "removed", "kept"],
    );
    assert.match(String(kept.out.error), /browser profile may still hold its cookies/);
    assert.match(
      kept.stderr,
      /next: run it again where api-anything finds its browser.*api-anything logout dummy\.test/,
    );
    assert.ok(!existsSync(sessionFile("dummy.test")));

    const none = await cli("logout", "nosuchsite");
    assert.equal(none.code, 1);
    assert.match(String(none.out.error), /no site "nosuchsite"/);
  }));

test("logout clears the named site's browser cookies and keeps another site's session", {
  skip: !browserAvailable(),
  timeout: 45_000,
}, async () => {
  saveSite(parseSite({ name: "logical-name", baseUrl: "https://www.audit.test", operations: [] }));
  const own = [cookie(".audit.test"), cookie("api.audit.test")];
  const other = cookie(".other.test");
  saveSession("logical-name", { cookies: own, values: { token: "synthetic-token" } });
  await addCookiesToProfile([...own, other], profileDir());
  const r = await logout("LOGICAL-NAME");
  // its cookies and its origins' page storage
  assert.equal(r.profile, "cleared");
  assert.equal(r.why, undefined);
  assert.deepEqual(loadSession("logical-name").cookies, []);
  assert.deepEqual(loadSession("logical-name").values, {});
  assert.deepEqual(await profileCookies({ url: "https://www.audit.test", profileDir: profileDir() }), []);
  assert.equal((await profileCookies({ url: "https://other.test", profileDir: profileDir() })).length, 1);
});

test("a corrupt domain-named spec does not prevent clearing that domain's browser session", {
  skip: !browserAvailable(),
  timeout: 45_000,
}, async () => {
  writePrivate(join(home, "sites/audit.test.json"), "not JSON");
  const own = [cookie(".audit.test")];
  saveSession("audit.test", { cookies: own, values: {} });
  await addCookiesToProfile(own, profileDir());
  await logout("audit.test");
  assert.deepEqual(loadSession("audit.test").cookies, []);
  assert.deepEqual(await profileCookies({ url: "https://audit.test", profileDir: profileDir() }), []);
  // again, with no session left: the corrupt spec still stops nothing
  assert.equal((await logout("audit.test")).session, false);
});

test("logout of a site named after a subdomain clears the registrable domain's cookies in the profile", {
  skip: !browserAvailable(),
  timeout: 45_000,
}, async () => {
  // an import puts the cookies on the registrable domain, and `login app.sub.test` names the site after the host
  const own = [cookie(".sub.test")];
  saveSession("app.sub.test", { cookies: own, values: {} });
  await addCookiesToProfile(own, profileDir());
  assert.equal((await logout("app.sub.test")).profile, "cleared");
  assert.deepEqual(await profileCookies({ url: "https://app.sub.test", profileDir: profileDir() }), []);
});

test("logout clears what the site's pages stored in the profile: a token in localStorage is gone", {
  skip: !browserAvailable(),
  timeout: 60_000,
}, async () => {
  const fx = await startFixture();
  try {
    saveSite(parseSite({ name: "stored", baseUrl: fx.url, operations: [] }));
    const had = async () => {
      await runTrigger({ url: `${fx.url}/keeps-token`, profileDir: profileDir() });
      const kept = fx.calls.filter((c) => c.path.startsWith("/api/kept")).at(-1);
      assert.ok(kept, "the page reported what it found");
      return new URL(kept.path, fx.url).searchParams.get("had");
    };
    assert.equal(await had(), "", "a fresh profile holds no token");
    assert.equal(await had(), "synthetic-stored-token", "the page's token stays in the profile");
    assert.equal((await logout("stored")).profile, "cleared");
    assert.equal(await had(), "", "the token went with the logout");
  } finally {
    await fx.close();
  }
});
