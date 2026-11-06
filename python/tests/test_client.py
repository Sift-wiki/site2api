import json
import os
import re
import socket
import unittest
from datetime import timedelta

import api_anything
from api_anything import (
    AuthError,
    BadRequest,
    Blocked,
    CallError,
    Client,
    Drift,
    Duplicate,
    InputError,
    NotFound,
    OperationError,
    Pending,
    RateLimited,
    Refused,
    Result,
    ServerUnavailable,
    Unauthorized,
)

from .fake_server import TOKEN
from .support import Isolated, WithFake


class TokenAndUrl(Isolated):
    def test_defaults(self) -> None:
        self.assertEqual(Client().base_url, "http://127.0.0.1:8787")
        os.environ["API_ANYTHING_URL"] = "http://127.0.0.1:9999/"
        self.assertEqual(Client().base_url, "http://127.0.0.1:9999")
        self.assertEqual(Client("http://localhost:1").base_url, "http://localhost:1")

    def test_token_precedence(self) -> None:
        self.assertIsNone(api_anything.default_token())
        with open(os.path.join(self.home, "serve-token"), "w") as f:
            f.write("from-file\n")
        self.assertEqual(api_anything.default_token(), "from-file")
        os.environ["API_ANYTHING_TOKEN"] = "from-env"
        self.assertEqual(api_anything.default_token(), "from-env")
        self.assertEqual(Client(token="explicit")._auth_token(), "explicit")

    def test_version_matches_pyproject(self) -> None:
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "..", "pyproject.toml"), encoding="utf-8") as f:
            version = re.search(r'^version = "([^"]+)"', f.read(), re.M)
        assert version is not None
        self.assertEqual(api_anything.__version__, version.group(1))


