No account is needed. Supply the ID portion of a Spotify URL or URI, not the whole URL.
Track album information and album release dates and labels are not available from these embed
documents. Preview URLs may be absent. Album artist names are a display string; track durations
are in milliseconds and track URIs contain their IDs. Album track lists can be truncated by the
response size limit.

Playlist owners and track artists are display strings; descriptions may be absent. Playlist and
artist track lists contain the embed's track objects, and long lists can be truncated by the
response size limit. Artist tracks are the top tracks shown by the embed, not a full discography.

Episode durations are in milliseconds; the show is a display name. Episode descriptions were not
present in the sampled embed documents, and preview URLs may be absent.

Search, show lookup, playback and account actions are not provided.

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

### Playlist and artist, 2026-11-01, logged out

Captured Today's Top Hits and RapCaviar for playlists, and Taylor Swift and Drake for artists.
The held-out New Music Friday embed matched the playlist name, owner, and returned track titles,
artists and durations against the visible page; its long result was truncated by the response size limit. The held-out
Ed Sheeran embed matched the artist and its ten visible top tracks and durations. Both operations
replayed at tier 1 without a token or cookie. The sampled entities did not expose playlist
descriptions or artist monthly listener counts.

The picker cannot project fields within an array while retaining the parent object, so album,
playlist and artist track objects remain untrimmed. Search, episodes and shows were not qualified
in that round.
During the two browser captures the embed automatically sent telemetry POSTs to Sentry and Spotify
event endpoints; no user-facing write operation, login, playback or audio download was performed.

### Podcast episodes, 2026-11-01, logged out

Captured show embeds for The Joe Rogan Experience and The Daily. Each showed one featured episode,
not a show entity, publisher, description or episode list, so `getShow` was not added. Their episode
IDs were used as two differing examples for `getEpisode`. The held-out Without Fail episode matched
its live episode embed's title, show, duration, release date, explicit flag and preview URL. The
sampled episode entities did not expose descriptions. Replays used tier 1 without a token or cookie.
The embeds automatically sent telemetry POSTs to Spotify event endpoints; no user-facing write,
login, playback or audio download was performed.
