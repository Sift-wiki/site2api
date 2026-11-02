No account is needed. Map data is © OpenStreetMap contributors, available under the ODbL.
Nominatim and the routing service are volunteer-run: keep usage light, space requests at least
one second apart, and follow their usage policies. Do not use these operations for bulk work.

- Coordinates are decimal degrees. Reverse geocoding finds a nearby mapped feature, not
  necessarily the exact coordinate; available address parts vary.
- Routing covers OSRM driving only. Distance is in metres and duration in seconds. The three
  step arrays correspond by index; a road name can be empty. Maneuver types and modifiers are
  OSRM's structured directions rather than localized instruction text.

## Maintainer notes

Verified 2026-11-01, logged out. The final exported spec passed `verify openstreetmap`: four
passes, no failures or inconclusive cases, all tier 1. Two examples used the Eiffel Tower and
Brandenburg Gate; the held-out Golden Gate Bridge results matched the directions page's requests.

| Operation | Frontend request | Held-out verification |
|---|---|---|
| `reverseGeocode` | Directions panel requests Nominatim `/reverse?lat=...&lon=...&format=json`. A single starting coordinate triggers exactly one reverse request. | Golden Gate Bridge, OSM relation 21407754 and its address |
| `getCarRoute` | Directions panel requests FOSSGIS OSRM `/routed-car/route/v1/driving/<lon>,<lat>;<lon>,<lat>?overview=false&geometries=polyline&steps=true`. | Golden Gate Bridge to Palace of Fine Arts, 8277.6 m and 625.5 s |

The map search used `POST /search/nominatim_query`, not the older hinted GET, so no geocode
operation was bundled: shared-read vetting does not accept that POST. Supplying the hinted
`fossgis_osrm_bike` engine fell back to `fossgis_osrm_car`, so bicycle and foot routing were not
claimed. The site sent its own Matomo analytics POSTs during page loads; no write was invoked.
The routing host is off the spec's registrable domain and produces a `vetShared` warning.
