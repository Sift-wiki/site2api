No account is needed. `company` is the slug in a SmartRecruiters career or job URL.
Postings change and may close.

- `listJobs` reads only the initial career page, not all the jobs: the page can show
  more groups or more jobs within a group. Locations may be absent when they are shown
  in group headings rather than each job. Follow the returned URL for a posting; its
  numeric ID is the beginning of the final path segment.
- `getJob` returns a one-element list of visible plain text. Adjacent paragraphs and
  list items can run together. Some fields can be absent, and benefits may appear in
  the company description, which this operation does not return.
- No application operations are included.

## Maintainer notes

Verified 2026-11-01, logged out. Final verification passed five cases at tier 1.
Each operation's first call from a separate empty home also used tier 1.

| op | learning examples | held-out comparison |
|---|---|---|
| `listJobs` | Version1, Xplor | Public Storage's six initial-page titles and URLs matched its career page. |
| `getJob` | Version1 `744000154491789`, Xplor `744000155454339` | Public Storage `744000158380327`: title, full-time status and description matched the live posting. |

The operations GET the server-rendered documents on `careers.smartrecruiters.com`
and `jobs.smartrecruiters.com`, respectively. These are different hosts under the same
registrable domain; the spec uses no off-site API. No request to
`api.smartrecruiters.com` appeared in the captured career page, so it was not used.
The board groups results and loads additional groups and jobs separately; this recipe
cannot join group headings to jobs or enumerate subsequent groups. The captured pages
also sent their own analytics and challenge requests, none part of the operations.
