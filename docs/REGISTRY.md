# The shared registry — design

Agents share one catalog of website operations, and the same agents fill it, verify it and repair
it as a side effect of using it. The registry is a small service (`registry/`, a Cloudflare Worker
with D1) that stores operations and counts reports. Every expensive step — learning, verifying,
repairing — runs on users' machines, which already have the browser, the sessions and home
connections that sites do not block. The wire contract is `src/registry-api.ts`. The one request the
registry ever sends to a site is a visitor's try of an allowlisted public read ("Trying an op from the
catalog"), and a Worker var switches it off.

## The rule

Nobody does anything only to share or verify. Uploading, verifying and repairing happen as part of
using the tool; a person is asked only to share an operation that needed a login or that writes.

## Setup

`npx api-anything setup` finds the user's agents (Claude Code, Codex, Cursor, Claude Desktop, Hermes,
Gemini CLI, VS Code) and, on a terminal, asks once which to connect (Hermes only by name); without a
terminal it connects the ones named with `--agents`, and none otherwise. It connects the MCP server to
each (and the skill where the agent takes skills), checks for a Chromium browser (needed only to learn
sites), makes the install's key (`identity.ts`: an Ed25519 pair in `~/.api-anything/key.json`, 0600)
and asks:

> Help build the shared catalog? Your agent will share operations it learns from public pages (never
> your cookies or logins) and report under this install's anonymous key whether calls work. Site
> searches go to the catalog either way, unless you choose local-only.

