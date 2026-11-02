No account is needed. CNN content is copyrighted; link to the original and use summaries as
appropriate rather than republishing full articles.

- For a dated `topStories` path, split `YYYY/MM/DD/section/slug` into the five `getArticle`
  arguments, preserving the leading zero in month and day. Some front-page links have undated
  paths, which `getArticle` does not support. Do not include a trailing `index.html` in the slug.
- The timestamp indicates whether it was published or updated. Metadata can be absent; paragraphs
  exclude subheadings and may include editorial or navigation text.

## Maintainer notes

Verified 2026-11-01, logged out, with isolated homes. Both operations use GET requests to
`lite.cnn.com` and server-rendered HTML.

| op | examples used to learn | held-out check | request and recipe |
|---|---|---|---|
| `topStories` | no arguments | live front page | `/`, `li.card--lite` links |
| `getArticle` | `2026/11/01/politics/chris-murphy-stroke`, `2019/06/22/us/hawaii-twin-engine-plane-crash` | `2026/11/01/us/south-florida-plane-crash`, compared with the article | `/{year}/{month}/{day}/{section}/{slug}`, headline and article elements |

The list recipe resolves links to absolute URLs and derives their host-relative paths. A single
multi-segment path parameter was percent-encoded by the CLI and returned HTTP 404; individual
path segments work. The front-page capture also loaded supporting resources; no write operation
was added. The article recipe collects paragraph elements, not subheadings or embedded media.
