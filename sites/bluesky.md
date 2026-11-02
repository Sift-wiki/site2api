No account is needed for these public reads. Handles are given without `@`.

- `getPosts` returns the first page, including pinned posts and reposts, not a complete timeline.
  `reason` is `app.bsky.feed.defs#reasonRepost` for a repost and is absent on ordinary posts.
  `embedType` is absent when the post has no embed.
- `getThread` returns a flat list: depth 0 is the requested post, negative depths are ancestors,
  and positive depths are replies. The page's request limits branching and depth, so replies may
  be missing; `moreReplies` can indicate further replies. Some unavailable or moderated entries
  may not have post fields. The response may be truncated by api-anything's output cap.
- A missing required handle is an input error. An unknown handle returned HTTP 400
  `Profile not found`, classified as `error`, not `input`, in testing.

## Maintainer notes

Verified 2026-11-01, logged out. All three operations returned at tier 1 from an empty
`API_ANYTHING_HOME`; subsequent calls also used tier 1. No login or writes were attempted.

| op | examples | verification |
|---|---|---|
| `getProfile` | `bsky.app`, `jay.bsky.team` | Held-out `nytimes.com` matched the page's name, bio and counts. |
| `getPosts` | `bsky.app`, `jay.bsky.team` | Held-out `nytimes.com` matched the first visible post; `atproto.com` included reposts. |
| `getThread` | `bsky.app` / `3l6oveex3ii2l`, `jay.bsky.team` / `3mxz7goeycc2f` | Held-out `nytimes.com` / `3mzceboitx622` matched the post and visible reply. |

The profile page first calls `com.atproto.identity.resolveHandle`, then sends the DID to
`app.bsky.actor.getProfile` and `app.bsky.feed.getAuthorFeed`. Two capture runs could not
automatically learn the lookup because the captured resolver request had a changing session
header. The spec uses the same public GET endpoints with the handle directly as `actor`,
tested on both examples and the held-out account; no derived lookup or session is needed.
The feed request uses `filter=posts_and_author_threads`, `includePins=true`, and `limit=30`.

The post page calls `app.bsky.unspecced.getPostThreadV2`, not `getPostThread`, with an
`anchor` of `at://<handle>/app.bsky.feed.post/<rkey>`. The handle is accepted directly, so no
DID lookup is needed. The request uses `branchingFactor=1`, `below=10`, `sort=top`, and
`above=true`. Its device and analytics session headers were removed after capture and are
not needed for the tested public calls. The page also loads analytics/config requests, which
are not part of these operations.

The captured search page made no search data request. Typeahead and post search were not
established and are not included; this does not establish whether either works logged out.
The API hostname is `public.api.bsky.app`. With this checkout's `tldts` rules, both it and
`bsky.app` resolve to registrable domain `bsky.app`, so `vetShared` reported no off-site
warning and no errors.
