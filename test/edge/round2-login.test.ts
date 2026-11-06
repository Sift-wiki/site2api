/**
 * Round-2 regressions for login: never guess between browser profiles (two people's accounts),
 * accept domains as targets, keep MCP login to human-chosen sources, scope sites by the Public
 * Suffix List, and prune captures.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.js";
import { importSession, reimportIfBrowser, resolveLoginTarget } from "../../src/login.js";
import { createServer as mcpServer } from "../../src/mcp.js";
import { cookieValue, loadSession, parseSetCookie, pruneCaptures, saveSession, siteOf } from "../../src/session.js";
import { makeChromiumDb } from "../fixture/cookie-db.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "aa-round2-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let homes = 0;
const newHome = () => {
  const h = join(TMP, `home${++homes}`);
  mkdirSync(join(h, "sites"), { recursive: true });
  process.env.API_ANYTHING_HOME = h;
  return h;
};
newHome();

/** Two Chrome profiles, both signed in to LinkedIn as different people, with Local State names. */
function twoLinkedInProfiles(): string {
  const root = mkdtempSync(join(TMP, "browser-"));
  const li = (v: string) => [
    { host_key: ".linkedin.com", name: "li_at", value: `AQED${v}` },
    { host_key: ".www.linkedin.com", name: "JSESSIONID", value: `"ajax:${v}"` },
  ];
  makeChromiumDb(join(root, "Default"), li("someone-else-token"), { password: "pw" });
  makeChromiumDb(join(root, "Profile 2"), li("my-own-token-value"), { password: "pw" });
  writeFileSync(
    join(root, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Other Person", user_name: "other@example.com" },
          "Profile 2": { name: "Sam Rivera", user_name: "me@example.com" },
        },
      },
    }),
  );
  process.env.API_ANYTHING_BROWSER_ROOTS = JSON.stringify([
    { name: "Chrome", family: "chromium", root, password: "pw" },
  ]);
  return root;
}

const runCli = (home: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src/cli.ts"), ...args], {
      cwd: ROOT,
      env: { ...process.env, API_ANYTHING_HOME: home },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });

/* ------------------------------------------------------------ 1-3: login */

describe("login", () => {
  test("login linkedin.com / www.linkedin.com / a URL resolve to the bundled linkedin site; unknown domains become their own site", () => {
    newHome();
    for (const t of ["linkedin", "linkedin.com", "www.linkedin.com", "LinkedIn.com"]) {
      const r = resolveLoginTarget(t);
      assert.equal(r.site, "linkedin", t);
      assert.equal(r.url, "https://www.linkedin.com", t);
      assert.deepEqual(r.loginCookies, ["li_at", "JSESSIONID"], t);
    }
    assert.deepEqual(resolveLoginTarget("https://www.linkedin.com/login"), {
      site: "linkedin",
      url: "https://www.linkedin.com/login",
      loginCookies: ["li_at", "JSESSIONID"],
    });
    assert.deepEqual(resolveLoginTarget("www.example.org"), { site: "example.org", url: "https://www.example.org" });
    assert.throws(() => resolveLoginTarget("nosuchsite"), /no site "nosuchsite"/);
  });

  test("CLI: two profiles signed in to the site -> ok:false with each profile's name and account, and a --profile next", async () => {
    const home = newHome();
    twoLinkedInProfiles();
    try {
      // with no terminal, a first import reads nothing at all, so no profile is listed either
      const refused = JSON.parse((await runCli(home, "login", "linkedin.com")).out);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /needs a yes from a person at a terminal/);
      assert.equal(refused.candidates, undefined);
      // pre-approved (automation the user set up): still no guess between two accounts
      process.env.API_ANYTHING_ALLOW_IMPORT = "linkedin.com";
      const r = await runCli(home, "login", "linkedin.com");
      delete process.env.API_ANYTHING_ALLOW_IMPORT;
      assert.equal(r.code, 1, r.out + r.err);
      const out = JSON.parse(r.out);
      assert.equal(out.ok, false);
      const byProfile = Object.fromEntries(out.candidates.map((c: { profile: string }) => [c.profile, c]));
      assert.deepEqual(byProfile["Chrome/Default"], {
        profile: "Chrome/Default",
        name: "Other Person",
        email: "other@example.com",
      });
      assert.deepEqual(byProfile["Chrome/Profile 2"], {
        profile: "Chrome/Profile 2",
        name: "Sam Rivera",
        email: "me@example.com",
      });
      assert.match(r.err, /next: .*api-anything login linkedin --profile "<Browser\/Profile>"/);
      assert.equal(existsSync(join(home, "sessions", "linkedin.json")), false, "nothing imported on a guess");
    } finally {
      delete process.env.API_ANYTHING_BROWSER_ROOTS;
    }
  });

  test("the chosen profile is remembered: a self-heal re-import takes it even though another profile is signed in too", async () => {
    newHome();
    twoLinkedInProfiles();
    try {
      await assert.rejects(
        importSession("linkedin", "https://www.linkedin.com", {
          loginCookies: ["li_at", "JSESSIONID"],
          pushProfile: false,
          confirm: async () => true,
        }),
        /2 browser profiles are signed in/,
      );
      const r = await importSession("linkedin", "https://www.linkedin.com", {
        loginCookies: ["li_at", "JSESSIONID"],
        profile: "Chrome/Profile 2",
        pushProfile: false,
        confirm: async () => true,
      });
      assert.equal(r?.name, "Sam Rivera");
      assert.equal(loadSession("linkedin").source, "chrome:Profile 2");
      saveSession("linkedin", { ...loadSession("linkedin"), cookies: [] }); // the site logged the jar out
      assert.equal(
        (await reimportIfBrowser("linkedin", "https://www.linkedin.com", ["li_at", "JSESSIONID"])).renewed,
        true,
      );
      assert.equal(cookieValue(loadSession("linkedin").cookies, "li_at"), "AQEDmy-own-token-value");
    } finally {
      delete process.env.API_ANYTHING_BROWSER_ROOTS;
    }
  });

  test("MCP login import only refreshes a known site's human-chosen source; never an arbitrary domain", async () => {
    newHome();
    twoLinkedInProfiles();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = mcpServer({});
    await server.connect(a);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(b);
    const login = async (args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name: "login", arguments: args })).content as { text: string }[])[0]!.text);
    try {
      // an injected "log in to evil.example" or a known site with no human-run login: refused, points at the CLI
      for (const args of [
        { url: "https://accounts.evil.example/" },
        { site: "linkedin" },
        { site: "linkedin", mode: "import" },
      ]) {
        const r = await login(args);
        assert.equal(r.ok, false, JSON.stringify(r));
        assert.match(r.next, /api-anything login/);
      }
      assert.equal(existsSync(join(process.env.API_ANYTHING_HOME!, "sessions", "linkedin.json")), false);
      // after the human picked Profile 2 in the CLI, the agent may refresh exactly that one
      await importSession("linkedin", "https://www.linkedin.com", {
        loginCookies: ["li_at", "JSESSIONID"],
        profile: "Chrome/Profile 2",
        pushProfile: false,
        confirm: async () => true,
      });
      saveSession("linkedin", { ...loadSession("linkedin"), cookies: [] });
      const r = await login({ site: "linkedin" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.profile, "Chrome/Profile 2");
      assert.equal(cookieValue(loadSession("linkedin").cookies, "li_at"), "AQEDmy-own-token-value");
    } finally {
      delete process.env.API_ANYTHING_BROWSER_ROOTS;
      await client.close();
      await closeBrowser();
    }
  });
});

