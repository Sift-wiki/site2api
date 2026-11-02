No account is needed for public projects.

- `getProject` returns a one-item list. `nameVersion` is the heading, combining the project name
  and version; `license` and `requiresPython` retain their page labels. The link labels and URLs
  are corresponding arrays. Fields can be absent when the project does not provide them.
  `maintainers` contains public PyPI usernames, not the author or maintainer credit text.
- `getReleases` follows the page's version ordering, not necessarily chronological order. `status`
  is absent for an unmarked release, or is PyPI's visible `Pre-release` or `Yanked` label.
  Long results can be truncated by the response limit.
- `getFiles` covers the latest release only. Infer wheel or source distribution from the filename.
  Sizes are displayed strings; checksums are not included.
- Project search is not included because PyPI presented a browser challenge during capture.

## Maintainer notes

Verified 2026-11-01, logged out. Both `requests` and `django` were captured as examples;
the held-out `flask` calls were compared with its public project page.

| op | request | held-out comparison |
|---|---|---|
| `getProject` | GET `/project/{name}/`, project heading and metadata HTML | Flask 3.1.3, summary, license, Python requirement, links, classifiers and date |
| `getReleases` | Same document, `#history` release cards | Flask history, including 2.0.0rc2 and its pre-release label |
| `getFiles` | Same document, `#files` tables | Flask 3.1.3 source and wheel filenames, sizes and dates |

Fragments select page sections and are not separate requests. The capture included external
GitHub statistics requests, but no request to PyPI's JSON API; the operations use the project
document only. The search document returned a Fastly challenge, so search was not learned.
The user-project page was not investigated. No writes are provided.

### 2026-11-01: user-project pages, logged out

The public user pages for `sethmlarson` and `kennethreitz` returned Fastly client challenges
in separate browser runs. No user-project operation was added, and search was not retried.
The challenge page itself sent POST requests; no write operation was invoked.
