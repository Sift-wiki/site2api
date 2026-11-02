No account is needed. For RFC and Internet-Draft search and metadata, use the separate `ietf`
site.

`getRfcText` returns the RFC Editor's plain-text document as a string. Results are capped at
about 20,000 characters and may be truncated; inspect the `truncated` and `more` fields to
retrieve more of the locally retained result. For the complete original, use
`https://www.rfc-editor.org/rfc/rfc<number>.txt`.

## Maintainer notes

Verified 2026-11-01, logged out. The final spec passed `verify rfceditor` 3/3 at tier 1,
including a nonexistent RFC input check. A fresh home called RFC 7231 and then RFC 791 at
tier 1. Export with examples passed with zero warnings.

| op | request | learned examples | held-out comparison |
|---|---|---|---|
| `getRfcText` | `GET /rfc/rfc<number>.txt`, raw text response | `9110`, `8446` | `791`, title and opening text matched the HTML rendering; `7231`, title and abstract matched the info page |

The info URL redirects to a server-rendered page that embeds the full RFC, and a broad DOI
selector picked a reference instead of the document's DOI. The errata URL redirects to the
separate errata service; records may omit corrected text, so positional `pre` selectors
can mistake notes for corrections. Neither metadata nor errata is included without a reliable
recipe. Errata submission is out of scope.
