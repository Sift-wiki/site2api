No account is needed. `company` is the board slug in `jobs.ashbyhq.com/<company>`.
Postings change and may close.

- `listJobs` returns a board's postings without paging. Large answers may be truncated; use
  the result continuation. The list provides a `teamId`, not a team name. Use `getJob` for
  department and team names. Construct a posting URL as
  `https://jobs.ashbyhq.com/<company>/<jobId>`.
- Workplace type and compensation may be null. Secondary locations are additional choices,
  not necessarily remote locations.
- `getJob` returns `descriptionHtml` as HTML, not plain text. Long descriptions can be
  truncated; check the result's truncation indicator. Compensation appears only when public.
- No application operations are included.

## Maintainer notes

Verified 2026-11-01, logged out. Final spec verification passed all five cases at tier 1;
each operation's first call from an empty home also used tier 1. Examples are public
postings and can close.

| op | learning examples | held-out comparison |
|---|---|---|
| `listJobs` | Linear and Notion | Ramp's Account Executive, London, OnSite matched its board capture. |
| `getJob` | Linear `6dd5500a-4bd4-4f57-ba09-7b07acefecf4`, Notion `11e56782-ee28-4025-ba0e-76222b0bfcea` | Ramp `1515fe6d-1d8e-475b-a5ee-cefe43e78cb7`: title, Sales department, London, FullTime and OnSite matched the posting page's embedded data. |

Both requests are the page's captured GraphQL query POSTs to `jobs.ashbyhq.com`:
`ApiJobBoardWithTeams` and `ApiJobPosting`. The latter query also reads blank application
form metadata as part of the site's original document, but the result recipe discards it;
no application was started or submitted. The board query returns team names separately
from postings, which the extraction recipe cannot join. Page resource requests and any
page-initiated analytics are not part of these operations.
An attempted HTML `h1` recipe on the posting document found no matching field in the raw
document; the embedded posting data and captured GraphQL response worked instead.
