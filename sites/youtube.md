No account is needed for these public reads.

- Pass a channel handle without `@`, for example `NASA`. Channel IDs are not accepted as handles.
- Video duration and view count from `getVideo` are strings; duration is in seconds. Counts and
  dates on the channel and search pages are displayed text and may be missing.
- In `search`, `views` is page text (`"148,107 views"`); a live stream has no `views`.
- `search` accepts one combined `filter` code, not separate filter arguments. Omit it for videos
  sorted by relevance. Use the values below as written, including `%3D` where shown:

  | Filter | Value |
  |---|---|
  | Videos (default) | `EgIQAQ%3D%3D` |
  | Videos, uploaded today | `EgQIAhAB` |
  | Videos, uploaded this week | `EgQIAxAB` |
  | Videos, uploaded this month | `EgQIBBAB` |
  | Videos, uploaded this year | `EgQIBRAB` |
  | Videos under 3 minutes | `EgQQARgE` |
  | Videos, 3–20 minutes | `EgQQARgF` |
  | Videos over 20 minutes | `EgQQARgC` |
  | Videos, sorted by popularity | `CAMSAhAB` |

  The code represents the whole selection; don't concatenate codes. The extraction returns video
  cards only, so channel, playlist, Shorts and movie filter codes are not supported.
- Search (about 20 videos) and channel uploads return the first page only. Video likes are not
  included.
- Pass the playlist URL's `list` value as `playlistId`. Use `getPlaylist` for the playlist header
  and `listPlaylistVideos` for its first page of items. The owner and count are displayed text;
  item durations are displayed strings and can be missing. Longer playlists can have more items
  than this first page returns.

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
Re-probed 2026-11-04 (issue #105): the watch page's caption tracks carry `exp=xpe` and answer
empty without the web player's proof-of-origin token. Only the Android app's player request
returns tracks that answer plain HTTP, and the shared rules refuse what that op would need. See
`docs/research/youtube-captions.md` for the evidence and the tier-3 route still to try.
The watch page exposed one comment in JSON-LD, not a top-comment list with reply counts, so no
comments operation was added.
A live stream's search view count is in another field. Some channel upload cards omit view and
publication text.

### Playlist and watch investigation, 2026-11-01 (logged out)

The playlist reads were learned from Google Search Stories and NASA's James Webb Space Telescope
playlist, and checked against the captured NASA Explorers: Season 5 playlist. Its title, owner,
count and five video IDs, titles, channels and durations matched. Both reads worked at tier 1
from a fresh data home. The playlist page initially returned ten items for a thirteen-video
playlist, so the video list is not a complete playlist. The header and item list are separate
operations because the current extraction recipe cannot project an item list and retain its
parent header in one compact result.

Scrolling the watch page triggered a `POST /youtubei/v1/next`, but capture stopped it under the
step safety guard, so its response was not verified. The learner's derived slots require a
same-host GET returning JSON, and cannot derive a continuation or transcript parameter from
the watch page's embedded HTML JSON. No comments or transcript operation was added. A watch-page
capture also automatically fetched video data; no media was intentionally downloaded or saved
as a deliverable.

### Search filters and suggestions, 2026-11-01 (logged out)

The filter menu's links supplied the presets above; selecting This week changed the URL to
`EgQIAxAB` and yielded different videos from the default. Its first live-page result, "Dad Cat
Meets His Newborn Kittens Then Kisses Mom", also appeared in the filtered API result. Ordering
varied. The menu currently says under 3 and 3–20 minutes, and offers Popularity rather than a
separate upload-date sort. The previously suggested under-4 and 4–20 codes were not confirmed.

The search box's `GET` to `suggestqueries-clients6.youtube.com` returns JSON wrapped in
`window.google.ac.h(...)`; the embedded recipe reads its array of suggestion strings. Different
`puppies` and `astronomy` examples returned different results. The held-out `space` call matched
the live suggestion list. The page itself sent analytics and other background requests; the
capture's step guard stopped several POSTs, and no write was intentionally sent.
