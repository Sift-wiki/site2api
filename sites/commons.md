No account is needed. Each file has its own license: check the file page and attribute as required
before reuse. Do not infer that attribution is unnecessary from missing fields.

- `searchMedia` searches images and returns the first page only. Titles omit `File:`; add that
  prefix when passing a title to `getFile`. The URL is the file description page, not the original.
- `getFile` reads the displayed page. Fields may be absent or incomplete: license templates vary,
  and an empty `licenses` array does not mean the file has no license. License links can include
  explanatory links as well as license URLs. Attribution requirements are not returned as a flag.
  `fileInfo` is displayed text, including dimensions, size and MIME type where present. Categories
  are visible categories only. The author and description can contain several languages or
  extra biographical text.
- `listCategory` takes a category name without `Category:` and returns the first gallery page,
  not subcategories. A category with no direct files can report input instead of an empty list.
  Large galleries can be truncated.

## Maintainer notes

Verified 2026-11-01, logged out. Two distinct examples were captured for each operation. Final
exported spec verification in a fresh data home passed 7 cases, with no failures or inconclusive
cases; all answered at tier 1. A separate fresh-home `getFile` call also answered at tier 1.

| op | request and extraction | held-out comparison |
|---|---|---|
| `searchMedia` | GET `/w/index.php` with `Special:MediaSearch`, search and image type; server-rendered result links and thumbnails | `arctic fox`: first results matched the captured page |
| `getFile` | GET `/wiki/<title>`; displayed summary cells, license templates, original link, file info and categories | `File:ArcticFoxSummer.jpg`: author, CC BY-SA 4.0, dimensions and original matched the captured page's metadata |
| `listCategory` | GET `/wiki/Category:<category>`; first server-rendered gallery | `Vulpes_lagopus_in_zoos`: returned gallery entries including ArcticFoxSummer.jpg |

The initial MediaSearch page embeds search data in its HTML; the capture did not show a separate
MediaSearch API request. Its numeric-keyed results object could not be extracted as a list with
`results[*]`, so the visible gallery is used instead. Search does not expose full URLs, dimensions,
MIME, license or author in this recipe. The Mona Lisa page uses a license template not matched by
`.licensetpl`, so its license is absent. `Red_pandas` had no direct gallery and returned input.
No write operations were learned or called.
