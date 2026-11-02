No account is needed. Wikidata's structured data is available under CC0; other content, including
linked Wikipedia articles, can have different licenses.

- `searchEntities` returns at most 10 matches. Search defaults to items; lexeme searches can
  include matches in languages other than English.
- `getEntity` accepts item IDs (`Q` followed by digits). It reads the English item page and
  returns only selected displayed statements: P31 (instance of), P569 (date of birth), P19
  (place of birth), P106 (occupation), P17 (country), and P131 (located in administrative
  entity). Empty arrays mean no value was displayed for that property, not that no other claims
  exist. Values are displayed text; qualifiers, references and ranks are not included. P31ids
  contains links to the linked items and may not align one-to-one with P31. Some fields, including
  the English Wikipedia title, may be absent. Calendar markers may be joined to dates.
- `getLabels` accepts IDs separated by `|`, for example `P31|Q5`, and returns an object keyed by
  ID. Use it to resolve property IDs and item IDs, including IDs at the ends of P31 links.
  English labels or descriptions can be missing. Missing entities may appear as entries marked
  `missing`, rather than causing the whole lookup to fail.

## Maintainer notes

Verified 2026-11-01, logged out. Two differing examples were captured for each operation:
Douglas/item and birth/property, Q42 and Q90, and P31|Q42 and P569|Q90. Held-out Q937
was compared with its captured item page; it showed Albert Einstein, human, and a birth date
of 14 March 1879. Search for Albert Einstein returned Q937; P31 and P569 resolved to
“instance of” and “date of birth”. The lexeme search for cat also returned results.

| op | request | held-out check | tier |
|---|---|---|---|
| `searchEntities` | The main-page search box makes `GET /w/api.php?action=wbsearchentities`; the trigger opens that same read directly to vary `type`. | Albert Einstein, item | 1 |
| `getEntity` | The server-rendered `/wiki/{id}` page supplies the selected displayed statements and terms. | Q937 | 1 |
| `getLabels` | `GET /w/api.php?action=wbgetentities`, requesting English labels and descriptions for the supplied IDs. | P31, P569, Q937 | 1 |

The Q42 and Q937 pages also requested `Special:EntityData/<id>.json` with a revision and
`wbgetentities` for page lookups. EntityData is large and keyed by dynamic IDs; the current
extraction recipes cannot compact arbitrary claim keys, so `getEntity` uses the page instead
of returning a truncated or misleading JSON record. It does not expose all claims. The
search capture stopped a page-initiated analytics POST; no write operation was learned or sent.
