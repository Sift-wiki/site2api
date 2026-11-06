"""A call's answer: the server's JSON object, with its fields as attributes."""

from __future__ import annotations

from typing import Any, Dict, Generic, List, Optional, TypeVar

from .errors import BY_CLASS, CallError

T = TypeVar("T")


class Result(Dict[str, Any], Generic[T]):
    """The CallResult as the server sent it. It is a dict, so `result["class"]` and `json.dumps(result)` work.

    The attributes read the same keys: `klass` is `class`, `next_call` is `nextCall`, and so on. A key the
    server left out reads as None.
    """

    @property
    def raw(self) -> Dict[str, Any]:
        return dict(self)

    @property
    def ok(self) -> bool:
        return self.get("ok") is True

    @property
    def klass(self) -> Optional[str]:
        return self.get("class")

    @property
    def tier(self) -> Optional[int]:
        return self.get("tier")

    @property
    def data(self) -> T:
        return self.get("data")  # type: ignore[return-value]

    @property
    def reason(self) -> Optional[str]:
        return self.get("reason")

    @property
    def next(self) -> Optional[str]:
        return self.get("next")

    @property
    def retry(self) -> Optional[str]:
        return self.get("retry")

    @property
    def retry_after(self) -> Optional[float]:
        """`retryAfterMs` in seconds."""
        ms = self.get("retryAfterMs")
        return ms / 1000 if isinstance(ms, (int, float)) else None

    @property
    def next_call(self) -> Optional[Dict[str, Any]]:
        return self.get("nextCall")

    @property
    def next_request(self) -> Optional[Dict[str, Any]]:
        """`nextRequest`: the REST step to take next, `{method, path, body?}`, when the server has one."""
        return self.get("nextRequest")

    @property
    def next_page(self) -> Any:
        return self.get("nextPage")

    @property
    def has_more(self) -> Optional[bool]:
        return self.get("hasMore")

    @property
    def job(self) -> Optional[str]:
        return self.get("job")

    @property
    def more(self) -> Any:
        return self.get("more")

    @property
    def result_id(self) -> Optional[str]:
        return self.get("resultId")

    @property
    def cached(self) -> Optional[bool]:
        return self.get("cached")

    @property
    def changes(self) -> Any:
        return self.get("changes")

    @property
    def healed(self) -> Optional[bool]:
        return self.get("healed")

    @property
    def pending(self) -> bool:
        return self.get("class") == "pending"

    def raise_for_status(self) -> "Result[T]":
        """Return self when ok, else raise the exception for its class (AuthError, RateLimited, Drift, ...)."""
        if self.ok:
            return self
        raise BY_CLASS.get(self.klass or "", CallError)(self)

    def __repr__(self) -> str:
        return f"Result({dict.__repr__(self)})"


class BatchResult(Result[None]):
    """`{ok, results}` from a batch: `results` holds one Result per call, in input order."""

    @property
    def results(self) -> List[Result[Any]]:
        return [Result(r) for r in self.get("results") or []]
