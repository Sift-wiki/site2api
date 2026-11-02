No account is needed for these public reads.

- Pass a channel handle without `@`, for example `NASA`. Channel IDs are not accepted as handles.
- Video duration and view count from `getVideo` are strings; duration is in seconds. Counts and
  dates on the channel and search pages are displayed text and may be missing.
- In `search`, `views` is page text (`"148,107 views"`); a live stream has no `views`.
- Search (about 20 videos) and channel uploads return the first page only. Video likes are not
  included.

## Maintainer notes

Verified 2026-11-01, logged out, using an isolated data home. `verify youtube` passed all seven
example and check cases. The video details were learned with Me at the zoo and Gangnam Style;
the held-out Rick Astley video matched the captured watch page's title and publication date.
The channel operations were learned with NASA and TED; the held-out Veritasium channel and
first upload matched its captured page.

| op | args | returns | tier |
|---|---|---|---|
| `search` | `q` | video search results | 1 |
| `getVideo` | `videoId` | title, channel, channel ID, views, duration, description, keywords, publication date | 1 |
| `getChannel` | `handle` | channel name, ID, description, subscriber text | 1 |
| `listChannelVideos` | `handle` | recent upload IDs, titles, views, publication text | 1 |

### How it works

Search reads `GET /results?search_query=...&sp=EgIQAQ%253D%253D` and extracts `ytInitialData`
with `--embedded`, not the innertube API. `sp=EgIQAQ==` is the page's own "Type: Video" filter;
without it the first section mixes in shelves, channels and "lockup" cards, which `pick` turned
into `{}` items. Once the jar holds `VISITOR_INFO1_LIVE`, YouTube serves in-feed ads and splits
the results into several sections; the extract path `contents[*]` joins the videos of every
section and `pick` drops the ad and shelf items. The innertube search POST
(`/youtubei/v1/search`) sends a gzip-compressed body; the op keeps to the document, which needs
no client context.
Video details come from `ytInitialPlayerResponse` on `GET /watch?v=...`. The channel operations
read `ytInitialData` on `GET /@handle/videos`; uploads are the first page of lockup cards.
The first plain HTTP request sometimes reported oversized headers; the CLI retried without
browser identity headers and returned successfully at tier 1.

### Known limits

The captured timedtext requests returned empty bodies, so no transcript operation was added.
The watch page exposed one comment in JSON-LD, not a top-comment list with reply counts, so no
comments operation was added. Playlists, configurable search filters, and suggestions were not
investigated. A live stream's search view count is in another field. Some channel upload cards
omit view and publication text.
