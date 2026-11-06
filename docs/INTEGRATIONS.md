# Agent frameworks

API Anything is an MCP server that runs over stdio, so any framework with an MCP client can use it.
The server is the same everywhere:

```json
{ "command": "npx", "args": ["-y", "api-anything", "mcp"] }
```

It needs Node 22.13 or newer on the `PATH` of the process that starts it. No API Anything account
or key is involved; the framework's own model does the reasoning. The examples below were written
against the versions named in each file and checked in October 2026: each one started the server
and listed its tools.

| framework | example | install |
|---|---|---|
| Vercel AI SDK (TypeScript) | [examples/vercel-ai-sdk.mjs](../examples/vercel-ai-sdk.mjs) | `npm install ai @ai-sdk/mcp @ai-sdk/anthropic` |
| LangChain.js | [examples/langchain.mjs](../examples/langchain.mjs) | `npm install langchain @langchain/anthropic @langchain/mcp-adapters @langchain/core @langchain/langgraph` |
| OpenAI Agents SDK (Python) | [examples/openai-agents.py](../examples/openai-agents.py) | `pip install openai-agents` |
| Plain MCP SDK, no model | [examples/mcp-call.mjs](../examples/mcp-call.mjs) | `npm install @modelcontextprotocol/sdk` |

Each example takes a question as its arguments:

```sh
ANTHROPIC_API_KEY=... node examples/vercel-ai-sdk.mjs "What does Goodreads rate Piranesi?"
ANTHROPIC_API_KEY=... node examples/langchain.mjs "Top Hacker News stories about sqlite"
OPENAI_API_KEY=... python examples/openai-agents.py "What does Goodreads rate Piranesi?"
```

## The tools

The server serves `find_sites`, `list_operations`, `call_operation`, `call_batch`, `get_job`,
`get_result`, `site_status`, `learn_site`, `list_sites` and `login`. `call_write_operation` exists
only on a server started with `mcp --allow-writes`. [QUICKSTART.md](QUICKSTART.md#the-tools-an-agent-gets)
says what each one does. A framework may rename them: LangChain's MCP adapters 2 prefix each with
the server's name (`api-anything_find_sites`).

The instructions the examples give the model are the short version of the server's own: find a
shared site first, call it, learn it only when nothing is shared, and answer a `pending` result with
`get_job` instead of calling again.

## Things that differ from a desktop client

- **Timeouts.** A call over plain HTTP returns in well under a second. A call that repairs itself, a
  browser-tier call or `learn_site` can take longer, so any call still running after about 25
  seconds answers `class: "pending"` with a `job`. Set the framework's per-call timeout to 60 seconds
  or more. The OpenAI Agents SDK waits 5 seconds by default; the example sets
  `client_session_timeout_seconds=60`.
- **Cold start.** The first `npx` run downloads the package. On a server or in CI, run
  `npx -y api-anything --version` once while building the image, or install it
  (`npm install -g api-anything`) and use `{"command": "api-anything", "args": ["mcp"]}`.
- **An old global install wins.** When `api-anything` is installed globally, `npx -y api-anything`
  runs that copy, whatever its version. Check with `api-anything --version`, then
  `npm install -g api-anything@latest`, or name the version: `npx -y api-anything@latest mcp`.
- **Learning needs a browser.** `learn_site`, `login` and the browser tier open a Chromium browser on
  the machine running the server. In a container without one, shared operations still work over
  plain HTTP; start the server with `mcp --no-learn` to hide `learn_site`.
- **Where things are kept.** Learned sites, sessions and settings live in `~/.api-anything`. Set
  `API_ANYTHING_HOME` in the server's environment to keep them somewhere else, for example a volume
  that outlives the container. Sessions and captures are sealed under a key from the OS store, which
  a container usually lacks: set `API_ANYTHING_KEY` to a passphrase from the platform's secret store
  to seal them there, or `API_ANYTHING_PLAINTEXT=1` to keep them as 0600 plaintext without a warning.
  The passphrase must stay the same for as long as the home does.
- **Sharing.** Until someone answers the sharing question (`npx -y api-anything setup`, or the
  question `learn_site` asks once), nothing is shared or reported. For a non-interactive install,
  record the answer first: `npx -y api-anything setup --share-only --no-share` (or `--yes`).
- **Writes.** Leave `--allow-writes` off unless the agent should send writes, such as posting or
  buying, and the framework asks a person before each one.
