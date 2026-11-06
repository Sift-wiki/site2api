"""Call websites as APIs from Python, through a running `api-anything serve`."""

from ._version import __version__
from .client import Client, default_token
from .errors import (
    ApiAnythingError,
    AuthError,
    BadRequest,
    Blocked,
    CallError,
    Drift,
    Duplicate,
    Forbidden,
    HTTPError,
    InputError,
    NodeNotFound,
    NotFound,
    OperationError,
    Pending,
    RateLimited,
    Refused,
    ServerStartError,
    ServerUnavailable,
    Timeout,
    Unauthorized,
)
from .result import BatchResult, Result
from .server import Server
from .tools import tool_name

__all__ = [
    "__version__",
    "ApiAnythingError",
    "AuthError",
    "BadRequest",
    "BatchResult",
    "Blocked",
    "CallError",
    "Client",
    "Drift",
    "Duplicate",
    "Forbidden",
    "HTTPError",
    "InputError",
    "NodeNotFound",
    "NotFound",
    "OperationError",
    "Pending",
    "RateLimited",
    "Refused",
    "Result",
    "Server",
    "ServerStartError",
    "ServerUnavailable",
    "Timeout",
    "Unauthorized",
    "default_token",
    "tool_name",
]
