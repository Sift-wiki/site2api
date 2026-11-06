"""Exceptions: the server could not be reached or refused the request, or a call's class was not ok."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, Optional

if TYPE_CHECKING:
    from .result import Result


class ApiAnythingError(Exception):
    """Base of every exception this package raises."""


class ServerUnavailable(ApiAnythingError):
    """No api-anything server answered at the client's URL."""


class Timeout(ApiAnythingError):
    """The server did not answer within the client's timeout."""


class NodeNotFound(ApiAnythingError):
    """Neither `api-anything` nor `npx` is on PATH, so no server can be started."""


class ServerStartError(ApiAnythingError):
    """The server process exited, or did not say where it listens, before it was ready."""


class HTTPError(ApiAnythingError):
    """The server answered with an HTTP error: the request itself was wrong, not the site's answer."""

    def __init__(self, status: int, message: str, body: Any = None) -> None:
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.body = body


class BadRequest(HTTPError):
    """400: a malformed body or arguments."""


class Unauthorized(HTTPError):
    """401: the bearer token is missing or wrong."""


class Forbidden(HTTPError):
    """403: the server does not allow this, such as a write on a server started without --allow-writes."""


class NotFound(HTTPError):
    """404: no such route, site, operation, job or result."""


class CallError(ApiAnythingError):
    """A call ran and its class was not ok. `result` is the whole answer; `next` says what to do."""

    def __init__(self, result: "Result[Any]") -> None:
        reason = result.reason or result.klass or "call failed"
        message = f"{result.klass}: {reason}"
        if result.next:
            message += f" (next: {result.next})"
        super().__init__(message)
        self.result = result

    @property
    def klass(self) -> Optional[str]:
        return self.result.klass

    @property
    def reason(self) -> Optional[str]:
        return self.result.reason

    @property
    def next(self) -> Optional[str]:
        return self.result.next

    @property
    def next_call(self) -> Optional[Dict[str, Any]]:
        return self.result.next_call

    @property
    def retry(self) -> Optional[str]:
        return self.result.retry


class AuthError(CallError):
    """class auth: the site wants a sign-in. `next` names the login step."""


class RateLimited(CallError):
    """class rate: the site is limiting calls. Wait `retry_after` seconds (None when the site did not say)."""

    @property
    def retry_after(self) -> Optional[float]:
        return self.result.retry_after


class Drift(CallError):
    """class drift: the site changed and the operation could not repair itself."""


class Blocked(CallError):
    """class blocked: a bot wall or a tier above the allowed cap."""


class InputError(CallError):
    """class input: the arguments do not fit the operation. `reason` gives the format."""


class OperationError(CallError):
    """class error: the site or the server failed in a way no other class describes."""


class Refused(CallError):
    """class refused: api-anything would not send it, such as a write without permission."""


class Duplicate(CallError):
    """class duplicate: the same write was sent within 10 minutes; pass again=True to send it anyway."""


class Pending(CallError):
    """class pending: the call is still running. `job` is the id to pass to Client.job()."""

    @property
    def job(self) -> Optional[str]:
        return self.result.job


BY_CLASS = {
    "auth": AuthError,
    "rate": RateLimited,
    "drift": Drift,
    "blocked": Blocked,
    "input": InputError,
    "error": OperationError,
    "refused": Refused,
    "duplicate": Duplicate,
    "pending": Pending,
}
