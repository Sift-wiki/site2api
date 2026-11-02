No account is needed. `company` is the board name in a Greenhouse URL such as
`job-boards.greenhouse.io/discord`; job boards and postings change daily. This covers hosted
boards that remain on `job-boards.greenhouse.io`, not companies that redirect to their own
careers sites or use a different embedded board layout.

- `listJobs` returns one page, up to 50 jobs. `page` defaults to 1; increment it to continue.
  The numbered paging recipe does not report a next page or total, so check the board when
  completeness matters. Department may be absent; locations are the board's display text.
- `getJob` returns a one-element list. Its description is plain text extracted from the page;
  formatting and some spaces between adjacent sections may be lost. Large results may be
  truncated, as indicated by the call result. Department and update time are available in
  `listJobs`, not in this detail result.
- There are no application operations. Closed or nonexistent postings may return `input`.

## Maintainer notes

Verified 2026-11-01, logged out. The final exported spec passed `verify greenhouse`: six cases,
all tier 1. The first call from an empty home also used tier 1.

| op | learning captures | held-out comparison |
|---|---|---|
| `listJobs` | Discord page 1, Anthropic page 2 | GitLab page 1 matched the hosted board, including Director, Support (Bengaluru), Bangalore, and its job URL. |
| `getJob` | Discord 8840756002, GitLab 8629019002 | Anthropic 5387564008 matched the live page's title and San Francisco location; the call returned its description. |

Both operations send a GET to `job-boards.greenhouse.io`: the list reads `jobPosts.data` from
the page's `window.__remixContext`, and the detail reads visible HTML. Only this host is in the
spec; there is no off-site request or trigger in it. Anthropic's board showed 673 jobs, with
different results on pages 1 and 2. The live board's JavaScript also sent its own analytics
beacon during capture; detail pages made separate anonymous resource requests, including a
`my.greenhouse.io` self check that returned 401. None is part of either operation.

Figma's Greenhouse URL redirected to its own careers page, which fetched
`boards-api.greenhouse.io/v1/boards/figma/jobs?content=true`. Airbnb and Stripe also redirected
to their own careers pages. That public API was not used in this spec, which avoids depending
on a second host but does not cover those redirects. The first verification using Discord as the
list example was inconclusive because Discord had no second page; the example was changed to
Anthropic and final verification passed. Public example jobs can close, requiring replacement.
