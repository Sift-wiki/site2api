"""The HTTP client for `api-anything serve`."""

from __future__ import annotations

import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union, cast

from ._version import __version__
from .errors import (
    ApiAnythingError,
    BadRequest,
    Forbidden,
    HTTPError,
    NotFound,
    ServerUnavailable,
    Timeout,
    Unauthorized,
)
from .result import BatchResult, Result

if TYPE_CHECKING:
    from .server import Server

DEFAULT_URL = "http://127.0.0.1:8787"
LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}

Fields = Union[str, Sequence[str]]
Seconds = Union[int, float, timedelta]
BatchCall = Union[Mapping[str, Any], Tuple[str, str], Tuple[str, str, Optional[Mapping[str, Any]]]]


def home_dir() -> str:
    """Where api-anything keeps its files: `API_ANYTHING_HOME`, else `~/.api-anything`."""
    return os.environ.get("API_ANYTHING_HOME") or os.path.join(os.path.expanduser("~"), ".api-anything")


def default_token() -> Optional[str]:
    """The server's token as the server reads it: `API_ANYTHING_TOKEN`, else the `serve-token` file."""
    token = os.environ.get("API_ANYTHING_TOKEN")
    if token:
        return token
    try:
        with open(os.path.join(home_dir(), "serve-token"), encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # the server never redirects; following one would send the bearer token wherever it points
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def _join(values: Fields) -> str:
    return values if isinstance(values, str) else ",".join(values)


def _ms(value: Seconds) -> int:
    seconds = value.total_seconds() if isinstance(value, timedelta) else float(value)
    return int(round(seconds * 1000))


def _segment(value: str) -> str:
    return urllib.parse.quote(value, safe="")


class Client:
    """Talks to a running `api-anything serve`.

    `base_url` defaults to `API_ANYTHING_URL`, else http://127.0.0.1:8787. `token` defaults to
    `API_ANYTHING_TOKEN`, else `~/.api-anything/serve-token` (`API_ANYTHING_HOME` moves the folder), read
    again on each request so a server started after the client still works. `timeout` (seconds) bounds
    each request and, for a call that answers `pending`, the whole wait for its job.
    """

    def __init__(self, base_url: Optional[str] = None, token: Optional[str] = None, timeout: float = 60) -> None:
        self.base_url = (base_url or os.environ.get("API_ANYTHING_URL") or DEFAULT_URL).rstrip("/")
        self.timeout = timeout
        self._token = token
        self._server: Optional["Server"] = None
        host = urllib.parse.urlsplit(self.base_url).hostname or ""
        handlers: List[urllib.request.BaseHandler] = [_NoRedirect()]
        if host in LOOPBACK or f"[{host}]" in LOOPBACK:
            # a proxy from the environment would see the token and could not reach this machine anyway
            handlers.append(urllib.request.ProxyHandler({}))
        self._opener = urllib.request.build_opener(*handlers)
        self._tool_index: Dict[str, Tuple[str, str, bool]] = {}

    # --- lifecycle -------------------------------------------------------------------------------

    @classmethod
    def start(cls, *, timeout: float = 60, **server_options: Any) -> "Client":
        """Start a local server (see `Server`) and return a client for it. Use it as a context manager,
        or call `close()`, to stop the server."""
        from .server import Server

        server = Server(**server_options).start()
        client = cls(server.url, token=server.token, timeout=timeout)
        client._server = server
        return client

    @property
    def server(self) -> Optional["Server"]:
        """The server `start()` spawned, if any."""
        return self._server

    def close(self) -> None:
        """Stop the server `start()` spawned. A client for a server it did not start has nothing to close."""
        if self._server is not None:
            self._server.stop()
            self._server = None

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"Client({self.base_url!r})"

    # --- transport -------------------------------------------------------------------------------

    def _auth_token(self) -> Optional[str]:
        return self._token or default_token()

    def _send(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: Optional[Mapping[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> Tuple[int, Any]:
        url = self.base_url + path
        if query:
            params = {k: v for k, v in query.items() if v is not None}
            if params:
                url += "?" + urllib.parse.urlencode(params)
        headers = {"Accept": "application/json", "User-Agent": f"api-anything-python/{__version__}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        token = self._auth_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        wait = self.timeout if timeout is None else timeout
        try:
            with self._opener.open(request, timeout=wait) as response:
                return response.status, _parse(response.read())
        except urllib.error.HTTPError as e:
            try:
                raw = e.read()
            finally:
                e.close()
            return e.code, _parse(raw)
        except urllib.error.URLError as e:
            if isinstance(e.reason, socket.timeout):
                raise Timeout(f"{method} {path}: no answer from {self.base_url} within {wait:g} s") from None
            raise ServerUnavailable(
                f"no api-anything server at {self.base_url} ({e.reason}). Start one with "
                "`api-anything serve`, or use Client.start()"
            ) from None
        except (socket.timeout, TimeoutError):
            raise Timeout(f"{method} {path}: no answer from {self.base_url} within {wait:g} s") from None
        except ConnectionError as e:
            raise ServerUnavailable(f"the api-anything server at {self.base_url} dropped the connection: {e}") from None

    def _json(self, method: str, path: str, body: Any = None, query: Optional[Mapping[str, Any]] = None) -> Any:
        status, payload = self._send(method, path, body, query)
        if 200 <= status < 300:
            return payload
        raise _http_error(status, payload)

    def _result(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: Optional[Mapping[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> Result[Any]:
        status, payload = self._send(method, path, body, query, timeout)
        if isinstance(payload, dict):
            # a refusal the server explains as a CallResult (bad args, writes off, busy) is an answer, not a crash
            if 200 <= status < 300 or (status in (400, 403, 404, 429) and isinstance(payload.get("class"), str)):
                return Result(payload)
        raise _http_error(status, payload)

    def _follow(self, result: Result[Any], deadline: float) -> Result[Any]:
        job_id = result.job
        delay = 0.25
        while result.pending and job_id:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            asked = time.monotonic()
            try:
                answer = self._result("GET", f"/v1/jobs/{_segment(job_id)}", timeout=remaining)
            except Timeout:
                break
            result = answer if not answer.pending or answer.job else Result({**answer, "job": job_id})
            if result.pending and time.monotonic() - asked < 1:
                # the server answered without holding the request: back off instead of spinning
                time.sleep(min(delay, max(0.0, deadline - time.monotonic())))
                delay = min(delay * 2, 2.0)
        return result

    # --- the API ---------------------------------------------------------------------------------

    def health(self) -> Dict[str, Any]:
        """`{ok, version}`. Needs no token."""
        return cast(Dict[str, Any], self._json("GET", "/v1/health"))

    def sites(self) -> List[Dict[str, Any]]:
        """The sites this server can call, as MCP `list_sites` answers."""
        return cast(List[Dict[str, Any]], self._json("GET", "/v1/sites"))

    def operations(self, site: str) -> Dict[str, Any]:
        """A site's operations, each with its args JSON Schema (`inputSchema`), as MCP `list_operations`
        answers. A shared site that is not installed is pulled first."""
        return cast(Dict[str, Any], self._json("GET", f"/v1/sites/{_segment(site)}"))

    def find(self, query: str) -> Dict[str, Any]:
        """Search this machine's sites and the shared catalog: words, a domain or a URL."""
        return cast(Dict[str, Any], self._json("GET", "/v1/find", query={"q": query}))

    def call(
        self,
        site: str,
        op: str,
        args: Optional[Mapping[str, Any]] = None,
        *,
        fields: Optional[Fields] = None,
        max_chars: Optional[int] = None,
        max_tier: Optional[int] = None,
        max_age: Optional[Seconds] = None,
        changes: bool = False,
        changes_only: bool = False,
        watch: Optional[str] = None,
        wait: bool = True,
    ) -> Result[Any]:
        """Call a read operation. Every class comes back as a Result; `raise_for_status()` turns a failure
        into its exception. With `wait`, a `pending` answer is followed through `job()` until it finishes
        or the client's timeout passes (then the pending Result is returned, with its `job`). `watch` names
        the watcher whose baseline `changes` compares with, so two watchers of one query don't share one."""
        deadline = time.monotonic() + self.timeout
        body: Dict[str, Any] = {}
        if args:
            body["args"] = dict(args)
        view: Dict[str, Any] = {}
        if fields is not None:
            view["fields"] = list(fields.split(",")) if isinstance(fields, str) else list(fields)
        if max_chars is not None:
            view["maxChars"] = max_chars
        if view:
            body["view"] = view
        if max_tier is not None:
            body["maxTier"] = max_tier
        if max_age is not None:
            body["maxAgeMs"] = _ms(max_age)
        if changes:
            body["changes"] = True
        if changes_only:
            body["changesOnly"] = True
        if watch is not None:
            body["watch"] = watch
        result = self._result("POST", f"/v1/call/{_segment(site)}/{_segment(op)}", body)
        return self._follow(result, deadline) if wait else result

    def write(
        self,
        site: str,
        op: str,
        args: Optional[Mapping[str, Any]] = None,
        *,
        again: bool = False,
        idempotency_key: Optional[str] = None,
        wait: bool = True,
    ) -> Result[Any]:
        """Send a write operation once. Only a server started with `allow_writes` takes it. The same write
        within 10 minutes answers `duplicate` unless `again`. A pending write is followed, never resent."""
        deadline = time.monotonic() + self.timeout
        body: Dict[str, Any] = {}
        if args:
            body["args"] = dict(args)
        if again:
            body["again"] = True
        if idempotency_key is not None:
            body["idempotencyKey"] = idempotency_key
        result = self._result("POST", f"/v1/write/{_segment(site)}/{_segment(op)}", body)
        return self._follow(result, deadline) if wait else result

    def batch(self, calls: Iterable[BatchCall], concurrency: Optional[int] = None, *, wait: bool = True) -> BatchResult:
        """Call several reads: dicts `{site, op, args?, id?}` or tuples `(site, op[, args])`. Results come
        back in input order; one failure does not stop the others."""
        deadline = time.monotonic() + self.timeout
        items: List[Dict[str, Any]] = []
        for c in calls:
            if isinstance(c, Mapping):
                items.append(dict(c))
            else:
                site, op, *rest = c
                item: Dict[str, Any] = {"site": site, "op": op}
                if rest and rest[0]:
                    item["args"] = dict(rest[0])
                items.append(item)
        body: Dict[str, Any] = {"calls": items}
        if concurrency is not None:
            body["concurrency"] = concurrency
        result = self._result("POST", "/v1/batch", body)
        return BatchResult(self._follow(result, deadline) if wait else result)

    def job(self, job_id: str) -> Result[Any]:
        """A pending call's job: its result, or `pending` again while it runs. It never runs the call again."""
        return self._result("GET", f"/v1/jobs/{_segment(job_id)}")

    def result(
        self,
        result_id: str,
        offset: Optional[int] = None,
        fields: Optional[Fields] = None,
        max_chars: Optional[int] = None,
    ) -> Result[Any]:
        """More of a cut answer (one with `resultId` and `more`), from the server's local copy."""
        query = {
            "offset": offset,
            "fields": _join(fields) if fields is not None else None,
            "maxChars": max_chars,
        }
        return self._result("GET", f"/v1/results/{_segment(result_id)}", query=query)

    def learn(self, *, wait: bool = True, **learn_args: Any) -> Result[Any]:
        """Learn a read from a page, with MCP `learn_site`'s arguments as keywords (`trigger`, `args`,
        `args2`, `args3`, `site`, `op`, `description`, `pickRequest`, ...). It opens a browser on the
        machine running the server, so it often answers `pending` first; `wait` follows it."""
        deadline = time.monotonic() + self.timeout
        result = self._result("POST", "/v1/learn", learn_args)
        return self._follow(result, deadline) if wait else result

    # --- tools for agent frameworks --------------------------------------------------------------

    def tools(
        self, sites: Optional[Sequence[str]] = None, format: str = "openai", *, writes: bool = False
    ) -> List[Dict[str, Any]]:
        """One function-tool definition per operation, named `<site>__<op>`, for `format` "openai"
        (Chat Completions), "anthropic" or "json_schema". `sites` defaults to every installed site.
        Writes are left out unless `writes` (and the server allows them)."""
        from .tools import build_tools

        return build_tools(self, sites, format, writes=writes)

    def run_tool(self, name: str, arguments: Union[str, Mapping[str, Any], None] = None) -> Result[Any]:
        """Run a tool `tools()` described: `arguments` is the model's object or its JSON text."""
        from .tools import run_tool

        return run_tool(self, name, arguments)


def _parse(raw: bytes) -> Any:
    if not raw:
        return None
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


def _http_error(status: int, payload: Any) -> ApiAnythingError:
    if isinstance(payload, dict):
        message = payload.get("reason") or payload.get("error") or payload.get("message") or json.dumps(payload)
    else:
        message = str(payload or "").strip()[:500] or "no body"
    kind = {400: BadRequest, 401: Unauthorized, 403: Forbidden, 404: NotFound}.get(status, HTTPError)
    if status == 401:
        message += ": pass token=, set API_ANYTHING_TOKEN, or check ~/.api-anything/serve-token"
    return kind(status, str(message), payload)
