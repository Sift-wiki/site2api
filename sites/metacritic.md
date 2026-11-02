No account or API key is needed. Search covers games, movies, TV and music, with the site's first page of results only. Music results use the type `album`; use the returned URL to identify a title and its slug.

Game scores and counts are for the default platform shown on the page, not all platforms combined. The platform can differ between titles; other platforms are not selectable here. Movie `year` is the displayed year, not a full release date. Counts are display text, scores are strings, and unrated titles may show `tbd` or omit fields. Summaries are the page's previews and may end in "Read More".

TV `year` is the displayed start year and `releaseDate` is the first season's premiere. Critic reviews use the site's default platform for games and its default season selection for TV. Review dates and critic names may be absent; critic names retain the displayed "By" prefix. Browse and critic reviews return only the first page, ordered by the site's default Metascore sort. TV browse excludes titles with fewer than seven critic reviews.

## Maintainer notes

Verified logged out on 2026-11-01 using an isolated api-anything home, with no imported cookies. Guest advertising cookies caused the learner to mark the captures as logged in; that metadata was corrected. The unnecessary `sec-ch-ua` session reference, incorrectly inferred from guest storage, was removed. All three operations use only GET documents from `www.metacritic.com`, parsed as server-rendered HTML. No backend host or public API key is used.

| Operation | Two learning examples | Held-out verification |
| --- | --- | --- |
| `search` | `elden ring`, `the godfather` | `parasite` returned the 2019 movie at 97, matching its public movie page. |
| `getGame` | `elden-ring`, `the-legend-of-zelda-breath-of-the-wild` | `hades` matched the page: PC, Metascore 93, 58 critic reviews, user score 8.5 and 5,461 ratings. |
| `getMovie` | `the-godfather`, `parasite` | `inception` matched the page: Metascore 74, 42 critic reviews, user score 8.8 and 4,190 ratings. |

The search recipe reads visible result cards. Detail recipes read the product hero, including the first and second score panels; counts remain as displayed. Game JSON-LD may report a different platform's critic count, so it is not used for those fields. An empty home replayed each operation at tier 1 without a session. `verify metacritic` passed all nine example and public checks.

The site automatically sent extensive advertising and analytics requests during page captures. None was selected as an operation. At that time TV detail, critic-review listings and browse operations were not investigated or added; user-review writes were deliberately excluded. The site may change scores and page structure.

### Extension verified 2026-11-01, logged out

The additional reads use GET documents on www.metacritic.com. Learning used Breaking Bad and The Wire for TV, Elden Ring and The Godfather for critic reviews, and game and movie browse pages. Guest advertising storage again caused an unnecessary client-hint session reference and logged-in flag; both were removed.

Held-out Severance matched its public profile: 85 Metascore, 82 critic reviews, 8.3 user score, 1,059 ratings, 2022, Feb 18, 2022 premiere and Apple TV+. Its critic-review page matched the first Collider review's score, critic, date and quote. The held-out TV browse page matched Planet Earth: Blue Planet II, its URL, score 97 and Jan 20, 2018 release. The critic-review page can omit dates, as seen for The Godfather. Browser captures automatically sent advertising and analytics requests; none was chosen. Writes remain excluded.
