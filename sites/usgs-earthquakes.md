No account is needed. Times are epoch milliseconds UTC; magnitudes and other event
details can be revised. Coordinates are `[longitude, latitude, depth]`, with depth in
kilometres. Alert and felt values can be null. The tsunami flag is not a tsunami warning.

`recent` selects a USGS feed, not an exact magnitude filter; a quiet window can return
an empty list. `significant` is the site's significance feed. `getEvent` returns product
types as the site's comma-delimited string, with leading and trailing commas; product
availability can differ between the catalog and the cached detail feed.

`search` uses UTC ISO dates or date-times. Its end date is the start of that date, not
the end of the day. Searches are worldwide, with no region filter in this spec. USGS
limits a search to 20,000 events; narrow large searches by time and magnitude.

## Maintainer notes

Verified 2026-11-01, logged out. No writes were attempted.

| op | request | verification |
|---|---|---|
| `recent` | Map's `summary/{magnitude}_{period}.geojson` | Two feed examples, plus held-out `1.0_hour`; the default `2.5_day` matched the map capture. |
| `getEvent` | `fdsnws/event/1/query?eventid=...&format=geojson` | Tohoku and a recent feed event; held-out `us7000tupl` matched the event page's detail feed for magnitude, place, time, felt and alert. |
| `search` | Search form's GET action, with GeoJSON output, time range and magnitude | 2011 Tohoku and 2010 Maule examples, held-out 2004 Sumatra, and an empty historical query. |

The filename uses a single path slot with template `{magnitude}_{period}.geojson`.
The event page uses the detail feed for recent events and the FDSN query for the
historic Tohoku event. The second `getEvent` learning run did not match the FDSN
request because that recent event used the detail feed instead; direct FDSN calls for
both recent and historic events succeeded. The recovery trigger opens the FDSN query.
The catalog and cached feed can expose different product types.

The search form's bounding-box fields were observed, but a regional search was not
verified and is not exposed. The held-out search was checked against the returned
catalog event, not a rendered search page. No empty-result check was recorded for
short recent feeds because their contents change.
