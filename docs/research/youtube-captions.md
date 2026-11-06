# YouTube captions over HTTP (2026-11-04)

Evidence for issue #105's option A (captions as a plain web op on the bundled `youtube` spec, no
local operation) and for the design decision it led to (DESIGN.md, Non-goals: local operations).

Setup: macOS, `curl` and Python's `urllib`, logged out, an empty cookie jar unless stated, a US
address. Videos: `jNQXAC9IVRw` (Me at the zoo) and `dQw4w9WgXcQ`, both with English captions. About
twenty requests in total, read-only.

## What answers

| request | answer |
|---|---|
| `GET /watch?v=…` (the page `getVideo` reads) | `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`: one entry per language, each with a signed `baseUrl` on `/api/timedtext` carrying `exp=xpe` |
| that `baseUrl`, as given, or with `&fmt=vtt` | **HTTP 200, empty body** |
| `GET /api/timedtext?v=…&lang=en&fmt=vtt` (unsigned) | HTTP 200, empty body |
| `POST /youtubei/v1/get_transcript` with the watch page's `getTranscriptEndpoint.params`, the page's client version, and its visitor data and cookies | HTTP 400 `FAILED_PRECONDITION` |
| `POST /youtubei/v1/player` as the `ANDROID` or `IOS` client (`clientName`, `clientVersion` and the app's user-agent) | 200, `playabilityStatus: OK`, caption tracks whose `baseUrl` has no `exp=xpe` |
| that `baseUrl` with `&fmt=vtt` | **HTTP 200, WebVTT** (`WEBVTT`, `Kind: captions`, cues) |
| the same `baseUrl` without `signature` | 200, empty body |
| the same without `expire`, `ei`, `sparams`, `opi` or `xoaf` | 404 |
| `POST /youtubei/v1/player` as `TVHTML5_SIMPLY_EMBEDDED_PLAYER` or `WEB_EMBEDDED_PLAYER` | `playabilityStatus: ERROR`, no tracks |

`exp=xpe` marks a track the web player fetches with a proof-of-origin token (`pot`) that its
BotGuard script mints in the page. Without one, the web tracks answer empty, which is what the
2026-11-01 investigation in `sites/youtube.md` saw ("the captured timedtext requests returned empty
bodies").

## What option A would take

Only the mobile-app path answers from plain HTTP, and it needs things the spec format refuses
today:

1. **A POST lookup.** The track URL comes from `POST /youtubei/v1/player`. A derived slot's lookup
   is a GET on the op's own host (DESIGN.md, Request template; `vetShared`).
2. **A whole URL as the looked-up value.** The track URL is signed over `ip, ipbits, expire, v, ei,
   opi, xoaf` and is useless in pieces. A looked-up value must match `DERIVED_VALUE`
   (`/^[\w.~:@+=/-]{1,512}$/`, no `?` or `&`) and fills one leaf.
3. **A request no page of the site sends.** The `ANDROID` client body and user-agent are the
   Android app's. Chrome never sends them, so a trigger run cannot recapture the request, and
   healing cannot help: drift (YouTube moving the Android client to `pot` as well, a stale
   `clientVersion`) is only a failure. The `github` spec is in the same position for a different
   reason (github.com pages do not call api.github.com), but there the request is the site's
   documented API, not another client's identity.

Each of those is a deliberate rule: (1) and (2) keep a shared spec's lookup a plain read with an
identifier for an answer, and (3) is the reason the ladder exists. Loosening them for one op is
not worth it. Posing as the mobile app to avoid the web player's token is also close to what
DESIGN.md's non-goals rule out (TLS impersonation, CAPTCHA solving, signature reimplementation):
getting past a site's check of the client rather than sending what its page sends.

## Not tried

The route that fits the design is the web player's own request: a tier-3 run that opens the watch
page and turns captions on, so the page fetches `/api/timedtext` with its own `pot` and the
capture holds the WebVTT or `json3` answer. That op would need no spec-format change and would heal
like any other. Open questions before it can ship: whether a trigger step can turn captions on
reliably (the CC button, or the `c` key on the player), whether the captured answer has a body at
all (the earlier empty bodies may have been the player's preload), and whether tiers 1 and 2 ever
answer, since `pot` and the signed URL are per page load. If they never do, the op is tier 3 on
every call, which no bundled op is today.

## Tier-3 run, 2026-11-05 (Swiss network, guest profile)

The "Not tried" route, tried on a second network: headless Chromium 153.0.8010.12
(`chrome-headless-shell` and a headed full-Chromium run agree), ephemeral profiles, about thirty
requests, read-only.

- **A trigger step can turn captions on.** Opening the watch page, clicking the player to start
  it, then clicking the player's subtitles button lands the pointer event on the button and the
  player answers by fetching its caption track. The button selector used is the stable class
  `ytp-subtitles-button`, not the localized aria-label, so it works in any locale. The `c` key on
  the player was unreliable in headless. A European consent wall can appear one to three seconds
  after the page load; it is not part of the trigger, and a profile that has accepted it once no
  longer shows it.
- **The captured answer is the body the player gets.** The empty bodies of 2026-11-01 and
  2026-11-04 were not only the player's preload: on this network the player's own on-demand fetch
  after the toggle answered 200 with an empty body, content-type text/html, with no pot parameter
  in the URL, and in-page fetches of the watch page's own signed `baseUrl` answered empty in every
  variant (as signed, with vtt, json3, rvft or srv3, and without the signature). Where the page's
  player sees an empty track, the op answers missing; where the player gets cues, the capture
  holds them.
- **What answers from this network.** The newer Android client (`20.09.37`) still answered the
  player request from here. Its track URL bakes in `fmt=srv3`, which answers the cues (469 B for
  `jNQXAC9IVRw`, 3877 B for `dQw4w9WgXcQ`) as srv3 XML to a plain GET and to a page-context fetch
  alike, within its signature window; the same URL asked for vtt, json3 or rvft answered 200
  empty. The 11-04 machine's older client appended `&fmt=vtt` to a track URL carrying no baked
  fmt and got WebVTT, so which fmts answer depends on the network's cohort, not on the client
  alone. Sustained probing of `timedtext` from one address ended in 429 "Sorry..." pages.

The bundled `captions` op shipped from this is the first bundled operation at `minTier: 3`.
