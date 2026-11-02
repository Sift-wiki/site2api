No account is needed. The Federal Register publishes federal rules, proposed rules, notices and
presidential documents. For legal purposes, consult the official edition published by the Government
Publishing Office and applicable subsequent amendments. This is not legal advice.

- `search` returns the first page in the site's default order, not a complete set of matches.
  Search result dates are displayed as MM/DD/YYYY. Filters, ordering and pagination are not exposed.
- `getDocument` accepts the document number shown in a search result, including older numbers such
  as `E9-15194`. The summary and dates are page text, not separately normalized effective and
  comment-closing dates. They and other metadata may be absent. CFR and docket lists include at
  most four entries each; consult the full `metadata` text and document for any remaining entries.
  Docket entries can also include an agency's own identifier. The PDF link points to govinfo.gov.
- `agencyDocuments` returns the agency page's ten most recent documents, which may include documents
  of subordinate agencies. Use the agency slug from its Federal Register URL.

## Maintainer notes

Verified 2026-11-01, logged out. The local final spec passed `verify federalregister` 7/7,
including a nonexistent document input check. Export with examples passed with zero warnings.
An empty home replayed all three operations at tier 1.

| op | request | learned examples | held-out comparison |
|---|---|---|---|
| `search` | `GET /documents/search?conditions[search_type_id]=3&conditions[term]=...`, HTML results | `artificial intelligence`, `emissions standards` | `renewable energy`, compared the results with the captured page |
| `getDocument` | `GET /d/<document-number>`, follows redirect to HTML document | `2023-18624`, `2026-22082` | `2024-08791`, compared title, agencies, dates, docket, both CFR references and RIN with the captured page |
| `agencyDocuments` | `GET /agencies/<slug>`, HTML recently published section | `environmental-protection-agency`, `food-and-drug-administration` | `energy-department`, compared the first result with the captured page |

The search and document captures did not show the documented documents JSON API being requested.
They did show a clippings request and search-count requests, neither used for these operations.
The page also loads analytics. The document capture follows `/d/` to a different canonical URL for
each document, so two-run learning could not match the canonical paths. The request and match were
changed to the observed short URL and tested with both examples and a held-out document. No
comment submission or other write was performed.
