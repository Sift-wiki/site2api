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
- GitHub limits how fast logged-out visitors can search. Keep `searchRepos` calls spaced out.

## Maintainer notes

Verified 2026-10-31, logged out, from a clean `API_ANYTHING_HOME` holding only this file:
`api-anything verify github` passed 6 of 6 cases (each op's example, an `empty` check for
`searchRepos`, an `input` check for a missing repository, and a `listIssues` check with
`state:closed label:bug`). Every call answered at tier 1 (plain HTTP GET of github.com pages).

| op | request | checked with (not an example) | tier |
|---|---|---|---|
| `searchRepos` | the `/search?q=...&type=repositories` page; its results are in the `react-app.embeddedData` JSON script, read with `--embedded` at `payload.blackbirdSearchRoute.results` | `q="rust web framework"` (Rocket, actix-web, ...); `q="web framework language:go stars:>1000"` (all Go) | 1, about 0.7-2.7 s |
| `getRepo` | the repository page; the same JSON script, at `payload.sidebarAbout` (the About box) and `payload.codeViewRepoRoute.refInfo` (default branch) | `torvalds/linux` (no website, license "Other"), `facebook/react` (redirect to `react/react`) | 1, about 0.8-1.2 s |
| `listIssues` | the `/<owner>/<repo>/issues?q=...` page; the same JSON script, at `payload.issuesIndexContentRoute.results` | `denoland/deno` with `is:issue state:open label:bug` (every row labeled `bug`); `vitejs/vite` with no `query` (default) | 1, about 0.8-2.2 s |

- The spec pins `loginCookies: ["user_session"]`, GitHub's signed-in session cookie. Without it the
  learner read the `_gh_sess` cookie, which GitHub gives every logged-out visitor too, as a
  sign-in and recorded the ops as `learnedLoggedIn: true`, so `verify` skipped them as needing a
  login. The ops were learned logged out (`logged_in=no`), and `learnedLoggedIn` is set to `false`.
- No rotating ids: these are document GETs, so heal re-learns them from the page itself.
- Contributor PR #82 (by mxlogy-00) proposed a `github` spec against `api.github.com` (`repo`,
  `readme`, `issues`, `pulls`). It passes `vetShared`, but on 2026-10-31 its `issues` example
  (`torvalds/linux`, which has issues turned off) answered empty and `pulls` answered 404, so
  `verify` failed 4 of 8 cases. Its triggers open github.com pages, which never send requests to
  api.github.com, so heal could not re-learn them either; and the unauthenticated REST API allows
  60 requests an hour per IP. These ops were learned from github.com's own pages instead; its
  `repo` and `issues` ops set which data `getRepo` and `listIssues` cover.
- Not covered: individual pull requests, README text, file contents, code search (code search needs a login).

### 2026-11-01, logged out

`verify github` passed 8 of 8 cases at tier 1, including the original operations and the new
operation's example and closed-filter check.

| op | request | checked with (not an example) | tier |
|---|---|---|---|
| `listPullRequests` | `/<owner>/<repo>/issues?q=...`, with the page's `react-app.embeddedData` at `payload.issuesIndexContentRoute.results[*].pullRequest` | `vitejs/vite`, `is:pr is:closed`; compared the first result and label with the page | 1 |

- The dedicated `/pulls` page did not expose the same embedded JSON. The issues page supports
  `is:pr` and supplies pull request records instead.
- The issue detail page embeds an issue and a timeline containing comments and other event types.
  The timeline is paginated, so a simple extraction would not return a complete comment thread.
  No issue detail operation was added.
