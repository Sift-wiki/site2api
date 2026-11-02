No account is needed.

- `search` requires a destination (`loc`, a place name in any script: `São Paulo`, `東京`) and
  check-in and check-out dates in `YYYY-MM-DD` format; `adults` defaults to 1. It returns only the first page, about 18 stays. Prices are Airbnb's USD total
  labels for the requested dates, not a booking quote.
- Search returns an opaque GraphQL listing ID. Base64-decode it and take the digits after the
  colon to get the numeric room ID used by `getListing` and `https://www.airbnb.com/rooms/<id>`.
- Listing descriptions can be truncated, coordinates are approximate, and ratings or other fields
  may be missing. The listing page has more information than this operation exposes.
- Availability, itemized quotes, reviews and reservations are not provided.

## Maintainer notes

Verified 2026-11-01, logged out, using an isolated `API_ANYTHING_HOME`. Both operations and their
public result checks passed at tier 1. Search examples were Lisbon and Barcelona with different
dates and guest counts. The held-out Porto search for 2027-07-10 through 2027-07-14 with four
adults matched the captured page request's listing names and prices, with minor ranking changes.
Changing check-in, check-out and adult count separately changed prices or results. Listing examples
were rooms 31315228 and 34566309; the held-out 19615050 response matched its page's structured data.

| op | args | returns | tier |
|---|---|---|---|
| `search` | `loc`, `checkin`, `checkout`, `adults` | first page of stays, total price labels and ratings | 1 |
| `getListing` | numeric room `id` | public structured listing details and photos | 1 |

`search` replays the read-only `StaysSearch` GraphQL POST, learned with a soft navigation from
the homepage. The public `x-airbnb-api-key` is shared by the frontend. The persisted-query hash
in the URL and body is volatile, and `match` names only the operation and wildcarded path, so a
deploy that rotates it heals by rescan (verified live on 2026-09-27: about 5 s). Each param
fills two JSON leaves, one in `staysSearchRequest` and one in `staysMapSearchRequestV2`.
`x-csrf-token`, `x-csrf-without-token`, `x-client-version` and two `treatmentFlags` entries are
`session:` refs; with no session they are left out and the search still answers.
`getListing` reads the `VacationRental` JSON-LD from the room document. Its occupancy value
disagreed with the listing API's guest capacity on a sampled room, so it is intentionally omitted.

The calendar, reviews and booking-panel quote requests were observed, but their listing IDs are
different base64-encoded GraphQL IDs rather than the numeric ID in the page URL. They were not
bundled without a reliably learned conversion. No empty-result check was established, and no
write or reservation was attempted. No challenge or blocking was observed.

### Reviews, 2026-11-01, logged out

An experimental `getReviews` replayed the read-only `StaysPdpReviewsQuery` GET using a slot
that base64-encodes `StayListing:<numeric room id>`. Captures used rooms 31315228 and 34566309;
the held-out room 19615050 returned the same 24 ratings and dates as the request captured from
its live page. It passed verification and an empty-home call at tier 1, but is not bundled:
shared-spec vetting rejects a parameterized `b64` layer, including one nested in a GET query.
The returned reviews use Airbnb's relevance order, not strictly newest first.

The calendar request encodes `DemandStayListing:<numeric room id>` but also fixes its start month
and year in the request, so replaying a captured template would eventually return stale months.
The observed booking-panel query returned an unavailable result for the sampled dates rather than
an itemized quote. Neither operation was bundled without a reliable, validated result. No
challenge or blocking was observed during these captures.
