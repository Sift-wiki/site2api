No account is needed. Map data is © OpenStreetMap contributors, available under the ODbL.
Nominatim and the routing service are volunteer-run: keep usage light, space requests at least
one second apart, and follow their usage policies. Do not use these operations for bulk work.

- Coordinates are decimal degrees. Reverse geocoding finds a nearby mapped feature, not
  necessarily the exact coordinate; available address parts vary.
- Routing covers OSRM driving, walking and cycling. Distance is in metres and duration in seconds. The three
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

### 2026-11-01: walking and cycling, logged out

The OSRM Foot selector uses `fossgis_osrm_foot` and requests
`routing.openstreetmap.de/routed-foot/route/v1/driving/...`. Selecting Bicycle with OSRM uses
`fossgis_osrm_bicycle` and `/routed-bike/route/v1/driving/...`; the earlier `fossgis_osrm_bike`
hint still falls back to car. The `driving` path component does not mean these are car profiles.
Eiffel Tower to Louvre returned 3759.3 m and 3010.7 s on foot, 3974 m and 1221.2 s by bike,
versus the car panel's 4.3 km and 11 minutes. Berlin was the second example.

Held out Golden Gate Bridge to Palace of Fine Arts: foot returned 4534 m and 3624.3 s
(page 4.5 km, 1:00); bicycle returned 4602 m and 1223.8 s (page 4.6 km, 0:20).
Both fresh-home calls used tier 1. The final spec passed `verify openstreetmap`, eight passes,
zero failures or inconclusive cases, all tier 1. Page loads may send Matomo analytics POSTs;
no write operation was invoked.
