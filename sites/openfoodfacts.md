No account is needed for the product lookup. Open Food Facts data is crowdsourced and available
under the Open Database License (ODbL); records can be incomplete or wrong. Do not rely on it
alone for allergy or dietary decisions.

- Supply the barcode as a string, preserving leading zeroes. An unknown barcode can return an
  input error.
- The product name is the page heading and can include the brand and quantity. Nutrition values
  are the page's text for 100 g or 100 ml, including units; `?` means unknown.
- The three scores are image URLs, not bare grades: the filename identifies the grade or NOVA
  group where available. The environmental score is now displayed as Green-Score.
- Fields can be missing. Absence of an allergen field does not mean a product is allergen-free.
  Search and category or brand listings are not included.

## Maintainer notes

Verified 2026-11-01, logged out. Two product captures used Nutella `3017620422003` and Coca-Cola
`5449000000996`. The held-out Barilla `8076800195057` call matched the product page: 500 g,
gluten, 359 kcal, 13 g protein per 100 g, Nutri-Score A and NOVA 1. A first call from an empty
home and later calls succeeded at tier 1. The final spec passed `verify openfoodfacts` with 2
passes, 0 failures and 0 inconclusive; the unknown barcode `0000000000000` returned 404.

| op | frontend request | held-out check |
|---|---|---|
| `getProduct` | GET the server-rendered product page, following its canonical redirect; extract displayed HTML | Barilla spaghetti `8076800195057` |

The page did not request product JSON on initial load, so the operation uses the captured document
rather than claiming an unobserved JSON request. Its canonical slug varies by product; the stored
example slug redirects to the requested barcode's canonical page. HTML selectors and page wording
may change. The page itself loads Matomo analytics; no write operation was attempted.

The search page and category page returned HTTP 503 with the site's anonymous-access/high-demand
message. They were not retried, and search, category and brand operations were not added.
