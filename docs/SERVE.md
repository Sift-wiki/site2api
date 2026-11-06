# HTTP server: `api-anything serve`

`api-anything mcp` talks over stdio, so only a client that starts a local process can use it.
`api-anything serve` puts the same tools on an HTTP port for everything else: n8n, Make, Zapier,
Dify, Flowise, Postman, a custom GPT's actions, or a script in any language with an HTTP client.

One port serves three surfaces:

| path | what |
|---|---|
| `/mcp` | MCP over Streamable HTTP: the tools `api-anything mcp` serves, with the same flags |
| `/v1/...` | plain JSON endpoints, each answering exactly what the matching MCP tool answers |
| `/openapi.json` | an OpenAPI 3.1 document of the endpoints, with one typed path per installed read |

## Start it

```sh
npx -y api-anything serve
```

```text
{"ok":true,"version":"0.3.2","url":"http://127.0.0.1:8787","mcp":"http://127.0.0.1:8787/mcp","openapi":"http://127.0.0.1:8787/openapi.json","tokenFile":"/Users/you/.api-anything/serve-token"}
```

Once it listens it prints that one JSON line on stdout. Everything after it, one line per request,
goes to stderr. A program that starts the server reads the first stdout line for the URL. With
`--port 0` the server picks a free port and the line names it.

| flag | default | |
|---|---|---|
| `--host` | `127.0.0.1` | the address to listen on; anything but loopback prints a warning |
| `--port` | `8787` | `0` picks a free port |
| `--allow-writes` | off | adds `POST /v1/write/{site}/{op}` and the MCP `call_write_operation` |
| `--sites a,b` | every installed site | MCP: each op of these sites is also a tool of its own. OpenAPI: per-op paths for these sites only |
| `--no-learn` | | hides `POST /v1/learn` and `learn_site` |
| `--cors <origin>` | none | a browser origin allowed to call; repeat the flag for more |
| `--public-url <url>` | | the address a tunnel or proxy gives the server (see below) |
| `--print-config` | | prints curl, MCP and n8n examples instead of serving |

The server stops on Ctrl-C or SIGTERM. It finishes answers still being written (up to 30 seconds),
then closes the browser. A second Ctrl-C stops it at once.

## The token

Every request except `GET /v1/health` needs `Authorization: Bearer <token>`. The token is:

1. `API_ANYTHING_TOKEN` from the server's environment, when set. The startup line then has
   `"tokenEnv":"API_ANYTHING_TOKEN"` in place of `tokenFile`.
2. Otherwise, the contents of `~/.api-anything/serve-token` (under `API_ANYTHING_HOME` when that is
   set). The first start creates the file with 32 random bytes in hex, readable only by you.

```sh
TOKEN=$(cat ~/.api-anything/serve-token)
```

The token is never printed to stdout. To change it, delete the file and restart the server.

## Endpoints

Every body is JSON in and JSON out (`content-type: application/json`). An answer is the same
object as the MCP tool's answer for the same input. The answers use MCP's names: a `next` hint
says `call get_job` or `list_operations`, and `nextCall.tool` names a tool. The table gives the
endpoint for each tool.

| endpoint | MCP tool | body or query |
|---|---|---|
| `GET /v1/health` | | no token: `{"ok":true,"version":"..."}` |
| `GET /v1/sites` | `list_sites` | |
| `GET /v1/sites/{site}` | `list_operations` | an uninstalled shared site is pulled first, reads only |
| `GET /v1/find?q=...` | `find_sites` | `q`: words, a domain or a URL |
| `POST /v1/call/{site}/{op}` | `call_operation` | `{"args"?, "view"?: {"fields"?, "maxChars"?}, "maxTier"?: 1\|2\|3}` |
| `POST /v1/write/{site}/{op}` | `call_write_operation` | the same, plus `"again"?` and `"idempotencyKey"?`; only with `--allow-writes` |
| `POST /v1/batch` | `call_batch` | `{"calls": [{"site", "op", "args"?, "id"?}], "concurrency"?: 1..4}`, at most 20 calls |
| `GET /v1/jobs/{jobId}` | `get_job` | |
| `GET /v1/results/{resultId}` | `get_result` | `?offset=&fields=a,b&maxChars=&format=json` |
| `POST /v1/learn` | `learn_site` | `learn_site`'s arguments; hidden with `--no-learn` |
| `GET /openapi.json` | | the OpenAPI document |
| `/mcp` | every tool | MCP Streamable HTTP |

