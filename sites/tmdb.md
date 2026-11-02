No account or API key is needed for the observed search results. Search returns the first page of
movie, TV and person matches, grouped in the order served by the site. IDs are the numeric portion
of the result URL after `/movie/`, `/tv/`, or `/person/`. Dates, overviews and known-for text may be
missing. Rankings and the contents of the first page can change.

This product uses TMDB data. Check TMDB's current attribution and usage terms for your use.

## Maintainer notes

Observed logged out on 2026-11-01 local time using isolated api-anything homes. Search captures used
`Inception` and `Brad Pitt`; the held-out `Breaking Bad` returned the series at `/tv/1396-breaking-bad`
and its first-air date. A separate fresh home returned the same held-out result at tier 1.

| Operation | Request | Extraction |
| --- | --- | --- |
| search | GET `www.themoviedb.org/search?query=...` | Server-rendered movie, TV and person result sections |

Both search replays first reported a challenge page (HTTP 403), then succeeded at tier 1 without
browser identity headers. Further requests to search were stopped after the second challenge.
Later the same day, `verify tmdb` on the final spec from an empty home passed 3 of 3 (the example,
the `Breaking Bad` result check and the missing-query input check), all at tier 1.

The numeric movie URL `/movie/238` redirected to the canonical slug URL in a logged-out capture.
Movie detail replays for IDs 550 and 27205 returned Fight Club and Inception after the same 403
challenge and retry pattern. Further movie requests were stopped after those two challenges; the
partially learned movie operation was excluded because it could not meet the final verification
requirement. Credits, providers, TV details, seasons and people were not learned. The pages sent
advertising and consent-related requests automatically; no write operation was learned or called.
