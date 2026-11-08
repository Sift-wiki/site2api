/**
 * setup against a temp HOME: each agent's config, backups, idempotence, --dry-run, the non-TTY flags,
 * other entries never touched, and the agents' own CLIs (fakes on PATH) preferred when they exist.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSettings, QUESTION, saveSettings, settingsFile, VERIFY_QUESTION } from "../src/identity.js";
import {
  configPins,
  detect,
  guiServer,
  paths,
  pickAgents,
  SERVER,
  serverEntry,
  setup,
  summary,
  VERSION,
} from "../src/setup.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL = readFileSync(join(ROOT, "skills", "api-anything", "SKILL.md"), "utf8");
/** A whole copy of the skill folder at `dir`: its SKILL.md and the references it points at. */
const skillAt = (dir: string) => {
  assert.equal(read(join(dir, "SKILL.md")), SKILL, dir);
  assert.ok(existsSync(join(dir, "references", "writes.md")), `${dir} has its references`);
};
const saved = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  AA: process.env.API_ANYTHING_HOME,
  HERMES_HOME: process.env.HERMES_HOME,
};
let home: string;
let bin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aa-setup-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  process.env.HOME = home;
  process.env.PATH = bin;
  process.env.API_ANYTHING_HOME = join(home, ".api-anything");
  delete process.env.CODEX_HOME;
  delete process.env.HERMES_HOME;
  delete process.env.APPDATA;
  delete process.env.XDG_CONFIG_HOME;
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  process.env.API_ANYTHING_HOME = saved.AA;
  process.env.HERMES_HOME = saved.HERMES_HOME;
  rmSync(home, { recursive: true, force: true });
});

const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (file: string) => readFileSync(file, "utf8");
const json = (file: string) => JSON.parse(read(file));

/** Every agent's config with someone else's entries in it. */
function seed() {
  write(paths.claudeJson(), JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "other-mcp" } } }));
  write(paths.cursorJson(), JSON.stringify({ mcpServers: { cursorThing: { command: "x", args: ["y"] } } }, null, 2));
  write(paths.desktopJson(), JSON.stringify({ mcpServers: { fs: { command: "fs-mcp" } }, theme: "dark" }));
  write(paths.codexToml(), 'model = "o3"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "context7"]\n');
  write(paths.geminiJson(), JSON.stringify({ theme: "GitHub", mcpServers: { gh: { command: "gh-mcp" } } }));
  write(paths.vscodeJson(), JSON.stringify({ servers: { fetch: { type: "stdio", command: "uvx" } }, inputs: [] }));
  // the plain 2-space block form setup may edit
  write(
    paths.hermesYaml(),
    'model: "other"\nmcp_servers:\n  filesystem:\n    command: npx\n    args: ["-y", "fs", "/home"]\n',
  );
  return {
    claude: read(paths.claudeJson()),
    cursor: read(paths.cursorJson()),
    desktop: read(paths.desktopJson()),
    codex: read(paths.codexToml()),
    gemini: read(paths.geminiJson()),
    vscode: read(paths.vscodeJson()),
    hermes: read(paths.hermesYaml()),
  };
}

const ALL = ["claude-code", "codex", "cursor", "claude-desktop", "hermes", "gemini", "vscode"] as const;

/** An executable named `name` in the test's PATH. */
function fakeExe(name: string) {
  writeFileSync(join(bin, name), "#!/bin/sh\n");
  chmodSync(join(bin, name), 0o755);
}

test("GUI apps get npx by absolute path (from PATH, else beside the running node) with node on PATH; shell agents keep bare npx", async () => {
  fakeExe("npx"); // without node beside it, node's own directory goes on PATH
  assert.deepEqual(guiServer(), {
    command: join(bin, "npx"),
    args: SERVER.args,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
  });
  rmSync(join(bin, "npx"));
  const beside = join(dirname(process.execPath), "npx");
  if (existsSync(beside)) assert.equal(guiServer().command, beside);
  write(paths.cursorJson(), "{}");
  write(paths.claudeJson(), "{}");
  await setup({ agents: ["cursor", "claude-code"], share: false });
  assert.deepEqual(json(paths.cursorJson()).mcpServers["api-anything"], guiServer());
  assert.deepEqual(json(paths.claudeJson()).mcpServers["api-anything"], SERVER);
  // an entry already there, the bare one an earlier setup wrote included, is kept
  write(paths.desktopJson(), JSON.stringify({ mcpServers: { "api-anything": SERVER } }));
  const r = await setup({ agents: ["claude-desktop"], share: false });
  assert.equal(r.agents[0]!.mcp, "kept");
  assert.deepEqual(json(paths.desktopJson()).mcpServers["api-anything"], SERVER);
});

