No account is needed. Guardian content is copyrighted: use links and summaries, and respect its
reuse terms. Edition and region can affect the stories shown.

- `getFront` accepts one path segment, defaulting to `international`. Cards can repeat, link to
  video or interactive content, and omit standfirst, kicker or date. Results may be truncated.
- `getArticle` accepts the five separate segments of a standard
  `/<section>/<yyyy>/<mon>/<dd>/<slug>` URL, not a full URL. Other URL shapes, including
  interactive and video URLs, are not covered. Keywords are a comma-separated string. The
  standfirst may include related links; body paragraphs exclude nested content and may omit
  non-text elements. Metadata may be missing and long results may be truncated.
- `getTag` accepts exactly two path segments, such as `technology` and
  `artificialintelligenceai`. Results cover the first page and may include opinion or other
  formats. Dates and kickers can be missing.

## Maintainer notes

Verified 2026-11-01 local time, logged out (capture timestamps were 2026-11-02 UTC). Final
`verify guardian` passed six cases at tier 1. A fresh data home called all three ops at tier 1.

| op | learning examples | held-out comparison |
|---|---|---|
| `getFront` | `international`, `world` | `technology`, first headline matched the page |
| `getArticle` | `world/2026/nov/01/ukraine-defies-trump-resumes-attacks-russian-oil`, `thefilter/2025/sep/19/best-led-red-light-therapy-face-masks` | `business/2026/oct/29/binance-crypto-exchange-hack`, headline and paragraphs matched the page |
| `getTag` | `technology/artificialintelligenceai`, `world/ukraine` | `world/russia`, first headline matched the page |

Each operation GETs a server-rendered document from `www.theguardian.com`. Front and tag cards
come from HTML; article metadata comes from HTML and meta tags, and body paragraphs from the
main content container. The page also made analytics, advertising and consent requests. Captures
did not show a front JSON data request; a topic page loaded an advertising script from
`api.nextgen.guardianapps.co.uk`, which is not used by these operations. No Content API or writes
were used. Path segments are separate because path slots encode slashes.
