/**
 * `api-anything mcp --print-config`: how each MCP client adds this server. Absolute paths to node
 * and the CLI entry: a client started from the Dock or a menu does not get the shell's PATH, so a
 * bare `api-anything` (or an nvm node) is not found there.
 */

export interface Launch {
  /** absolute path of the node binary */
  command: string;
  args: string[];
  /** API_ANYTHING_* settings of this shell, which a client started elsewhere would not pass on */
  env: Record<string, string>;
}

/** The server's launch from where this CLI runs: the built entry, or the source through tsx's loader. */
export function launchOf(entry: string, flags: string[], env: NodeJS.ProcessEnv = process.env): Launch {
  const viaTsx = entry.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
  const own = Object.entries(env).filter(
    (e): e is [string, string] => /^API_ANYTHING_(HOME|BROWSER)$/.test(e[0]) && !!e[1],
  );
  return { command: process.execPath, args: [...viaTsx, entry, "mcp", ...flags], env: Object.fromEntries(own) };
}

const DOCS = "https://github.com/goodnight000/api-anything/blob/main/docs/QUICKSTART.md#connect-an-agent";

/** One shell word: quoted unless it is plainly safe. */
const sh = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/** The add command or config entry for each client, as text to copy. */
export function printConfig(l: Launch, name = "api-anything"): string {
  const words = [l.command, ...l.args].map(sh).join(" ");
  const args = l.args.map(sh).join(" ");
  const envFlags = (flag: string) =>
    Object.entries(l.env)
      .map(([k, v]) => `${flag} ${sh(`${k}=${v}`)} `)
      .join("");
  const entry = { command: l.command, args: l.args, ...(Object.keys(l.env).length ? { env: l.env } : {}) };
  const json = (v: unknown) => JSON.stringify(v, null, 2).replace(/\n/g, "\n  ");
  const servers = json({ mcpServers: { [name]: entry } });
  return [
    `The ${name} MCP server, with absolute paths (a client started from the Dock or a menu may not get your shell's PATH):`,
    `  ${words}`,
    "",
    "Claude Code:",
    `  claude mcp add --scope user ${envFlags("-e")}${name} -- ${words}`,
    "Codex (an older Codex stops a tool call at 60 s: tool_timeout_sec in ~/.codex/config.toml raises it):",
    `  codex mcp add ${name} ${envFlags("--env")}-- ${words}`,
    // Gemini reads the command as a positional of its own, and what follows -- as its args, never as Gemini's flags
    "Gemini CLI:",
    `  gemini mcp add --scope user ${envFlags("-e")}${name} ${sh(l.command)} -- ${args}`,
    "VS Code:",
    `  code --add-mcp ${sh(JSON.stringify({ name, type: "stdio", ...entry }))}`,
    "Cursor: merge into ~/.cursor/mcp.json (or .cursor/mcp.json in a project):",
    `  ${servers}`,
    "Claude Desktop: merge into ~/Library/Application Support/Claude/claude_desktop_config.json (Windows: %APPDATA%\\Claude\\claude_desktop_config.json):",
    `  ${servers}`,
    "Hermes (merge into the top-level mcp_servers block of its config.yaml, in ~/.hermes or $HERMES_HOME):",
    `  mcp_servers:`,
    `    ${name}:`,
    `      enabled: true`,
    `      command: ${JSON.stringify(l.command)}`,
    `      args: [${l.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    ...(Object.keys(l.env).length
      ? [`      env:`, ...Object.entries(l.env).map(([k, v]) => `        ${k}: ${JSON.stringify(v)}`)]
      : []),
    "",
    `Restart the client afterwards. Timeouts per client, and fixes for common problems: ${DOCS}`,
  ].join("\n");
}
