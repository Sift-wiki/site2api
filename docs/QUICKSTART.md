# Setup and demos

Use Node 22.13 or newer. A Chromium browser is needed to learn operations and for the browser
tier: Google Chrome by default, or Brave, Microsoft Edge, Chromium, Vivaldi, Arc. Any Chromium
executable works, and a non-default one is named with `API_ANYTHING_BROWSER` (a name like `brave`,
or the path). Calling shared operations over plain HTTP needs no browser. There is no API Anything
account and no model key: your agent supplies the reasoning when it learns an operation.

## Setup

```sh
npx -y api-anything setup
```

Setup connects the MCP server, `{"command":"npx","args":["-y","api-anything","mcp"]}`, to each agent
it finds:

| agent | how | skill |
|---|---|---|
| Claude Code | `claude mcp add --scope user api-anything -- npx -y api-anything mcp`, else `~/.claude.json` `mcpServers` | `~/.claude/skills/api-anything/` |
| Codex | `codex mcp add api-anything -- npx -y api-anything mcp`, else `~/.codex/config.toml` `[mcp_servers.api-anything]` | `~/.agents/skills/api-anything/` |
| Cursor | `~/.cursor/mcp.json` `mcpServers` | `~/.agents/skills/api-anything/` |
| Claude Desktop | `claude_desktop_config.json` `mcpServers` (macOS: `~/Library/Application Support/Claude/`, Linux: `~/.config/Claude/`, Windows: `%APPDATA%\Claude\`) | none: it takes skills only as an upload in its settings |
| Hermes | its home's `config.yaml`, the top-level `mcp_servers` block (home: `$HERMES_HOME`, else `~/.hermes`); edited only in the plain 2-space form, else the entry is printed to add by hand | `~/.hermes/skills/api-anything/` |
| Gemini CLI | `gemini mcp add --scope user api-anything npx -- -y api-anything mcp`, else `~/.gemini/settings.json` `mcpServers` | `~/.agents/skills/api-anything/` |
| VS Code | `code --add-mcp '{...}'`, else the user `mcp.json` `servers` (macOS: `~/Library/Application Support/Code/User/`, Linux: `~/.config/Code/User/`, Windows: `%APPDATA%\Code\User\`) | `~/.agents/skills/api-anything/` |

Cursor, Claude Desktop and VS Code are apps that start with a minimal PATH, where an `npx` from nvm
or Homebrew is not found. For those, the entry names npx by its absolute path (the one on setup's
PATH, else the one beside the node running setup) and sets `"env": {"PATH": "<node's directory>:/usr/bin:/bin"}`
so npx finds node. After a Node upgrade that moves npx, delete that entry and run setup again.

The skill is a folder: a short `SKILL.md` the agent loads when a request is about a website, and two
references it reads only when it needs them (turning a site into an API with the CLI, and writes).
The server's own instructions carry the same rules in brief, for a client that loads no skill.

- An `api-anything` entry that is already there is left as it is, even when it differs (an older
  `api-anything mcp` entry, or one with `--allow-writes`). Other entries are never changed.
- A config file is copied to `<file>.bak-api-anything` before api-anything first edits it. A copy of
  the skill that was edited, or predates this, is backed up to `~/.api-anything/skill-backups/`,
  then replaced.
- The server runs through `npx -y api-anything`, so it is always the latest release. Whenever the
  CLI or the server starts, it replaces a skill copy setup installed that an older version wrote and
  nobody edited since (each copy carries a stamp, `.api-anything.json`). An edited copy, a link, or
  a copy from a newer version is left alone.
- It checks for a Chromium browser, makes this install's key (`~/.api-anything/key.json`, mode 0600),
  and asks whether to help build the shared catalog. The answer is kept in
  `~/.api-anything/settings.json`; until it is given, nothing is shared or reported. Without setup
  (the plugin, or `mcp add` by hand), the agent's `learn_site` asks the same question once, the first
  time it learns something it could share.

Flags:

| flag | does |
|---|---|
| `--dry-run` | prints what would change, and changes nothing |
| `--yes` | answers the question yes without asking |
| `--no-share` | answers it no |
| `--share-only` | with `--yes` or `--no-share`: records the answer and changes nothing else (the way to turn sharing on or off later) |
| `--agents claude-code,codex,cursor,claude-desktop,hermes,gemini,vscode` | connects these agents only, found or not |

Without a terminal (an agent running it) and without `--yes` or `--no-share`, the question is not
asked and nothing is shared. Running setup again changes only what is missing.

Restart the agent, then check it:

```sh
npx -y api-anything call hacker-news search query=sqlite
```

The call should return `ok: true`, `tier: 1`, and a list of stories. It needs no account and no
browser. `ok: false` carries a class, a reason and a next step, and the CLI exits nonzero.

Then ask the agent something like "What does Goodreads rate Piranesi?". It should call
`find_sites`, then `call_operation`. For a site nobody shared, it calls `learn_site`.

To run from a checkout instead: `npm ci`, then `npm run cli -- <command>` (for example
`npm run cli -- call hacker-news search query=sqlite`). An MCP client can run the checkout with
`{"command":"npx","args":["tsx","<checkout>/src/cli.ts","mcp"]}`.

## The tools an agent gets

| tool | does |
|---|---|
| `find_sites` | searches the shared catalog and this machine's sites by words, a domain or a URL |
| `list_operations` | an operation's params and returned fields, and the site's notes; fetches a shared site on first use |
| `call_operation` | calls a read; fetches a shared site on first use |
| `call_batch` | up to 20 reads of installed sites, in order |
| `call_write_operation` | calls a write; only on a server started with `--allow-writes` |
| `get_job` | the result of a call still running after about 25 s |
| `get_result` | the rest of a cut answer, from this machine |
| `site_status` | this machine's record of a site's calls, heals and cool-downs |
| `learn_site` | learns, proves and shares a read nobody shared yet, and answers the user's request |
| `list_sites`, `login` | what is installed; refresh a session the user imported |

`api-anything mcp --no-learn` hides `learn_site`. An MCP client without a shell can call and learn
reads; learning a write needs the CLI (`add --write`), run by an agent with a shell or by the user.

## Learning an operation

`learn_site` (CLI: `api-anything learn`) takes:

- `trigger`: the page URL with `{param}` placeholders, such as `https://site.com/search?q={q}`;
- `args`: the user's own values. Their answer comes back in `data`;
- `args2` and `args3`: two other real values of the same kind, chosen by the agent. `args2` becomes
  the operation's shared example; `args3` is a holdout call, kept as the operation's check;
- optionally `site`, `op`, `intent` (what the operation is for, shared as its description), and the
  agent's own choice of request and recipe: `pickRequest`, `extract`, `pick`, `html`, `embedded`.

It loads the page with `args` and with `args2` and picks the request that carries the values, with
the fields from an outline of its answer. It saves the operation with `args2` as its example, calls
it with `args3`, and replays it once with no cookies. The result has `data`, the operation's
`signature`, the `chosen` request and recipe with `alternatives`, the `proof`, and what was `shared`.
When the pick is wrong, call it again with the result's `captures` (no browser) and a
`pickRequest` or a recipe.

```sh
api-anything learn 'https://lobste.rs/domains/{domain}' \
  --args domain=github.com --args2 domain=arxiv.org --args3 domain=youtube.com
```

## Other clients and flags

`setup` covers Claude Code, Codex, Cursor, Claude Desktop, Hermes, Gemini CLI and VS Code. For any
other client, or when a client can't find `api-anything` or `node`, print its entry with absolute
paths:

```sh
api-anything mcp --print-config
```

It prints the add command for Claude Code, Codex, Gemini CLI and VS Code, the JSON entry for Cursor
and Claude Desktop, and the mcp_servers entry for Hermes, all pointing at the absolute path of the
`node` you ran it with and of the installed CLI. Pass the flags you want served (`--allow-writes`,
`--sites goodreads`) and it adds them. A client started from the Dock or a menu may not get your
shell's `PATH`, so a bare `api-anything`, or a `node` installed with nvm, is not found there.
`API_ANYTHING_HOME` and `API_ANYTHING_BROWSER` are copied into the entry when you have them set.

In Claude Code, the repository also installs as a plugin (the MCP server and the skill, without
setup's other steps): `/plugin marketplace add goodnight000/api-anything`, then
`/plugin install api-anything@api-anything`. For the Vercel AI SDK, LangChain.js, the OpenAI Agents
SDK and other frameworks, see [INTEGRATIONS.md](INTEGRATIONS.md).

`api-anything mcp --sites goodreads,hacker-news` also serves each operation of those sites as a tool
of its own (`goodreads__searchBooks`), with its arguments' schema, so the agent skips
`list_operations`. Each one adds to the tool list the client sends with every request, so name only
the sites you use.

### Client timeouts

A call over plain HTTP takes well under a second. A call that repairs itself or runs the page in the
browser can take minutes, and so can a sign-in window. So any tool call still running after about
25 seconds answers `class: "pending"` with a `job`, and `get_job` waits up to 25 seconds more for
it, so no call outlasts a 60-second client limit. The server never needs a tool timeout above 60
seconds. A cold start through `npx` downloads the package, which can outlast a short startup
timeout.

"From docs" means the client's own documentation; "from source" means its source code; "reported"
means an issue or forum post only. Checked in October 2026.

| client | startup timeout | tool-call timeout | how to raise them | |
|---|---|---|---|---|
| Claude Code | 30 s | about 28 hours; calls move to the background after 2 minutes | `MCP_TIMEOUT` and `MCP_TOOL_TIMEOUT` (ms) in the environment, or `"timeout"` on the server in `.mcp.json` | from [docs](https://code.claude.com/docs/en/mcp) |
| Codex (CLI and IDE) | 30 s (10 s in older builds and the docs) | 300 s (60 s in older builds and the docs) | `startup_timeout_sec`, `tool_timeout_sec` under `[mcp_servers.api-anything]` in `~/.codex/config.toml` | from [docs](https://learn.chatgpt.com/docs/extend/mcp) and source |
| Gemini CLI | 600 s, one setting for both | 600 s | `"timeout"` (ms) on the server in `settings.json`, or `gemini mcp add --timeout` | from docs and source |
| VS Code | none found | none found | none | from source |
| Cursor | not documented | not documented | not documented | from [docs](https://cursor.com/docs/context/mcp) |
| Claude Desktop | not documented | about 60 s; a `timeout` in the config is ignored | none | reported |

### Troubleshooting

- **The client says the server failed to start, or shows no api-anything tools.** It can't find
  `api-anything` or `node`. Run `api-anything mcp --print-config` and use its entry, which has
  absolute paths. Check `node --version` is 22.13 or newer for the `node` it names.
- **It worked, then stopped after you switched Node versions.** The entry names the old version's
  `node` (an nvm path holds the version). Run `--print-config` again and replace the entry.
- **The client reports a startup timeout through `npx`.** The first `npx` run downloads and builds
  the package. Run the `npx` command once in a terminal to fill npm's cache, or install the CLI
  globally, then raise the client's startup timeout (table above).
- **A call answers `class: "pending"`.** It is still running: call `get_job` with its `job`. Don't
  call the tool again: the same call while it runs joins it, and a write is not sent twice.
- **`get_job` answers `no job`.** The job finished more than 15 minutes ago, or the server
  restarted, which ends its jobs. Call a read again; for a write, check the site first.
- **A tool call times out in the client.** Raise the client's tool-call timeout to 60 seconds or
  more (table above). No tool waits longer than about 25 seconds before it answers.
- **The client asks for approval before every read.** Restart it so it loads the current tool list:
  `call_operation` is advertised read-only, and only `call_write_operation` asks.
- **`login` with mode `"window"` answers `pending`.** The window is open for the user. Tell them to
  sign in and close it, then call `get_job`. A second `login` meanwhile returns the same job, and
  the window closes by itself after 10 minutes.
- **The server sees none of your learned sites.** The client started it with another home. Set
  `API_ANYTHING_HOME` in your shell before `--print-config`, which copies it into the entry, or add
  it to the entry's `env`.
- **A per-op tool from `--sites` is missing.** A site named there that doesn't exist stops the
  server from starting: check `api-anything sites`. A write is a tool only with `--allow-writes`.

## Demo 1: teach once, call with new arguments

From the clone, with a Chromium browser (default Chrome; any works) and `jq` installed:

```sh
./examples/teach-once.sh arxiv.org
```

The script learns `hn-demo.links` from the Hacker News pages for `github.com` and `github.io`.
It prints the saved slot, then calls the operation with `arxiv.org` over plain HTTP
(`--max-tier 1`). Hacker News's `/from` page refuses plain HTTP carrying the browser's headers the op
learned, so the call is sent once more without them, still over plain HTTP. It exits nonzero unless
every returned URL is on the requested domain. The commands it runs:

```sh
api-anything add hn-demo links --trigger 'https://news.ycombinator.com/from?site={domain}' \
  --example domain=github.com --example2 domain=github.io --match path=/from \
  --html '{"items":"tr.athing","fields":{"title":".titleline > a","url":".titleline > a@href"}}'
api-anything call hn-demo links domain=arxiv.org --max-tier 1
```

This shows one reusable operation. It doesn't map every feature of Hacker News. A new site
usually needs an agent to choose the request, identify the arguments and pick the response fields.
To call the same operation the way an MCP client does, run
`node examples/mcp-call.mjs hn-demo links domain=nature.com`.

## Demo 2: an internal research workflow

From a checkout:

```sh
npm ci
npm run demo -- 'agent memory'
```

The example returns a short brief. It contains the first five Hacker News search results and a
`calls` log with each call's transport tier and time. It checks `ok` and truncation before using
a result, and exits with an error if a call fails.

For company research, import your existing LinkedIn session once, then run the same workflow
with enrichment. If several profiles are found, choose your account from the candidates. The
profile name below is a placeholder, not an account to assume.

```sh
api-anything login linkedin
# If prompted: api-anything login linkedin --profile 'Chrome/<your profile>'
api-anything call linkedin getMe
node examples/research.mjs anthropic --linkedin
```

This searches companies, then uses each returned `universalName` to fetch company details, for
at most three companies. It sends no messages. The JSON can feed an agent's brief, a local
report, or your existing job runner. Requests to one site are paced across processes, so CLI runs
in parallel queue up rather than arrive together. Treat `auth`, `rate`, `blocked` and
`drift` as incomplete work. Recordings and captured output for both demos are in
[docs/demos](demos/README.md).

## Writes and limits

The engine supports learning writes by intercepting and aborting requests, then calling the
saved operation with explicit write permission. Local tests verify different recipients and
content, no sends during learning, write refusal by default, and ambiguous-response handling.
No LinkedIn messaging operation ships with this release. Building one requires observing its
real request flow and verifying delivery to an explicitly authorized recipient.

Calls are local, not a hosted REST service. Sites can change, require login, or block automation.
The framework attempts recovery; it cannot guarantee every site or every feature. A fallback
that cannot honor the requested arguments fails instead of returning unrelated data. Read each
site's notes with `api-anything ops <site>`, particularly the limits on dates, pagination and fields.
