These public reads use mastodon.social, not an arbitrary Mastodon server. Account names have
no leading `@`; remote accounts may use `name@domain` when known to this server.
Profile `note` and post content are HTML.

`getStatuses` returns the first page, excludes replies, and may include boosts. For a boost,
the boosted post's details appear in the `boosted_` fields; ordinary posts have no such fields.
Media types are reported for the outer post. Counts and posts change over time.

Status IDs are those known to mastodon.social. Post content is HTML. `getReplies`
returns available descendants, including nested replies, not just direct replies. Remote
replies may not be loaded for a logged-out visitor, so an empty result does not prove
there are no replies, even when the reply count is nonzero.

Use a hashtag without `#`. Trending posts, trending tags, and hashtag timelines are the
first page only and change over time. Tag history describes daily activity.

## Maintainer notes

Verified 2026-11-01, logged out. Both operations worked at tier 1 with an empty
`API_ANYTHING_HOME`, and later calls also used tier 1. No login or writes were attempted.

| op | examples | verification |
|---|---|---|
| `getAccount` | `Mastodon`, `Gargron` | Held-out `staff` matched the captured profile's display name and bio. |
| `getStatuses` | `Mastodon`, `Gargron` | Held-out `staff` matched the first post in its captured profile request. |

The profile loads `GET /api/v1/accounts/lookup?acct=...`, then the account's statuses
with `exclude_replies=true&exclude_direct=true`. Learning with `staff` and
`MastodonEngineering` automatically derived the account ID from the lookup's JSON `id`.
The first attempted pair, `Mastodon` and `Gargron`, did not expose a suitable lookup in
the capture; that add failed. The bundled derived slot uses the same public lookup.

In the earlier capture, logged-out requests to trending statuses, trending tags and the
`rust` tag timeline returned HTTP 200 but had not yet been authored and verified.
Status detail and context requests were also captured. One context was empty despite a
nonzero reply count; another returned descendants. Search was not tested.

### Additional public reads, 2026-11-01, logged out

The status and context requests came from post pages, trends from `/explore` and
`/explore/tags`, and timelines from `/tags/<tag>`. `/statuses/<id>` also triggered
the status and context requests without needing the account name.

| op | examples | verification |
|---|---|---|
| `getStatus` | `117466985005297414`, `117466983307949301` | Held-out `117411420916699261` matched the post page's captured status. |
| `getReplies` | same two status IDs | The held-out post's descendants matched the captured context, including nested replies. |
| `trendingStatuses` | none | Compared with the explore page request. |
| `trendingTags` | none | Compared with the explore tags page request. |
| `tagTimeline` | `rust`, `photography` | Held-out `mastodon` matched the captured tag timeline. |

These are read-only. No login or writes were attempted.
