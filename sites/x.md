No account is needed. Individual public posts are available; recent-post timelines are not included.

- An unknown handle returns `input` from both ops.
- `getProfile`'s `title` looks like "NASA (@NASA) on X".
- `getUser`'s `avatar.image_url` is the `_normal` (48 px) size. Replace `_normal` with `_400x400` for
  a larger one.
- `getUser` sends X's public bearer, which X could rotate. Then X answers 400 "Bad Authentication
  data" (code 215), and the call re-learns the bearer from the page (a browser run, once).
- `getTweet` takes the decimal ID from a post's URL, as a string. Its text and time are as displayed,
  including shortened links; engagement counts are labels rather than numbers. Reposts can include
  quotes; a separate quote count and quoted post ID are not returned. Image URLs are returned when
  present, but video URLs are not.

## Maintainer notes

Verified 2026-09-27, logged out, from a US IP. `api-anything verify x` passes, and both ops were called
from a clean `API_ANYTHING_HOME` using only this bundled spec: tier 1, no cookies, no browser.

| op | args | returns | tier |
|---|---|---|---|
| `getUser` | `screen_name` (example `nasa`) | `rest_id`, `core.name`, `core.screen_name`, `core.created_at_ms`, `profile_bio.description`, `location.location`, `relationship_counts.followers`/`following`, `tweet_counts.tweets`, `verification.*`, `privacy.protected`, `avatar.image_url`, `banner.image_url` | 1 (GraphQL GET, about 150 ms) |
| `getProfile` | `screen_name` (example `nasa`) | `title` ("NASA (@NASA) on X"), `screen_name`, `bio`, `avatar`, `banner`, `posts` as displayed ("74.3K"), `joined` ("December 2007"), `url`. No follower count | 1 (GET of the profile page, about 1 s) |

```sh
api-anything call x getUser screen_name=spacex
api-anything call x getProfile screen_name=NASAWebb
```

### How it works

- **getUser** sends `GET api.x.com/graphql/<queryId>/UserByScreenName?variables={"screenName":...}`
  with the public web-app bearer (the same constant X's JavaScript sends for every logged-out
  visitor) and a browser user agent. Guest token, cookies and `x-client-transaction-id` are not
  needed for this query, so they were removed from the spec by hand.
- **getProfile** fetches `https://x.com/<screen_name>` and reads the `<meta>` tags with a
  `response.html` recipe. It was learned entirely with `api-anything add ... --html`.

### How getUser was learned

A hard load of `x.com/<screen_name>` makes no `UserByScreenName` request: X's frontend runs it
server-side. An in-app navigation does send it, and `--soft-from` now navigates through the
app's router (history API + `popstate`) instead of a full page load:

```sh
api-anything capture https://x.com/nasa --soft-from https://x.com/spacex --example screen_name=nasa
api-anything add x getUser --from <capture> --pick-request <id> --example screen_name=nasa --public authorization \
  --extract data.user_result_by_screen_name.result --pick rest_id,core.name,...
```

`--public authorization` keeps X's public web-app bearer literal (every logged-out visitor's
browser sends the same one) and lets `export` write it. The guest token and
`x-client-transaction-id` headers were removed by hand: the bearer plus a browser user agent is enough.

### Known limits

- **Healing getUser.** A rotated queryId returns 404 "Query not found" (drift). The browserless
  rescan finds the new id in the SSR document (`key:"<queryId>{...}",name:"UserByScreenName"`).
  Recapture and tier 3 run the soft-navigation trigger (from `x.com/spacex`).
- **Unknown handle:** `getUser` gets `200 {"data":{}}`. api-anything replays the example handle, which
  still answers, and returns `input` in about 1 s, with no heal and no browser. `getProfile`
  returns `input` too (HTTP 404).
- If you query `spacex` itself, the soft-nav trigger's neutral page is the target page. This only
  matters for recapture.
- **No timeline operation.** Logged out, `UserOriginalsTimeline` returns an empty 404, even when sent by X's own
  frontend after a soft navigation. Tweets exist only in the SSR HTML, as a JS literal.
- Protected, suspended and logged-in-only fields were not tested.

## 2026-11-01: public post, logged out

| op | args | returns | tier |
|---|---|---|---|
| `getTweet` | `tweetId` (example `1354143047324299264`) | displayed text, author name and handle, displayed time, reply/repost/like labels, image URLs | 1, including a clean home |

`getTweet` reads the server-rendered status page's article. The captured request uses the XDevelopers
status path; X redirects it to the post's canonical author when the ID belongs to another account.
The matcher wildcards both the author and ID. The trigger uses `/i/status/{tweetId}`. The two
learning examples were the X Developers post above and post `20`; the held-out NASA post
`2116263878807998722` returned its displayed text, time, engagement labels and image.

The public Tweet embed loaded its HTML but did not make a tweet-result request in the capture.
The separate embedded-timeline endpoint returned HTTP 429, so testing that endpoint stopped.
This does not establish whether its timeline is generally available. No session values are stored.
