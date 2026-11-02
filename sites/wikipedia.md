No account is needed. English Wikipedia only. Text is CC BY-SA: attribute on reuse. Long results
(text, links, languages) can be truncated: check `truncated` and use `more`.

- `searchArticles` matches titles by prefix, giving an article `key` (`Ada_Lovelace`) for the
  other ops; for a topic, use `searchText` (page 1, 20 hits; the `key` ends its `url`).
- `getSummary` follows redirects (`USA` -> `United States`); a missing title answers `input`.
  `type: "disambiguation"` means a page of meanings: search with a more specific title.
- `getSections`: the displayed table of contents; the first entry is the unnumbered top, and
  numbers like `3.2` are display numbers, not API section indexes.
- `getCategories`: visible categories only.
- `getArticleText`: paragraphs in order, no headings, tables or lists; may include empty
  paragraphs and citation markers.
- `getLinks`: titled links in paragraphs (not navboxes); may repeat or leave the article namespace.
- `getRevisions`: the first history page (about 50); dates and byte changes are display strings;
  anonymous editors appear as IPs.
- `getMainPage`: today's Main Page by section (`mp-tfa` featured article, `mp-itn` news,
  `mp-otd` anniversaries, `mp-dyk` facts); items are plain text.
- `getLanguages`: language names in their own language; codes need not match subdomains. A page
  with no language links may answer drift instead of an empty list.

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

### 2026-11-01, logged out: article text, links and history

Captured the article documents and history pages for Ada Lovelace and Python (programming
language), then compared calls for the held-out Moon with its captured documents. The text and
links use the rendered article's paragraph elements; history uses the page's displayed entries.
The Main Page capture did not show a featured-feed request, so no feed operation was added.
Section text was not added: the desktop document does not fetch sections independently and the
table-of-contents display numbers are not API section indexes. The first attempt at a direct
paragraph/heading selector matched nothing; the working recipe reads paragraph descendants.

### 2026-11-01, logged out: Main Page and languages

The mobile Main Page redirected to the desktop Main Page and its capture did not show the featured
feed, so the operation reads the server-rendered current page, not past dates. The four sections
matched the captured document; list extraction uses direct child lists to omit navigation and
ongoing-events lists. The featured article link comes from the first bold link in its paragraph.

`getLanguages` reads `.interlanguage-link a` on captured Ada Lovelace and Python (programming
language) documents. The held-out Moon call agreed with the captured page for French (Lune) and
German (Mond); the full list exceeded the output cap. The `#p-lang` selector matched nothing on
the current desktop layout, which uses `#p-lang-btn`. Final verification passed 19 cases, with no
failures or inconclusive cases; both operations answered at tier 1.
