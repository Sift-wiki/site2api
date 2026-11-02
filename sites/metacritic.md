No account or API key is needed. Search covers games, movies, TV and music, with the site's first page of results only. Music results use the type `album`; use the returned URL to identify a title and its slug.

Game scores and counts are for the default platform shown on the page, not all platforms combined. The platform can differ between titles; other platforms are not selectable here. Movie `year` is the displayed year, not a full release date. Counts are display text, scores are strings, and unrated titles may show `tbd` or omit fields. Summaries are the page's previews and may end in "Read More".

## Maintainer notes

Verified logged out on 2026-11-01 using an isolated api-anything home, with no imported cookies. Guest advertising cookies caused the learner to mark the captures as logged in; that metadata was corrected. The unnecessary `sec-ch-ua` session reference, incorrectly inferred from guest storage, was removed. All three operations use only GET documents from `www.metacritic.com`, parsed as server-rendered HTML. No backend host or public API key is used.

| Operation | Two learning examples | Held-out verification |
| --- | --- | --- |
| `search` | `elden ring`, `the godfather` | `parasite` returned the 2019 movie at 97, matching its public movie page. |
| `getGame` | `elden-ring`, `the-legend-of-zelda-breath-of-the-wild` | `hades` matched the page: PC, Metascore 93, 58 critic reviews, user score 8.5 and 5,461 ratings. |
| `getMovie` | `the-godfather`, `parasite` | `inception` matched the page: Metascore 74, 42 critic reviews, user score 8.8 and 4,190 ratings. |

The search recipe reads visible result cards. Detail recipes read the product hero, including the first and second score panels; counts remain as displayed. Game JSON-LD may report a different platform's critic count, so it is not used for those fields. An empty home replayed each operation at tier 1 without a session. `verify metacritic` passed all nine example and public checks.

The site automatically sent extensive advertising and analytics requests during page captures. None was selected as an operation. TV detail, critic-review listings and browse operations were not investigated or added; user-review writes were deliberately excluded. The site may change scores and page structure.
