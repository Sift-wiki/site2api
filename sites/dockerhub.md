No account is needed. Use `library` as the namespace for Docker Official Images.

- Counts are Docker Hub's displayed strings, often rounded (for example, `1B+`). The update
  time is relative on repository pages and may be absent for official images. Badges are the
  labels rendered on the page; an empty list does not prove that a publisher is unverified.
- Tags are the first page, sorted as displayed by Docker Hub, and can include signatures and
  other artifacts. Platform details are a preview, not a complete manifest: the page shows at
  most a few rows, and some tags show none. The digest, platform and compressed-size arrays
  correspond by position for displayed rows. Digests are shortened, not full SHA-256 values.
- Search and image pulls are not covered.

## Maintainer notes

Verified 2026-11-01, logged out. The two learning examples were `bitnami/redis` and
`hashicorp/terraform`. The held-out `library/nginx` result matched the official overview and tags
documents, including the official badge and the first tag's displayed platform rows. Both reads
worked at tier 1 on the first call from an empty home. The final spec passed `verify dockerhub`
(4 pass, 0 fail, 0 inconclusive).

| op | frontend request | held-out check |
|---|---|---|
| `getRepository` | GET `/r/<namespace>/<name>`, extract the server-rendered overview | `library/nginx`, official badge and displayed counts |
| `listTags` | GET `/r/<namespace>/<name>/tags`, extract server-rendered tag cards | `library/nginx`, `stable-trixie` and its displayed platforms |

Docker Hub redirects `/r/library/<name>` to `/_/<name>`; direct HTTP replay followed that redirect.
The capture saw no repository or tag JSON XHR. The in-app `.data` response uses a turbo-stream
format that the current extractor does not support. Search returned a Cloudflare challenge, so no
search operation was added. The pages themselves also sent third-party Qualtrics survey POSTs;
no write operation was learned or called.
