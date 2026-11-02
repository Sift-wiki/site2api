No account is needed. Use decimal-degree coordinates for US locations. Forecasts and
observations update often; the observing station can be some distance from the requested point.

- Forecast fields are parallel arrays: entries at the same index describe the same period.
  Temperatures are in degrees Fahrenheit, and detailed text includes wind. Precipitation
  probabilities are percentages and can be null.
- Current temperatures are in degrees Fahrenheit, humidity in percent, wind speed and gusts
  in mph, wind direction in degrees (`999` means variable), and visibility in miles. Values can
  be `NA` or missing.
- Outside the service area, the site can return HTTP 400, reported as an error.
- The hourly table has two consecutive 24-hour blocks of rows. Within each block, the same
  `hour01` through `hour24` column identifies the same time across rows; the Hour row names
  the local time zone. Date cells mark changes of date, and blank date cells carry forward
  the preceding date, including across blocks. Other blank cells mean no value shown.
  Temperature and dewpoint are in °F, wind in mph, and sky cover and precipitation potential
  in percent. Weather rows use the site's abbreviations, not a short forecast sentence.

## Maintainer notes

Verified 2026-11-01, logged out. Both operations were learned with Seattle
(`47.6062,-122.3321`) and Denver (`39.7392,-104.9903`). The held-out Miami
(`25.7617,-80.1918`) forecast and observation matched the rendered page, including the
forecast text, the KMIA station, its conditions and temperature. Forecast and observation
times and values change.

| op | request | held-out comparison |
|---|---|---|
| `getForecast` | `forecast.weather.gov/MapClick.php?lat=...&lon=...&FcstType=json` | Miami forecast period and text |
| `getCurrent` | Same JSON document, `currentobservation` | Miami station, temperature and conditions |

The JSON variant was captured directly. The hourly graphical page captured here was
server-rendered and did not expose a point-to-grid API flow, so hourly forecasts are not
included. Active alerts and location search were not verified as operations. The rendered Miami
page displayed an advisory, but this spec does not expose alert details.

London returned HTTP 400, but the classifier reported the HTML error as `error`, not `input`;
an input check for this case was therefore omitted. The page also loads ArcGIS map resources;
these are not part of either operation. No writes were attempted.

### Hourly table and alerts, 2026-11-01, logged out

`getHourly` was learned from the tabular forecast document with Seattle
(`47.6062,-122.3321`) and Denver (`39.7392,-104.9903`). The held-out Miami
(`25.7617,-80.1918`) table matched the page's dates, hours, temperature, dewpoint, wind,
sky cover and precipitation potential. The page's XML link serves DWML, but extraction
does not provide an XML recipe. The HTML recipe keeps empty cells in their original columns.

The earlier hourly and alert limitations above describe the previous verification. The alert
operation remains unverified: `alerts.weather.gov` did not resolve, and the captured
`www.weather.gov` home page did not expose a point-based active-alert request. No alert
endpoint was added without a demonstrated page request. The home page sent its own analytics
requests; no writes were attempted by the operator.
