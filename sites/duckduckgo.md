`search(q)` returns the first page of ordinary web results, excluding cards marked as ads. The URL
is DuckDuckGo's click redirect, not necessarily the destination URL. A snippet may be absent.
Ranking and snippets can change with time and location.

`suggest(q)` returns search-box autocomplete suggestions. Neither operation requires a login.
Region, date filtering, pagination, instant answer panels, and writes are not covered.
Stop on a bot challenge or rate limit.

## Maintainer notes

Verified 2026-11-01 local time (captures dated 2026-11-02 UTC), signed out, with a separate
API_ANYTHING_HOME and no imported cookies.

| Operation | Request | Evidence |
| --- | --- | --- |
| `search(q)` | GET `html.duckduckgo.com/html/?q=...` | Python and Rust programming captures; held-out JavaScript programming page and tier-1 replay |
| `suggest(q)` | GET `duckduckgo.com/ac/?q=...&kl=wt-wt&vertical=homepage` | Homepage search-box captures for Python and Rust language; held-out JavaScript capture and tier-1 replay |

Search extracts visible cards under `#links`, excluding `result--ad`. The held-out replay returned
the same ten organic titles, redirect URLs and snippets as the captured page, with two results
reordered. Two ad cards on that page were excluded. The captured homepage request and replay
returned the same eight JavaScript suggestions.

The final exported spec passed all four `verify` cases at tier 1. An initially empty home also
returned both held-out queries at tier 1. Export with examples reported no warnings, and the
shared-spec vet returned no errors or warnings. The checks assert result presence, not ranking
or destination identity; the held-out comparisons supplied that evidence.

No anomaly page or CAPTCHA was observed. The initial homepage capture with `input[name=q]`
timed out because the search field is a textarea; using `textarea[name=q]` worked. Browser
capture stopped non-GET requests sent after the search-box step; none of those stopped requests
was learned. No result link was followed. The HTML page showed region and date controls, but
their effects were not tested, so they are not exposed.
