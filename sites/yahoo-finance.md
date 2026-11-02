Use a Yahoo Finance ticker such as AAPL. The checked examples are U.S. stocks; other instruments have not been validated. No account is needed.

Prices may be delayed, and the primary quote can represent a closed market; consult the market notice. Values are formatted strings, including abbreviations and punctuation. Currency and exchange are not returned; the checked U.S. stocks are quoted in USD. Some statistics may be missing for other instruments.

## Maintainer notes

2026-11-01, logged out in an isolated browser profile. Captured the AAPL and MSFT public quote documents as two learning examples. A held-out NVDA tier-1 call matched the primary quote and summary statistics in its separately captured document. Browser capture aborted non-GET requests. No consent interstitial was encountered.

| Operation | Source |
| --- | --- |
| getQuote | GET `https://finance.yahoo.com/quote/{symbol}/`, using the primary price section and summary statistics in the server-rendered document. |

No crumb, cookie, or session value is required by the saved request. Plain HTTP initially encountered oversized response headers with browser identity headers, and the tier-1 fallback without those headers succeeded.

The chart page capture did not expose a completed `/v8/finance/chart/` request. Chart, symbol search, news, and separate key-statistics operations were not qualified. No write operation was attempted.
