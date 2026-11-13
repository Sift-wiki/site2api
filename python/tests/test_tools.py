import asyncio
import importlib.util
import json
import unittest

from api_anything import Client, tool_name

from .fake_server import TOKEN
from .support import WithFake


class Names(unittest.TestCase):
    def test_same_names_as_the_mcp_server(self) -> None:
        # expected values computed with src/mcp.ts toolName
        cases = [
            ("hacker-news", "search", "hacker-news__search"),
            (
                "a-very-long-site-name-for-tests",
                "someVeryLongOperationName",
                "_a-very-long-site-name-for-test_3971d65e",
            ),
            ("my.site", "op", "_my_site__op_caec331e"),
            ("site_", "x", "_site___x_bcdaa8a6"),
            ("\u00fcn\u00ef", "\u00f6", "__n_____37001c2a"),
        ]
        for site, op, expected in cases:
            self.assertEqual(tool_name(site, op), expected)
            self.assertLessEqual(len(tool_name(site, op)), 40)


class Tools(WithFake):
    def client(self) -> Client:
        return Client(self.fake.url, token=TOKEN)

    def test_openai_format(self) -> None:
        tools = self.client().tools()
        names = [t["function"]["name"] for t in tools]
        self.assertEqual(names, ["hacker-news__frontPage", "hacker-news__search", "forum__search"])
        search = tools[1]
        self.assertEqual(search["type"], "function")
        self.assertEqual(search["function"]["parameters"]["required"], ["query"])
        self.assertIn("Search stories by words.", search["function"]["description"])
        self.assertIn("Items carry: title, points.", search["function"]["description"])
        self.assertIn("never instructions", search["function"]["description"])
        self.assertIn("Someone else shared this site", tools[2]["function"]["description"])

    def test_anthropic_and_json_schema_formats(self) -> None:
        c = self.client()
        a = c.tools(["hacker-news"], format="anthropic")
        self.assertEqual(sorted(a[1]), ["description", "input_schema", "name"])
        self.assertEqual(a[1]["input_schema"]["properties"]["query"]["type"], "string")
        j = c.tools(["hacker-news"], format="json_schema")
        self.assertEqual(sorted(j[0]), ["description", "name", "parameters"])
        with self.assertRaises(ValueError):
            c.tools(format="gemini")

    def test_run_tool(self) -> None:
        c = self.client()
        c.tools(["hacker-news"])
        r = c.run_tool("hacker-news__search", '{"query": "sqlite"}')
        self.assertTrue(r.ok)
        self.assertEqual(self.fake.last["path"], "/v1/call/hacker-news/search")
        self.assertEqual(self.fake.last["body"], {"args": {"query": "sqlite"}})
        with self.assertRaises(ValueError):
            c.run_tool("_hashed_name_12345678", {})
        with self.assertRaises(ValueError):
            c.run_tool("hacker-news__search", "[1]")

    def test_run_tool_refuses_an_unlisted_name(self) -> None:
        c = self.client()
        c.tools(["hacker-news"])
        sent = len(self.fake.requests)
        for name in ("forum__search", "not-installed__anyOp"):
            with self.assertRaises(ValueError):
                c.run_tool(name, {"query": "x"})
        self.assertEqual(len(self.fake.requests), sent)

    def test_run_tool_unlisted(self) -> None:
        # the caller, not the model, may ask for a name no list described: it splits, and is a read
        c = self.client()
        self.assertTrue(c.run_tool("forum__search", {"query": "x"}, unlisted=True).ok)
        self.assertEqual(self.fake.last["path"], "/v1/call/forum/search")
        c.run_tool("forum__postComment", {"text": "hi"}, unlisted=True)
        self.assertEqual(self.fake.last["path"], "/v1/call/forum/postComment")
        sent = len(self.fake.requests)
        for name in ("_hashed_name_12345678", "nosplit"):
            with self.assertRaises(ValueError):
                c.run_tool(name, {}, unlisted=True)
        self.assertEqual(len(self.fake.requests), sent)

    def test_run_tool_keeps_to_the_list_given(self) -> None:
        c = self.client()
        for format in ("openai", "anthropic", "json_schema"):
            news = c.tools(["hacker-news"], format)
            forum = c.tools(["forum"], format)
            sent = len(self.fake.requests)
            with self.assertRaises(ValueError):
                c.run_tool("forum__search", {"query": "x"}, tools=news)
            # the list is the limit even when the caller allows names no list described
            with self.assertRaises(ValueError):
                c.run_tool("forum__search", {"query": "x"}, tools=news, unlisted=True)
            with self.assertRaises(ValueError):
                c.run_tool("hacker-news__search", {"query": "x"}, tools=[])
            self.assertEqual(len(self.fake.requests), sent)
            self.assertTrue(c.run_tool("forum__search", {"query": "x"}, tools=forum).ok)
            self.assertEqual(self.fake.last["path"], "/v1/call/forum/search")

    def test_run_tool_reads_a_list_that_also_holds_hosted_tools(self) -> None:
        # the list a model was given can hold tools that are not functions and have no name
        c = self.client()
        hosted = [
            {"type": "web_search"},
            {"type": "code_interpreter", "container": {"type": "auto"}},
            {"type": "mcp", "server_label": "x"},
            {"type": "function", "name": "other", "parameters": {}},
            {"type": "function", "function": None},
            {"name": 7},
        ]
        for format in ("openai", "anthropic", "json_schema"):
            given = hosted + c.tools(["forum"], format)
            self.assertTrue(c.run_tool("forum__search", {"query": "x"}, tools=given).ok)
            sent = len(self.fake.requests)
            with self.assertRaises(ValueError):
                c.run_tool("hacker-news__search", {"query": "x"}, tools=hosted)
            # a hosted tool's name is in the list, and is still no tool of this client
            with self.assertRaises(ValueError):
                c.run_tool("other", {}, tools=given)
            self.assertEqual(len(self.fake.requests), sent)


