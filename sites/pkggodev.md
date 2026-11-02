These reads work without an account. Pass Go import paths without a leading slash.

- Search returns the first page, up to 25 packages. Search paths are absolute pkg.go.dev URLs.
  Synopsis, license and publication date can be absent.
- Package metadata is a one-item list. `kind` includes `standard library` for standard packages
  and `module` when the package is also a module root. Version, publication and count values
  retain their page labels. The module path is not separately returned.
- The documentation index returns the page's displayed signature lines and links. The signature
  includes the kind and name; methods appear as `func` with a receiver. Constants and variables
  may appear only as section links, not individual names. Packages with no documentation index
  may return an input error. Large indexes can be truncated.
- Version history and importing-package listings are not included.

## Maintainer notes

Verified 2026-11-01, logged out. Search examples were `websocket` and `router`; package and
index examples were `net/http` and `encoding/json`. The final spec passed `verify pkggodev`
(7 pass, 0 fail, 0 inconclusive), all at tier 1. A first call from an empty home for
`golang.org/x/sync/errgroup` also succeeded at tier 1.

| Operation | Frontend request | Held-out comparison |
|---|---|---|
| `searchPackages` | GET `/search?q=...&m=package`, server-rendered snippets | `yaml`, first result `gopkg.in/yaml.v3`, v3.0.1, Apache-2.0 and MIT |
| `getPackage` | GET `/<import path>`, server-rendered header and overview | `github.com/stretchr/testify`, v1.12.1, MIT, 0 imports and 15 imported by |
| `getIndex` | Same document, documentation index | `golang.org/x/sync/errgroup`, Group and five function/method lines |

The CLI encodes the import path's slashes in its single path slot; pkg.go.dev served those URLs
for the examples and held-out packages. The missing-package check returned input. The page also
sends analytics requests; no write operation was learned or called.

The versions tab has sibling elements for tags and dates, with only some dates in expandable
summaries. The attempted parallel-array extraction did not align, so it was omitted. The
imported-by tab returned 20,000 entries for `net/http`, making its unpaged output impractical;
it was omitted. No separate JSON fragment was selected over the document.
