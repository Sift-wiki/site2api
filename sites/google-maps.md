Public signed-out Maps place search. The request fixes English and US context. Results follow Google's ranking and may vary by time, client and location context.

`searchPlaces(query)` returns the initial result batch, 20 businesses in the checked searches. Include city words in free text when useful. Geographic text does not enforce a boundary: the checked New York pizza query also returned businesses elsewhere. No pagination, radius filter, opening hours, route, reservation or full place-detail operation is provided.

Place IDs are public Google Maps identities. Rating and review counts can change; website, category or rating fields may be absent. Coordinates identify the returned place, not the user's position.

## Maintainer notes

Verified signed out on 2026-10-26 UTC with isolated homes and no private browser-cookie import. Source triggers were public Maps search pages for coffee San Francisco, pizza New York and museums in Chicago. Actual frontend request 2 was GET https://www.google.com/search with tbm=map. This is the request made by the Maps frontend, not a guessed general-search API. Captures cmvp2un0o and cmvp2xqi3 were standard CLI captures; independent fresh-profile cmvp3h3cb used CLI write interception to abort unsafe requests.

The final template learned through CLI add from genuine cmvp3h3cb first and cmvp2xqi3 second. It contains no x-browser integrity header, Cookie header or credential slot. The original template contained opaque browser-build headers and was not shared. No header was manually removed, generated or spoofed. The capture representation under interception naturally omitted those headers. No challenge was observed for Maps. Earlier unrelated Google Search/Trends controls were not revisited.

Both q and pb carry the query. Captured pb metadata also varied, but the learner's original-template second-argument replay succeeded and established minTier1. Learner warnings also noted fixed downlink/rtt differences and referer space encoding. These constants can drift; healing is the normal runtime path.

The response is XSSI-prefixed positional JSON: result batch [64], place payload at each [1]. Unseen final-template coffee San Francisco returned20 ordered place IDs matching its independent original frontend capture. Every extracted field matched except one review count that changed between observations. A separate Chicago replay matched all20 rows and every extracted field exactly against the fresh frontend capture. Verification uses public Chicago, New York and San Francisco inputs at tier1. No empty or invalid-place response semantics were established.

Raw captures, source comparisons, learning warnings, verification, fresh-home reuse, export and vet receipts remain ignored under bench/explore/state/discovery/coordinator-maps/. Report: docs/research/discovery/maps-coordinator.md. Public business metadata only; no account, navigation, posting, personal location or other write operation was learned.

Final verification passed all three cases at tier1. The exported operation replayed from a newly
created empty home at tier1 without a Cookie or opaque browser header, no healing, one request,
and all20 rows exactly equal to the earlier unseen replay. Direct shared vet and export scanning
returned zero errors or warnings. No public release or publication occurred.

### Investigation on 2026-11-01 (signed out)

No additional operation was bundled. A place-ID URL resolved the public ID to a different
internal feature ID before requesting `/maps/preview/place`; the captured detail request did
not carry the original ID, and a bare name or place ID in the `/maps/place/` path produced no
place details. The existing learner cannot prove a lookup from that HTML document.

A directions prototype used the frontend's GET `/maps/preview/directions` request, learned
from San Francisco and New York landmarks. A held-out Seattle replay matched the captured
frontend response at tier 1, but that response mixed driving routes with a transit alternative.
The request also contained a changing opaque value. It was not bundled: travel-mode selection,
the value's provenance and a comparison with the rendered page remain unverified. The shared
browser preview timed out twice when reading the page. Autocomplete and reviews were not
established. No CAPTCHA or unusual-traffic page was observed in the captures.

### Follow-up on 2026-11-01 (signed out)

No new operation was bundled. Two captures of the same Golden Gate Bridge to Palace of Fine
Arts driving route returned 200; the changing opaque directions value also appeared in the
page document, but not in the captured cookie or storage snapshot. Its issuance and replay
requirements were not proven, and it was not copied into the spec. A walking capture for
the same pair changed the request's mode field from `!1e0` to `!1e2`. These are numeric
values, while slots have no mapping from the requested named mode enum to those values.
Other modes and rendered route summaries were not verified in this follow-up.

The `place_id:` URL again led to a `/maps/preview/place` request with an internal feature ID,
not the original ID. Search responses for Space Needle Seattle and Empire State Building
New York carried place data at `[0][1][0][14]`, including hours and sometimes phone.
The held-out Golden Gate Bridge San Francisco search instead returned a list at `[64]`:
the rendered page included a sponsored result followed by Golden Gate Bridge. A fixed
single-place extraction would not handle both shapes, nor reliably choose a named place.
The page sent its own logging requests; no write was intentionally performed. No CAPTCHA
or unusual-traffic page appeared in these captures.
