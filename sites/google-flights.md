No account is needed. One-way, 1 adult, economy only. No pagination.

- The cheapest flight on a date can be in either `search` or `top`. "Cheapest flight next month" is
  one `priceCalendar` call per airport pair (for a metro area, one per airport: New York is JFK,
  LGA, EWR), then `search` and `top` for the cheapest date.
- In `search` and `top`, a metro code or city name covers all its airports, and each item's
  `from`/`to` says which one. An ambiguous city name is resolved the way Google's search box
  resolves it.
- `priceCalendar`'s `pattern` refuses metro codes, but its list is not exhaustive: an unlisted metro
  code comes back empty.
- A date in the past or a place Google can't resolve makes `search` and `top` return `input`: check
  the date and places. `priceCalendar` with an empty range returns `input`.
- Repeated use needs no cookies. Too many calls bring Google's "unusual traffic" page: the call
  returns `rate` and the site rests. Wait `retryAfterMs`; don't refresh cookies. Send fewer calls:
  shortlist dates with `priceCalendar`, and reuse recent answers.

## Maintainer notes

Verified 2026-09-27, logged out, US IP, from a clean `API_ANYTHING_HOME`: `verify` passes, and live
calls covered airport, metro and city searches and 92-day calendars. Re-verified 2026-10-12 the same
way: `verify` passes.

| op | args | returns | tier |
|---|---|---|---|
| `search` | `origin`, `destination` (airport code, metro code or city name), `date` (`YYYY-MM-DD`) | Google's "other departing flights" list, one-way, sorted by price (about 5 to 30 items) | 1 (GET of the results page, about 1 to 1.6 s, 3 to 4 MB) |
| `top` | same | Google's "top departing flights" list (about 3 to 5 items) | 1 |
| `priceCalendar` | `origin`, `destination` (IATA **airport** codes only), `start`, `end` (`YYYY-MM-DD`) | the cheapest one-way fare for each departure date in the range: `{date, price}` | 1 (POST `GetCalendarPicker`, about 0.1 s) |

```sh
api-anything call google-flights search origin=SFO destination=NYC date=2027-04-15
api-anything call google-flights top origin=BOS "destination=London" date=2027-04-22
api-anything call google-flights priceCalendar origin=SFO destination=JFK start=2026-10-01 end=2026-10-31
```

### Places

`search` and `top` put the args into the page's own free-text query,
`/travel/flights?q=Flights from {origin} to {destination} on {date} one way&hl=en-US&gl=US&curr=USD`,
and Google resolves them. Airport codes (`JFK`), metro codes (`NYC`, `LON`, `TYO`) and city names
(`New York`, `Tokyo`) all work.

`priceCalendar` sends the airport code in its own slot (`["JFK",0]`). Google encodes a city there as a
different entity (`["/m/02_286",4]`), so a metro code returns an empty calendar. The param
`pattern` refuses 3-letter codes that are metro codes (NYC, LON, PAR, TYO, CHI, WAS, and so on).

### Result fields

`search` and `top` read the results the page embeds (`AF_initDataCallback` `ds:1`: `[2][0]` is the top
list, `[3][0]` the other list). The JSPB paths are in `google-flights.json`. Each item:

| key | meaning | example |
|---|---|---|
| `airline` | airline names (several when the itinerary mixes carriers) | `["Delta"]` |
| `price` | USD for the whole one-way itinerary | `209` |
| `from` / `to` | departure / arrival airport | `"SFO"` / `"JFK"` |
| `departureTime` / `arrivalTime` | local time `[h,m]`; a missing entry is 0: `[9]` = 09:00, `[null,56]` = 00:56 | `[13,50]` |
| `arrivalDate` | `[y,m,d]`; the departure date is the one you asked for | `[2027,4,16]` |
| `durationMinutes` | total duration | `333` |
| `via` | stop airports in order; **absent for a nonstop flight** | `["IAH"]` |

The page also has the carrier code, flight numbers, aircraft, layover minutes and a booking token
per item. Add them to `pick` in your copy of the spec if you need them. `priceCalendar` reads
`[0][0][2]` of the batchexecute payload, one `[date, null, [[null, price], token], 1]` per day;
`price` is missing on a day with no fare.

### Known limits

- Round trips, cabins and passenger counts need their own ops.
- `search` and `top` are disjoint. Together they are the whole results page, and each costs one
  3 to 4 MB page download.
- Calendar ranges were tested up to 3 months per call. The trigger (tier 3) opens the date picker,
  which requests the page's own range (start to the end of the next month), not `start`/`end`. The
  runtime refuses that response when its request differs from the requested range: it will not
  claim the UI's default dates are your answer. A heal re-learns the request from the picker's own
  and keeps `end` where the op has it, since the trigger has no `{end}` (a forced heal from a clean
  home succeeded and replayed the caller's range on 2026-10-12).
- `GetCalendarPicker` sometimes answers HTTP 200 with `[["wrb.fr",null,null,null,null,[13]]]`
  (gRPC INTERNAL) instead of data, in waves that come and go within minutes (issue #21). The call
  returns `error`, and a later retry gets the data. On 2026-10-12 a captured
  `x-goog-batchexecute-bgr`, a fresh `bl`, pacing and tier 2 did not change the rate; the failures
  clustered by session and time. A reversed or past range answers `[3]` (INVALID_ARGUMENT); the
  example range still answers, so the call returns `input`.
- The session tokens in the calendar's `f.req` (`json:/0/3`) and `f.sid` are session-scoped, not
  per-request signatures: stale values replay fine at tier 1 from a clean home. The export's base64
  warning refers to that token. It is issued to every logged-out visitor, not a credential.
- The example dates (`2027-04-15`, `2027-04-01` to `2027-04-30`) go stale. Bump them before then,
  or `verify` fails.
- A date in the past or a place Google can't resolve makes `search`/`top` fall back to Google's
  Explore page, which has no results list. The call replays the example args once; they answer, so
  it returns `input`: check the date and places. A malformed date (`Oct 21`) is refused by the
  param's `pattern` before anything is sent.
- Prices and names follow `hl=en-US&gl=US&curr=USD` in the page URL and the calendar's
  `x-goog-ext-259736195-jspb` header. The EU consent wall was not tested.

### Throttling (issue #84)

Google's wall after many calls is a redirect to `/sorry/index`, which answers HTTP 429 with no
`Retry-After` ("Our systems have detected unusual traffic from your computer network. Please try
your request again later."), seen live on 2026-11-04. It classifies as `rate`, so the site cools
down for 3 minutes, and every op of the site answers from the cool-down without sending
(`test/sites.test.ts` pins this with a trimmed copy of that page). Rotating `NID`/`OTZ` does not
help and is not needed: the ops were verified with an empty jar. Only `SOCS`, the consent record,
could matter, behind the untested EU consent wall. A logged-out read redirected to
`consent.google.com` is `drift` there (an unfinished step is only named for signed-in ops), so a
report of a heal loop from the EU is the evidence to ask for.
