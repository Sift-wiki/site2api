No account is needed.

- Only amazon.com is covered. Search defaults to page 1; pass `page` to request another page.
- Sponsored results are included as the page shows them. Items without a price omit `price`.
- Amazon answers automated traffic with a 503 "automated access" page or a captcha; api-anything
  classifies both as `blocked` and escalates to Chrome. If a real Chrome is challenged too, ask the
  user to run `api-anything login amazon` and clear it. Keep call volume human.

## Maintainer notes

Verified 2026-11-01, logged out, with `api-anything verify amazon` passing from a separate
`API_ANYTHING_HOME` (no imported cookies, tier 1).

| op | args | returns | tier |
|---|---|---|---|
| `search` | `k` (example `kettle`), `page` (default `1`) | a results page: `asin`, `title`, `price` | 1 (HTML GET of /s) |

```sh
api-anything call amazon search "k=french press" page=3
```

### How it works

The op reads the server-rendered results page (`GET /s?k=...&page=...`) with an `--html` recipe:
items are `div[data-component-type=s-search-result]`, with the ASIN from `data-asin`, the title
from `h2.a-text-normal` and the price from `.a-price .a-offscreen`. Some results (electronics) put
the brand in an `h2` of its own above the title; on 2026-10-31 the recipe moved from `h2` to
`h2.a-text-normal`, so `title` is the product's name there too (`iphone 18 pro`, `kettle` and
`lego` checked live at tier 1). On 2026-11-01, page 3 of `french press` matched the captured
page's first product and price, and differed from page 1. Search ordering and prices can change.

A logged-out product page for `B09B8V1LZ3` loaded and exposed product details in server-rendered
markup, but two subsequent product-page captures returned Amazon challenge pages (HTTP 404).
Product capture stopped there, so no product operation was added. Reviews, offers, autocomplete,
and guest-cart interception were not attempted.
