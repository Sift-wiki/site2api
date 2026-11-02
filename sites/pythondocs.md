These reads need no account and use the moving Python 3 documentation, not a fixed minor version.
Check the documentation version when compatibility matters.

- `getModule` takes the library page basename, which may differ from the import name. For example,
  `asyncio-task` is a page about tasks. The module index links show the actual page to use; some
  indexed modules share a page. Use `getPage` with `library/<basename>` for its title and prose.
- API entries are in document order. `kind` is the page's CSS class, such as `py function` or
  `py method`. A name or description can be missing, and entries with multiple signatures only
  expose the first. Some pages organize content outside API entries or link to other pages.
- The index includes linked modules only, including removed modules marked `Deprecated:`. That
  marker is text and is absent for other entries, not a Boolean. Some summaries are absent.
- Page headings and paragraphs are separate ordered lists, not paired sections. Examples, tables,
  and code blocks are not included. Text and signatures may include Sphinx's paragraph marker.
- Results are capped at 20,000 JSON characters. Check `truncated` and use the result continuation
  or field shaping when the index or a long page exceeds that limit.
- Documentation and examples have separate license terms; see Python's documentation license.

## Maintainer notes

Verified 2026-11-01, logged out. All requests are public GETs to `docs.python.org`. Captures used
one browser at a time. The HTML recipes read server-rendered documents.

| op | frontend request | verification |
|---|---|---|
| `getModule` | GET `/3/library/<page>.html` | Captured `json` and `itertools`. Held-out `pathlib` returned `pathlib.UnsupportedOperation` and `pathlib.PurePath` with signatures and descriptions matching the page. A nonexistent page is an input check. |
| `listModules` | GET `/3/py-modindex.html` | Captured twice. Compared `aifc` and `collections.abc` with the index, including the former's deprecation marker. The 320-row index was truncated in the default response. |
| `getPage` | GET `/3/<path>.html` | Captured `tutorial/classes` and `howto/logging`. Held-out `tutorial/datastructures` matched the title, opening paragraph and headings. A nonexistent page is an input check. |

`getModule` returns API entries rather than a page title and summary because an HTML recipe cannot
nest a list of records inside a page record. `getPage` supplies the page title and prose separately.
The Sphinx search is client-side; no per-query search operation or minor-version parameter was
proven. No writes or login were attempted.
