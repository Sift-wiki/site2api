"""LangChain and LangGraph tools: one `StructuredTool` per operation. Needs `langchain-core` 0.3 or newer."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, List, Optional, Sequence

if TYPE_CHECKING:
    from ..client import Client


def tools(client: "Client", sites: Optional[Sequence[str]] = None, *, writes: bool = False) -> List[Any]:
    """StructuredTools for `create_react_agent`, `bind_tools` or a ToolNode. Each returns the call's
    result as JSON text, failures included, so the model can read `next`."""
    try:
        from langchain_core.tools import StructuredTool
    except ImportError:
        raise ImportError(
            "api_anything.integrations.langchain needs langchain-core: pip install langchain-core"
        ) from None

    def make(name: str, description: str, schema: Any) -> Any:
        def run(**kwargs: Any) -> str:
            return json.dumps(client.run_tool(name, kwargs))

        async def arun(**kwargs: Any) -> str:
            return await asyncio.to_thread(run, **kwargs)

        return StructuredTool.from_function(
            func=run, coroutine=arun, name=name, description=description, args_schema=schema
        )

    return [
        make(t["name"], t["description"], t["parameters"]) for t in client.tools(sites, "json_schema", writes=writes)
    ]
