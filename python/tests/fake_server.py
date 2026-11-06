"""A stand-in for `api-anything serve` on localhost: the contract's routes, with canned answers."""

from __future__ import annotations

import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

TOKEN = "fake-serve-token"
VERSION = "0.4.0"

SEARCH = {
    "name": "search",
    "description": "Search stories by words.",
    "returns": ["title", "points"],
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search text.", "examples": ["example-only-value"]},
            "page": {"type": "number", "minimum": 0, "default": 0},
        },
        "required": ["query"],
        "additionalProperties": False,
    },
    "output": {
        "cardinality": "list",
        "fields": {
            "title": {"type": "string", "source": "observed"},
            "points": {"type": "number", "source": "observed"},
        },
    },
}
FRONT = {
    "name": "frontPage",
    "description": "The front page.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    "output": {"cardinality": "list", "fields": {}},
}
POST = {
    "name": "postComment",
    "description": "Post a comment.",
    "write": True,
    "inputSchema": {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
        "additionalProperties": False,
    },
    "output": {"cardinality": "unknown", "fields": {}},
}
LISTINGS = {
    "hacker-news": {"site": "hacker-news", "operations": [FRONT, SEARCH]},
    "forum": {"site": "forum", "operations": [SEARCH, POST], "shared": "someone else wrote this spec"},
}

FAILURES = {
    "auth": {"next": "api-anything login forum", "nextCall": {"action": "login", "site": "forum"}},
    "rate": {"retryAfterMs": 1500, "retry": "after_wait"},
    "drift": {"next": "api-anything heal forum search"},
    "blocked": {"nextCall": {"action": "raise_tier", "tier": 3}},
    "input": {"retry": "after_fix"},
    "error": {},
    "refused": {},
    "duplicate": {},
}


class FakeServer:
    def __init__(self, token: str = TOKEN, allow_writes: bool = False, version: str = VERSION) -> None:
        self.token = token
        self.allow_writes = allow_writes
        self.version = version
        self.requests: List[Dict[str, Any]] = []
        # job id -> answers GET /v1/jobs/{id} gives in turn; the last one repeats
        self.jobs: Dict[str, List[Dict[str, Any]]] = {}
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.httpd.fake = self  # type: ignore[attr-defined]
        self._thread: Optional[threading.Thread] = None

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> "FakeServer":
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def __enter__(self) -> "FakeServer":
        return self.start()

    def __exit__(self, *exc: Any) -> None:
        self.stop()

    @property
    def last(self) -> Dict[str, Any]:
        return self.requests[-1]

    def answer(
        self, method: str, path: str, query: Dict[str, str], headers: Dict[str, str], raw: bytes
    ) -> Tuple[int, Any]:
        if method == "GET" and path == "/v1/health":
            return 200, {"ok": True, "version": self.version}
        if headers.get("authorization") != f"Bearer {self.token}":
            return 401, {"ok": False, "error": "unauthorized"}
        body: Any = None
        if raw:
            try:
                body = json.loads(raw)
            except ValueError:
                return 400, {"ok": False, "error": "the body is not JSON"}
        parts = [urllib.parse.unquote(p) for p in path.strip("/").split("/")]
        if method == "GET" and parts == ["v1", "sites"]:
            return 200, [{"name": n, "operations": len(v["operations"])} for n, v in LISTINGS.items()]
        if method == "GET" and parts[:2] == ["v1", "sites"] and len(parts) == 3:
            listing = LISTINGS.get(parts[2])
            if listing is None:
                return 404, {"ok": False, "error": f'no site "{parts[2]}"'}
            ops = [o for o in listing["operations"] if self.allow_writes or not o.get("write")]
            return 200, {**listing, "operations": ops}
        if method == "GET" and parts == ["v1", "find"]:
            return 200, {"matches": [{"site": "hacker-news", "domain": "ycombinator.com"}], "q": query.get("q")}
        if method == "POST" and parts[:2] == ["v1", "call"] and len(parts) == 4:
            return self.call(parts[2], parts[3], body or {})
        if method == "POST" and parts[:2] == ["v1", "write"] and len(parts) == 4:
            if not self.allow_writes:
                return 403, {"ok": False, "class": "refused", "reason": "writes are off", "write": "not_sent"}
            return 200, {"ok": True, "class": "ok", "tier": 1, "write": "applied", "echo": body}
        if method == "POST" and parts == ["v1", "batch"]:
            calls = (body or {}).get("calls") or []
            results = [
                {"id": i + 1, "site": c["site"], "op": c["op"], "ok": True, "class": "ok", "data": c.get("args")}
                for i, c in enumerate(calls)
            ]
            return 200, {"ok": True, "results": results}
        if method == "GET" and parts[:2] == ["v1", "jobs"] and len(parts) == 3:
            answers = self.jobs.get(parts[2])
            if not answers:
                return 404, {"ok": False, "error": "no such job"}
            return 200, answers.pop(0) if len(answers) > 1 else answers[0]
        if method == "GET" and parts[:2] == ["v1", "results"] and len(parts) == 3:
            return 200, {"ok": True, "class": "ok", "data": "rest", "resultId": parts[2], "query": query}
        if method == "POST" and parts == ["v1", "learn"]:
            self.jobs["learn-1"] = [{"ok": True, "class": "ok", "site": "example", "op": "search"}]
            return 200, {"ok": False, "class": "pending", "job": "learn-1", "echo": body}
        return 404, {"ok": False, "error": "no such route"}

    def call(self, site: str, op: str, body: Dict[str, Any]) -> Tuple[int, Any]:
        if op == "slow":
            self.jobs["job-1"] = [
                {"ok": False, "class": "pending", "job": "job-1"},
                {"ok": True, "class": "ok", "tier": 2, "data": ["done"]},
            ]
            return 200, {"ok": False, "class": "pending", "job": "job-1", "retry": "no"}
        if op == "stuck":
            self.jobs["job-2"] = [{"ok": False, "class": "pending", "job": "job-2"}]
            return 200, {"ok": False, "class": "pending", "job": "job-2"}
        if op == "badargs":
            return 400, {"ok": False, "class": "input", "reason": "query: required", "retry": "after_fix"}
        if op == "badbody":
            return 400, {"error": "args must be an object"}
        if op == "busy":
            return 429, {"ok": False, "class": "rate", "reason": "server busy", "retryAfterMs": 2000}
        if op.startswith("fail-"):
            klass = op[len("fail-") :]
            return 200, {"ok": False, "class": klass, "reason": f"{klass} happened", **FAILURES.get(klass, {})}
        return 200, {
            "ok": True,
            "class": "ok",
            "tier": 1,
            "data": [{"title": "Hello", "points": 3}],
            "nextPage": 1,
            "hasMore": True,
            "echo": {"site": site, "op": op, **body},
        }


