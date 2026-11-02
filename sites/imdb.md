No account is needed.

- `search` returns the search box's suggestions, up to about 8, titles and people mixed.
- `id` starts with `tt` for a title and `nm` for a person; use it in `https://www.imdb.com/title/<id>/`
  or `https://www.imdb.com/name/<id>/`.
- For a title, `type` is `feature`, `TV series`, `video game` and the like, and `stars` lists the
  main cast. For a person, `type` and `year` are missing and `stars` is their main job and best-known
  title (`Producer, Tenet (2020)`).
- Title details, cast, episodes and person pages are not covered.

## Maintainer notes

Verified 2026-11-01, logged out, from an isolated `API_ANYTHING_HOME` (no cookies, tier 1):
`api-anything verify imdb` passed 3 of 3 (the example, a `result` check and an `empty` check).
Learned from `inception` and `matrix`; held-out `interstellar` returned the 2014 film, `godfather`
returned The Godfather (1972, tt0068646) first, and `nolan` returned Christopher Nolan (nm0634240).

| op | args | returns | tier |
|---|---|---|---|
| `search` | `q` (example `inception`) | `id`, `name`, `year`, `type`, `stars` | 1 (JSON GET, about 0.1 s) |

```sh
api-anything call imdb search q=godfather
```

### How it works

The op replays the autocomplete request imdb.com's search box sends,
`GET https://v3.sg.media-imdb.com/suggestion/x/<q>.json`. The site puts the query's first letter
in the path segment before the query; the endpoint answers any letter there, so the spec keeps `x`.
The response's `d` array holds the suggestions.

### What failed

On 2026-11-01 www.imdb.com served AWS WAF challenges to the capture browser on both a title page
and the search page; work on www.imdb.com stopped after the second one. The suggestion host is
separate and answered every request. Title pages carry JSON-LD and `__NEXT_DATA__`, the likeliest
source for a `getTitle` op once the pages answer without a challenge.
