No account is needed.

- A work is a book across all its editions. Ids look like `OL59800W` (work) and `OL31353A` (author).
- `searchBooks` returns page 1 only (20 works), ranked by the site. Several works can share a
  title (study guides, other editions catalogued apart): pick by author and by `editions`, the
  largest usually being the main one. `authorId` is the first author only; `author` lists them all.
- `getWork` `description` is sometimes plain text and sometimes an object whose text is in
  `value`. It, `subjects`, `subjectPlaces` and `coverId` are missing when the catalog has none.
  `authorIds` are keys like `/authors/OL31353A`: the last part is the `getAuthor` arg.
- `getAuthor`: `bio` follows the same text-or-object rule. `birthDate` and `deathDate` are
  free text in whatever format the record has (`21 October 1929`, `January 4, 1976`), and each
  can be missing.
- `getEditions` returns the first 50 editions, not all editions. Edition ids are keys like
  `/books/OL7353617M`; language values are keys like `/languages/eng`. ISBNs, publisher,
  publication date, pages and languages may be missing.
- `getByIsbn` accepts an ISBN-10 or ISBN-13 without hyphens. Work and author values are keys
  such as `/works/OL45804W` and `/authors/OL34184A`, and may be absent.
- `getAuthorWorks` returns the first 50 works. Its work ids are `/works/` keys, and first
  publication dates are free text and often missing.
- `getSubject` takes a subject slug such as `science_fiction` and returns the first 12 works.
  It does not return the subject's total work count. Authors and first publication year may be
  missing.
- A cover image is `https://covers.openlibrary.org/b/id/<coverId>-M.jpg` (`-S`, `-M` or `-L`).

## Maintainer notes

### 2026-11-01, logged out: additional investigation

- A search page capture showed the sort picker values `relevance`, `editions`, `old`, `new`,
  `rating`, `readinglog`, `want_to_read`, `currently_reading`, `already_read`,
  `stopped_reading`, `trending` and `random`. The page and the author-search page were
  server-rendered; neither capture showed a request to its JSON search twin.
- Direct JSON document captures for author search, work ratings and work bookshelves answered
  for two differing examples each. The work HTML page redirected to human verification, so
  whether that page requests the two work JSON endpoints was not established.
- Adding sort and page to `searchBooks` did not complete: the second page timed out, and a
  second attempt failed with connection refused. A held-out author-search call then failed
  twice with `ECONNREFUSED`. No new operations were exported without held-out calls and
  verification. The pages sent Sentry analytics POSTs on their own; no write was called.

### 2026-11-01, logged out

- Captured two differing JSON documents for each new operation. Held-out calls at tier 1 matched
  captured JSON documents: `getEditions(OL66554W)` first returned `/books/OL49198652M`;
  `getByIsbn(9780141439518)` resolved to `/books/OL37076991M`;
  `getAuthorWorks(OL34184A)` first returned `/works/OL15158644W`;
  `getSubject(fantasy)` first returned `/works/OL138052W`. The actual HTML edition and subject
  pages redirected to `/verify_human`, so a comparison with their rendered pages was not possible.
- The ISBN JSON URL redirects to a `/books/` JSON document. Capturing the redirect yields a 302
  HTML response, so its learned response recipe was corrected to JSON for the final response;
  tier-1 fetch follows the redirect.
- Subject JSON contains name and count alongside full work records. The recipe extracts the
  work list instead: selecting whole records caused oversized, truncated results and redacted
  nested `key` fields. The count is not returned.
- No separate availability operation was added: the challenged HTML pages did not expose their
  button requests. Reading logs, lists and borrowing are not included. The challenge page sent
  a Sentry analytics POST on its own; no write operation was called.

Verified 2026-10-31, logged out, from a clean `API_ANYTHING_HOME`: `api-anything verify
openlibrary` passed 5 of 5 cases (each op's example, an `empty` check for `searchBooks`, and an
`input` check for a work id that doesn't exist). Every call answered at tier 1 (plain HTTP).

| op | request | checked with (not an example) | tier |
|---|---|---|---|
| `searchBooks` | the server-rendered `/search?q=...&mode=everything` page, read with an HTML recipe; `workId` and `authorId` are cut out of the result links with a pick regex | `q="pride and prejudice"` (Jane Austen's work `OL66554W` first); `q=zzqqxxwvnothingmatch` gives `[]` | 1, about 1.5-2 s |
| `getWork` | `GET /works/<id>.json`, the site's own record | `workId=OL15093171W` (Pride and Prejudice and Zombies, whose description is a plain string) | 1, under 1 s |
| `getAuthor` | `GET /authors/<id>.json` | `authorId=OL3125727A` (Seth Grahame-Smith: no bio, no death date) | 1, under 1 s |

- The HTML work and author pages (`/works/OL59800W`) redirect to `/verify_human` both in a headless
  Chrome and over plain HTTP, so they were not used. The `.json` records of the same pages answer
  without it, and the search page did too.
- The header search box is drawn by script; filling it fired no autocomplete request, so search is
  learned from the results page.
- The `empty` element of the search recipe is `p.search-no-direct-match__message` ("No matching
  books or authors"), absent from a page with results.
- `firstPublished` was left out of `getWork` because the example work's record has no
  `first_publish_date` (a picked field missing on the example reads as drift); `searchBooks` has it.