class Transport(WithFake):
    def client(self, **kw: object) -> Client:
        return Client(self.fake.url, token=TOKEN, **kw)  # type: ignore[arg-type]

    def test_health_needs_no_token(self) -> None:
        self.assertEqual(Client(self.fake.url).health(), {"ok": True, "version": "0.4.0"})
        self.assertNotIn("authorization", self.fake.last["headers"])

    def test_bearer_token_from_the_file(self) -> None:
        with open(os.path.join(self.home, "serve-token"), "w") as f:
            f.write(TOKEN)
        Client(self.fake.url).sites()
        self.assertEqual(self.fake.last["headers"]["authorization"], f"Bearer {TOKEN}")
        self.assertTrue(self.fake.last["headers"]["user-agent"].startswith("api-anything-python/"))

    def test_wrong_token(self) -> None:
        with self.assertRaises(Unauthorized) as e:
            Client(self.fake.url, token="wrong").sites()
        self.assertEqual(e.exception.status, 401)
        self.assertIn("API_ANYTHING_TOKEN", str(e.exception))

    def test_no_server(self) -> None:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        with self.assertRaises(ServerUnavailable) as e:
            Client(f"http://127.0.0.1:{port}", token=TOKEN).health()
        self.assertIn("api-anything serve", str(e.exception))

    def test_sites_operations_find(self) -> None:
        c = self.client()
        self.assertEqual([s["name"] for s in c.sites()], ["hacker-news", "forum"])
        ops = c.operations("hacker-news")
        self.assertEqual([o["name"] for o in ops["operations"]], ["frontPage", "search"])
        with self.assertRaises(NotFound):
            c.operations("a/b")
        self.assertEqual(self.fake.last["path"], "/v1/sites/a%2Fb")
        self.assertEqual(c.find("hn stories")["q"], "hn stories")
        self.assertEqual(self.fake.last["query"], {"q": "hn stories"})

    def test_call_body(self) -> None:
        r = self.client().call(
            "hacker-news",
            "search",
            {"query": "sqlite"},
            fields="title,points",
            max_chars=500,
            max_tier=2,
            max_age=timedelta(minutes=2),
            changes=True,
            changes_only=True,
        )
        self.assertEqual(self.fake.last["path"], "/v1/call/hacker-news/search")
        self.assertEqual(
            self.fake.last["body"],
            {
                "args": {"query": "sqlite"},
                "view": {"fields": ["title", "points"], "maxChars": 500},
                "maxTier": 2,
                "maxAgeMs": 120000,
                "changes": True,
                "changesOnly": True,
            },
        )
        self.assertIsInstance(r, Result)
        self.assertTrue(r.ok)
        self.assertEqual(r.klass, "ok")
        self.assertEqual(r["class"], "ok")
        self.assertEqual(r.tier, 1)
        self.assertEqual(r.data, [{"title": "Hello", "points": 3}])
        self.assertEqual((r.next_page, r.has_more), (1, True))
        self.assertEqual(r.raw["class"], "ok")
        self.assertIs(r.raise_for_status(), r)
        self.assertEqual(json.loads(json.dumps(r))["class"], "ok")

    def test_call_minimal_body(self) -> None:
        self.client().call("hacker-news", "frontPage", max_age=1.5, fields=["title"])
        self.assertEqual(self.fake.last["body"], {"view": {"fields": ["title"]}, "maxAgeMs": 1500})

    def test_pending_is_followed(self) -> None:
        r = self.client().call("hacker-news", "slow")
        self.assertTrue(r.ok)
        self.assertEqual(r.data, ["done"])
        paths = [q["path"] for q in self.fake.requests]
        self.assertEqual(paths, ["/v1/call/hacker-news/slow", "/v1/jobs/job-1", "/v1/jobs/job-1"])

    def test_pending_without_wait(self) -> None:
        r = self.client().call("hacker-news", "slow", wait=False)
        self.assertTrue(r.pending)
        self.assertEqual(r.job, "job-1")
        with self.assertRaises(Pending) as e:
            r.raise_for_status()
        self.assertEqual(e.exception.job, "job-1")
        self.assertEqual(self.client().job("job-1")["class"], "pending")
        self.assertTrue(self.client().job("job-1").ok)

    def test_pending_until_the_timeout(self) -> None:
        r = self.client(timeout=1).call("hacker-news", "stuck")
        self.assertTrue(r.pending)
        self.assertEqual(r.job, "job-2")
        self.assertGreater(len(self.fake.requests), 1)

    def test_classes_raise_their_exception(self) -> None:
        expected = {
            "auth": AuthError,
            "rate": RateLimited,
            "drift": Drift,
            "blocked": Blocked,
            "input": InputError,
            "error": OperationError,
            "refused": Refused,
            "duplicate": Duplicate,
            "something-new": CallError,
        }
        for klass, kind in expected.items():
            with self.subTest(klass=klass):
                r = self.client().call("forum", f"fail-{klass}")
                self.assertFalse(r.ok)
                self.assertEqual(r.reason, f"{klass} happened")
                with self.assertRaises(kind) as e:
                    r.raise_for_status()
                self.assertIs(type(e.exception), kind)
                self.assertIs(e.exception.result, r)
                self.assertEqual(e.exception.klass, klass)

    def test_rate_and_auth_details(self) -> None:
        r = self.client().call("forum", "fail-rate")
        self.assertEqual(r.retry, "after_wait")
        self.assertEqual(r.retry_after, 1.5)
        with self.assertRaises(RateLimited) as e:
            r.raise_for_status()
        self.assertEqual(e.exception.retry_after, 1.5)
        auth = self.client().call("forum", "fail-auth")
        self.assertEqual(auth.next_call, {"action": "login", "site": "forum"})
        with self.assertRaises(AuthError) as a:
            auth.raise_for_status()
        self.assertEqual(a.exception.next, "api-anything login forum")
        self.assertIn("api-anything login forum", str(a.exception))

    def test_bad_args_are_a_result_bad_body_raises(self) -> None:
        r = self.client().call("forum", "badargs", {"nope": 1})
        self.assertEqual(r.klass, "input")
        with self.assertRaises(InputError):
            r.raise_for_status()
        with self.assertRaises(BadRequest) as e:
            self.client().call("forum", "badbody")
        self.assertEqual(e.exception.status, 400)
        self.assertIn("args must be an object", str(e.exception))

    def test_write_off(self) -> None:
        r = self.client().write("forum", "postComment", {"text": "hi"})
        self.assertEqual((r.klass, r["write"]), ("refused", "not_sent"))
        self.assertEqual(self.fake.last["path"], "/v1/write/forum/postComment")

    def test_batch(self) -> None:
        r = self.client().batch(
            [
                ("hacker-news", "frontPage"),
                ("hacker-news", "search", {"query": "x"}),
                {"site": "forum", "op": "search", "id": "f"},
            ],
            concurrency=2,
        )
        self.assertEqual(
            self.fake.last["body"],
            {
                "calls": [
                    {"site": "hacker-news", "op": "frontPage"},
                    {"site": "hacker-news", "op": "search", "args": {"query": "x"}},
                    {"site": "forum", "op": "search", "id": "f"},
                ],
                "concurrency": 2,
            },
        )
        self.assertTrue(r.ok)
        self.assertEqual([x.data for x in r.results], [None, {"query": "x"}, None])
        self.assertIsInstance(r.results[0], Result)

    def test_result_view(self) -> None:
        r = self.client().result("res-1", offset=200, fields=["a", "b"], max_chars=100)
        self.assertEqual(self.fake.last["path"], "/v1/results/res-1")
        self.assertEqual(self.fake.last["query"], {"offset": "200", "fields": "a,b", "maxChars": "100"})
        self.assertEqual(r.result_id, "res-1")
        self.client().result("res-2")
        self.assertEqual(self.fake.last["query"], {})

    def test_learn(self) -> None:
        r = self.client().learn(trigger="https://example.com/s?q={q}", args={"q": "a"}, pickRequest=2)
        self.assertEqual(
            self.fake.requests[0]["body"],
            {"trigger": "https://example.com/s?q={q}", "args": {"q": "a"}, "pickRequest": 2},
        )
        self.assertTrue(r.ok)
        self.assertEqual(r["site"], "example")


class Writes(WithFake):
    allow_writes = True

    def test_write_body(self) -> None:
        c = Client(self.fake.url, token=TOKEN)
        r = c.write("forum", "postComment", {"text": "hi"}, again=True, idempotency_key="k1")
        self.assertEqual(self.fake.last["body"], {"args": {"text": "hi"}, "again": True, "idempotencyKey": "k1"})
        self.assertEqual(r["write"], "applied")


class NoRedirects(Isolated):
    def test_a_redirect_is_not_followed(self) -> None:
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        seen = []

        class Redirect(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                seen.append(self.path)
                self.send_response(302)
                self.send_header("location", "/elsewhere")
                self.send_header("content-length", "0")
                self.end_headers()

            def log_message(self, *a: object) -> None:
                pass

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        with self.assertRaises(api_anything.HTTPError) as e:
            Client(f"http://127.0.0.1:{httpd.server_address[1]}", token=TOKEN).sites()
        self.assertEqual(e.exception.status, 302)
        self.assertEqual(seen, ["/v1/sites"])


if __name__ == "__main__":
    unittest.main()