test("setup adds the server to each agent's config, keeps every other entry, and backs each file up", async () => {
  const before = seed();
  fakeExe("npx");
  fakeExe("node");
  const r = await setup({ agents: [...ALL], share: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(
    r.agents.map((a) => [a.agent, a.mcp, a.via]),
    ALL.map((a) => [a, "added", "file"]),
  );

  const claude = json(paths.claudeJson());
  assert.equal(claude.numStartups, 3);
  assert.deepEqual(claude.mcpServers, { other: { command: "other-mcp" }, "api-anything": SERVER });
  // GUI apps start with a minimal PATH: the npx on PATH, by its absolute path, with node's directory
  const gui = { command: join(bin, "npx"), args: SERVER.args, env: { PATH: `${bin}:/usr/bin:/bin` } };
  assert.deepEqual(json(paths.cursorJson()).mcpServers.cursorThing, { command: "x", args: ["y"] });
  assert.deepEqual(json(paths.cursorJson()).mcpServers["api-anything"], gui);
  assert.equal(json(paths.desktopJson()).theme, "dark");
  assert.deepEqual(json(paths.desktopJson()).mcpServers["api-anything"], gui);
  const toml = read(paths.codexToml());
  assert.ok(toml.startsWith(before.codex), "the old config.toml is kept as it was");
  assert.match(toml, /\[mcp_servers\.api-anything\]\ncommand = "npx"\nargs = \["-y", "api-anything", "mcp"\]\n$/);
  const yaml = read(paths.hermesYaml());
  assert.ok(yaml.startsWith(before.hermes), "the old config.yaml is kept as it was");
  assert.ok(
    yaml.endsWith(
      `  api-anything:\n    enabled: true\n    command: "${join(bin, "npx")}"\n    args: ${JSON.stringify(SERVER.args)}\n    env:\n      PATH: "${bin}:/usr/bin:/bin"\n`,
    ),
    yaml,
  );

  assert.equal(read(`${paths.claudeJson()}.bak-api-anything`), before.claude);
  assert.equal(read(`${paths.cursorJson()}.bak-api-anything`), before.cursor);
  assert.equal(read(`${paths.desktopJson()}.bak-api-anything`), before.desktop);
  assert.equal(read(`${paths.codexToml()}.bak-api-anything`), before.codex);
  // Gemini CLI starts from the shell; VS Code is a GUI app, and keeps its servers under `servers`
  const gemini = json(paths.geminiJson());
  assert.equal(gemini.theme, "GitHub");
  assert.deepEqual(gemini.mcpServers, { gh: { command: "gh-mcp" }, "api-anything": SERVER });
  const vscode = json(paths.vscodeJson());
  assert.deepEqual(vscode.inputs, []);
  assert.deepEqual(vscode.servers, {
    fetch: { type: "stdio", command: "uvx" },
    "api-anything": { type: "stdio", ...gui },
  });
  assert.equal(read(`${paths.geminiJson()}.bak-api-anything`), before.gemini);
  assert.equal(read(`${paths.vscodeJson()}.bak-api-anything`), before.vscode);
  assert.equal(read(`${paths.hermesYaml()}.bak-api-anything`), before.hermes);

  skillAt(paths.claudeSkill());
  skillAt(paths.agentsSkill());
  skillAt(paths.hermesSkill());
  // Codex, Cursor, Gemini CLI and VS Code share ~/.agents/skills; Hermes takes its own; Claude Desktop by upload
  assert.deepEqual(
    r.agents.map((a) => a.skill),
    ["installed", "installed", "unchanged", undefined, "installed", "unchanged", "unchanged"],
  );
  assert.equal(loadSettings().share, true);
  assert.ok(existsSync(join(home, ".api-anything", "key.json")));
  assert.equal("created" in r.key && r.key.created, true);
});

test("setup run again changes nothing", async () => {
  seed();
  await setup({ agents: [...ALL], share: true });
  const files = [
    paths.claudeJson(),
    paths.cursorJson(),
    paths.desktopJson(),
    paths.codexToml(),
    paths.hermesYaml(),
    paths.geminiJson(),
    paths.vscodeJson(),
    join(paths.claudeSkill(), "SKILL.md"),
    join(paths.claudeSkill(), ".api-anything.json"),
    join(paths.hermesSkill(), "SKILL.md"),
  ];
  const after1 = files.map(read);
  const askedAt = loadSettings().askedAt;
  const r = await setup({ agents: [...ALL] });
  assert.deepEqual(
    r.agents.map((a) => a.mcp),
    ALL.map(() => "unchanged"),
  );
  assert.deepEqual(
    r.agents.map((a) => a.skill),
    ["unchanged", "unchanged", "unchanged", undefined, "unchanged", "unchanged", "unchanged"],
  );
  assert.deepEqual(files.map(read), after1);
  assert.equal("created" in r.key && r.key.created, false);
  assert.deepEqual([r.share, loadSettings().askedAt], [true, askedAt], "the earlier answer stands");
});

test("an api-anything entry that is already there, set up another way, is left as it is", async () => {
  const mine = { command: "api-anything", args: ["mcp", "--allow-writes"] };
  write(paths.cursorJson(), JSON.stringify({ mcpServers: { "api-anything": mine } }));
  write(paths.codexToml(), '[mcp_servers."api-anything"]\ncommand = "api-anything"\nargs = ["mcp"]\n');
  write(
    paths.hermesYaml(),
    'mcp_servers:\n  api-anything:\n    enabled: true\n    command: "api-anything"\n    args: ["mcp", "--allow-writes"]\n',
  );
  const before = [read(paths.cursorJson()), read(paths.codexToml()), read(paths.hermesYaml())];
  const r = await setup({ agents: ["cursor", "codex", "hermes"], share: false });
  assert.deepEqual(
    r.agents.map((a) => [a.agent, a.mcp]),
    [
      ["cursor", "kept"],
      ["codex", "kept"],
      ["hermes", "kept"],
    ],
  );
  assert.deepEqual(r.agents[0]!.entry, mine);
  assert.deepEqual([read(paths.cursorJson()), read(paths.codexToml()), read(paths.hermesYaml())], before);
  assert.equal(existsSync(`${paths.cursorJson()}.bak-api-anything`), false);
  assert.equal(existsSync(`${paths.hermesYaml()}.bak-api-anything`), false);
});

test("an old copy of the skill is backed up under ~/.api-anything, then replaced whole", async () => {
  write(join(paths.claudeSkill(), "SKILL.md"), "old skill");
  write(join(paths.claudeSkill(), "notes.md"), "a file the package no longer ships");
  write(paths.claudeJson(), JSON.stringify({ mcpServers: { "api-anything": SERVER } }));
  const r = await setup({ agents: ["claude-code"], share: false });
  assert.equal(r.agents[0]!.skill, "updated");
  skillAt(paths.claudeSkill());
  assert.equal(existsSync(join(paths.claudeSkill(), "notes.md")), false);
  // not beside the copy: an agent walking its skills folder would load a backup as a second skill
  const saved = r.agents[0]!.skillBackup!;
  assert.ok(saved.startsWith(join(home, ".api-anything")), saved);
  assert.equal(read(join(saved, "SKILL.md")), "old skill");
  assert.equal(read(join(saved, "notes.md")), "a file the package no longer ships");
  assert.deepEqual(json(join(home, ".api-anything", "skills.json")).dirs, [paths.claudeSkill()]);
});

test("a config that can't be edited still leaves the skill installed", async () => {
  write(paths.vscodeJson(), '{\n  // my servers\n  "servers": {}\n}\n');
  const r = await setup({ agents: ["vscode"], share: false });
  assert.equal(r.agents[0]!.mcp, "failed");
  assert.equal(r.agents[0]!.skill, "installed");
  skillAt(paths.agentsSkill());
  assert.equal(read(paths.vscodeJson()), '{\n  // my servers\n  "servers": {}\n}\n');
});

test("an agent config that is not JSON is named in the error, never quoted: it can hold other servers' tokens", async () => {
  write(paths.cursorJson(), '{"t":SECRETX}');
  const r = await setup({ agents: ["cursor"] });
  assert.equal(r.agents[0]!.mcp, "failed");
  assert.equal(r.agents[0]!.error, `${paths.cursorJson()} is not valid JSON: fix it, then run setup again`);
  assert.equal(read(paths.cursorJson()), '{"t":SECRETX}');
});

test("--dry-run says what would change and changes nothing", async () => {
  const before = seed();
  const r = await setup({ agents: [...ALL], dryRun: true, share: true });
  assert.equal(r.dryRun, true);
  assert.deepEqual(
    r.agents.map((a) => [a.mcp, a.skill]),
    [
      ["would add", "would install"],
      ["would add", "would install"],
      ["would add", "would install"],
      ["would add", undefined],
      ["would add", "would install"],
      ["would add", "would install"],
      ["would add", "would install"],
    ],
  );
  assert.deepEqual(
    [
      read(paths.claudeJson()),
      read(paths.cursorJson()),
      read(paths.desktopJson()),
      read(paths.codexToml()),
      read(paths.hermesYaml()),
      read(paths.geminiJson()),
      read(paths.vscodeJson()),
    ],
    [before.claude, before.cursor, before.desktop, before.codex, before.hermes, before.gemini, before.vscode],
  );
  for (const f of [paths.claudeSkill(), paths.agentsSkill(), `${paths.claudeJson()}.bak-api-anything`])
    assert.equal(existsSync(f), false, f);
  assert.equal(existsSync(join(home, ".api-anything")), false, "no key, no settings");
  assert.deepEqual(r.key, { file: join(home, ".api-anything", "key.json"), wouldCreate: true });
});

/** A fake agent CLI: logs its argv, and adds the entry where the real one would. */
function fakeCli(name: "claude" | "codex" | "gemini" | "code") {
  const json = (file: string, key: string, entry: string) =>
    `const f=${JSON.stringify(file)};fs.mkdirSync(path.dirname(f),{recursive:true});const c=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8").replace(/^\\s*\\/\\/.*$/gm,"")):{};c.${key}={...c.${key},"api-anything":${entry}};fs.writeFileSync(f,JSON.stringify(c));`;
  const add = {
    claude: json(
      paths.claudeJson(),
      "mcpServers",
      `{type:"stdio",command:"npx",args:["-y","api-anything","mcp"],env:{}}`,
    ),
    codex: `const f=path.join(process.env.HOME,".codex","config.toml");fs.mkdirSync(path.dirname(f),{recursive:true});fs.appendFileSync(f,'[mcp_servers.api-anything]\\ncommand = "npx"\\nargs = ["-y", "api-anything", "mcp"]\\n');`,
    gemini: json(paths.geminiJson(), "mcpServers", `{command:"npx",args:["-y","api-anything","mcp"]}`),
    code: json(paths.vscodeJson(), "servers", `JSON.parse(process.argv[3])`),
  }[name];
  const file = join(bin, name);
  writeFileSync(
    file,
    `#!${process.execPath}\nconst fs=require("fs"),path=require("path");fs.appendFileSync(path.join(process.env.HOME,"cli.log"),JSON.stringify(process.argv.slice(1).map((a,i)=>i?a:path.basename(a)))+"\\n");${add}\n`,
  );
  chmodSync(file, 0o755);
}
const cliLog = () =>
  existsSync(join(home, "cli.log"))
    ? read(join(home, "cli.log"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];

test("the agents' own CLIs add the server when they are installed, and are not run again once it is there", async () => {
  fakeCli("claude");
  fakeCli("codex");
  write(paths.claudeJson(), JSON.stringify({ other: true }));
  assert.deepEqual(detect(), ["claude-code", "codex"]);
  const r = await setup({ agents: ["all"], share: false });
  assert.deepEqual(
    r.agents.map((a) => [a.agent, a.mcp, a.via]),
    [
      ["claude-code", "added", "cli"],
      ["codex", "added", "cli"],
    ],
  );
  assert.deepEqual(cliLog(), [
    ["claude", "mcp", "add", "--scope", "user", "api-anything", "--", "npx", "-y", "api-anything", "mcp"],
    ["codex", "mcp", "add", "api-anything", "--", "npx", "-y", "api-anything", "mcp"],
  ]);
  assert.equal(read(`${paths.claudeJson()}.bak-api-anything`), JSON.stringify({ other: true }));
  const again = await setup({ agents: ["all"], share: false });
  assert.deepEqual(
    again.agents.map((a) => a.mcp),
    ["unchanged", "unchanged"],
  );
  assert.equal(cliLog().length, 2);
});

test("Gemini CLI and VS Code: their own CLIs add the server, and a config with comments is read as text", async () => {
  fakeCli("gemini");
  fakeCli("code");
  fakeExe("npx");
  fakeExe("node");
  assert.deepEqual(detect(), ["gemini", "vscode"]);
  const r = await setup({ agents: ["all"], share: false });
  assert.deepEqual(
    r.agents.map((a) => [a.agent, a.mcp, a.via, a.skill]),
    [
      ["gemini", "added", "cli", "installed"],
      ["vscode", "added", "cli", "unchanged"],
    ],
  );
  const gui = { type: "stdio", command: join(bin, "npx"), args: SERVER.args, env: { PATH: `${bin}:/usr/bin:/bin` } };
  assert.deepEqual(cliLog(), [
    ["gemini", "mcp", "add", "--scope", "user", "api-anything", "npx", "--", "-y", "api-anything", "mcp"],
    ["code", "--add-mcp", JSON.stringify({ name: "api-anything", ...gui })],
  ]);
  const again = await setup({ agents: ["all"], share: false });
  assert.deepEqual(
    again.agents.map((a) => a.mcp),
    ["unchanged", "unchanged"],
  );

  // VS Code's mcp.json may hold comments: the entry is found in the text, and only `code` adds one
  write(paths.vscodeJson(), '{\n  // mine\n  "servers": { "api-anything": { "command": "x" } }\n}\n');
  assert.equal((await setup({ agents: ["vscode"], share: false })).agents[0]!.mcp, "kept");
  write(paths.vscodeJson(), '{\n  // mine\n  "servers": {}\n}\n');
  assert.deepEqual(
    (await setup({ agents: ["vscode"], share: false })).agents.map((a) => [a.mcp, a.via]),
    [["added", "cli"]],
  );
  assert.equal(cliLog().length, 3);
});

test("detect finds an agent by a file it writes, never by a directory left behind", () => {
  // empty directories: an uninstalled agent, or another tool's ~/.claude/skills
  for (const d of [
    join(home, ".claude", "skills"),
    paths.codexHome(),
    dirname(paths.cursorJson()),
    paths.hermesHome(),
    dirname(paths.geminiJson()),
    dirname(paths.vscodeJson()),
  ])
    mkdirSync(d, { recursive: true });
  mkdirSync(dirname(paths.desktopJson()), { recursive: true });
  assert.deepEqual(detect(), []);
  write(join(dirname(paths.cursorJson()), "argv.json"), "{}");
  write(join(paths.codexHome(), "auth.json"), "{}");
  write(join(dirname(paths.desktopJson()), "config.json"), "{}");
  write(paths.hermesYaml(), "{}");
  write(paths.geminiJson(), "{}");
  write(join(dirname(paths.vscodeJson()), "globalStorage", "storage.json"), "{}");
  assert.deepEqual(detect(), ["codex", "cursor", "claude-desktop", "hermes", "gemini", "vscode"]);
});

/** A Hermes config setup must not edit: the file keeps its shape, and the entry is printed to add by hand. */
test("hermes: servers indented 4 spaces are not edited; the entry is printed", async () => {
  write(paths.hermesYaml(), "mcp_servers:\n    other:\n        command: npx\n");
  const before = read(paths.hermesYaml());
  const r = await setup({ agents: ["hermes"], share: false });
  assert.equal(r.agents[0]!.mcp, "printed");
  assert.equal(read(paths.hermesYaml()), before, "the file is left as it was");
  assert.equal(existsSync(`${paths.hermesYaml()}.bak-api-anything`), false);
  assert.match(String(r.agents[0]!.entry), / {2}api-anything:\n {4}enabled: true\n {4}command: /);
});

test("hermes: an inline mcp_servers mapping is not edited; the entry is printed", async () => {
  write(paths.hermesYaml(), 'model: "other"\nmcp_servers: {other: {command: npx}}\n');
  const before = read(paths.hermesYaml());
  const r = await setup({ agents: ["hermes"], share: false });
  assert.equal(r.agents[0]!.mcp, "printed");
  assert.equal(read(paths.hermesYaml()), before, "the file is left as it was");
  assert.equal(existsSync(`${paths.hermesYaml()}.bak-api-anything`), false);
  assert.match(String(r.agents[0]!.entry), / {2}api-anything:/);
});

test("hermes: a 4-space api-anything entry is not duplicated; the entry is printed", async () => {
  write(paths.hermesYaml(), "mcp_servers:\n    api-anything:\n        command: x\n");
  const before = read(paths.hermesYaml());
  const r = await setup({ agents: ["hermes"], share: false });
  assert.equal(r.agents[0]!.mcp, "printed");
  assert.equal(read(paths.hermesYaml()), before, "the 4-space entry stands, no duplicate added");
  assert.equal(existsSync(`${paths.hermesYaml()}.bak-api-anything`), false);
});

test("hermes: a plain block, comment after the colon included, is edited", async () => {
  write(paths.hermesYaml(), "mcp_servers: # mine\n  other:\n    command: npx\n");
  const before = read(paths.hermesYaml());
  const r = await setup({ agents: ["hermes"], share: false });
  assert.equal(r.agents[0]!.mcp, "added");
  assert.ok(read(paths.hermesYaml()).startsWith(before), "the old config is kept as it was");
  assert.match(read(paths.hermesYaml()), / {2}api-anything:\n {4}enabled: true\n/);
});

function cli(...args: string[]): Promise<{ code: number; out: Record<string, unknown>; stderr: string }> {
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      ["--import", "tsx", join(ROOT, "src", "cli.ts"), ...args],
      { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}` } },
      (err, stdout, stderr) =>
        resolve({ code: err ? Number(err.code ?? 1) : 0, out: JSON.parse(stdout.trim().split("\n").at(-1)!), stderr }),
    ),
  );
}

test("CLI setup: --dry-run, --yes, --no-share, and no answer without a TTY", async () => {
  write(paths.cursorJson(), "{}");
  const dry = await cli("setup", "--dry-run", "--agents", "cursor");
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal((dry.out.agents as { mcp: string }[])[0]!.mcp, "would add");
  assert.match(dry.stderr, /dry run: nothing was changed/);
  assert.equal(read(paths.cursorJson()), "{}");

  const none = await cli("setup", "--agents", "cursor");
  assert.equal(none.out.shareAsked, false);
  assert.match(none.stderr, /Sharing: not asked yet/);
  assert.equal(loadSettings().askedAt, undefined, "nothing is shared until asked");

  const yes = await cli("setup", "--yes", "--agents", "cursor");
  assert.deepEqual([yes.out.share, loadSettings().share], [true, true]);
  assert.match(yes.stderr, /Cursor: already connected/);
  const no = await cli("setup", "--no-share", "--agents", "cursor");
  assert.deepEqual([no.out.share, loadSettings().share], [false, false]);

  // --share-only records the answer and touches no agent
  write(paths.cursorJson(), "{}");
  const only = await cli("setup", "--yes", "--share-only");
  assert.deepEqual([only.code, only.out.share, loadSettings().share], [0, true, true]);
  assert.equal(read(paths.cursorJson()), "{}");
  assert.match(only.stderr, /Sharing: on\. .*Turn it off with: api-anything setup --no-share --share-only/);
  assert.match(only.stderr, /Background verification: off, not asked/);
  const off = await cli("setup", "--no-share", "--share-only");
  assert.deepEqual([off.out.share, loadSettings().share], [false, false]);
  const unanswered = await cli("setup", "--share-only");
  assert.equal(unanswered.code, 1);
  assert.match(String(unanswered.out.error), /pass --yes or --no-share/);

  const both = await cli("setup", "--yes", "--no-share");
  assert.equal(both.code, 1);
  const bad = await cli("setup", "--agents", "vim");
  assert.match(String(bad.out.error), /unknown agent vim/);
});

/* --------------------------------------------------------- which agents */

/** Claude Code, Codex and Hermes installed, each with a config of its own. */
function three() {
  write(paths.claudeJson(), "{}");
  write(paths.codexToml(), 'model = "o3"\n');
  write(paths.hermesYaml(), 'model: "other"\n');
  return [read(paths.claudeJson()), read(paths.codexToml()), read(paths.hermesYaml())];
}
const configs = () => [read(paths.claudeJson()), read(paths.codexToml()), read(paths.hermesYaml())];

test("with no terminal and no --agents, setup connects nothing and says how to connect each agent found", async () => {
  const before = three();
  const r = await setup({ share: false });
  assert.equal(r.ok, true);
  assert.deepEqual([r.selection, r.found, r.agents], ["none", ["claude-code", "codex", "hermes"], []]);
  assert.deepEqual(
    r.notConnected.map((n) => [n.agent, n.command]),
    [
      ["claude-code", "api-anything setup --agents claude-code"],
      ["codex", "api-anything setup --agents codex"],
      ["hermes", "api-anything setup --agents hermes"],
    ],
  );
  assert.deepEqual(configs(), before, "no config was touched");
  assert.equal(existsSync(paths.claudeSkill()), false, "no skill installed");
  const text = summary(r);
  assert.match(
    text,
    /Claude Code: not connected: no terminal to ask; connect it with: api-anything setup --agents claude-code/,
  );
  assert.match(text, /Hermes: found, not connected \(always-on gateway\): add with --agents hermes/);
});

test("on a terminal it asks once which to connect; Hermes is never offered, and is only connected by name", async () => {
  three();
  const offered: unknown[] = [];
  const r = await setup({
    share: false,
    choose: async (offer, o) => {
      offered.push(offer, o);
      return ["codex"];
    },
  });
  assert.deepEqual(offered, [["claude-code", "codex"], { hermes: true }]);
  assert.deepEqual(
    r.agents.map((a) => [a.agent, a.mcp]),
    [["codex", "added"]],
  );
  assert.equal(read(paths.claudeJson()), "{}", "Claude Code was not chosen");
  assert.doesNotMatch(read(paths.hermesYaml()), /api-anything/);
  assert.deepEqual(
    r.notConnected.map((n) => [n.agent, n.reason]),
    [
      ["claude-code", "found, not chosen"],
      ["hermes", "found, not connected (always-on gateway)"],
    ],
  );
  // codex is connected now: a later run lists it neither as chosen nor as missing
  const again = await setup({ share: false, choose: async () => [] });
  assert.deepEqual(
    again.notConnected.map((n) => n.agent),
    ["claude-code", "hermes"],
  );
  // --agents all is every one found but Hermes; all,hermes adds it
  assert.deepEqual(
    (await setup({ agents: ["all"], share: false, dryRun: true })).agents.map((a) => a.agent),
    ["claude-code", "codex"],
  );
  assert.deepEqual(
    (await setup({ agents: ["all", "hermes"], share: false, dryRun: true })).agents.map((a) => a.agent),
    ["claude-code", "codex", "hermes"],
  );
});

test("--dry-run on a terminal asks nothing and reports what each offered agent would get", async () => {
  const before = three();
  let asked = false;
  const r = await setup({
    dryRun: true,
    choose: async () => {
      asked = true;
      return [];
    },
    ask: async () => {
      asked = true;
      return true;
    },
  });
  assert.equal(asked, false);
  assert.equal(r.selection, "would ask");
  assert.deepEqual(
    r.agents.map((a) => [a.agent, a.mcp]),
    [
      ["claude-code", "would add"],
      ["codex", "would add"],
    ],
  );
  assert.deepEqual(configs(), before);
  assert.match(summary(r), /Would ask which to connect \(Enter = all of Claude Code, Codex\)/);
  // with no terminal, a dry run says it would connect none
  assert.equal((await setup({ dryRun: true })).selection, "none");
});

test("the typed answer: Enter is every agent offered, numbers pick, n is none, anything else asks again", () => {
  const offer = ["claude-code", "codex", "cursor"] as const;
  assert.deepEqual(pickAgents("", [...offer]), [...offer]);
  assert.deepEqual(pickAgents(" 1,3 ", [...offer]), ["claude-code", "cursor"]);
  assert.deepEqual(pickAgents("2 3", [...offer]), ["codex", "cursor"]);
  assert.deepEqual(pickAgents("n", [...offer]), []);
  assert.equal(pickAgents("4", [...offer]), undefined);
  assert.equal(pickAgents("yes", [...offer]), undefined);
});

/* ------------------------------------------------------- share, verify */

test("the questions: sharing first (Enter = yes), then verification only after a yes (Enter = no)", async () => {
  const asked: [string, boolean][] = [];
  const answers = [true, false];
  const r = await setup({
    agents: [],
    ask: async (q, yes) => {
      asked.push([q, yes]);
      return answers.shift()!;
    },
  });
  assert.deepEqual(asked, [
    [QUESTION, true],
    [VERIFY_QUESTION, false],
  ]);
  assert.deepEqual([r.share, r.verify], [true, false]);
  assert.deepEqual([loadSettings().share, loadSettings().verify], [true, false]);
  assert.doesNotMatch(QUESTION, /test a few new operations/, "the sharing question no longer covers verification");
  assert.match(
    summary(r),
    /Sharing: on\..*\n.*Background verification: off\. Turn it on with: api-anything setup --verify/,
  );
  // answered: neither is asked again
  const again = await setup({ agents: [], ask: async () => assert.fail("asked again") });
  assert.deepEqual([again.share, again.verify], [true, false]);

  // a no to sharing: verification is not asked, and is off
  rmSync(settingsFile());
  asked.length = 0;
  const no = await setup({
    agents: [],
    ask: async (q, yes) => {
      asked.push([q, yes]);
      return false;
    },
  });
  assert.deepEqual(asked, [[QUESTION, true]]);
  assert.deepEqual([no.share, no.verify], [false, false]);
});

test("an install that answered the old question keeps verification as it answered, recorded once in settings", () => {
  // the old question: "... and test a few new operations a day from your network"
  write(settingsFile(), JSON.stringify({ share: true, askedAt: "2026-01-01T00:00:00.000Z" }));
  assert.equal(loadSettings().verify, true);
  const file = json(settingsFile());
  assert.deepEqual([file.verify, file.verifyAskedAt, file.verifyFrom], [true, "2026-01-01T00:00:00.000Z", "migrated"]);
  write(settingsFile(), JSON.stringify({ share: false, askedAt: "2026-01-01T00:00:00.000Z" }));
  assert.equal(loadSettings().verify, false);
  assert.equal(json(settingsFile()).verify, false);
  // a new install's yes to sharing alone never turns verification on
  rmSync(settingsFile());
  saveSettings({ share: true, askedAt: "2026-11-01T00:00:00.000Z" });
  assert.equal(loadSettings().verify, false);
  assert.equal(json(settingsFile()).verifyFrom, undefined);
});

test("CLI: --verify and --no-verify, with --share-only too; verification needs sharing on", async () => {
  const off = await cli("setup", "--verify", "--share-only");
  assert.equal(off.code, 1);
  assert.match(String(off.out.error), /needs sharing on/);
  const on = await cli("setup", "--yes", "--verify", "--share-only");
  assert.equal(on.code, 0, on.stderr);
  assert.deepEqual([on.out.share, on.out.verify, loadSettings().verify], [true, true, true]);
  assert.match(on.stderr, /Background verification: on\. An idle server tests up to 20 new shared operations a day/);
  const noVerify = await cli("setup", "--no-verify", "--share-only");
  assert.deepEqual([noVerify.out.share, noVerify.out.verify, loadSettings().verify], [true, false, false]);
  // a no to sharing turns verification off with it
  await cli("setup", "--verify", "--share-only");
  assert.equal(loadSettings().verify, true);
  await cli("setup", "--no-share", "--share-only");
  assert.deepEqual([loadSettings().share, loadSettings().verify], [false, false]);
  const both = await cli("setup", "--verify", "--no-verify", "--share-only");
  assert.match(String(both.out.error), /contradict/);
  // no terminal: an agent's run names the agent and records only the answers it was given
  write(paths.cursorJson(), "{}");
  const agent = await cli("setup", "--agents", "cursor", "--yes");
  assert.equal(agent.code, 0, agent.stderr);
  assert.equal((agent.out.agents as { mcp: string }[])[0]!.mcp, "added");
});

/* ----------------------------------------------------------------- pin */

test("--pin writes this version into every config it writes, and moves an older pin of setup's own entry", async () => {
  fakeExe("npx");
  fakeExe("node");
  write(paths.claudeJson(), "{}");
  write(paths.cursorJson(), "{}");
  write(paths.codexToml(), 'model = "o3"\n');
  write(paths.hermesYaml(), "mcp_servers:\n  other:\n    command: x\n");
  const pinned = ["-y", `api-anything@${VERSION}`, "mcp"];
  assert.deepEqual(serverEntry(true).args, pinned);
  const r = await setup({ agents: ["claude-code", "cursor", "codex", "hermes"], pin: true, share: false });
  assert.deepEqual(
    r.agents.map((a) => [a.agent, a.mcp, a.pinned]),
    [
      ["claude-code", "added", VERSION],
      ["cursor", "added", VERSION],
      ["codex", "added", VERSION],
      ["hermes", "added", VERSION],
    ],
  );
  assert.deepEqual(json(paths.claudeJson()).mcpServers["api-anything"], { command: "npx", args: pinned });
  assert.deepEqual(json(paths.cursorJson()).mcpServers["api-anything"].args, pinned);
  assert.match(
    read(paths.codexToml()),
    new RegExp(`args = \\["-y", "api-anything@${VERSION.replaceAll(".", "\\.")}", "mcp"\\]`),
  );
  assert.match(
    read(paths.hermesYaml()),
    new RegExp(`args: \\["-y","api-anything@${VERSION.replaceAll(".", "\\.")}","mcp"\\]`),
  );
  assert.deepEqual(
    configPins().map((p) => [p.agent, p.pinned]),
    [
      ["claude-code", VERSION],
      ["codex", VERSION],
      ["cursor", VERSION],
      ["hermes", VERSION],
    ],
  );

  // a run without --pin leaves a pinned entry as it is
  const plain = await setup({ agents: ["claude-code"], share: false });
  assert.deepEqual([plain.agents[0]!.mcp, plain.agents[0]!.pinned], ["kept", VERSION]);

  // an older version pinned them: --pin from this one moves each pin, and keeps the rest of the entry
  const old = ["-y", "api-anything@0.0.1", "mcp"];
  write(
    paths.claudeJson(),
    JSON.stringify({ mcpServers: { "api-anything": { type: "stdio", command: "npx", args: old, env: {} } } }),
  );
  write(paths.cursorJson(), JSON.stringify({ mcpServers: { "api-anything": { ...guiServer(), args: old } } }));
  write(
    paths.codexToml(),
    `model = "o3"\n\n[mcp_servers.api-anything]\ncommand = "npx"\nargs = ["-y", "api-anything@0.0.1", "mcp"]\nstartup_timeout_sec = 30\n`,
  );
  write(
    paths.hermesYaml(),
    `mcp_servers:\n  api-anything:\n    enabled: true\n    command: "${guiServer().command}"\n    args: ${JSON.stringify(old)}\n  other:\n    command: x\n`,
  );
  assert.deepEqual(
    configPins().map((p) => p.pinned),
    ["0.0.1", "0.0.1", "0.0.1", "0.0.1"],
  );
  const dry = await setup({ agents: ["claude-code", "cursor", "codex", "hermes"], pin: true, dryRun: true });
  assert.deepEqual(
    dry.agents.map((a) => a.mcp),
    ["would update", "would update", "would update", "would update"],
  );
  assert.match(summary(dry), new RegExp(`pin would move to api-anything@${VERSION.replaceAll(".", "\\.")}`));
  const moved = await setup({ agents: ["claude-code", "cursor", "codex", "hermes"], pin: true, share: false });
  assert.deepEqual(
    moved.agents.map((a) => [a.mcp, a.pinned]),
    [
      ["updated", VERSION],
      ["updated", VERSION],
      ["updated", VERSION],
      ["updated", VERSION],
    ],
  );
  assert.deepEqual(json(paths.claudeJson()).mcpServers["api-anything"], {
    type: "stdio",
    command: "npx",
    args: pinned,
    env: {},
  });
  assert.match(read(paths.codexToml()), /startup_timeout_sec = 30\n$/, "the table's other keys are kept");
  assert.match(read(paths.hermesYaml()), / {2}other:\n {4}command: x\n$/, "the other server is kept");
  assert.deepEqual(
    configPins().map((p) => p.pinned),
    [VERSION, VERSION, VERSION, VERSION],
  );

  // an entry setup did not write (a global install) is never touched, pin or not
  const own = { command: "api-anything", args: ["mcp"] };
  write(paths.cursorJson(), JSON.stringify({ mcpServers: { "api-anything": own } }));
  assert.equal((await setup({ agents: ["cursor"], pin: true, share: false })).agents[0]!.mcp, "kept");
  assert.deepEqual(json(paths.cursorJson()).mcpServers["api-anything"], own);
  assert.equal(configPins().find((p) => p.agent === "cursor")?.pinned, "custom");
});

test("moving a pin changes only the package argument: env, command, cwd and other fields stay", async () => {
  fakeExe("npx");
  fakeExe("node");
  const old = ["-y", "api-anything@0.0.1", "mcp"];
  const pinned = ["-y", `api-anything@${VERSION}`, "mcp"];
  const custom = { API_ANYTHING_LOCAL_ONLY: "1", API_ANYTHING_HOME: "/data/aa" };
  write(
    paths.cursorJson(),
    JSON.stringify({
      mcpServers: {
        "api-anything": { command: "/custom/npx", args: old, env: { PATH: "/my/bin", ...custom }, cwd: "/work" },
      },
    }),
  );
  // no PATH: the GUI entry's is merged in, beside the user's own variables
  write(
    paths.desktopJson(),
    JSON.stringify({ mcpServers: { "api-anything": { command: "npx", args: old, env: { ...custom } } } }),
  );
  write(
    paths.vscodeJson(),
    JSON.stringify({
      servers: {
        "api-anything": {
          type: "stdio",
          command: "/opt/npx",
          args: ["-y", "api-anything", "mcp"],
          env: { PATH: "/x", ...custom },
          envFile: "/e",
        },
      },
    }),
  );
  write(
    paths.codexToml(),
    `[mcp_servers.api-anything]\ncommand = "/opt/bin/npx"\nargs = ["-y", "api-anything@0.0.1", "mcp"]\nenv = { API_ANYTHING_LOCAL_ONLY = "1" }\n`,
  );
  write(
    paths.hermesYaml(),
    `mcp_servers:\n  api-anything:\n    command: "/opt/bin/npx"\n    args: ${JSON.stringify(old)}\n    env:\n      API_ANYTHING_HOME: "/data/aa"\n  other:\n    command: x\n`,
  );
  const agents = ["cursor", "claude-desktop", "vscode", "codex", "hermes"] as const;
  const r = await setup({ agents: [...agents], pin: true, share: false });
  assert.deepEqual(
    r.agents.map((a) => [a.agent, a.mcp, a.pinned]),
    agents.map((a) => [a, "updated", VERSION]),
  );
  assert.deepEqual(json(paths.cursorJson()).mcpServers["api-anything"], {
    command: "/custom/npx",
    args: pinned,
    env: { PATH: "/my/bin", ...custom },
    cwd: "/work",
  });
  assert.deepEqual(json(paths.desktopJson()).mcpServers["api-anything"], {
    command: "npx",
    args: pinned,
    env: { ...custom, PATH: guiServer().env!.PATH },
  });
  assert.deepEqual(json(paths.vscodeJson()).servers["api-anything"], {
    type: "stdio",
    command: "/opt/npx",
    args: pinned,
    env: { PATH: "/x", ...custom },
    envFile: "/e",
  });
  assert.equal(
    read(paths.codexToml()),
    `[mcp_servers.api-anything]\ncommand = "/opt/bin/npx"\nargs = ${JSON.stringify(pinned).replaceAll(",", ", ")}\nenv = { API_ANYTHING_LOCAL_ONLY = "1" }\n`,
  );
  assert.equal(
    read(paths.hermesYaml()),
    `mcp_servers:\n  api-anything:\n    command: "/opt/bin/npx"\n    args: ${JSON.stringify(pinned)}\n    env:\n      PATH: ${JSON.stringify(guiServer().env!.PATH)}\n      API_ANYTHING_HOME: "/data/aa"\n  other:\n    command: x\n`,
  );
  // moved: a second run has nothing to change
  const again = await setup({ agents: [...agents], pin: true, share: false });
  assert.deepEqual(
    again.agents.map((a) => a.mcp),
    agents.map(() => "unchanged"),
  );
  // a Hermes entry with no env gets one holding PATH, after its other keys
  write(paths.hermesYaml(), `mcp_servers:\n  api-anything:\n    command: npx\n    args: ${JSON.stringify(old)}\n`);
  await setup({ agents: ["hermes"], pin: true, share: false });
  assert.equal(
    read(paths.hermesYaml()),
    `mcp_servers:\n  api-anything:\n    command: npx\n    args: ${JSON.stringify(pinned)}\n    env:\n      PATH: ${JSON.stringify(guiServer().env!.PATH)}\n`,
  );
});

test("CLI: mcp --print-config --pin prints the pinned npx form; status shows each config's pin", async () => {
  fakeExe("npx");
  const printed = await new Promise<string>((resolve) =>
    execFile(
      process.execPath,
      ["--import", "tsx", join(ROOT, "src", "cli.ts"), "mcp", "--print-config", "--pin"],
      { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}` } },
      (_err, stdout) => resolve(stdout),
    ),
  );
  assert.ok(printed.includes(`${join(bin, "npx")} -y api-anything@${VERSION} mcp`), printed);
  write(paths.claudeJson(), JSON.stringify({ mcpServers: { "api-anything": SERVER } }));
  const s = await cli("status");
  assert.deepEqual(s.out.configs, [{ agent: "claude-code", file: paths.claudeJson(), pinned: false }]);
});
