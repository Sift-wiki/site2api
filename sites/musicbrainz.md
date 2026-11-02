These reads are public. MusicBrainz asks clients to stay at about one request per second.
Core MusicBrainz data is CC0; supplementary data can be CC BY-NC-SA. Check the site's data
license before reuse.

- Searches return the first page, up to 25 results. An artist or release MBID is the UUID at the
  end of its result URL. Artist `area` need not be a country. Dates can be partial or missing.
- Release search shows the first displayed country and date if there are several. Track counts
  are display strings and can show counts per medium, such as `6 + 6`.
- `getReleaseTracks` returns JSON-LD track positions, including the medium number, and ISO 8601
  durations. Track and label information can be absent. `getRelease` does not include the date,
  country, barcode or media; use release search for its displayed date, country and format.
- From a fresh install the first `getRelease` call can take about 30 s: plain HTTP is turned away
  until a browser run sets the site's cookies, after which calls answer over plain HTTP (about 3 s).
- Artist details are a one-item list; dates are the site's display text and may include elapsed
  time. Gender, end date and disambiguation can be absent.
- Artist release groups are the first page only (up to 100), across the page's sections. Their
  section type is not returned; ratings can be absent, and a year may be `—`.
- Recording search returns the first displayed release for each recording, not necessarily its
  earliest release. A recording can have no displayed release; unknown lengths appear as `?:??`.

## Maintainer notes

Verified logged out on 2026-11-01 (the environment clock recorded 2026-11-02 UTC). Search
captures used Radiohead and The Beatles, and OK Computer and Abbey Road. Release captures used
the OK Computer cassette and an Abbey Road release. A held-out Argentine OK Computer release
matched its captured JSON-LD tracklist, including Airbag, position 1.1 and duration PT04M44S;
its label and catalog number matched the release search table. Held-out Daft Punk and Revolver
calls returned plausible results, but were not separately compared against live browser pages.
No writes were tried.

| op | frontend request and recipe |
| --- | --- |
| `searchArtists` | GET `/search?query=...&type=artist&method=indexed`, server-rendered table |
| `searchReleases` | GET `/search?query=...&type=release&method=indexed`, server-rendered table |
| `getRelease` | GET `/release/<mbid>`, MusicRelease JSON-LD fields |
| `getReleaseTracks` | Same release document, MusicRelease JSON-LD `track` array |

The artist page also had JSON-LD albums, but it did not provide the requested complete artist
details and release-group dates in a compact combined recipe, so `getArtist` was not included then.
The search pages did not request autocomplete JSON during the captured navigation. Recording
search was not attempted in that round. Missing-MBID input checks are local validation, not nonexistent-ID
server checks. Search empty-result checks were not verified.

The final exported and edited spec passed `verify musicbrainz` from a separate home: 8 pass,
0 fail, 0 inconclusive. The fresh home's first artist search used tier 1; verification used tier 1
except `getRelease`, which completed at tier 3. Earlier held-out calls for all four ops used tier 1.

### 2026-11-01, logged out: artist and recording reads

Two captures each used Radiohead and The Beatles for the artist page, and Karma Police and Hey
Jude for recording search. The artist page's sidebar and header supply details; its release-group
tables supply the first page, but their type is in section headings outside the rows. The recording
search table has extra continuation rows for later releases; the recipe selects only rows with a
recording link. It uses the first displayed release, not a chronological claim.

Held-out Daft Punk details and its 1997 Homework row matched the captured page. A held-out
`recording:"Get Lucky" AND artist:"Daft Punk"` search returned Merle Haggard's “I Always Get
Lucky With You”, matching the live search page but not the intended artist; indexed search
interpretation is the site's. A broad Get Lucky search changed its first-page results between
requests. No writes were tried.

The final export had no secret-scan warnings. Verification passed 14 cases, all at tier 1 where
networked. A separate empty home's first `getArtist` call used tier 1; the other new ops were not
individually tested as the first call in an empty home. The original home used tier 1 for all three
held-out calls.
