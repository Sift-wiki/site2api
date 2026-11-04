/**
 * `api-anything setup`: connect the MCP server to each agent on this machine (and the skill where the
 * agent takes skills), check for a browser, make the install's key, and ask the one question
 * (docs/REGISTRY.md, "Setup"). Other entries in an agent's config are never changed: a file is backed up
 * before it is edited, and an api-anything entry that is already there is left as it is.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { browserChoice } from "./browser.js";
import { answerShare, ensureKey, keyFile, loadSettings, QUESTION } from "./identity.js";
import { installSkill, recordSkillDirs, type SkillResult, skillDirs } from "./skill.js";

export interface Entry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
/** The entry for agents that start from the user's shell (Claude Code, Codex) and so find npx on PATH. */
export const SERVER: Entry = { command: "npx", args: ["-y", "api-anything", "mcp"] };
const NAME = "api-anything";

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

/** `added`: connected now. `unchanged`: already exactly this. `kept`: another api-anything entry is there, left as it is. `printed`: the config can't be edited, the entry is printed for a person to add. */
type Status = "added" | "unchanged" | "kept" | "would add" | "printed" | "failed";

export interface AgentResult {
  agent: Agent;
  mcp: Status;
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
export function guiServer(): Entry {
  const win = process.platform === "win32";
  const npx = onPath("npx") ?? [join(dirname(process.execPath), win ? "npx.cmd" : "npx")].find((f) => existsSync(f));
  if (!npx) return SERVER;
  const nodeDir = existsSync(join(dirname(npx), win ? "node.exe" : "node")) ? dirname(npx) : dirname(process.execPath);
  return {
    command: npx,
    args: SERVER.args,
    env: { PATH: (win ? [nodeDir] : [nodeDir, "/usr/bin", "/bin"]).join(delimiter) },
  };
}

const same = (e: { command?: unknown; args?: unknown } | undefined, want: Entry = SERVER) =>
  !!e && e.command === want.command && JSON.stringify(e.args ?? []) === JSON.stringify(want.args);

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
  (cfg[key] as Record<string, { command?: unknown; args?: unknown }> | undefined)?.[NAME];

/** A server entry in a JSON config (Claude Code's ~/.claude.json, Cursor, Claude Desktop, Gemini CLI, VS Code). */
function jsonServer(
  agent: Agent,
  file: string,
  dryRun: boolean,
  entry: Entry & { type?: string } = SERVER,
  key = "mcpServers",
): AgentResult {
  const cfg = readJsonFile(file);
  const cur = entryIn(cfg, key);
  if (cur)
    return { agent, mcp: same(cur, entry) ? "unchanged" : "kept", file, ...(same(cur, entry) ? {} : { entry: cur }) };
  if (dryRun) return { agent, mcp: "would add", via: "file", file };
  const saved = backup(file);
  const servers = (cfg[key] as Record<string, unknown> | undefined) ?? {};
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...cfg, [key]: { ...servers, [NAME]: entry } }, null, 2)}\n`);
  return { agent, mcp: "added", via: "file", file, ...(saved ? { backup: saved } : {}) };
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
  dryRun: boolean,
): AgentResult {
  let cur: { command?: unknown; args?: unknown } | undefined;
  try {
    cur = entryIn(readJsonFile(file), key);
  } catch (e) {
    if (!onPath(cli.cmd)) throw e;
    if (readFileSync(file, "utf8").includes(`"${NAME}"`)) return { agent, mcp: "kept", file };
    return viaCli(agent, file, cli.cmd, cli.args, dryRun);
  }
  if (!cur && onPath(cli.cmd)) return viaCli(agent, file, cli.cmd, cli.args, dryRun);
  return jsonServer(agent, file, dryRun, entry, key);
}

/** Runs an agent's own `mcp add`, after backing up the file it edits. */
function viaCli(agent: Agent, file: string, cmd: string, args: string[], dryRun: boolean): AgentResult {
  if (dryRun) return { agent, mcp: "would add", via: "cli", file };
  const saved = backup(file);
  try {
    execFileSync(cmd, args, { stdio: "pipe", timeout: 30_000 });
    return { agent, mcp: "added", via: "cli", file, ...(saved ? { backup: saved } : {}) };
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    const why = err.stderr?.toString().trim() || err.message;
    return { agent, mcp: "failed", via: "cli", file, error: `${cmd} ${args.join(" ")}: ${why.split("\n")[0]}` };
  }
}

/** The `[mcp_servers.api-anything]` table of Codex's config.toml, if there is one. */
function codexEntry(text: string): { command?: string; args?: string[] } | undefined {
  const head = /^\s*\[mcp_servers\.(?:"api-anything"|api-anything)\]\s*$/m.exec(text);
  if (!head) return undefined;
  const rest = text.slice(head.index + head[0].length);
  const body = rest.slice(0, /^\s*\[/m.exec(rest)?.index ?? rest.length);
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

function codexServer(dryRun: boolean): AgentResult {
  const file = paths.codexToml();
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const cur = codexEntry(text);
  if (cur) return { agent: "codex", mcp: same(cur) ? "unchanged" : "kept", file, ...(same(cur) ? {} : { entry: cur }) };
  if (onPath("codex"))
    return viaCli("codex", file, "codex", ["mcp", "add", NAME, "--", SERVER.command, ...SERVER.args], dryRun);
  if (dryRun) return { agent: "codex", mcp: "would add", via: "file", file };
  const saved = backup(file);
  mkdirSync(dirname(file), { recursive: true });
  const table = `[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(SERVER.command)}\nargs = ${JSON.stringify(SERVER.args).replaceAll(",", ", ")}\n`;
  writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${table}`);
  return { agent: "codex", mcp: "added", via: "file", file, ...(saved ? { backup: saved } : {}) };
}

