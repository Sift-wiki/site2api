"""Start `api-anything serve` as a child process and stop it again."""

from __future__ import annotations

import atexit
import collections
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
from typing import IO, Any, Deque, Dict, List, Mapping, Optional, Sequence, Tuple

from ._version import MIN_SERVER_VERSION
from .client import Client
from .errors import NodeNotFound, ServerStartError

INSTALL_NODE = (
    "api-anything runs on Node.js 22.13 or newer, and neither `api-anything` nor `npx` is on PATH. "
    "Install Node from https://nodejs.org (or `brew install node`, or your package manager), then "
    "`npm install -g api-anything`; or pass command=[...] to name the api-anything command yourself."
)


def _version_tuple(version: str) -> Optional[Tuple[int, ...]]:
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)", version)
    return tuple(int(x) for x in m.groups()) if m else None


def resolve_command(env: Mapping[str, str], npm_version: str = "latest") -> Tuple[List[str], str]:
    """The command that runs api-anything, and where it came from: "path" or "npx"."""
    path = env.get("PATH")
    found = shutil.which("api-anything", path=path)
    if found:
        return [found], "path"
    npx = shutil.which("npx", path=path)
    if npx:
        return [npx, "-y", f"api-anything@{npm_version}"], "npx"
    raise NodeNotFound(INSTALL_NODE)


