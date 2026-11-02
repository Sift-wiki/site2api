No account is needed. English Wikipedia only (en.wikipedia.org).

- `searchArticles` matches titles by prefix, like the search box: use it to turn a name into an
  article `key`. For a topic rather than a name, use `searchText`.
- `getSummary` takes the `key` from `searchArticles` (`Ada_Lovelace`). A title that redirects
  (`USA`) answers with the target article (`United States`). A title that doesn't exist answers `class: "input"`.
- A `getSummary` with `type: "disambiguation"` is a page listing several meanings: its `extract`
  says little. Search again with a more specific title.
- `searchText` returns page 1 only (20 hits). `url` is the full article link; the article `key` is
  its last path segment.
- `getSections` reads the article's displayed table of contents. The first entry is the unnumbered
  top of the page; numbered entries use display numbers such as `3.2`, not MediaWiki API section
  indexes. Their depth indicates the nesting level, and the anchor is a link to that heading.
- `getCategories` reads visible categories, not hidden maintenance categories.
- Wikipedia article text is generally available under CC BY-SA; check the page's attribution and
  licensing requirements before reuse.

## Maintainer notes

Verified 2026-10-31, logged out, from a clean `API_ANYTHING_HOME`: `api-anything verify wikipedia`
passed 5 of 5 cases (each op's example, plus an `empty` check for `searchText` and an `input` check
for a missing page in `getSummary`). Every call answered at tier 1 (plain HTTP).

| op | how it was learned | checked with (not an example) | tier |
|---|---|---|---|
| `searchArticles` | typing into the search box on the Main Page fires `GET /w/rest.php/v1/search/title?q=...&limit=10` | `q="ada love"` (Ada Lovelace first) | 1, about 0.4 s |
| `getSummary` | `GET /api/rest_v1/page/summary/<title>`, the endpoint the page previews (link hover cards) call; the trigger opens that URL directly, since the trigger steps can't hover | `title=Ada_Lovelace`, `title=Grace Hopper` (with a space), `title=USA` (redirect), `title=Mercury` (disambiguation) | 1, about 0.4-0.7 s |
| `searchText` | the server-rendered `Special:Search` page (`fulltext=1` so an exact title does not jump to the article; `ns0=1` for articles only), read with an HTML recipe | `q="tidal locking moon"` (Tidal locking first); `q=zzqqxxwvnothingmatch` gives `[]` | 1, about 1.5 s |

The `empty` element of the `searchText` recipe is `p.mw-search-nonefound`, the "There were no
results" message.

### 2026-11-01, logged out

Captured the actual server-rendered article documents for Ada Lovelace and Python (programming
language), and compared the held-out Moon results with its captured page. `getSections` reads the
desktop table of contents, and `getCategories` reads the visible category list. Both answered at
tier 1 in the learning home and in a fresh home. The final spec passed `verify wikipedia`: 9
passed, 0 failed, 0 inconclusive.

An infobox recipe was not included: on Moon, nested rows produced misleading pairs and flattening
superscripts changed scientific notation. Full article/section text, article links, revision
history and the featured feed were not captured or verified in this pass.