function claudeCodeServer(dryRun: boolean): AgentResult {
  const file = paths.claudeJson();
  const cur = entryIn(readJsonFile(file));
  if (!cur && onPath("claude"))
    return viaCli(
      "claude-code",
      file,
      "claude",
      ["mcp", "add", "--scope", "user", NAME, "--", SERVER.command, ...SERVER.args],
      dryRun,
    );
  return jsonServer("claude-code", file, dryRun);
}

/** The `api-anything` entry under the top-level `mcp_servers:` of Hermes's config.yaml, if there is one. */
function hermesEntry(text: string): { command?: string; args?: unknown } | undefined {
  const block = /^mcp_servers\s*:/m.exec(text);
  if (!block) return undefined;
  const rest = text.slice(block.index + block[0].length);
  const body = rest.slice(0, /^\S/m.exec(rest)?.index ?? rest.length);
  const head = /^ {2}(?:"api-anything"|api-anything):\s*$/m.exec(body);
  if (!head) return undefined;
  const after = body.slice(head.index + head[0].length);
  const entryBody = after.slice(0, /^\S|^ {2}\S/m.exec(after)?.index ?? after.length);
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
  return { command: parse(value("command")), args: parse(value("args")) };
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
function hermesServer(dryRun: boolean): AgentResult {
  const file = paths.hermesYaml();
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const entry = guiServer();
  const cur = hermesEntry(text);
  if (cur)
    return {
      agent: "hermes",
      mcp: same(cur, entry) ? "unchanged" : "kept",
      file,
      ...(same(cur, entry) ? {} : { entry: cur }),
    };
  if (!plainServers(text))
    return { agent: "hermes", mcp: "printed", via: "file", file, entry: hermesEntryLines(entry).join("\n") };
  if (dryRun) return { agent: "hermes", mcp: "would add", via: "file", file };
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
  return { agent: "hermes", mcp: "added", via: "file", file, ...(saved ? { backup: saved } : {}) };
}

function server(agent: Agent, dryRun: boolean): AgentResult {
  switch (agent) {
    case "claude-code":
      return claudeCodeServer(dryRun);
    case "codex":
      return codexServer(dryRun);
    case "cursor":
      return jsonServer("cursor", paths.cursorJson(), dryRun, guiServer());
    case "claude-desktop":
      return jsonServer("claude-desktop", paths.desktopJson(), dryRun, guiServer());
    case "hermes":
      return hermesServer(dryRun);
    case "gemini":
      // Gemini reads the command as a positional of its own, and what follows -- as its args
      return cliOrJson(
        "gemini",
        paths.geminiJson(),
        { cmd: "gemini", args: ["mcp", "add", "--scope", "user", NAME, SERVER.command, "--", ...SERVER.args] },
        SERVER,
        "mcpServers",
        dryRun,
      );
    case "vscode": {
      const entry = { type: "stdio", ...guiServer() };
      return cliOrJson(
        "vscode",
        paths.vscodeJson(),
        { cmd: "code", args: ["--add-mcp", JSON.stringify({ name: NAME, ...entry })] },
        entry,
        "servers",
        dryRun,
      );
    }
  }
}

/** The server and the skill each on their own: a config that can't be edited still leaves the skill installed. */
function connect(agent: Agent, dryRun: boolean): AgentResult {
  let r: AgentResult;
  try {
    r = server(agent, dryRun);
  } catch (e) {
    r = { agent, mcp: "failed", file: "", error: (e as Error).message.split("\n")[0] };
  }
  const dir = SKILL_DIR[agent];
  if (!dir) return r;
  try {
    return { ...r, ...installSkill(dir(), { mode: "setup", dryRun }) };
  } catch (e) {
    return { ...r, skillNote: `not installed: ${(e as Error).message.split("\n")[0]}` };
  }
}

export interface SetupOptions {
  /** the agents to connect; default: every one found on this machine */
  agents?: Agent[];
  dryRun?: boolean;
  /** the answer given by flag (--yes, --no-share) */
  share?: boolean;
  /** asks the question; given only when a person can answer (a TTY) */
  ask?: (question: string) => Promise<boolean>;
}

export interface SetupResult {
  ok: boolean;
  dryRun?: true;
  agents: AgentResult[];
  browser: { available: boolean; name?: string; note: string };
  key: { file: string; created: boolean; publicKey?: string } | { file: string; wouldCreate: true };
  /** undefined: not asked yet (no TTY and no flag), so nothing is shared */
  share?: boolean;
  shareAsked: boolean;
}

export async function setup(o: SetupOptions = {}): Promise<SetupResult> {
  const dryRun = !!o.dryRun;
  const agents = (o.agents ?? detect()).map((a) => connect(a, dryRun));
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

  const before = loadSettings();
  let share = o.share;
  if (share === undefined && !before.askedAt && o.ask && !dryRun) share = await o.ask(QUESTION);
  if (share !== undefined && !dryRun) answerShare(share);
  const answer = share ?? (before.askedAt ? before.share : undefined);

  return {
    ok: agents.every((a) => a.mcp !== "failed"),
    ...(dryRun ? { dryRun: true as const } : {}),
    agents,
    browser,
    key,
    ...(answer !== undefined ? { share: answer } : {}),
    shareAsked: answer !== undefined,
  };
}

/** A yes/no on the terminal, default yes. */
export async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return a === "" || a === "y" || a === "yes";
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

export function summary(r: SetupResult): string {
  const lines = r.agents.map((a) => {
    const what =
      a.mcp === "added"
        ? "connected"
        : a.mcp === "would add"
          ? "would be connected"
          : a.mcp === "unchanged"
            ? "already connected"
            : a.mcp === "kept"
              ? "has another api-anything entry, left as it is"
              : a.mcp === "printed"
                ? `left as it is (its mcp_servers is not a plain 2-space block); add by hand:\n${String(a.entry ?? "")
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
  if (!lines.length) lines.push(`  No agent found. Name one: api-anything setup --agents ${AGENTS.join(",")}`);
  const share =
    r.share === undefined
      ? r.dryRun
        ? "Sharing: would be asked on a terminal (default yes); --yes or --no-share answers it"
        : "Sharing: not asked yet, so nothing is shared; your agent asks the first time it learns something to share. Answer now with: api-anything setup --yes (or --no-share)"
      : `Sharing: ${r.dryRun ? "would be " : ""}${r.share ? "on. Your agent shares operations it learns from public pages, reports whether calls work, and tests a few new operations a day; never your cookies or logins." : "off."}`;
  return [
    `api-anything setup${r.dryRun ? " (dry run: nothing was changed)" : ""}`,
    ...lines,
    `  Browser: ${r.browser.available ? `${r.browser.name} found` : "none found; install Chrome, Brave, Edge or Chromium to learn new sites"} (needed only to learn sites)`,
    `  ${share}`,
    "",
    r.agents.some((a) => a.mcp === "added" || a.mcp === "would add")
      ? 'Restart your agent, then ask it: "What does Goodreads rate Piranesi?"'
      : 'Ask your agent: "What does Goodreads rate Piranesi?"',
  ].join("\n");
}
