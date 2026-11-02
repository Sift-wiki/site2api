No account is needed for public repositories.

- `searchRepos` returns page 1 (10), best-match order, not stars. Matched words in `description`
  have `<em>` tags; `stars` is the count, and `language` is absent if none is detected.
- `getRepo` follows renames (`facebook/react` becomes `react/react`); missing or private repos
  return `class: "input"`. Unset `website`, `license` and `description` are absent; an
  unrecognized license is `"Other"`. `releases` counts published releases, not tags.
- `listIssues` returns page 1 (25), newest first, excluding PRs. `query` defaults to
  `is:issue state:open`; replace the whole filter, keeping `is:issue` (e.g.
  `is:issue state:closed label:bug`). State is `REPO_ISSUE_STATE_OPEN` or
  `REPO_ISSUE_STATE_CLOSED`; `comments` and `labels` are absent when none.
- `listPullRequests` returns page 1 (up to 25), newest first. `query` defaults to `is:pr is:open`;
  replace the whole filter, keeping `is:pr`. State is `REPO_ISSUE_PULL_REQUEST_STATE_OPEN`,
  `REPO_ISSUE_PULL_REQUEST_STATE_CLOSED` or `REPO_ISSUE_PULL_REQUEST_STATE_MERGED`.
  `labels` is absent when none.
- `listDirectory` takes a nonempty repository-relative path, including nested paths, not the root.
  Its `type` uses GitHub's values, such as `directory` and `file`.
- `getFile` returns an array of lines from GitHub's blob page; binary or large files may not
  provide lines. Check for truncation.
- For `listDirectory` and `getFile`, `ref` defaults to `HEAD`, GitHub's default-branch ref.
  A branch, tag or commit can be supplied instead. A missing path answers `class: "input"`.
- `listReleases` returns page 1, up to 10. `status` is GitHub's label (e.g. `Pre-release` or
  `Latest`), not a boolean, and is absent if unlabeled. `summary` is the first rendered paragraph,
  if present.
- `getUser` returns a one-item list for a public user; organizations and missing users return
  `class: "input"`. Counts are displayed strings, sometimes abbreviated (`330k`); pinned repos
  are names, not owner/name pairs. Unset profile fields may be absent.
- `getIssue` returns the issue's main post in Markdown, not the comment thread. `comments` is the
  total comment count; `labels` can be empty. A missing issue answers `class: "input"`.
- Trending periods default to `daily`; an empty `language` means all languages. Repository links
  are full URLs, counts are displayed strings, and descriptions or languages may be missing.
  Developer names can fall back to the username and popular repository links may be absent.
- `getLanguages` gives GitHub's rounded percentages, including an `Other` group when present.
- GitHub limits how fast logged-out visitors can search. Keep `searchRepos` calls spaced out.

## Maintainer notes

2026-10-31, logged out, clean home: verify 6/6 at tier 1, including empty search, missing repo
and closed bug issue checks.

| op | request | checked with (not an example) | tier |
|---|---|---|---|
| `searchRepos` | `/search?q=...&type=repositories`, `payload.blackbirdSearchRoute.results` | `rust web framework`; `web framework language:go stars:>1000` (all Go) | 1, 0.7-2.7 s |
| `getRepo` | repo page, `payload.sidebarAbout` and `payload.codeViewRepoRoute.refInfo` | Linux (no website, license "Other"); `facebook/react` redirects to `react/react` | 1, 0.8-1.2 s |
| `listIssues` | `/<owner>/<repo>/issues?q=...`, `payload.issuesIndexContentRoute.results` | Deno with `is:issue state:open label:bug`; Vite with default query | 1, 0.8-2.2 s |

- `loginCookies: ["user_session"]` prevents the learner mistaking logged-out `_gh_sess` for
  sign-in and skipping verification. These ops were learned with `logged_in=no` and
  `learnedLoggedIn: false`. Document GETs have no rotating IDs and heal from the page itself.
- Contributor PR #82 (mxlogy-00) proposed `api.github.com` `repo`, `readme`, `issues`, `pulls`:
  it passed `vetShared`, but 2026-10-31 verify failed 4/8 (Linux issues disabled, pulls 404).
  github.com triggers cannot heal those REST calls; unauthenticated REST permits 60 requests/hour/IP.
  Its `repo` and `issues` informed this page-based coverage.
- Not covered: individual pull requests, automatic README discovery, full issue comment threads,
  code search (code search needs a login). A README at a known path can be read with `getFile`.

### 2026-11-01, logged out

Verify passed 8/8 at tier 1, including the new example and closed-filter check.

| op | request | checked with (not an example) | tier |
|---|---|---|---|
| `listPullRequests` | `/<owner>/<repo>/issues?q=...`, `react-app.embeddedData` at `payload.issuesIndexContentRoute.results[*].pullRequest` | `vitejs/vite`, `is:pr is:closed`; first result and label matched | 1 |

- `/pulls` lacked the same embedded JSON; the issues page supplies PR records with `is:pr`.
- The issue detail timeline mixes comments and other events and is paginated, so a simple extraction
  would not return a complete comment thread. No issue detail operation was added in this pass.

### 2026-11-01, logged out: repository contents

Verify passed 14/14 at tier 1, including missing-path and historical-tag checks. Node `HEAD`
and `v18.0.0` captures differed in listings and README lines; Node's `HEAD` matched `main`,
Linux's `HEAD` file matched `master` and raw contents. GitHub resolves `HEAD` to a tree object.

| op | request | checked with (not an example) | tier |
|---|---|---|---|
| `listDirectory` | `/<owner>/<repo>/tree/<ref>/<path>`, embedded `payload.codeViewTreeRoute.tree.items` | `torvalds/linux`, `HEAD`, `kernel/sched`; compared names, paths and types with the page | 1 |
| `getFile` | `/<owner>/<repo>/blob/<ref>/<path>`, embedded `payload["codeViewBlobLayoutRoute.StyledBlob"].rawLines` | `torvalds/linux`, `HEAD`, `COPYING`; compared lines with its raw file | 1 |

- Node `HEAD` and `master` returned the same listing, leaving `ref` unproven; the historical tag
  produced different data.
- Blob lines are under a literal-dot key, not `payload.blob`, so extraction uses a quoted bracket
  key. README discovery, releases, profiles and issue fields were not investigated in this pass.

### 2026-11-01, logged out: releases, profiles and issue posts

Verify passed 22/22 at tier 1, including missing-input checks. Each used two examples and a
held-out public-page comparison.

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

### 2026-11-01, logged out: discovery

`verify github` passed 28/28 at tier 1. Fresh-home calls and later calls used tier 1.
`trendingRepos`: Rust/weekly and Python/monthly learned; Go/daily matched the page, and the
empty language default returned mixed languages. `trendingDevelopers`: weekly/monthly learned;
daily matched the page. Both use server-rendered `article.Box-row` lists. `getLanguages` reads
`/<owner>/<repo>/_sidebar` JSON; Node and Rust learned, Go matched its sidebar response.
Topic markup was examined but no operation was added: the recipe could not return a structured
topic with aligned repository records and metadata. Contributors were not investigated separately.
