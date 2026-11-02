No account is needed. Reddit answers plain HTTP from many networks with a JS challenge, so a
caller's first call often goes through the browser tier (about 12 s with Chrome starting, then 1 to
2 s a call). Later calls start there.

- `search` returns the first page of post results, about 7, ranked by Reddit. `votes` and
  `comments` are strings of digits. No comments, communities or people results.
- `hot` returns the posts the subreddit page renders first, usually 3 to 10, with no paging.
  `url` is the linked page on a link post and the post itself on a text post; `permalink` is
  relative to reddit.com.
- `listPosts` returns the first rendered posts in a sorted feed, without paging. `sort` defaults
  to `hot`; `t` (default `day`) only filters `top`, and Reddit ignores it for the other sorts. Links have the same
  meaning as in `hot`.
- A subreddit that is private, banned or misspelled answers `input` (no posts on the page).

## Maintainer notes

Learned 2026-10-31 with `api-anything learn`, logged out, from the pages reddit.com serves
(`/search/?q=` and `/r/<sub>/hot/`), with an explicit `--html` recipe over the attributes Reddit
puts on each result. Holdouts `rust async` and `r/sqlite` answered at tier 1 in the learning
profile; the clean replay with no cookies met Reddit's JS challenge, which a caller's browser
passes on its own. `api-anything verify reddit` passed 4 of 4 from an empty `API_ANYTHING_HOME`,
at tier 2.

This replaces the `.json` data-endpoint spec proposed in #82: from this network those endpoints
answer `403 blocked by network security`, and no Reddit page requests them, so a browser could
not heal them.

| op | args | returns | tier |
|---|---|---|---|
| `search` | `query` (example `linux kernel`) | about 7 posts: `title`, `subreddit`, `votes`, `comments`, `posted`, `url` | 1, or 2 behind the challenge |
| `hot` | `sub` (example `rust`) | the first posts: `title`, `subreddit`, `author`, `score`, `comments`, `url`, `permalink`, `posted`, `id` | 1, or 2 behind the challenge |

```sh
api-anything call reddit search query="local llm"
api-anything call reddit hot sub=programming
```

### 2026-11-01, logged out

| op | args | returns | tier |
|---|---|---|---|
| `listPosts` | `sub`, `sort` (`hot`, `new`, `top`, `rising`), `t` (`hour`, `day`, `week`, `month`, `year`, `all`) | First rendered posts, using the same fields as `hot` | 1, or browser fallback behind the challenge |

`listPosts` captures the GET document at `/r/<sub>/<sort>/?t=<range>` and reads
`shreddit-post` attributes. Learned with `r/programming` top/day and `r/technology` top/year;
the held-out `r/linux` rising/month call matched the captured page's first three posts. The
time range only filters top feeds. A post capture of the old Obama AMA encountered a CAPTCHA;
a recent post page loaded, but the tested HTML recipe did not extract its comments as structured
records, so no post operation was added.

### 2026-11-01, logged out: post, community and profile retry

Captures of two public r/programming posts (`1tlh5aj` and `1qoxwdt`), the community page
and `u/spez` ended at `chrome-error://chromewebdata/` after Reddit's JavaScript challenge,
without a usable document. A retry of `1tlh5aj` after verifying the existing operations
listed an initial document response, but inspecting it with a `shreddit-post` recipe found
no matching items. No post, comment, community or user operation was added without the
two examples and held-out validation. Existing operations passed all six verification cases
at tier 2 in this session.

### 2026-11-01, logged out: waited post capture

The programming top/week feed returned recent posts at tier 2. Waiting for `shreddit-post`
on the post pages for `r/programming` `1xft3w2` and `r/technology` `1xj6gwl` reached
their canonical documents. The first document exposed the post's title, author, score,
comment count, timestamp and link, but neither document contained `shreddit-comment`
elements, and no comments partial appeared in the captures. A candidate `getPost` learned
from the first canonical URL retained its title slug; its two-run diff found no matching
second request, and replay for the second post returned no results. It was not added.
The pages sent analytics requests during loading; capture stopped further POSTs after
the wait steps began. Reddit loaded reCAPTCHA resources; no CAPTCHA was reported by capture.
The unchanged spec passed all six `verify reddit` cases. A fresh-home `listPosts`
call passed at tier 2 after the plain HTTP challenge.