class _Handler(BaseHTTPRequestHandler):
    # headers and body go out in two writes; with Nagle on, each answer waits ~40 ms for a delayed ACK
    disable_nagle_algorithm = True

    def _handle(self) -> None:
        fake: FakeServer = self.server.fake  # type: ignore[attr-defined]
        split = urllib.parse.urlsplit(self.path)
        query = dict(urllib.parse.parse_qsl(split.query, keep_blank_values=True))
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        headers = {k.lower(): v for k, v in self.headers.items()}
        fake.requests.append(
            {
                "method": self.command,
                "path": split.path,
                "query": query,
                "headers": headers,
                "body": json.loads(raw) if raw else None,
            }
            if _is_json(raw)
            else {"method": self.command, "path": split.path, "query": query, "headers": headers, "body": raw}
        )
        status, payload = fake.answer(self.command, split.path, query, headers, raw)
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = _handle
    do_POST = _handle

    def log_message(self, *args: Any) -> None:
        pass


def _is_json(raw: bytes) -> bool:
    if not raw:
        return True
    try:
        json.loads(raw)
        return True
    except ValueError:
        return False


if __name__ == "__main__":
    # run as a fake `api-anything` executable: `serve [--port N] ...` prints the ready line and serves
    import os
    import signal
    import sys

    argv = sys.argv[1:]
    record = os.environ.get("FAKE_ARGV_FILE")
    if record:
        with open(record, "w", encoding="utf-8") as f:
            json.dump(argv, f)
    if os.environ.get("FAKE_EXIT"):
        print("serve: unknown command", file=sys.stderr)
        sys.exit(int(os.environ["FAKE_EXIT"]))
    home = os.environ["API_ANYTHING_HOME"]
    token_file = os.path.join(home, "serve-token")
    with open(token_file, "w", encoding="utf-8") as f:
        f.write(TOKEN + "\n")
    server = FakeServer(
        token=os.environ.get("API_ANYTHING_TOKEN") or TOKEN, version=os.environ.get("FAKE_VERSION", VERSION)
    )
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print("starting", file=sys.stderr, flush=True)
    print("npm notice: not json", flush=True)
    ready = {
        "ok": True,
        "version": server.version,
        "url": server.url,
        "mcp": server.url + "/mcp",
        "openapi": server.url + "/openapi.json",
        "tokenFile": token_file,
    }
    print(json.dumps(ready), flush=True)
    server.httpd.serve_forever()
