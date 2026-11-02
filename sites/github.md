No account is needed for public repositories.

- `searchRepos` returns page 1 only (10 repositories), in GitHub's best-match order, not by stars.
  `description` keeps the page's highlighting: the matched words are wrapped in `<em>` tags.
  `stars` is the star count. `language` is missing for a repository with no detected language.
- `getRepo` follows renames: `facebook/react` answers as `react/react`. A repository that doesn't
  exist (or is private) answers `class: "input"`. `website`, `license` and `description` are
  missing when the repository sets none; `license` is `"Other"` for a license GitHub doesn't
  recognize. `releases` counts published releases, not tags.
- `listIssues` returns page 1 only (25 issues), newest first, without pull requests. `query`
  defaults to `is:issue state:open`; pass the whole filter when you change it, keeping `is:issue`
  (`is:issue state:closed label:bug`). `state` is `REPO_ISSUE_STATE_OPEN` or
  `REPO_ISSUE_STATE_CLOSED`. `comments` and `labels` are missing when an issue has none.
- `listPullRequests` returns page 1 only (up to 25), newest first. `query` defaults to
  `is:pr is:open`; pass the whole filter when changing it, keeping `is:pr`. The state is
  `REPO_ISSUE_PULL_REQUEST_STATE_OPEN`, `REPO_ISSUE_PULL_REQUEST_STATE_CLOSED` or
  `REPO_ISSUE_PULL_REQUEST_STATE_MERGED`. `labels` is missing when there are none.
- `listDirectory` takes a nonempty repository-relative directory path, including nested paths.
  Its `type` uses GitHub's values, such as `directory` and `file`. It does not list the root.
- `getFile` returns text as an array of lines, not a single string. It reads text available in
  GitHub's blob page; binary or large files may not provide lines. Check for a truncated result.
- For `listDirectory` and `getFile`, `ref` defaults to `HEAD`, GitHub's default-branch ref.
  A branch, tag or commit can be supplied instead. A missing path answers `class: "input"`.
- `listReleases` returns the first page, up to 10 releases. `status` is GitHub's visible label,
  such as `Pre-release` or `Latest`, and is absent for an unlabeled release, not a boolean.
  `summary` is the first paragraph in the rendered release notes and may be missing.
- `getUser` returns a one-item list for a public user, not an organization. An organization login
  or a missing user answers `class: "input"`. Counts are displayed strings, sometimes abbreviated
  (such as `330k`); pinned repositories are names, not owner/name pairs. Profile fields the user
  has not set may be missing.
- `getIssue` returns the issue's main post in Markdown, not the comment thread. `comments` is the
  total comment count; `labels` can be empty. A missing issue answers `class: "input"`.
- GitHub limits how fast logged-out visitors can search. Keep `searchRepos` calls spaced out.

## Maintainer notes

Verified 2026-10-31, logged out, in a clean `API_ANYTHING_HOME`: `verify github` passed 6 of 6
cases at tier 1, including empty search, missing repository and closed bug issue checks.

| op | request | checked with (not an example) | tier |
|---|---|---|---|
| `searchRepos` | `/search?q=...&type=repositories`, embedded `payload.blackbirdSearchRoute.results` | `q="rust web framework"`; `q="web framework language:go stars:>1000"` (all Go) | 1, 0.7-2.7 s |
| `getRepo` | repository page, embedded `payload.sidebarAbout` and `payload.codeViewRepoRoute.refInfo` | `torvalds/linux` (no website, license "Other"), `facebook/react` (redirect to `react/react`) | 1, 0.8-1.2 s |
| `listIssues` | `/<owner>/<repo>/issues?q=...`, embedded `payload.issuesIndexContentRoute.results` | `denoland/deno` with `is:issue state:open label:bug`; `vitejs/vite` with default query | 1, 0.8-2.2 s |

- The spec pins `loginCookies: ["user_session"]`, the signed-in cookie. Without it the learner
  mistook the logged-out `_gh_sess` cookie for a sign-in and verify skipped the ops. They were
  learned logged out (`logged_in=no`) and have `learnedLoggedIn: false`.