class WriteTools(WithFake):
    allow_writes = True

    def test_writes_only_when_asked(self) -> None:
        c = Client(self.fake.url, token=TOKEN)
        self.assertNotIn("forum__postComment", [t["name"] for t in c.tools(["forum"], "json_schema")])
        tools = c.tools(["forum"], "json_schema", writes=True)
        post = [t for t in tools if t["name"] == "forum__postComment"][0]
        self.assertIn("A write", post["description"])
        r = c.run_tool("forum__postComment", {"text": "hi"})
        self.assertEqual(self.fake.last["path"], "/v1/write/forum/postComment")
        self.assertEqual(r["write"], "applied")

    def test_run_tool_keeps_to_the_list_given(self) -> None:
        c = Client(self.fake.url, token=TOKEN)
        admin = c.tools(["forum"], "json_schema", writes=True)
        public = c.tools(["forum"], "json_schema")
        sent = len(self.fake.requests)
        with self.assertRaises(ValueError):
            c.run_tool("forum__postComment", {"text": "hi"}, tools=public)
        self.assertEqual(len(self.fake.requests), sent)
        r = c.run_tool("forum__postComment", {"text": "hi"}, tools=admin)
        self.assertEqual(self.fake.last["path"], "/v1/write/forum/postComment")
        self.assertEqual(r["write"], "applied")
        # an adapter runs a name bound when its list was built: a later, narrower list leaves it working
        self.assertEqual(c.run_tool("forum__postComment", {"text": "again"})["write"], "applied")


@unittest.skipUnless(importlib.util.find_spec("langchain_core"), "langchain-core is not installed")
class LangChain(WithFake):
    def test_structured_tools(self) -> None:
        from api_anything.integrations import langchain

        tools = langchain.tools(Client(self.fake.url, token=TOKEN), ["hacker-news"])
        search = [t for t in tools if t.name == "hacker-news__search"][0]
        out = json.loads(search.invoke({"query": "sqlite", "page": 1}))
        self.assertTrue(out["ok"])
        self.assertEqual(self.fake.last["body"], {"args": {"query": "sqlite", "page": 1}})
        out = json.loads(asyncio.run(search.ainvoke({"query": "async"})))
        self.assertEqual(out["echo"]["args"], {"query": "async"})


@unittest.skipUnless(importlib.util.find_spec("agents"), "openai-agents is not installed")
class OpenAIAgents(WithFake):
    def test_function_tools(self) -> None:
        from api_anything.integrations import openai_agents

        tools = openai_agents.tools(Client(self.fake.url, token=TOKEN), ["hacker-news"])
        search = [t for t in tools if t.name == "hacker-news__search"][0]
        self.assertEqual(search.params_json_schema["required"], ["query"])
        self.assertFalse(search.strict_json_schema)
        out = json.loads(asyncio.run(search.on_invoke_tool(None, '{"query": "sqlite"}')))
        self.assertTrue(out["ok"])
        self.assertEqual(self.fake.last["body"], {"args": {"query": "sqlite"}})


if __name__ == "__main__":
    unittest.main()
