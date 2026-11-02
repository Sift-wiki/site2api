These public reads use mastodon.social, not an arbitrary Mastodon server. Account names have
no leading `@`; remote accounts may use `name@domain` when known to this server.
Profile `note` and post content are HTML.

`getStatuses` returns the first page, excludes replies, and may include boosts. For a boost,
the boosted post's details appear in the `boosted_` fields; ordinary posts have no such fields.
Media types are reported for the outer post. Counts and posts change over time.

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

Logged-out requests to trending statuses, trending tags and the `rust` tag timeline also
returned HTTP 200, but are not included because they were not fully authored and verified.
Status detail and context requests were captured, but are not included. One context was
empty despite a nonzero reply count; another returned descendants. Search was not tested.