The call body also accepts `maxAgeMs`, `changes` and `changesOnly`, so a client written for a
later version still works. This version ignores them.

HTTP status codes:

- **200**: the call ran. A call that failed at the site (`auth`, `drift`, `rate`, `input`...) is
  still a 200: `ok` and `class` in the body say what happened, and `next` says what to do.
- **400**: the body is not JSON, is not an object, has a key the endpoint does not take, or fails
  the tool's schema (`args` not an object, `maxTier: 4`, 21 batch calls).
- **401**: no token, or the wrong one. **403**: a refused `Origin` or `Host` (see below).
- **404**: an unknown route, or `/v1/write` without `--allow-writes`. **405**: a known path with
  the wrong method. **413**: a body over 1 MB.
- **500**: a bug. Please report it.

Two things an HTTP client has to handle:

- **Pending calls.** A call still running after about 25 seconds (a repair, a browser-tier call,
  `learn_site`) answers `{"ok":false,"class":"pending","job":"<id>",...}` and keeps running. Ask
  for its result with `GET /v1/jobs/<id>`. That request waits up to 25 seconds and answers either
  the result or `pending` again. Never send the call again: an identical call joins the running
  job anyway, and a write might be sent twice. Set your client's timeout to 60 seconds or more.
- **Tables.** When it makes the JSON shorter, a `data` list of two or more records comes back as
  `{"columns":[...],"rows":[[...],...]}`, one row per item and `null` for a missing field, as it
  does over MCP. To get the records back, zip each row with `columns`.

### curl

```sh
curl -s http://127.0.0.1:8787/v1/health
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/sites
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8787/v1/find?q=book%20ratings"
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"args":{"query":"sqlite"},"view":{"fields":["title","points"]}}' \
  http://127.0.0.1:8787/v1/call/hacker-news/search
```

### n8n

Use an **HTTP Request** node:

- **Method**: `POST`
- **URL**: `http://127.0.0.1:8787/v1/call/hacker-news/search`
- **Authentication**: Generic Credential Type, then **Bearer Auth**, with the token as the bearer
  token.
- **Send Body**: on, **Body Content Type** `JSON`, **Specify Body** `Using JSON`:
  `{"args":{"query":"{{ $json.topic }}"}}`
- **Options, Timeout**: 60000 ms. A `pending` answer is followed with a second HTTP Request node
  to `GET /v1/jobs/{{ $json.job }}`.

When n8n runs in Docker, `127.0.0.1` inside the container is the container itself. Reach the host
as `host.docker.internal`, and start the server with
`--public-url http://host.docker.internal:8787` so that Host is accepted. If the container still
cannot connect, the server must listen on an address the container can reach (`--host 0.0.0.0`).
Read the security notes below before you do that.

`api-anything serve --print-config` prints this node as JSON, along with the curl lines and an
MCP-over-HTTP entry.

### MCP over HTTP

Any MCP client that takes a URL and headers can connect:

```json
{ "url": "http://127.0.0.1:8787/mcp", "headers": { "Authorization": "Bearer <token>" } }
```

It gets the same tools as `api-anything mcp` with the same flags. Every session shares one job
table with the REST endpoints, so a job one of them started can be read from any other.

### OpenAPI

`GET /openapi.json` (token required, since it lists your installed sites) returns an OpenAPI 3.1
document with bearer security. It has the endpoints above, plus one concrete
`POST /v1/call/<site>/<op>` path for each installed read:

