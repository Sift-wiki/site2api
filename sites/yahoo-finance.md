Use a Yahoo Finance ticker such as AAPL. The checked examples are U.S. stocks; other instruments have not been validated. No account is needed.

Prices may be delayed, and the primary quote can represent a closed market; consult the market notice. Values are formatted strings, including abbreviations and punctuation. Currency and exchange are not returned; the checked U.S. stocks are quoted in USD. Some statistics may be missing for other instruments.

Historical prices are daily rows from the history page's default date window, currently about one year. The operation does not accept a range or interval. Dividend and split event rows are excluded. Large results may be truncated by the output cap.

## Maintainer notes

2026-11-01, logged out in an isolated browser profile. Captured the AAPL and MSFT public quote documents as two learning examples. A held-out NVDA tier-1 call matched the primary quote and summary statistics in its separately captured document. Browser capture aborted non-GET requests. No consent interstitial was encountered.

| Operation | Source |
| --- | --- |
| getQuote | GET `https://finance.yahoo.com/quote/{symbol}/`, using the primary price section and summary statistics in the server-rendered document. |

No crumb, cookie, or session value is required by the saved request. Plain HTTP initially encountered oversized response headers with browser identity headers, and the tier-1 fallback without those headers succeeded.

The initial chart page capture did not expose a completed `/v8/finance/chart/` request. Chart, symbol search, news, and separate key-statistics operations were not qualified in that attempt. No write operation was attempted.

### 2026-11-01 continuation, logged out

Captured the AAPL and MSFT history documents as differing examples. A held-out NVDA call at tier 1 matched the first price row in a separate captured NVDA document. The HTML recipe excludes event rows, which do not have seven price cells. The document request needed the same plain-HTTP fallback without browser identity headers as the quote request.

| Operation | Source |
| --- | --- |
| getHistory | GET `https://finance.yahoo.com/quote/{symbol}/history/`, using the server-rendered daily price table. |

Search-box captures returned autocomplete results for Microsoft, Apple, and Nvidia, but the first direct replay returned HTTP 429. Search was not bundled. A later capture did observe a chart request, but configurable chart history, news, and key statistics were not qualified. Page loads included normal analytics and advertising traffic; non-GET requests during history captures and step-triggered non-GET requests during search captures were aborted.
