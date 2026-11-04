# api-anything — design v1

Evidence behind every decision: [research/prior-art.md](research/prior-art.md),
[research/prototype-reuse.md](research/prototype-reuse.md),
[research/live-probes.md](research/live-probes.md).

## Goal

Turn a website whose only interface is a GUI into operations an agent can call directly
(`x.getUser`, `google-flights.search`), fast and token-cheap, and keep them working when the
site changes, without a human.

## Core idea: one mechanism for create, heal, and fallback

Each operation stores, besides its request template:

- **trigger**: how to make the site's own frontend fire the request. It is a URL template
  (`https://x.com/{screen_name}`), optionally with UI steps or a soft navigation from a neutral page.
- **match**: how to recognize that request in captured traffic, using stable identity only:
  method, host, path with hash-like segments and the segments a param or a ref fills wildcarded, and GraphQL operationName.
  **Never a queryId/doc_id/hash**; putting those in the matcher is what makes rotation unhealable
  (as happened to unbrowse).

One routine, *capture → match → learn*, does three jobs:

1. **Create**: run the trigger with example args, capture, pick the matching request, learn the template.
2. **Heal**: on classified drift, run the trigger with the current args, capture, re-learn,
   validate, save, and retry. A moved parameter can heal, but a change to its established encoding
   requires re-adding the operation to confirm its meaning. No site-specific code.
3. **Fallback**: for reads, the triggered browser run already produced the response. If
   the template can't be replayed (per-request signatures), return that captured response.

Healing is **reactive only**. Always send the stored template first. Never make a
heal/resolve step mandatory before a request (api-anything's X capsule died this way while its
baked queryId still worked).

## Request template = captured request + slots

Store the captured request **verbatim** (method, url, headers, body string) plus a list of
**slots**. A slot says where a value goes, as a path through *decoded layers*:

```jsonc
{ "param": "screen_name", "at": ["query:variables", "json:/screen_name"] }
{ "param": "origin",      "at": ["form:f.req", "json:/1", "json:/0/1/0/0"] }  // JSON inside a JSON string
{ "param": "query",       "at": ["query:q"], "template": "from:{query} lang:en" } // substring of a leaf
{ "ref": "cookie:ct0",    "at": ["header:x-csrf-token"] }
{ "ref": "cookie:JSESSIONID", "transform": "strip-quotes", "at": ["header:csrf-token"] }
{ "ref": "session:x-goog-batchexecute-bgr", "at": ["header:x-goog-batchexecute-bgr"] }
{ "gen": "uuid",          "at": ["header:idempotency-key"] }  // a value the page makes per request
{ "from": { "request": { "method": "GET", "url": "https://shop.example/api/resolve?slug=blue-mug" },
            "slots": [{ "param": "slug", "at": ["query:slug"] }] },
  "path": "product.id",   "at": ["path:2"] }                  // a value an earlier request looks up
```

A `gen` slot holds what the page makes for each request (an idempotency key from
`crypto.randomUUID()`, an `x-request-id`): no value is stored, and each call fills a new UUID v4,
drawn from a seed the call holds, so its own retries (a 401 re-sent once) carry the same one. A write's seed is its
ledger record's (see Writes): with the caller's `idempotencyKey` it is an HMAC of that key, so
every call with the key sends the same value and the site dedupes the caller's repeats too.
Learning makes one only from two runs (step 3 below); a recapture has one run, so it keeps the op's
gen slots where the page still sends a UUID, and a ref it put there gives way.

A *derived* slot (`from` and `path`) holds a value the page looked up with an earlier request of the
same page load: a product page at `/p/{slug}` asks `/api/resolve?slug=` for the product's id, then
loads `/api/products/{id}`; a crate's download needs the crate's `default_version`. `from` is that
lookup's own template: a request plus slots that are params of the op (by name) or `cookie:` refs,
never a `session:` value, a `gen` or a lookup of its own. `path` is where its JSON answer holds the
value (getPath's form, one value: `crate.default_version`, `items[0].id`). The leaf keeps the value it had
in the capture (the example's), as a param's place does; the slot fills a whole leaf, with no template.
A call sends each distinct lookup first, at the same tier and with the same session as the op's own request,
reads the path, sets the leaf, then sends the op's request (below, Execution ladder). A lookup is always a
GET on the op's own host: a read, sent again on every try. A param may live only in the lookup (the slug
above): the op's own request carries it nowhere the server reads (an echo such as the Referer still
follows it), and its value reaches the request only as the id it looked up. `export` strips the leaf's
example value as it strips a param's (a JSON number becomes `0`, a path segment `0`) and the lookup's
own example values with it.

Step kinds: `path:<i>` (URL path segment), `query:<key>`, `header:<name>`, `form:<key>`,
`json:<RFC6901 pointer>` (the current string is parsed as JSON), `b64` (the current string is
base64 of JSON), `body` (the whole body). A repeated key's later occurrences are `query[1]:<key>`,
`form[1]:<key>`, and so on. A JSON object has no such form: a pointer reaches a key's first occurrence
only. The walk reads every occurrence, so learning knows what any of them would be, and refuses the request
where a repeated key is, or holds, a param, a session reference or a volatile anchor in any occurrence
(`{"token":A,"token":B}`): the later value could be neither blanked nor filled. A repeated key that is none of
those is a constant and is sent as captured, byte for byte (`{"limit":1,"limit":2}`). Header names are lower-cased when a spec is parsed.
Filling decodes only the layers a slot touches, sets the value, and re-encodes only those layers.
Untouched bytes stay identical, so RestLi parens, key order and the exact encoding survive.
No `{x}` string interpolation over raw captured text. In a slot `template`, `{{` and `}}` are
literal braces, so a leaf's own text (a minified GraphQL `{name}` selection) survives filling.
A templated slot records how the value is escaped inside its leaf: `escape: "url"` when the leaf
is a URL (a `next=/search?q=...` param, a twice-encoded state, found percent-encoded), so the arg is
percent-encoded; `escape: "json"` inside a JSON string literal (inline GraphQL `search(q: "{q}")`).
Referer and Origin templates are always URL-escaped. No header value is ever sent as non-ASCII.
A body labeled form-urlencoded that is really JSON (Algolia's client does this to skip the CORS
preflight) is walked as `body > json:`.

A JSON leaf replaced by a param keeps the arg's native type, except that a leaf that was a JSON
string stays a string (`"id":"123"` next to `ids:[123]`). Params default to type `string`.
A param may declare `pattern` (a regex the whole value must match) and `hint` (what a valid value
is, "a date as YYYY-MM-DD"): an arg that fails it is `input`, named with the hint, and nothing is sent.
A numeric string whose exact value is past the largest safe integer (2^53 − 1) is never rounded: plain digits are sent exactly, and any other form (an
exponent, a decimal point: `9007199254740993e0`) is `input`, saying so, with nothing sent. `"false"` is false.

## Learning (`learn.ts`)

Input: the captured exchanges plus one or two example arg sets. Output: an Operation.

1. **Pick the request.** Use the `match` if given (then nothing in the pool counts as noise). Otherwise
   take the candidates that carry the example values (searched at every decoded layer) and return
   JSON-ish data, drop noise (subresource assets, analytics, beacons; a document or XHR whose path ends
   in `.js` is not an asset), and rank them. A data-less answer (empty 2xx, `{"success":true}`, `OK`)
   ranks below every real answer: a read's answer is data. With a response recipe (`--html`, `--embedded`,
   `--extract`), a candidate the recipe resolves on wins over a beacon that echoes the page URL. The
   agent confirms which one when it's ambiguous. A read picked this way whose answer is data-less
   and does not carry an example value is refused (an analytics beacon's ack whose echo of the page
   went unrecognized), with a hint to `--pick-request` the data request or learn the document with
   `--html`/`--embedded`; a request picked by id or pinned by `match` is the agent's call.
   A request that carries no example value but holds one an earlier request that carries them looked up
   (step 3, *derived values*) is a candidate only where nothing else fits: with a recipe that resolves on no
   carrying candidate, the best-ranked such request the recipe resolves on; for a write whose run
   intercepted none that carries the values, the intercepted such request. When a param has no place and a
   leaf looks looked up but is not proven (one run, or a lookup that needs more than a template), the
   error says so, naming the leaf, the path and the request, instead of only a missing place; `learn_site`
   answers so (with that request first among the alternatives) when no request of run 1 carries the
   example values in an answer that could be read.
2. **Decode and substitute.** Walk every decoded layer of URL path, query, form, and JSON (including JSON
   inside strings, base64 JSON, and every occurrence of a repeated key). A leaf equal to an example
   value → a slot. A string leaf containing it (or its percent-encoded form) → a slot with a
   `template`; digits must not touch other digits, and number, flag and null leaves are never partial.
   A leaf equal to one param's value belongs to that param even if another's value is inside it, and
   several params in one leaf are replaced longest first. Headers the browser computes (user-agent,
   accept*, content-type, sec-*) are never slots. A `true`/`false`/`null` example binds only to the
   leaf named like the param, even when it is the only such flag. An array or object example binds to the equal JSON container. Example
   values must be distinct and at least 3 chars: a shorter one found by substring in one capture is ambiguous.
   A shorter value (`US`, `page=2`, a small enum) is accepted only with a second example that differs, and its
   run. A param with a short value in either example (`USA`, then `US`) is then placed only where a whole decoded leaf equals its value in run 1 and equals the other example at the
   same place in run 2, never inside a longer leaf; a leaf that equals it and does not follow (`gl=US` on every
   request, `size: 2` beside `page: 2`) is no slot. The same both-runs match says which request carries it, endpoint by endpoint:
   run 2's evidence counts for the request with the same method, host and path (a path segment may differ the way the
   examples do), so another endpoint's `country=CA` does not vouch for a feed that always asks for `US`.
   Without that evidence the example is refused, with a hint to pass a second one. A known limit: two leaves that both
   follow the examples (`{"page":1,"counter":1}`, then `{"page":2,"counter":2}`) both become slots for the param, with
   the warning below; two runs cannot tell them apart. If a value appears in several unrelated places,
   record all of them but warn. (Google Flights reuses the destination as the return-leg origin.)
   A short example (4 chars or fewer, "SFO") inside a random-looking leaf counts only where it
   stands alone between non-alphanumerics: inside a base64 blob it is chance.
   Referer, Origin, Cookie and any other echo of the page's location follow the args, but they are
   not evidence: an example value found nowhere else in the chosen request is an error, since the
   param would change nothing the server reads and every call would silently return the example's
   data. An echo is found structurally from the capture's page URLs (its documents, every Referer,
   the filled trigger, and every location the page's main frame had, history API changes and the
   final URL included, since an SPA's pushState URL is in no document and a cross-origin Referer
   is origin-only): a leaf holding the page's href or origin anywhere, or starting with its path
   or search string, at any percent-encoding depth (analytics `context.page.url`, `x-page-path`,
   `src=`/`redirect=` params). A request whose only hits are echoes (a Segment-style beacon) is no
   candidate. A request the agent picked by id (`--pick-request`) is exempt: its echo-shaped leaf
   is evidence (a route resolver posting `{path:"/facebook/react"}`). `--match` is not, since heals
   pass it too. An example found raw in a URL leaf is filled percent-encoded, unless encoding would
   change it (the slash in `/facebook/react`): then the leaf evidently holds it raw.