/* ------------------------------------------------------------ 9: public suffixes */

describe("public suffixes", () => {
  test("siteOf follows the Public Suffix List, private section included", () => {
    assert.notEqual(siteOf("api.victim.run.app"), "run.app");
    assert.equal(siteOf("foo.supabase.co"), "foo.supabase.co");
    assert.equal(siteOf("abc.execute-api.us-east-1.amazonaws.com"), "abc.execute-api.us-east-1.amazonaws.com");
    assert.equal(siteOf("www.bbc.co.uk"), "bbc.co.uk");
    assert.equal(siteOf("alice.github.io"), "alice.github.io");
    assert.equal(siteOf("www.linkedin.com"), "linkedin.com");
    assert.equal(siteOf("127.0.0.1"), "127.0.0.1");
    assert.equal(siteOf("localhost"), "localhost");
  });

  test("a Set-Cookie for a shared suffix is refused and a cookie ref never crosses it", () => {
    for (const [host, d] of [
      ["a.run.app", "run.app"],
      ["x.supabase.co", "supabase.co"],
      ["y.readthedocs.io", "readthedocs.io"],
      ["z.ngrok.app", "ngrok.app"],
      ["q.notion.site", "notion.site"],
    ]) {
      assert.equal(parseSetCookie(`sid=1; Domain=${d}`, `https://${host}/`), undefined, d);
    }
    const jar = [
      {
        name: "csrftoken",
        value: "OTHER-SITE-SECRET",
        domain: ".victim.run.app",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: true,
      },
    ];
    assert.equal(cookieValue(jar, "csrftoken", "https://attacker.run.app/x"), undefined);
    assert.equal(cookieValue(jar, "csrftoken", "https://api.victim.run.app/x"), "OTHER-SITE-SECRET");
  });
});

/* ------------------------------------------------------------ 14: captures */

test("captures: the newest 20 are kept, none older than 24 h", () => {
  const home = newHome();
  const dir = join(home, "captures");
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 25; i++) {
    const f = join(dir, `c${i}.json`);
    writeFileSync(f, "{}");
    const t = new Date(now - i * 60_000);
    utimesSync(f, t, t);
  }
  const old = join(dir, "cold.json");
  writeFileSync(old, "{}");
  utimesSync(old, new Date(now - 25 * 3600_000), new Date(now - 25 * 3600_000));
  pruneCaptures(now);
  const left = readdirSync(dir).sort();
  assert.equal(left.length, 20);
  assert.ok(!left.includes("cold.json"));
  assert.ok(left.includes("c0.json") && !left.includes("c24.json"));
});
