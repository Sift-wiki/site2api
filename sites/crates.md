No account is needed for these reads. crates.io asks for at most one request per second: space
calls out.

- Search defaults to relevance and page 1, with up to 10 results per page. The optional `sort` is
  `relevance`, `downloads` (all time), `recent-downloads`, `recent-updates`, `new`, or `alpha`.
  `page` is a positive whole number. Versions are sorted by publication date, first page only, up
  to 100. Reverse dependencies return the first page, up to 10.
- The category index returns up to 100 categories. Keyword listings return the first 10 crates,
  sorted by recent downloads.
- `defaultVersion` is the version selected by crates.io for the crate page, not necessarily the
  highest version. The detail license belongs to that version. Links and license can be null.
- Pass an exact published version to `getDependencies`. Its `req` is a Cargo version requirement;
  `kind` distinguishes normal, build and development dependencies.
- Reverse dependency versions are versions of the dependent crates, not requirements on the
  queried crate. Owners can be users or teams; their names can be null.
- A nonexistent crate returns an input error. Publishing, yanking and owner changes are not covered.

## Maintainer notes

Verified 2026-11-01, logged out. Two captures per operation used `serde` and `tokio`; held-out
`rand` calls matched the corresponding page requests. The original exported spec passed `verify crates`
(8 pass, 0 fail, 0 inconclusive), all at tier 1. A first call from an empty home (`getCrate rand`)
also succeeded at tier 1.

| op | frontend request | held-out check |
|---|---|---|
| `getCrate` | `/api/v1/crates/<name>?include=keywords,categories,downloads,default_version` from the crate page | `rand`, default version `0.10.3` and its license |
| `searchCrates` | `/api/v1/crates?page=1&per_page=10&sort=relevance&q=...` from search | `rand`, first result `rand`; nonsense query empty |
| `getVersions` | `/api/v1/crates/<name>/versions?sort=date&per_page=100&include=release_tracks` | `rand`, first release `0.10.3` |
| `getDependencies` | `/api/v1/crates/<name>/<version>/dependencies` from the version page | `rand` `0.10.3`, including `rand_core` |
| `getReverseDependencies` | `/api/v1/crates/<name>/reverse_dependencies?page=1&per_page=10` | `rand`, including `tokio` |
| `getOwners` | `/api/v1/crates/<name>/owners` from the crate page | `rand`, a user and a team |

- The detail response's `max_version` and `newest_version` were `0.0.0` and
  `max_stable_version` was null for `serde` with this include set. The page's `default_version`
  is returned instead; search has a populated `max_version`.
- Reverse dependency names and versions come from the response's `versions` array, not the
  `dependencies` array, whose `crate_id` is the queried crate.
- No writes were tried.

### Additional reads, 2026-11-01 (logged out)

- The exported spec passed `verify crates` from a fresh home: 13 pass, 0 fail, 0 inconclusive,
  all at tier 1. A fresh-home search call also succeeded at tier 1.
- Search captures used `serde` / `downloads` / page 2 and `tokio` / `recent-downloads` / page 3.
  A held-out `rand` / `alpha` / page 2 call matched the search-page XHR, starting with `a1-ai`.
  Changing sort and page separately for `serde` changed the results. The original defaults remain
  relevance and page 1.
- `/categories` loaded `/api/v1/categories?page=1&per_page=100&sort=alpha`, with 58 entries at
  capture. `/keywords/async` and `/keywords/cli` loaded the keyword-filtered crates request;
  held-out `serde` matched its page XHR, starting with `serde_json`.
- A category detail page sends separate requests for metadata and its crates. The current response
  recipe cannot combine the two, so no combined `listCategory` is included.
- Crate pages fetch rendered README HTML from `static.crates.io`, on the same registrable site.
  Captures for `serde` and `serde_json` returned HTML fragments without a stable enclosing element;
  the whole-body HTML recipe matched nothing. README extraction is not included.
