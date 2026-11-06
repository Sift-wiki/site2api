import ast
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from api_anything import Client, Result
from api_anything.__main__ import main
from api_anything.codegen import generate, pascal, snake

from .fake_server import LISTINGS, TOKEN
from .support import WithFake

HERE = os.path.dirname(os.path.abspath(__file__))
INPUT = os.path.join(HERE, "golden", "books.json")
GOLDEN = os.path.join(HERE, "golden", "books_client.py")


def books() -> dict:
    with open(INPUT, encoding="utf-8") as f:
        return json.load(f)


def load(source: str, name: str) -> object:
    path = os.path.join(tempfile.mkdtemp(prefix="aa-gen-"), f"{name}.py")
    with open(path, "w", encoding="utf-8") as f:
        f.write(source)
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # get_type_hints resolves a class's annotations through sys.modules
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class Golden(unittest.TestCase):
    def test_matches_the_golden_file(self) -> None:
        source = generate(books())
        if os.environ.get("UPDATE_GOLDEN"):
            with open(GOLDEN, "w", encoding="utf-8", newline="\n") as f:
                f.write(source)
        with open(GOLDEN, encoding="utf-8", newline="") as f:
            self.assertEqual(source, f.read(), "regenerate with UPDATE_GOLDEN=1 if the change is intended")

    def test_deterministic(self) -> None:
        description = books()
        shuffled = {**description, "operations": list(reversed(description["operations"]))}
        self.assertEqual(generate(description), generate(json.loads(json.dumps(description))))
        self.assertEqual(generate(description), generate(shuffled))

    def test_no_examples_notes_or_writes(self) -> None:
        source = generate(books())
        self.assertNotIn("EXAMPLE-SENTINEL", source)
        self.assertNotIn("NOTE-SENTINEL", source)
        self.assertNotIn("post_review", source)
        self.assertNotIn("cookie", source.lower())

    def test_hostile_text_stays_in_the_docstring(self) -> None:
        source = generate(books())
        tree = ast.parse(source)
        functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
        self.assertEqual(sorted(functions), ["_call", "front_page", "get_book", "import_", "search_books"])
        doc = ast.get_docstring(functions["get_book"]) or ""
        self.assertIn('One book\'s page """ with quotes, a backslash \\ and a newline.', doc)
        hostile = {
            "site": "x",
            "operations": [{"name": "a", "description": '"""\nimport os; os.system("x")\n"""\\', "inputSchema": {}}],
        }
        tree = ast.parse(generate(hostile))
        statements = (ast.FunctionDef, ast.ImportFrom, ast.Assign, ast.AnnAssign, ast.ClassDef)
        self.assertEqual([n for n in tree.body[1:] if not isinstance(n, statements)], [])
        a = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "a"][0]
        self.assertIn('os.system("x")', ast.get_docstring(a) or "")
        self.assertEqual(len(a.body), 3)  # the docstring, args, return

    def test_names(self) -> None:
        self.assertEqual(snake("searchBooks"), "search_books")
        self.assertEqual(snake("getHTMLPage"), "get_html_page")
        self.assertEqual(snake("class"), "class_")
        self.assertEqual(snake("2fa"), "_2fa")
        self.assertEqual(pascal("search_books"), "SearchBooks")


class GeneratedModule(WithFake):
    def test_functions_call_through_the_client(self) -> None:
        module = load(generate(books()), "books_client_test")
        client = Client(self.fake.url, token=TOKEN)
        r = module.search_books(
            q="dune", sort_by="rating", from_="2020-01-01", client_=False, client=client, max_tier=2
        )  # type: ignore[attr-defined]
        self.assertIsInstance(r, Result)
        self.assertEqual(self.fake.last["path"], "/v1/call/books/searchBooks")
        self.assertEqual(
            self.fake.last["body"],
            {"args": {"q": "dune", "sortBy": "rating", "from": "2020-01-01", "client": False}, "maxTier": 2},
        )
        module.front_page(client=client)  # type: ignore[attr-defined]
        self.assertEqual(self.fake.last["body"], {})
        with self.assertRaises(TypeError):
            module.get_book("1", client=client)  # type: ignore[attr-defined]

    def test_default_client_reads_the_environment(self) -> None:
        module = load(generate(LISTINGS["hacker-news"]), "hn_client_test")
        os.environ["API_ANYTHING_URL"] = self.fake.url
        os.environ["API_ANYTHING_TOKEN"] = TOKEN
        self.assertTrue(module.search(query="sqlite").ok)  # type: ignore[attr-defined]
        self.assertEqual(self.fake.last["body"], {"args": {"query": "sqlite"}})

    def test_cli(self) -> None:
        out = os.path.join(tempfile.mkdtemp(prefix="aa-gen-"), "hn.py")
        os.environ["API_ANYTHING_TOKEN"] = TOKEN
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(main(["gen", "hacker-news", "-o", out, "--url", self.fake.url]), 0)
        with open(out, encoding="utf-8") as f:
            self.assertEqual(f.read(), generate(LISTINGS["hacker-news"]))
        stdout = io.StringIO()
        with redirect_stdout(stdout), mock.patch.dict(os.environ, {"API_ANYTHING_URL": self.fake.url}):
            self.assertEqual(main(["gen", "hacker-news"]), 0)
        self.assertEqual(stdout.getvalue(), generate(LISTINGS["hacker-news"]))
        with redirect_stderr(err):
            self.assertEqual(main(["gen", "nope", "--url", self.fake.url]), 1)
        self.assertIn("no site", err.getvalue())


class TypesResolve(unittest.TestCase):
    def test_annotations_evaluate(self) -> None:
        import typing

        module = load(generate(books()), "books_types_test")
        hints = typing.get_type_hints(module.search_books)  # type: ignore[attr-defined]
        self.assertIn("Literal", str(hints["sort_by"]))
        self.assertIn("SearchBooksItem", str(hints["return"]))
        item_hints = typing.get_type_hints(module.SearchBooksItem)  # type: ignore[attr-defined]
        self.assertEqual(item_hints["rating"], float)


if __name__ == "__main__":
    unittest.main()
