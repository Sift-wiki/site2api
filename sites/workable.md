No account is needed. `company` is the slug in `apply.workable.com/<company>`, and
`shortcode` is the code in the posting's `/j/<shortcode>/` URL. Postings can close.

- `getJob` returns description, requirements and benefits as HTML, not plain text.
  Fields such as employment type or benefits can be absent or empty.
- There is no list or application operation. Find a posting on the company's board first.

## Maintainer notes

Verified 2026-11-01, logged out. The final spec passed `verify workable` with two cases,
both tier 1. The first call from an empty home also used tier 1.

| op | learning examples | held-out comparison |
|---|---|---|
| `getJob` | Human Intelligence `C8A97F7C66`, Thrive `FCAAE7F7E9` | REEDS `A88C321C31`: title and Newark location matched the live posting; the call returned requirements and benefits. |

The posting page requests `GET /api/v2/accounts/<company>/jobs/<shortcode>` on
`apply.workable.com`. The page also requests application form metadata; the operation does
not use it and no application was started. The page may send its own analytics or challenge
requests, which are not part of this operation.

The board page requested `POST /api/v3/accounts/<company>/jobs` for listings. Although it
returns public job data, `notARead` rejects a non-GraphQL POST for a shared read. No GET
listing request was observed in the captured boards, so this spec does not include `listJobs`.
