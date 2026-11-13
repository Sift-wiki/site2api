# Python

The Python client for `api-anything serve`, the local HTTP server, installs from this repository
(it is not on PyPI yet):

```sh
pip install "git+https://github.com/goodnight000/api-anything#subdirectory=python"
```

The import name is `api_anything`. The package has no dependencies beyond the standard library and
supports Python 3.9 and newer. The server is the npm package and needs Node.js 22.13 or newer.

The client sends no request to a website itself. Every call goes to the server, which runs it through
the same ladder as the CLI and MCP: plain HTTP first, the browser tiers when needed, a repair when the
site changed, a cookie re-import on `auth`, and the classifier's verdict on the answer. The code is in
[`python/`](../python).

## Start a server

```python
from api_anything import Client

with Client.start() as client:
    print(client.health())        # {"ok": True, "version": "..."}
```

`Client.start()` runs `api-anything serve --port 0` when `api-anything` is on `PATH`, else
`npx -y api-anything@latest serve --port 0`. It reads the line the server prints when it listens,
reads the token from the token file, and stops the process (and the node that npx started) when the
`with` block ends or the interpreter exits. Its keywords go to `Server`:

| keyword | meaning |
|---|---|
| `command` | the api-anything command, such as `["node", "dist/cli.js"]` from a checkout; `serve` and its flags are added |
| `host`, `port` | where to listen; the default is a free port on 127.0.0.1 |
| `allow_writes`, `sites`, `no_learn` | `serve --allow-writes`, `--sites a,b`, `--no-learn` |
| `npm_version` | what npx runs, `latest` by default |
| `env` | variables for the server, such as `{"API_ANYTHING_HOME": "/data/api-anything"}` |
| `startup_timeout` | seconds to wait for it to listen (default 180, for npx's first download) |

Without Node, `Client.start()` raises `NodeNotFound` with the install steps. An `api-anything` on
`PATH` older than 0.4.0 has no `serve`; the error says to run `npm install -g api-anything@latest`.

A server you run yourself works too:

```sh
api-anything serve            # http://127.0.0.1:8787
```

```python
client = Client()             # API_ANYTHING_URL, else http://127.0.0.1:8787
```

The token is `token=` when given, else `API_ANYTHING_TOKEN`, else `~/.api-anything/serve-token`
(`API_ANYTHING_HOME` moves the folder), as the server reads it. `Client(timeout=60)` bounds each
request and, for a call that answers `pending`, the whole wait for its job.

`health()` sends no token. Every other request carries it to whatever listens at the base URL, and
the client cannot tell that listener from your server: the server does not prove that it holds the
token. On a machine where another account or a confined process can listen on a loopback port, one
that holds the port while no server does (before the first start, after a stop or a crash) receives
the token on the first `sites()` or `call()`, and the server accepts that token until you change it
(delete `serve-token` and restart the server). A base URL with `localhost` adds a second case: the
server listens on 127.0.0.1 only, so another process can hold `[::1]` on the same port while it
runs. `Client.start()` is not affected, since it takes the address from the process it started.
Where this matters, use `Client.start()`, or keep `127.0.0.1` in the URL and the server running.

## Call

```python
result = client.call("hacker-news", "search", {"query": "sqlite"}, fields=["title", "points"])
if result.ok:
    print(result.data)
else:
    print(result.klass, result.reason, result.next)
```

| method | route |
|---|---|
| `health()` | `GET /v1/health` (needs no token, and sends none) |
| `sites()` | `GET /v1/sites` |
| `operations(site)` | `GET /v1/sites/{site}`: each op with its args JSON Schema; pulls a shared site |
| `find(query)` | `GET /v1/find?q=`: this machine's sites and the shared catalog |
| `call(site, op, args, *, fields, max_chars, max_tier, max_age, changes, changes_only, wait)` | `POST /v1/call/{site}/{op}` |
| `write(site, op, args, *, again, idempotency_key)` | `POST /v1/write/{site}/{op}`, on a server started with `allow_writes` |
| `batch(calls, concurrency)` | `POST /v1/batch`: dicts `{site, op, args?}` or tuples `(site, op, args)` |
| `job(job_id)` | `GET /v1/jobs/{id}` |
| `result(result_id, offset, fields, max_chars)` | `GET /v1/results/{id}`: more of a cut answer |
| `learn(**learn_site_args)` | `POST /v1/learn` |

`max_age` takes seconds or a `timedelta`. With `wait=True` (the default), a `pending` answer is
followed through `job()` until the job finishes or the client's timeout passes. At the timeout the
pending `Result` comes back with its `job`, so you can call `client.job(result.job)` later. A pending
write is followed the same way and is never sent again.

### Results and errors

`call`, `write`, `job`, `result` and `learn` return a `Result`: a dict of the server's answer, so
`result["class"]` and `json.dumps(result)` work, with attributes for its fields: `ok`, `klass`, `tier`,
`data`, `reason`, `next`, `retry`, `retry_after` (seconds), `next_call`, `next_page`, `has_more`, `job`,
`more`, `result_id`, `cached`, `changes`, `healed`. `batch` returns a `BatchResult` whose `results`
holds one `Result` per call.

A call that ran is a `Result` whatever its class. `raise_for_status()` returns it when `ok`, else raises:

| class | exception |
|---|---|
| `auth` | `AuthError`; `next` names the login step |
| `rate` | `RateLimited`; `retry_after` in seconds |
| `drift` | `Drift` |
| `blocked` | `Blocked` |
| `input` | `InputError` |
| `error` | `OperationError` |
| `refused` | `Refused` |
| `duplicate` | `Duplicate` |
| `pending` | `Pending`; `job` |

Each is a `CallError` carrying the `result`, `reason`, `next`, `next_call` and `retry`. Problems with
the request itself raise `HTTPError` subclasses: `BadRequest` (400), `Unauthorized` (401), `Forbidden`
(403), `NotFound` (404). A refusal the server explains as a call result (bad args, writes off) is
returned as a `Result` instead. `ServerUnavailable` means nothing answered at the URL; `Timeout` means
it did not answer in time. All of them derive from `ApiAnythingError`.

## Tools for agent frameworks

```python
tools = client.tools(["hacker-news", "goodreads"], format="openai")
# a tool call from the model:
result = client.run_tool(call.function.name, call.function.arguments, tools=tools)
```

`tools()` returns one function-tool definition per operation of the named sites (all installed sites
by default), named `<site>__<op>` as the MCP server's per-op tools are, with the operation's argument
schema as `parameters`. `format` is `"openai"` (Chat Completions), `"anthropic"` (Messages API
`input_schema`) or `"json_schema"` (`{name, description, parameters}`). Writes are left out unless
`writes=True`. `run_tool(name, arguments)` takes the model's arguments as an object or JSON text and
calls the operation. Send its `Result` back as the tool's output (`json.dumps(result)`), failures
included, so the model can read `next`.

The model writes the name, so `run_tool` runs only a tool that a list described:

- A name no `tools()` call on this client listed raises `ValueError`, and nothing is sent.
- `tools=` is the list the model was given, in any format. A name outside it raises `ValueError`.
  The list can hold other tools beside these: a hosted one with no name (`{"type": "web_search"}`,
  a code interpreter, an MCP server) is skipped.
- Without `tools=`, a name from any earlier list of the same client still runs: the client remembers
  every list it built (the adapters below depend on that), so after `tools(["forum"], writes=True)` a
  later reads-only list leaves `forum__postComment` a write. Where lists differ in sites or in
  `writes`, pass `tools=` or use one `Client` per list.
- `unlisted=True` is for your own code, not for a model's name: it runs a `<site>__<op>` name no list
  described, as a read. The server then calls any site it holds, and pulls a shared one it lacks.

### LangChain and LangGraph

```python
from langchain.agents import create_agent
from api_anything import Client
from api_anything.integrations import langchain

with Client.start() as client:
    agent = create_agent("anthropic:claude-sonnet-4-5", tools=langchain.tools(client, ["hacker-news"]))
    reply = agent.invoke({"messages": [{"role": "user", "content": "Top HN stories about sqlite"}]})
```

`langchain.tools(client, sites)` returns `StructuredTool`s (needs `langchain-core` 0.3 or newer), which
also work with `bind_tools` and LangGraph's `ToolNode`. Each runs in a thread when awaited.

### OpenAI Agents SDK

```python
from agents import Agent, Runner
from api_anything.integrations import openai_agents

agent = Agent(name="Web data", tools=openai_agents.tools(client, ["hacker-news"]))
print(Runner.run_sync(agent, "Top HN stories about sqlite").final_output)
```

`openai_agents.tools(client, sites)` returns `FunctionTool`s, not in strict mode since most arguments
are optional. With `writes=True`, a write tool needs the run's approval. The full script is
[examples/python-agent.py](../examples/python-agent.py).

Other frameworks (CrewAI, LlamaIndex, Pydantic AI, smolagents) take a function plus a JSON Schema in
one form or another: build them from `client.tools(format="json_schema")` and `client.run_tool`, with
each tool's name bound in its function as the adapters above do. Or
connect them to the server's MCP endpoint, printed as `mcp` when it starts (`server.mcp_url`).

## Typed clients

```sh
python -m api_anything gen hacker-news -o hacker_news.py [--url http://127.0.0.1:8787]
```

reads `GET /v1/sites/hacker-news` and writes a module with one function per read operation:

```python
def search(
    *,
    query: str,
    type: Optional[Literal['story', 'comment', 'ask_hn', 'show_hn', 'poll', 'job']] = None,
    page: Optional[float] = None,
    client: Optional[Client] = None,
    **options: Any,
) -> Result[List[SearchItem]]:
```

- Arguments are keyword-only, named in snake_case (`sortBy` becomes `sort_by`; the docstring names
  the original), typed from the schema: an enum becomes a `Literal`, a required argument has no default,
  and the description, pattern, bounds and default go in the docstring. The server checks the pattern
  and bounds when it is called, as for any call.
- Where the operation records its output fields, a `TypedDict` declares them (`total=False`, since a
  site can leave a key out), and the function returns `Result[List[SearchItem]]` or `Result[SearchData]`.
- Each function calls `Client.call`, through `client=` or a `Client()` set up from the environment, and
  passes `**options` on (`fields`, `max_tier`, `wait`, ...). Repairs, tiers and failure classes apply as
  they do for any call. Writes are left out.
- The file depends only on the operations' names, arguments and output hints, never on example values,
  notes or session data, and holds no credential. The same description gives a byte-identical file, so
  a site that repaired itself regenerates the same module, and the module can be checked in.

## Testing

From `python/`:

```sh
PYTHONPATH=src python -m unittest discover -s tests -t .
UPDATE_GOLDEN=1 PYTHONPATH=src python -m unittest tests.test_codegen   # after an intended codegen change
uv build                                                               # or: python -m build
```

The tests run against a fake server on localhost and fake `api-anything`/`npx` executables, so they
need neither Node nor the network. The adapters' tests skip unless their framework is installed.
CI runs them on Python 3.9 and 3.13 against the built wheel. Releasing is in
[DISTRIBUTION.md](DISTRIBUTION.md#pypi).
