No account is needed.

- Numbers keep the page's format. `avgRating` is a string (`"4.22"`). `ratingsCount` is
  `"1,481,183 ratings"` in `getBook`, `"1,481,180"` in `authorBooks` and a number in `searchBooks`.
- Page 1 only: 5 search results, 30 of an author's books, the first reviews.
- On a new install, the first `getReviews` call opens the page in Chrome once (about 6 s) to pick up
  a site-wide API key. Later calls are plain HTTP.
- `getAuthor` takes the numeric `authorId` from `searchBooks`. Dates, website, genres and influences
  may be absent. Influences and the biography are the page's visible excerpts, not necessarily complete.

## Maintainer notes

Logged out. Goodreads closed its public API in 2020. An agent with the
api-anything skill built these operations on 2026-09-28 from a stated intent, in about 6 minutes
([bench/explore](../bench/explore/README.md)). Across 30 books it had never seen, every call
answered over plain HTTP. In each of the 29 books where the chain reached the book, the details
matched the page Chrome rendered.

| op | args | returns |
|---|---|---|
| `searchBooks` | `q` (title or author words) | the search box's top 5: `bookId`, `title`, `author`, `authorId`, `avgRating`, `ratingsCount` |
| `getBook` | `bookId` | `title`, `author`, `authorUrl`, `avgRating`, `ratingsCount`, `pages`, `firstPublished`, `genres` (list), `description` |
| `authorBooks` | `authorId` | up to 30 books: `bookId`, `title`, `avgRating`, `ratingsCount` |
| `getWorkId` | `bookId` | `workId` (`kca://work/...`), `legacyWorkId` |
| `getReviews` | `workId` | top reviews: `reviewer`, `rating` (1-5), `text` |

Chains:
- Details: `searchBooks q=circe` returns `bookId`, then call `getBook bookId=...`.
- Author: take `authorId` from `searchBooks`, then call `authorBooks authorId=...`.
- Reviews: call `getWorkId bookId=...`, then `getReviews workId=...`. Reviews are keyed by the
  work, not the book.

### Caveats

- **Search by title, then choose.** For a "title author" query, Goodreads's own search ranks
  summaries and study guides first. The real book may not be in the top 5. Search by the title,
  then pick the result by the right author with the most ratings.
- In `getBook`, `pages` is `"393 pages, Hardcover"`.
- `getReviews` returns review text as the site's HTML. Long reviews fill the output cap after a
  few reviews, and the result is marked `truncated`.
- `getReviews` sends a site-wide API key that the page itself uses. The key isn't in the spec. Its
  trigger is fixed to one book's page, so if the request itself changes, repair can't re-learn it
  for other works. The call fails rather than return another book's reviews.

### 2026-11-01, logged out

`getAuthor` was learned from J.K. Rowling (1077326) and Stephen King (3389). A held-out
J.R.R. Tolkien profile (656983) matched the page's name, dates, website, genres, rating,
ratings count and biography excerpt. The profile is server-rendered HTML.
