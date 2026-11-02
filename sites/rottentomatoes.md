No account or API key was needed for the verified calls. `searchMovies` returns the first movie section of the public search page, up to ten fuzzy matches, with no pagination. Results can match cast or other metadata, so a title need not contain the query.

`getMovie` takes the slug after `/m/` in a search result URL. `tomatometer` is the percentage of positive professional critic reviews, not a mean star rating or an audience score. It can be blank or absent when unrated. `dateCreated` is the site's JSON-LD property and is not guaranteed to mean a worldwide release date. Its cast is the subset in the page's JSON-LD, not necessarily the full cast.

`getMovieScores` uses the same movie slug. Its audience count is a banded display string, not an exact count; the audience score can cover all ratings or verified ratings, as indicated by `audienceScoreType`. Scores or counts can be absent for unrated titles. Critic consensus and individual review text are not included.

`getTvSeries` takes the slug after `/tv/`; use the site's canonical URL when possible. Its start date and cast come from JSON-LD, and the cast can be incomplete. Seasons link to the individual season pages. Network and end year are not included.

`browseMovies` returns the first page only. Its category defaults to `movies_in_theaters`; `movies_at_home` and `movies_coming_soon` are also available. URLs are site-relative, and a blank score means the page did not display one. The lists can overlap and change; an at-home listing is not a guarantee of availability on a particular service.

## Maintainer notes

Verified signed out on 2026-10-26 UTC with an isolated api-anything profile and no imported browser session. The worker profile started empty. The learner marked the fresh visitor logged in because guest analytics/session cookies matched its heuristic; that metadata was corrected. A separate fresh home replayed the exported search and detail specs at tier 1 in 327 ms and 263 ms respectively, with no captured or imported Rotten Tomatoes cookies.

Search frontend captures: `cmvp0mnha`, request 1, for `q=Inception`; `cmvp0omzz`, request 1, for `q=The Matrix`. Source pages and captured requests are GET `https://www.rottentomatoes.com/search?search=Inception` and the same page with `search=The%20Matrix`. The recipe reads only movie rows in the server-rendered document, avoiding analytics requests that echo the page URL. The two-run diff had no warnings.

The unseen `q=Interstellar` replay succeeded at tier 1 in 195 ms. The first result was the 2014 film, with canonical URL `/m/interstellar_2014`, matching the public search page. It replaced Inception, the 2010 example. `getMovie` was learned from real frontend captures `cmvp0q2dk` and `cmvp0q4ax` at `https://www.rottentomatoes.com/m/inception` and `/m/interstellar_2014`. Its recipe reads the Movie JSON-LD script in the document, with no API endpoint or rotating query ID.

The unseen `slug=matrix`, taken from the captured Matrix search, replayed at tier 1 in 169 ms. It returned The Matrix, dateCreated 1999-03-31, the Wachowski directors and a critic score matching the captured search row. An earlier alias call using `the_matrix` redirected to `/m/matrix`; the saved check uses the captured canonical slug. `verify rottentomatoes` passed four cases, example plus a different-input result check per operation, all at tier 1, with no failures or inconclusive cases.

These operations fill signed-out movie identity lookup and public critic-score retrieval without app registration or API credentials. They use the public frontend's documents and are not presented as discovery of an official API. Official API product access, licensing and parity were not audited. The checks prove live data and different identities on this date; they do not freeze scores, ranking, or availability.

### 2026-11-01, logged out

Captured movie pages for `the_godfather` and `parasite_2019`: the scorecard script provides audience and critic ratings, and JSON-LD provides cast. The held-out `the_dark_knight` scorecard matched the page at 94 critic, 94 audience, and 337 critic ratings. TV captures for `breaking_bad` and canonical `the-wire` were used for learning; held-out `mad-men` matched the public page at 94 and seven seasons. The alias `the_wire` redirects to `the-wire`.

Browse captures used `movies_in_theaters` and `movies_at_home`; the held-out `movies_coming_soon` replay matched the server-rendered cards, including scores and release text. Lists overlapped on this date. All new reads replayed at tier 1 in a separate fresh home, without importing a session. Guest cookies caused the learner's logged-in heuristic to fire, so that metadata was corrected.

The critic review page fetched a JSON endpoint keyed by a movie EMS ID, but the slug-to-ID lookup was embedded in HTML rather than a JSON request the learner can derive. A reliable slug-based review operation was not added. Critic consensus and TV network/end year were not recovered in the recipes. The pages automatically sent advertising, analytics, and a theme-preference request during capture; no write operation was called or learned.
