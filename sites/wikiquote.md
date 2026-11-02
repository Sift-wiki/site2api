No account is needed. This is the English Wikiquote.

- `searchPages` returns up to ten title suggestions, not a full-text search. Use a result's key
  as the title for `getQuotes`; a description may be absent.
- `getQuotes` reads only lists directly under a top-level `Quotes` or `Sourced` heading.
  Subsections are omitted, so it can return very few items or fail on a page that has quotes.
  The full item text includes its nested notes; the separate source list can contain translations,
  variants or commentary rather than a citation, and can be empty. Formatting is flattened.
  Results are subject to the output cap; check `truncated`. Visit the page for full context.
- Top-level `Disputed` and `Misattributed` sections are excluded, but attribution is not
  independently verified. Check those sections and the original source before relying on a quote.
- `quoteOfTheDay` reads the current Main Page, not an archive. Its attribution is displayed text
  and may include punctuation or more than an author.
- Wikiquote content is generally available under CC BY-SA. Check attribution, licensing and any
  rights in the quoted work before reuse.

## Maintainer notes

Verified 2026-11-01, logged out. No login or write operation was used.

| Operation | Request and verification |
|---|---|
| `searchPages` | Typing `Einstein` and `Twain` on the Main Page captured `GET /w/rest.php/v1/search/title`. Held-out `Marie Curie` returned the matching page and description. |
| `getQuotes` | Captured the server-rendered `Albert_Einstein` and `Mark_Twain` pages. Held-out `Marie_Curie` matched its live page, including the first quotation and its 1894 letter note; its separate Misattributed section was excluded. Einstein's many subsection lists are omitted. |
| `quoteOfTheDay` | Reads the Main Page document's quote-of-the-day transclusion and `cquote` table. Compared the returned quote and attribution with the live Main Page. |

The search page attempted an analytics POST to `intake-analytics.wikimedia.org`; capture stopped
it. The quote selector does not traverse subsection lists, and the HTML recipe cannot extract
direct text nodes separately from nested lists, so it does not provide clean quote-only text or
section headings. A `Hamlet` call returned an input error because the selector matched no list;
the operation does not cover that work page. No edit operations were added.

The final spec passed `verify wikiquote`: 7 passed, 0 failed, 0 inconclusive. Fresh-home calls
for all three operations and subsequent calls used tier 1. Export with kept examples passed with
zero warnings and without `--force`.
