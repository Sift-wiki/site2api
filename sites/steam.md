No account or API key is needed. Searches the public Steam storefront and returns its first
page, up to 50 products. Products can include games, demos, soundtracks, packages and bundles.
The `itemKey` prefix identifies the kind, for example `App_504230` for Celeste. Store URLs can
include Steam's own tracking query parameters.

Prices and release dates retain the store's displayed text. Currency, availability, language,
ranking and content filters depend on Steam's signed-out regional defaults. A price may be
absent for a product not currently sold. No region override, pagination, account library,
or purchase operations are included. `listStore` returns the first page of top sellers by
default; `popularnew` and `popularcomingsoon` select popular new and upcoming releases.
Discount is present only on discounted products. Specials are not available as a list option.

`getApp` accepts a numeric app ID. The price fields describe the first purchase offer, which
may be missing or represent an edition or bundle rather than the base game. Discount fields
are present only when the offer is discounted. Platform values are Steam CSS class names.
Some apps have an age gate, which can prevent detail and review retrieval.

`getReviews` defaults to the storefront's first ten summary-ranked English reviews. It accepts
`filter` (`summary`, `all` for most helpful, `recent`, or `funny`), `language` (Steam language
codes or `all`), and `reviewType` (`all`, `positive`, or `negative`). It does not paginate.
Playtime is in minutes at review and dates are Unix seconds. `getReviewSummary` reports the review-section
counts, which can differ from the storefront's headline counts because their filters differ.
Reviews and scores change over time.

## Maintainer notes

Verified signed out on 2026-10-26 UTC using a new isolated browser profile, with no everyday
browser-cookie import. The learner's guest-session heuristic initially marked the operation
logged in; metadata was corrected because no login had occurred, then checked with a separate
fresh-home replay. No credentials or session slots are required.

Real browser captures `cmvp125w6` and `cmvp127ku` came from the source CLI's two-example add
at `https://store.steampowered.com/search/?term=portal` and the same page with `term=stardew`.
The operation reads the public search document itself. The request matcher uses GET, the
store host and `/search/`; no rotating identifier is pinned. Learning had no warnings and
retained tier 1.

The unseen `term=celeste` replay returned Celeste, `App_504230`, with its matching store URL
at tier 1 in 342 ms. Its identity differs from the Portal example. The first negative check
found that Steam omits `#search_resultsRows` entirely when no products match. A separate
public request confirmed HTTP 200 and "0 results match your search" with no result links.
The recipe was adjusted to the parent `#search_result_container`, observed in both layouts.
Offline extraction preserved 50 Portal rows and correctly recognized the empty layout.

Final verification passed three cases at tier 1: Portal returned results in 495 ms, Celeste
returned results in 739 ms, and nonsense `term=zzqxwyvpr` returned an empty list in 930 ms.
The negative expectation was preserved while the selector was repaired. No core code changed.
Export retained public examples and completed the secret scan without warnings.

The exported spec replayed unseen `term=hades` from a separate fresh home with no captured
or imported cookies. It returned Hades, `App_1145360`, at tier 1 in 1875 ms. Final shared
vetting of the spec and these notes returned zero errors and zero warnings.

Raw browser exchanges and response documents remain local and are not part of the shared spec.

### 2026-11-01, logged out

Added product details and separate review-list and review-summary reads. The detail operation
uses the server-rendered app document; the review operations use the `ajaxappreviews` GET
made when the page's review section is opened. Both learned with Celeste 504230 and Stardew
Valley 413150. Hollow Knight 367520 was held out: its name, price, developer, genre and score
matched its captured product page, and its review response and summary matched the captured
review-section request. The review request retains the page's observed summary-count query
values; despite differing between captures, the held-out response matched the page exactly.
The score summary and review list are separate to select only public display names, not
reviewer IDs or profile URLs.

The page attempted a usability-tracking POST on the review interaction. Capture stopped it,
and the operations do not send it. The learner marked the guest session logged in; the metadata
was corrected without importing cookies. In separate empty homes, Portal 2 620 returned
product details, reviews and a summary at tier 1. A nonexistent app was classified as input.
Verification passed ten cases at tier 1. At that point no top-seller, specials or player-count
operation, review filter options, pagination, or age-gate bypass had been added.

### 2026-11-01, logged out: store lists and review filters

Learned `listStore` from the public search documents for top sellers and popular new releases.
The held-out popular-upcoming document and tier-1 replay both began with ArcheAge Chronicles
and Loftia. `filter=specials` returned undiscounted products; the actual specials page uses
`specials=1`, so it was not included in this single-parameter operation.

Captured review controls on Celeste with recent, Simplified Chinese, and negative selected,
and on Stardew Valley with most helpful, Brazilian Portuguese, and positive selected. The
learned query slots preserve the original summary, English, and all-sentiment defaults. A
held-out Celeste summary/English/negative replay matched the captured page's first review
timestamps and sentiment. Two attempts to capture Hollow Knight's dropdowns timed out while
the controls moved or lost visibility, so dropdown-based healing may be sensitive to page layout.
The page attempted usability-tracking POSTs on review interactions; capture stopped them.
The learner's guest-login heuristic was corrected, with no cookies imported.
