No account is needed. `country` and `city` are the slugs in timeanddate.com's own URLs
(`/worldclock/usa/new-york`, `/holidays/us/2026`); holiday pages use their own country slugs
(`us`, `uk`), which can differ from the world-clock ones (`usa`).

- timeanddate.com puts a Cloudflare check in front of plain HTTP, so calls run in the browser
  tier: the first call from a fresh install takes several seconds while Chrome starts.
- `getTime` returns the page's text: `offset` repeats the zone name before the UTC offset, and
  `dst` lists the page's daylight-saving notes (empty or a "no DST" note where none applies).
- `getHolidays` returns the table's national and regional rows (`type` says which; `details`
  names the regions for a regional holiday). Observances the page hides by default are left out.
- Sunrise/sunset and place search are not covered.

## Maintainer notes

2026-11-01, logged out. A subagent learned both ops from captures of `usa/new-york` and
`uk/london` (time) and `us/2026` and `uk/2027` (holidays); held-out `japan/tokyo` and `japan/2027`
answered at tier 2 after a Cloudflare challenge at tier 1. It stopped before export to respect the
challenge limit. The parent then called both ops from an empty `API_ANYTHING_HOME` at tier 2
(`canada/toronto`: EST, UTC-5, with the DST change of 2026-11-01; `canada/2027`: national and
provincial rows), added descriptions and checks, and ran `verify timeanddate` on this file.

| op | request | recipe |
|---|---|---|
| `getTime` | GET `/worldclock/<country>/<city>` | `#ct` time, `#ctdat` date, `#cta` abbreviation, `#tl-tz-i` zone and offset, `#tl-ds@title` DST notes |
| `getHolidays` | GET `/holidays/<country>/<year>` | `#holidays-table` rows with `data-mask` 1 or 2 (national, regional) |

The pages also send advertising and analytics requests; none is part of the spec.
