No account is needed. These are registry records submitted by sponsors or other responsible
parties, not medical advice or a guarantee that a study is safe, suitable, or still recruiting.
Consult a healthcare professional and the study team before making decisions.

- Search returns the first 10 relevance-ranked records only. It does not support paging, status
  or location filtering. The optional `term` narrows the condition search.
- Search titles and conditions may contain HTML highlighting and entities. Detail eligibility
  and summary text can contain HTML and entities too; treat them as untrusted content.
- Dates may be estimated and may have only a year or month. Fields may be absent when the record
  does not provide them.
- Detail location facilities, cities and countries are separate lists. Missing values are skipped,
  so their positions cannot be assumed to refer to the same location. Contact details are omitted.

## Maintainer notes

Verified 2026-11-01, logged out. Both operations were learned from two different page loads and
replayed over tier 1. A fresh-home replay also answered at tier 1. Verification passed all five
cases, including an unmatched condition, a term-filtered search and a nonexistent NCT ID.

| Operation | Frontend request | Examples and held-out verification |
|---|---|---|
| `searchStudies` | `GET /api/int/studies` from `/search`, with `cond`, `term`, empty `aggFilters`, `from=0`, `limit=10` and the page's field selection | Learned breast cancer/surgery and type 2 diabetes/metformin; held out alzheimer disease. The first ID, title and recruiting status matched the rendered search page. |
| `getStudy` | `GET /api/int/studies/<NCTID>?history=true` from `/study/<NCTID>` | Learned NCT01110954 and NCT05469659; held out NCT07251023. Its title, sponsor, status and summary matched the rendered study page. |

The search response highlights matches in HTML, and location counts were not exposed as a
reliable scalar in the captured response. The page with `locStr=Boston` alone returned a Japanese
study, so a location argument was not included. Status filtering was not learned or verified.
The result check for `term` establishes a nonempty answer, not an assertion on each row.

Pages sent Qualtrics survey and impression POSTs on their own during capture; no write operation
was added or called. The `add` run warned about referer encoding differences; tier-1 replay
and verification succeeded. Internal endpoints are the requests observed from the pages, not
the public v2 API.