class Server:
    """A local `api-anything serve`, started on a free port.

    The command is `command` when given (e.g. `["node", "dist/cli.js"]`), else `api-anything` from PATH,
    else `npx -y api-anything@<npm_version>`. `env` adds variables to the child's environment, such as
    `API_ANYTHING_HOME`. `startup_timeout` covers npx's first download. Use it as a context manager, or
    call `start()` and `stop()`.
    """

    def __init__(
        self,
        *,
        command: Optional[Sequence[str]] = None,
        host: Optional[str] = None,
        port: int = 0,
        allow_writes: bool = False,
        sites: Optional[Sequence[str]] = None,
        no_learn: bool = False,
        npm_version: str = "latest",
        env: Optional[Mapping[str, str]] = None,
        startup_timeout: float = 180,
    ) -> None:
        self.env: Dict[str, str] = {**os.environ, **(env or {})}
        if command is not None:
            self.command, self.source = list(command), "command"
        else:
            self.command, self.source = resolve_command(self.env, npm_version)
        flags = ["serve", "--port", str(port)]
        if host:
            flags += ["--host", host]
        if allow_writes:
            flags.append("--allow-writes")
        if sites:
            flags += ["--sites", ",".join(sites)]
        if no_learn:
            flags.append("--no-learn")
        self.argv = self.command + flags
        self.startup_timeout = startup_timeout
        self.process: Optional[subprocess.Popen[bytes]] = None
        self.info: Dict[str, Any] = {}
        self.token: Optional[str] = None
        self._stderr: Deque[str] = collections.deque(maxlen=200)
        self._stderr_thread: Optional[threading.Thread] = None

    @property
    def url(self) -> str:
        return str(self.info["url"])

    @property
    def mcp_url(self) -> Optional[str]:
        return self.info.get("mcp")

    @property
    def openapi_url(self) -> Optional[str]:
        return self.info.get("openapi")

    @property
    def version(self) -> Optional[str]:
        return self.info.get("version")

    @property
    def token_file(self) -> Optional[str]:
        return self.info.get("tokenFile")

    def logs(self) -> str:
        """The last lines the server wrote to stderr."""
        return "".join(self._stderr)

    def client(self, timeout: float = 60) -> Client:
        if not self.info:
            raise ServerStartError("the server is not started: call start() first")
        return Client(self.url, token=self.token, timeout=timeout)

    def start(self) -> "Server":
        if self.process is not None:
            return self
        posix = os.name == "posix"
        try:
            self.process = subprocess.Popen(
                self.argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=self.env,
                # its own process group, so stop() also ends the node that npx starts
                start_new_session=posix,
                creationflags=0 if posix else getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            )
        except FileNotFoundError:
            raise NodeNotFound(f"{self.argv[0]} was not found. {INSTALL_NODE}") from None
        atexit.register(self.stop)
        lines: "queue.Queue[Optional[str]]" = queue.Queue()
        assert self.process.stdout is not None and self.process.stderr is not None
        threading.Thread(target=self._read_stdout, args=(self.process.stdout, lines), daemon=True).start()
        self._stderr_thread = threading.Thread(target=self._read_stderr, args=(self.process.stderr,), daemon=True)
        self._stderr_thread.start()
        try:
            self.info = self._await_ready(lines)
            self.token = self._read_token()
        except BaseException:
            self.stop()
            raise
        return self

    def _read_stdout(self, stream: IO[bytes], lines: "queue.Queue[Optional[str]]") -> None:
        # keeps draining after the ready line, so a chatty server never blocks on a full pipe
        try:
            for raw in iter(stream.readline, b""):
                lines.put(raw.decode("utf-8", errors="replace"))
        except (OSError, ValueError):  # closed by stop()
            pass
        lines.put(None)

    def _read_stderr(self, stream: IO[bytes]) -> None:
        try:
            for raw in iter(stream.readline, b""):
                self._stderr.append(raw.decode("utf-8", errors="replace"))
        except (OSError, ValueError):
            pass

    def _await_ready(self, lines: "queue.Queue[Optional[str]]") -> Dict[str, Any]:
        deadline = time.monotonic() + self.startup_timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ServerStartError(
                    f"`{' '.join(self.argv)}` did not report where it listens within {self.startup_timeout:g} s."
                    f"{self._tail()}"
                )
            try:
                line = lines.get(timeout=min(remaining, 0.5))
            except queue.Empty:
                continue
            if line is None:
                assert self.process is not None
                code = self.process.wait()
                if self._stderr_thread is not None:
                    self._stderr_thread.join(2)  # its last lines explain the exit
                raise ServerStartError(
                    f"`{' '.join(self.argv)}` exited with code {code} before it was ready.{self._hint()}{self._tail()}"
                )
            try:
                info = json.loads(line)
            except ValueError:
                continue
            if isinstance(info, dict) and info.get("ok") and isinstance(info.get("url"), str):
                self._check_version(info.get("version"))
                return info

    def _check_version(self, version: Any) -> None:
        have = _version_tuple(version) if isinstance(version, str) else None
        want = _version_tuple(MIN_SERVER_VERSION)
        if have is not None and want is not None and have < want:
            raise ServerStartError(
                f"api-anything {version} is older than {MIN_SERVER_VERSION}, which this client needs: "
                "npm install -g api-anything@latest"
            )

    def _read_token(self) -> Optional[str]:
        token = self.env.get("API_ANYTHING_TOKEN")
        if token:
            return token
        path = self.info.get("tokenFile")
        if not path:
            return None
        try:
            with open(path, encoding="utf-8") as f:
                return f.read().strip() or None
        except OSError as e:
            raise ServerStartError(f"the server's token file {path} could not be read: {e}") from None

    def _hint(self) -> str:
        if self.source == "path":
            return (
                f" An api-anything older than {MIN_SERVER_VERSION} has no `serve` command: check "
                "`api-anything --version`, then `npm install -g api-anything@latest`."
            )
        return ""

    def _tail(self) -> str:
        tail = "".join(list(self._stderr)[-20:]).strip()
        return f"\nIts stderr:\n{tail}" if tail else ""

    def stop(self, timeout: float = 5) -> None:
        """Stop the server and wait for it to exit. Safe to call twice."""
        process, self.process = self.process, None
        atexit.unregister(self.stop)
        if process is None:
            return
        if process.poll() is None:
            self._signal(process, signal.SIGTERM)
            try:
                process.wait(timeout)
            except subprocess.TimeoutExpired:
                self._signal(process, getattr(signal, "SIGKILL", signal.SIGTERM))
                process.wait(timeout)
        elif os.name == "posix":
            # the npx wrapper may have exited while the node it started still runs
            self._signal(process, signal.SIGTERM)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()

    @staticmethod
    def _signal(process: "subprocess.Popen[bytes]", sig: int) -> None:
        try:
            if os.name == "posix":
                os.killpg(process.pid, sig)
            elif sig == signal.SIGTERM:
                process.terminate()
            else:
                process.kill()
        except (ProcessLookupError, PermissionError, OSError):
            pass

    def __enter__(self) -> "Server":
        return self.start()

    def __exit__(self, *exc: Any) -> None:
        self.stop()

    def __repr__(self) -> str:
        return f"Server({self.info.get('url', 'not started')!r})"
