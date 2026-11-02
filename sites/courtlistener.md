No account is needed for opinion search. This is not legal advice; coverage varies by court and
may be incomplete. Consult the court and current authoritative sources before relying on a result.

`searchOpinions` returns the first page in relevance order. The case name includes the court
abbreviation and year where the page supplies them. Citations and snippets may be absent. The
result URL contains the opinion's ID and slug. CourtListener's AWS WAF challenges plain HTTP, so
calls run in the browser: the first call from a fresh install can take a full page load (tier 3),
later ones about one browser fetch (tier 2). Keep call volume low.

## Maintainer notes

Verified 2026-11-01, logged out. The final search spec passed `verify courtlistener` 2/2 at tier 2.
A fresh home returned the held-out search at tier 3 after a tier-2 AWS WAF challenge; direct HTTP
had also received a challenge. No further search requests were made after the second challenge.

| op | request | learned examples | held-out comparison |
|---|---|---|---|
| `searchOpinions` | `GET /?q=<q>&type=o&order_by=score%20desc`, server-rendered result articles | `miranda warning`, `fair use software` | `Brown v Board of Education`, first ID, name, date and citations matched the page |

The opinion route `/opinion/<id>/<slug>/` served HTML, but opinion requests encountered two WAF
challenges, so detail was not included. `/opinion/107196/` returned 404; a wrong slug with that
ID displayed the ID's opinion, not the slug's. A detail page's JavaScript automatically sent a
view-count analytics POST; no write operation was learned or called. `citedBy` and sort options
were not verified.