The answer is `settings.json` `share: true|false` (Enter on the terminal is yes; an agent passes `--yes`
only on the user's explicit yes, and `--no-share` otherwise). After a yes, a second question:

> Also let an idle server test up to 20 new shared operations a day from your network? No cookies,
> public https hosts only.

Its answer is `verify` (Enter is no; `--verify`, `--no-verify`), and background verification
(below) runs only with both on. An install that answered the old single question, which also said "test
a few new operations a day from your network", keeps the answer it gave: the first read writes
`verify` from `share` into the file with `verifyFrom: "migrated"`, so no read infers it again. No
account. An install that never ran setup (the plugin, `claude mcp add`, `npm -g`) shares nothing until
the question is answered: `learn_site` asks it once, the first time it has something to share (MCP
elicitation, or the CLI's prompt), and when the client cannot ask, its `next` has the agent ask the
user and run `api-anything setup --yes --share-only` or `--no-share --share-only`, which records the
answer alone. What it does not change: `find_sites` sends its query to `GET /v1/search`
whether sharing is on or off (the local specs are searched too, and answer alone when the registry
cannot be reached), and so does a call of a site this machine lacks, which fetches it. Words go as
typed: letters and digits, a hyphen or an apostrophe inside. Every other token of the query is read as
an address and goes as its public registrable domain and no more (`registryQuery` in
`src/registry.ts`): the registry reads nothing else of one, and a path or query can hold a token.
Nothing goes of a token that has no public domain: an IP, `localhost` or a single label with a port or
a path, a suffix outside the public list, a `.arpa` name, however it is written (after a user name and
password, a `key=`, in brackets, percent-encoded), and what is no address at all (`node.js`, a file
path). The registry holds no such site, so that part of the search covers this machine alone, where
the whole query still matches, and the answer's `notSent` says that part of the query, or all of it,
was not sent. The registry
sees the request's IP address, as any web server does, and does not store it. Of a domain or URL search
that finds nothing, it keeps the registrable domain and the hashed network that asked (demand, below),
never the words of a search.

**Local-only.** `setup --local-only` (`settings.json` `localOnly`) or `API_ANYTHING_LOCAL_ONLY=1` stops
every request to the registry: search, pull, reports, verification jobs, claims, uploads, publish,
interface reports and the bundled-spec upgrade. It is enforced in `registryRequest`, the one function
every registry request goes through, which throws before it opens a connection. Search then answers from
this machine with a `localOnly` note; a call of a site this machine lacks, `pull` and `publish` say it is
local-only and how to turn it off (`setup --no-local-only --share-only`, or unset the variable).

## Using an operation that exists

1. The agent calls MCP `find_sites` (words, a domain or a URL). The registry's `GET /v1/search`
   answers with each match's operations, their params and status, so the agent can call one next. Its
   `q` is at most 200 characters (longer is a 400; the client searches with the first 200, its local specs too), since each listed
   op repeats the query's words in its `matched`/`unmatched`. Every
   match, local or the registry's, shows its `domain`, and the tool's description, its `next` and the
   skill tell the agent to check that domain is the site the user means: a site's name and description
   are the uploader's words, and can imitate another site.
   Anyone can upload a site that calls itself Amazon, so search trusts only what other installs
   confirmed:
   - a site with a live op always ranks above a site with only candidates, whatever the score;
   - words never find a site with no live op. A domain or URL query finds it when it names the site's
     own domain;
   - `GET /v1/index`, the home page list and the sitemap leave such a site out. Its page
     (`/sites/:name`) still renders, marked `noindex`.
   Lexical ranking is shared with the client (`src/search.ts`). Unmatched constraint words do not
   subtract from a capability hit; covering more query words improves rank. Optional `matched` and
   `unmatched` arrays on `SearchMatch` and `FoundOp` explain normalized query words, with each op
   matched only against its own summary. Partial matches suggest calling the existing capability or
   broadening before learning, not that the uncovered constraints are supported.
   `find_sites.nextCall` is `list_operations {site}` (read its notes first), or `list_sites {}` on
   no match, rather than an incomplete call or learn request.
2. `call_operation` on a site that is not installed fetches it (`GET /v1/sites/:name`) first. Of a
   site fetched this way only the reads run until a human runs `api-anything pull` (the `by: "agent"`
   mark, as before). An op of a fetched or pulled site that is still a `candidate` is called with none of
   the user's cookies or session values, at plain HTTP and in the browser's page fetch: by the review
   rules a candidate is a public read and needs none, and a GET with the user's cookies can still act on
   their account. The call runs on the user's machine: plain HTTP first, the browser if it must.
3. After the call, a report (`POST /v1/reports`): version hash, outcome, tier, ms. No args, no data.
   Reports are batched, sent in the background, and dropped when the registry cannot be reached. Each
   is signed by the install's key and stored with it and the time it arrived: the key is anonymous, but
   it ties together every report and upload this install makes.

## Learning an operation that does not exist

1. After trying partial capabilities or broadening discovery, `find_sites` finds nothing, or the site
   lacks the op. The agent supplies a page and examples to `learn_site`.
2. `learn_site {page URL template, args, args2, args3, intent}` (MCP; CLI `learn`) first looks for the
   op among what is shared: words never find a site with only candidates, so a newcomer would learn it
   again, and since the version hash covers the op's name, description, examples and checks, two
   independent learns never hash the same and neither collects confirmations. So when the registry
   serves a site for the trigger's domain (`sharedName`) and one of its reads has the same trigger page
   (placeholders at the same places, any names), the client pulls it as an agent pulls (reads only, the
   shared rules, a candidate called with no cookies), calls it with the user's args, and on data answers
   with it and `reused`: no browser, no upload. That call's report counts toward the op's promotion.
   Otherwise, or when the call fails, it runs the page with the user's own args, picks the request and
   the fields from the outline (the agent can override), runs it again with a second example, and
   returns the data of the user's own request with the op saved.
3. The client proves it before sharing (`learnsite.ts`):
   - the two-run diff and run 2's data (add's existing rules);
   - a holdout call, with args used as neither example, answers with data;
   - a clean replay: the op called with no cookies and no session values. Ok means it is public; so does
     a bot wall answering (Anubis, Cloudflare): the data is public behind it, and each caller's browser
     tier passes it.
   Before the holdout call sends anything, `learn_site` refuses a request that is no read: a method other
   than GET or HEAD unless it is a GraphQL query sent as POST, a GraphQL mutation, a GraphQL POST that
   carries no query document (a persisted query, named by a hash or an id), or a param that is the whole
   body or the document. Over MCP the trigger must be an https page on a public host.
4. `shareOps` uploads it (`POST /v1/versions`, signed). A public read goes automatically when
   `share` is on (unanswered, the question is asked first: Setup). Public also means learned in a session
   that shows no account: no login on record for the site, and no live cookie of the site's own domain
   whose name is not known to be a visitor's (an analytics, consent, bot-management or CSRF cookie, or a
   name a signed-out visit was given at a login or is given now: the client asks the site once, with no
   cookies, when such a cookie is all that stands in the way). A read learned with a login on record, or
   under a session cookie no signed-out visit is given, waits for the user's yes, since its request can
   carry their account's id as a constant. `learn_site` also keeps here an op whose request still spells
   one of the user's own values (as it is, encoded, in base64 or as a slug), and its question names every
   value the saved op holds: its params' examples and each check's args. A login op is claimed by its
   fingerprint ("Ops learned signed in"). A login op or a write is uploaded with its body only with
   the user's yes (CLI prompt, or MCP
   elicitation where the client supports it); the prompt lists what in the upload may be the user's own
   (an email, an id, a literal typed into the page). The published examples are the agent's chosen second
   example and holdout, never the user's own request. An automatic upload carries no checks but
   learn_site's holdout and none of the user's own `<site>.md` notes: a check recorded with
   `api-anything check`, or notes the user wrote, go only with their yes (`publish --yes`). A pulled
   site's notes came from the registry and go back with its heal.
5. A new site's name is its registrable domain with dots as dashes (`crates-io` for crates.io,
   `lobste-rs` for lobste.rs); a site the registry already holds keeps its name (a seed's: goodreads.com
   is `goodreads`), and a new op uploaded under another name on that domain goes to review. So
   `learn_site` names a new site after a site this machine has on that host, else the name the registry
   serves the domain under (`sharedName`: `GET /v1/search?q=<domain>`, a match whose `domain` is it;
   never asked about a host that is not public, a trigger's or an upload's), else the slug. `shareOps` uploads a site
   under its own name when it is pulled or bundled or the registry serves its domain under that name,
   and otherwise under the slug, which the outcome's `as` names (`publish.ts` `registryName`,
   `uploadName`).

