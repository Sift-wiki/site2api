No account is needed. Supply the ID portion of a Spotify URL or URI, not the whole URL.
Track album information and album release dates and labels are not available from these embed
documents. Preview URLs may be absent. Album artist names are a display string; track durations
are in milliseconds and track URIs contain their IDs. Album track lists can be truncated by the
response size limit.

Search, artist and playlist lookup, playback and account actions are not provided.

## Maintainer notes

Verified 2026-11-01, logged out, in an isolated data home. Captured two different public examples
per operation. The held-out Cut To The Feeling track matched the public page's title, artist, year
and displayed duration. The held-out Scorpion album matched its public page's album and artist,
and its embed's 25 track titles and displayed durations.

| op | inputs | returns | tier |
|---|---|---|---|
| `getTrack` | `trackId` | track identity, artists, duration, release date, explicit flag and optional preview URL | 1 |
| `getAlbum` | `albumId` | album identity, artist display string and embed track list | 1 |

Both operations read the `__NEXT_DATA__` JSON in a public `open.spotify.com/embed/` document.
They need no access token, client token or cookie and store no visitor session values. The embed
track entity does not provide its album; the sampled album entities had a null release date.
The regular track document loaded a reCAPTCHA resource and attempted client-token requests when
those POSTs were blocked during capture. Search and the other operations were not qualified.
No playback, audio download, login or write was performed.