3. **Two-run diff** (create with two example sets, recommended). A position that changes with the args is a
   param. A position that changes although the args did not (including the text around the arg in a
   templated leaf, such as a signed URL; browser-computed headers never count) is a nonce/signature, so the op gets `minTier: 3`,
   unless one tier-1 replay of run 1's template with example 2's args still answers ok: then the value is
   session-scoped (Google's `f.sid`), not a signature, and `minTier` stays 1. A whole leaf that is a UUID in
   both runs, a different one in each, and in neither run held by a cookie, storage, or anything loaded before
   the request (an address, an answer's body or headers) is one the page made for the request: a `gen` slot,
   not a nonce, whatever its name. A session ref step 4 gave it by its name (`Idempotency-Key` reads as a
   credential) gives way, and its value is not stored: kept, run 1's key would go with every call, and a site
   that dedupes by it answers a new order with the old one. A UUID the site handed out is the site's, and stays a
   ref. A key in another shape stays as before. Everything else is a constant.
   That includes a place step 2 gave a param which stays as it was although the param changed (the endpoint's own
   segment in `/api/search?q=search`, when example 2 is `q=kitten`): run 2 disproves it, so it is no slot, and learning
   runs again without it, which makes the leaf a constant to every step (the match names the segment, a credential in
   it is found). A param left with no place is an error, not a warning. This covers params whose example is a
   string, number or flag. An object or array param is outside it: its places are not checked against run 2, so a
   copy of it elsewhere in the request that did not follow stays a slot, and the leaves inside it, which change with
   the example, are read as nonces (`minTier: 3`). Run 2's request is chosen on the evidence
   run 1's was: what the response recipe reads, when there is one, and for a read an answer that is data: a captured 2xx,
   not a bare acknowledgement, an error, or a request nobody answered (unless run 1's own answer, pinned by the caller, is no data either). Among the requests that pass, the one on run 1's own path that carries the args comes first (the
   wildcard a false path param puts in the match fits sibling endpoints too). When none passes, run 2 disproves nothing.
   The diff proves an arg reaches the request, not that the server reads it there. So `add` then judges run 2's
   answer with the op's recipe: when a read's example 2 gave a param another value and its data equals run 1's,
   and is not empty, the server may go by a cookie, the IP or the page instead. The op is saved with a warning
   and marked `unproven: {params, reason}` (the params whose values differed). It can be a false alarm: two
   places with the same stores answer alike. The warning asks for an example 2 that excludes something example
   1 returned; `publish` refuses the op while the mark stands, and `verify` clears it (below). Two answers that
   differ because another param changed hide an ignored one (pkg.go.dev pages by `limit`, so `q=websocket, page=1`
   against `q=yaml, page=2` differ while `page` is ignored): when a read's example 2 changed more than one param, and
   the op is tier 1, `add` sends one tier-1 read per changed param, example 1's args with only that param's value
   from example 2, at the site's pace, and marks `unproven` the params whose read answered example 1's data again
   (the reason names them). A read that did not answer ok proves nothing and marks nothing. A write is never sent to
   learn it: the check is for reads. Two answers that differ for another reason (a timestamp, a shuffled order) still
   hide an ignored param: the check finds a copy, no more.

   *Derived values* come out of the same two runs, before the params are placed (step 2), so a param
   the chosen request does not carry is no error when its lookup does. A whole leaf of the chosen request
   (the URL path, the query, a form or a JSON body; never a header, which is where credentials go) is
   derived when all of this holds: it holds no example value and no cookie or stored value; an earlier
   GET of run 1 on the same host, which carries an example value and answered 2xx JSON, holds it at a
   JSON path (the shortest such path, the latest such request); in run 2, the request at the same
   method, host and path shape that carries example 2's values holds another value at that same path;
   and run 2's counterpart of the chosen request holds that other value in the same leaf. The lookup's
   own template is learned from its exchange like any read, with the examples of the params it carries:
   when that template needs a `session:` value, a `gen` slot or a nonce (`minTier` above 1), the leaf is
   no derived slot and is treated as before (a nonce, a counter, or the param's missing place).
   A derived leaf is no nonce, no volatile anchor and no session ref; its path segment is a wildcard in
   the match. One run (a recapture) keeps a derived slot only where the op had one, from an earlier GET
   of the run that carries the args and holds the leaf's value. A leaf derived from something else (a
   page's HTML, a value the page computes) is not found: the request needs tier 3, or its own op.
4. **Session references.** A header, query or JSON leaf whose value equals a cookie value (raw,
   quote-stripped, or URL-decoded; ≥ 8 chars) becomes a `cookie:` ref. Capture also snapshots the
   final page origin's localStorage and sessionStorage; a leaf equal to a stored value (or to a
   string inside a JSON entry, as auth SDKs keep tokens; ≥ 8 chars) becomes a `session:` ref named
   after the storage key and the JSON keys under it. A ref's name reaches the spec, so each `/`-separated
   part of one that holds a live value itself (a key scoped by the org id a cookie carries) becomes a short
   hash of that part, and a value spread over two parts hashes the name whole. The hash keeps an exact copy of
   the value out of the spec and does no more than that: it is not anonymity, since a low-entropy id (an
   incrementing one, a known org) is recovered by hashing a guess. The hash is of the key alone, so a recapture
   of the same page names the same ref while the live values the name was checked against are unchanged; a part
   that holds none stays as the page wrote it. Those values rotate, so the same key can become hashed, or stop
   being hashed, in a later learn or heal; a stored spec keeps the names it has, because a refresh reads each
   value at its slot's position and stores it under that slot's own ref name. A ref's per-position
   collision suffix is checked the same way. The leaf's own name changes none of this: under a persisted-query key (`sha256Hash`,
   `doc_id`, `queryId`, `hash`) a cookie or stored value is a ref as anywhere else, whole or inside the leaf, since a
   token the page stores and sends as `queryId` reads exactly like a query id it caches there. So a query id the app
   keeps in storage is a `session:` ref too; only one that is in no cookie and no storage stays a volatile anchor. A key or header named like a credential (its words: token, secret, key,
   auth, sess(ion), sid, signature, password, credential; "author" is not) with a random-looking
   value (≥ 16 chars, two character classes, ≥ 3 bits/char) is a `session:` ref too, unless the site
   ships that value in a static bundle to every visitor (a public API key): then it stays
   literal and is listed in `public`. A static bundle is a GET script that shared caches may keep
   (not `private`/`no-store`), fetched without the user's cookies or marked `public`/`immutable`;
   a per-user script sent with the session cookie proves nothing. A random value (≥ 16 chars, as
   above) that an earlier response of the same capture holds (a bootstrap JSON, a per-user config
   script, a token in the document; not a static bundle) is server-issued: a `session:` ref named
   after its leaf, whatever the name. This rule leaves hash-like path segments and persisted-query keys
   alone: issued, but in no cookie and no storage, they stay volatile anchors. Like every `session:` ref it is refreshed by each trigger run; when it
   expires, tier 1 answers `auth` or a bare 403, and the ladder's tier-3 run (below) re-derives it
   and answers the call, so it needs no `minTier` of its own. Auth/anti-bot-looking
   headers (authorization, x-*-token, x-csrf*, x-goog-batchexecute-bgr, x-client-transaction-id)
   become `session:` refs, whose values live in the session store and are refreshed by every capture. So do
   per-session fields in forms, queries and JSON bodies (`at`, `fb_dtsg`, `lsd`,
   `authenticity_token`, `csrf*`, `access_token`, `token`, `session_id`), and a header repeating one of
   them (Meta's `x-fb-lsd`) shares its ref. A cookie or stored value (≥ 16 chars) inside a longer
   leaf (`v1:<cookie>`, percent-encoded in a `next=` URL, JSON-escaped) is a templated ref that
   re-encodes it the same way; in a leaf that also holds an arg (`next=/search?q={q}&auth=<cookie>`)
   it is a `{cookie:x}` hole in the param's template, filled at call time. A hole is filled with the value as
   stored; only a ref slot's own value takes a `transform`. So a cookie that could only be a hole and sits
   there unquoted or URL-decoded has no safe form, and learning refuses the request rather than keep its text. When that slot has no
   escape of its own and the value sits there percent- or JSON-encoded, the slot takes that escape. The text then left
   around the holes of a param's leaf may be a credential beside the arg. Under a per-session field or header name
   (`token`, `x-csrf-token`) it is one from 8 characters on, as a whole leaf there is (`token=kittens.<token>`). Under any
   other name, one that only reads like a credential's included (`cache_key`, `api_key`), it is one only when a piece of
   it, without the separators next to the hole, is a token and nothing else: one unbroken run of 16 or more characters
   of the hex or URL-safe base64 alphabet that is random-looking (`api_key=<token>:kittens`). Text with separators inside
   it is structure and stays (`cache_key=query:{q}:page:1:sort:relevance`, a path), and so are words and numbers joined
   by `-` or `_` (a slug). A credential there refuses the request. It is not made a hole, because no later capture
   could tell where the arg ends and the credential begins (`red.fox.<token>`), and a refresh would store the wrong
   text. The rule goes by shape, so it also refuses a public id or hash that stands alone beside the arg
   (`/<docId>/kittens`, `rev=kittens@<hash>`); the caller can mark the name public when the text is the same for every
   visitor. A capture refreshes a
   templated `session:` value from its place in the leaf. A `session:` value the page later sends empty is not
   refreshed: the stored one is kept. Slots never overlap, and a container that is a
   session value is never serialized in part. A container is a string that holds JSON, as it is or in base64. One that
   is a session value as a whole (a header named like a credential, a value equal to a cookie, a value the page also
   keeps in storage under any key) is one ref: blank in the spec and sent whole from the session at call time, so no
   key, no short leaf and no encoding of its text reaches the spec. The refs found inside it are dropped. A param
   inside it could not be filled on replay, so the learn is refused: the error names the container and the param.
   Where the container is one only by its header's name (it is in no cookie and no storage), the way on is to mark
   it public (`--public x-csrf-token`) when the rest of it is the same for every visitor: it then stays as captured,
   with the param inside it filled and any cookie or stored value inside it still a ref. Otherwise learn another
   request. A container that is a cookie or a stored value as a whole (a body the page saved) has only that second
   way: it is a ref under a public name too, and the error does not offer the mark. Only a header is a session value by its name alone: a
   container under a credential-like field name is judged leaf by leaf. A stored value counts as a credential under a credential's name or when it is random-looking, in any
   entry that holds it and whatever the entries' order; a stored JSON text by its key, and each string in it on its
   own. A stored setting sent under a credential's name in the request (`token=<it>`) counts too. Newly learned session references are scoped by operation, with distinct request positions
   for different tokens that share a name: one name never means two values, wherever the second was
   found (a storage entry called `token` inside `v1:<value>`, next to a `token` field holding another). All discovered credentials participate in compound-copy
   removal. Learning ends with one check behind all of these rules: the save-time secret scan, run over the stored
   request, the slot templates and the slots' ref names, so a name that still carries a live value fails the learn
   rather than first the save. It looks for credentials, not for everything live: every cookie (the jar's and
   the request's own Cookie header); the `session:` values that are credentials (found by name or as issued, stored as
   one, or sent under a credential's name), those of refs dropped from inside a container sent whole included; and
   the stored values that are credentials, whether or not anything made them refs. A cookie or stored value that is
   the origin of a URL the operation sends to or opens (its request's, its trigger's or `softFrom`'s), raw, quoted
   or percent-encoded, is no live value at all: not to learning's passes and this check, not to the add and heal
   save-time scans, and not to export, which adds the spec's `baseUrl`. The spec spells those bytes as its host, so
   a copy anywhere carries nothing new, and an analytics cookie keeping the last page (`https://www.x.test/`) would
   otherwise refuse every learn on the site. Each saved operation's origins are recorded in the session file
   (`origins`, never dropped), and a learn's own count for what the write storing its values stores (not for what
   the file held: a refused save must not take a protection apart), so no session write records a setting as a
   credential for holding one or being held by one. Any other
   URL is a value like any other: another host's or port's origin, or one with user info, a path, a query or a
   fragment. One exception, in this check only: a
   stored value that is a credential by its storage key's name alone (`token: "solarized-dark"`), neither random-looking
   nor shaped like a token (a JWT, a bearer, a long hex or base64 blob), does not refuse the learn, since the check
   fires only for a copy that could not be a ref and the text is then kept as captured; where it can be a ref it still
   is one. That lets through a short token (under 16 characters) kept under such a key and copied where no pass
   reaches it. A stored setting
   (a theme, a locale) is not looked for, also when a leaf that equals it made it a ref: a ref keeps a value fresh,
   it does not make it secret. A copy no rule could turn into a ref (too short to template, base64, percent-encoded
   twice) fails the learn, closed, and the error names the leaf that holds it. No name exempts a leaf, one marked
   public included; exempt is only the caller's own example, for stored values. Add, heal and export
   run the scan again, against the site's cookies and the session values that are credentials, and refuse to save
   or share any spec that still contains one. Which values those are is learning's own classification, not a guess
   at save time: a learn records what each name it stored holds (`kinds` in the session file) and a setting is not
   looked for. A setting is a stored value related to no credential that learn saw, which is more than it stores (a
   cookie the request sent, a storage entry no leaf repeated): by save time those texts are gone, so the four tests
   below are asked at classification time too, against all of them. Related through another value the learn saw
   counts as related: a live value that is no JSON container is entered as a setting of its own, so the chain
   reaches the stored name even where no single step holds both of its ends. A container is no such link -- a
   credential and a leaf beside it inside one are siblings, not copies of each other. A credential classification is never undone by a
   later learn, and a name no learn classified, one a session file written before the field or a refused add left
   behind, is scanned like a credential until one does.
   So is a setting whose value changed outside a learn: a refresh (a trigger run, a recapture) rereads each value at
   its slot's position without classifying it, and the page can put anything there. A recorded setting is left out of the scan only when
   all four hold: it is no JSON container (a container carries credentials whose own refs were dropped for it, and
   a refresh can put a new one in); its own text is not random-looking and not shaped like a token (a JWT, a
   bearer, a long hex or base64 blob); nothing protected holds it, in any encoding the scan reads (a theme also
   sent as the bearer is a copy of that bearer); and it holds nothing protected itself. Protected is every cookie
   and every session value that is not itself a candidate to be left out: a credential classification of the same
   bytes wins, here and in what a learn records. A setting that loses its exemption is protected in turn, and the last two tests are asked again
   against it until nothing more is protected: the scan reads a few decoding layers, so a chain of settings would
   otherwise carry a credential further than any one of them can. No cookie is ever a setting. What protects a
   setting is a relationship between live values, which a later write can take apart, so it is not left to be
   recomputed: every write of the session file records as a credential each setting this scan keeps, in what was
   stored and in what is being stored, and a credential is sticky. A write hands back what it recorded, and the add
   that asked for it scans the op it is saving with that: the kinds it passed in are the ones the write just overruled. What was stored is asked with every name this write
   calls a setting that it left unclassified read as one, so a classification never forgets a relationship the stored
   session held. Rotating the value that protects one -- a new bearer, a re-imported cookie -- therefore cannot
   unprotect it. A setting whose own value that write replaces is left alone: the text that was protected is no
   longer under that name.
   What the scan finds is a copy of a value it is given, 6 characters or longer, as it is or unquoted or URL-decoded:
   in the text; in what the text decodes to, through up to three layers of percent-encoding, JSON escapes and base64
   runs of 16 characters or more decoded whole; and as the value's own base64 encoding at any byte offset, in the
   standard and the URL-safe alphabet (a six-character value's eight characters, an encoding that follows other text).
   That last search only says where to look: the text there is decoded at that offset and must hold the value's bytes,
   so a match is always a copy of the value, never another one that encodes alike (`xqbcdef` beside `abcdef`).
   It does not prove a spec holds no credential. These can still reach one: a cookie or value under
   6 characters; a credential that is a number (a number leaf is never a ref, and digits alone are not random-looking, so
   one is caught only as a copy of a known value); a credential split across two leaves; a copy behind more encoding
   than that (four layers, base64 twice after other text, hex); a cookie that only the second run's request carried and the jar does not hold; a value under a
   credential's name that is too plain for the name's rule (under 8 characters for a per-session name, not random-looking
   for a credential-like one); beside a param under a name that is not per-session, a token with separators in it or
   around it in the same piece (a JWT's dots, standard base64's `+` and `/`, `auth=<token>` after other text) or under
   16 characters; and a credential no rule recognizes (not a cookie, not stored, not named like one, not issued by an
   earlier answer). Export scans a
   spec again, by name and by shape, before it is shared. At call time a `cookie:` ref takes the
   cookie sent to the request URL, else one of the same registrable domain (by the Public Suffix
   List, private section included: co.uk, github.io and run.app are suffixes) that is not HttpOnly,
   never another site's. A `session:` ref takes its value only for a request to the host the value
   was captured from (see Sharing specs).
   The same `siteOf` scopes Set-Cookie domains, the profile's exported cookies and browser import. A header or field name a human marks public
   (`add --public authorization` for a web app's shared bearer) is listed by the op in `public`
   and keeps literal what these rules would take by that name: a header by its name (`authorization`, `x-csrf-token`),
   a credential-like name over a random-looking value (`api_key`), a value an earlier answer issued, the text beside
   a param. It exempts nothing else. A per-session field (`token`, `csrf`, `at`: the list above) is a ref under a
   public name too. A public leaf that equals or embeds a cookie or a stored value becomes its ref as anywhere else,
   whatever the stored value looks like: a name or entropy rule that does not fire is no proof a stored value is
   safe to keep. One that holds a cookie or a stored credential in a form no rule can make a ref (too short, base64)
   fails the final check. The save-time scan (`heal.ts`) and export still waive a public header whole, and no other public name.
   Learning runs first on every add and recapture, so a public header reaches them holding no cookie and no stored
   credential the scan can find; a public query or body field that holds a session value another operation of the site stored
   learns, and `add` then refuses to save it where that value is one of the site's credentials. Where the other operation
   recorded it as a setting, the save goes through: the field keeps it as captured, and this operation's own leaf that
   equals it is a ref as ever.
5. **Volatile anchors.** A hash-like literal (queryId path segment, doc_id, persisted hash) gets a
   `volatile` entry recording its shape (charset + length) and a stable **anchor** string next to it
   (the GraphQL operationName or the neighboring path segment). This is what the cheap heal uses.
6. **Headers.** Keep captured per-op headers verbatim (including sec-fetch-*, origin, referer,
   user-agent) minus `:pseudo`, host, content-length, connection, cookie, conditional headers
   (`if-none-match` and co., which would turn every replay into a 304), and content-encoding (a
   gzip-compressed request body is captured and stored decoded). Never promote headers to
   site-global: a globally promoted x-twitter-auth-type broke every X guest read. At call time a
   filled header whose value holds a line break or a NUL is not sent: the call fails naming the
   header, never the value (fetch's own error would quote a session's token into the result).
7. Record `learnedLoggedIn` (whether the session had auth cookies, not counting the names a signed-out
   visit is given: "Guest cookies" under Logging in). If an op learned signed in comes back without its
   data and the jar has no login cookie, the call is `auth`, not drift; a write learned signed in is
   not sent at all while the jar has none ("Before a write" under Logging in).
8. **Response.** Store the content type, the XSSI prefix to strip (`)]}'`), a suggested `extract` path (the
   richest array/object carrying the example value), and an inferred **shape** (key paths + types)
   for drift detection. The agent may set `pick` (fields per item) for token efficiency.
9. **Judge the answer, then save.** `add` judges the op on the answer it was learned from. One that
   is `blocked`, `auth`, `rate` or a server failure (what a heal counts as having learned nothing) is
   not saved: the request answered was a wall's, so the error says to log in or wait, then add again.
   Any other failure saves with a warning that says which recipe flag to fix.
10. **Allowed values.** A param may carry what no capture tells: `pattern` and `hint`, `enum` (the
   site's whole set of values, never only the example's) and `min`/`max` (bounds on the value read as
   a number). `add --enum name=a,b --min name=n --max name=n` sets the last three, and editing the spec
   sets any of them. A call whose arg fails one is `input` before anything is sent, and the examples
   must fit them at add. An op learned again keeps them, and the param's description, for params of
   the same name, and keeps its `checks` whose args are all still params. It also keeps its `paging`
   (Response extraction), which `add --paging` sets, and a write keeps its `readback` (Writes), as
   long as the shared rules still pass for them.
11. **Paging found in a capture** (`paging.ts`). A capture whose steps clicked "Show more" holds
   two requests for one list. `pagingHints` pairs a request with the latest earlier one to the same
   method, origin and path depth that it differs from in exactly one place (headers left out: a trace
   id differs on every request; page 2 may add a cursor page 1 lacked, never drop one of its values).
   It is a cursor when page 1's answer holds page 2's value there: `next` is the path to it, the one
   outside the list's items when several hold it (GraphQL's `edges[i].cursor` beside
   `pageInfo.endCursor`). When the answer holds it only as a query param of a string (crates.io's
   `meta.next_page: "?per_page=10&page=2"`), `next` is `path~[?&]page=([^&#]*)`. With no cursor in
   the answer, a number that counts up by one (or a page 2 where page 1 left it out) is numbered
   pages. A value under 4 characters or all digits is found by chance in most answers (a count, a
   rating), and a value inside a list's items is often another item's id (a related item, not the
   next page): either counts only under a key that names paging (`next`, `cursor`, `after`,
   `token`, `continu...`). `capture` and `inspect` list each hint as `pages` with the `add` flags
   that learn the list from its second request, and `add` from a capture warns when the request it
   learned is one of two pages and no `--paging` was given. The CLI only suggests: one capture is
   one run, and two unrelated requests can look like pages of a list, so the user confirms with
   `--paging`. A page value under 3 characters (page `2`) cannot be located by its value, and two
   runs of one list both send `2`; when `--paging` with a `next` names the place a hint found,
   `add` learns from a copy of each run with a stand-in value there (`standIn`) and puts the run's
   own value back in the op.
   `learn_site` applies paging itself, because its two runs are the confirmation: with `steps`
   that load page 2, a hint for the chosen request's endpoint that both runs show (same place,
   param and path) is learned as `add --paging` would learn it, from the page-2 request with each
   run's cursor as the example; `data` is still page 1, the user's answer, and the result carries
   `paging` (`auto: true`), `nextPage` and `hasMore`. Only a cursor is applied this way: numbered
   pages need the page in `args`, `args2` and `args3`, so the agent passes `paging` itself. An
   agent's `paging` with a `next` the runs do not show is refused, with a `next` that says to give
   steps that load page 2.

## Writes

A write must never be performed to learn it. Create/heal for writes runs the UI trigger with a
context-wide route (popups included) that **aborts** before it leaves: every non-GET request, every
request but stylesheets, fonts and media once the UI steps start (a "Follow" button may send a GET,
an upvote may be `new Image().src`, a link, a GET form, JSONP or an iframe), those too when they are
the site's own endpoint in disguise (same site, and no asset extension or a query carrying an
example value: `<link rel=stylesheet href=/api/vote?id=..>`), and anything matching a
known write's `match`; WebSocket messages any of the run's pages sends (a popup's too: the socket
route is context-wide) are dropped too. A new tab's first navigation (a `target=_blank` link,
`window.open`) is routed before Playwright has the tab's page, which it reports only once that
navigation commits, so the guard cannot ask whose request it is. The browser reports each new tab
with the tab that opened it, and that is recorded as it happens (the browser forgets it once
the opener is closed, as does Playwright's `opener()`), on a DevTools session of the browser itself,
which outlives every page. The record holds open tabs only (when one closes, the tabs it opened
pass to the tab that opened it), and is brought up to date before each such decision. The request
is judged as the run's own
unless the run has no stray tab, one its pages opened that it does not hold yet, and
an aborted one joins the capture once its page shows the tab was the run's. Two runs that open a
tab at the same moment cannot be told apart, and the guard then applies to both tabs: one run's
tab fails to load rather than a write going out. A tab whose page arrives after its opener closed
is adopted by that record, and one that still has no page when the run ends (a slow document that
would load, and write, after the guards were lifted) is closed through that session, whether or
not any page of the run is still open. The guards are lifted only after the run's pages are closed:
an open page still sends (a client's retry; Chrome reloads an aborted navigation's error page after
about a second), and removing a route releases the requests paused in it. A route is not asked about
every request. Playwright continues by itself every hop of a redirect (a stylesheet the guard
allowed, answered with a redirect to the write, would be sent on to it) and any paused request that
has no network id, which is what a document sends as it unloads (a pagehide beacon, a keepalive
fetch, an image ping) and a deferred `fetchLater()`. So each guarded page also has a DevTools
session of the run's own, where the same guard decides those; a hop is judged at its own address
with the resource type of the request that was redirected, and is told by its network id (Chrome
marks a cross-origin fetch's hop with no `redirectedRequestId`). One exception, for reads: every hop
of a chain that started with the op's own unsafe request is the op's own, on any origin, as Chrome
would follow it (a signed read the server checks elsewhere with a 307). The hops of any other chain
(an asset, a request let through for another reason) are judged at their address, so a stylesheet
sent on to a write is still aborted. Not covered: the op's own read sent on by a 307 to a write
endpoint, which passes as the read did before hops were judged. Not covered: a frame on another site. It is a
DevTools target of its own: its redirect hops would need a session on the frame, and that target is
gone before the frame's document unloads, so what the frame sends as it unloads
is seen by no session, one attached to the frame included (tried); what it sends while the page is
up is routed like any request. Only interception on the browser target would see it, for every run.
Closing a page is not atomic either: its unload handlers send, Playwright calls no route handler for
a page once `close()` was called, and Chrome sends a request paused in a session on to the network
when that session detaches. So when a guarded run ends, each of its pages is first taken to
`about:blank` with its session and the guards still live, and everything it sends from then on
fails; what is closed afterwards has nothing left to send. What the guard itself would stop is
still recorded as aborted then, so a write a page only sends on leaving can be learned; the rest of
a closing page's traffic is stopped without a record. Every wait in that sequence has a bound,
since a hung renderer answers nothing and neither `evaluate()` nor `close()` has a timeout of its
own: 5 s each for a page to be emptied, for its session to answer, for the browser's list of tabs
(also when a new tab's owner is decided: no answer counts as a possible owner) and for a page or a
stray tab to close. No new round starts after 15 s, but a round under way runs its waits out, each
to its own 5 s, so with a page that answers nothing the end of a run can take longer (two such
pages took about 21 s). The guards are lifted only when every page of the run and every stray tab
is known to be closed. If one is not, the browser is still released, and both guards stay until the
last of them is gone: the route, which acts on the run's pages only, and the socket guard, although
it drops every run's sends. A page that is still open can still write, and time passing is no sign
that it cannot. Service workers are blocked in the profile, since their fetches bypass routing (a
dedicated worker's are routed). Not covered: a shared worker's writes (see Browser below). The op is learned from the intercepted
request. A read's tier-3 trigger also aborts unsafe requests other than the op's own once its steps
run, so a spec that says "read" can't write. Learning a read (`add` or `capture` without `--write`)
is held to the same rule, since forgetting `--write` would otherwise perform the action on each run
(seen: a click step that POSTed an order placed two real orders, and the op was saved as a read of
the page's GET without a word about the POST). Once the steps run, an unsafe request (any method but
GET, HEAD and OPTIONS) is aborted unless it is the op's own by `--match` (or a hop of that one's
redirect chain) or a GraphQL query carrying its document, which reads by GraphQL's own rules (the
same test `notARead` applies; a persisted query, which names its document by a hash, may be a
mutation and is aborted). What the page sends while it loads, before the steps run, and a trigger
with no steps are left alone: a visit sends that too. One aborted on the trigger page's own site,
with no `--match`, fails the add before run 2 and before anything is saved, naming each request by
method and path and saying what to do: `--write` if it is the action, which never sends it, said
first; a `--match` pin only if it changes nothing (a search the site sends as POST), said with what it
costs: a pinned request is sent for real on each learning run and saved as a read (seen: an agent took
the pin for an order endpoint, sent two real orders while learning and saved the order as a read). The
guard cannot tell a POST search from an order (both fail `notARead`), so the safe answer leads. One on
another site (an analytics beacon, most often), or beside a pinned
`--match`, is still aborted, and the add goes on and warns about it. `capture` lists what it stopped
(`stopped`), and its `next` says the same; `add --from` such a capture refuses to learn a request
that was stopped, which never left and has no answer. WebSocket messages are not judged here, as
for a read's tier-3 run. While the page is a bot challenge's interstitial the
steps are not running yet: its own verify POSTs (AWS WAF's `mp_verify`, Cloudflare's
`/cdn-cgi/challenge-platform`) go through, or it would never reload; the guard applies from the real
document on. A 2xx to a write is `ok` (204, "OK", an HTML page with a password field, `{"status":
"queued"}`), because the server took it, unless the answer says it was not done:
- A sign-in form (a password field next to a username field, or a form posting to a login path)
  where the op's answer is not a page is `auth`: the session was gone and nothing ran.
- A JSON answer that says the service refused the write is not `ok`, and is marked `rejected`.
  That covers an error field that holds an error, up to four levels down (`error`, `errors` and
  `userErrors` at any of those levels, and the family `validationErrors`, `errorMessage`, `hasError`
  up to two). It covers `ok` or `success` false up to two levels, and a root `status`, `state`,
  `result` or `outcome` that is an error word (`"error"`, `"fail"`, `"invalid"`). An error field
  that is empty, zero, false or a word for none (`error: null`, `userErrors: []`) is no refusal. A
  `message` is not read for error words, since a success can name what the write was about ("Error
  report sent").
- A numeric `status` of 400 or more, up to one level down, is judged as that HTTP status, like an
  error status in place of the data (below). A 4xx there is a refusal; a 5xx is a server failure
  and stays as ambiguous as one.
- GraphQL errors with no `data` are a request error, so by the spec nothing ran. Errors with null
  `data`, or with null under every root field, are an execution that failed. Both are refusals.
  Errors next to a payload that is there mean the write may have partly run: not `ok`, and not
  `rejected` either.
- The class follows the wording: a refusal that says the session is gone is `auth`, one that names a
  limit is `rate`, and anything else is `error`. Its `nextCall` follows: `fix_args` for `error`,
  `login` for `auth`, `retry` after the wait for `rate`.
- A form page that shows its errors (Django's `errorlist`, Rails' `field_with_errors` or
  `#error_explanation`, or an alert whose text is an error's) is a refusal when it is the answer
  itself, with no redirect. An element the markup hides (`hidden`, `aria-hidden`, an inline
  `display: none`, a `<template>`) is not shown; a stylesheet's hiding is not seen.
- After a redirect, neither of these proves anything: the post may have run before the redirect.
  A redirect whose address names an error (`?error=title_blank`, `#status=failed`), or one back to
  the op's own form page (its trigger's address) showing an error, is `error` with "may or may not
  have run". It is not `rejected`.
- A 201 with a `Location` header is a created resource, whatever its body names.

None of this resends anything: a 2xx is never proof that a write did not run, so the rule below
holds. Reads get none of it. A read's data can carry an error field of its own (a job's or a
payment's failure), and a read without its data already goes through the example-args check
below, which can tell a template that went stale (heal it) from bad args.

A write executes exactly once per call. Retry only on a definite non-execution (400/401/403/404 answered to the request
itself: after a redirect, as in Post/Redirect/Get, it ran; at tier 3 the page sent it, and the
answer judged may be a redirect's follow-up, so a tier-3 write is never retried); timeouts, 5xx and network errors are
ambiguous and are never retried. A redirect does not send it a second time either: at tiers 1 and 2
one that keeps the method and body (307, 308; 301/302 after a PUT or DELETE), or that leads back to
the op's own request (a GET write redirected to itself), is not followed. The write was sent once;
the call fails naming the redirect and the origin it pointed to, and its `next` says to check the
site and, if the operation moved, to learn it at its new address. A 301/302/303 that turns it into a
GET (Post/Redirect/Get) is followed: nothing is sent again. At tier 3 the page can also send it twice by itself (a handler
bound twice, a client that sends again), so the run has a budget: the op's own request, by its
`match`, leaves once, every further request matching it is aborted, and the result's `reason` says
a repeat was stopped. The server's redirect of the one that left is held to the same rule as at
tiers 1 and 2: a hop that would send the write on (an unsafe method kept, or the op's own request
again) is aborted in the browser, and the result says so; a hop that became a GET passes. A real
write often needs companion requests (the cart saved before the order), but a page can change under
a spec: after a redesign, the button the steps click can send `DELETE /api/account`, and when the
companions were let through unexamined that DELETE reached the server while the result said only
that the trigger fired no request of the op's (seen). So learning a write records them: each unsafe
request the guard aborted in either run besides the op's own, on the op's site, goes in
`trigger.companions` by the same stable identity as `match` (method, host, path with a segment that
holds a hash, a long number or an example value as `*`, operationName; never a query id), at most 8
(`add` warns about the rest). A write always has the key, an empty list included. Once the steps of
a tier-3 write run, an unsafe request that is neither the op's own (sent once, as above) nor a
recorded companion is aborted, so is another site's, and what the page sends while it loads is left
alone as for a read. A write learned before this has no `companions` key: its companions still pass,
since nothing says which ones it needs. Either way the result's `reason` names every other unsafe
request that left or was stopped, by method and path (with the host when it is off the op's site,
never the query, redacted like any reason), and for an op with no record it says to learn it again
with `add --write` so the rest are stopped. A heal never changes the list: like the confirms it is the
caller's contract, and a recapture runs the trigger intercepted anyway. WebSocket messages pass at
tier 3, as before. When the run ends, as in every guarded run, its pages send nothing more. An op
with no `match` has no request to count. `vetShared` refuses `companions` on a read, more than 8, and
one that names no unsafe method, no host or no path, or a host off the op's own site: a shared spec
cannot use the list to let a write to someone else's server out of the user's browser. Not covered:
a companion whose path holds an id that is none of those (a cart id the page makes on each visit).
It is another path on the next call, so it is stopped, and the reason names it; the write may then
fail, and nothing else was sent.

Payment-card entry is handed back to the human. api-anything does not learn card fields or the
request that submits a card: a card form sits in the payment provider's iframe, on another site,
which the guards cannot cover (above), and a card number is a credential no spec may hold. A checkout
can be learned up to the payment step like any write; at the payment step, the agent tells the user
to finish in their browser.

A write behind the browser's own `confirm()` ("Delete this post?") is sent only once the dialog is
accepted. Told no, as Playwright tells every dialog with no listener, the page sends nothing, and
learning took the page's own GET for the write (seen before this was handled). So while a write is
learned (`add --write`, `capture --write`, a write's recapture or session refresh), a confirm that
comes once the steps run is accepted: the guard aborts the request it lets go, so accepting sends
nothing. Each accepted confirm is recorded in the op's `trigger.confirms` as the step index it came
at (-1 before the first) and a SHA-256 digest of the page's origin, that step, and the question
normalized (NFC, whitespace collapsed) with every example value it names, as a whole word or number
in any letter case, replaced by its param. Run 1's confirms are kept; when run 2's differ by more
than the values, `add` warns. A tier-3 write call accepts a confirm only when its digest, made with
the call's own args, matches a record at the same step, each record once per run; any other is
dismissed, nothing is confirmed on the user's behalf, and the reason says the page asked to confirm
at which step and why it was told no (no record matches, or the op has none: learned before this).
The class stays `drift`, whose `next` is to re-learn with `add --write`. A heal never changes the
records: they are the caller's contract, like the rest of the trigger.
The spec keeps a digest rather than the question because a shared spec is public, and a question
can name the person who learned it ("Remove Jane Doe from the team?", an order or an account
number) beyond the example values the learner knows to abstract. A digest of a short question can
be confirmed by guessing it, so it hides what is not guessable, which is what matters here; and
matching needs only equality. What a reviewer can still see is that the write confirms, how many
times, and at which step. `vetShared` refuses `confirms` on a read, more than 8 on one op, and a
step the trigger does not have; the schema refuses a digest that is not 64 lowercase hex
characters, so the field cannot carry page text. Unlike Pomerado, an http page's confirm can match
too: its origin is in the digest, and the shared rules already require https addresses.
Writes need `allowWrites` at every entry point (CLI flag, MCP
server flag, library option).

What a write did is a field, not prose: `write` is read from every attempt the call made, the most
any of them may have done. `not_sent`: nothing left (refused, bad args, a request that cannot be
built, the browser profile busy, a tier-2 origin page that did not load or never sent the request, a tier-3 run that fired
nothing after its confirm was told no, or the ledger below held it back). `not_applied`: the site answered that it did not run it (a definite non-execution as above,
or an attempt flagged `rejected`: a clear refusal in a 2xx body, which the classifier sets).
`accepted`: a 2xx judged ok, which proves the site took it and not that it took effect.
`may_have_applied`: anything else that may have reached the site. `applied`: the op's readback
(below) found it. A failed write that is `accepted` or `may_have_applied` always says `retry: "no"`
and `nextCall: check_site`.

Writes are aborted while they are learned, so learning never sees a write's success answer, and a
2xx is the only evidence a call has. A write op can carry `readback: {op, args, find?}`, a read of
the same site that proves it landed: after a call whose write is `accepted` or `may_have_applied`,
that read runs once through `call` (healing and tiers as any read, `allowWrites` off). It is a read,
never a resend, so send-once holds. Each arg and `find.equals` may hold `{param}`, filled from the
write's args. With `find: {field, equals}`, some item of the read's result (or the result itself,
when it is not a list) must have `field` equal to `equals`, compared as text with the ends trimmed.
Without `find`, any data counts, which proves something only when a read arg comes from the write
(a lookup by the id the caller chose). Found, the call becomes `ok`, class `ok`, `write: "applied"`,
with no `retry` or `nextCall`, even after a lost answer (a timeout, a 502): the site shows the write.
Not found, or a read that fails, changes nothing but `reason`, which says the site may not show it
yet: it stays `accepted` or `may_have_applied`, and the second is still never sent again.
Pomerado saves again when its read-back does not match (`typescript/authoring/writes/SKILL.md`);
that is a second send, so here a miss only leaves the status as it was. The readback has to find
something only this write makes (a title the caller chose, an id it returns elsewhere), or an older
item with the same value passes for it. `api-anything readback <site> <write> <read> [k=v ...]
[--find field=value]` sets it, checked against the read it names and by the shared rules below. An
op learned again keeps its readback while those checks still pass.

A local readback names a read of the same site. An upload holds one op, so a shared write carries
that read inline instead: `readback: {read, args, find?}`, where `read` is the read's request, slots,
trigger, match, response and params (no examples) as `publish` exports them, and `read.name` is a
label. Publish embeds it, and checks the named read fits first; the local spec keeps the name. A
carried read runs as the write's proof: through the same tiers, with the trust its spec has, but it
remembers no tier, heals nothing and reports nothing, so a drift or a miss leaves the write
`accepted` or `may_have_applied`; its `rate` or `blocked` answer cools the site down as any call's
does. A later repair of that read on the site does not change a published proof; a new version of
the write does.

An agent that skims an unclear answer sends the write again, so a write is recorded before it is
sent (`writes.json` in `~/.api-anything`, under its lock, written atomically): site, op, time, a
status (`sending` until the call settles it) and an HMAC-SHA256 of `[site, op, args]` (defaults
filled, keys sorted) under a random key made on first use (`write.key`, 0600), so a short arg (a
comment, a vote) cannot be guessed back from the file. The args are never stored. The same digest
within 10 minutes of a record that is `accepted`, `applied`, `may_have_applied` or still `sending`
(its process died mid-send) is refused with class `duplicate`, `write: "not_sent"`, and a `next` to
check the site.
Ten minutes covers an agent's re-send after an unclear answer, a login or a heal in between, and the
user looking at the site; a repeat placed on purpose later (the same comment an hour on) goes
through. `again` (CLI `--again`, MCP `again`, library option) skips the check, for a user who
checked. Check and record are one step under the lock, so two processes racing to send the same
write let one through. An `idempotencyKey` replaces the digest check among keyed calls: the caller
says which calls are one, so another key is another write. A repeat with a key whose write may have gone through returns that call's record (`ok`,
`class`, `write`) and sends nothing; a key whose write did not run may be sent again; a key used for
other args is refused as `input`. A key with no such record still meets a keyless call: the same
digest within the window of one with no key is `duplicate`, as without a key. An agent that adds a
key only to its retry of a lost answer is repeating that call, and was sending it twice. The key
belongs on the first call. Records are kept 24 hours. The record also seeds the op's `gen` slots
(the key's HMAC, else the record's random id), and holds no generated value.

A failed write whose `nextCall` is `check_site` says where to look in its `next`: the trigger's page
filled with the call's args (redacted like every `next`), and the op's readback with its filled
args when it has one. When the record cannot be written (a
read-only home) the write is not sent unless the caller passed `again`; a corrupt ledger is started
over, as `state.json` is.

## Failure classifier (`classify.ts`)

Every response is classified, never by status code alone:

| class | signals | action |
|---|---|---|
| `ok` | 2xx, expected content type, extract path present (an empty list there is a search with no results: `data: []`; for an html recipe, its `empty` selector shown on the page, or, with an items selector `<container> <item>`, the container present with no element of the item's tag), no GraphQL `errors` with null `data` or next to a null extract target, no error status in place of the data; any 2xx to a write whose answer does not say it was refused (see Writes) | return |
| `drift` | 404/410 on a templated API path, GraphQL "PersistedQueryNotFound"/"must be defined", 400 schema errors, extract path missing, a non-empty list there that the `pick` empties (no item has a picked field: a spec may have no learned shape, and `data: []` would read as no results), a picked field the learned shape typed that no item carries now, or none with that type (see below), an html recipe whose items all match with none of their fields found, breaking shape change (compared under the extract path; id-keyed maps are `*`) | heal once (missing data first checks the example args) |
| `auth` | 401, 400/403/422 with login wording ("Bad Authentication data") or a refused API key ("Invalid Application-ID or API key") or an explicit CSRF failure (token missing/invalid/mismatch, verification failed, InvalidAuthenticityToken; not a page that merely carries a csrf field), a 403 login page, 419, 200 + HTML login page where JSON expected, a sign-in form that embeds a CAPTCHA widget or a vendor script that also rides on ordinary pages (reCAPTCHA on a login page guards the login; an interstitial's own markers still make the page `blocked`), an html/embedded op's page without its data that says "sign in" or shows a sign-in form (a mere Sign-in link, like Google's ServiceLogin button, is not one), a redirect to a login path, `require_login: true`, a trigger that lands on a sign-in page | each step at most once per call, at any tier, a retry that still answers `auth` going on to the next step (a changed analytics cookie changes the request without renewing a token); a write only when it certainly did not run, so never at tier 3: re-import a browser-imported session; then refresh the jar's cookies from the profile, retrying if that changes the request (a tier-2 page sends the profile's cookies itself, so there only a `cookie:` ref counts: an `x-csrf-token` header); for a read with `session:` refs, one trigger run refreshes them and answers; for a write with them, one trigger run with the write intercepted (as when learning it) refreshes them and the write is sent again; for a read whose only credential is one marked public, with no login on record, a heal re-learns it, as for drift (the site rotated its shared bearer); then diagnostic "run `api-anything login <site>`" |
| `rate` | 429; any 4xx or 5xx that carries a Retry-After (a 503 in maintenance, a 403 lockout: the server named its wait, so sooner meets it again; a wall's markers still make it `blocked`, a 2xx with one is its answer); "please wait", "rate limit" | back off, report; no heal; the site cools down (Execution ladder) |
| `blocked` | challenge pages (Cloudflare, Akamai, DataDome, PerimeterX, AWS WAF, Amazon, Imperva, Kasada, Anubis, self-solving JS challenges, reCAPTCHA; an interstitial's title even on a big page, unless the op's html/embedded recipe finds its data there: "Robot check-in: how our robots work"), even at 200. The interstitial's own structure counts at any status; a vendor script that also rides on ordinary pages (AWS WAF's challenge.js, DataDome's tags.js, Imperva's resource script, Kasada's ips.js and `x-kpsdk-*` headers) counts only on a challenge status (202, 403, 405, 429, 503); a bare 403 with no markers; 451 (Unavailable For Legal Reasons: not available from this network or region). A page showing a sign-in form is `auth`, not a wall, when its only challenge marker is one that also rides on ordinary pages (a CAPTCHA widget, a vendor script or header on a challenge status); an interstitial's own structure or title on that page is still a wall; a tier-3 run or a heal's recapture whose trigger fired no matching request and ended on a challenge that did not solve (judged before a sign-in page or a page that is down) | escalate transport tier; then diagnostic `gated`, whose `next` asks for `api-anything login <site> --window`: to clear the challenge in the window, or, for a bare 403 at every tier (no challenge to clear), to see why the site refuses this machine or network. A read's bare 403 first replays the example args once at the same tier: if they answer, the call is `input` (a private or missing entity), with no climb and no heal. A 451 climbs no tier (a browser on the same network gets the same answer): `retry: "no"`, `nextCall` `report`. The site then cools down (Execution ladder) |
| `input` | 400 with validation error mentioning a param; 404 with the param in the path; a read's 404, empty 2xx or missing data while the example args still answer; a GraphQL not-found; an unknown arg name | return the error to the caller |
| `error` | a write refused in its 2xx answer (see Writes); a signed-in JSON read (it holds a credential ref, or was learned signed in) redirected off its path to an HTML page of the same site with no sign-in form or challenge: a consent, terms or "verify it's you" step, reported with its address and a `next` to finish it in the browser and run `api-anything login <site>` (`nextCall` `login`) (a real redirect only: an SPA's shell at the request's own address is drift); anything else (a network error names its cause) | return with details; no heal, nothing stale |

An error status a 2xx answer carries in place of its data is judged as the HTTP status it stands
for: a batchexecute RPC whose payload's place holds `[13]` (`[["wrb.fr",null,null,null,null,[13]]]`),
`{"error": {"status": "UNAVAILABLE"}}` or `{"error": {"code": 503}}`, a JSON-RPC `error`. gRPC's
codes go as Google's gateways map them (13 and 2 → 500, 14 → 503, 4 → 504, 8 → 429, 16 → 401, 7 → 403,
5 → 404, 3, 9 and 11 → 400), JSON-RPC's as a server error (500), a missing method (404) or a bad
request (400). So a server's own failure is `error`, not drift: it is not healed and marks nothing
stale. A heal whose trigger page or candidate check gets a server failure (a 5xx, or a status in the
body that stands for one), or no answer at all (a timeout, a reset, a page that does not load),
learned nothing either: it stops and marks nothing stale, as for a
throttled check, and so does an example-args check that gets one. A tier-3 run whose page answered
a 5xx is that `error` too, and does not switch tier 3 off for a stale op. A read's bad request in the body names no
param, so it is missing data: the example args tell bad args (`input`: a reversed date range) from a
template that went stale. Of several RPCs in one answer, the status is the one the extract path
reads, and none when that RPC is absent. It counts only where the extract target is absent or null, or anywhere when the op has no
extract path (the body is then the answer): data that is there, its shape changed or not, is judged
as before, whatever error member sits next to it. An app's own error number
(`{"error": {"code": 190}}`) and a name that is not gRPC's are not statuses. A write's 2xx that
carries one was refused.
Login and rate wording in a 2xx JSON body only counts when the data is missing (Instagram sends
`require_login: false` on its rate-limit answers). **Missing data is ambiguous**: "no such user"
and "no results" look exactly like a moved extract path, and so does a server that sometimes
answers a good request without the data (Google sends its homepage for a valid flight search now
and then). A read below tier 3 is first sent once more: if that answers, it is the call's answer.
Then, before healing, the stored template is replayed once with the op's example args; if that
answers, nothing drifted and the call returns `input`. This costs two requests instead of a browser
run. If that replay is
throttled, challenged or logged out, the call stops there with that class and nothing is healed.
If the examples get no data either and re-learning gives the same request, the response recipe
drifted (a renamed field): `drift`, with a hint to re-add with a new `--extract`.

**A picked field that went is missing data too**, not an `ok` without it: a field of the `pick` that
the learned shape typed (not `null`) and that no item carries now, or none with that type (`price`
renamed `amount`, moved under `pricing`, or `9.5` become `"$9.50"`). It takes the same path: a
second try, then the example args. When the example args' answer still carries it, the field is
absent for these args' data only: the call returns that data, `ok`, with a `reason` naming the
field. Otherwise a heal runs, its candidate held to the same types (a recapture keeps the picked
fields' learned types over the new answer's shape), and a heal that cannot bring the field back
ends in `drift` naming it ("picked field price disappeared from the response"), with a `next` to
re-add with a new `--pick` or `--extract` (`nextCall` `relearn`); with no example args to tell, the
same. A field learned `null`, absent from the learned answer's first item, or absent from any
other item of the learned list (a `salePrice` only items on sale carry; the learned shape types it
`null`), is optional and not judged, and in a list a field some items still carry is the data. Not caught: a field that keeps
its type and changes its meaning (`price` now holding the list price, or cents instead of units).
The shape records key paths and types, not what a value means.

Two guards against heal loops. A heal that produces a byte-identical template (compared with the
same args filled in) is not drift. An op healed less than 10 minutes ago that fails again, or
whose heal failed, is marked stale for 30 minutes with a reason, not re-healed. While stale, a read
still tries its trigger (tier 3), unless the trigger did not answer either (a run met by a challenge,
a limit or a sign-in page is no such answer). A heal that learned nothing about the op (its check
was rate limited, challenged or logged out, its recapture ended on a challenge that did not solve,
another process held the browser profile, or no browser is installed for the recapture) stops at once and marks nothing
stale. A forced `api-anything heal` that re-learns the same template replays it once and reports its
answer: the same template is no proof the op works.

## Execution ladder

Requests to one site are paced at every tier: tier 1's sends, tier 2's page fetches (the wait starts
once Chrome is up, so its start overlaps it) and tier 3's trigger runs take the site's next send
slot. The slots are kept in `pace.json` in the home, read and moved on under its lock, so separate
processes (a CLI loop, agents in parallel, an MCP server beside them) queue up as one. Each send moves
the site's slot on by `minIntervalMs` (default 1 s) times a random 0.7 to 1.3: about a second apart,
never one fixed period. An idle site's call waits for nothing; a home that cannot be written paces
within the process only. Tier 1's `send` is paced for every caller (`add`'s replay check, the clean
replay of `learn_site` and the background verification); a heal's rescan fetches the trigger page and
its scripts as a browser loads them, unpaced, and learning's own trigger runs are page loads.

A site that said stop is left alone for a while: a cool-down per site in `state.json`. A `rate` answer
sets it for the site's Retry-After, capped at 30 minutes, or 3 minutes without one; a `blocked` answer
at every tier the op climbs to (3 for a read, 2 for a write), or a 451 at any tier, sets 10 minutes. A
local `blocked` (a tier cap, no browser, an unconfirmed op) sets none. While it lasts, `call()`
answers `rate` or `blocked` without sending anything, a write before its ledger records it
(`write: "not_sent"`), with `cooling: true`, `retryAfterMs` counting down to its end and a `reason`
naming what the site answered and when; nothing is reported to the registry for that answer. A blocked cool-down's `next`
asks for `api-anything login <site> --window`. Any login for the site (an import, a cookies file, the
window whether or not it saw a sign-in, since a challenge cleared there counts) ends it. The call
option `ignoreCoolDown` (CLI `call --force`), which only a user asks for, sends that one call through
it: one that succeeds ends it, since the site answered (before a write's readback, which may set it
again); one the site limits or blocks again sets it anew from that answer, as any call does. MCP has no way to skip it. The idle MCP server's verification of candidates skips a cooling site too.

| tier | transport | when |
|---|---|---|
| 1 | Node `fetch` + domain/path-scoped cookie jar + session values; redirects followed by hand under the redirect policy below (cookies set on a hop ride on the next); Set-Cookie answers are merged into the jar; the body is decoded with its declared charset | default |
| 2 | `fetch()` inside a real page on the site origin (real TLS, cookies, sec-fetch); redirects one hop at a time under the same policy | tier 1 `blocked`, or op `minTier: 2` |
| 3 | run the trigger in the browser, capture the matched response | op `minTier: 3`, or after a heal fails for reads |

One redirect policy, for tiers 1 and 2 (`nextHop`). A write follows no redirect that would send it
again (see writes above), so a write behind a 307/308 fails where it worked before. A request is taken
through as many redirects as its tier took before redirects were followed by hand: 5 at tier 1, 20
at tier 2 as in a browser's own fetch (more at tier 1 would send a GET write that moves on at each
hop, or carry a copied value, further than it ever went). One more fails the call saying that the limit was reached, and its `next` says not to retry
but to learn the operation where the site now answers): 303 after anything but a GET or HEAD, and 301/302 after a POST,
make a bodiless GET, without the headers that described the body (Content-Type, -Language,
-Encoding, -Location, -Length), as a browser's own redirect does; every other redirect sends the
request on as it was, so a GET answered 303 keeps its headers. On an origin change the credential headers are
dropped: authorization, cookie, and every header a `cookie:`/`session:` ref fills, at any depth
(a ref inside a header's JSON too). A hop to another origin is not taken when it would re-send a
body in which any ref slot lives, which is decided from the slots and not by searching the bytes
(a value under base64 or any other layer is not found that way), nor when its Location repeats the
value of any ref slot, a dropped header's too (the site can copy what a header held into the
address). That is a search and not a proof: the address is percent- and form-decoded until nothing
changes (a return address inside a return address opens), and the value is looked for as it is, as
a JSON string's contents and in base64; an encrypted, hashed or split copy is not found. The call then fails naming the redirect, and its
`next` says not to retry (for a write: to check the site first, since the request the redirect
answered was sent). At tier 2 a page's own `fetch()` would follow a redirect with every header and
the body, so the page fetches with `redirect: "manual"`. It is then told nothing about the redirect,
not even its status, so each hop's status and Location are read from what Playwright saw of the
request. The origin page or another call may have sent the same request at the same moment (same
method, address and body): if their redirects differ, this call's cannot be told apart and it fails
saying so. Cookies a hop sets are in the profile for the next, as with a browser's own redirect.

A derived slot's lookup goes first, at tiers 1 and 2, through the same tier with the same session
(none for a candidate or an agent-pulled non-GET, as below), the same pacing, the same redirect policy
and, for someone else's spec, the same public-address check; identical lookups of one call are sent
once. Its answer is judged as a read with no recipe: anything but `ok` is the call's answer at that
tier, with `unsent` (the op's own request never left, so a write's status is `not_sent`): `rate`,
`auth` and `blocked` act as for the op, and a 404 or a 2xx without the path is missing data, which the
example args tell from drift, as for any read. Drift heals as usual (the stored template, lookup
included, is sent first; a recapture re-learns the lookup from the trigger run). A failed lookup's
network error is `error` with `server`. A write sends its lookup on every try, the write itself once.
Tier 3 runs the page, which does its own lookup. A looked-up value is text the site's users may have
written, so it must be an identifier (letters, digits and `_.~:@+=/-`, at most 512 characters: an id, a
slug, a UUID, a base64 id) or the call is `error` before the op's request is sent; learning derives no
other value. No such value can make a GraphQL document, however deep the leaf sits in encoded layers the
vet cannot read. As a second guard, a read whose filled document defines a mutation is refused too.

Heal strategies, cheapest first:
- **rescan**: no browser. Fetch the trigger document and the JS bundles it references (resolved
  against the document's final URL), find a token of the recorded shape within ~300 chars of each
  volatile anchor, swap it in, and validate. The anchor must stand as its own name ("Followers" is
  not inside "FollowersYouKnow"), and an occurrence in code beats one in prose (whitespace next to
  it, a log message). A token in the anchor's own group beats a nearer one outside it: between them
  no bracket closes the group and no `;` ends a statement at that level (Meta's previous module
  ends in `}),null);`, while its own `"use strict";` is nested); a tie is no answer. For a write, whose validation
  is a real send, only a token that is the single candidate is tried. And for a write, the pages the
  rescan fetches must not be the write: a trigger that is the write's own address (a GET vote link)
  would be performed by a plain fetch, before any validation and with nothing to intercept it. So
  redirects (301, 302, 303, 307, 308 only; at most 20, as the plain fetch it replaced) are taken by hand, and no address matching the op's `match` as a GET (or, for an op with
  no `match`, its template's own address) is fetched, at first or at any hop. The rescan then finds
  nothing and the recapture, which intercepts, does the work.
- **recapture**: run the trigger in the browser, match, re-learn, and validate by replaying at the op's
  tier (at most 2: at tier 3 the site's own request would answer, validating nothing) with the current
  args (classifier must say `ok` and the extract must resolve). It learns from the call's args with
  defaults filled when they can be located (every param present, 3+ chars, distinct), else from the
  op's examples. A new slot where the arg merely equals the old template's constant there (q=search
  in /api/search) is dropped; a candidate that loses any param's slot is refused. A page fills some places with its
  own values: a date picker asks for its own range (from the first of the chosen day's month, to a day
  it picks), so the caller's `start` is only at the chosen day and the caller's `end` nowhere. A param
  found only at places the op already had (it did not move) keeps its other places too, and a param
  the trigger has no `{name}` for, whose example the page therefore never sends, keeps all of them.
  Each kept place must still hold the same kind of value: the same leaf type, the same runs of
  characters ("2026-10-31" and "2027-05-31" are one kind, "en-US" another, so fields that moved are
  caught), the param's pattern, no cookie or stored value, and, in an array, the same array around
  it: as long, with the same value at every position no param fills (a field inserted beside it, or a
  constant that traded places with it, is caught). One holding another kind, or inside a
  longer text (a templated slot, which could not be filled with the page's value left beside it),
  fails the heal: re-add the operation. A param the trigger does give the page, but which the page
  sent nowhere, means something else now: that fails the heal as before. Adding an op stays strict: there an example the request
  does not carry is refused, since the param would change nothing. Values of newly
  learned `session:` refs are stored before the check.

A healed template is saved to the user's spec dir only after validation. Every heal is
appended to `~/.api-anything/heals.jsonl`: op, strategy, what changed, the op as it was before
(`previous`) and a hash of the template it saved. A heal shows its work rather than patching in
silence. The call that healed answers `heal: {strategy, changes}` beside `healed: true` (the CLI also
prints it, with how to undo it, on stderr). `changes` is one line per change to the wire template:
the method, origin and path, then each query, header, form and body leaf added, removed or changed
(`header:x-app-version: "1" -> "2"`, `query:term: added "{q}"`). It is read with every slot's
`{param}` or `cookie:`/`session:` ref in its place, so a moved param shows as a moved `{q}` and a
value never shows. Lines are capped at 12, values at 80 characters. A registry version adopted in
place of a drifted one says `strategy: "registry"`. The changes and the stored op hold refs, never
a credential. They are redacted against the jar anyway, as the result's `reason` is. `api-anything
heals [site]` lists the last 20 heals and reverts with their changes. `api-anything revert <site>
<op>` puts back the op as it was before its last heal not yet reverted, logged as a `revert`, and a
second revert takes back the heal before that. It refuses when no heal kept the op, or when the op's
template changed after the heal (learned again or edited: reverting would undo newer work). A revert
writes the user copy, as a heal does. A pulled spec's copy keeps its `shared` record, and the op gets
back the registry `version` it was, after the restored spec passes `vetShared`. A revert is no heal
for the heal-loop guard, and it clears a stale mark. The next call sends the old template: if the
site really changed, it drifts again and heals again, so a wrong heal is fixed by learning the op
again. A heal-back upload of the healed version (see Sharing) is not taken back. A tier an op escalated to
(above its own `minTier`) is remembered per op as a speed hint (a lower `--max-tier` still tries
its own tier), and a call that ran above tier 1 says why in `reason`. Every failure also carries
`retry` and `nextCall`, filled in one place from the class, the attempt (a busy profile is
`retry: "after_wait"`; a refused redirect `relearn`) and what was sent, so the fields cannot
disagree: `safe` (now, once), `after_wait` (`retryAfterMs`, from the site's Retry-After, or a few
minutes), `after_fix` (once the step is done), `no`. A `reason` quotes up to 160 characters of the
site's answer, and a 401 or a CSRF failure can echo the token it refused. Each attempt's reason is
redacted (`redact` in `secrets.ts`) against the jar as it was before the send and after it (a
rotated cookie), and the result's `reason` and `next` again when the call returns, as are stale
marks and the heal log when they are written. Every stored form of a live value (as stored,
unquoted, URL-decoded) is replaced as it is, percent- and form-encoded, JSON- and HTML-escaped, and
base64-encoded at any byte offset; a quote that ends in the first 4 or more characters of a value
(as they are, or spelled in JSON escapes: `\u0053`, `\/`) was cut inside it, and those go too. The
cut end is read on the quote as it came, before any whole value is replaced, and one such start at a
time comes off it (a value's start right after another's).
The classifier cuts the quote without the session; redacting after the cut and dropping a cut
value's prefix gives the same result without passing the session to it. A value that is an origin
is left. `data` is the answer the user asked for and is not redacted. The jar, `state.json` and a
spec (every add and heal, re-read under the lock) are read-modify-written under a lock file, so
concurrent processes and calls lose nothing.

**Call log.** Every finished call (a write's readback is part of its call, not one of its own)
appends one line to `~/.api-anything/calls.jsonl`: `{at, site, op, class, tier, ms, healed?,
write?}`. `tier` is the tier that answered, absent when nothing was sent (a cool-down's answer,
args refused before the send). Only names, enums and numbers go in. Args are the user's (a search
term, a message, an account id), data and `reason` quote the site's answer, and `next` can repeat
either, so none of them is kept. A call log is something an agent reads too. Without it nothing
recorded a call that worked, so an op that still answers but 150 times slower (a remembered
escalation to tier 3) or that fails `auth` on every call left no trace. The log is appended under
its lock and rewritten only when it passes 1 MB, or when its first line is more than a day past the
30 days kept. The rewrite keeps the 30 days, and the newest half of them if that is still over 1 MB. A
home that cannot be written keeps no log, and the call's answer is the same. Nothing in it leaves
the machine: `report.ts` does not read it.

`api-anything stats [--days n] [--card]` totals the log over up to the 30 days kept: calls, ok rate,
tiers, sites, median ms of the calls that sent a request, heals and writes. It sends nothing. When
API Anything works its results go to an agent, so nobody sees it; `--card` prints those totals in a
few lines to paste into a post. Its `saved` is an estimate and carries its assumption: each ok call
that sent a request stands in for 2.5 s of an agent driving a browser, less the call's own time. The
benchmark measured about 3.2 s a call (Google Flights, 5 dates: 41.6 s with a browser against 21.1
s over 10 calls of about 1.2 s) and more on Goodreads. Not on MCP: a tool costs every agent tokens,
and this one answers a person, not a task.

`api-anything status [site]` (MCP `site_status`) reads it with the rest of the home: the state's
cool-downs, stale marks and remembered tiers, the heal log, verify's record and the write ledger
(counts by status only, never a digest or args). It sends nothing. Per op it gives each source's
latest and the calls of the last 24 h and 7 days: count, ok rate, tier mix, heals and median ms.
An op is `degraded` when its last 24 h ran mostly at a higher tier than the 6 days before, or with
an ok rate 20 points lower (3 calls in each window at least: fewer say nothing). Each problem
carries `next`, phrased as a call's is. A read remembered above its own `minTier` is called once
with `--max-tier` at that tier. That needs no new mechanism: an answer at the op's own tier already
forgets the escalation.
At tier 2 `timeoutMs` is one deadline for the whole call, counted from the moment Chrome is up
(starting it, seconds on a busy machine, is not counted): the first load of the origin page, every
hop of the fetch, and the wait and second fetch after the page navigated all draw on it. When the
origin's root redirects to another origin, it fetches from a
blank stand-in page on the request's origin. When the origin page navigates mid-fetch, after the request left (its own
challenge or redirect destroys the context), a read waits for the new document and fetches once
more; a write is never resent.
Origin pages are kept per origin across a process's calls, and every request one sends waits in
the browser until api-anything lets it go. A fetch none of whose requests was let go within 2 s
(any with its method to its origin counts, the page's own included) never left: seen on a loaded
machine, a cached page whose renderer ran nothing until the next DevTools command reached it, so
the call waited out its whole deadline. A page that closed or navigated before letting one go is
treated the same. That page is retired, whatever it sends later is failed in
the browser, and the request goes once more from a fresh page inside the same deadline, a write
too, since nothing was sent. If that one never leaves either, the call fails with
`write: "not_sent"` (when it was the first hop). A page a call failed on is not handed to the next
call. The tier-3 answer is the matching request whose declared parameter positions equal the
materialized call, including short and structured values, and whose response judges ok (a `softFrom` page fires its own; a WAF interstitial precedes the page).
A param's default is filled into the args once, before the first tier, so every tier runs with the
same values: the tier-3 trigger opens `?count=20`, never a literal `{count}`.
Before any recovery or browser, a read that tier 1 answers `auth` or `blocked`, from a site with no
login on record (as below), whose request carries browser identity headers (`user-agent`,
`sec-ch-ua*`, `sec-fetch-*`) that no slot fills, is sent once more at tier 1 without them, all else
unchanged. Some walls refuse a client that claims to be Chrome without Chrome's TLS (Hacker News's
`/from` answers 419 "Sorry"), and which headers trip one differs by site, so all of them go. An ok
answer is the call's, at tier 1, and nothing is kept: the next call sends the stored template first
and pays the one extra fast request again. A 429 is the call's answer; any other leaves the call
with tier 1's first answer. It runs under `--max-tier 1` and with no browser, once per call, never
for a write.
An `auth` answer starts recovery at whichever tier got it (an op with `minTier: 2` or `3`, or one a
remembered escalation starts there), at most once per call. At tier 3 only the re-import applies,
and only to a read: the page just ran with the profile's own cookies and session values, so there is
nothing fresher to take, and a write the page sent is never sent again.
When tier 1 still answers `auth` to a read after that recovery and the site has no login on record
(the session has no source, the jar has no live login cookie once recovery is done, the op takes no
cookie or session value and was not learned signed in), a wall that answers 419 or 401 to a client
that is not a browser looks the same as a login wall. One tier-2 attempt is made, when that tier may
run, before the call gives up. If the page gets the data, tier 2 is remembered. If it does not, the
call's answer is tier 1's `auth` and the login hint. The attempt is a tier-2 call like any other:
Chrome opens the site's origin page, whose own scripts run, and fetches from it. That is its cost on
every call that fails this way, and why a write never gets it: a write is sent once, and a page can
send a request again (its own scripts, a retry after a navigation or a connection reset).

## Browser

- Any installed Chromium build, launched by path (no browser download).
  The default order is Google Chrome, then Brave, Microsoft Edge, Chromium, Vivaldi, Arc, each
  probed at its standard install location for the current OS. `API_ANYTHING_BROWSER` overrides
  the choice: a name (matched against the browsers above, case- and style-insensitive — `brave`,
  `Brave`, `BRAVE`, `chrome` all work) or the path of any Chromium executable, which is how a
  portable install or an off-list build is named. When the resolver finds nothing, the browser
  tiers skip cleanly; the plain-HTTP tier needs no browser at all.
- The headless user agent is asked of the resolved browser once (it means starting it again,
  about 3 s of a cold call), so the answer is kept at `~/.api-anything/chrome-ua.json`, keyed by
  the browser binary's path, modification time and size: an update changes those and the browser
  is asked again. A file that cannot be read, or that names another browser, is not believed. A
  wrong user agent under the right key is believed: delete the file and start again (a running
  process, an MCP server too, keeps the one it read). `HeadlessChrome` in the reported agent is
  rewritten to `Chrome` (a default-headless agent says so, and some sites answer 403). `login`
  runs headed.
- Capture listens on the context, keeps the run's own pages and the popups they open (closed
  afterwards), and reads bodies **inside the response handler** (bodies vanish after navigation).
  The document body is kept raw. Pages load to `domcontentloaded` (a hung tracker or a download URL
  doesn't fail the run). The run waits for the network to go quiet, ignoring streams, an endpoint's
  repeats (beacons, polling), requests open over 3 s, and the previous document's requests once the
  page starts a new one (they never finish; their bodies get 2 s); with an op's match it ends soon after that
  request answers; with no XHR yet it waits up to 2 s more for a deferred one. When the page it
  ended on is a bot challenge's interstitial (a JS challenge that solves itself, often after a second
  or more), it waits up to 15 s for the real document, then waits for its data as before; UI steps
  wait for it the same way before they run. It records every URL the main frame had (history API
  changes included) as the capture's `locations`.
- Native dialogs, in every page a trigger run holds (popups too) and in tier 2's origin page, get
  one answer each: leaving a page (`beforeunload`) is accepted, since leaving sends nothing and
  staying would abort the run's own navigation (a `goto` step, or the `about:blank` that empties a
  guarded page at the end; dismissing it made such a `goto` fail as `ERR_ABORTED`, which a load
  treats as loaded); `alert` and `prompt` are dismissed; a `confirm` is dismissed unless the run's
  caller accepts it (see Writes), and always before the steps run and once the run is ending.
  Every dialog needs an answer once a listener exists, or the page waits on it. Playwright with no
  listener already accepted `beforeunload` and dismissed the rest, so the alert, prompt and
  unsaved-changes pages did not hang or leak before; the tests keep it that way. The capture
  records each dialog's type, message, origin, step and answer as `dialogs` (the message stays in
  the local capture file; no reason or spec carries page text).
- Each run records why its wait ended (`wait`): the op's request answered, the page went quiet, or
  the time ran out, with the requests still open and the status of the first page's last document.
  A tier-3 call or a recapture that found no matching request appends that to its reason, with the
  final page's origin and path (never its query, which can carry a token) and each dialog's type,
  answer and step.
- A browser locks a profile to one process. The browser is released after 3 s idle, and a second
  process waits up to 15 s for the profile before it fails with a short hint. SIGTERM exits.
- After every browser run, cookies are exported (full Playwright cookie objects) to
  `~/.api-anything/sessions/<site>.json`, together with session values seen in captured headers and what a learn
  classified each of them as, a setting or a credential. A later run that only refreshes the values classifies
  nothing: a setting whose value changed is unclassified again, and a credential stays one. Every write of the file
  goes through one place, which records there what the save-time scan keeps and returns that, so no write undoes
  its protection and no caller goes on scanning with the classification the write overruled.
- `softFrom` loads the neutral page, then navigates in-app: a link the app rendered is clicked
  (its router handles it); otherwise `history.pushState` + `popstate`, which client routers listen
  to. Only if nothing fired does it load the URL. An injected `<a>` is not routed by React Router,
  TanStack or Comet, so it would be a second full page load that fires no data XHR.
- Service workers are blocked in the profile: their fetches bypass routing and capture.
- Known gap: shared workers are not guarded. A shared worker's requests reach no route, no page's
  tap and no capture, so a write a guarded page hands to one (started from a URL, a blob: or data:
  URL, or one an unguarded page started earlier and the guarded page joins) is sent, and is not
  recorded. They are left running because sites need them (a sign-in or start-up can wait on one):
  removing the constructor broke those, and guarding them through the browser's session judged
  every run's workers by every guarded run's guard, covering only a URL worker started by a
  guarded page. Closing it needs per-run ownership of a worker.
- A per-site minimum interval between network requests (default 1 s) keeps usage at human scale.

## Response extraction and token efficiency

`response.extract` (dot/bracket path; `[*]` maps the rest over an array and flattens one level, skipping items without it, undefined when none has it) → optional `pick` (list of paths kept per item, or per
object; `name=path` renames, `name=path~regex` keeps what the regex's group 1 finds in a string; a picked item left empty, such as a shelf or an ad, is dropped) → a hard output cap (the
result is never over it) with a truncation note that says what was cut. Arrays are cut at an item
boundary, an item too big on its own is cut rather than dropped, strings are cut as strings, and
objects stay objects: members above a common size cap are shortened, then trailing members are
dropped. It runs in about linear time on 10k-member objects.

A call-level `view: {fields?: string[], maxChars?: number}` comes after classification and the
stored extraction/pick recipe, before the cap. It never changes the spec or the site's args.
`fields` uses pick's paths and `name=path`, per item of a list or on an object. Its regex form
(`path~regex`) is refused (`input`): the agent that names a view may be acting on page text, a
pattern can backtrack for minutes on a kept answer, and nothing interrupts a running match. Unlike a stored pick, a view keeps an empty projected item as `{}`, so item indexes
stay stable. It cannot recover fields the stored recipe already discarded. `maxChars` is an
integer from 256 to 200,000 JSON characters, default 20,000; the cap is on `data`, not the result
envelope.

When a view is cut, `results.ts` keeps the full extracted answer, before the call's view, in
`API_ANYTHING_HOME/results.json` (otherwise `~/.api-anything/results.json`), atomically written
under the store's lock with 0700 directories and 0600 files. Disk rather than MCP memory lets
the next CLI process read the same answer. Only the newest 20 answers that fit 16 MiB together are kept (one
larger alone is not kept, and evicts nothing), each for 15 minutes from creation, with opaque random `resultId`s. Reads never extend the TTL; expired
records are inaccessible and removed on the next successful call or result-store access.
The file can hold signed-in user data, just as `data` can: it is never a spec, heal log,
write-ledger entry or report. A retention failure leaves the successful call successful but
explicitly says that its full answer is unavailable.

A cut call returns `resultId` and `more: {resultId, offset, fields?, maxChars?, format?}`.
`get_result` (CLI `result <id>`, library `getResult`) reads it without a site request, spec
lookup, classification, or healing. Normally `offset` is an item index and `data` is the next
list slice, capped on whole items. Pass `more` unchanged for the same view, or pass just the
id and a different view to project from the start. If even one item cannot fit whole, or a
non-list answer is cut, `more` restarts at offset 0 with `format: "json"`. In that mode `data`
is a fragment of the full projected answer's serialized JSON and `encoding: "json"` is set;
offset counts string characters. Concatenate only these fragments, then parse once complete,
not the initial shortened preview. This recovers oversized strings, objects, and single items
without a new site request. Changing the projection in JSON-fragment mode requires restarting
at offset 0. Missing, expired, or evicted ids fail locally and never rerun the call.

For HTML-only pages, `response.format:
"html"` with a selector recipe `{ items: "<css>", fields: { name: "<css>[@attr]" } }` parsed
in Node; a field written `all:<css>[@attr]` returns every match as a list (a book's genres). An
optional `empty: "<css>"` names the element a page with no results shows instead of the list
(pkg.go.dev's `p.SearchResults-emptyContentMessage`, on a page with no list container for the
`<container> <item>` rule to find empty): items matching nothing while that element is shown is `ok`
with `data: []`, as the structural empty is. Only a shown element counts, as for the items: a message
a page keeps hidden under its list says nothing. The selector is a string in the spec like the
others, so the secret scan reads it; `verify`, when an html op without one fails an `empty` check as
`input` or `drift`, says to add the op again with the recipe plus `empty`.
`@href` and `@src` values are links, so a relative one is unusable without the page's own
address: they are resolved as a browser would, against the page's `<base href>` or else the final
URL the answer came from (redirects included). The other attributes are returned as they are in
the page. For data embedded in the HTML document (for example Google's `AF_initDataCallback`), `format:
"embedded"` with a regex whose capture group is JSON, followed by `extract`. Seroval/JS-literal
payloads are out of scope for v1.

A read whose list pages carries `paging: {param, next?}`. `param` is the arg that asks for the
next page. `next` is a path in the whole answer, read before `extract` and `pick` throw the rest
away (for `embedded`, in the embedded JSON; never for `html`), to the next page's cursor or number.
A call returns that value as `nextPage`, with `hasMore: true`. When the answer has `null`, `""` or
`false` there, the site says this is the last page: `hasMore: false` and no `nextPage`. When the
path finds nothing, neither field is set, because a moved path must not read as the last page.
`next` may be `path~regex`, as a `pick` entry may (the same code, `getPathRegex`): `nextPage` is
the regex's group 1 in the string there. A site that answers with a next-page URL
(`"?page=2&q=x"`) gives the value to pass back, not the URL. `null`, `""` or `false` at the path is
still the last page; a string the regex does not match sets neither field. The shared rules check
the regex as they check a pick's (length, no nested quantifier), and the path before `~` as any
`next`.
Without `next` the pages are numbered, and a call says nothing about the next one. `nextPage =
page + 1` while the list is non-empty would be a guess: the last page is non-empty too, and many
sites answer a page past the end with the last page again, so an agent paging by it might never
stop. The agent sets the param itself, and `verify` checks that page n+1 is not page n.

A cursor op is learned from the request that loads page 2 ("Show more"), since page 1's request
often has no cursor field. `add --paging <param>=<path>` makes that param optional and drops its
example, since a captured cursor can expire or carry the session it was made for. A call that
leaves the cursor out gets the first page: the slot is emptied (`null` in a JSON leaf, `""`
elsewhere), so the template's captured page-2 cursor is never sent. Calls are stateless replays,
so the cursor is the site's own value, passed through untouched. It is not signed or re-windowed
as Pomerado's list cursors are (`docs/how-it-works.md`): it is not a local result-store offset.
When the output cap cuts a page, `truncated` says that `nextPage` starts after the page's last
item, cut or not. Retrieve the cut items with `more`/`get_result` before following `nextPage`;
the two continuations are independent, and `hasMore` describes the site only.

## Spec files and where they live

One JSON file per site: `{ name, displayName, baseUrl, description, operations[] }`, zod-validated.
Site names are case-insensitive (lower-cased), so one file never gets two sets of state.
Resolution order: `~/.api-anything/sites/<site>.json` (user-created and healed copies win) → a
pulled `~/.api-anything/registry/<site>.json` → the bundled `sites/<site>.json` (community). A heal
of a pulled or bundled spec writes a user copy.
An operation may carry `links: [{from, to: {op, arg}, transform?}]`: a selected result item's
field/path supplies an arg of another operation in the same spec. Shared vetting requires the
target operation and param to exist, and the source field to be one the op returns when its
recipe names them (a pick or an HTML recipe). Transforms are `lastPathSegment` (an absolute URL's final
non-empty pathname segment, without query or fragment, still percent-encoded) or `path~regex`,
the pick expression relative to the source value (`~regex` reads the value itself). Link regexes
have the same limits as pick regexes. Links are metadata, never triggers: no item is chosen and
no request is sent. Relearning, healing and adopting the registry's version of an op preserve
them. Whole-site exports keep them; individual
registry uploads omit them, since an upload carries no target operations to validate against.
`api-anything export <site>` writes a shareable copy. It strips examples (unless `--keep-examples`:
a human confirmed they are public, so `verify` works for others) and samples (response shapes,
whose keys can be user data, but for the picked fields' learned types: the pick names them already, and they let every copy tell a picked field that went; typed example values in the request become null), and it runs an
exact-match secret scan against live jar/session values, found under any encoding the spec may
carry them in (percent-encoded up to three layers, JSON- or `\u`-escaped, base64), plus regex
heuristics. It also refuses any literal the learner would have made a ref (a session field or
header, a random value under a credential's name), and warns about a literal IP address (a client
`remoteHost` the page reported), whole or inside a longer leaf (`ip:port`, an x-forwarded-for list,
`ip=` text; a version string after a letter or `/`, or one ending in `.0`, is not one). Names an op lists in `public` are allowed.

## Sharing specs (`registry.ts`, `share.ts`, `publish.ts`, `report.ts`, `background.ts`, `vet.ts`)

Agents share one catalog of operations through the registry service (`registry/`, a Cloudflare
Worker), and fill, verify and repair it as a side effect of using it. `docs/REGISTRY.md` is the design
of the service and the crowd rules (candidate, live, degraded, review; promotion by reports); the wire
contract is `src/registry-api.ts`. This section is the client's side. The base URL is `REGISTRY_API`;
`API_ANYTHING_REGISTRY` overrides it (https, or http to localhost for tests). Every request refuses
redirects, has a timeout and reads its answer while streaming up to a cap. Uploads, reports and
verify jobs are signed with the install's Ed25519 key (`identity.ts`). Nothing is uploaded, reported
or verified unless setup's question (`QUESTION`) was answered yes (`settings.json` `share`, with
`askedAt`), except an upload the user consents to.

**The one question, asked once.** A plugin install, `claude mcp add` or `npm -g` never runs setup, so
`learn_site` asks the same question the first time it reaches the share step (the holdout answered and
the op holds none of the user's values) with no answer recorded: through MCP elicitation, or the CLI's
prompt on a terminal. A yes or a no is kept (`answerShare`) and never asked again; a dismissed prompt
keeps nothing. Unanswered, the share outcome's reason says sharing was never asked (a no says the user
said no), and the result's `next` gives the agent the question in its words and the commands that
record the answer, `api-anything setup --yes --share-only` or `--no-share --share-only` (setup's
answer alone: no agent, skill or key touched), then, on yes, the `publish --yes` that shares the op.
Nothing is shared without a yes.

**Trust model.** A spec is executable configuration: it names the URLs a call sends the user's
cookies and session values to, the pages a browser holding the user's sessions opens and what it
clicks there, and whether an op writes. A pulled spec is someone else's. The service runs the shared
rules and the export secret scan on every upload and serves a version that needed a login, writes,
sends off its site or lists `public` names only to its uploader until a maintainer reviews it. The
local rules below are defense in depth on top of that.

**What keeps a pulled spec from turning the user's sessions against them:**

- *A session value goes only back to the host it was captured from.* The session records the host
  of the request each value was sent in (`Session.valueHosts`), set with the value in one write, and a
  `session:` ref resolves only for a request to that host. So a spec cannot point a request at
  another host, or a sibling host of the site, and carry a bearer the trigger just captured from the
  real one; the value is simply missing there. A value from before the field has no host: it is sent
  as before for the user's own specs, and dropped from the session by `pull` and before the first call
  or forced heal of any spec the user did not write (pulled, bundled, or a heal's copy of a pulled one); the next
  trigger run captures it again, bound.
- *A cookie ref's site fallback never takes an HttpOnly cookie.* The fallback (a cookie of
  www.site.com echoed to api.site.com) models page script copying a cookie, and no script can read an
  HttpOnly one; without the rule a host-only session cookie would reach every host of its site.
- *Provenance survives a heal.* `pull` stamps the spec with `shared: {from, sha256, by?}`. A heal writes
  a user copy that keeps it, and `loadSite` runs the shared rules on every spec that has it or lives
  in the registry directory, so tightened rules reach copies too; a registry file without it is no
  file pull wrote, and is refused. `export` and uploads strip it. A bundled spec ships inside the
  package and is trusted as its code is: it keeps rescan.
- *A shared spec heals by recapture only.* A rescan sends a token it found in the site's own pages to
  the op's request URL before any check, and the spec chose that URL.
- *A shared spec's trigger run keeps a redirect of the op's own request on its site.* `readGuard`
  lets an unsafe redirect hop of the op's own request through on any origin (a signed read checked
  elsewhere with a 307); for a shared spec, a hop to another site is aborted, before the steps run too.
- *Writes stay gated.* `allowWrites` is required at every entry point, whatever the spec's source.
- *An unreviewed candidate goes without the user's sessions.* For a spec with `shared`, an op whose
  `version.status` is `candidate` gets no cookie jar and no session values at tier 1, and its tier-2
  page fetch sends none of the profile's cookies (`credentials: "omit"`), whatever its method and whoever
  pulled it. By the registry's review rules a candidate is a public read with no cookie or session ref,
  so it needs none, and a GET with the user's cookies can still act on their account (a one-click
  settings link). Once live (confirmed by other installs) or reviewed it gets them like any op. The
  user's own ops, including one they uploaded that is a candidate, are unchanged.
- *An unconfirmed candidate an agent pulled never runs in the user's browser profile.* For a spec
  pulled with `by: "agent"`, an op whose `version.status` is `candidate` runs at tiers 1 and 2 only
  (`unconfirmed` in `execute.ts`): no tier-3 trigger run, whose steps would click what the spec says
  with the user's sessions aboard, no recapture heal (a trigger run too), no trigger run to refresh
  session values, and no copy of the profile's cookies into the jar. A call that needs tier 3 (its
  `minTier`, or an escalation past a wall) answers `blocked` at tier 3 with nothing sent: the operation is
  unconfirmed and needs the browser, and a human can allow it by running `api-anything pull <site>` in a
  terminal, which drops the agent mark (MCP's `next` keeps that command as it is, instead of rewriting it
  to `list_operations`, whose pull would not lift it). A live op, a human's pull, and the user's own
  ops are unchanged.
- *An agent's pull that may change something goes without the user's sessions.* For a spec an agent
  pulled (`by: "agent"`), a request whose method is not GET or HEAD gets no cookie jar and no session
  values at tier 1, and a tier-2 page fetch of it sends none of the profile's cookies
  (`credentials: "omit"`): a "read" sent as POST can be a write the rules cannot see, and page text may
  have steered the agent to it. A human's pull and a bundled spec upgraded from the registry keep them:
  the registry serves a POST read, or an op with a slot holding a cookie or session ref, to no one but
  its uploader until a maintainer reviewed it (docs/REGISTRY.md), and the seeded POST reads need the
  session (airbnb search). Tier 3 runs the site's own page, which sends what it sends (`bare` in
  `execute.ts`).
- *Someone else's spec sends only to public addresses.* At tiers 1 and 2, for a spec with `shared`, the
  request and every redirect hop must pass `badAddress` (https, a host under a public suffix, no IP literal or
  `localhost`), and every address the host resolves to (`node:dns` lookup, all of them) must be outside
  loopback, private, link-local, CGNAT, unique-local, multicast and reserved ranges, IPv4-mapped and
  NAT64 forms included (`publicAddress` in `http.ts`); otherwise nothing is sent there. A refused first
  request is an `error` with nothing sent; a refused hop is a redirect not followed. Tier 2 checks the
  request before the page's fetch and each hop in `pageFetch`'s `redirect` callback, which the page
  takes one at a time. Background verification sets the same check on `cleanCall` (`publicOnly`). Tier 3
  navigates the site's own page in Chrome, which resolves and follows redirects on its own: not covered.
- *Text is data.* Notes, descriptions and hints reach the calling agent; `ops`, MCP `list_operations`
  and `find_sites` say beside a shared spec's that someone else wrote them and they are not
  instructions. Op and param names, which `next` hints spell in commands, are restricted.

**The shared rules** (`vetShared`), run on pull, on every upload (here and by the service), on load,
and by CI over the bundled `sites/`. Errors refuse: every URL an op sends to or opens (request, a derived slot's lookup, trigger, soft-from, `goto` value or
selector) is https on a host under a public suffix (no IP, `localhost`, single-label or
`.local`/`.internal`-style name), and so is `baseUrl`; no literal credential in a request or a lookup (the
export rule) outside the op's `public` names; a lookup is a GET on the op's own host whose `path` names one value, and its value goes only in the path, a query or the body, never a header nor a field named like a session value or credential, and the lookup overrides no method; a derived slot counts as a param in the read rules that follow; a read's method-override field (`_method`, `x-http-method-override`, `x-method-override`) is neither filled by a param or a lookup nor holds a literal other than GET or HEAD; `readOnly` only on GET, HEAD and POST, never on a
GraphQL document defining a mutation or subscription (read from a JSON body, a batch, a form, the URL
or a raw `application/graphql` body, by each definition's operation type, with comments, strings and
block strings skipped: `query mutation { }` is a query), never with a param as the whole body (raw,
base64, the JSON root or a batch item: the caller would write the request), and never on a GraphQL
request whose document a param fills; a `match` naming a host, path or operationName (the match is what a trigger run
lets through as the op's own request); op and param names a letter then letters, digits, `_ . -`;
regexes (`pick` `~`, `embedded`, param `pattern`) at most 200 characters with no quantified group
inside a quantified group; at most 50 operations, descriptions and hints at most 500 characters,
notes at most 8 KB, the file at most 256 KB; a param's `enum` at most 100 values of at most 500
characters each; at most 10 checks per op, each arg a param of the op and at most 500 characters, a
purpose at most 500; no checks on a write (verify would send it); no `unproven` mark; no provider key
anywhere in the spec or the notes, by the key's own prefix (`providerKeys`): GitHub (`ghp_`, `gho_`,
`ghu_`, `ghs_`, `ghr_`, `github_pat_`), OpenAI and Anthropic (`sk-`, `sk-proj-`, `sk-ant-`, with a
random run so a slug like `sk-hynix-ddr5-...` is no key), AWS access key ids (`AKIA`/`ASIA` and 16
more), Slack (`xox[abposr]-`) and `-----BEGIN ... PRIVATE KEY-----`, raw or percent-encoded. A
provider issues each to one account and no site ships one to every visitor, so `public` waives none;
the error names the key by its first 8 characters only; `paging` only
on a read, its param one of the op's that goes into a slot (and optional when `next` names a cursor,
since the first page leaves it out), its `next` a path to one value (no `[*]`, at most 200
characters) on a JSON or embedded answer; a `readback` only on a write, filling `{name}` only from the
write's params and from at least one of them (otherwise any answer would pass for this write), each
value at most 500 characters; a read it carries takes these args (only its params, every required
one) and meets every rule of a read here. A readback that names a read is checked against it where
the whole site is at hand (`readback`, a re-learn, `publish`), not on load: a pulled site may hold
another version of that read. An upload's readback must carry its read. Warnings, shown to the human: reads sent as POST, writes, ops learned logged in, literal `public` values
(a shared bearer makes every user's calls that account's), requests or triggers off the spec's own
site (Algolia behind Hacker News, AppSync behind Goodreads), the export scan's shape heuristics over
the spec and the notes (skipping pull's `shared` record and each op's `version`), and a Google API key (`AIza` and 35 more), which a site's own pages often
carry for anyone to read (Maps, Firebase, YouTube), so it is a question for the reviewer, not a refusal.

**What the rules do not cover.** A read sent as GET or as a non-GraphQL POST can still change
something; trigger steps can click what the page lets them before `readGuard` acts on the page's own
unsafe requests, and page script at tier 2 and 3 sends what it likes with the browser's cookies; the
regex rule catches the common catastrophic shapes and is no bound on run time (`(a|aa)+` passes);
what a hostname resolves to is checked at tiers 1 and 2 only, and fetch (Node's or Chrome's) resolves it
again when it connects, so a DNS answer that changes in between (rebinding) is not caught, and tier 3
navigation is not checked at all; shared workers are not guarded (see Browser).

**Versions.** Each op the registry serves is a version, named by the SHA-256 of its site's name and
the canonical op (`versionHashText`: keys sorted, `learnedAt` left out). A local op records the
version it is as `version: {hash, status}`, set by `pull` and by an upload. It is this machine's
record, like `learnedAt`: never uploaded, exported or part of verify's op hash, and a heal drops it,
since the healed op is no longer that version.

**Pull.** `api-anything pull <site>` asks `GET /v1/sites/<site>` for the site's best version of each op
and its notes. It checks the answer is the site asked for and that its domain is its `baseUrl`'s,
builds the spec with each op's `version`, runs `vetShared`, refuses a spec over 256 KB, and writes it
to `~/.api-anything/registry/<site>.json` with its notes, notes first, and the record
`shared: {from, sha256 of the spec written, by?}`. Resolution is user → registry → bundled. It refuses
when a local spec or session of that name belongs to another site (one name is one session), and
reports when the user's own copy shadows the pulled one. Output: each op (`name(params) -> fields`,
method, hosts, write, login, status), the warnings, and what changed since the last pull. Each op's
`registry` holds the served version's hash, status, confirmations, successRate and lastOkAt;
missing evidence is `"unknown"`, never an inferred success. Its separate `local` holds the current
op's verify status (`pass`, `fail`, `inconclusive`, or `unknown`) and record time when present,
not args or case results. These summaries are output only, not part of the spec. A call or
`ops` for a site that does not exist says `next: api-anything pull <site>` before suggesting `capture`.

**Agents pull.** MCP `list_operations` and `call_operation` on a site that is not installed pull it,
so an agent with no shell reaches every shared site. Pulled this way, the record says `by: "agent"`,
and the server neither lists nor runs its writes, whatever `--allow-writes` says: page text may have
steered the agent to it, so a write waits for an `api-anything pull` from the CLI, which rewrites the
record without `by`, in the user's own copy too when one shadows the pulled spec (a heal's, or one an
`add` extended). The mark binds this server only: an agent with a shell can run the CLI itself, as it
always could. Its reads run with what the user already set up and nothing more: a session exists only
if a human logged in to that site with the CLI or a login window, and session values stay bound to
their hosts.

**Search.** `api-anything search <words | domain | url>` and MCP `find_sites` ask `GET /v1/search`
and merge the answer with the specs on this machine (the user's, pulled and bundled) as `installed`,
the local copy winning, so a site learned here and never shared is found too; a registry that cannot
be reached leaves the local ones with a `registryError`. Each match lists its ops with their params and
status, with `registry` health and `local` verification separated as in pull, so the agent can decide
whether to call one next. An installed copy keeps its own call metadata and gains registry health only
for the same site name, domain and op name; that health names the registry's version, not necessarily
the installed one. With no registry answer its health is unknown, even if the installed op records a
version's status. No new probes run. A registry match reaches the agent as text, so it is held to
the shared rules' limits (a site name as `safeName` allows, op and param names the rules allow, an op
signature, texts of at most 500 characters, at most 50 ops); one that breaks them is dropped, not
the rest. The registry ranks its own matches; local specs are scored here: a domain or URL query
matches the specs whose ops use its registrable domain; words (lower-cased, under 3 letters and
common words such as "the", "in" or "best" left out, a plural `s` dropped but not from "news") are
scored against the site's name (most), its title and domains, then op signatures, the site's description
and op descriptions. Op names and fields split at camelCase; part of a longer word there counts from
5 letters. Unmatched words do not subtract: `vegetarian pasta recipes` can find a recipe capability
without claiming it filters vegetarian pasta. The sum of word weights is multiplied by the number of
matched words, favoring coverage; a generic action or output word alone (`search`, `price`, `title`,
`name`, `description`, `result`, `data`) does not establish a capability when other query words miss.
A local site under a third of the best score matched a stray word and is left out. Each site and each
op returns normalized `matched` and `unmatched` words; an op's coverage uses only its own signature
and description, never another op's text. Domain queries keep their exact registrable-domain rules.
When all matches are partial, `next` suggests trying their core capabilities or broadening before
learning. `find_sites.nextCall` is executable: `list_operations {site}` for a match (notes before
calling), `list_sites {}` for no match; an interface-only match has none. Learning needs a page and
examples, so a bare `learn_site` is not a next call.

**Sharing what this install learned (`shareOps`).** Each op's upload (`VersionUpload`) is built by
`publish.ts`'s `plan`: the export's stripping (no example values in the request, no response shapes but the picked fields' types,
no `learnedAt`, no `shared`, no `version`), the param examples kept (learning arranges for them to be
the agent's chosen second example and holdout, never the user's own request), the site context
(name, domain, baseUrl, display fields, login cookies) and the caller notes (`<site>.md` before
`## Maintainer notes`). The notes go only with `consent` (the user's own notes are theirs), or when
they came from the registry (a pulled site's, which go back with its heal); an automatic upload of a
site the user wrote notes for carries none. An op is public when its clean replay was ok (`cleanCall`: no cookies, no
session values, plain HTTP), it was learned signed out, it reads, every host it sends to or opens is
on its site's domain, and it lists no `public` names. A public op uploads when `share` is on or with
`consent`; anything else only with `consent: true`, and otherwise the answer is `needsConsent`. A
public op holding what may be the user's own (below) waits for consent too. Before sending, each
upload must pass the shared rules and two secret scans, with no override: the export's, and an exact
scan of the upload's bytes against this machine's cookies and session values that no `public` name
waives (a public name keeps a shared bearer out of the shape heuristics, never out of this), keys
included; an upload over 256 KB is refused. What may be the user's own is listed for them, and goes
in the outcome of a consented op for the caller to show: an email address, a UUID or a literal IP
anywhere in the upload (keys included) or the notes, a run of 5+ digits in a URL path no param
fills, a literal typed by a `fill` step, a param default, an `enum` value holding a run of 5+ digits,
and every check's args. A check's args hold an automatic upload back like the rest, except those of the
check `learn_site` records from its holdout call (`purpose: "learn_site holdout"`, `HOLDOUT_PURPOSE`),
whose values the agent chose as neither of the user's examples; a check recorded with
`api-anything check` needs consent. It is sent signed to `POST /v1/versions`, and the answer's hash and status
become the local op's `version`.

**Publish.** `api-anything publish <site> [op ...]` is the human's way to share: without `--yes` it
previews each upload exactly as it would be sent, what was stripped, every warning, what may be the
user's own, and verify's record of each op's checks; `--yes` sends them through `shareOps` with
`consent: true`. Both refuse an op that fails the scans or the shared rules, or `checks.ts`'s gate
(below). The agent skill shows the preview to the user and runs `--yes` only on their explicit OK.
`learn_site` keeps its holdout call as the verify record of the op's holdout check when that is its
only check (`recordCases`); learning an op again replaces an earlier `learn_site`'s holdout check with
its own, which ran on the version it saves, while a check recorded otherwise stays and leaves the
record to `verify`. The record keeps what the run proved (clean replay, holdout, tier): a publish of that
version passes the gate with no verify first and sends that evidence (`proofOf`), so a public read the
user shares after the fact goes up as a candidate, as it would have automatically.

**Proof before sharing (`checks.ts`).** A read may carry `checks: [{args, expect, purpose?}]`:
args a human confirmed on the site and what it answers them with, `result` (data), `empty` (its own
no-results) or `input` (it refuses them). `api-anything check <site> <op> k=v --expect ...` records
one (the same args replace the old one). The most useful check excludes something: every optional
param set at once, each value chosen so one row the example returned fails it, or a value no row
matches, expecting `empty`, so a param the server ignores shows up as a failing case. `verify` runs
each read's stored example (expecting `result`) and its checks through `call`, healing as any call
does, and judges every case: `pass`, `fail`, or `inconclusive` when the answer is `blocked`, `auth`,
`rate` or a server that failed or could not be reached (`CallResult.server`), which says nothing
about the op. Each case's answer comes from one version of the op: the one its call resolved, or the
one a heal or the registry put in its place. Its outcomes are kept per op in
`~/.api-anything/checks/<site>.json`, with a hash of the op as saved when verify ends (in schema
order; `learnedAt`, `unproven` and `version` aside). Each case is tagged with the hash of the version
that answered it, or with none when the site's cool-down answered it (`CallResult.cooling`): nothing
was sent, so that case is no version and mixes nothing. A run is clean when its cases were chosen
from the op saved now and every tagged case answered from it. A run that is not clean (a heal part
way, another process saving the op, cases chosen from an earlier version) runs once more from the op
saved now, and that second run is the one judged. A judged run that sent nothing leaves the op's
record as it was, unless the first run sent something and was not clean: then the record goes; a
clean one becomes the record, inconclusive cases and all; any other takes the
record away. So an op changed since, or saved by something else while its last cases ran, has none,
and a rate limit part way through keeps the failures the cases before it saw. When two passing cases whose args differ only in an op's
`unproven` params answer differently, in a run that becomes the record, verify clears the mark. A read with `paging` gets one more
case after its example, `next page`: the call again with the paging param set to the example's
`nextPage` (or, for numbered pages, the example's page number plus one). It fails when the answer
has rows and every one of them was on page 1 (`got: "page 1 again"`), the sign of a server that
ignores the param where the request puts it. One new row is enough to pass (Pomerado's rule,
`typescript/src/mint/live-tests.ts`). It is inconclusive when there is no page 1 to go on from (the
example failed or was empty), no next page to ask for (no cursor in page 1's answer, or no page
number in the example), or an empty page 2, which some lists end with. `publish` refuses an op marked
`unproven`, an op with checks and no record for its current version, and any counted case that
failed: every counted case must pass, with no percentage bar, because there are two or three
human-confirmed cases, not a suite in which one wrong case should be outvoted. Inconclusive cases
count neither way. Check args are literals the publisher typed, shared with the op: the personal
scan lists them for the publisher to confirm.

**Verify unattended.** A nightly `verify` must tell a broken spec from a site that is down, and new
breakage from old, with no one reading it. Verify is the explicit check, so a read's drift heals here
even while the op is marked stale or was healed minutes ago (`CallOptions.ignoreStale`, verify's
alone): the stored template is still what goes first, and only the guard that would answer "stale
until" is skipped, so healing stays reactive and a saved heal clears the mark as it always did. Each
recorded case carries `since`, when it began answering its current outcome: a case of the same label
that answered the same outcome last time keeps the earlier `since` (across versions of the op too,
so a failure a heal did not cure keeps its start), and a changed outcome starts over; `recordCases`
does the same for the holdout `learn_site` keeps. Nothing else about the record changes: `publish`'s
gate reads the same hash, the same cases and the same outcomes, and a record with no `since` (one
written before the field) reads as beginning at its `at`. From the record before the run and after
it, verify reports per op `newlyFailing` (a failing case now, none before, or no record before),
`recovered` (a failing case before, a record with none now; an op whose record went away is neither)
and `failingSince` (the earliest `since` among its failing cases). The exit code says what the run
found: 0 when every counted case passed, 1 when a case failed or a site could not be verified, 2
when nothing failed and a case was inconclusive, so a rate limit or an outage reads as "tested
nothing", not as a broken spec; `--strict` turns 2 into 1. A skipped op sets no exit code. Scope:
`verify [site ...]` takes several sites, none means every known one, and `--user` means the user's
own specs in `~/.api-anything/sites` (not bundled or pulled ones), the ones a signed-in session
might exist for. A read learned signed in is skipped as `needs login` without a call when the
session store says the site has no login: no login ever saved a `source`, and the jar holds no live
login cookie (the same test `call` makes before it says a guest's answer is `auth`); with a source
on record the read runs, since a call would re-import on `auth`. A write is never sent by verify
(the rules on writes forbid sending one to test it); each gets a `preflight` row instead, built with
nothing sent: whether its template `builds` from its example args and the session through
`buildRequest` (a `session:` ref no trigger run has captured, or captured for another host, says
"needs a trigger run"; a `cookie:` ref not in the jar says to log in; a required param with no
example does not build), `learnedLoggedIn` against `loggedIn` now (the same `loggedIn` test a call
makes before sending a write learned signed in; a call would re-import first), its `readback`'s own
cases' outcome in this run (`not run` for a readback that carries its own read, which verify does
not call), and `unconfirmed`: how many of the op's writes in the ledger were sent and nothing
confirmed landed (`accepted`, `may_have_applied`, or still `sending`). `ok` means every part a send
needs is in place and the readback passed. The built request is dropped, and the preflight holds no
session value. A preflight is not a case: it sets no exit code and is no part of the record or the
gate, since nothing was sent to judge; `--strict` alone exits 1 for a write whose preflight is not
`ok`, for a job that wants its writes ready too.

**Reports (`report.ts`).** After every `call()` of an op that carries a `version`, with `share` on, a
report `{hash, outcome, tier, ms}` is queued: ok → `ok`, drift and error → `fail`, auth, blocked, rate
and input as they are; a call refused before anything was sent (a write without `allowWrites`, a
duplicate) reports nothing, and a call that healed the op reports `fail` for the version it was,
whose stored request drifted. No args and no data. Reports go in signed batches of 50 to
`POST /v1/reports`, in the background, and are dropped when the registry cannot be reached: a call
never waits or fails for one. The CLI waits at most 1.5 s for the background work after its answer
is out, then stops it; the MCP server flushes every 5 seconds and on exit.

**Heal back.** When a call heals an op that was a registry version and `share` is on, the healed op
is replayed clean with its examples (`cleanCall`); when that is ok and the op is public, it is
uploaded with `parent` and `evidence.healedFrom` set to the old hash, and its new version recorded.
The registry counts it as a heal only after this install reported `fail` on the parent, so the queued
reports (the call's `fail` among them) are flushed and awaited before the upload. Otherwise it stays a
local op with no version.

**Background verification (`background.ts`).** An MCP server with `share` on that has seen no message
in or out for 60 s asks `GET /v1/verify-jobs` (signed) for candidates this install has not reported,
takes each candidate's op from the job, which carries the version and its site's `baseUrl` since
`GET /v1/sites/<site>` serves only each op's best (used only when it hashes to the job's hash; a
registry that sends none is asked `GET /v1/sites/<site>`, matched by hash; not installed, held to the
shared rules), calls it with the job's args through `cleanCall` with `publicOnly` (https to public
addresses only, every hop, as above), never with the user's sessions, and reports the outcome. A
candidate with `minTier` above 1 is skipped: plain HTTP would fail it whether it works or not, and the
report would count against it. The calls go from the user's IP address, which the setup question says.
At most 20 a day (`~/.api-anything/verify-jobs.json`); a round stops when the client goes away.

**Recorded answers (`test/fixture/sites/<site>.json`).** CI cannot reach the sites, so for every
bundled op it can, it keeps an answer trimmed to what the recipe reads: `{op, args, status,
contentType, note, body}`, the body as text or as JSON. One test in `test/sites.test.ts` checks
each one: `buildRequest` puts every arg in its slot (or a hole of another slot's template), and
`judge` answers `ok` with every field the op returns present in some item. A fixture proves the
recipe still parses that body, not that the site still answers that way. The files live under
`test/`, not `sites/`. `listSites` would read a `sites/*.json` as a spec, `pull` and `publish`
would have to carry them, and the npm package ships `sites/`. More to the point, a recorded answer
is a page as the recorder's browser saw it (their location, their language, their session), which
a maintainer trims by hand. `publish` never gathers one. The test refuses a fixture for an op
learned signed in or one that sends a cookie or session value, a body over 8 KB, and anything the
publish scans flag: `scanSecrets`'s token shapes (a JWT, a bearer, a long hex or base64 blob) and
`personalIn`'s email addresses, UUIDs and IP addresses, in the args and in the body. Trimming
rebuilds HTML from the elements each field selector matches, never whole rows, so a form's
per-visitor token does not ride along. JSON keeps a few items (with a learned `shape`, their keys
too, or the classifier calls it drift). Where a site test already built a body from a real answer
(YouTube's ad layout, Google Flights' results), that body is the fixture.

**Bundled specs.** The package's `sites/` stays an offline fallback, trusted as the package is. The
first call of a bundled site with no `version`, with `share` on, pulls the registry's copy in the
background, without the agent mark, so later calls carry a version and report. An attempt is
recorded (`~/.api-anything/upgrades.json`), so a registry without the site is asked again only after
a week.

Not in this version: signed or pinned versions on pull, checks of resolved addresses at tier 3 and a
connection pinned to the address checked, a bounded regex engine, an MCP `publish`, and the `wrong` outcome (an agent saying the data contradicted
the page).

## Logging in (`login.ts`, `import.ts`)

The easiest sign-in is the one the user already did. `api-anything login <site|url>` by default
**imports** that site's cookies from the user's everyday browser, so there is no password to type
and no 2FA/captcha to redo — the human solved those in their own browser already.

A password is never a trigger step's. A `fill` step's value is saved in the spec (and its examples),
so before it types, the run asks the page what the field is: a `type=password` input, or one whose
`autocomplete` holds `current-password`, `new-password` or `one-time-code` (through a `<label>` to
its control), fails the run with "a sign-in is the user's: ask them to run api-anything login
<site>", and add saves nothing. A hand-written step is caught without a page: `signInFills`
(`secrets.ts`) flags a fill whose selector names a password or code field (`type=password`, those
autocomplete tokens, `password`/`passwd`/`passcode`, `pass`/`pw`/`pwd`/`otp`/`totp`/`mfa`/`2fa` as a
word, so `user_pass` but not `passport`, `passenger` or `compass`)
or whose literal (outside `{param}`s) is random-looking; add's save and `export` refuse it, and
`vetShared` rejects it on pull, publish and load.

- **Chromium family** (Chrome, Arc, Brave, Edge, Chromium, Vivaldi; macOS + Linux). The cookie DB
  is copied to a temp dir first (the browser holds it open), then read with `node:sqlite`. Cookie
  *names* are plaintext, so the right profile is chosen with no decryption and no Keychain prompt;
  only the chosen profile's *values* are decrypted, so at most one macOS Keychain dialog appears.
  Values are `v10`-prefixed AES-128-CBC (IV = 16 spaces) under PBKDF2-SHA1(password, `"saltysalt"`,
  1003, 16). The password is the "<Browser> Safe Storage" Keychain item on macOS, `"peanuts"` (1
  iteration) for Linux v10. When the DB's `meta.version >= 24` the plaintext is prefixed by a 32-byte
  SHA-256 of `host_key`, which is stripped. `expires_utc` is microseconds since 1601.
- **Firefox**: `cookies.sqlite` `moz_cookies` is plaintext on every OS.
- **Windows chromium** uses app-bound encryption and is not supported: `login` falls back to the window.
- **Guest cookies**: a framework hands every visitor a session cookie named like a login
  (`laravel_session`, a Rails `_app_session`, `ci_session`, `_gh_sess`), so a name proves nothing by
  itself: a sign-in marker counts only if a signed-out visitor does not get it too. Every `login`
  first GETs the target URL with no cookies, following up to five redirects within the site, and the
  names of the cookies it is given join the session file's `guestCookies` (names only, a union kept
  across logins) when that login saves its cookies; a login that fails leaves the file as it was. A
  site whose spec pins `loginCookies` is not probed, since those names decide alone. Guest names are
  not login evidence anywhere: `loggedIn`, profile choice, the window
  check, and `learnedLoggedIn` at add and heal. A pinned `loginCookies` still decides on its own, and
  `logged_in=yes` still counts by its value. A plain fetch sees only `Set-Cookie`, never a cookie page
  script sets, but the cookies frameworks give every visitor are the server's, and a signed-out browser
  visit would cost a launch and a profile of its own. A probe that gets no answer records nothing, and
  a site never logged in has no list: the name heuristic decides there, as before. Two checks leave the
  list out on purpose, because they compare the jar with an op's `learnedLoggedIn`, which may have been
  learned with a guest name as its only login, before the list existed or on someone else's machine:
  the pre-write check below and the drift check for an op learned signed in.
- **Profile choice**: scan every profile of every installed browser for the site's `loginCookies`
  (for an unknown site, auth-looking cookie names that are not guest names, else any cookie for the site). One profile holds
  them: it is used. Several do (a work and a personal profile, or another person's account in the
  same Chrome): never a guess. `login` answers `ok: false` with each candidate's profile, display name
  and Google account email (from Chrome's `Local State` `profile.info_cache`) and a `next` of
  `api-anything login <site> --profile "<Browser/Profile>"`. Only cookies whose domain is the site's
  are read. The chosen source (`"chrome:Profile 1"`, `"window"`, `"file"`) is recorded in the session
  file, and success prints the profile's display name and account.
- **Targets**: a site name, a domain (`linkedin.com`, `www.linkedin.com`) or a URL. A domain or URL
  on a known site's baseUrl host (with or without `www.`) is that site; any other becomes a site
  named after its host.
- Imported cookies go into the jar **and** into api-anything's own browser profile (`addCookies`), so
  tier 2/3 and heals are logged in too.
- `--window` opens a visible browser window on api-anything's profile for a by-hand sign-in (an
  independent session). It is also the automatic fallback when nothing is importable. The site's
  cookies are read as the window opens, before its page loads, and then while it is open: on every
  response (where a `Set-Cookie` lands) and every half second (for one a script sets), and once more
  on Enter. Of the reads that completed while it was open, the newest started is kept; one still in
  flight when it began closing never counts, nor does any read after. Closing Chrome's last window on
  Linux or Windows quits it, and a quitting Chrome's jar has already lost its session cookies, often
  the login among them (CI caught this). The sign-in counts
  only when a login cookie (not a guest name) appeared or changed in between: a profile that already
  held one proves nothing, since it may be the very cookie the site has signed out. Then the jar is
  replaced and `login` answers `ok: true` with the `renewed` names. Otherwise it answers `ok: false`
  with why (no login cookie appeared, or the ones held at opening did not change) and keeps the stored
  session. The window does not close itself when a login cookie appears: a site can set its session
  cookie before a second factor, a consent page or the redirect back from an identity provider is done,
  and closing then would keep a half-finished sign-in. The human closes it, or presses Enter. Its
  dialogs (popups included) are answered for it, since Playwright takes them from the human: a
  `beforeunload` and an alert are accepted, so leaving or closing a page is never refused, and a
  confirm or prompt is declined, as Playwright's default would. A site
  whose only login cookie is one every visitor gets cannot be told apart by name: list that name in the
  spec's `loginCookies`, and a change in it counts.
- `--cookies <file>` imports a `cookies.txt` (Netscape) or JSON array (Cookie-Editor / Playwright)
  export, for servers/CI with no browser.
- **Self-healing auth**: when a call classifies `auth` and the session came from a browser import,
  exactly the recorded profile is silently re-imported once (browserless) and the call retried (a write
  only when it certainly did not run, so never one the page sent at tier 3). The retry happens only
  when the re-import renewed something: login cookies the jar did not hold, or held with other values.
  For a site where neither side holds a cookie any rule names as a login, any changed cookie counts. The
  same dead cookies again would only get the same answer, and `api-anything login` would import them
  once more, so a call still `auth` after a re-import from a browser profile says where to sign in
  instead: `ask the user to sign in to linkedin.com in Chrome profile "Work" (me@example.com); then
  retry once`, with `nextCall` `{action: "sign_in_browser", profile: "Chrome/Profile 1"}` and `retry`
  `after_fix`. Other sources keep the "run `api-anything login`" hint. This runs at tiers 2 and 3 as at
  tier 1: the import also lands in the browser profile those tiers send their cookies from.
- **Import results**: `login` by import reports `loggedIn` (guest names aside) and `renewed`, and a
  `warning` when the imported cookies show no sign-in ("Chrome profile "Work" looks signed out") or are
  the login cookies the session already held, so nothing was renewed and a call that said `auth` will
  say it again. It still answers `ok: true`: the cookies were imported and saved.
- **Before a write**: a write learned signed in whose jar holds no live login cookie (expired, or never
  there) is not sent as it stands. The recorded browser profile is re-imported first; if there is still
  none, the call answers `auth` with `write: "not_sent"`, and the reason says so. It comes before the
  duplicate guard records the write, so a call that sends nothing leaves nothing for a repeat to be
  held back by. Nothing sent means the send-once rule is untouched. This check ignores `guestCookies` (see above), so a guest's write still
  reaches the server, whose 401 or 403 is retried as any write's is.
- **`logout <site>`** clears the jar and that site's cookies in the profile.

`node:sqlite` is chosen over the `sqlite3` CLI: it is built in (no dependency, present on every
Node ≥ 22.13, which the `engines` floor now requires; its one ExperimentalWarning is silenced) and
returns the encrypted BLOB as bytes directly, where the CLI would need `hex()` plus escaping of
binary output. An imported session is the **same** session as the everyday browser: if the site
revokes it, both are logged out, so heavy headless automation on it is avoided; `--window` is the
independent alternative.

## Agent interface

- **CLI** `api-anything`:
  - `login <site|url> [--profile "Chrome/Profile 1"] [--window] [--cookies <file>]`, `logout <site>`
  - `capture <url> [--steps ...] [--interactive]` prints a compact, noise-filtered list of candidate
    requests with ids. Its `next` recommends the learn step, unless the page is a bot challenge, a
    sign-in page, or an HTTP error that is itself the best candidate (an erroring document that loaded
    a usable data request is reported as `pageStatus`, and the request is recommended). "Sign-in page"
    is said in one case: the navigation ended on a login path and the final document shows a sign-in
    form. Any other page that shows a sign-in form (a public page's login box; a login page served in
    place) gets the recommendation, with a clause that says so, redirect or not; the clause is stronger
    when `--example` values were given and no candidate's response holds one. A candidate's URL can
    carry a live token (`?access_token=...`): each of the run's cookie and web-storage values in it
    (not one equal to an `--example` value) is shown as the ref a spec would hold there,
    `[cookie:auth]` or `[session:x]` (`redact` with `named`, `captureLive`). `learn_site`'s `chosen`
    and `alternatives` URLs are shown the same way, and so are the request URLs and bodies `inspect`
    shows (keeping its `--example` values). None is `data`, which stays the site's answer
  - `add <site> <op> --trigger <url-template> --example k=v [--example2 k=v] [--match ...] [--pick ...] [--paging ...] [--write]`
  - `call <site> <op> [k=v ...] [--allow-writes] [--again] [--idempotency-key <k>] [--force]` (`--force`: send while the site cools down; a success ends the cool-down)
    accepts `--json -` for an args object on stdin (at most 4 MiB); positional `k=v` overrides its keys.
  - `batch [--input <file> | -] [--concurrency 1..4] [--limit 1..200] [--max-tier 1|2|3]`
    reads JSONL `{id?, site, op, args?}` from the file or stdin (the default). `batch.ts`'s
    `callReads` delegates every valid item to `call()` with writes off and no cool-down or pacing
    override. A write's refusal becomes `input`, `"writes are not batched"`, `write: "not_sent"`;
    no batch entry point takes `allowWrites`. Results are `{id, site, op, ...callResult}`, in input
    order, with every retry, paging and truncation field intact, never the input args. An omitted id
    becomes its 1-based input position. The default is sequential; concurrency is at most four
    different sites, and one site's items (case variants included) never overlap or change order.
    This keeps `store.ts`'s send slots and lets a call record its cool-down before that site's next
    item checks it. Valid reads during a cool-down answer from it without sending. Other failures
    do not stop later items. No caching, automatic pagination or retry of an entire batch.
    Sites must be installed first; a batch does not pull them implicitly. The whole input is bounded
    before any call: at most 200 lines (a lower `--limit` only), 4 MiB. An oversized input fails as a
    whole; a malformed or blank line gets its own `input` result, without quoting its contents. A
    final newline is not another line, and empty input emits nothing. Exit 0 when every item is ok,
    otherwise 1.
  - `inspect <captureId> [requestId]` reads a saved capture with no browser, through `add`'s recipe
    flags (`--extract`, `--pick`, `--html`, `--embedded`): what the recipe would return, or a failure
    when a path or selector finds nothing (an empty list at a path is a result, and so is an `--html`
    items container that is on the page with no item in it, or the recipe's `empty` element shown on it, as the
    classifier judges a call); JSON inside strings (batchexecute
    payloads, a form's `f.req`) is shown decoded, in the response and the request body. Every `add` saves its trigger runs as
    captures, so a recipe is fixed without Chrome: `add --from <id>` on an existing op with the recipe
    flags. There is one way an op is learned, and this is it: with no `--example`, what the command
    leaves out is taken from the stored op (its examples; its recipe when no recipe flag is given; its
    description; a `minTier` an earlier two-run diff raised), so its params are never silently dropped
    and the credential checks and the session kept are those of any add. The capture must carry the
    stored example values where the op takes them: when it does not, or carries them somewhere else
    (the op's example user as the viewer of another's page), the add is refused and says to pass
    `--example` with the values the capture was made with. Learning an existing
    write again without `--write` is refused before any browser run, never saved as a read. So is
    learning a request that a `--write` capture aborted, under any op name: the guard stopped it as a
    write, and that verdict counts, not the method (a POST the capture let through is a read). Captures hold
    full responses and the run's cookie values (one page can be tens of MB), so each new one prunes
    the directory to the newest 20, none older than 24 h.
  - `capture --outline` / `inspect --outline` (the explorer's scout, `outline.ts`): for the top
    candidates, a compact summary instead of the body — where the example values sit, a suggested
    extract and pick fields with samples, JSON the page embeds (JSON-LD, `__NEXT_DATA__`,
    `application/json` scripts, `window.X =` state) with a ready `--embedded` regex, a repeated
    HTML list holding the example as a ready `--html` recipe, and labelled texts on a detail page.
    Deterministic and site-agnostic; the agent reads it instead of inspecting bodies. Paths through
    id-like keys (Apollo's `Book:kca://...`) are flagged, since they don't generalize. The list and
    the labels, like an `--html` recipe's extraction, read the page as it shows (`parseShown`):
    without script, style, noscript and template, and without elements hidden by the `hidden`
    attribute (not `until-found`) or an inline `display:none`/`visibility:hidden`. Text the agent
    reads and the user never sees is where an injected instruction hides. `aria-hidden` stays: it
    hides only from screen readers and is often the visible copy (a rating shown beside its spoken
    label). A stylesheet's hiding is not computed.
  - `verify [site ...] [--user] [--strict]` (health-checks every read op with its example and checks,
    healing as needed, stale mark or not; preflights every write without sending it; exit 0 pass,
    1 fail, 2 inconclusive only; see Verify unattended)
  - `readback <site> <write> <read> [k=v ...] [--find field=value]` (how a write's call proves it
    landed; see Writes)
  - `sites`, `ops <site>` (params with their description and format, `returns` where the recipe names them: the keys a result item
    can carry, read from the op's `pick`, else from an HTML recipe's fields when no `extract` reshapes its
    items, so it cannot disagree with the recipe; a key the site leaves out is absent, and the site's notes: `<site>.md` beside its
    spec, the user's copy first, up to its `## Maintainer notes` heading; the rest of the file is
    for people working on the spec), `heal <site> <op>`, `export <site>`, `mcp`
  - `ops <site> <op> --schema` describes the stored operation without a call:
    `{site, op, description?, readOnly, params, output: {cardinality, fields}, links?}`. `params` is the same JSON
    Schema MCP advertises. Cardinality is `list`, `one` or `unknown`, derived from the response
    recipe and stored learned shape, never the op's name or prose. A field has an optional `type`
    and `source` (`declared` by an HTML/pick recipe, `observed` in the stored learned shape, or
    `unknown`). Hints describe the extracted data, not the call envelope; no values are coerced
    and no response samples are gathered for discovery. A shape stripped on export leaves the
    corresponding hints unknown. A learned `null` also stays unknown: the shape uses it for a
    field absent from some items, not only a JSON null.
  - All output is JSON-first, compact, and ends with a `next` hint on failure.
  - A call's result says what happened in fields as well as prose: `retry` (`safe`, `after_wait`,
    `after_fix`, `no`), `retryAfterMs`, `nextCall` (`{action, site, op}`, with `mode` for a window
    login, `tier` for a raised cap and `profile` for a browser sign-in; actions `retry`, `login`,
    `sign_in_browser` (the user signs in again in the everyday browser profile `profile`, since a
    re-import from it brought back the same cookies: "Self-healing auth" under Logging in), `heal`,
    `relearn`, `fix_args`, `list_sites`, `check_site`, `allow_writes`, `raise_tier`,
    `install_browser`, `report`), for a write `write` (see Writes), and for a paged read
    `nextPage` and `hasMore` (see Response extraction). `next` stays, for a reader; `nextCall` is
    the same step for a
    program. `test/execute.test.ts` checks the fields over every class, a read and a write, and
    what was sent.
- **MCP server** (`api-anything mcp`) with fixed meta-tools: `list_sites`, `find_sites`, `list_operations`,
  `call_operation`, `call_batch`, `get_result` (local result views, above), `get_job`, `site_status`
  (`status`, see the call log), `login` (so an agent can fix an `auth` failure itself) and `learn_site`
  (`mcp-learn.ts`), plus `call_write_operation` on a server started with `--allow-writes`, so the tool list costs the same at 2 sites or 200. `find_sites` is `search` (see
  Sharing specs): each match's ops with their params, lexical coverage, registry health and local
  verification, `nextCall` `{tool: "list_operations", args: {site}}` for the best match, or
  `{tool: "list_sites", args: {}}` with none;
  `list_operations`, `call_operation` and `call_write_operation` on a site that is not installed pull it from the registry first
  (see "Agents pull"), and `list_operations` shows each op's registry status. `learn_site` (CLI
  `learn`, `learnsite.ts`) learns a read with the user's args, the agent's second and third values, a
  holdout call and a clean replay, then shares it (see Sharing specs). Before any browser runs, unless
  the agent relearns (`fresh: true`, captures, `pickRequest` or a recipe), it looks for a read already shared for the
  same page: the registry's site for the trigger's registrable domain (`sharedName`; a user's own copy
  under that name is looked in as it is) and an op whose `trigger.url` is the same page (`sameTrigger`:
  host without `www.`, each path segment and query key, placeholders at the same places whatever their
  names, which map the user's args onto the op's params). It is pulled with `by: "agent"`, so every rule
  for a pulled spec applies, and called through `call()`; data answers with `reused: {site, op, status}`
  and nothing is learned or uploaded (its `next`: call it from now on, or `fresh: true` to learn
  your own), and the call's report (with `share` on) is a confirmation. No
  match, or a call that fails or answers nothing, learns as before. Search words never find a site with
  only candidates, and two independent learns never hash the same, so without this step nothing a
  newcomer used would ever collect confirmations. It refuses a write, and a chosen
  request (automatic or `pickRequest`) that the shared rules would refuse as a read or whose method is
  not GET or HEAD (a GraphQL query sent as POST excepted; a GraphQL POST with no query document, a
  persisted query named by a hash or an id, is refused since it may be a mutation), before the holdout
  call or the clean replay sends anything; the automatic pick passes over such a request for one that reads. It takes `steps`
  (as `add --steps`: a click on "Show more" loads page 2) and `paging` (as `add --paging`); see
  "Paging found in a capture" under Learning. Over MCP the trigger, and every `goto` step's address,
  must pass `badAddress` (page text may steer the agent to a page on this machine or the local network);
  the CLI takes any address, the user typed it. A new site's default name is a site this machine has on
  that host, else the name the registry already serves its registrable domain under (`sharedName`, a
  search for the domain; a seed keeps its own name, goodreads.com is `goodreads`, and a new op under a
  parallel name would go to review), else what the registry names a new site: the domain with dots as
  dashes (`slugOf`: crates.io is `crates-io`). A local site goes up under its own name when it is pulled
  or bundled or the registry serves its domain under that name, else under the slug (`registryName`,
  `uploadName`, asked only when something may go up), and the share outcome's `as` names it. `find_sites` shows every match's `domain`, local or the registry's; its description and
  `next`, `call_operation`'s description and the skill tell the agent to check it is the site the user
  means before calling, since a name or description can imitate another site. When a share
  needs the user's yes, the prompt (MCP elicitation or the CLI's) and the `next` that tells the agent to
  ask list the upload's `personal` items. With `share` on, an
  idle server verifies a few candidates a day and flushes call reports (see Sharing specs). The agent may be steered by page content, so MCP `login` import
  only refreshes a site that has a spec and a browser source a human chose with the CLI, from that
  same profile; anything else answers `next`: ask the user to run `api-anything login <site>`. Mode
  window is allowed (a human signs in). So an `auth` result points at the login tool (`next`, and
  `nextCall.tool`) only for a site the user imported; for any other it says to ask the user to run
  `api-anything login <site>` in a terminal (their browser's cookies, no password) or `--window`, and
  `nextCall` names no tool, rather than a step that would only fail. A `blocked` result's window mode
  needs no import and keeps the tool. MCP cannot create operations: capture and add are CLI only.
  - **Reads and writes are separate tools**, because MCP hints are per tool and clients act on them:
    Codex and VS Code skip the approval prompt for a `readOnlyHint` tool and ask for a
    `destructiveHint` one, and Claude Code and Codex run read-only tools in parallel. One
    `call_operation` that also sent writes had to be advertised destructive on a writes-enabled
    server, so every read asked for approval. `call_operation` is read-only, idempotent and
    non-destructive on every server, and sends with writes off whatever the server allows: a write
    op is `refused` and nothing is sent, and on a writes-enabled server its `next` and `nextCall`
    name `call_write_operation` with the same arguments. `call_write_operation` is destructive and
    not idempotent, takes `again` and `idempotencyKey`, and refuses a read (`input`, pointing back
    at `call_operation`), so a read never meets the write prompt. `list_sites`, `list_operations`,
    `get_job` and `site_status` are read-only, idempotent and closed-world (`find_sites` is read-only and open-world); `login` changes the local session,
    never the site (not read-only, not destructive, idempotent: a repeat joins the first). Every
    tool sets all four hints, since the spec's defaults for an unset one are the pessimistic ones.
    The split costs a second tool name; the package was not published with the single tool.
  - `list_operations` gives each op its `returns`, an `inputSchema` (a JSON Schema object of its
    args: `type`, `enum`, `minimum`/`maximum`, `pattern` anchored as `^(?:p)$` since a spec's
    pattern matches the whole value, `default`, `examples`, the format `hint` in `description`,
    `required` for a required param with no default, `additionalProperties: false`), the site's
    notes, `pages` and `readback` as `ops` shows them, and `shared` for a pulled spec. A per-op tool's
    description says the same, and the call tools name `nextPage`/`hasMore` and write `applied`. The schema replaces the old `params` list, so each param
    is sent once.
    It also gives the shared description's `output` hints and optional `links`.
    `list_operations {site, prepare: {op, link, item, args?}}` prepares a declared link (zero-based
    index) from one item the agent selected, returning `nextCall: {tool: "call_operation", args:
    {site, op, args}}`. The site must already be installed and the target a read; preparation does
    not pull or call anything. Target defaults and explicit extra args fill the remaining params;
    missing required params are an input error, never filled from examples or guesses.
  - **Per-op tools**: `mcp --sites a,b` also registers each op of those sites as a tool of its own,
    `<site>__<op>` (any character outside `[A-Za-z0-9_-]` becomes `_`), taking the op's args
    directly with its `inputSchema` and a read's or a write's hints; writes only with
    `--allow-writes`. The model calls it without `list_operations` first, at about 200 tokens of
    tool list per op, sent with every request (the five meta-tools are about 950; goodreads' five
    ops add about 1,000, all 25 bundled ops about 5,700), which is why it is opt-in. A name is at most 40 characters (Gemini
    CLI cuts `mcp_<server>_<tool>` past 63, and Cursor is reported to drop a tool whose server and
    tool names pass 60); a longer one is cut and ends in 8 hex characters of a hash of the whole,
    so two stay distinct. The description is the op's, the keys its items carry, and where its
    notes are; a pulled spec's starts with `SHARED_NOTE`, since a tool description is text the
    model weighs more than a result. The args are judged by `call()`, not the SDK: the advertised
    schema is the model's guide, and a refusal comes back as `class: "input"` with the format and a
    next step, as through `call_operation`. A per-op write takes no `again` or `idempotencyKey`
    (they could collide with a param's name): those go through `call_write_operation`.
  - **Jobs** (`jobs.ts`). No client resets its tool-call timeout on a progress notification (the
    spec allows it; Codex only logs them, Gemini CLI and VS Code show them; Claude Code counts
    them only against its idle timeout), and some stop a call at 60 s (Claude Desktop, reportedly;
    Codex before its default became 300 s). A call that heals or runs the page, or a sign-in window
    the user is still using, can take longer, and an agent that never sees the answer may log in
    again or send a write again. So a tool call (`call_operation`, `call_batch`, `call_write_operation`, a per-op
    tool, `login`) that is still running at 25 s answers
    `{ok: false, class: "pending", job, reason, next, retry: "no", nextCall: get_job}`, with
    `isError` false (nothing failed), and keeps running. `get_job {job}` waits up to 25 s for it and
    answers its result, or pending again; it never runs the call again, and a finished job's result
    is kept 15 minutes. A call identical to one still running (the same tool, site, op and args;
    a write's `idempotencyKey` too, but not `again`) joins it instead of running beside it: a
    second `login` for a site while its window is open answers that window's job (whatever the
    mode), and a write still on its way is not sent twice. Jobs live in the server's memory and end
    with it. A plain HTTP call answers in milliseconds and meets none of this: a job is only named
    once its deadline passes. The 25 s leaves room under a 60 s client for `get_job`'s own wait. A
    sign-in window nobody closes is closed after 10 minutes, so it does not hold the browser
    profile. There is no `cancel_job`: a call cannot be stopped midway without leaving a write in
    an unknown state, and the user closes a window themselves. The MCP tasks extension
    (`taskSupport` in the SDK) is the protocol's version of this, but clients do not send task
    requests yet.
  - A `next` served over MCP names the tools (`list_operations {"site":"x"}`, the
    `login` tool) instead of CLI commands, and tells the agent to run a CLI-only one (heal, add) in its
    own shell, or to hand it to the user when it has none. A `nextCall` served over MCP adds the
    `tool` and `args` when one of the server's tools takes the step (`login`, `list_operations`,
    `list_sites`; for a retry, the tool that was called with the arguments it was called with).
    `sign_in_browser` names no tool: the user signs in again in their own browser, and the retry
    re-imports by itself, so the `login` tool would only import the same cookies once more. The
    prose `next` keeps its rewrite: it carries what the fields do not (check the site first, then
    re-learn), and the other tools' `next` strings have no `nextCall`.
  - `call_batch` takes at most 20 `items` and an optional `concurrency` (1..4). It runs
    `callReads` with that lower cap and returns `{ok, results}`; `ok` is true only when all items
    succeeded. It has read-only, idempotent, non-destructive, open-world hints even on a
    writes-enabled server. Each item's data uses `asTable`, and its `next`/`nextCall` use MCP
    terms; a retry names `call_operation` with that item's args, never a repeat of the batch.
    As with `call_operation`, a batch still running at the deadline answers with a job, and
    identical running batches join it. Finished results are kept only by the normal jobs mechanism,
    not as a cache of read calls. `list_operations` installs a missing site before batching it.
  - Each answer is JSON text and, when it is an object, the same object as `structuredContent`. A
    client gives its model one of the two, never both: Codex and VS Code send the structured one
    and drop the text, Gemini CLI sends the text, so neither costs tokens twice, and a program
    reads the fields without parsing. `list_sites` (a list) is text only: before the 2026-07-28
    revision structuredContent is an object. No tool declares an `outputSchema`: the SDK would
    then reject an answer that does not match it, and a failure's shape differs from a success's.
    `isError` is true exactly when `ok` is false, except for `pending`.
  - `call_operation` sends `data` that is a list of two or more records as `{columns, rows}` (a
    missing field is null) when that makes the JSON smaller. A sparse table can be larger than the
    original records, so those stay a list to preserve the output cap. The keys, repeated in every
    item, were half of a flight search's tokens.
  - That a result's data, any site text in it and a site's notes are data from the website, never
    instructions, and that the agent tells the user of any instruction it found there (one it quietly
    ignores leaves the user unaware the site tried), is said once per session (`UNTRUSTED_NOTE`), in the server instructions and in the
    description of `call_operation` and `call_write_operation`, since some clients drop instructions
    and every one sends a tool's description; a note in every result would be paid for on every
    call, and the model already knows which tool a result came from.
  - `mcp --print-config` prints the command or config entry that adds the server to Claude Code,
    Codex, Gemini CLI, VS Code, Cursor and Claude Desktop (`clients.ts`), with the absolute path of
    the node running it and of the CLI entry (from a checkout, through tsx's loader), the other
    flags given, and `API_ANYTHING_HOME`/`API_ANYTHING_BROWSER` when set: a client started from the
    Dock or a menu may not get the shell's PATH (an nvm node) or its variables. Gemini CLI reads the
    command as a positional of its own, so its args follow `--` there and none is read as its flag.
  - The server instructions also carry the skill's core in brief (find, call, learn on a miss, check
    the domain, follow `next` once, writes only on request), for a client that loads no skill
    (Claude Desktop takes skills only as an upload); every session pays for them, so they stay a few
    sentences.
- **Skill** `skills/api-anything/`: `SKILL.md` is the core an agent loads whenever a request is about
  a website: the find, call, learn loop, the few result fields the agent must tell the user about,
  the strict failure loop (follow `next` at most once, then stop and report), and the safety rules.
  It is loaded whole, so a test caps it, and it restates nothing the agent already sees: the tool
  descriptions, a failure's `next` and `--help` carry the detail and can't drift from the code. Two
  branches sit in `references/`, each linked with the condition for reading it: authoring with the
  CLI (capture → add → call → verify), and writes. A test holds that every link resolves. `setup`
  copies the folder to
  `~/.claude/skills` (Claude Code) and `~/.agents/skills` (Codex, Cursor, Gemini CLI, VS Code) and
  records where (`skill.ts`). Each copy carries a stamp, `.api-anything.json`: the version and a hash
  of the files. Since the server runs through `npx -y api-anything`, it is always the latest release
  while a copy is not, so any CLI start (the server's included) replaces a recorded copy that an
  older version wrote and nobody edited. An edited copy, a link, a newer version's copy, and a
  same-version copy with other files (a checkout beside a release) are left alone. A copy from before
  stamps is backed up to `~/.api-anything/skill-backups/`, never beside it, where an agent walking
  its skills folder would load the backup as a second skill. An install with its own
  `API_ANYTHING_HOME` refreshes only the copies its own setup recorded.
- **Claude Code plugin** manifest (skill + MCP), its version held equal to the package's by a test,
  plus copy-paste install lines for Codex and other agents.
- Library: `import { call, callReads, closeBrowser } from "api-anything"`. `callReads(items, opts)`
  is an async iterable of `BatchResult`; `BatchItem` and `BatchOptions` are exported too. It takes
  an array of at most 200 items, `maxItems` to lower that cap, `concurrency` (default 1, at most 4),
  and the call options `maxTier`, `timeoutMs`, `fetchImpl`. Invalid bounds or too many items throw
  before any call; invalid items fail individually. Breaking iteration starts no further calls
  and waits for those already running to finish.
- Library: `call`, `describeOperation(siteSpec, op)`, `prepareLink(siteSpec, sourceOp, item, link,
  extraArgs?)`, and the existing safe registry reads `search(query)` and `pull(site)`.
  The description builder is shared with MCP's input schema; the link helper returns complete
  `{site, op, args}` without executing, validating/coercing values, or granting permission for a
  write. A later `call` still enforces every arg and write rule.
- Embedded hosts: `api-anything/host` exposes local-only discovery (`hostSites`, `hostSite`),
  redacted request planning (`planCall`), approval-bound execution (`callPlanned`), `setBundledDir`
  for a compiled host's extracted specs, and `closeHost`. Every host call sets `callOnly`: no
  learning, healing, everyday-browser import, registry traffic, reporting or background work.
  Installed specs remain unchanged. The transport ladder, own-profile sessions, write ledger and
  readback, pacing, cool-downs, local logs and result caps stay in use. See [HOST.md](HOST.md) for
  approval binding, dynamic-value placeholders and the Bun export condition.

## Non-goals (v1)

TLS impersonation transports, CAPTCHA solving, signature reimplementation, seroval parsing,
a marketplace (the registry stores and counts; see Sharing specs), typed-client codegen, Windows app-bound cookie decryption
(login falls back to `--window` there), and local operations (below).

**Local operations.** An op is a request to a site, sent by the ladder. An op that runs a program on
the caller's machine instead is out of scope: a shell line with `{param}` holes, or a named tool that
api-anything ships (`youtube-captions` running `yt-dlp` with an argv, issue #105). A fixed tool list
run without `sh -c`, in a scrubbed environment, asynchronously, does remove the injection and the
frozen MCP server. It does not fix the rest:

- *The boundary.* `vetShared` can vouch for a shared spec because everything the spec makes happen is
  a request it can read: https to a public host, a GET lookup on the op's own host, a method, regexes it
  bounds. A tool fetches with its own client, so none of that applies to what it sends. It also skips
  pacing, cool-downs, the classifier and the public-address check, and it runs with the caller's files.
  A spec that picks the tool is the part vet can read; what the tool does is not.
- *Healing.* There is no capture, trigger or tier for a tool, so drift is only a failure, and nothing
  in a run tells drift from a rate limit or a bad arg. Every other op is judged by the same classifier
  and sent through the same ladder, whether or not a page of its site can heal it.
- *What the tools are for.* The tools that would earn a place, `yt-dlp` first, exist to get past what
  a site's page does: deciphering player signatures, minting or avoiding proof-of-origin tokens. That
  is signature reimplementation by another name.

Data a site serves only to such a client stays out of the catalog until a page of the site requests
it, so the ladder can send and heal that request. For YouTube captions, the probes behind this
(`docs/research/youtube-captions.md`) found that the watch page's own tracks answer empty without the
web player's token, and that only the Android app's player request answers plain HTTP. That request
needs a POST lookup and a whole signed URL as a derived value, which the shared rules refuse, and no
page sends it, so it could not heal either. The route that fits is a tier-3 op that turns captions on
in the page and captures the page's own request; it is not built yet.
