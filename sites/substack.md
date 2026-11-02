No account is needed. This site currently searches profiles, not the full publication directory.
Some profiles have no primary publication, so its name and subdomain can be absent. The bio is
the profile's description, and the subscriber count is a display string, sometimes not a number.
Results are the first page. Reading posts, comments, and paid content is not supported.

## Maintainer notes

Verified 2026-11-01, logged out.

| op | learned with | held out |
|---|---|---|
| `searchPublications` | `rust`, `climate` | `astronomy`, first result matched the profile-search page's response; a nonsense query returned no profiles |

The profile search page fetches `GET https://substack.com/api/v1/profile/search` with the query
and page zero. It searches profiles, which may or may not have primary publications. The separate
publication-search endpoint returned no results for `climate`.

The general top-search response mixes posts and other activity, and a nonsense query returned
unrelated posts; extracting posts also included nulls. It was not bundled as post search.
Publication archives use each publication's host: the observed Noahpinion subdomain redirected to
its custom domain before fetching the archive. The request codec has no host slot, so a caller
cannot select a publication host in a shared operation. A fixed-host profile page fetched a feed
by numeric profile ID, not a publication archive by handle. Consequently this spec does not
offer archive, post or comment reads. No paywall was bypassed and no write was exercised. Pages
sent analytics and challenge-related requests on their own.
