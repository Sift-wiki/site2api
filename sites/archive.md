No account is needed. Search returns the first page, up to 100 items; some metadata fields are
absent on individual items. Search expressions follow the Internet Archive's search syntax.

For Wayback summaries, `first` and `last` are timestamps in `YYYYMMDDhhmmss` form. Each entry
in `years` is an array of twelve monthly capture counts, January first; sum an array for the
year's total. Counts and search results can change.

## Maintainer notes

Verified 2026-11-01, logged out. Two examples per operation: `nasa` and `shakespeare` for
search, `https://example.com/` and `https://wikipedia.org/` for Wayback. The final bundled
spec passed `verify archive` (4 pass, 0 fail, 0 inconclusive), all tier 1. Calls from an empty
home succeeded at tier 1.

| op | frontend request | held-out comparison |
|---|---|---|
| `searchItems` | Search page GET `/services/search/beta/page_production/`, first page of 100 | `beethoven`: first result and fields matched the captured page request |
| `waybackSummary` | Wayback calendar page GET `/__wb/sparkline` | `https://iana.org/`: timestamps and monthly counts matched the captured page request |

The search page's generated tracking UID and Sentry tracing headers were removed from the
export, then the final spec was called and verified. The page itself also sent Sentry analytics.
The captured collection and media item pages did not request the complete `/metadata/<identifier>`
response, so no item operation is included. The calendar did request yearly capture data, but
learning the year parameter selected a request without that year and failed; no capture-list
operation is included. Pagination and media filters were not proven. No writes were attempted.
