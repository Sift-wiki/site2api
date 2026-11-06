# Reference

Details behind the [README](../README.md). The design and its reasons are in
[DESIGN.md](DESIGN.md); setup for agents is in [QUICKSTART.md](QUICKSTART.md).

- [The CLI and the library at a glance](#the-cli-and-the-library-at-a-glance)
- [Results you can act on](#results-you-can-act-on)
- [Creating an operation from captured traffic](#creating-an-operation-from-captured-traffic)
- [Replay, fallback and repair](#replay-fallback-and-repair)
- [Read batches and stdin](#read-batches-and-stdin)
- [Logging in](#logging-in)
- [Finding operations and checking health](#finding-operations-and-checking-health)
- [Result views and local continuation](#result-views-and-local-continuation)
- [MCP server](#mcp-server)
- [Safety and terms of service](#safety-and-terms-of-service)
- [What leaves your machine](#what-leaves-your-machine)
- [Status and known limits](#status-and-known-limits)
- [Bundled sites](#bundled-sites)
- [Prior art](#prior-art)

## The CLI and the library at a glance

```sh
api-anything sites                                   # the sites you can call
api-anything ops goodreads                           # params, returns and caveats
api-anything call goodreads searchBooks q=piranesi   # JSON out; a failure exits nonzero
api-anything call google-flights search origin=SFO destination=NYC date=2026-12-01 --max-tier 1
api-anything call goodreads getBook bookId=50202953 --dry   # the request, credentials redacted
```

`api-anything <command> --help` explains each command.

```ts
import { call } from "api-anything";

const r = await call("goodreads", "searchBooks", { q: "piranesi" });
if (r.ok) console.log(r.tier, r.data);
else console.log(r.class, r.reason, r.next, r.retry);

// a write needs allowWrites at every entry point
await call("my-site", "postComment", { text: "Ship it" }, { allowWrites: true });
```

`npm install api-anything`. [`examples/reading-list.mjs`](../examples/reading-list.mjs) builds a
five-book table from Goodreads with no model and no browser, and
[`examples/mentions.mjs`](../examples/mentions.mjs) searches five sites for a project's mentions at
once. Agent hosts that only call installed operations can use [`api-anything/host`](HOST.md): local
discovery, redacted approval plans and call-only execution without learning, cookie import or
registry traffic. Bun can import its TypeScript source without a build step.

## Results you can act on

Every call answers in fields, so an agent or a script can act without parsing prose.

| field | values | it tells you |
|---|---|---|
| `class` | `ok` `drift` `auth` `rate` `blocked` `input` `error` `refused` `duplicate` | what happened |
| `write` | `not_sent` `not_applied` `accepted` `applied` `may_have_applied` | what a write did |
| `retry` | `safe` `after_wait` `after_fix` `no` | whether to send it again; `retryAfterMs` says when |
| `nextCall` | `login` `relearn` `fix_args` `check_site` `allow_writes` ... | the one step to take next; over MCP, with the tool and its args |
| `nextPage`, `hasMore` | the site's own cursor | how to get the next page of a list |
| `heal` | `{strategy, changes}` | how a call that repaired the op did it, and what changed in its request; `api-anything revert` undoes it |

`tier` says how the call went: 1 is one plain HTTP request, with no browser. A failure also says
why (`reason`) and what to do next (`next`).

## Finding operations and checking health

`api-anything search <words | domain | url>` and MCP `find_sites {query}` search the registry and
this machine's specs. Extra words do not cancel a capability match: `vegetarian pasta recipes`
can find recipe search. Each site and op returns normalized `matched` and `unmatched` words.
An op's words come from its own summary, not a different op at that site. Partial matches are
suggestions, not guarantees for uncovered constraints. Try the existing capability with the user's
values, or broaden the query, before learning a new site. Check each match's `domain` first.
Unconfirmed registry sites still require a domain or URL query.

Each search op, and each op in `pull <site>` output, separates evidence:

- `registry`: the registry version's `hash`, `status`, `confirmations`, `successRate` (0–1) and
  `lastOkAt`. Missing values say `"unknown"`; live with zero confirmations is not proof of success.
- `local`: the matching current op's last verify record, `status` (`pass`, `fail`, `inconclusive`,
  or `unknown`) and `at` when present. It includes no args or case results.

An installed copy keeps its params and descriptions without losing the registry's health. Health
describes the registry version, which may differ from the local one. An unreachable registry leaves
local matches with `registryError` and unknown registry health. No probes run, and no tier or latency
is inferred: the Worker does not store aggregates for them. In local-only mode (`setup --local-only`,
or `API_ANYTHING_LOCAL_ONLY=1`) the registry is never asked: search answers from this machine's specs
with a `localOnly` note saying so, and `pull`, `publish` and a call of a site this machine lacks say
it is local-only and how to turn that off.

`find_sites.nextCall` is a complete discovery call: `list_operations {site}` for a match, so the
agent reads notes before calling, or `list_sites {}` when nothing matched. An interface-only match
has no next call. `learn_site` still needs a page template and examples supplied by the agent.

## Creating an operation from captured traffic

Suppose you want Hacker News search as an operation. Start by seeing which requests the page makes:

```sh
$ api-anything capture "https://hn.algolia.com/?q=sqlite" --example q=sqlite
{"capture":"cmujqsybh","requests":38,"candidates":[
  {"id":21,"kind":"fetch","method":"POST","url":"https://uj5wyc0l7x-dsn.algolia.net/1/indexes/Item_dev/query?x-algolia-agent=...","status":200,"type":"application/json","carries":["q"],"size":61234},
  {"id":1,"kind":"document","method":"GET","url":"https://hn.algolia.com/?q=sqlite","status":200,"type":"text/html","size":2841}, ...]}
```

A candidate URL that carries one of the run's cookie or web-storage values (an
`?access_token=` some APIs take) shows it as the ref a spec would hold there, such as
`access_token=[cookie:auth]`, never the value; `learn_site`'s `chosen` and `alternatives` do the same.
`api-anything inspect <capture> <id>` shows a candidate's response, without a browser, and its
request's URL and body with the same refs (a value equal to one of its `--example` values stays as
it is). Then describe
how to make the page fire that request. Give two example values, so the learner can tell params
from nonces:

```sh
$ api-anything add hn-search search --trigger "https://hn.algolia.com/?q={query}" \
    --example query=sqlite --example2 query=postgres --match host=uj5wyc0l7x-dsn.algolia.net \
    --extract hits --pick "title,url,points,comments=num_comments"
{"ok":true,"site":"hn-search","op":"search","request":"POST https://uj5wyc0l7x-dsn.algolia.net/1/indexes/Item_dev/query",
 "params":["query:string"],"readOnly":true,"minTier":1,"match":{"host":"uj5wyc0l7x-dsn.algolia.net"},"extract":"hits",
 "preview":{"count":30,"first":{"title":"Hosting SQLite databases on GitHub Pages or any static file hoster","url":"https://phiresky.github.io/blog/2021/hosting-sqlite-databases-on-github-pages/","points":1812,"comments":244}},
 "warnings":[],"captures":["cmujqsybh","cmujqszcj"],"next":"api-anything call hn-search search query=..."}

$ api-anything call hn-search search query=duckdb
{"ok":true,"class":"ok","tier":1,"data":[{"title":"The DuckDB Local UI","url":"https://duckdb.org/2025/03/12/duckdb-ui.html","points":926,"comments":188}, ...],"ms":990}
```

The `add` and `call` output is real, from 2026-09-27, shortened; the `capture` listing shows its
shape (ids and sizes vary). `--pick`
accepts `name=path` to rename a field, `name=path~regex` to keep the part of a string the
regex's group 1 finds (`publicId=navigationUrl~/in/([^/?]+)`), and `[*]` in a path collects from every array item
(`sections[*].items` joins each section's items); items with none of the picked fields are dropped. If the preview is wrong, fix the recipe: re-run
`add <site> <op> --from <one of the captures>` with the recipe flags (`--extract`, `--pick`,
`--html`, `--embedded`). No browser is needed, and no `--example`: the operation's stored examples
are used, so its params stay. From a capture made with other values, pass those with `--example`.
For a server-rendered page, use
`--html '{"items":"<css>","fields":{...}}'`, or `--embedded '<regex>'` for JSON inside the page.
An `--html` recipe may add `"empty":"<css>"`, the element a page with no results shows instead of
the list (`p.SearchResults-emptyContentMessage` on pkg.go.dev): a call whose items match nothing
while that element is shown answers `data: []`.
`inspect` accepts the same recipe flags (`--extract`, `--pick`, `--html`, `--embedded`), so you can
try a recipe first: it exits non-zero when a path or selector finds nothing. An `--html` items
container that is on the page and empty, or the recipe's `empty` element shown on it, is a page
with no results: `data: []`, with a `note`.

In `capture`'s output, `pageStatus` is the page's own HTTP error when a request it loaded is
recommended all the same, and `blocked` is the bot challenge the site served.

`add` can also learn from a saved capture instead of running the trigger: `add <site> <op> --from
<capture> --pick-request <id> --example k=v`. A capture holds one run, so the second example needs a
second capture of the page, made with its values: `--from2 <capture2> --example2 k=v2`.

When the page looks up the value its data request needs (a product page at `/p/<slug>` asks
`/api/resolve?slug=` for the product's numeric id, then loads `/api/products/<id>/reviews`), `add`
with two examples learns the lookup with the op: each call sends the lookup first, with the same
session, and fills the id from its answer. Pick the data request (`--pick-request`, or a recipe
that names its answer) even though it carries no example value. The lookup is a GET on the same
host; one that fails is the call's answer and the op's own request is not sent (a write reports
`not_sent`). With one example, `add` says which value looks looked up and asks for `--example2`.

`add` does not save an op whose captured answer is a bot challenge, a sign-in page, a rate limit or
a server failure: log in (`api-anything login <site>`) or wait, then add again. When example 2 is
answered with example 1's data, the op is saved with a warning and marked `unproven`: the server may
not read those params at all (it goes by a cookie or the IP). Pick an example 2 that excludes
something example 1 returned, such as another place or a filter value one of its rows fails. When
example 2 changes more than one param of a read, `add` also sends one read per changed param
(example 1's args with only that value from example 2) and marks `unproven` only the params whose
read answered example 1's data again: a `page` the server ignores is caught beside a `q` it reads.

`--enum name=a,b,c` lists the values a param takes (the site's whole set, such as a picker's
options), and `--min name=n` / `--max name=n` bound a numeric one. A call with another value is
`input` and nothing is sent; `ops` and MCP `list_operations` show them. Set them on an existing op by
editing its spec. An op learned again keeps its params' allowed values and descriptions.

A list that pages takes `--paging`. Learn a cursor-paged list from the request that loads page 2
("Show more"), with the cursor as the example, and say where the answer gives the next cursor:

```sh
api-anything add goodreads getReviews --from <captureId> --pick-request <id> \
  --example workId=kca://work/... --example after=<page 2's cursor> \
  --extract data.getReviews.edges --paging after=data.getReviews.pageInfo.nextPageToken
```

The cursor param becomes optional, and its captured value is dropped. A call without it gets page 1,
with the cursor's slot emptied. Each call returns `nextPage`, the value to pass as `after` for the
next page, and `hasMore` (`false` when the site says it is the last page). `--paging page`, with no
path, marks numbered pages: the call says nothing about the next page, since a non-empty page is
also what the last one looks like. `verify` asks a paged op for the page after its example's and
fails it when that page holds only page 1's items again.

You rarely have to find the cursor yourself. Capture the page with steps that click "Show more"
(`capture <url> --steps '[{"action":"click","selector":"#more"}]'`): when it loads two pages of one
list, `capture` and `inspect <capture>` list them as `pages`, with the paging found and the `add`
flags that learn the list from page 2:

```json
"pages": [{"requests": [5, 6], "paging": {"param": "after", "next": "data.reviews.pageInfo.endCursor"},
  "flags": "--from c1 --pick-request 6 --example 'after=Y3Vy...' --paging 'after=data.reviews.pageInfo.endCursor'"}]
```

Add the list's other `--example` values to those flags. `add` from such a capture without `--paging`
warns that the request is one of two pages. The suggestion is never applied silently: two unrelated
requests can look like pages of a list.

When the answer gives the next page as a URL rather than a value (crates.io's
`meta.next_page: "?per_page=10&q=reqwest&page=2"`), read the value out of it with `path~regex`, as
`--pick` does: `--paging 'page=meta.next_page~[?&]page=([^&#]*)'` returns `nextPage: "2"`. `capture`
suggests this form when it finds the value inside such a string.

`learn` (and MCP `learn_site`) takes `--steps` and `--paging` too (`steps` and `paging` over MCP).
With steps that load page 2, a cursor-paged list that both of its runs page the same way is learned
with that paging: the result has `paging` (`auto: true`), `data` (page 1), `nextPage` and
`hasMore`. The cursor is the op's own param, never in `--args`. For numbered pages, put the page in
`--args`, `--args2` and `--args3` and pass `--paging page`.

A write can prove it landed. Name a read of the same site that shows it, filled from the write's
args:

```sh
api-anything readback todo addTodo listTodos --find "title={title}"
```

After the write is sent and answered 2xx (or may have run), the call runs that read once. When an
item's `title` equals the write's, `write` is `applied`. When it is not there yet, the write stays
`accepted`, and `reason` says so. The read is never a resend.

Record what a human confirmed on the site as checks, then let `verify` run them with the examples:

```sh
api-anything check hn-search search query=zzqqxxnothing --expect empty --purpose "no story matches"
api-anything verify hn-search
```

`--expect` is `result` (data), `empty` (the site's own no-results) or `input` (the args are
refused). `verify` reports each case as `pass`, `fail` or `inconclusive`: a challenge, a sign-in
page, a rate limit or a server that failed or could not be reached tests nothing. Check args are
shared with the spec, so use public values only.

`verify` is made for a job nobody watches:

```sh
api-anything verify hn-search goodreads        # several sites; none means every known site
api-anything verify --user                     # the user's own specs in ~/.api-anything/sites
api-anything verify --user --strict            # inconclusive, or a write not ready, exits 1 too
```

- Exit code: 0 when every counted case passed; 1 when a case failed or a site could not be
  verified; 2 when nothing failed and a case was inconclusive (the site, not the spec). `--strict`
  makes 2 into 1. A skipped op never sets the exit code.
- A read that drifted heals even while marked stale: verify is the explicit check. The stored
  template is still sent first.
- Each case's record keeps `since`, when it began answering its current outcome, and the output
  lists `newlyFailing`, `recovered` and `failingSince` (per `site/op`), so a nightly run tells new
  breakage from old.
- A read learned signed in is `skipped: needs login` without a call when no login is on record for
  the site. Log in, then verify again.
- A write is never sent. Its row is a `preflight`: `builds` (the template fills from the example and
  the session; a missing `session:` value says "needs a trigger run"), `learnedLoggedIn` against
  `loggedIn` now, its `readback`'s outcome in this run, `unconfirmed` (writes in the ledger that were
  sent and never confirmed landed), and `ok`. A preflight is not a case: without `--strict` it never
  sets the exit code, and it is no part of what `publish` reads.

## Replay, fallback and repair

Besides its request template, each operation stores two things:

- **trigger**: how to make the site's own frontend fire the request. This is a URL template,
  plus optional UI steps. A write's trigger may also hold `confirms`: the `confirm()` dialogs its
  learning accepted, each as a step index and a SHA-256 digest (no page text), which a tier-3 call
  accepts again when the page asks the same question, and `companions`: the other unsafe requests
  its learning saw the trigger send on the op's site, by stable identity, the only ones besides its
  own that a tier-3 call lets out.
- **match**: how to recognize that request in captured traffic by stable identity only
  (method, host, path with hash-like segments wildcarded, GraphQL operation name). It never
  uses a queryId or hash.

One routine, run the trigger, match the request, learn the template, does three jobs:

1. **Create.** `add` runs the trigger with your example values. It substitutes only those values
   and stores everything else verbatim, down to key order and the site's own percent-encoding.
   Cookies and auth headers become references to a local session store, so a spec file never
   holds a credential.
2. **Heal.** Every call sends the stored template first. The response is classified as ok,
   drift, auth, rate, blocked, input or error, and only drift triggers a heal. The heal tries:
   - **rescan**, with no browser: fetch the page and its scripts and find the new id next to
     its anchor;
   - **recapture**: run the trigger again with your current args and re-learn from it.

   A healed template is saved only after a replay succeeds. The call that healed says how and
   what changed in `heal`, one line per change to the request, with `{param}` and refs in place of
   values (the CLI prints it on stderr too):

   ```
   "healed":true,"heal":{"strategy":"rescan","changes":["path: /api/graphql/Aa1.../UserByName -> /api/graphql/Zz9.../UserByName"]}
   ```

   Each heal is logged to `~/.api-anything/heals.jsonl` with the op as it was. `api-anything heals
   [site]` lists the last 20 with their changes, and `api-anything revert <site> <op>` puts the op
   back as it was before its last heal. It refuses if the op changed after that heal (learned again
   or edited). Run it again to take back the heal before. A reverted op whose site really changed
   drifts and heals again on a later call, so learn it again with `add` if the heal was wrong.
   Two guards stop heal loops: a heal that produces an identical
   template is not drift, and an op that drifts again within 10 minutes of a heal is marked
   stale for 30 minutes.
3. **Fallback.** For reads, the triggered browser run has already received the answer. When a
   template can't be replayed (for example, per-request signatures), that answer is returned only if the captured request matches the call’s arguments at their declared positions. Otherwise the call fails rather than returning another query’s data.

Transport tiers, cheapest first. The lowest tier that worked is remembered for each op.

| tier | transport | used when |
|---|---|---|
| 1 | Node `fetch` with a domain/path-scoped cookie jar | default |
| 2 | `fetch()` inside a real Chrome page on the site | tier 1 is `blocked` |
| 3 | run the trigger in Chrome and read the site's own response | per-request signatures, a failed heal (reads only) |

### Health: `api-anything status [site]`

An op can keep working and still be in trouble: an escalation to tier 3 is remembered for good, so
a read that took 4 ms can take 700 ms and a browser launch on every call while `ops` still says
nothing. `status` shows what this machine knows of each op, from local files only. It sends
nothing and needs no browser. Output is one line of JSON:

- per site, `cooling` `{class, until, reason}` while calls answer without sending;
- per op, `stale` `{until, reason}`, `tier` `{remembered, minTier}`, `lastHeal` `{at, strategy}`,
  `lastVerify` `{at, outcome, current}` (`current: false`: the op changed after that verify),
  `writes` (the ledger's writes of the last 24 h, counted by `accepted`, `applied`,
  `mayHaveApplied`, `notApplied` and `notSent`), and `calls`: for the last `24h` and `7d`, the
  count, the `ok` rate, the `tiers` that answered, `heals` and `medianMs`, and the `last` call's
  class;
- `degraded` on an op whose last 24 h ran mostly at a higher tier, or with an ok rate 20 points
  lower, than the 6 days before (3 calls in each window at least);
- `problems`, each `{site, op, problem, detail, next}`: `cooling`, `stale`, `escalated` (a read
  remembered above its own tier; `next` calls it once with `--max-tier` at that tier, and an
  answer there forgets the escalation), `degraded`, `failing` (the last call failed for a reason
  other than its args), `verify` (the last verify on this version failed), `write` (a write may
  have gone through), `plaintext` (a session file is stored unsealed because no key is available,
  a session or capture written before sealing is not sealed yet, or the key fails, such as a wrong
  `API_ANYTHING_KEY`). `next` is phrased as a call's `next`;
- `storage`: whether session and capture files are sealed here, `{sealed: true, key}` with the key's
  source, or `{sealed: false, why, chosen}`. Finding out may create the key in the OS store, as the
  first save would.

With a site, every op is listed. Without one, only the sites with something on record here, and
only the ops with something to say: a passing verify alone is not listed. The call history comes
from `~/.api-anything/calls.jsonl`, one line per finished call: time, site, op, class, tier, ms,
whether it healed and what a write did. It holds no args, no data and no reason text, and is kept 30
days (`status` reads the last 7).

### Usage: `api-anything stats [--days n] [--card]`

Results go to your agent, so when API Anything works you never see it. `stats` totals what this
machine's calls did over the last 30 days (`--days 1` to `30`), from the same call log. It sends
nothing. Output is one line of JSON: `calls`, `okRate`, `sent` (calls that sent a request; a
cool-down's answer or refused args send none), `tiers` (tier 1 is plain HTTP), `plainHttp` (the
share of sent calls at tier 1), `sites`, `ops`, `topSites` (the 5 most called, each with its
`okRate`), `medianMs` of the sent calls, `heals` (calls that repaired a drifted request), `writes`,
and `window` `{days, since, until, firstCall}`.

`saved` is an estimate, and says so in its `assumption` field. Each ok call that sent a request
counts as 2.5 s of an agent driving a browser, less the call's own time, and a call slower than that
counts for nothing. The figure sits below what [the benchmark](../bench/README.md) measured. On
Google Flights (5 dates) the browser agent took 41.6 s and the API Anything agent took 21.1 s over 10
calls of about 1.2 s each, which is about 3.2 s of browser time per call. On Goodreads (5 books) the
times were 182.5 s and 30.5 s. That is one model on two sites, so `saved` is not a measurement of
your calls.

`--card` prints a few plain lines to paste into a post instead of the JSON:

```text
API Anything, last 30 days
1,240 calls to 9 sites, 97% ok, 92% over plain HTTP with no browser
median call 472 ms, 5 calls repaired after the site changed
about 38 min of browser-agent time saved (estimate: 2.5 s per ok call, less the call's own time)
top: goodreads 512, google-flights 301, reddit 188, youtube 120, hackernews 64
npx -y api-anything setup
github.com/goodnight000/api-anything
```

## Logging in

For sites that need an account, one command signs you in:

```sh
api-anything login linkedin.com
```

The target can be a site name (`linkedin`), a domain (`linkedin.com`, `www.linkedin.com`) or a URL.
By default this **imports** the site's cookies from your everyday browser — you are almost always
already signed in there, so there is no password to type and no 2FA or captcha to redo. It prints
the browser profile it used, with the profile's display name and Google account, and the cookie
*names* (never the values). Then LinkedIn operations just work:

```sh
api-anything call linkedin getCompany universalName=openai
api-anything call linkedin getProfile publicId=williamhgates
```

**The first import asks you.** An agent with a shell can run `login` too, so the first import of a
domain's cookies from a browser profile waits for a person: on a terminal it asks `Import
linkedin.com cookies from Chrome profile "Work" (me@example.com)? [y/N]` before it reads any cookie
value, and without a terminal it reads nothing and answers `ok: false` with a `next` to run
`api-anything login <site>` in a terminal or use `--window`. `--profile` does not skip the question.
Your yes is kept, in the site's session file, for that domain (its registrable domain:
`linkedin.com` covers `www.linkedin.com`) and that profile only. Importing that domain again from that
profile (`login` again, or the re-import after an `auth` call) asks nothing. Another profile, or
another domain, is a new choice and asks again, even under the same site name: an operation of the
site on another domain does not re-import that domain's cookies on its own. `logout` forgets the
approvals with the session. A session imported by an older version counts as approved for its
profile and the domain of the site's `baseUrl` only. `--window` and `--cookies` need no terminal.
For headless automation you set up yourself, `API_ANYTHING_ALLOW_IMPORT=github.com,linkedin.com`
pre-approves those domains.

The question is a safeguard against an agent importing a site's cookies by accident, or because a
page it read told it to. It is not a security boundary against an agent with unrestricted shell
access: such an agent can open a terminal of its own and answer `y`, or set
`API_ANYTHING_ALLOW_IMPORT`, and it can read your files anyway. The boundary is not giving an
agent you don't trust a shell.

**Several profiles signed in.** If more than one browser profile is signed in to the site (a work
and a personal profile, or someone else's account in your Chrome), `login` does not guess. It
answers `ok: false` with a `candidates` list, each with its profile, display name and email, and you
pick one:

```sh
api-anything login linkedin.com --profile "Chrome/Profile 1"
```

The choice is remembered: when a call later returns `class: "auth"`, api-anything re-imports from
that same profile once on its own before asking you to log in again. It retries the call only if the
re-import brought new login cookies. If they are the same ones, the site has ended that sign-in in
your browser too, so the call's `next` says where to sign in, for example `sign in to linkedin.com in
Chrome profile "Work"`, rather than sending you back to `login`, which would import them again.

**What counts as signed in.** Many sites give every visitor a session cookie named like a login
(`laravel_session`, a Rails `_app_session`, `ci_session`). Before it imports or opens a window,
`login` fetches the site once with no cookies and records the names of the cookies it is given
(names only, in the session file). Those never count as a sign-in. The output says `loggedIn` and
`renewed`, plus a `warning` when the imported cookies show no sign-in or are the same login cookies
the session already had. If a site's real login cookie has an unusual name, list it in the spec's
`loginCookies`; that list always wins.

A write learned while signed in is checked before it is sent: if the session has no live login
cookie (expired or missing), api-anything re-imports first, and if there is still none the call
returns `class: "auth"` and sends nothing.

**Keychain: choose Allow, not Always Allow.** On macOS an import shows one Keychain prompt ("security
wants to use the … Safe Storage" key). That key decrypts every cookie the browser holds, and Always
Allow lets any process that runs `security` read it from then on without asking you again, which
makes an import nobody watched silent. With Allow, each import asks.

The imported session is the *same* one as your browser, so if the site logs it out, both
go — avoid heavy automated traffic on it. Other ways in:

- `--window` opens a visible Chrome window to sign in by hand (an independent session). Use it when
  the site asks for 2FA or a captcha, or when you don't want to share your browser's session. It is
  also the automatic fallback when nothing is importable. Finish signing in, 2FA included, then close
  the window or press Enter: it does not close itself, because some sites set their login cookie before
  the second factor is done. It counts only if a login cookie appeared or changed while it was open;
  otherwise `login` answers `ok: false`, says why, and keeps the session you had.
- `--cookies <file>` imports a `cookies.txt` (Netscape) or JSON export, for servers/CI with no browser.
- `api-anything logout <site>` deletes the stored session (it needs no key, so it also resets a sealed
  session whose key is lost).

**How the session is stored.** The session file (`~/.api-anything/sessions/<site>.json`),
captures and the answers kept for `--max-age` and `--changes` (`snapshots/`) are sealed with AES-256-GCM, so a backup, a synced folder or a copied home does not carry
your logins. The key is made on first use and kept in the macOS Keychain (item `api-anything`,
created by `security`, so reading it shows no dialog), the Secret Service on Linux (`secret-tool`),
or DPAPI on Windows. On a machine with none of those, such as a container or CI, set
`API_ANYTHING_KEY` to a passphrase; it overrides the OS store. Keep the passphrase: without it the
sealed files cannot be read, and a wrong one is an error, not an empty session. Keep `key-salt.json`
too: if it goes missing while passphrase-sealed files exist, api-anything refuses to make a new one
and says to restore it. To start over, run `api-anything logout <site>` for each site, delete the
files in `captures/` and `snapshots/`, and log in again.

A sealed file starts with the line `#api-anything-sealed`. api-anything 0.3.2 and earlier refuse such
a file as corrupt instead of reading it as an empty session, so going back to an older version does
not overwrite your sealed sessions (it cannot use them either).

On a machine with no key store at all, a home that has never sealed a file keeps 0600 plaintext JSON
as before: the CLI says so once on stderr, and `status` lists a `plaintext` problem for each such
session. Set `API_ANYTHING_PLAINTEXT=1` if that is your choice, to silence both. Any other key problem
is an error and nothing is written in plaintext: a locked or failing key store, any error with
`API_ANYTHING_KEY` set, or a missing key store in a home that has sealed files. The error's `next`
says what to fix; the next command asks the key store again. Files written before sealing still
read, and are sealed in place the first time a key is available; one that cannot be sealed yet (busy
or corrupt) is retried by the next run and listed by `status` as `plaintext` until then.

A trigger step never signs in: a `--steps` fill into a password or one-time-code field (the page's
`type=password`, or `autocomplete` `current-password`, `new-password`, `one-time-code`) fails the run
and saves nothing, since a step's value is stored in the spec. A hand-written step like that is
refused by `export`, `publish` and `pull`.

Chrome, Arc, Brave, Edge, Chromium and Firefox are supported on macOS and Linux (on Linux, not
cookies encrypted with the desktop keyring). On Windows, `login` opens a window.

In short:

- **Guest cookies don't count.** Many sites give every visitor a cookie named like a login
  (`laravel_session`, `_app_session`). `login` notes which ones a signed-out visit gets, and those
  never count as signed in.
- **A window sign-in has to show a login.** It counts only if a login cookie appears or changes
  while the window is open. Otherwise `login` says so and keeps the session you had.
- **On an unauthorized call**, API Anything tries each of these at most once, retrying the call after
  each one that changes something: re-import from the profile you chose; take cookies from its own
  browser profile; for an op with session tokens, reload the page so the site issues fresh ones. A
  write's own request is stopped during that reload, so only the retry sends it.
- **A write learned while signed in** isn't sent while the session has no live login cookie.
- Live cookie and session values are replaced by `[redacted]` in every `reason` and `next`.

## Read batches and stdin

`call --json -` reads one args object from stdin (at most 4 MiB). Positional `k=v` arguments
override its keys:

```sh
printf '%s\n' '{"query":"sqlite"}' | api-anything call hacker-news search --json -
```

`batch` reads JSONL from stdin by default, from `-`, or from `--input <file>`. Each line is
`{id?, site, op, args?}`; `id` is a string or number, and omitted args mean `{}`. Sites must
already be installed: use `pull` first, or MCP `list_operations`.

```sh
printf '%s\n' \
  '{"id":"news","site":"hacker-news","op":"search","args":{"query":"sqlite"}}' \
  '{"id":"books","site":"goodreads","op":"searchBooks","args":{"q":"Circe"}}' |
  api-anything batch - --concurrency 2
```

- One JSONL result per line, in input order: `{id, site, op, ...callResult}`. Without an id the
  1-based line number is used. The normal `class`, `retry`, `next`, `nextCall`, `nextPage`,
  `hasMore` and `truncated` fields are kept. Args are not echoed.
- Sequential by default. `--concurrency 1..4` allows different sites to run together; a site's
  own items stay sequential, including case variants of its name. Every call uses the normal
  per-site pacing and cool-downs. After a rate limit or block starts a cool-down, remaining
  valid reads of that site answer from it without sending; other sites continue.
- At most 200 lines and 4 MiB of input. `--limit 1..200` lowers the line cap. Oversized input
  fails before any call. Empty input emits nothing. A malformed or blank line gets its own
  `input` result without echoing its text; a final newline is not an extra line.
- Writes always answer `input`, `"writes are not batched"`, with `write: "not_sent"`.
  `--allow-writes` and `--force` are not batch flags. `--max-tier 1` keeps a batch browserless.
- Partial failures do not stop the batch. Exit 0 when all items are ok, otherwise 1.
  No result caching, retries of whole batches or automatic pagination.

The library exports `callReads(items, opts)`, an async iterable of the same ordered results:

```js
import { callReads, closeBrowser } from "api-anything";

try {
  for await (const result of callReads([
    { id: "news", site: "hacker-news", op: "search", args: { query: "sqlite" } },
  ], { concurrency: 2, maxItems: 20, maxTier: 1 })) {
    console.log(JSON.stringify(result));
  }
} finally {
  await closeBrowser();
}
```

`BatchItem`, `BatchOptions` and `BatchResult` are exported types. The array cap is 200;
`maxItems` can only lower it. Invalid bounds or an oversized array throw before sending; invalid
items fail individually. Options also accept `timeoutMs` and `fetchImpl`, but no write, force
or pacing override. Breaking iteration starts no more calls and waits for those already running
(at most four) to finish.

## Result views and local continuation

Output is capped at 20,000 JSON characters by default. Shape just this call's output, separately
from the site's params:

```sh
api-anything call <site> <op> q=example --fields 'id,name=details.title' --max-chars 4000
api-anything result <resultId> --offset 7 --fields 'id,name=details.title' --max-chars 4000
```

MCP: `call_operation {site, op, args, view: {fields: ["id", "name=details.title"], maxChars: 4000}}`.
Library: `call(site, op, args, {view: {fields: ["id"], maxChars: 4000}})`, then
`getResult(resultId, {offset: 7, fields: ["id"]})` from `api-anything`.
`fields` uses the stored pick's path syntax (including `name=path`, but not `path~regex`, which a
view refuses as `input`), per item; empty projections stay `{}` so indexes do not shift. Classification and the stored
extraction/pick happen first. A view cannot restore fields that recipe discarded.
`maxChars` must be an integer from 256 to 200,000 and caps `data`, not its envelope.

A cut answer has `resultId` and `more`, independent of the site's `nextPage`/`hasMore`.
MCP `get_result` takes `more` unchanged. CLI `result` takes its id and the corresponding
`--offset`, `--fields`, `--max-chars`, and `--format` flags. It only reads the local kept answer,
with no site request or spec change. To reshape from the start, use just the id and new fields.
Normal offsets count items. An oversized single item or non-list answer instead returns
`more.format: "json"` with offset 0: `get_result` (`result --format json`) returns `encoding:
"json"` and `data` string fragments of the full projected answer's JSON. Concatenate those
fragments, then `JSON.parse`; do not append the initial shortened preview. Offsets then count
characters. Restart at offset 0 when changing fields in that mode.

The full extracted answer, before the call's view, is private local user data. At most 20 cut
answers, and at most 16 MiB of them together (an answer over that alone is not kept, and its cut
answer says so), are kept in `API_ANYTHING_HOME/results.json` (default `~/.api-anything`), with 0600
permissions in a 0700 directory, for 15 minutes without renewal. Expired records are removed
on the next successful call or result access; an expired or evicted id fails locally, never
reruns the call. Answers do not enter specs, logs, or reports. If retention fails, the cut
answer says it is unavailable instead of returning a continuation.

## MCP server

`api-anything mcp` serves these tools over stdio:

| tool | what it does | hints |
|---|---|---|
| `list_sites` | the sites, with how many operations each has | read-only |
| `list_operations` | a site's operations: args (`inputSchema`), output shape/type hints (`output`), field names (`returns`), operation `links`, paging and readback, and the site's notes; optional `prepare` builds a linked call without executing it | read-only |
| `call_operation` | call a read; a write op is refused and nothing is sent | read-only, idempotent |
| `call_batch` | up to 20 read items, optional `concurrency` 1..4; `{ok, results}` in input order, writes rejected | read-only, idempotent |
| `call_write_operation` | call a write, with `again` and `idempotencyKey`; only with `--allow-writes` | destructive, not idempotent |
| `get_job` | wait up to 25 s for a pending call's result | read-only |
| `site_status` | what `api-anything status` prints, with each problem's `next` in MCP terms | read-only, local |
| `get_result` | retrieve or reshape a kept answer, with no site request | read-only, local |
| `login` | refresh a session from the profile chosen with the CLI, or open a window to sign in by hand | changes the local session only |

- `--sites goodreads,hacker-news` also serves each operation of those sites as a tool of its own,
  `<site>__<op>` (at most 40 characters, any other character as `_`), that takes the op's args
  directly. A write is one only with `--allow-writes`.
- A tool call still running after about 25 s answers `{ok: false, class: "pending", job}` and keeps
  running; `get_job {job}` returns its result, or pending again, and never runs it again. The same
  call while it runs joins it, so a second `login` for a site whose window is open returns that
  job. Jobs end when the server does; a finished one is kept 15 minutes. A sign-in window nobody
  closes is closed after 10 minutes.
- `call_batch` uses the same jobs mechanism: an identical running batch joins its job, and
  `get_job` returns `{ok, results}` when it finishes. A failed item's retry hint names
  `call_operation` for that item, never the entire batch. Each item's data uses the same compact
  table representation as a single call; its retry, paging and truncation fields stay intact.
- Each answer is JSON text, and the same object as `structuredContent`.
- `--print-config` prints how to add the server to Claude Code, Codex, Gemini CLI, VS Code, Cursor,
  Claude Desktop and Hermes, with absolute paths. With `--pin` it prints the npx form pinned to this
  version (`npx -y api-anything@<version> mcp`), as `setup --pin` writes it. Client timeouts and fixes
  for common problems are in [QUICKSTART.md](QUICKSTART.md#client-timeouts).
- `api-anything serve` serves the same tools over HTTP: MCP over Streamable HTTP at `/mcp`, JSON
  endpoints under `/v1` that answer as the library's `call()` does (data as records, plus a
  `nextRequest`), and an OpenAPI 3.1 document at `/openapi.json`. See
  [SERVE.md](SERVE.md).

### Portable operation descriptions and links

`api-anything ops goodreads getBook --schema` prints `{site, op, description?, readOnly, params, output, links?}`.
`params` is JSON Schema, identical to MCP's `inputSchema`. `output.cardinality` is `list`, `one`
or `unknown`; `output.fields` maps names to `{type?, source}`. A type is `declared` by a recipe
(HTML text stays a string, `all:` stays an array, a pick regex returns a string), `observed` in
the stored learned shape, or `unknown` without evidence. These are hints, not an output
validator: absent fields stay absent, no numbers are parsed from text, and a stripped response
shape cannot establish a type. Goodreads `getBook` is a list even when it has just one item.
Neither discovery surface calls the site.

An operation's optional `links` records how one of its result fields supplies another op's arg:
`{from: "url", to: {op: "getRecipe", arg: "slug"}, transform: "lastPathSegment"}`.
The URL's final non-empty pathname segment is used, without its query/fragment and without
percent-decoding. Alternatively `path~regex` uses the same path/group-1 semantics as `--pick`,
relative to the source field; `~regex` applies to the source string itself (Rotten Tomatoes
`searchMovies` links `url` to `getMovie.slug` with `~/m/([^/?#]+)`). When the op's recipe names
its fields (a pick or an HTML recipe), `from` must start with one of them. The bundled
Goodreads, BBC Good Food, Rotten Tomatoes and LinkedIn specs declare their chains this way.

Choose an item, then ask MCP to prepare (not execute) a link:

```json
{"site":"bbcgoodfood","prepare":{"op":"search","link":0,"item":{"url":"https://www.bbcgoodfood.com/recipes/beef-bourguignon"}}}
```

Pass that to `list_operations`; its `nextCall` names `call_operation` and contains
`{site:"bbcgoodfood", op:"getRecipe", args:{slug:"beef-bourguignon"}}`.
`link` is a zero-based index from the listed op's `links`. The site must already be installed;
preparing does not pull it. Additional target params go in `prepare.args`; defaults are filled,
but required params without a value fail instead of borrowing examples. MCP preparation only
offers reads. It never selects among results or runs any request.

The library exports `describeOperation(siteSpec, op)`, `prepareLink(siteSpec, sourceOp, item,
link, extraArgs?)`, and registry reads `search` and `pull`:

```ts
import { describeOperation, loadSite, prepareLink } from "api-anything";
const site = loadSite("bbcgoodfood")!.site;
const description = describeOperation(site, "search");
const next = prepareLink(site, "search", selectedItem, description.links![0]!);
// next is {site, op, args}; executing it remains a separate, permission-checked call.
```

Links survive whole-site export, healing, relearning and adopting the registry's version of an op. Single-operation registry uploads
omit them, because their targets are not part of that upload.

## Safety and terms of service

- api-anything automates your own browser session on your own accounts. It is meant for things you
  could do by hand, at human pace. Requests to one site are spaced about 1 s apart (0.7 to 1.3 s, at
  random), at every tier and across processes: separate CLI runs and agents in parallel queue up for
  the same slot. A trigger run is a page load, which may fire many requests of the page's own.
- When a site answers a rate limit, api-anything leaves it alone for its Retry-After (at most 30
  minutes), or 3 minutes without one; after a block at every tier, or a 451, for 10 minutes. Calls
  meanwhile answer `rate` or `blocked` at once with nothing sent, and `retryAfterMs` counts down.
  `api-anything login <site>` ends the wait. `api-anything call ... --force` sends that one call
  anyway: when it succeeds the wait ends; when the site limits or blocks it again, the wait starts
  over from that answer.
- **Writes** (posting, sending, buying) are learned by intercepting the request and aborting it
  in the browser, so learning never performs them. Without `--write`, `add` and `capture` stop a
  POST, PUT, PATCH or DELETE the steps send (a GraphQL query, or the request `--match` pins, passes):
  one on the page's own site fails the add before its second run, so a forgotten `--write` places no
  order. The failure says to add an action again with `--write`, which never sends it, and offers a
  `--match` pin only for a request that changes nothing (a search sent as POST): a pinned request is
  sent for real on each learning run and saved as a read, so never pin an order. A tier-3 write call lets out only the op's own request, once, and the other unsafe requests
  its learning saw the trigger send (`trigger.companions`); any other is stopped, and the reason
  names it (a redesign whose button now deletes the account deletes nothing). Card payment is left to
  you: api-anything does not learn card fields, which sit in the payment provider's iframe. Calling a write needs `--allow-writes` on the
  CLI, the MCP server (whose `call_write_operation` sends it; `call_operation` never does), or the library. A write is sent once and is retried only when the
  server certainly did not run it (a 400, 401, 403 or 404 answered to the write itself, not after
  a redirect). Timeouts and 5xx errors are reported,
  not retried. The result's `write` says what happened (`not_sent`, `not_applied`, `accepted`,
  `may_have_applied`), and `retry` says whether to send it again (`no` for one accepted or that may
  have gone through). The same write with the same args within 10 minutes of one that was accepted
  or may have gone through is refused (`class: "duplicate"`), unless the caller passes `--again`
  (MCP `again`, library `again`). `--idempotency-key <k>`, passed on the first call, makes a repeat
  return that call's record instead of sending; a key added only to a retry of a keyless call is
  still that call's `duplicate`. A UUID the site's page makes for each request (an idempotency key)
  is learned as a `gen` slot: each call sends a new one, the same on its own retries, and the same
  for every call with one `--idempotency-key`. A result that says to check the site names the page. The record (`~/.api-anything/writes.json`, kept 24 hours) holds the
  site, the op, the time, the outcome and an HMAC of the args under a random local key, never the args.
- A failure's `reason` quotes the site's answer, and `next` can name values too: both have every
  live cookie and session value replaced by `[redacted]` (as stored, URL-encoded, JSON- or
  HTML-escaped, or base64), including what is left of one the 160-character quote cut short. So do
  stale marks and the heal log. `data`, the answer you asked for, is not redacted.
- **Native dialogs** in the browser: leaving a page ("unsaved changes") is accepted, since leaving
  sends nothing; alerts and prompts are dismissed; a `confirm()` is dismissed during reads. While a
  write is learned its request is intercepted, so its confirm is accepted and recorded as a digest
  of the page's origin, the step and the question with your example values abstracted. A tier-3
  write call accepts a confirm only when it matches that record with the call's own values; any
  other is dismissed, and the call's reason says so. A call whose trigger fired no matching request
  says why the browser stopped waiting: whether the page went quiet or the time ran out, the page's
  address without its query, its HTTP status, the requests still open and the dialogs it showed.
- Credentials stay in `~/.api-anything` (directories 0700, files 0600), and session files and
  captures are sealed (see "How the session is stored" under Logging in). Specs hold references
  such as `cookie:ct0`, never values. Captures (`~/.api-anything/captures`, kept for `inspect` and
  `add --from`) hold full responses and the run's cookie values, so only the newest 20 are kept and
  none past 24 hours; an older one is refused with a `next` to capture again. `api-anything export` strips your example values, and it
  refuses to write a spec that contains any live cookie or session value from your machine.
- api-anything does not solve CAPTCHAs or impersonate TLS fingerprints. It runs its own Chrome
  profile; `api-anything login <site>` copies only that site's cookies from your everyday browser
  (or signs in through a window), and only when you run it.
- Many sites' terms restrict automated access. Read them. You are responsible for how you use
  this tool.

### Write guards, in short

- Nothing is sent without `--allow-writes` (MCP: `call_write_operation`, library: `allowWrites`).
- Learning a write intercepts and aborts the request, so learning never performs it. Learning a read
  stops any POST, PUT, PATCH or DELETE its clicks send, so a forgotten `--write` places no order.
- When the browser sends a write, only the requests its learning saw go out: a redesigned button
  that now deletes the account is stopped, and the result names it.
- Card payment stays with you: api-anything doesn't learn card fields.
- A write is sent once. It is retried only when the server certainly didn't run it (400, 401, 403, 404).
- The same write within 10 minutes is refused as `duplicate`, unless you pass `--again`.
  `--idempotency-key` on the first call makes a repeat return that call's record.
- A key the page makes per request (`Idempotency-Key: crypto.randomUUID()`) is made fresh for each call, not replayed.
- `accepted` is a 2xx. Only a `readback` that finds the new item makes it `applied`.

[Recording: a write refused without `--allow-writes`, applied once, then refused as a duplicate](demos/README.md#5-a-write-refused-by-default-sent-once-never-twice),
against the local test site the suite uses. No write operation is bundled.

## What leaves your machine

Calls run on your machine, your network and your sessions. The catalog stores specs and counts
reports; it never proxies your calls. Its only request to a site is the "try it" endpoint for a few
public operations ([REGISTRY.md](REGISTRY.md)), which a visitor runs from the catalog's page.

Whether sharing is on or off, a search goes to the catalog: the words, domain or URL your agent passes
to `find_sites`, and the name of a shared site it calls before this machine has it. The catalog keeps
no search words. Local-only mode (`api-anything setup --local-only`, or `API_ANYTHING_LOCAL_ONLY=1`)
stops every registry request, searches included; searches then cover this machine only and say so.
With sharing on:

- **Operations learned from public pages.** Shared automatically only when it is a read, it was
  learned signed out, and the replay with no cookies answered (with the data, or with a bot wall
  such as Anubis or Cloudflare, which each caller's browser passes on its own). Its stored example
  is the agent's second value and its check is the third, never the value you asked for.
- **An operation that needed your login**, or one that may hold something of yours (an email
  address, an id, a value typed into the page), goes only after you say yes, or once 3 installs on
  3 networks learned exactly the same thing.
- **Reports.** After a call: which version ran, the outcome, the transport tier and the time. No
  arguments and no data. Each is signed by your install's anonymous key.
- **Background checks, only with verification on too.** Verification is a separate question, asked
  after a yes to sharing and defaulting to no (`setup --verify` or `--no-verify`). With it on, an idle
  MCP server calls a few new operations a day (at most 20) with their published examples, from your
  network over plain HTTP with no cookies, only to https addresses on public hosts.
- **Repairs.** When a call heals a public operation that drifted, the repaired version is shared.

With sharing off (`api-anything setup --no-share --share-only`), or before you answered, nothing is
shared or reported, and the catalog still works for reads. [How the catalog works](REGISTRY.md)

### What the gate checks

- Cookies and tokens are references in an operation (`cookie:name`), never their values, and a spec
  holding a live credential is refused before it is saved.
- `publish` previews exactly what each upload sends, every host the op sends to, and anything that
  may be yours, such as an email or an account id. Nothing is sent until `--yes`.
- It refuses a spec holding a live cookie or session value, a provider API key, an op whose recorded
  checks fail, and an op marked `unproven`. The catalog runs the same rules again on every upload.
- A param can declare an `enum`, a `min` or a `max`. A call outside them is `input`, and nothing is sent.
- A pulled spec is someone else's. A session value goes only back to the host it came from, an
  unconfirmed candidate runs with none of your cookies, and its writes still need `--allow-writes`.

### Sharing by hand

```sh
api-anything search book ratings        # or goodreads.com, or a page's URL
api-anything pull goodreads             # checked against the shared rules first
api-anything check hn-demo links domain=arxiv.org --expect result  # confirmed on the site
api-anything verify hn-demo                                         # pass, fail or inconclusive
api-anything publish hn-demo                                        # preview only
api-anything publish hn-demo --yes                                  # upload, signed by this install
```

Your agent does the first two on its own: `find_sites` searches the catalog, and calling a site this
machine doesn't have fetches it, reads only. A new operation is a candidate until installs other than
its uploader report it working from different networks; then it is served as live. A live one is
replaced only when 3 or more networks see it fail. Operations that write, that needed a login, or
that send to another site's host wait for a maintainer, and are never promoted by reports. A site's
own MCP server or OpenAPI document shows up in search beside the operations agents learned for it.

## Status and known limits

This is an early release for developers and agents. It ships 323 read operations across 114
sites ([the list](#bundled-sites)). Those operations cover selected features, not the entire sites. LinkedIn messaging and
posting are not bundled. The engine's write handling is tested against a local fixture, not
against every site's real write endpoints. Treat `write: "accepted"` as taken, not done: give the
op a `readback`, so a call can say `applied`, or check the site before treating delivery as confirmed.

Site specs are executable request/interaction instructions. Install specs from sources you trust
and review their destinations and write declarations. A `readOnly` declaration is not a sandbox
for a malicious spec, and website text is data, not instructions for the agent.

The offline suite covers the learning, healing, tier and write paths against a local fixture site.
Individual real sites vary and are not continuously verified.

In short:

- Calls run on your machine, your network and your sessions. The catalog is a directory of specs,
  not a hosted API, and it's young.
- It knows only the operations someone taught it, not every feature of every site.
- `learn_site` learns from one page load per value, from a URL template. A site whose data appears
  only after clicks or typing, or only on in-app navigation, needs the CLI's `capture` and `add`
  with `--steps` or `--soft-from`. It learns reads only.
- A shared operation is someone else's work. Candidates are served marked as such until other
  installs confirm them, and an operation that worked for others can still fail for you (a
  different region, a block on your network).
- Repair can fail. There's no CAPTCHA solving: if a site challenges real Chrome, you clear it by hand,
  and a challenge that doesn't clear is reported as `blocked`.
- `verify` proves an op only as far as its examples and checks go: a few cases a human confirmed,
  not a test suite.
- No write operations are bundled, and writes are tested only against a local fixture. A 2xx doesn't
  prove a message was delivered: only a write op with a `readback` that finds it says `applied`.
- Paging hands back the site's own next cursor when the answer has one. Numbered pages get no hint.
- Read each site's terms. You're responsible for how you use it.

Known limits in detail:

- An arg a site derives from another request is substituted only when an earlier GET of the same
  page load, on the same host and carrying the example values, answers it as JSON, and two examples
  show it follow. A value the page computes, reads from HTML, or looks up with a POST, on another
  host or with a stored session value, is not: model the lookup as its own op, or rely on tier 3.
  A page-2 cursor is passed back as an arg with `--paging`. Otherwise `add` refuses an example
  value that the chosen request does not carry.
- Example values need at least 3 characters and must appear in the request (multi-word values
  are fine; they are matched decoded, so `mcp server` finds `mcp%20server`).
- An op extracts one value from one request. Data in two places of one page takes two ops.
- `--html` returns text as it is in the page. `@href` and `@src` are links, so a relative value
  is resolved against the page's `<base href>` or else the final URL the answer came from, and
  returned absolute; the other attributes (`@title`, `@id`, ...) and plain text stay as they are.
- `--html` and `--outline` read only what the page shows: `<script>`, `<style>`, `<noscript>` and
  `<template>` are dropped, and so is every element with the `hidden` attribute (not
  `hidden="until-found"`) or an inline `display:none`/`visibility:hidden`, with all it holds.
  `aria-hidden="true"` stays: it hides from screen readers, not from the eye. Hiding done by a
  stylesheet (an `sr-only` class, off-screen positioning) is not seen, so such text still comes back.
- "Not found" is detected by replaying the op's example args, so a spec without examples reports
  missing data as `drift`. An empty result is `ok` with `[]` when the page shows it structurally:
  an empty JSON list at the extract path, or, for `--html`, an items selector written as
  `"<container> <item>"` whose container is on the page with no item-tag element in it, or the
  recipe's `empty` element shown on the page. A no-results page that drops the list and shows a
  message instead needs `empty`; without it the call is `input` ("selector matched nothing", since
  the example args still answer), and an `--expect empty` check fails with a reason that says so.
  A message the site shows for another reason too (an error it styles the same way) reads as `[]`. A list
  that `--pick` empties (no item has a picked field), or `--html` items with none of their fields
  found, is missing data, not `[]`: the site may have renamed them. So is a picked field the op
  learned with a type (not `null`) that no item carries now, or none with that type: when the
  example args' answer still has it, the call is `ok` and its `reason` names the field; otherwise a
  heal is tried, and if it cannot bring the field back the call is `drift` naming it, with a `next`
  to re-add with a new `--pick`. A field learned `null` or absent, missing from some items of the
  learned list, or present in some items of a list now, is optional. A field that keeps its type and changes its meaning (cents instead of units)
  is not detected.
- A write's 2xx is `ok` unless its answer says it was refused: an error field that holds an error
  (`userErrors`, `error: "..."`), `ok`/`success` false, an error word as the root `status`, a body
  status of 400 or more, GraphQL errors with null or no data, or the form page answering with its
  errors. A redirect back to the form that shows an error, or to an address naming one, is
  `error`, because the write may or may not have run. A site that answers a failure with an
  unmarked 200 still reads as `ok`. None of these verdicts sends the write again.
- A signed-in read redirected to a consent, terms or "verify it's you" page of the same site is
  `error`. Its `next` names the page, which the user finishes in the browser before running
  `api-anything login <site>`. It is not healed and not marked stale.
- A param may declare a `pattern` (a regex the whole value must match) and a `hint`, an `enum` of
  the values it takes, and a `min`/`max`; a call whose arg fails one is `input`, and nothing is sent.
- Two examples that the site answers with the same data mark the op `unproven`, which may be a
  false alarm (two places with the same stores). `publish` refuses it until a re-add with a better
  example 2, or until `verify` sees two passing cases that differ only in those params answer
  differently. When example 2 changes several params of a tier-1 read, each is also sent alone in
  example 1's args, so a param the server ignores beside one it reads is caught; one read per
  changed param, at the site's pace. A param the server ignores is still not caught when the two
  answers differ for another reason (a timestamp, a shuffled order), when the op needs a browser
  (tier 3, whose per-param reads would not answer), or when example 2 changes only that param and
  the two answers happen to differ anyway.
- Chrome locks its profile to one process. An MCP server releases it after 3 s idle; another
  process waits up to 15 s for it, then fails with a hint.
- Optional request structure (a reply block that only some calls have) needs a separate op.
- Rescan only reads scripts that the page references directly. An id inside a lazily loaded
  chunk heals through recapture instead, which is slower.
- A site behind a bot wall that challenges a real Chrome as well needs you to clear it by hand
  (`api-anything login <site> --window`). There is no CAPTCHA solving and no TLS impersonation. A trigger run or
  repair that ends on a challenge that did not solve is `blocked` and marks nothing stale.
- Paging returns the site's own next cursor, and only when the answer holds one. Numbered pages
  get no `nextPage`. When the output cap cuts a page, the cut items are on neither that page nor
  the next; use the local `more`/`get_result` continuation to recover them before following
  `nextPage`, or reshape the kept answer with `fields`.
- A readback finds what the read shows: a write the site lists later, or under a value other than
  the one sent, stays `accepted`. An older item with the same value passes for a new one, so find
  something only this write makes.
- The recorded answers in `test/fixture/sites/` prove that a bundled recipe still parses the
  answer it was recorded from, not that the site still answers that way. Ops that send a cookie or
  session value have none.


## Bundled sites

114 sites and 323 read operations ship with the package (`api-anything sites` from an empty home,
2026-11-06), and the catalog serves the same ones. They cover selected features, not whole sites.
On 2026-10-31, called from an empty home with their examples, 97 of the 99 operations that needed no
account in the first 55 sites answered with data ([release notes](RELEASE-READINESS.md)).
`api-anything ops <site>` lists each op's params and caveats, and the
[catalog](https://api-anything-registry.forth-site.workers.dev) has everything agents shared since.

Known gaps: `google-flights.priceCalendar` answers an internal error since Google changed it, and
`aldi.applianceDetails`'s example product is gone. `linkedin` needs your account, and `dominos-au`
ships no examples. Reddit challenges plain HTTP from many networks, so its calls often need the
browser tier. `dominos-au` came in through `publish` from a contributor, `goodreads` was built by
the [explorer](../bench/explore/README.md), and `reddit` was the site agents asked for most.

| site | ops | what |
|---|---|---|
| `airbnb` | 2 | Search Airbnb stays by date and inspect public listings |
| `aldi` | 1 | Retailer descriptions and advertised technical details for public ALDI UK appliance product pages. |
| `aljazeera` | 1 | Read Al Jazeera English section fronts. |
| `allrecipes` | 4 | Allrecipes recipes, logged out: keyword search, ingredients, steps, nutrition and embedded reviews. |
| `amazon` | 1 | Amazon.com product search |
| `apple` | 4 | Public US iPhone technical specifications from Apple model-family pages. Includes public iPhone, iPad and Mac model-family catalog links. Includes selected public US retail store business details and source-declared opening hours. |
| `appstore` | 4 | Public App Store app listings, displayed reviews, developer shelves and US iPhone search results. |
| `archive` | 2 | Search Internet Archive items and inspect Wayback Machine capture summaries without an account. |
| `arxiv` | 4 | Public arXiv paper abstracts, search results and category submissions from arxiv.org HTML pages. |
| `ashby` | 2 | Public Ashby-hosted company job boards and postings. |
| `auchan` | 1 | Public French product identities and general characteristics, without purchase-mode prices or availability. |
| `bbc` | 3 | Read BBC section fronts and public news articles. |
| `bbcgoodfood` | 2 | Signed-out recipe search and recipe details from Good Food public pages. |
| `bing` | 1 | Public organic web search results from the signed-out Bing results page. |
| `bluesky` | 3 | Read public Bluesky profiles, author feeds and post threads without signing in. |
| `booking` | 3 | Booking.com stays, logged out: search a destination for dates, a property's details, and its rooms and rates for dates. |
| `chownow` | 1 | Public restaurant identity and nested published menu data from ChowNow source documents. |
| `clinicaltrials` | 2 | Search public clinical studies and read their registry records. |
| `cnn` | 2 | CNN's public lightweight headlines and articles. |
| `commons` | 3 | Public Wikimedia Commons image search, file pages and category galleries. |
| `costco` | 1 | Public US product identity and descriptive metadata, without membership prices or availability. |
| `coursera` | 3 | Public course catalog search, course metadata and ordered specialization curricula from signed-out Coursera pages. |
| `courtlistener` | 1 | Search public US court opinions on CourtListener, a Free Law Project service. |
| `craigslist` | 3 | Search signed-out public for-sale listings in the San Francisco Bay Area. |
| `crates` | 8 | Search public Rust crates and inspect their releases, dependencies, reverse dependencies and owners, logged out. |
| `disneyplus` | 3 | Public signed-out title metadata from Disney+ entity documents in the observed US English context. |
| `dockerhub` | 2 | Look up public container repositories and their first page of tags without an account. |
| `docsrs` | 3 | Read public Rust crate documentation and release overviews on docs.rs. |
| `dominos-au` | 3 |  |
| `duckduckgo` | 2 | Signed-out web search results and search autocomplete suggestions. |
| `ecb` | 2 | Get official euro foreign-exchange reference rates and recent currency history. |
| `edx` | 3 | Public provider course cards, course details and professional-certificate course membership from signed-out edX documents. |
| `espn` | 4 | ESPN scores, standings and NBA rosters, logged out. |
| `eventbrite` | 2 | Discover featured events by city and read public event details. |
| `fandango` | 2 | Public movie discovery and metadata from Fandango search and movie overview pages. |
| `federalregister` | 3 | Search public US federal regulations, notices and presidential documents and read their publication details. |
| `flashscore` | 2 | Public competition document pair navigation and identity/competition metadata for the fixture selected by a known football pair link. Pair links do not uniquely select a date or event. |
| `flixbus` | 2 | Public city stop directories and published route guide FAQs. |
| `github` | 12 | Public GitHub repository search, repository details, files, directories, releases, user profiles, issues and pull request lists, from github.com's own pages. |
| `goodreads` | 6 | Goodreads books, logged out: search, book details, an author's books, and community reviews. Explored and built by an agent with the api-anything skill (bench/explore). |
| `google-flights` | 3 | Logged-out one-way flight search and a cheapest-date price calendar on Google Flights. Prices in USD, en-US. |
| `google-maps` | 1 | Public signed-out Google Maps place search with English/US result context. |
| `google-play` | 5 | Public Android app listing identity and displayed metadata in the response locale. |
| `greenhouse` | 2 | Public Greenhouse-hosted company job boards and job descriptions. |
| `guardian` | 3 | Read Guardian news fronts, articles and topic pages. |
| `gumtree` | 1 | Public UK listing product metadata from server-rendered detail documents. |
| `habr` | 1 | Habr (habr.com), the Russian-language IT community, logged out: one article or news item by id. Results are in Russian. |
| `hacker-news` | 7 | Hacker News front page (HTML) and story search via the Algolia index behind hn.algolia.com. Public, logged out. |
| `hays` | 1 | Public structured job metadata from Hays UK posting pages. |
| `healthline` | 1 | Public news article titles, source URLs, credits and publisher date labels. No article bodies or clinical guidance. |
| `hh` | 2 | hh.ru (HeadHunter), the largest Russian job board, logged out: vacancy search by keywords and region, and one vacancy's details. Results are in Russian. |
| `huggingface` | 7 | Hugging Face Hub: search public models, datasets and Spaces, and read their repository metadata while logged out. |
| `ietf` | 3 | Public RFC and Internet-Draft search and metadata from the IETF Datatracker. |
| `ikea` | 4 | Public signed-out IKEA US English category products, individual product metadata and selected-store visit details. |
| `imdb` | 1 | Find movies, TV series and people on IMDb |
| `instacart` | 3 | Public city retailer directories, pantry category product discovery and product-detail metadata from Instacart. |
| `instagram` | 2 | Public Instagram profiles, logged out: profile details and the 12 most recent posts, read from the Relay data embedded in the server-rendered profile page. |
| `jet2holidays` | 1 | Public destination descriptions, popular resort labels and editorial activity categories. |
| `justwatch` | 1 | Regular public streaming, rental, purchase and other provider offers on US movie pages. |
| `khan-academy` | 2 | Public course identity and ordered unit metadata from signed-out Khan Academy course pages. |
| `lever` | 2 | Public job boards hosted on Lever (jobs.lever.co/<company>), read through Lever's public postings API: every open posting of a company, and one posting's full description. |
| `linkedin` | 5 | LinkedIn read operations over the Voyager API: your own mini profile, a member profile, a company, people search, company search. Needs login: `api-anything login linkedin --profile <browser/profile>` imports your session. |
| `mastodon` | 7 | Read public accounts and recent posts on mastodon.social without signing in. |
| `mcdonalds` | 2 | Public national US menu category product links and product descriptions. No restaurant pricing, availability or customized nutrition. |
| `mdn` | 3 | Search English web platform documentation, read article sections, and inspect browser compatibility data without an account. |
| `meetup` | 2 | Public event discovery and advertised schedules from signed-out Meetup pages. |
| `megabus` | 1 | Provider-advertised US route-guide identity, stop counts and travel summaries. |
| `metacritic` | 6 | Public title search, scores, critic reviews and browse lists from Metacritic. |
| `musicbrainz` | 7 | Search public artists, releases and recordings, and inspect artist and release pages. |
| `nasa-images` | 2 | Search NASA's public image, video and audio library and find available media assets. |
| `nasdaq` | 1 | Public stock listing identity from observed Nasdaq frontend requests. |
| `netflix` | 3 | Public signed-out title metadata from Netflix title documents in the observed US English context. |
| `nike` | 5 | Public US catalog categories, product details and initial free-text search shelves, signed out. |
| `npr` | 3 | NPR's public text-only front page, sections and articles. |
| `openfoodfacts` | 1 | Look up public food product information by barcode. |
| `openlibrary` | 7 | Open Library (the Internet Archive's book catalog): book search from the site's search page, and a work's or an author's record from the site's own JSON. Public, logged out. |
| `openstreetmap` | 4 | Reverse-geocode coordinates and get driving, walking, and cycling directions using OpenStreetMap's public map. |
| `pinterest` | 1 | Public signed-out Pinterest search suggestions from the frontend typeahead. |
| `pkggodev` | 3 | Search and inspect public Go packages and their documentation indexes. |
| `pypi` | 3 | Public Python project metadata, release history and release files from PyPI project pages. |
| `pythondocs` | 3 | Read Python 3 documentation pages and standard library API entries, and browse the module index without an account. |
| `reddit` | 3 | Reddit, logged out: site-wide post search and sorted subreddit feeds, read from the pages reddit.com serves. Reddit challenges plain HTTP from many networks, so a first call can take the browser tier. |
| `rfceditor` | 1 | Public RFC text from the RFC Editor. |
| `rightmove` | 1 | Public UK property-search location lookup from the Rightmove frontend. |
| `rottentomatoes` | 5 | Public movie search, scores, TV series profiles and movie lists from Rotten Tomatoes. |
| `smartrecruiters` | 2 | Public company career pages and job postings hosted by SmartRecruiters. |
| `spotify` | 5 | Public track, album, playlist, artist and podcast episode metadata from Spotify embed documents. |
| `steam` | 5 | Public Steam storefront product search without an API key. |
| `substack` | 1 | Find public Substack profiles and their primary publications. |
| `ticketmaster` | 1 | Search public event metadata from the Ticketmaster US frontend. |
| `tiktok` | 2 | Public TikTok profiles and videos, logged out: a profile's bio and counts, and one video's caption, stats, music and author, read from the data embedded in the server-rendered page. |
| `timeanddate` | 2 | Local time, time zones and public holidays from timeanddate.com |
| `tmdb` | 1 | Search public movie, television and person listings on The Movie Database. |
| `toscrape` | 4 | The toscrape.com scraping sandbox, read from its server-rendered pages: books.toscrape.com (a fake bookstore: a category's books and a book's details) and quotes.toscrape.com (quotes by tag and an author's bio). |
| `tradingview` | 2 | Public instrument metadata and U.S. sector stock discovery from TradingView documents. |
| `trip` | 1 | Public destination hotel lists from Trip.com landing pages, without dates or live availability. |
| `ulta` | 3 | Public US beauty product documents. |
| `uniqlo` | 1 | Signed-out Denmark English product metadata; excludes prices, inventory and variant selection. |
| `usgs-earthquakes` | 3 | Explore recent earthquakes and search the USGS earthquake catalog. |
| `vinted` | 1 | Document metadata for known public US resale items. |
| `waitrose` | 2 | Public UK product document metadata without a selected store. |
| `weathergov` | 3 | Get public US National Weather Service point forecasts, hourly tables, and current weather observations. |
| `wikidata` | 3 | Public Wikidata entity search, selected item claims, and English label resolution. |
| `wikipedia` | 10 | English Wikipedia: search, article text, links, sections, categories, summaries, languages, Main Page highlights and public revision history. Public, logged out. |
| `wikiquote` | 3 | Public English Wikiquote title suggestions, selected quotation list items and the current quote of the day. |
| `wikivoyage` | 3 | English Wikivoyage destination search, summaries and travel-guide sections, available logged out. |
| `wiktionary` | 3 | Public dictionary entry definitions, title suggestions, and English IPA pronunciations from English Wiktionary. |
| `workable` | 1 | Public job postings on Workable-hosted company boards. |
| `workday` | 1 | Public job metadata on Workday’s own employer careers tenant, not other employers using Workday. |
| `x` | 3 | Public X (Twitter) profiles and individual posts, logged out: account details, profile cards, and visible post text and engagement. |
| `yahoo-finance` | 2 | Public stock quotes from Yahoo Finance's summary documents. |
| `yandex` | 2 | Yandex Weather (yandex.ru/pogoda), logged out: current weather and the hourly forecast for a city. Results are in Russian. Yandex web search and Yandex Market answer a SmartCaptcha to automated browsers, so they are not covered. |
| `youtube` | 7 | Search YouTube videos and browse public video and channel details |
| `zalando` | 1 | Public UK article identity and colour metadata; excludes size selection, offers and inventory. |

## Prior art

| project | the honest difference |
|---|---|
| [unbrowse](https://github.com/unbrowse-ai/unbrowse) | Learns routes passively from browsing; its inference runs on a closed server, and drift is handed back to the agent to re-capture. api-anything is local, learns from known example values, and repairs the template itself. |
| [Integuru](https://github.com/Integuru-AI/Integuru) | An LLM picks the request and writes Python code for it (AGPL). api-anything learns deterministically, with no LLM, and stores data rather than code, so a single executor can heal any site. |
| [reverse-api-engineer](https://github.com/kalil0321/reverse-api-engineer) | A coding agent writes a per-site client and hardcodes the captured credentials in it. api-anything keeps credentials out of specs, and it heals at runtime instead of re-running an agent. |
| [mitmproxy2swagger](https://github.com/alufers/mitmproxy2swagger) | Turns proxy captures into OpenAPI docs, with a human editing templates in between. It is a documentation tool: it has no replay, auth, or drift handling. |
