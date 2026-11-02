No account is needed. BBC content is copyrighted; use summaries and links and respect its reuse
terms. Region can affect the stories shown.

- `getSection` takes one top-level path segment, defaulting to `news`. For `/news/world` use
  `getNewsSection` with `world`. Multi-segment paths are not supported by either operation.
- Section results can include video, live coverage and links outside BBC News. Cards can repeat,
  and summaries, dates and topics are not present on every card. Dates are displayed relative text.
- `getArticle` takes the final segment of a `/news/articles/<id>` URL, not a full URL or an older
  `/news/<slug>-<number>` URL. Text is flattened and can include editorial follow links; non-text
  content is omitted. Byline spacing can be flattened, and metadata or topics can be absent.
  Long results can be truncated.

## Maintainer notes

Verified 2026-11-01 local time, logged out (capture timestamps were 2026-11-02 UTC). Final
`verify bbc` passed 6 cases at tier 1; a fresh data home called the default section at tier 1.

| op | learning examples | held-out comparison |
|---|---|---|
| `getSection` | `news`, `business` | `technology`, first titles and links matched the page |
| `getNewsSection` | `world`, `uk` | `scotland`, first titles and links matched the page |
| `getArticle` | `c51kdy1ew7zvo`, `c64g1y90p71eo` | `cq5ynzvkn1d8o`, headline and paragraphs matched the page |

All operations GET server-rendered documents from `www.bbc.com`. Section cards are extracted from
the page markup; article dates come from meta tags, and article paragraphs and topics from visible
markup. Captures also showed analytics, consent, advertising and unrelated `bbci.co.uk` requests
made by the page; none is an operation. No writes were exercised.

Search was not bundled: both captures redirected to a short-lived `edgeauth` URL, and no search
JSON request was observed. The parameterized nested path `news/world` encoded the slash and
returned 404, so a separate single-segment subsection operation is used. `/news/technology`
redirected to `/technology`. A tested older slug URL redirected to a topic listing, not an article;
older article URLs are not covered. An older long-lived article example was not verified.