## Demand

What agents looked for and nobody shared is the list of what to learn next. A `GET /v1/search` for a
domain or a URL that matches no site records that query's registrable domain with the hashed network
that asked; words are never recorded, since they are a person's and the list is public. `GET /v1/demand`
(cached 60 s) and the home page list the domains asked for in the last 30 days that no site covers yet,
by how many distinct networks asked, so one network asking a thousand times counts once. A domain
leaves the list once a site for it is shared; the daily job deletes records older than 90 days.

Only a public domain is recorded. An IP address, `localhost`, a single label, a name under a suffix
outside the public list (`.internal`, `.local`, `.lan`, `.test`, `.example`, `.invalid`) or under `.arpa`
is a name on someone's own network: the search is answered and nothing is kept. A search takes no key, so
what it may store is bounded by network: one network adds at most 20 domains an hour (`DEMAND_PER_HOUR`)
and all networks together 1000 (`DEMAND_PER_HOUR_ALL`). Past either bound the search is still answered
and nothing is kept. A record stored before these rules that they would refuse is not listed and has no
wanted page; it is deleted with the rest after 90 days.

Each listed domain links to its **wanted page**, `GET /wanted/<domain>` (`registry/src/wanted.ts`): how
many networks asked for it in those 30 days, and the commands that teach it (`npx -y api-anything setup`,
then a prompt for the agent, or `npx -y api-anything learn '<page with {q}>' --args … --args2 … --args3 …`).
A demand domain is someone's search, so only a clean registrable domain (lowercase, on a public suffix,
no host, port or path: what a search records) still in demand gets a page; anything else is a 404, so no input creates
one. A domain fewer than 2 networks asked for (`WANTED_INDEX_NETWORKS`) is marked `noindex` and left out
of the sitemap: one network's search is too thin a page to list. Once a served site covers the domain,
its wanted page answers 301 to the site's page.

## Public stats and credit

`GET /v1/stats` (cached 60 s; `registry/src/stats.ts`) answers aggregate counts and nothing that tells
one install from another, no key and no network hash:

```json
{ "generated": "…",
  "installs": { "last7Days": 41, "last30Days": 120,
    "seen": { "total": 1204, "last30Days": 1180, "perDay": [{ "day": "2026-10-07", "new": 12 }, "…"] },
    "activated": { "total": 812, "last7Days": 64, "last30Days": 590,
      "ok": { "total": 701, "last7Days": 52, "last30Days": 511 } },
    "sharing": { "last30Days": 600 },
    "countedAt": "…" },
  "calls": { "last7Days": 2300, "ok": 2010, "okRate": 0.93 },
  "sites": { "live": 55, "operations": 140 },
  "community": { "sites": 6, "operations": 19, "uploadsLast30Days": 33 },
  "wanted": 18 }
```