- No rotating ids: these are document GETs, so heal re-learns them from the page itself.
- Contributor PR #82 (mxlogy-00) proposed `api.github.com` ops (`repo`, `readme`, `issues`,
  `pulls`). It passes `vetShared`, but 2026-10-31 verification failed 4 of 8: `torvalds/linux`
  has issues disabled and answered empty, and `pulls` answered 404. Its github.com triggers never
  send requests to api.github.com, so heal could not relearn them; unauthenticated REST also
  allows 60 requests per hour per IP. Its `repo` and `issues` informed this page-based coverage.
- Not covered: individual pull requests, automatic README discovery, full issue comment threads,
  code search (code search needs a login). A README at a known path can be read with `getFile`.

### 2026-11-01, logged out

`verify github` passed 8 of 8 cases at tier 1, including the new example and closed-filter check.

| op | request | checked with (not an example) | tier |
|---|---|---|---|
| `listPullRequests` | `/<owner>/<repo>/issues?q=...`, with the page's `react-app.embeddedData` at `payload.issuesIndexContentRoute.results[*].pullRequest` | `vitejs/vite`, `is:pr is:closed`; compared the first result and label with the page | 1 |

- The dedicated `/pulls` page did not expose the same embedded JSON. The issues page supports
  `is:pr` and supplies pull request records instead.
- The issue detail page embeds an issue and a timeline containing comments and other event types.
  The timeline is paginated, so a simple extraction would not return a complete comment thread.
  No issue detail operation was added.

### 2026-11-01, logged out: repository contents

`verify github` passed 14 of 14 cases at tier 1, including missing-path and historical-tag checks.
Two `nodejs/node` captures at `HEAD` and `v18.0.0` gave different listings and README lines.
Node's `HEAD` listing matched `main`; Linux's `HEAD` file matched `master` and its raw contents.
GitHub resolves `HEAD` to a tree object in the page.

| op | request | checked with (not an example) | tier |
|---|---|---|---|
| `listDirectory` | `/<owner>/<repo>/tree/<ref>/<path>`, embedded `payload.codeViewTreeRoute.tree.items` | `torvalds/linux`, `HEAD`, `kernel/sched`; compared names, paths and types with the page | 1 |
| `getFile` | `/<owner>/<repo>/blob/<ref>/<path>`, embedded `payload["codeViewBlobLayoutRoute.StyledBlob"].rawLines` | `torvalds/linux`, `HEAD`, `COPYING`; compared lines with its raw file | 1 |

- An initial directory learn compared `HEAD` with `master` on Node, which returned the same
  listing and left `ref` unproven. Relearning with the historical tag produced different data.
- The blob's lines live under a key containing a literal dot, not under `payload.blob`. The CLI
  extraction uses a quoted bracket key. README discovery, releases, profiles and issue fields
  were not investigated in this pass.

### 2026-11-01, logged out: releases, profiles and issue posts

`verify github` passed 22 of 22 cases at tier 1, including missing-input checks. Each operation
used two examples and a held-out comparison with the public page.

| op | request | checked with (not an example) | tier |
|---|---|---|---|
| `listReleases` | `/<owner>/<repo>/releases`, server-rendered release sections | `sveltejs/svelte`, first release tag, name, date, label and summary | 1 |
| `getUser` | `/<username>`, server-rendered profile | `sindresorhus`, including website, counts and pinned names; `nodejs` organization returns input | 1 |
| `getIssue` | `/<owner>/<repo>/issues/<number>`, embedded `payload.issueViewerRoute.data.repository.issue` | `nodejs/node#66`, title, state, author, date, body and label | 1 |

- `golang/go` did not supply a matching release list for the second capture; `rust-lang/rust`
  did. Release status is a displayed label, not a boolean prerelease field.
- README `richText` is HTML in an overview-files array; no reliable text-only extraction that
  selects the README over other files was established, so no `getReadme` was added.
- An issue URL can redirect to a pull request, as `nodejs/node#10000` did. The issue operation
  targets the issue page payload, not pull requests or the paginated timeline.
