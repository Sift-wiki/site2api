No account is needed. Paper licenses vary; check the license on each abstract page before reuse.

- `getPaper` accepts modern IDs such as `1706.03762` and legacy IDs such as `hep-th/9711200`.
  It returns one item. `versionUrl` identifies the version shown, usually the latest when no version
  is requested. Comments, journal reference and DOI can be absent. Authors use the citation metadata's
  surname-first format; subjects are page text.
- `searchPapers` defaults to all fields and the first 50 results in announcement-date order.
  Use `searchtype=author` for author search, `order` for sorting, and `start=50`, `100`, etc. for
  subsequent pages. An empty `order` selects relevance. The abstract is a search snippet and may
  contain a “More” marker.
- `listNew` returns the new-submissions section, excluding cross-lists and replacements. Its title
  and subject text retain the page's labels. The page changes on announcement days, and may limit
  long lists; api-anything may also truncate large responses.
- `listRecent` returns the first page of the category's recent submissions as served by arXiv.
  Its title and subject text retain the page's labels; lists change over time and may be truncated.

## Maintainer notes

Verified 2026-11-01, logged out. `verify arxiv` passed 5/5 cases at tier 1, including a nonexistent
paper and an empty search. A fresh home called `getPaper` at tier 1. Requests use arxiv.org's
server-rendered HTML, not the Atom API.

| op | request | learned examples | held-out comparison |
|---|---|---|---|
| `getPaper` | `GET /abs/<id>`, citation meta tags and abstract-page metadata | `1706.03762`, `1512.03385` | `2005.14165`, title and metadata; legacy `hep-th/9711200` also returned at tier 1 |
| `searchPapers` | `GET /search/?query=<q>&searchtype=all`, search result rows | `transformer`, `quantum error correction` | `residual learning`, result IDs and titles matched the page |
| `listNew` | `GET /list/<category>/new`, new-submissions section | `cs.LG`, `cs.CL` | `math.CO`, first title and category matched the page |

The page's no-results warning identifies an empty search. A missing paper returned HTTP 404. The
paper DOI selector returns the linked DOI rather than the adjacent tooltip text. `versionUrl` is
the page's Open Graph URL. The search page selected `-announced_date_first` by default, not
relevance. List pages can have separate new, cross-list and replacement sections; the recipe selects
the section headed “New submissions”.

### 2026-11-01 extension, logged out

`listRecent` was learned with `cs.LG` and `cs.CL`; held-out `math.CO` matched the live page's
first title and subjects. An empty home called `astro-ph` at tier 1. The recent page returned 50
items for the categories inspected.

The search page exposes the full `searchtype` and `order` enums in the spec, including empty
`order` for relevance. `Lee` searches with all fields versus author, announcement versus submission
order, and offsets 0 versus 50 produced different results. A held-out author search for `Smith`,
newest submission first at offset 50, matched the live page's first ID and title. An empty relevance
order also returned results. The initial author search for `transformer` at offset 50 was empty and
could not establish the short offset slot, so the learning examples were changed to `Lee`.

The final local spec passed `verify arxiv` 7/7 cases at tier 1, including the existing empty search
and a result check setting all three optional search parameters. Requests remain public HTML GETs.
A later attempt to verify a different title-search check timed out twice and then received HTTP 429
on search; that unverified check was not exported, and no further search requests were made.
