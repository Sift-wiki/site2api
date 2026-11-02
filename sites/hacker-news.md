No account is needed.

- `frontPage`: job posts have neither `points` nor `comments`. Self posts (Ask HN) have a relative
  `url` such as `item?id=...`. Only the first page is included, with no pagination.
- `search` defaults to stories ranked by popularity, page 0 (30 hits). `searchByDate` sorts newest
  first. Both accept `type` (`story`, `comment`, `ask_hn`, `show_hn`, `poll`, `job`) and zero-based
  `page`. `search` returns story fields only, so use `searchByDate` with `type=comment` to read
  comments: its comment hits carry `comment_text` and story context instead of titles and points.
- `getItem` takes a story's id; a comment's id returns no story. `text` is set only on self posts
  (Ask HN). `getComments` returns the comments the item page shows, in thread order; `depth` is
  the indentation level (`0` for a top-level comment). Very long threads are split across pages
  by HN and only the first page is returned.
- `listStories` defaults to the front page (`list=news`, `page=1`); its values are page text, as in
  `frontPage`.
- `getUser` values are page text: `created` is a date such as `October 9, 2006`, `about` can be
  missing.
- HN answers fast repeated requests with HTTP 419 "Sorry", which api-anything reports as `auth`:
  wait a minute and retry instead of logging in. Keep call volume low.

## Maintainer notes

Verified 2026-09-27, logged out, with `api-anything verify hacker-news` passing from a clean
`API_ANYTHING_HOME`.

| op | args | returns | tier |
|---|---|---|---|
| `frontPage` | none | 30 front-page stories: `title`, `url`, `points`, `comments` | 1 (HTML GET of news.ycombinator.com, about 150 ms) |
| `search` | `query` (example `sqlite`) | up to 30 story hits: `title`, `url`, `points`, `num_comments`, `objectID`, `author`, `created_at` | 1 (POST to the Algolia index behind hn.algolia.com, about 1 s) |

```sh
api-anything call hacker-news frontPage
api-anything call hacker-news search query=duckdb
```

### Known limits

- `frontPage` values are page text: `points` is `"105 points"`, and `comments` is `"11 comments"` or
  `"discuss"`.
- The `search` request carries Algolia's public search-only key (`x-algolia-api-key`, the one
  hn.algolia.com ships to every browser). The export hex-blob warning refers to that key.
- Algolia sends its JSON body under `content-type: application/x-www-form-urlencoded` (to skip
  the CORS preflight). api-anything reads such a body as JSON, so `add` finds the query at
  `["body", "json:/query"]` by itself (re-verified 2026-09-27).

### 2026-11-01, logged out: items, lists and users

`verify hacker-news` passed 10 of 10 result cases at tier 1 from a fresh home holding only this
spec. All four ops are HTML GETs read with `--html` recipes.

| op | request | learned with | checked with (not an example) |
|---|---|---|---|
| `getItem` | `/item?id=<id>`, `tr.athing.submission` and the rows after it | `8863`, `2921506` | `10000000` |
| `getComments` | `/item?id=<id>`, `tr.comtr` with depth from `td.ind@indent` | `8863`, `2921506` | `10000000` |
| `listStories` | `/<list>?p=<page>`, `tr.athing.submission` | `newest` p1, `best` p2 | `ask` p1 |
| `getUser` | `/user?id=<name>`, the profile table rows | `pg`, `dang` | `dang` |

- Learning `getItem` with `2921983` failed: that id is a comment, which the story recipe
  doesn't match.
- During learning HN answered one browser-style request with HTTP 419 "Sorry" (its throttle). A
  later `input` check for a missing id also met 419, so no missing-item behaviour is recorded.
  The classifier reads 419 as `auth` (Laravel's expired-CSRF status).

### 2026-11-01, logged out: Algolia search options

Captured date-sorted `sqlite` comments on page 1 and `rust` stories on page 2. A held-out
`database` Ask HN search on page 1 matched the first item returned by hn.algolia.com.
The date index is `Item_dev_sort_date`; the body uses `tagFilters` such as `[["comment"],[]]`
or `[["ask_hn"],[]]`, a numeric zero-based `page`, and `hitsPerPage: 30`. The original popularity
index is `Item_dev`, and its default request remains stories, page 0 with `numericFilters: []`.
The UI used `typoTolerance: "min"` for the date-sorted examples; `minProximity` differed between
the captures, so the recorded comment value is retained. Author and time-range filters are not
exposed.
