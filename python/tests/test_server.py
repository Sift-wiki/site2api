import json
import os
import stat
import sys
import tempfile
import unittest

from api_anything import Client, NodeNotFound, Server, ServerStartError

from .fake_server import TOKEN
from .support import Isolated

PYTHON_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def fake_command(directory: str, name: str) -> str:
    """An executable `name` in `directory` that behaves as `api-anything serve` (tests/fake_server.py)."""
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(
            f"#!{sys.executable}\n"
            "import runpy, sys\n"
            f"sys.path.insert(0, {PYTHON_DIR!r})\n"
            "runpy.run_module('tests.fake_server', run_name='__main__')\n"
        )
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


@unittest.skipUnless(os.name == "posix", "the fake executables are shebang scripts")
class Spawn(Isolated):
    def setUp(self) -> None:
        super().setUp()
        self.bin = tempfile.mkdtemp(prefix="aa-bin-")
        self.argv_file = os.path.join(self.home, "argv.json")
        self.env = {"PATH": self.bin, "API_ANYTHING_HOME": self.home, "FAKE_ARGV_FILE": self.argv_file}

    def argv(self) -> list:
        with open(self.argv_file, encoding="utf-8") as f:
            return json.load(f)

    def test_api_anything_on_path(self) -> None:
        fake_command(self.bin, "api-anything")
        fake_command(self.bin, "npx")
        with Server(env=self.env, allow_writes=True, sites=["a", "b"], no_learn=True, host="127.0.0.1") as server:
            self.assertEqual(server.source, "path")
            self.assertEqual(server.token, TOKEN)
            self.assertEqual(server.version, "0.4.0")
            self.assertTrue(server.url.startswith("http://127.0.0.1:"))
            self.assertEqual(server.mcp_url, server.url + "/mcp")
            self.assertEqual(server.openapi_url, server.url + "/openapi.json")
            self.assertEqual(server.token_file, os.path.join(self.home, "serve-token"))
            client = server.client()
            self.assertEqual(client.health()["ok"], True)
            self.assertEqual(len(client.sites()), 2)
            process = server.process
            assert process is not None
            self.assertIn("starting", server.logs())
        self.assertEqual(
            self.argv(),
            ["serve", "--port", "0", "--host", "127.0.0.1", "--allow-writes", "--sites", "a,b", "--no-learn"],
        )
        self.assertIsNotNone(process.poll())
        self.assertIsNone(server.process)
        server.stop()  # a second stop is harmless

    def test_npx_when_not_installed(self) -> None:
        fake_command(self.bin, "npx")
        server = Server(env=self.env).start()
        try:
            self.assertEqual(server.source, "npx")
            self.assertEqual(server.client().operations("hacker-news")["site"], "hacker-news")
        finally:
            server.stop()
        self.assertEqual(self.argv(), ["-y", "api-anything@latest", "serve", "--port", "0"])
        self.assertEqual(Server(env=self.env, npm_version="0.4.1").argv[2], "api-anything@0.4.1")

    def test_client_start(self) -> None:
        fake_command(self.bin, "api-anything")
        with Client.start(env=self.env, timeout=5) as client:
            self.assertEqual(client.timeout, 5)
            self.assertTrue(client.call("hacker-news", "search", {"query": "x"}).ok)
            server = client.server
            assert server is not None and server.process is not None
            process = server.process
        self.assertIsNotNone(process.poll())
        self.assertIsNone(client.server)

    def test_token_from_the_environment(self) -> None:
        fake_command(self.bin, "api-anything")
        with Server(env={**self.env, "API_ANYTHING_TOKEN": "env-token"}) as server:
            self.assertEqual(server.token, "env-token")
            self.assertEqual(len(server.client().sites()), 2)

    def test_explicit_command(self) -> None:
        path = fake_command(self.bin, "anything-else")
        with Server(command=[path], env={"API_ANYTHING_HOME": self.home, "FAKE_ARGV_FILE": self.argv_file}) as server:
            self.assertEqual(server.source, "command")
            self.assertTrue(server.client().health()["ok"])

    def test_no_node(self) -> None:
        with self.assertRaises(NodeNotFound) as e:
            Server(env={"PATH": self.bin})
        self.assertIn("https://nodejs.org", str(e.exception))
        self.assertIn("npm install -g api-anything", str(e.exception))

    def test_exits_before_ready(self) -> None:
        fake_command(self.bin, "api-anything")
        with self.assertRaises(ServerStartError) as e:
            Server(env={**self.env, "FAKE_EXIT": "1"}).start()
        message = str(e.exception)
        self.assertIn("exited with code 1", message)
        self.assertIn("serve: unknown command", message)
        self.assertIn("npm install -g api-anything@latest", message)

    def test_too_old(self) -> None:
        fake_command(self.bin, "api-anything")
        server = Server(env={**self.env, "FAKE_VERSION": "0.3.2"})
        with self.assertRaises(ServerStartError) as e:
            server.start()
        self.assertIn("0.3.2 is older than 0.4.0", str(e.exception))
        self.assertIsNone(server.process)

    def test_startup_timeout(self) -> None:
        path = os.path.join(self.bin, "api-anything")
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\nimport time\ntime.sleep(30)\n")
        os.chmod(path, 0o755)
        server = Server(env=self.env, startup_timeout=0.5)
        with self.assertRaises(ServerStartError) as e:
            server.start()
        self.assertIn("did not report where it listens", str(e.exception))
        self.assertIsNone(server.process)


if __name__ == "__main__":
    unittest.main()