- `installs`: `last7Days` and `last30Days` are distinct keys that reported, uploaded, claimed or reported
  an interface in the window. The rest is the install funnel, by key:
  - `seen`: keys in `keys`, all time, and the keys first seen on each of the last 30 UTC days, oldest
    first, today included. A key reaches `keys` when its install first uploads or reports, so an install
    with sharing off, or one that never called a registry op, is never seen: `seen` is a floor on working
    installs, not a count of downloads.
  - `activated`: keys with an accepted report of any outcome (`keys.reports`, which outlives the report
    rows a purged version takes with it); `ok`, keys that ever had an ok report accepted, which is the
    number of installs known to have made a call that worked. `ok.total` reads `keys.activated_at`, set
    once at the first accepted ok (a report, or a re-upload's confirmation) and never cleared: a report row
    keeps only the key's latest outcome on its version and goes with a purged version, so it cannot say
    whether a key was ever ok. The 7- and 30-day windows read when the key's latest report on each version
    arrived.
  - `sharing`: keys that uploaded a version or reported in the last 30 days.
  - `countedAt`: counting reads every key, and the stats are read far more often, so the funnel is kept in
    `snapshots` and recounted at most once an hour. The read that finds it stale claims the recount with
    one conditional write (a 5-minute lease); a read that loses serves the previous count meanwhile, or
    zeros with no `countedAt` before the first count is stored.
- `calls`: reports accepted in the last 7 UTC days, today included, from the `calls` table (a count per
  day and outcome; `reports` keeps only each install's latest outcome per version, so it cannot count
  calls). `okRate` is ok / (ok + fail + wrong), absent with none of those. The daily job deletes days
  older than 90.
- `sites`: sites with a live op, and their live ops. `community`: of those, the sites an install (not a
  maintainer's seed) first shared, and the live ops whose served version an install uploaded; and the
  versions installs uploaded in 30 days, any status.
- `wanted`: domains on the demand list.

The home page shows a strip from the same counts ("N installs active this week · M calls this week · A of
S installs seen made a call that worked · K sites taught by the community") when they could be read, and
leaves it out otherwise. `api-anything stats` on the client reads only the local call log and sends
nothing, so it does not show these. A site an install
first shared carries a "taught by an install" badge in the home list and on its page; a seeded site's
page says the maintainers seeded it, and either says how many of its ops came from installs. No key, and
nothing derived from one, is shown.

## Trying an op from the catalog

Everywhere else the catalog stores and counts, and every call runs on a user's machine. Trying the tool
then needs Node 22 and an install, so a visitor who only wants to see what an op answers cannot. `GET
/v1/try/:site/:op?<arg>=<value>…` (`registry/src/try.ts`) is the one exception: the Worker sends one
live read to the site and answers what the client's `call()` would, `{ok, class, data, truncated?, tier:
1, ms, reason?, retryAfterMs?}`, plus `"via": "catalog-try"`, `cached: true` when it came from the cache,
and a `next` with the install and the `api-anything call` command. With no args it runs the op's
published examples. Each allowlisted site's page has a "Run it here, no install" form per op, filled
with those examples, and the curl line; the page's one script sends the form to this endpoint and shows
the JSON (the CSP adds `connect-src 'self'` for it), and without the script the form opens the JSON.

It runs only when all of these hold, checked on every request:

- the site and op are in `TRY_OPS`, a list in the code: wikipedia `searchArticles` and `getSummary`,
  openlibrary `getWork` and `getAuthor`, usgs-earthquakes `recent` and `getEvent`, nasa-images `search`.
  Bundled public reads of harmless data, answered over plain HTTP by hosts that answer a datacenter's
  address (Hacker News answers the Worker with HTTP 419, so it is not listed). Anything else is a 404 with nothing read or sent;
- `TRY_ENABLED` is `true` (`registry/wrangler.jsonc` sets it; unset or any other value is off, a 503).

What runs is the op as reviewed in the repo: the Worker build imports those sites' `sites/<name>.json`,
and a try never reads the version the registry serves. Anyone can upload a version under an allowlisted
name and, with reports from a few networks, get it promoted, so running the served version would let
them point the catalog's request anywhere on the site's domain. The bundled op is checked once, when
the Worker first needs it, and left out if it fails: `readOnly`, a GET, `minTier` 1, not learned signed
in, no slot holding a `cookie:` or `session:` ref or a lookup's answer, no `public` names, its request
https to a public host (`badAddress`) on port 443 on the registrable domain of the site's `baseUrl`,
and the site passing `vetShared`.

Each op is pinned to its origin: the scheme, host and port of its bundled request. `TRY_OPS` can list
more origins for an op, each https on port 443 (none does today). The filled request and every redirect
hop must go to exactly one of those, so another host on the same domain, another port or plain http is
refused. Redirects are followed at most twice.

What it sends: the filled template with an empty cookie jar, so only the op's own literal headers and
its args. Nothing of the visitor's request (cookies, authorization, IP headers) goes on. The answer is
judged and extracted by the client's own `src/classify.ts` and `src/extract.ts`, HTML included
(node-html-parser bundles for Workers), and capped as a call's output is. A change to an allowlisted
op in `sites/` reaches tries with the next deploy.

The limits, each a Worker var to tighten without a code change:

| limit | default (var) |
|---|---|
| tries per network (IPv4 /24, IPv6 /32, hashed) a minute, a cached one included | 10 (`TRY_PER_MINUTE`) |
| tries per network a UTC day | 100 (`TRY_PER_DAY`) |
| requests sent to sites a UTC day, all networks, each redirect hop one | 5000 (`TRY_PER_DAY_ALL`) |
| time for the whole exchange, redirects and body included | 8 s (`TRY_TIMEOUT_MS`) |
| the site's answer, declared or streamed | 1 MB (`TRY_MAX_BYTES`) |
| an ok answer cached by its version and filled URL | 600 s (`TRY_CACHE_SECONDS`) |

Over a network's budget is a 429 with Retry-After; over the day's total a 503. The counters live in
`rates`. A try reports nothing and counts toward no promotion: it is the catalog's request, not an
install's. The requests come from Cloudflare's addresses, which is why the list holds only sites that
answer them, and why it is short: every op on it is a request the catalog makes in its own name. To
switch it off without a code change, set `TRY_ENABLED` to `false` among the Worker's variables in the
dashboard (takes effect at once; the next deploy restores `registry/wrangler.jsonc`'s value), or in that
file and deploy. To drop one op, remove it from `TRY_OPS`.

## Pages for search engines

A site page's title is "<name> API for AI agents: <its op names as words> | API Anything", with a
meta description, a canonical URL, OpenGraph and Twitter tags, and JSON-LD (`WebAPI` and
`BreadcrumbList`) in a `<script type="application/ld+json">`. That block is data, never run, so the CSP's
`script-src` hash does not apply to it; it is JSON with `<`, `>` and `&` written as `\u` escapes, so no
spec string can close the element. The sitemap lists the home page, each confirmed site's page and each
indexable wanted page.

A site page shows an `api-anything call` command to copy, with the first runnable read's examples, and a
try's `next` shows one with the args it was given. An example is its uploader's text and the visitor
pastes the line into whatever shell they have, where no quoting holds everywhere: `'...'` quotes nothing
in cmd.exe, and `'\''` ends a PowerShell string. So a value is spelled only when sh, cmd.exe and
PowerShell read it alike (`callArg` in `registry/src/pages.ts`): bare when `name=value` is letters,
digits and `_ . : / @ + = -`, in double quotes when it also holds a space or a comma, and otherwise as
the placeholder `name=<name>`.

## Sites' own interfaces

Some sites ship their own agent interface: an MCP server or an OpenAPI document. `api-anything interface
mcp|openapi <url>` reports one (`POST /v1/interfaces`, signed): https on a public host, keyed by its
registrable domain. Once installs on as many distinct networks as promote a version (`PROMOTE_KEYS`,
`PROMOTE_NETWORKS`) reported it, `GET /v1/sites/:name` and search list it as `interfaces` beside that
domain's operations. A domain search finds a domain that has only an interface, as a match with no
operations, and records no demand for it. A site already installed keeps its own operations in the
answer and gains its domain's interfaces. At most ten are served per domain, the best confirmed first;
the client drops any more, or any malformed one, never the match (a match left with no operations and no
interface is dropped).

An interface is what other installs reported, and nothing checks that it is the site's own: two keys on
two networks are enough to have one listed. So the client treats it as data. It keeps one only as an
address and nothing else (`interfaceAddress` in `src/registry.ts`): https on a public host, at most 300
characters, no query or fragment, a path of letters, digits and `. _ ~ / -`, rebuilt from its parts; the
`interface` command refuses to report any other. The registry holds a report to the same rule
(`interfaceAddress` in `registry/src/store.ts`): anything else is refused with 422, an address is stored
in that one spelling, and a row stored before the rule is served as that address or not at all. It is listed in `matches[].interfaces` and never
spelled into `next`, the field agents follow: for a match that has only interfaces, `next` names the
domain, points at that field and says nobody verified it. A plain address can still spell words in its
path, which is why the wording, not the shape check, is the rule. The agent shows the user the address;
nothing in the client calls an interface.

## Ops learned signed in

A login op's body can encode the person who learned it: an account id in a path, an intranet host, a
literal they typed. Asking every user before each such upload means almost none go up. So when sharing
is on, an op learned signed in that no rule refuses, that stays on its own site, and that shows nothing
personal in its `anonymous` form (no description, param descriptions, hints, examples or checks) is
**claimed** instead (`POST /v1/claims`, signed): the site's name and domain, the op's fingerprint
(sha256 of `fingerprintText`: the site, then the anonymous op without its name) and a hash of its name.
Nothing else leaves the machine.

Once installs on `CLAIM_KEYS` (3) distinct networks claimed the same fingerprint, the registry answers
each of them, on their next claim or `GET /v1/claims`, with the fingerprints it wants. An idle MCP server
asks at most every 6 hours. A holder then uploads the anonymous op with `claim` set; the site goes up by
its name, domain and address alone, and the evidence says only how the holdout call went and at which
tier: its args are the args of the check the anonymous form leaves out, so `holdout.args` goes empty. The registry accepts it only from an install that claimed that
fingerprint, only in anonymous form, only if it hashes to the fingerprint, and keeps the op's name only
if as many installs gave it that name. Each wanted fingerprint says so (`named`), and when it is false
the client sends the op as `op_<fingerprint>`: a name only its learner chose never leaves the machine,
not even for the registry to replace. A claim is answered under the name the site went up under. The client sends a body only for a
fingerprint it claimed itself and its op still hashes to: that k installs agree is the registry's claim,
and a registry that asks for anything else gets nothing.

Identical bytes from strangers on different networks cannot hold one person's own value, since a
personal literal differs per person and its fingerprint never converges. This settles privacy, not
safety. The version still goes to `review` ("learned while signed in"), with the number of installs that
hold it among its reasons, because a login op runs with every caller's credentials. The user can still
say yes and share it at once, as before.

## Verification by the crowd

**Health on the wire.** `GET /v1/sites/:name` (`ServedOp`) and `GET /v1/search` (`FoundOp`)
add an optional `registry` object: `{hash?, status, confirmations, successRate?, lastOkAt?}`.
These are the selected version's stored aggregates only. Existing top-level status, confirmations,
successRate and lastOkAt remain for older clients; search now also carries lastOkAt. The client shows
the top-level fields as the registry's evidence: a `registry` object that disagrees with them lends
nothing, not even its hash. No report keys,
network identifiers, args or data are served. Serving still reads versions, not reports, and runs no
new probes. Tier and ms exist on individual reports but have no stored dominant-tier or median-latency
aggregate, so neither is exposed. Absent successRate/lastOkAt are unknown, not zero or a seed's date;
pages say so explicitly. Clients show missing health as `"unknown"` under `registry`, keep local
verify evidence under `local`, and do not replace either with the other when merging installed ops.

A new version is a **candidate**. It is served to others while no live version of that op exists,
marked as such. It becomes **live** once installs other than its uploader report it ok:

| rule | value (env var on the worker) |
|---|---|
| distinct installs reporting ok, uploader excluded | `PROMOTE_KEYS` = 2 |
| of which distinct networks (ASN, else /24 or IPv6 /32, stored hashed) | `PROMOTE_NETWORKS` = 2 |
| a heal (below) | `PROMOTE_HEAL_KEYS` = 1 installs, still `PROMOTE_NETWORKS` networks |
| networks with a `wrong` report | each outweighs two oks; fresh keys on one network are one voice |

A version that claims `evidence.healedFrom` is a heal only when the version it names is of the same op
and either `degraded`, or live with a `fail` report from the uploader's own key in the last 7 days.
Otherwise anyone could name a live hash and take its op over with one friend. A heal never needs fewer
networks than a new op, so with the defaults it needs as many installs as one too. It needs fewer only
where `PROMOTE_KEYS` is set above `PROMOTE_NETWORKS`.

Promotion does not decide what is served. Of the live versions of an op, the **incumbent** (the one live
the longest) is served while it is not degraded, whatever the success rates and confirmations. A newer
live version, a heal included, is served only once the incumbent degrades. A few keys on two networks
can promote a version, but they cannot replace one callers already rely on.

Background verification makes the long tail move: an MCP server whose user said yes to sharing and to
verification (setup's second question, `verify` in settings) and is idle for a minute asks
`GET /v1/verify-jobs` for candidates and calls each with its published examples, plain HTTP only, no
cookies, at most 20 a day, and reports the outcome. The calls go from the user's machine and IP address,
only over https to a host under a public suffix that resolves to no private, loopback, link-local, CGNAT
or unique-local address, every redirect hop included. A job is a candidate that:

- this key neither uploaded nor reported;
- is served: no live version of its op name shadows it;
- runs at `minTier` 1, over plain HTTP;
- has published examples for every required param;
- installs on fewer than 3 networks reported anything but ok. The uploader's host decides what a check
  sees, so `fail`, `wrong`, `rate`, `blocked`, `auth` and `error` all count. The count is by network:
  fresh keys on one network are cheap, and three of them must not take a stranger's candidate off the list;
- belongs to a site that already has a live op, or has ok reports from installs on 2 distinct networks
  other than the uploader's and no `wrong` report from anyone. Those installs found it by themselves,
  through a domain search or a re-learn with the same hash. With the default thresholds such a candidate
  is usually promoted by those same reports, so in practice a new site's ops are checked by the installs
  that find it, not by background jobs. A `wrong` holds a version at candidate, and the uploader's own
  key may send one, so without the `wrong` rule its keys could keep a candidate of a site nobody vouched
  for on the list for as long as they liked. On a site with a live op a `wrong` is only one more network
  that did not confirm the candidate: there one key's `wrong` must not end the checks of someone else's
  repair.

Together these keep a stranger's fresh site from sending every verifying install to a host it watches,
which would harvest their IP addresses: its candidate somebody disputes is handed out to nobody, and any
other candidate reaches the installs of about three networks that fail to confirm it, or the few that do
and promote it. Reports arrive after jobs are handed out, so a few more installs than that can hold one
job at once.

Only public reads are promoted by reports. A version is `review`, served to its uploader only until a
maintainer sets its status (`POST /v1/admin/versions/:hash`), when it:

- was learned while signed in, or its clean replay was neither ok nor a bot wall;
- writes, or is a read sent with a method other than GET or HEAD. The one exception is a POST that
  carries only GraphQL query documents: a JSON body whose every item holds a `query` document with
  nothing beside it but `variables` and `operationName` and no key twice, sent as `application/json` or
  `application/graphql+json`, or a raw document sent as `application/graphql`. The body is read as its
  content type says a server reads it: under any other type (a form's, `text/plain`, none, a list of
  two) a JSON body is review, since a form parser finds its own `query=` inside one of its strings. So
  is an op with a slot at `header:content-type`, or with a `form:` slot, which writes pairs into a body
  that is no form. A persisted query names no document and could be a mutation. A field the rule
  does not know (`extensions`, an endpoint's own fields) could be the real request. A document a slot
  fills is whatever an arg or a param's default makes it, so a search API's `{"query":"{q}"}` is review too;
- has a slot with a `cookie:` or `session:` ref, as its whole value or as a hole in its template, its
  lookups' slots included: every caller's client would send its own credentials;
- has a derived slot: its lookup is sent with the caller's cookies, and what it answers (a CSRF token
  under any name) goes into the request;
- is a new op name on a site that lists `loginCookies` or has an op learned while signed in;
- is a new op name on an established site: some site on its domain has a seeded op, or a version that
  was ever live, whatever its status now. So degrading the only live op of a site the crowd made lifts
  no review, and neither does waiting for the daily job to archive it. Callers
  trust an established site, so a maintainer approves what it newly does (an x.com `follow`). The check
  is by domain, so a second name for the same domain gets around nothing. A new version of an op the
  site has a live or degraded version of is no new op. A name only review, blocked, archived or
  candidate versions hold is still new, on such a site and on one with a login, so uploading it twice
  gets around nothing either;
- on such a site, has a match (method, host, path, GraphQL operationName) other than the op's
  incumbent's, or sends another request than it under the same match. The incumbent is, of the op's live
  and degraded versions, the one live the longest. A real heal keeps its match, since the match is built
  only from the request's stable identity. The match is its uploader's word, so the request is compared
  too, read from the version itself (`requestSig` in `src/registry-api.ts`): its method, origin, path and
  GraphQL operationName. A path segment a slot fills counts as any value, whatever the stored URL holds
  there, so a param's default cannot move the request unseen; so does a name a slot can change. The match
  lends only its `*` segments (a hash that rotates). A version that turns linkedin `search` into a GET of
  `/psettings/close-account` is never served without a maintainer, whatever match it declares.
  The trigger is compared as well (`triggerSig`: its URL, steps, `softFrom`, confirms and companions in
  canonical form), since a tier-3 call and every heal open it whatever the request is: a version that
  keeps the request and opens `/psettings/close-account?confirm=1` in the caller's browser is review.
  A heal keeps its op's trigger, so it passes.
  Degrading the incumbent first changes nothing, since a degraded version still counts. The costs: a
  heal that changes the host, adds or drops a path slot or a trailing slash is review, so is a re-learn
  of the op from another page or with other steps, and so is a new version of an op whose only versions
  are candidates, until one of them is live;
- sends to or opens a host off its site (its readback's read included), or lists `public` names;
- holds something the export secret scan flags.

## Maintenance by the crowd

- Every call is a health check. A live version is **degraded** when, among the last 10 reports from
  distinct installs (`DEGRADE_WINDOW`), more than half are `fail` or `wrong`, at least 3 installs
  failed (`DEGRADE_MIN_FAILED`), those failures come from at least 3 distinct networks
  (`DEGRADE_MIN_NETWORKS`), and the failing networks outnumber the networks whose latest report on it in
  the last 7 days is ok. Fresh keys on one network are cheap, and a handful of VPSes cannot degrade an op
  with real traffic. Then the next best version is served. `auth`, `rate`, `blocked` and `input` say
  nothing about the op.
- The client already heals an op that drifted. A healed public op uploads automatically as a new
  version with `parent` and `evidence.healedFrom`. Its own failed call of the old version makes it a
  heal (above), so the client sends that `fail` report before the upload. A heal learns from a run made
  with the call's own args, so a healed request that still spells one of them (a copy in a header, a
  slug in another field) is not uploaded: the published request never says what its healer asked.
- Identical repairs from many installs hash the same: each upload of an existing version counts as
  its uploader's confirmation.
- A repair reaches everyone who pulled the site once it is live. A drifted call of an op in a pulled
  spec (one with the `shared` record, a heal's copy of it included) first asks the registry
  (`GET /v1/sites/:name`, at most 3 s) for the version it serves for that op now. A different version
  that is live, keeps the op's match, sends the same request (`requestSig`), keeps its trigger
  (`triggerSig`) and passes the shared rules
  is tried before any heal of the client's own, at the tier it asks for if the caller allows it: one
  request in place of a browser run. Only if it answers does it replace the op where this machine reads
  it (the rest of the spec untouched). The old version is reported `fail`, the new one `ok`, and nothing
  is uploaded, since the version is the registry's already. A spec the user learned themselves never
  takes another install's version, though its shared ops carry a version too: the `shared` record is
  what holds someone else's op to the shared rules (public addresses only, bound session values, the
  vet on every load), and that spec has none. Its drifted op heals by itself and shares the heal back.
- Versions of one op are grouped by its site and op name; each version also stores its match (method,
  host, path, GraphQL operationName). The match alone would merge distinct ops that share an endpoint
  (goodreads `getBook` and `getWorkId` both match `/book/show/*`). The best is served: live over
  candidate over degraded; of two live versions the incumbent; otherwise by success rate, then by
  confirmations.
- A write's proof is inside its version: its readback carries the read it runs, so the hash covers it,
  a maintainer's approval binds it, and a later version of that read changes nothing about it.
- Each version keeps its report counts beside it (installs confirming it, oks, failures, installs that
  reported it), so a search, a site or the index reads versions only, never reports. A report recounts
  its version and moves its status, except that a version `STATS_LIVE_UP_TO` (100) or more installs
  reported is recounted at most every `STATS_SECONDS` (60): a count reads all of its reports, and each
  report would otherwise cost as many reads as the version has installs. A report in between marks the
  version pending, and a job every minute recounts and re-judges what is pending, so degrading or
  promoting such a version waits a minute or two, never on another report coming. The daily job
  recounts every version, as reports age out of the last 30 days.
- A daily job archives a candidate or degraded version with no ok report in 30 days, and a degraded
  version older than a live version of the same op, which replaced it. It never archives a live
  version: a newer live one may be a takeover. A live version leaves live only by degrading. The job
  deletes versions archived over 30 days ago, with their reports.

## Trust

- A site's name is bound to its domain by its first upload; another domain under that name is refused.
- A new site's name must be exactly its registrable domain (`siteOf`) with dots turned into dashes:
  `crates-io` for crates.io, `lobste-rs` for lobste.rs, `git-xyz` for git.xyz. Otherwise the upload is
  refused with 422 and the reason. A name is unique by construction and cannot take another site's
  brand. A maintainer's seed is exempt (`goodreads`, `dominos-au`).
- An uploaded `displayName` is ignored: a site nobody seeded is titled by its domain.
- The server runs `vetShared` and the export secret scan on every upload, and refuses a spec over 256 KB.
  It checks the declared length first, then reads the body as a stream that stops at the cap. A request
  missing a signature header or with a stale timestamp is refused before any of its body is read.
- An upload is vetted alone, so a site is held to a pull's limits where it is put together to be served
  (`registry/src/catalog.ts`): at most 50 ops, and at most 256 KB as the client writes the spec. Live ops
  are kept first, then degraded ones, then candidates, the oldest first in each, so an op under a new
  name never pushes out one that was served before it. An op left out stays stored. A site none of
  whose ops fit is not served.
- A signature covers the method, the path with its query exactly as sent, the timestamp and the body's
  hash. A signature over the bare path does not cover a query.
- The `review` reasons above are never promoted by reports.
- Keys are cheap, so a key counts once per version and promotion needs distinct networks. Uploads and
  reports are rate-limited each hour per key and per network (an IPv4 /24 or an IPv6 /32: one
  subscriber holds a /48 or more). A report batch costs one per report and never less than one, so an
  empty batch, which still records its key, is not free. A key first seen less than an hour ago uploads at most 5 versions
  (`NEW_KEY_UPLOADS`). A circuit breaker caps uploads at 300 an hour across all keys
  (`UPLOADS_PER_HOUR_ALL`). Every limit answers 429 with Retry-After.
- Public reads (`/v1/search`, `/v1/sites/:name`, `/v1/index`, `/v1/demand`, `/v1/stats`, `/`,
  `/sites/:name`, `/wanted/:domain`, `/sitemap.xml`) are cached for 60 s at the edge, keyed by URL. A signed read skips the cache, since it may include the
  signer's own `review` versions. Cloudflare documents the Cache API as working for a Worker on a custom
  domain; nothing here relies on it caching on the `*.workers.dev` host. The limits hold without it, and
  the stats' install funnel is kept in `snapshots` anyway, since counting it reads every key.
- A maintainer can block a version or a site.

What these rules leave open:

- A lookalike domain is its own site. Whoever registers github-xyz.com can share `github-xyz-com`, and
  ok reports from installs on 2 networks promote it. Its title is only its domain, but its description
  is the uploader's own. Once it is live, that description ranks for words like any other site's
  ("amazon prices" finds amazon-deals.net next to amazon). No registry rule tells a lookalike from a
  real site. The defence is the agent's: every match carries `domain`, and the agent checks it against
  the site the user meant before calling.
- An op with no ok report from any network in the last 7 days (a seed nobody calls) can be degraded by
  failures from 3 networks. A version with the same match, the same request (method, origin, path,
  operationName) and the same trigger, promoted by 2 networks, is then served. A version with a
  different match, request or trigger still goes to review. What such a version can still change is
  what the comparison leaves out: the query string, the headers, the body under the same operationName,
  and the response recipe.
- An uploader whose site already has a live op (two keys on two networks) can upload version after
  version of another op there. Each is a background verification job until installs on three networks
  fail to confirm it, so each reaches the verifying installs of about three networks, within the upload
  limits. Its own `wrong` reports from two networks hold such a version at candidate through four more
  oks than promotion needs, so it can draw about six confirming installs before the version goes live
  and stops being a job.
- A site is established while the registry holds a version of it that was ever live. The daily job
  deletes a version 30 days after archiving it, so a crowd-made site whose every op died and was deleted
  is a new site again: its name stays bound to its domain, and nothing it had is served.
- The edge cache holds a public read for up to 60 s, so a maintainer's block takes up to a minute to
  disappear from search, site and index answers.
- An uploaded site `description` and op descriptions are the uploader's words, shown on its page and
  read by agents as data, never as instructions.

## What the registry stores

D1 tables: `sites` (name, domain, display fields, login cookie names, the site's `pace` budget,
notes, first uploader; the first upload or a seed sets them, and `GET /v1/sites/:name` serves them
with the ops, `pace` held to the shared rules' bounds on the way in and again on pull), `versions` (hash, site,
op name, match signature, operation JSON, parent, status, uploader and its network hash, evidence,
timestamps including when it first went live, its report counts), `reports`
(hash, key, network hash, outcome, tier, at), `keys` (public key, first seen, counts, first accepted ok), `rates` (hourly
counters, kept for a day), `claims` (fingerprint, site, key, network hash, name hash, at), `demand`
(registrable domain, network hash, at; deleted after 90 days), `interfaces` and `interface_reports`
(url, domain, kind; key, network hash, at), `calls` (UTC day, outcome, count; deleted after 90 days),
`snapshots` (the public stats' install funnel as last counted: counts only). No args, no response data,
no IP addresses. A try (`/v1/try`) stores only its counters in `rates`; the cache holds its answer for 10
minutes.

About the caller, the registry keeps its reports, keyed by install key and time, and nothing else:
no account, no IP address (a network is a salted hash, used to count distinct networks and for rate
limits), no search words. Workers observability logs are off (`registry/wrangler.jsonc`), so request
URLs, and the queries in them, are not stored.
