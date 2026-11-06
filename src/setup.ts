/**
 * `api-anything setup`: connect the MCP server to the agents the user chose (and the skill where the
 * agent takes skills), check for a browser, make the install's key, and ask the questions
 * (docs/REGISTRY.md, "Setup"). Other entries in an agent's config are never changed: a file is backed up
 * before it is edited, and an api-anything entry that is already there is left as it is, except that
 * `--pin` moves the version of an entry setup wrote.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { browserChoice } from "./browser.js";
import {
  answerShare,
  answerVerify,
  ensureKey,
  keyFile,
  loadSettings,
  localOnly,
  QUESTION,
  setLocalOnly,
  VERIFY_QUESTION,
} from "./identity.js";
import { installSkill, recordSkillDirs, type SkillResult, skillDirs } from "./skill.js";

export interface Entry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
const NAME = "api-anything";
export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/** The npx entry, unpinned (`npx` fetches the newest release at each start) or pinned to this version. */
export const serverEntry = (pin = false): Entry => ({
  command: "npx",
  args: ["-y", pin ? `${NAME}@${VERSION}` : NAME, "mcp"],
});
/** The entry for agents that start from the user's shell (Claude Code, Codex) and so find npx on PATH. */
export const SERVER: Entry = serverEntry();

/**
 * Whether an entry is the npx one setup writes, pinned or not: only such an entry may have its pin
 * moved. Anything else (a global install, a checkout, extra flags) is the user's own.
 */
function npxEntry(e: { command?: unknown; args?: unknown } | undefined): { pin?: string } | undefined {
  if (!e || typeof e.command !== "string" || !Array.isArray(e.args)) return undefined;
  if (!/^npx(\.cmd)?$/.test(basename(e.command))) return undefined;
  const [y, pkg, mcp, ...rest] = e.args as unknown[];
  if (y !== "-y" || mcp !== "mcp" || rest.length || typeof pkg !== "string") return undefined;
  const m = /^api-anything(?:@([\w.+-]+))?$/.exec(pkg);
  return m ? (m[1] ? { pin: m[1] } : {}) : undefined;
}

export const AGENTS = ["claude-code", "codex", "cursor", "claude-desktop", "hermes", "gemini", "vscode"] as const;
export type Agent = (typeof AGENTS)[number];
const LABEL: Record<Agent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "claude-desktop": "Claude Desktop",
  hermes: "Hermes",
  gemini: "Gemini CLI",
  vscode: "VS Code",
};

/** Where a desktop app keeps its settings: Application Support, %APPDATA%, or the XDG config folder. */
const appData = () =>
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32"
      ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

export const paths = {
  claudeJson: () => join(homedir(), ".claude.json"),
  claudeSkill: skillDirs.claude,
  codexHome: () => process.env.CODEX_HOME || join(homedir(), ".codex"),
  codexToml: () => join(paths.codexHome(), "config.toml"),
  agentsSkill: skillDirs.agents,
  cursorJson: () => join(homedir(), ".cursor", "mcp.json"),
  desktopJson: () => join(appData(), "Claude", "claude_desktop_config.json"),
  geminiJson: () => join(homedir(), ".gemini", "settings.json"),
  vscodeJson: () => join(appData(), "Code", "User", "mcp.json"),
  // Hermes's home comes from HERMES_HOME, else ~/.hermes; personal skills live under it
  hermesHome: () => process.env.HERMES_HOME || join(homedir(), ".hermes"),
  hermesYaml: () => join(paths.hermesHome(), "config.yaml"),
  hermesSkill: () => join(paths.hermesHome(), "skills", NAME, "SKILL.md"),
};

/** Claude Desktop takes skills only as an upload in its settings: it gets none here. */
const SKILL_DIR: Partial<Record<Agent, () => string>> = {
  "claude-code": paths.claudeSkill,
  codex: paths.agentsSkill,
  cursor: paths.agentsSkill,
  hermes: paths.hermesSkill,
  gemini: paths.agentsSkill,
  vscode: paths.agentsSkill,
};

/** Whether `cmd` is an executable on PATH. */
export function onPath(cmd: string): string | undefined {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean))
    for (const ext of exts) {
      const f = join(dir, cmd + ext);
      try {
        accessSync(f, constants.X_OK);
        return f;
      } catch {
        /* next */
      }
    }
  return undefined;
}

/**
 * The agents installed here: the command on PATH, or a file the agent writes itself. A bare directory
 * is no sign: one left behind (an uninstall, another tool's skills dir) would get a config the
 * machine never runs.
 */
