import os
import tempfile
import unittest
from unittest import mock

from .fake_server import FakeServer


class Isolated(unittest.TestCase):
    """No test reads the real ~/.api-anything or the shell's API_ANYTHING_* variables."""

    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix="aa-home-")
        env = {k: v for k, v in os.environ.items() if not k.startswith("API_ANYTHING_")}
        env["API_ANYTHING_HOME"] = self.home
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)


class WithFake(Isolated):
    allow_writes = False

    def setUp(self) -> None:
        super().setUp()
        self.fake = FakeServer(allow_writes=self.allow_writes).start()
        self.addCleanup(self.fake.stop)