- `operationId` is `<site>__<op>`, with any character outside `[A-Za-z0-9_]` turned into `_`
  (`hacker_news__search`).
- `args` in the request body is typed with the op's args JSON Schema, the same schema
  `list_operations` gives.
- The 200 answer is the call result, with `data` typed from what the spec says the op returns.
- The summary and description come from the op's description and the site's notes. The
  description is cut to 300 characters, the most a custom GPT accepts. A shared site's
  description starts with the warning that someone else wrote it.

The document is generated on every request. A site you learn appears without a restart. Without
`--sites`, every installed site is included, up to 300 per-op paths. A tool loader works better
with a short document, so pass `--sites` with the sites you want.

## Using it from a hosted service (a custom GPT, Zapier, Make)

A hosted service calls from its own servers, so it cannot reach `127.0.0.1` on your machine. A
tunnel can get it there (`cloudflared`, `ngrok`, `tailscale funnel`).

> **Warning.** Behind a public tunnel, anyone who has the URL and the token can act as you on every
> site you are signed in to through api-anything. They can read your accounts and, with
> `--allow-writes`, post, buy or delete in your name. The service you give the token to keeps it.
> Before you open a tunnel:
>
> - Leave `--allow-writes` off.
> - Limit the server to the sites the service needs: `--sites goodreads,hacker-news`. This limits
>   the OpenAPI paths and per-op tools, not the endpoints. `/v1/call` still reaches any installed
>   site, so use a separate `API_ANYTHING_HOME` that holds only those sites and their sessions.
> - Use a fresh token (`API_ANYTHING_TOKEN=$(openssl rand -hex 32)`), and change it when you are
>   done.
> - Stop the tunnel and the server as soon as you are done.

For example, with a Cloudflare quick tunnel:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
# it prints https://<random>.trycloudflare.com
API_ANYTHING_HOME=~/.api-anything-gpt API_ANYTHING_TOKEN=$(openssl rand -hex 32) \
  npx -y api-anything serve --no-learn --sites goodreads \
  --public-url https://<random>.trycloudflare.com
```

`--public-url` adds the tunnel's host name to the Hosts the server accepts (it refuses every other
non-loopback Host) and writes it into the OpenAPI document's `servers`. Then:

1. Fetch the document: `curl -s -H "Authorization: Bearer $API_ANYTHING_TOKEN" https://<random>.trycloudflare.com/openapi.json`.
2. In the GPT editor, open **Actions**, then **Create new action**, and paste the document into
   the schema.
3. Under **Authentication**, choose **API Key**, then **Bearer**, and enter the token.

Postman, Dify and other OpenAPI importers take the same document.

## Security model

The server holds your signed-in sessions, so it is guarded like a key to them:

- **Loopback by default.** It listens on `127.0.0.1`. With any other `--host`, it prints a
  warning: every machine that can reach that address can try the token.
- **A bearer token on every request** except `GET /v1/health`, compared in constant time. The
  token file is readable only by you.
- **No browser pages.** A page you visit can send requests to `127.0.0.1`. The server refuses
  every request that carries an `Origin` header (which browsers add to cross-site requests),
  unless the origin is listed with `--cors`. `*` is refused. A listed origin gets CORS headers and
  preflight answers.
- **No DNS rebinding.** Bound to loopback, it refuses any `Host` header other than
  `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` and the `--public-url` host. A page
  whose domain is made to resolve to `127.0.0.1` still sends its own domain as `Host`, so it is
  refused.
- **Writes are off** unless you pass `--allow-writes`. Even then, every rule that applies to
  `call_write_operation` still applies: a read endpoint never sends a write, a write is refused as
  a duplicate within 10 minutes unless `again` is set, and a site an agent pulled has no writes.
- **Bounded input.** JSON bodies are capped at 1 MB, and a batch at 20 calls.
- **Shared specs are data.** The OpenAPI document and the answers carry site text. Treat it the
  way the MCP server does: as data from the website, never as instructions.