export function detect(): Agent[] {
  const any = (...files: string[]) => files.some((f) => existsSync(f));
  const seen: Record<Agent, boolean> = {
    "claude-code": !!onPath("claude") || any(paths.claudeJson()),
    codex: !!onPath("codex") || any(paths.codexToml(), join(paths.codexHome(), "auth.json")),
    // Cursor writes argv.json on first launch, Claude Desktop its config.json
    cursor: !!onPath("cursor") || any(paths.cursorJson(), join(dirname(paths.cursorJson()), "argv.json")),
    "claude-desktop": any(paths.desktopJson(), join(dirname(paths.desktopJson()), "config.json")),
    // Hermes's gateway reads its config.yaml, present from first use
    hermes: !!onPath("hermes") || any(paths.hermesYaml()),
    gemini: !!onPath("gemini") || any(paths.geminiJson()),
    // VS Code writes globalStorage/storage.json on first launch
    vscode:
      !!onPath("code") || any(paths.vscodeJson(), join(dirname(paths.vscodeJson()), "globalStorage", "storage.json")),
  };
  return AGENTS.filter((a) => seen[a]);
}

/**
 * `added`: connected now. `unchanged`: already exactly this. `updated`: setup's npx entry, its pin moved
 * (`--pin`). `kept`: another api-anything entry is there, left as it is. `printed`: the config can't be
 * edited, the entry is printed for a person to add.
 */
type Status = "added" | "unchanged" | "updated" | "kept" | "would add" | "would update" | "printed" | "failed";

/** How a setup run writes: `pin` puts this version in every entry it writes. */
interface Write {
  dryRun: boolean;
  pin: boolean;
}

export interface AgentResult {
  agent: Agent;
  mcp: Status;
  /** the version the entry in the config is pinned to, when it is pinned */
  pinned?: string;
  /** how it was (or would be) added: the agent's own CLI, or an edit of its config file */
  via?: "cli" | "file";
  file: string;
  backup?: string;
  /** the existing entry, when it is kept */
  entry?: unknown;
  skill?: SkillResult["skill"];
  skillDir?: string;
  skillBackup?: string;
  skillNote?: string;
  error?: string;
}

/**
 * The entry for a GUI app (Cursor, Claude Desktop, VS Code). It starts with a minimal PATH, where npx from nvm or
 * Homebrew is not found: so the npx setup would run, by its absolute path, with node's directory on PATH
 * (npx is a node script).
 */
export function guiServer(pin = false): Entry {
  const win = process.platform === "win32";
  const npx = onPath("npx") ?? [join(dirname(process.execPath), win ? "npx.cmd" : "npx")].find((f) => existsSync(f));
  if (!npx) return serverEntry(pin);
  const nodeDir = existsSync(join(dirname(npx), win ? "node.exe" : "node")) ? dirname(npx) : dirname(process.execPath);
  return {
    command: npx,
    args: serverEntry(pin).args,
    env: { PATH: (win ? [nodeDir] : [nodeDir, "/usr/bin", "/bin"]).join(delimiter) },
  };
}

const same = (e: { command?: unknown; args?: unknown } | undefined, want: Entry = SERVER) =>
  !!e && e.command === want.command && JSON.stringify(e.args ?? []) === JSON.stringify(want.args);

/** Its pin, for a result: what the config holds. */
const pinnedOf = (e: { command?: unknown; args?: unknown } | undefined) => {
  const pin = npxEntry(e)?.pin;
  return pin ? { pinned: pin } : {};
};

type Current = { command?: unknown; args?: unknown; env?: unknown };

/**
 * What moving the pin of setup's own npx entry changes: the package argument, and PATH (the GUI entry's)
 * only when the entry has none. The command, the rest of env (API_ANYTHING_HOME, API_ANYTHING_LOCAL_ONLY)
 * and every other field are the user's: an agent's CLI, or the user, may have put them there.
 */
function repin(cur: Current, want: Entry): { args?: string[]; path?: string } {
  const args = cur.args as string[];
  const env = cur.env as Record<string, unknown> | undefined;
  return {
    ...(args[1] !== want.args[1] ? { args: args.map((a, i) => (i === 1 ? want.args[1]! : a)) } : {}),
    ...(want.env?.PATH !== undefined && (!env || typeof env !== "object" || env.PATH === undefined)
      ? { path: want.env.PATH }
      : {}),
  };
}

/**
 * What to do with the entry already in a config: leave it (`unchanged`, `kept`), or, under `--pin`, move
 * the pin of setup's own npx entry to this version (`update`). Undefined: there is none, add one.
 */
function existing(cur: Current | undefined, want: Entry, w: Write): "unchanged" | "kept" | "update" | undefined {
  if (!cur) return undefined;
  if (same(cur, want)) return "unchanged";
  if (!w.pin || !npxEntry(cur)) return "kept";
  return Object.keys(repin(cur, want)).length ? "update" : "unchanged";
}

/** The result for an entry left as it is. */
const left = (agent: Agent, file: string, cur: { command?: unknown; args?: unknown }, how: "unchanged" | "kept") => ({
  agent,
  mcp: how,
  file,
  ...pinnedOf(cur),
  ...(how === "kept" ? { entry: cur } : {}),
});

/** Copies `file` to `<file>.bak-api-anything` once: a later run keeps the copy made before api-anything's first edit. */
function backup(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const to = `${file}.bak-api-anything`;
  if (!existsSync(to)) copyFileSync(file, to);
  return to;
}

function readJsonFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file} is not a JSON object`);
  return v as Record<string, unknown>;
}

/** VS Code keeps its servers under `servers`; the others under `mcpServers`. */
const entryIn = (cfg: Record<string, unknown>, key = "mcpServers") =>
  (cfg[key] as Record<string, Current> | undefined)?.[NAME];

/** A server entry in a JSON config (Claude Code's ~/.claude.json, Cursor, Claude Desktop, Gemini CLI, VS Code). */
function jsonServer(
  agent: Agent,
  file: string,
  w: Write,
  entry: Entry & { type?: string } = serverEntry(w.pin),
  key = "mcpServers",
): AgentResult {
  const cfg = readJsonFile(file);
  const cur = entryIn(cfg, key);
  const how = existing(cur, entry, w);
  if (cur && how !== "update") return left(agent, file, cur, how!);
  if (w.dryRun) return { agent, mcp: cur ? "would update" : "would add", via: "file", file };
  const saved = backup(file);
  const servers = (cfg[key] as Record<string, unknown> | undefined) ?? {};
  mkdirSync(dirname(file), { recursive: true });
  let next: Current = entry;
  if (cur) {
    const r = repin(cur, entry);
    const env = cur.env && typeof cur.env === "object" ? (cur.env as Record<string, unknown>) : {};
    next = { ...cur, ...(r.args ? { args: r.args } : {}), ...(r.path ? { env: { ...env, PATH: r.path } } : {}) };
  }
  writeFileSync(file, `${JSON.stringify({ ...cfg, [key]: { ...servers, [NAME]: next } }, null, 2)}\n`);
  return {
    agent,
    mcp: cur ? "updated" : "added",
    via: "file",
    file,
    ...pinnedOf(next),
    ...(saved ? { backup: saved } : {}),
  };
}

/**
 * The agent's own CLI adds the entry when it is installed, else the JSON config is edited. Gemini CLI and
 * VS Code accept comments in their config, which JSON.parse refuses: the entry is then looked for in the
 * text, and only their CLI may add it.
 */
function cliOrJson(
  agent: Agent,
  file: string,
  cli: { cmd: string; args: string[] },
  entry: Entry & { type?: string },
  key: string,
  w: Write,
): AgentResult {
  let cur: { command?: unknown; args?: unknown } | undefined;
  try {
    cur = entryIn(readJsonFile(file), key);
  } catch (e) {
    if (!onPath(cli.cmd)) throw e;
    // a config with comments is only read as text: a pin in it is the user's to move
    if (readFileSync(file, "utf8").includes(`"${NAME}"`)) return { agent, mcp: "kept", file };
    return viaCli(agent, file, cli.cmd, cli.args, w);
  }
  if (!cur && onPath(cli.cmd)) return viaCli(agent, file, cli.cmd, cli.args, w);
  return jsonServer(agent, file, w, entry, key);
}

/** Runs an agent's own `mcp add`, after backing up the file it edits. */
function viaCli(agent: Agent, file: string, cmd: string, args: string[], w: Write): AgentResult {
  if (w.dryRun) return { agent, mcp: "would add", via: "cli", file };
  const saved = backup(file);
  try {
    execFileSync(cmd, args, { stdio: "pipe", timeout: 30_000 });
    return {
      agent,
      mcp: "added",
      via: "cli",
      file,
      ...(w.pin ? { pinned: VERSION } : {}),
      ...(saved ? { backup: saved } : {}),
    };
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    const why = err.stderr?.toString().trim() || err.message;
    return { agent, mcp: "failed", via: "cli", file, error: `${cmd} ${args.join(" ")}: ${why.split("\n")[0]}` };
  }
}

/** Where the body of Codex's `[mcp_servers.api-anything]` table is in config.toml, if there is one. */
function codexTable(text: string): { start: number; end: number } | undefined {
  const head = /^\s*\[mcp_servers\.(?:"api-anything"|api-anything)\]\s*$/m.exec(text);
  if (!head) return undefined;
  const start = head.index + head[0].length;
  const rest = text.slice(start);
  return { start, end: start + (/^\s*\[/m.exec(rest)?.index ?? rest.length) };
}

/** The `[mcp_servers.api-anything]` table of Codex's config.toml, if there is one. */
function codexEntry(text: string): { command?: string; args?: string[] } | undefined {
  const t = codexTable(text);
  if (!t) return undefined;
  const body = text.slice(t.start, t.end);
  const value = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, "m").exec(body)?.[1];
  const parse = (v: string | undefined) => {
    try {
      return v === undefined ? undefined : JSON.parse(v);
    } catch {
      return v;
    }
  };
  return { command: parse(value("command")), args: parse(value("args")) };
}

const tomlArgs = (args: string[]) => JSON.stringify(args).replaceAll(",", ", ");

/** Replaces the `key: value` (YAML) or `key = value` (TOML) line of each key in `body`, the rest as it was. */
const setLines = (body: string, sep: ":" | "=", values: Record<string, string>) =>
  Object.entries(values).reduce(
    (b, [k, v]) =>
      b.replace(
        new RegExp(`^([ \\t]*)${k}[ \\t]*${sep}.*$`, "m"),
        (_, indent: string) => `${indent}${k}${sep === ":" ? ":" : " ="} ${v}`,
      ),
    body,
  );

function codexServer(w: Write): AgentResult {
  const file = paths.codexToml();
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const want = serverEntry(w.pin);
  const cur = codexEntry(text);
  const how = existing(cur, want, w);
  if (cur && how !== "update") return left("codex", file, cur, how!);
  if (cur) {
    if (w.dryRun) return { agent: "codex", mcp: "would update", via: "file", file };
    const saved = backup(file);
    const t = codexTable(text)!;
    // the args line only: the command, env and every other key of the table stay
    const body = setLines(text.slice(t.start, t.end), "=", { args: tomlArgs(repin(cur, want).args!) });
    writeFileSync(file, text.slice(0, t.start) + body + text.slice(t.end));
    return {
      agent: "codex",
      mcp: "updated",
      via: "file",
      file,
      ...pinnedOf(want),
      ...(saved ? { backup: saved } : {}),
    };
  }
  if (onPath("codex")) return viaCli("codex", file, "codex", ["mcp", "add", NAME, "--", want.command, ...want.args], w);
  if (w.dryRun) return { agent: "codex", mcp: "would add", via: "file", file };
  const saved = backup(file);
  mkdirSync(dirname(file), { recursive: true });
  const table = `[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(want.command)}\nargs = ${tomlArgs(want.args)}\n`;
  writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${table}`);
  return { agent: "codex", mcp: "added", via: "file", file, ...pinnedOf(want), ...(saved ? { backup: saved } : {}) };
}

