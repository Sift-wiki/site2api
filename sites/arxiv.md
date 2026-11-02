No account is needed. Paper licenses vary; check the license on each abstract page before reuse.

- `getPaper` accepts modern IDs such as `1706.03762` and legacy IDs such as `hep-th/9711200`.
  It returns one item. `versionUrl` identifies the version shown, usually the latest when no version
  is requested. Comments, journal reference and DOI can be absent. Authors use the citation metadata's
  surname-first format; subjects are page text.
- `searchPapers` searches all fields, returning the first 50 results in the site's default
  announcement-date order. The abstract is a search snippet and may contain a “More” marker.
  Author-only search, ordering and pagination are not exposed.
- `listNew` returns the new-submissions section, excluding cross-lists and replacements. Its title
  and subject text retain the page's labels. The page changes on announcement days, and may limit
  long lists; api-anything may also truncate large responses.

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
