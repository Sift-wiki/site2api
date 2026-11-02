No account is needed. NASA media generally is not copyrighted, but check NASA's usage guidelines,
the item's credit and any third-party rights before reuse.

- `search` returns the first page only, across images, video and audio, restricted to creation
  years 1920 through 2026. Descriptions can be long, fields can be absent, and results can be
  truncated by the output cap.
- `getAssets` returns the URLs NASA lists, which can include different sizes, video captions and
  metadata as well as media. Availability varies by item. The API currently returns these URLs
  with `http`, so use care before following them.

## Maintainer notes

Verified 2026-11-01, logged out. Two distinct examples were captured for each operation. The
exported, hand-edited spec passed six verification cases in a fresh data home, all at tier 1.
No write operation was learned or called.

| op | request and extraction | held-out comparison |
|---|---|---|
| `search` | GET `images-api.nasa.gov/search`, first page, all three media types, explicit year bounds; extract collection items | `hubble`: the first result, PIA12110, title and thumbnail matched the page's captured response |
| `getAssets` | GET `images-api.nasa.gov/asset/<nasaId>`; extract the collection's URLs | `GSFC_20190424_HST_m13189_Hubble29`: matched the page's asset request, including MP4 variants and VTT captions |

The page without year bounds sent `year_start=null&year_end=null` and received HTTP 400.
Explicit bounds made its search work; the upper bound consequently excludes later media. The
page stores its media selection in local storage; the exported request uses the observed public
value directly instead of requiring a session. The site also sent CSP violation reports during
page loads.

The page fetches a metadata pointer from `images-api.nasa.gov/metadata/<nasaId>` and then reads
the JSON on `images-assets.nasa.gov`. A derived lookup cannot cross hosts, so `getMetadata` was
not added. The asset URLs may include the metadata JSON, and search supplies some metadata.
The assets and metadata hosts share the registrable domain `nasa.gov` with the frontend.
