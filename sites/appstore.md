# App Store public listings

Use the numeric ID following `id` in an App Store app or developer link. `getApp` defaults to the US storefront; `gb` was also checked. Availability, prices, ratings and language depend on storefront and can change. The description is the page's structured-data description, which may be shortened. Compatibility is Apple's summary, not a device eligibility check. Age rating, version, release notes and size are not included.

`getReviews` returns the US app page's featured review shelf, not a chronological or complete review feed. Dates are timestamps in the page data. `getDeveloperApps` returns initial US developer-page shelf items, including duplicate entries and sometimes app bundles; it is not a complete catalog and does not identify categories. `search` returns initial US iPhone page results, without developer names or pagination. Ratings are display labels and may be absent.

## Maintainer notes

Verified logged out on 2026-11-01 (the capture host's UTC timestamps had crossed into 2026-11-02). No account, imported cookies, or per-visitor token was used. All operations read GET documents from apps.apple.com. Capture allowed the page's own background analytics; no write operation was learned or called. No bearer token is stored or required, and the separately documented iTunes Search API was not used.

| Operation | Evidence |
| --- | --- |
| getApp | Spotify US and Instagram GB captures; held-out Duolingo US compared with its live listing. |
| getReviews | Spotify and Instagram US captures; held-out Duolingo reviews compared with its listing. Featured reviews are not necessarily recent. |
| getDeveloperApps | Google and Duolingo captures; held-out Spotify shelves compared with its live developer page. |
| search | Music and weather captures; held-out chess results compared with the search page. |

Details come from the document's `SoftwareApplication` JSON-LD, reviews and developer shelves from `serialized-server-data`, and search from the rendered document's result cards. App and developer request paths retain the captured slug; Apple redirected the held-out IDs to their correct canonical slugs. Source structures do not reliably expose app categories in developer cards, and the search cards did not expose developer names. The extra detail fields are not combined with JSON-LD because a positional metadata recipe would not reliably identify them across listings.
