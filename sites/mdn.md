These reads need no account and cover English MDN pages. Documentation content is generally
licensed under CC BY-SA; see the page's license and attribution requirements before reuse.

- Search returns the first 10 results. Use a result's `url` path after `/en-US/docs/` as the
  document slug, preserving case; the search `slug` itself is lowercased. Redirecting aliases can
  work too.
- Document sections are plain rendered text with their headings included where present, not
  structured heading/text pairs. The first section is usually the introduction. Code formatting
  and whitespace are not preserved; some markup artifacts can remain. The compatibility section
  may be empty because its table loads separately. The last-modified date may be absent.
- Results are capped at 20,000 JSON characters. Check `truncated`: a long document can lose later
  sections or shorten a section.
- Compatibility keys are case-sensitive BCD identifiers, not documentation slugs. Support is
  keyed by browser or runtime, with arrays of support statements; inspect all statements, including
  flags, notes and version removals. This returns the requested feature's own support, not its
  nested subfeatures.

## Maintainer notes

Verified 2026-11-01, logged out. The final bundled spec passed `verify mdn` with 5 pass, 0 fail,
0 inconclusive, all tier 1. An empty-home first call to `searchDocs` also succeeded at tier 1.

| op | frontend request | verification |
|---|---|---|
| `searchDocs` | GET `/api/v1/search?q=...&page=1&locale=en-US` from search | Captured `fetch` and `grid`; held-out `promise` matched the search response, including the first result. A nonsense query is empty. |
| `getDoc` | GET the server-rendered document, with the slug URL-encoded as one path segment | Captured `Web/API/Window/fetch` and `Web/CSS/Reference/Properties/grid`; held-out `Web/JavaScript/Reference/Global_Objects/Array/map` matched its page. A nonexistent slug returns input. |
| `getCompat` | GET `https://bcd.developer.mozilla.org/bcd/api/v0/current/<feature>.json`, as loaded by the compatibility table | Captured `api.fetch` and `css.properties.grid`; held-out `javascript.builtins.Array.map` matched its page's BCD request. |

The document capture and a soft navigation did not request an `index.json` twin, so the HTML
document was used instead. The BCD trigger opens the captured JSON URL directly because a feature
key does not determine a document URL. Both hosts share the registrable domain `mozilla.org`.
Search pagination was not proven and is not exposed. Pages sent their own telemetry and ad
requests during capture; none are operations. No account or contribution writes were attempted.
