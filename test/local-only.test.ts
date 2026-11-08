/**
 * Local-only mode: with it on, no code path opens a connection to the registry. The registry URL points
 * at a localhost server that counts every connection; each test ends with that count at zero.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { verifyCandidates } from "../src/background.js";
import {
  answerShare,
  answerVerify,
  loadSettings,
  localOnly,
  saveSettings,
  setLocalOnly,
  settingsFile,
} from "../src/identity.js";
import { createServer as mcpServer } from "../src/mcp.js";
import { uploadName } from "../src/publish.js";
import {
  LocalOnlyError,
  pull,
  registryRequest,
  reportInterface,
  search,
  servedNow,
  sharedName,
  upgradeBundled,
} from "../src/registry.js";
import { flushReports, queueReport } from "../src/report.js";
import { record } from "../src/setup.js";
import { answerClaims, shareOps } from "../src/share.js";
import { parseSite } from "../src/spec.js";
import { loadSite, saveSite } from "../src/store.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let hits: string[] = [];
let connections = 0;
const registry = createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  res.writeHead(500, { "content-type": "application/json" }).end('{"error":"local-only must not reach me"}');
});
registry.on("connection", () => connections++);
let base = "";
const saved = { reg: process.env.API_ANYTHING_REGISTRY, env: process.env.API_ANYTHING_LOCAL_ONLY };

before(async () => {
  await new Promise<void>((r) => registry.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
  process.env.API_ANYTHING_REGISTRY = base;
});
after(async () => {
  await new Promise((r) => registry.close(r));
  for (const [k, v] of [
    ["API_ANYTHING_REGISTRY", saved.reg],
    ["API_ANYTHING_LOCAL_ONLY", saved.env],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aa-local-only-"));
  process.env.API_ANYTHING_HOME = home;
  hits = [];
  connections = 0;
  // sharing and verification on: every background path would otherwise run
  saveSettings({
    share: true,
    askedAt: "2026-11-01T00:00:00.000Z",
    verify: true,
    verifyAskedAt: "2026-11-01T00:00:00.000Z",
  });
});
afterEach(() => {
  delete process.env.API_ANYTHING_LOCAL_ONLY;
  rmSync(home, { recursive: true, force: true });
});

const noConnection = () => {
  assert.deepEqual(hits, [], "no request reached the registry");
  assert.equal(connections, 0, "no connection was opened to the registry");
};

const mine = () =>
  saveSite(
    parseSite({
      name: "mine",
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
          version: { hash: "a".repeat(64), status: "live" },
        },
      ],
    }),
  );

test("the server is reachable when local-only is off: the counter works", async () => {
  await assert.rejects(registryRequest("/v1/search?q=x"));
  assert.equal(hits.length, 1);
});

for (const how of ["env", "setting"] as const)
  describe(`local-only by ${how === "env" ? "API_ANYTHING_LOCAL_ONLY=1" : "setup --local-only"}`, () => {
    beforeEach(() => {
      if (how === "env") process.env.API_ANYTHING_LOCAL_ONLY = "1";
      else setLocalOnly(true);
      assert.equal(localOnly(), true);
    });

    test("every registry function refuses before connecting", async () => {
      await assert.rejects(registryRequest("/v1/search?q=x"), LocalOnlyError);
      await assert.rejects(pull("hacker-news"), LocalOnlyError);
      await assert.rejects(reportInterface("mcp", "https://example.com/mcp"), LocalOnlyError);
      assert.equal(await sharedName("example.com"), undefined);
      mine();
      assert.equal(await uploadName("mine"), "example-com");
      assert.equal(await upgradeBundled("hacker-news"), false);
      const op = loadSite("mine")!.site.operations[0]!;
      assert.equal(await servedNow("mine", op), undefined);
      assert.equal(await verifyCandidates(), 0);
      queueReport({ hash: "a".repeat(64), outcome: "ok", tier: 1, ms: 5 });
      await flushReports();
      await answerClaims();
      const [shared] = await shareOps("mine", ["search"], { evidence: {}, consent: true });
      assert.equal(shared?.shared, false);
      assert.match(String(shared?.reason), /local-only/);
      noConnection();
    });

    test("search answers from this machine and says so", async () => {
      const r = await search("hacker news");
      assert.ok(r.matches.some((m) => m.site === "hacker-news"));
      assert.equal(r.registryError, undefined);
      assert.match(String(r.localOnly), /searched this machine only/);
      noConnection();
    });

    test("MCP: find_sites says it searched here only; a site this machine lacks says it is local-only", async () => {
      const client = new Client({ name: "probe", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await mcpServer().connect(a);
      await client.connect(b);
      const tool = async (name: string, args: Record<string, unknown>) =>
        JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text);
      try {
        const found = await tool("find_sites", { query: "zzqxv" });
        assert.deepEqual(found.matches, []);
        assert.match(found.localOnly, /searched this machine only/);
        assert.match(found.next, /not asked \(local-only\)/);
        const missing = await tool("call_operation", { site: "nosuch", op: "x", args: {} });
        assert.equal(missing.ok, false);
        assert.match(missing.reason, /local-only/);
        assert.match(missing.next, how === "env" ? /unset API_ANYTHING_LOCAL_ONLY/ : /setup --no-local-only/);
        const ops = await tool("list_operations", { site: "nosuch" });
        assert.match(JSON.stringify(ops), /local-only/);
      } finally {
        await client.close();
      }
      noConnection();
    });

    test("CLI: search, pull, publish, interface and a call of a missing site send nothing", async () => {
      const cli = (...args: string[]) =>
        new Promise<{ code: number; out: Record<string, unknown>; stderr: string }>((resolve) =>
          execFile(
            process.execPath,
            ["--import", "tsx", join(ROOT, "src", "cli.ts"), ...args],
            { cwd: ROOT, env: process.env },
            (err, stdout, stderr) =>
              resolve({
                code: err ? Number(err.code ?? 1) : 0,
                out: JSON.parse(stdout.trim().split("\n").at(-1)!),
                stderr,
              }),
          ),
        );
      const s = await cli("search", "hacker", "news");
      assert.equal(s.code, 0, s.stderr);
      assert.match(String(s.out.localOnly), /searched this machine only/);
      const p = await cli("pull", "goodreads");
      assert.equal(p.code, 1);
      assert.match(String(p.out.error), /local-only/);
      mine();
      const pub = await cli("publish", "mine");
      assert.equal(pub.code, 1);
      assert.match(String(pub.out.error), /refusing to publish mine: this install is local-only/);
      const i = await cli("interface", "mcp", "https://example.com/mcp");
      assert.equal(i.code, 1);
      assert.match(i.stderr, how === "env" ? /unset API_ANYTHING_LOCAL_ONLY/ : /setup --no-local-only/);
      const c = await cli("call", "nosuch", "op");
      assert.equal(c.code, 1);
      assert.match(String(c.out.reason), /local-only/);
      noConnection();
    });
  });

test("setup --local-only is a setting, and --no-local-only turns it off", async () => {
  const cli = (...args: string[]) =>
    new Promise<{ code: number; stderr: string }>((resolve) =>
      execFile(
        process.execPath,
        ["--import", "tsx", join(ROOT, "src", "cli.ts"), ...args],
        { cwd: ROOT, env: process.env },
        (err, _stdout, stderr) => resolve({ code: err ? Number(err.code ?? 1) : 0, stderr }),
      ),
    );
  const on = await cli("setup", "--local-only", "--share-only");
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stderr, /Local-only: on\. Nothing is sent to the shared catalog/);
  assert.equal(JSON.parse(readFileSync(settingsFile(), "utf8")).localOnly, true);
  assert.equal(localOnly(), true);
  const off = await cli("setup", "--no-local-only", "--share-only");
  assert.equal(off.code, 0, off.stderr);
  assert.equal(localOnly(), false);
  assert.match(off.stderr, /Sharing: on/);
  noConnection();
});

test("an unreadable settings.json fails closed: local-only, and no request reaches the registry", async () => {
  writeFileSync(settingsFile(), "{ not json");
  assert.equal(localOnly(), true, "a settings file that cannot be read must not turn local-only off");
  const r = await search("hacker news");
  assert.match(String(r.localOnly), /searched this machine only/);
  noConnection();
  // the documented way out still works: it rewrites a readable file
  setLocalOnly(false);
  assert.equal(localOnly(), false);
});

test("an answer never replaces an unreadable settings.json: the inferred local-only is not written", async () => {
  const bad = '{"share": true, SECRETX';
  writeFileSync(settingsFile(), bad);
  const refused = (e: unknown) =>
    e instanceof Error &&
    e.message.startsWith(`${settingsFile()} is not valid JSON, so the answer was not saved`) &&
    /api-anything setup --local-only --share-only/.test(e.message) &&
    !e.message.includes("SECRETX");
  assert.throws(() => answerShare(true), refused);
  assert.throws(() => answerVerify(true), refused);
  await assert.rejects(record({ share: true, verify: true }), refused, "setup's flags too");
  assert.equal(readFileSync(settingsFile(), "utf8"), bad, "the file is left as it was");
  assert.equal(localOnly(), true, "still fail closed");
  assert.equal(loadSettings().localOnly, undefined, "the inferred flag is not one a reader can save back");

  // setLocalOnly replaces it with the one choice it could not read back; the rest starts unanswered
  setLocalOnly(false);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile(), "utf8")), { share: false, verify: false });
  answerShare(true);
  const saved = JSON.parse(readFileSync(settingsFile(), "utf8"));
  assert.equal(saved.share, true);
  assert.equal("localOnly" in saved, false);
  assert.equal(localOnly(), false);
  noConnection();
});

test("settings.json that is not an object, or a directory, fails closed too", () => {
  writeFileSync(settingsFile(), "null");
  assert.equal(localOnly(), true);
  assert.throws(() => answerShare(true), /settings\.json is not a JSON object, so the answer was not saved/);
  rmSync(settingsFile());
  mkdirSync(settingsFile());
  assert.equal(localOnly(), true);
  assert.throws(() => answerShare(true), /settings\.json cannot be read \(EISDIR\), so the answer was not saved/);
  noConnection();
});
