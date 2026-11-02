No account is needed. The ECB usually publishes reference rates around 16:00 CET on
TARGET working days. They are for information only, not transaction rates.

Rates are units of the named currency per 1 EUR. To convert from one non-EUR currency
to another, divide the destination currency's EUR rate by the source currency's EUR rate.
The latest table returns parallel arrays: entries at the same index belong together.
Values are strings, preserving the precision shown by the ECB.

History covers the four calendar months shown on the currency page. Each day entry
contains the day of the month followed by its rate; an entry with only a day has no
published rate. Combine the day with its month heading to get the full date.

## Maintainer notes

Verified 2026-11-01, logged out. The latest table showed 30 October 2026, including
USD 1.1172, GBP 0.83380, JPY 175.68, CHF 0.9194 and CNY 7.4326. History was learned
with `usd` and `gbp`; the held-out `jpy` page and call both showed 30 October at
175.68 and 29 October at 175.92. Verification also called `chf` and `cny`.

| op | request | verification |
|---|---|---|
| `getRates` | GET the reference rates HTML document | Compared date and rates with the live table |
| `getCurrencyHistory` | GET the currency's `eurofxref-graph-<currency>.en.html` document | Compared held-out JPY calendar with the live page |

The history page embeds chart data as JavaScript statements and also links an XML
download. The daily rates page links XML too, but the extractor has no XML recipe.
Both operations instead read the visible server-rendered HTML tables. Checks verify
nonempty results and lowercase input, not numeric rate ranges or array alignment.
The captured pages loaded an analytics script; no writes were attempted.
