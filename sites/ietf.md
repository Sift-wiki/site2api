No account is needed. These are public Datatracker reads.

- `searchDocuments` searches RFCs and active drafts by name or title. Results are grouped by
  document status on the page, not necessarily by relevance. Dates are page text and can include
  badges such as “New”. Large result lists can be truncated. Search does not return group or area.
- `getRfc` takes digits only. `typeAndDate` is the page's combined metadata text, including
  relationships; individual relationship fields can be absent. The abstract comes from the page's
  Open Graph description, which may be partial or empty, especially for older RFCs. Page count
  and DOI are not included.
- `getDraft` takes a draft name without its revision suffix. `rev` is the current revision;
  `state` is the document's overall state, while `iesg_state` and `rfceditor_state` are separate
  workflow states and may be absent or null. Drafts and their statuses change over time.
- Full RFC text is not included. The Datatracker document page links to RFC Editor's text and HTML.

## Maintainer notes

Verified 2026-11-01, logged out. The final local spec passed `verify ietf` 7/7 at tier 1,
including a nonexistent RFC input check. An empty home replayed all three operations at tier 1.
Export with examples passed with zero warnings.

| op | request | learned examples | held-out comparison |
|---|---|---|---|
| `searchDocuments` | `GET /doc/search?name=...&sort=&rfcs=on&activedrafts=on`, HTML result rows | `quic`, `oauth` | `webtransport`, all four names, titles, dates and statuses matched the page |
| `getRfc` | `GET /doc/rfc<number>/`, HTML metadata | `9110`, `8446` | `2616`, title, date, stream and relationships matched the page; `791` also replayed in an empty home |
| `getDraft` | page's `GET /doc/<name>/doc.json` | `draft-ietf-quic-multipath`, `draft-ietf-moq-transport` | `draft-ietf-quic-load-balancers`, title, revision, authors, state, group, expiration and abstract matched the page |

The draft JSON contains author contact details, but the recipe selects author names only. The
search page did not request Tastypie document JSON during capture. The RFC Editor is a separate
registrable domain, which `vetShared` flags as off-site, so no cross-site text operation was added.
