"""OpenAI Agents SDK tools: one `FunctionTool` per operation. Needs `openai-agents`."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Sequence

if TYPE_CHECKING:
    from ..client import Client


def tools(client: "Client", sites: Optional[Sequence[str]] = None, *, writes: bool = False) -> List[Any]:
    """FunctionTools for `Agent(tools=...)`. Each returns the call's result as JSON text, failures
    included, so the model can read `next`. A write, when `writes` is on, needs the run's approval."""
    try:
        from agents import FunctionTool
    except ImportError:
        raise ImportError(
            "api_anything.integrations.openai_agents needs openai-agents: pip install openai-agents"
        ) from None

    def make(name: str, description: str, schema: Any) -> Any:
        async def invoke(_ctx: Any, arguments: str) -> str:
            result = await asyncio.to_thread(client.run_tool, name, arguments)
            return json.dumps(result)

        # passed only for a write: SDKs before human-in-the-loop approvals have no such argument
        extra: Dict[str, Any] = {"needs_approval": True} if client._tool_index[name][2] else {}
        return FunctionTool(
            name=name,
            description=description,
            params_json_schema=schema,
            on_invoke_tool=invoke,
            # strict mode wants every property required; optional args are the norm here
            strict_json_schema=False,
            **extra,
        )

    return [
        make(t["name"], t["description"], t["parameters"]) for t in client.tools(sites, "json_schema", writes=writes)
    ]
