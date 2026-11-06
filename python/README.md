# api-anything for Python

[API Anything](https://github.com/goodnight000/api-anything) turns a website's own browser traffic into
operations an agent can call: search a site, read a page, check a price. When the site changes, the
operation repairs itself on the next call. This package is the Python client for its local server,
`api-anything serve`, with tool definitions for agent frameworks and a generator for typed clients.

It has no dependencies beyond the standard library. The server runs on Node.js 22.13 or newer.

```sh
pip install "git+https://github.com/goodnight000/api-anything#subdirectory=python"
```

It is not on PyPI yet, so install it from the repository as above.

## Call a site

```python
from api_anything import Client

with Client.start() as client:          # runs `api-anything serve`, or `npx -y api-anything serve`
    result = client.call("hacker-news", "search", {"query": "sqlite"}, fields=["title", "points"])
    result.raise_for_status()           # AuthError, RateLimited, Drift, Blocked, InputError, ...
    for story in result.data:
        print(story["points"], story["title"])
```

`Client.start()` starts a server on a free port and stops it when the block ends. To use a server that
is already running (`api-anything serve`), create `Client()`: it reads `API_ANYTHING_URL` (default
`http://127.0.0.1:8787`) and the server's token from `API_ANYTHING_TOKEN` or
`~/.api-anything/serve-token`.

Every call returns a `Result`, a dict with the server's answer and attributes for its fields: `ok`,
`klass` (`result["class"]`), `data`, `reason`, `next`, `retry`, `retry_after`, `next_call`, `next_page`.
A failed call is still a `Result`; `raise_for_status()` raises the exception for its class. A call
still running after about 25 seconds answers `pending`; the client follows its job until it finishes
or the client's `timeout` passes.

## Tools for agent frameworks

```python
tools = client.tools(format="openai")             # or "anthropic", "json_schema"
result = client.run_tool(name, arguments)          # the model's tool call
```

One tool per operation, named `<site>__<op>`, with the operation's argument schema. Adapters for
LangChain/LangGraph and the OpenAI Agents SDK:

```python
from api_anything.integrations import langchain, openai_agents

langchain.tools(client, ["hacker-news"])        # StructuredTool list; pip install langchain-core
openai_agents.tools(client, ["hacker-news"])    # FunctionTool list; pip install openai-agents
```

## Typed clients

```sh
python -m api_anything gen hacker-news -o hacker_news.py
```

writes a module with one typed function per read operation. The functions call the operation through
the server, so repairs and failure classes still apply, and the file holds no credential.

```python
import hacker_news

hacker_news.search(query="sqlite", page=0).raise_for_status().data
```

The full guide is [docs/PYTHON.md](https://github.com/goodnight000/api-anything/blob/main/docs/PYTHON.md).
MIT licensed.
