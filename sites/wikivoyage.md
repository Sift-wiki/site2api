English Wikivoyage is public and needs no account for these reads.

- Search matches title prefixes and returns up to ten suggestions, including district articles.
  Pass a result's `key` as the title for a guide or summary. Descriptions and coordinates may be
  missing.
- `getSections` returns the lead first, without a heading, then top-level sections in page order.
  Paragraphs from nested subsections are grouped under their top-level heading without subsection
  headings. Lists, tables and individual listings outside paragraphs are not included. Large
  guides can exceed the result cap: check `truncated` and use the result ID and `more` to retrieve
  remaining items. Large cities often have separate district guides.
- Travel information and listings can be outdated. Confirm prices, hours and safety information
  independently. Wikivoyage text is generally licensed under CC BY-SA; check attribution and
  licensing requirements before reuse.

## Maintainer notes

Verified 2026-11-01, logged out. Paris and Kyoto were the two learning examples for each
operation. Lisbon was held out and compared with the public guide: the summary matches the lead
and coordinates, and the Understand section's text matches the page. The Lisbon search returned
Lisbon first and district articles also present on the guide. All answered at tier 1.

| operation | request and extraction | held-out check |
|---|---|---|
| `searchDestinations` | Search-box `GET /w/rest.php/v1/search/title`, extracting `pages` | Lisbon |
| `getSummary` | Page-preview `GET /api/rest_v1/page/summary/<title>` | Lisbon |
| `getSections` | Server-rendered `GET /wiki/<title>`, top-level sections and descendant paragraphs | Lisbon |

The search page attempted an analytics POST during learning; the capture stopped it. A `:has`
section selector matched nothing in the recipe engine, so the working selector includes the lead.
Listings were not added: `.vcard` alone also matches entries outside the requested listing
sections and does not identify their type. No editing or other write operation was learned.