function claudeCodeServer(w: Write): AgentResult {
  const file = paths.claudeJson();
  const cur = entryIn(readJsonFile(file));
  const want = serverEntry(w.pin);
  if (!cur && onPath("claude"))
    return viaCli(
      "claude-code",
      file,
      "claude",
      ["mcp", "add", "--scope", "user", NAME, "--", want.command, ...want.args],
      w,
    );
  return jsonServer("claude-code", file, w);
}

/** Where the body of the `api-anything` entry under Hermes's top-level `mcp_servers:` is, if there is one. */
function hermesSpan(text: string): { start: number; end: number } | undefined {
  const block = /^mcp_servers\s*:/m.exec(text);
  if (!block) return undefined;
  const from = block.index + block[0].length;
  const rest = text.slice(from);
  const body = rest.slice(0, /^\S/m.exec(rest)?.index ?? rest.length);
  const head = /^ {2}(?:"api-anything"|api-anything):\s*$/m.exec(body);
  if (!head) return undefined;
  const start = from + head.index + head[0].length;
  const after = text.slice(start, from + body.length);
  return { start, end: start + (/^\S|^ {2}\S/m.exec(after)?.index ?? after.length) };
}

/** The `api-anything` entry under the top-level `mcp_servers:` of Hermes's config.yaml, if there is one. */
function hermesEntry(text: string): { command?: string; args?: unknown } | undefined {
  const span = hermesSpan(text);
  if (!span) return undefined;
  const entryBody = text.slice(span.start, span.end);
  const value = (k: string) => new RegExp(`^    ${k}:\\s*(.+?)\\s*$`, "m").exec(entryBody)?.[1];
  const parse = (v: string | undefined) => {
    const un = v?.replace(/^["']|["']$/g, "");
    if (un === undefined) return undefined;
    try {
      return JSON.parse(un);
    } catch {
      return un;
    }
  };
  // only whether env holds a PATH matters (`repin`); an inline map is not looked into, nor touched
  const env = /^ {4}env:[ \t]*(.*?)\s*$/m.exec(entryBody);
  const inline = !!env?.[1] && !env[1].startsWith("#");
  return {
    command: parse(value("command")),
    args: parse(value("args")),
    ...(env ? { env: inline || /^ {6}PATH:/m.test(entryBody) ? { PATH: "" } : {} } : {}),
  };
}

/** The entry's body with `PATH` in its env block, the block added when it has none. */
function withYamlPath(body: string, path: string): string {
  const line = `      PATH: ${JSON.stringify(path)}`;
  const env = /^ {4}env:[ \t]*(?:#.*)?$/m.exec(body);
  if (env) return `${body.slice(0, env.index + env[0].length)}\n${line}${body.slice(env.index + env[0].length)}`;
  const end = body.length - (/\s*$/.exec(body)?.[0].length ?? 0);
  return `${body.slice(0, end)}\n    env:\n${line}${body.slice(end)}`;
}

/**
 * Whether setup may add to a Hermes config's top-level `mcp_servers:`: a plain block, where nothing
 * but an optional comment follows the colon and the servers sit two spaces in. Deeper indentation or
 * an inline `{...}` is a file setup can't touch without risk; an empty block is plain.
 */
function plainServers(text: string): boolean {
  const m = /^mcp_servers\s*:([^\n]*)$/m.exec(text);
  if (!m) return true;
  if (m[1].trim() && !m[1].trim().startsWith("#")) return false;
  for (const line of text.slice(m.index + m[0].length).split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    return /^ {2}\S/.test(line);
  }
  return true;
}

/** The entry as the lines a person pastes into the plain block, the way `--print-config` prints it. */
function hermesEntryLines(e: Entry): string[] {
  const lines = [
    `  ${NAME}:`,
    "    enabled: true",
    `    command: ${JSON.stringify(e.command)}`,
    `    args: ${JSON.stringify(e.args)}`,
  ];
  if (e.env) {
    lines.push("    env:");
    for (const [k, v] of Object.entries(e.env)) lines.push(`      ${k}: ${JSON.stringify(v)}`);
  }
  return lines;
}

/**
 * Hermes launches its MCP servers from its gateway, a background process, so the entry uses npx by
 * absolute path with node's directory on PATH, like the GUI apps. Written to config.yaml rather than
 * via the hermes CLI: the gateway reads the file at startup, so editing it never touches a running
 * process.
 */
function hermesServer(w: Write): AgentResult {
  const file = paths.hermesYaml();
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const entry = guiServer(w.pin);
  const cur = hermesEntry(text);
  const how = existing(cur, entry, w);
  if (cur && how !== "update") return left("hermes", file, cur, how!);
  if (cur) {
    if (w.dryRun) return { agent: "hermes", mcp: "would update", via: "file", file };
    const saved = backup(file);
    const span = hermesSpan(text)!;
    const r = repin(cur, entry);
    let body = text.slice(span.start, span.end);
    if (r.args) body = setLines(body, ":", { args: JSON.stringify(r.args) });
    if (r.path) body = withYamlPath(body, r.path);
    writeFileSync(file, text.slice(0, span.start) + body + text.slice(span.end));
    return {
      agent: "hermes",
      mcp: "updated",
      via: "file",
      file,
      ...pinnedOf(r.args ? { ...cur, args: r.args } : cur),
      ...(saved ? { backup: saved } : {}),
    };
  }
  if (!plainServers(text))
    return { agent: "hermes", mcp: "printed", via: "file", file, entry: hermesEntryLines(entry).join("\n") };
  if (w.dryRun) return { agent: "hermes", mcp: "would add", via: "file", file };
  const saved = backup(file);
  mkdirSync(dirname(file), { recursive: true });
  const lines = hermesEntryLines(entry);
  const block = /^mcp_servers\s*:[ \t]*(?:#.*)?$/m.exec(text);
  let next: string;
  if (block) {
    const rest = text.slice(block.index + block[0].length);
    const insertAt = block.index + block[0].length + (/^\S/m.exec(rest)?.index ?? rest.length);
    const prefix = text.slice(0, insertAt);
    next = `${prefix}${prefix && !prefix.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n${text.slice(insertAt)}`;
  } else {
    next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}mcp_servers:\n${lines.join("\n")}\n`;
  }
  writeFileSync(file, next);
  return { agent: "hermes", mcp: "added", via: "file", file, ...pinnedOf(entry), ...(saved ? { backup: saved } : {}) };
}

function server(agent: Agent, w: Write): AgentResult {
  const shell = serverEntry(w.pin);
  switch (agent) {
    case "claude-code":
      return claudeCodeServer(w);
    case "codex":
      return codexServer(w);
    case "cursor":
      return jsonServer("cursor", paths.cursorJson(), w, guiServer(w.pin));
    case "claude-desktop":
      return jsonServer("claude-desktop", paths.desktopJson(), w, guiServer(w.pin));
    case "hermes":
      return hermesServer(w);
    case "gemini":
      // Gemini reads the command as a positional of its own, and what follows -- as its args
      return cliOrJson(
        "gemini",
        paths.geminiJson(),
        { cmd: "gemini", args: ["mcp", "add", "--scope", "user", NAME, shell.command, "--", ...shell.args] },
        shell,
        "mcpServers",
        w,
      );
    case "vscode": {
      const entry = { type: "stdio", ...guiServer(w.pin) };
      return cliOrJson(
        "vscode",
        paths.vscodeJson(),
        { cmd: "code", args: ["--add-mcp", JSON.stringify({ name: NAME, ...entry })] },
        entry,
        "servers",
        w,
      );
    }
  }
}

/** The server and the skill each on their own: a config that can't be edited still leaves the skill installed. */
function connect(agent: Agent, w: Write): AgentResult {
  let r: AgentResult;
  try {
    r = server(agent, w);
  } catch (e) {
    r = { agent, mcp: "failed", file: "", error: (e as Error).message.split("\n")[0] };
  }
  const dir = SKILL_DIR[agent];
  if (!dir) return r;
  try {
    return { ...r, ...installSkill(dir(), { mode: "setup", dryRun: w.dryRun }) };
  } catch (e) {
    return { ...r, skillNote: `not installed: ${(e as Error).message.split("\n")[0]}` };
  }
}

/** The config file of each agent, and the api-anything entry in it, if any. Never throws. */
function configEntry(agent: Agent): { file: string; entry?: { command?: unknown; args?: unknown } } {
  const text = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  const json = (f: string, key = "mcpServers") => {
    try {
      return entryIn(readJsonFile(f), key);
    } catch {
      return undefined;
    }
  };
  const read: Record<Agent, () => { file: string; entry?: { command?: unknown; args?: unknown } }> = {
    "claude-code": () => ({ file: paths.claudeJson(), entry: json(paths.claudeJson()) }),
    codex: () => ({ file: paths.codexToml(), entry: codexEntry(text(paths.codexToml())) }),
    cursor: () => ({ file: paths.cursorJson(), entry: json(paths.cursorJson()) }),
    "claude-desktop": () => ({ file: paths.desktopJson(), entry: json(paths.desktopJson()) }),
    hermes: () => ({ file: paths.hermesYaml(), entry: hermesEntry(text(paths.hermesYaml())) }),
    gemini: () => ({ file: paths.geminiJson(), entry: json(paths.geminiJson()) }),
    vscode: () => ({ file: paths.vscodeJson(), entry: json(paths.vscodeJson(), "servers") }),
  };
  try {
    return read[agent]();
  } catch {
    return { file: "" };
  }
}

/**
 * Each agent whose config has an api-anything entry, and the version it is pinned to: `false` for the
 * unpinned npx entry (the newest release at each start), `"custom"` for an entry setup did not write.
 */
export function configPins(): { agent: Agent; file: string; pinned: string | false | "custom" }[] {
  return AGENTS.flatMap((agent) => {
    const { file, entry } = configEntry(agent);
    if (!entry) return [];
    const npx = npxEntry(entry);
    return [{ agent, file, pinned: npx ? (npx.pin ?? false) : ("custom" as const) }];
  });
}

/**
 * Hermes runs as an always-on gateway: a browser-capable tool there is a deliberate choice, so it is
 * connected only when named (`--agents hermes`), never by Enter or `--agents all`.
 */
const ASKED_FOR: (a: Agent) => boolean = (a) => a !== "hermes";

/** `named`: --agents. `asked`: the terminal question. `would ask`: a dry run on a terminal. `none`: no terminal and no --agents. */
export type Selection = "named" | "asked" | "would ask" | "none";

export interface SetupOptions {
  /** the agents to connect; "all" is each one found but Hermes. Absent: `choose` asks, else none is. */
  agents?: (Agent | "all")[];
  /** asks which of the agents found to connect; given only when a person can answer (a TTY) */
  choose?: (offer: Agent[], o: { hermes: boolean }) => Promise<Agent[]>;
  dryRun?: boolean;
  /** the answer given by flag (--yes, --no-share) */
  share?: boolean;
  /** background verification by flag (--verify, --no-verify) */
  verify?: boolean;
  /** local-only by flag (--local-only, --no-local-only) */
  localOnly?: boolean;
  /** pin every entry written to this version (--pin) */
  pin?: boolean;
  /** asks a yes/no question with its default; given only when a person can answer (a TTY) */
  ask?: (question: string, yes: boolean) => Promise<boolean>;
}

export interface SetupResult {
  ok: boolean;
  dryRun?: true;
  /** the agents found on this machine */
  found: Agent[];
  selection: Selection;
  agents: AgentResult[];
  /** found, not connected by this run and without an entry already: why, and the command that connects it */
  notConnected: { agent: Agent; reason: string; command: string }[];
  browser: { available: boolean; name?: string; note: string };
  key: { file: string; created: boolean; publicKey?: string } | { file: string; wouldCreate: true };
  /** undefined: not asked yet (no TTY and no flag), so nothing is shared */
  share?: boolean;
  shareAsked: boolean;
  /** background verification; undefined: not asked yet, so it is off */
  verify?: boolean;
  localOnly: boolean;
  /** the version this run pins entries to (--pin) */
  pin?: string;
}

export async function setup(o: SetupOptions = {}): Promise<SetupResult> {
  const dryRun = !!o.dryRun;
  const w: Write = { dryRun, pin: !!o.pin };
  const found = detect();
  const offer = found.filter(ASKED_FOR);
  let selection: Selection;
  let chosen: Agent[];
  if (o.agents) {
    selection = "named";
    chosen = [...new Set(o.agents.flatMap((a) => (a === "all" ? offer : [a])))];
  } else if (o.choose && offer.length) {
    selection = dryRun ? "would ask" : "asked";
    // a dry run reports what each would get if chosen, and asks nothing
    chosen = dryRun ? offer : await o.choose(offer, { hermes: found.includes("hermes") });
  } else {
    selection = o.choose ? "asked" : "none";
    chosen = [];
  }
  const agents = chosen.map((a) => connect(a, w));
  const notConnected = found
    .filter((a) => !chosen.includes(a) && !configEntry(a).entry)
    .map((agent) => ({
      agent,
      reason: !ASKED_FOR(agent)
        ? "found, not connected (always-on gateway)"
        : selection === "none"
          ? "found, not connected: no terminal to ask"
          : "found, not chosen",
      command: `api-anything setup --agents ${agent}${w.pin ? " --pin" : ""}`,
    }));
  const skills = agents.flatMap((a) =>
    a.skillDir && (a.skill === "installed" || a.skill === "updated" || a.skill === "unchanged") ? [a.skillDir] : [],
  );
  if (!dryRun && skills.length) recordSkillDirs(skills);

  const b = browserChoice();
  const browser = {
    available: !!b,
    ...(b ? { name: b.name } : {}),
    note: "a Chromium browser is needed only to learn sites; calls to shared operations work without one",
  };

  const hadKey = existsSync(keyFile());
  const key: SetupResult["key"] = dryRun
    ? hadKey
      ? { file: keyFile(), created: false }
      : { file: keyFile(), wouldCreate: true }
    : { file: keyFile(), created: !hadKey, publicKey: ensureKey().publicKey };

  if (o.localOnly !== undefined && !dryRun) setLocalOnly(o.localOnly);
  // with nothing going to the catalog, there is nothing to ask about
  const offline = o.localOnly ?? localOnly();
  const answers = await record({ share: o.share, verify: o.verify }, { dryRun, ask: offline ? undefined : o.ask });

  return {
    ok: agents.every((a) => a.mcp !== "failed"),
    ...(dryRun ? { dryRun: true as const } : {}),
    found,
    selection,
    agents,
    notConnected,
    browser,
    key,
    ...answers,
    localOnly: offline,
    ...(w.pin ? { pin: VERSION } : {}),
  };
}

/**
 * Records the answers given by flag, and asks the ones not answered yet when a person can answer:
 * sharing (default yes), then, only after a yes, background verification (default no).
 */
export async function record(
  given: { share?: boolean; verify?: boolean },
  o: { dryRun?: boolean; ask?: SetupOptions["ask"] } = {},
): Promise<{ share?: boolean; shareAsked: boolean; verify?: boolean }> {
  const before = loadSettings();
  const ask = o.dryRun ? undefined : o.ask;
  let share = given.share;
  if (share === undefined && !before.askedAt && ask) share = await ask(QUESTION, true);
  if (share !== undefined && !o.dryRun) answerShare(share);
  const shareNow = share ?? (before.askedAt ? before.share : undefined);
  let verify = given.verify;
  if (verify === undefined && shareNow === true && !before.verifyAskedAt && ask)
    verify = await ask(VERIFY_QUESTION, false);
  if (verify !== undefined && !o.dryRun) answerVerify(verify);
  const verifyNow = shareNow === false ? false : (verify ?? (before.verifyAskedAt ? loadSettings().verify : undefined));
  return {
    ...(shareNow !== undefined ? { share: shareNow } : {}),
    shareAsked: shareNow !== undefined,
    ...(verifyNow !== undefined ? { verify: verifyNow } : {}),
  };
}

/** A yes/no on the terminal: Enter is `yes`, the default the question shows. */
export async function askYesNo(question: string, yes = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = (await rl.question(`${question} ${yes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    return a === "" ? yes : a === "y" || a === "yes";
  } catch {
    return false; // the input closed: no answer is a no
  } finally {
    rl.close();
  }
}

/**
 * The agent picks of a typed answer, or undefined when it is none of: Enter (all of `offer`), numbers
 * like `1,3` or `1 3`, `n` (none).
 */
export function pickAgents(answer: string, offer: Agent[]): Agent[] | undefined {
  const a = answer.trim().toLowerCase();
  if (a === "" || a === "all") return offer;
  if (/^(n|no|none)$/.test(a)) return [];
  const nums = a
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (!nums.length || nums.some((n) => !Number.isInteger(n) || n < 1 || n > offer.length)) return undefined;
  return offer.filter((_, i) => nums.includes(i + 1));
}

const HERMES_NOTE = "Hermes: found, not connected (always-on gateway): add with --agents hermes";

/** Asks on the terminal which of the agents found to connect, once. */
export async function askAgents(offer: Agent[], o: { hermes: boolean }): Promise<Agent[]> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const list = offer.map((a, i) => `${i + 1}) ${LABEL[a]}`).join(" ");
  try {
    if (o.hermes) process.stderr.write(`${HERMES_NOTE}\n`);
    for (;;) {
      const picked = pickAgents(
        await rl.question(`Connect API Anything to: ${list} [Enter = all, numbers like 1,3, n = none] `),
        offer,
      );
      if (picked) return picked;
      process.stderr.write(`Type numbers from 1 to ${offer.length} (like 1,3), Enter for all, or n for none.\n`);
    }
  } catch {
    return []; // the input closed: nothing is connected
  } finally {
    rl.close();
  }
}

/** What setup did, for a person: one line per agent, then what to ask first. */
const SKILL_DONE = {
  installed: "installed",
  updated: "updated",
  kept: "left as it is",
  "would install": "would be installed",
  "would update": "would be updated",
} as const;

/** Sharing, verification and local-only, as the summary says them, each plainly on or off. */
export function answersSummary(r: { dryRun?: true; share?: boolean; verify?: boolean; localOnly: boolean }): string[] {
  const would = r.dryRun ? "would be " : "";
  if (r.localOnly)
    return [
      `Local-only: ${would}on. Nothing is sent to the shared catalog: no sharing, no reports, no verification, and searches look at this machine only. Turn it off with: api-anything setup --no-local-only --share-only`,
    ];
  const share =
    r.share === undefined
      ? r.dryRun
        ? "Sharing: would be asked on a terminal (Enter = yes); --yes or --no-share answers it"
        : "Sharing: not asked yet, so nothing is shared; your agent asks the first time it learns something to share. Answer now with: api-anything setup --yes --share-only (or --no-share --share-only)"
      : `Sharing: ${would}${r.share ? "on. Your agent shares operations it learns from public pages and reports whether calls work; never your cookies or logins. Turn it off with: api-anything setup --no-share --share-only" : "off. Nothing is shared or reported. Turn it on with: api-anything setup --yes --share-only"}`;
  const verify = !r.share
    ? "Background verification: off (it needs sharing on)"
    : r.verify === undefined
      ? r.dryRun
        ? "Background verification: would be asked on a terminal after a yes to sharing (Enter = no); --verify or --no-verify answers it"
        : "Background verification: off, not asked. Turn it on with: api-anything setup --verify --share-only"
      : `Background verification: ${would}${r.verify ? "on. An idle server tests up to 20 new shared operations a day from your network, with no cookies, on public https hosts only. Turn it off with: api-anything setup --no-verify --share-only" : "off. Turn it on with: api-anything setup --verify --share-only"}`;
  return [share, verify, "Site searches go to the shared catalog; api-anything setup --local-only stops that too"];
}

export function summary(r: SetupResult): string {
  const lines = r.agents.map((a) => {
    const pin = a.pinned ? ` (pinned to api-anything@${a.pinned})` : "";
    const what =
      a.mcp === "added"
        ? `connected${pin}`
        : a.mcp === "would add"
          ? `would be connected${r.pin ? ` (pinned to api-anything@${r.pin})` : ""}`
          : a.mcp === "updated"
            ? `pin moved${pin}`
            : a.mcp === "would update"
              ? `pin would move to api-anything@${r.pin}`
              : a.mcp === "unchanged"
                ? `already connected${pin}`
                : a.mcp === "kept"
                  ? `has another api-anything entry, left as it is${pin}`
                  : a.mcp === "printed"
                    ? `left as it is (its mcp_servers is not a plain 2-space block); add by hand:\n${String(
                        a.entry ?? "",
                      )
                        .split("\n")
                        .map((l) => `        ${l}`)
                        .join("\n")}`
                    : `not connected: ${a.error}`;
    const skill =
      a.skill && a.skill !== "unchanged"
        ? `; skill ${SKILL_DONE[a.skill]}${a.skillNote ? ` (${a.skillNote})` : ""}`
        : a.skillNote
          ? `; skill ${a.skillNote}`
          : "";
    return `  ${LABEL[a.agent]}: ${what}${skill}${a.backup ? ` (backup: ${a.backup})` : ""}`;
  });
  if (r.selection === "would ask")
    lines.unshift(
      `  Would ask which to connect (Enter = all of ${r.agents.map((a) => LABEL[a.agent]).join(", ")}); each one, if chosen:`,
    );
  for (const n of r.notConnected)
    lines.push(
      n.agent === "hermes"
        ? `  ${HERMES_NOTE}`
        : `  ${LABEL[n.agent]}: ${n.reason.replace(/^found, /, "")}; connect it with: ${n.command}`,
    );
  if (!r.found.length && !r.agents.length)
    lines.push(`  No agent found. Name one: api-anything setup --agents ${AGENTS.join(",")}`);
  else if (!lines.length) lines.push("  No agent connected.");
  return [
    `api-anything setup${r.dryRun ? " (dry run: nothing was changed)" : ""}`,
    ...lines,
    `  Browser: ${r.browser.available ? `${r.browser.name} found` : "none found; install Chrome, Brave, Edge or Chromium to learn new sites"} (needed only to learn sites)`,
    ...answersSummary(r).map((l) => `  ${l}`),
    "",
    r.agents.some((a) => ["added", "would add", "updated", "would update"].includes(a.mcp))
      ? 'Restart your agent, then ask it: "What does Goodreads rate Piranesi?"'
      : 'Ask your agent: "What does Goodreads rate Piranesi?"',
  ].join("\n");
}
