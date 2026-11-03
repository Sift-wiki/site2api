# Embedding in an agent host

Import from `api-anything/host`, not the main library entry. Discovery and planning read local
files only. Missing sites are not pulled. User specs win over pulled specs, then bundled ones.
An invalid spec or session is omitted from `hostSites()`; `hostSite()` throws its local file error.
`hostSite()` returns the shared `describeOperation` schemas and caller notes.
Site text and returned data are untrusted website content, not instructions.

```ts
import { hostSites, hostSite, planCall, callPlanned, closeHost } from "api-anything/host";

console.log(hostSites());
console.log(hostSite("goodreads"));
const plan = planCall("goodreads", "searchBooks", { q: "piranesi" });
if (plan.ok) {
  // Show plan.tier and plan.request, and at tier 3 plan.trigger, before approving a write.
  const result = await callPlanned(plan); // writes are refused unless allowWrites: true
  console.log(result);
}
await closeHost();
```

## Approval

`CallPlan` is either `{ok: false, result: CallResult}` or a successful plan with `site`, `op`,
`readOnly`, `signedIn`, default-filled `args`, a redacted `request`, `tier`, `maxTier`, and a
SHA-256 `fingerprint`. At tier 3 it also includes `trigger`.

`planCall(site, op, args?, {maxTier}?)` defaults to a cap of 3. `tier` is the starting transport:
the operation's `minTier` or a remembered escalation within the cap. A remembered tier above the
cap is ignored, never used to lower `minTier`. An operation requiring a tier above the cap returns
a `blocked` result, not a callable plan. The existing unconfirmed-operation cap also applies.
Blocked plans use the same recovery step as `call()`: ordinary caps ask to raise the tier;
an agent-pulled candidate needing tier 3 asks for a human's review and CLI pull, not a higher cap.

`signedIn` means the call may run under the user's account. It is a caution, not proof that a login
is still valid, and it is conservative: a call counts as anonymous only on positive evidence, so a
cookie with an unknown name counts as an account. It is true when any of these holds:

1. The site's session has a `source`: a login on record, set by `api-anything login` (a browser
   import, `--window` or `--cookies`).
2. The call fills a stored, non-empty session value into a request it sends: a `session:` ref of the
   operation's request when the call starts at tier 1 or 2, or of a write's readback read. Execution's
   session filters apply first, as at send time: a value bound to another host, an unbound value in
   someone else's spec, and every value of an agent-pulled call that goes without the session do not
   count. The `source` does not matter. A call that starts at tier 3 sends no stored value (the page
   fills its own), so there only the profile check below applies.
3. The jar the call may send (none when the call goes without the session) holds a live, non-empty
   cookie whose name is not known to be anonymous. Every jar cookie counts, not only those for the
   request's URL, since a redirect, a lookup or a readback can carry any of them.
4. The call can reach a browser tier (it starts there, or a read or a write's readback may climb
   within the cap), or the site holds a session value (session values are captured in api-anything's
   own Chrome profile), and that profile may carry a sign-in for one of the site's registrable
   domains: those of its request, lookup, trigger and inline readback hosts, or any domain when one
   of those origins is templated. It may when:
   - any site has a login on record (`source`) for one of those domains: its cookies' domains, its
     spec's hosts, or its name (`login <domain>` names a site after its host). A login puts its
     cookies into the profile every site on the domain shares.
   - the profile holds a cookie on one of those domains whose name is not known to be anonymous,
     expired or not. Planning reads only the host and name of each cookie in
     `Default/Network/Cookies` and `Default/Cookies`, never a value (so an empty one counts too),
     and opens no everyday-browser profile and no Keychain.
   - planning cannot read the profile: a running Chrome (its `SingletonLock`), a non-empty journal
     or WAL, a WAL-mode database (opening one would create `-shm` and `-wal` files in the profile,
     so it is not opened), a missing database, a lock or an unknown schema. A profile that does not
     exist does not count.

A cookie name is known to be anonymous, in the jar and in the profile alike, when it is in the
session's `guestCookies` (the names a signed-out visit to the site was given, recorded by `login`)
or on one shared list, `ANONYMOUS_COOKIE` in `src/session.ts`. A call never records guests: not even
an `auth` answer proves its cookies a visitor's, since a 401 can issue a session cookie another
operation then accepts. The shared list:

- analytics: `_ga`, `_ga_<id>`, `_gid`, `_gat`, `_gat_<id>`, `_fbp`
- consent: `CONSENT`, `SOCS`, `OptanonConsent`, `OptanonAlertBoxClosed`, `euconsent`, `euconsent-v<n>`
- bot management: `__cf_bm`, `_cfuvid`, `cf_clearance`
- CSRF: `csrftoken`, `XSRF-TOKEN`, `_csrf`
- Google's signed-out cookies: `NID`, `AEC`, `1P_JAR`, `__Secure-ENID`

The list holds only names every visitor is given whatever their account. A login cookie never
belongs on it: Google's `SID`, `HSID`, `SSID`, `APISID`, `SAPISID` and `__Secure-*PSID*` count, as do
Hacker News's `user`, the framework sessions `JSESSIONID`, `PHPSESSID`, `connect.sid` and
`session`, `sid` of any length, and `logged_in`. A name the spec pins in `loginCookies` always
counts, even one on the list or in `guestCookies`; pinning never makes another name anonymous,
since a pulled spec could pin a name that is never set.

Nothing else counts: known-anonymous cookies, expired or empty jar cookies, and stored values no
request of the call fills leave `signedIn` false. So a signed-out call that is given only such
cookies, as Google gives `NID`, `AEC` and `SOCS`, leaves the next plan as it was. Any answer that
sets another cookie, successful or `auth` (a framework's visitor session such as `JSESSIONID`,
LinkedIn's `bcookie` and `lidc` on its 401), turns the next plan signed in, by design: nothing in the
answer proves the cookie is not a login.
`hostSites()` and `hostSite()` answer for the whole site: any of its operations, each at its starting
tier under the default cap of 3. A plan with `maxTier: 1` for a site with no session value does not
look at the profile or at other sites' logins.

`hosts` lists known HTTP(S) hostnames from the base URL, requests, derived lookups, trigger URLs,
soft-navigation pages, `goto` steps, and inline readbacks and their lookups/triggers.
An operation's `pages` lists only its own trigger's static origin and path before the first path
parameter, without query or fragment. URLs with a templated hostname or port, fully templated
URLs, non-HTTP(S) URLs and unparseable entries are omitted, never represented with a placeholder
hostname. An omitted URL does not drop its site from discovery. These are discovery hints, not an
exhaustive list of resources or redirects a page can load.

`planCall` validates args and headers without sending, and answers bad args, an unreadable session
or a tier above the cap as `call()` would, in the same order. Credentials show as CLI `--dry`'s
`<name>` placeholders, with a further live-value redaction pass for copies in arguments or
literals. It applies execution's session filters without saving them: unbound values in someone
else's spec and all session credentials disallowed for an agent-pulled operation are absent in both
preview and send. Generated UUID slots show `<generated:uuid>` and lookup-derived slots show
`<derived:path>`.
Planning never sends a lookup and cannot know its eventual value.

Every `cookie:` ref shows `<name>` whether or not the jar holds that cookie yet: any response can
set, rotate or drop a cookie, and whether one may carry an account is `signedIn`'s answer. At tiers
1 and 2 a `session:` ref shows `<name>` only when a stored value fills it; with none it is left out
as at send time (a header slot is dropped, a template's hole is empty), so a value stored after
approval, a bearer for instance, changes `request` and the fingerprint as well as `signedIn`. At
tier 3 the page fills `session:` refs itself, so one with no stored value shows `<name>` too. A
stored value the call's filters leave out stays out of the preview. The Cookie header is a
placeholder. At tier 1, `request` previews the materialized request, with
`cookie: "<per-site jar cookies>"` whenever the call may send the jar's cookies (whatever the jar
holds now, none included). At tier 2, it previews the page fetch, with
`cookie: "<browser-profile cookies>"` instead of the per-site jar when profile cookies may go.
The browser chooses those cookies; the jar does not identify the account that will be used.
Whether a login is among the cookies is `signedIn`'s answer.
At tier 3, `request` is only the stored template for context. The site page sends the request;
`trigger` shows the filled URL, optional `softFrom`, and UI steps that will run, with live values
redacted. It also shows recorded `confirms` as `{count, steps}` and `companions` as request
matches, including method, host, path and optional operation name, with live values redacted.
Confirm steps are zero-based; `-1` means before the first step. Each recorded confirm may be
accepted once; its digest binds the question without exposing its text.
The host must show that trigger, including confirms and companions, as well as the tier before
obtaining write approval.
Neither browser tier is an exact wire-request or account-identity preview.

The fingerprint binds the tier and cap, the entire installed spec and source, args, the redacted
request and the displayed trigger. This also catches changed write flags, triggers, readbacks and
trust metadata. A call's own known-anonymous cookies change none of it, nor `signedIn`, and neither
does a guest value (a name such as `x-guest-token`) a tier-3 run captures for a plan that starts at
tier 3: the plan for the same args before and after such a call compares equal. Any other value a
tier-3 run captures, such as a bearer the page keeps in its storage, makes `signedIn` true even though
the page fills it itself. What a call does can still change the plan:

- a new remembered tier;
- a response that sets a cookie not known to be anonymous, which makes `signedIn` true;
- a session value a browser run captures for an operation whose plan starts at tier 1 or 2, which the
  request then shows and which makes `signedIn` true;
- a captured value of six or more characters that also appears in the args or the request, which
  redaction then replaces;
- a browser still running. While one runs, its `SingletonLock` makes every plan that can reach the
  profile fail closed to `signedIn: true`. So `callPlanned` closes the browser its call started as
  soon as no other call in the process uses it, and waits for it to exit before returning: the next
  plan reads a released, flushed profile. While calls overlap, the browser stays up, and a plan made
  meanwhile is signed in until the last of them returns.

`callPlanned` re-plans synchronously before `call()`. A fresh plan that differs from the approved
one in any field (the fingerprint, the shown request or trigger, `signedIn`) returns
`class: "refused"` without sending, with `write: "not_sent"` for writes. Credential rotation under
the same placeholders, and known-anonymous cookies set or dropped, do not by themselves invalidate
approval. A login, a cookie that may carry an account and a stored value the request fills do,
through `signedIn` and, for a value, the request. Keep the plan in trusted host memory; it is not a
signed token for accepting arbitrary plans from an untrusted client. `args` are execution inputs
and may contain caller-provided secrets; `request` and `trigger`
are redacted display text. Do not log the whole plan.
If re-planning itself fails, its original input/error/blocked result is returned, including its
reason and recovery step, rather than an approval-mismatch message.

The only call options are `allowWrites`, `maxTier`, `timeoutMs`, `fetchImpl`, `minIntervalMs` and
`view`. `view` (`fields`, `maxChars`) shapes only the answer after extraction, never the request, so
it is not part of the plan or its approval.
An omitted `maxTier` reuses the plan's cap; changing it requires re-planning and approval.
The host must grant `allowWrites` separately for an approved write. There is no force, again,
idempotency override, or operation-learning option. Pacing is at least one second per site,
including the existing jitter; a smaller `minIntervalMs` cannot disable it.

## Call-only execution

Host calls always set `CallOptions.callOnly`. Direct library callers can also set it.

- No rescan, recapture, operation replacement, registry adoption or bundled upgrades.
- No registry calls, reports, sharing, verification jobs or other background work.
- No cookie import from the user's everyday browser. An auth failure asks the user to run
  `api-anything login <site>`. A read's drift asks for `api-anything heal <site> <op>`, unless the
  read was learned signed in and no login cookie is stored: that is `auth`, as for `call()`.
  A write's drift asks for `api-anything add <site> <op> ... --write`, never `heal`.
- Site spec files remain byte-identical. Calls still update local sessions, pacing, cool-downs,
  remembered tiers, the write ledger and call log.
- An answer over the cap is cut as for `call()`, but none is kept: there is no `resultId`, `more` or
  `get_result` to continue it. The `truncated` note names only what the host can change: `view.fields`
  or the arguments.
- The HTTP, page-fetch and own-profile trigger-run tiers remain available. Those transports may
  make the operation's derived lookups and readback requests. Browser tiers load the site's pages
  and resources as before. No example-argument probes are sent in call-only mode.
- A write stays at its planned starting tier. Any failure returns without a transport escalation,
  cookie-refresh resend, intercept recapture or other retry, even after a definite non-execution.
  A read can still climb within the approved cap and refresh cookies/session values.
- A tier-3 write must have a `companions` list, even if empty, and a non-empty `match`.
  Planning and direct call-only execution refuse older or incomplete specs with
  `class: "refused"` and `write: "not_sent"`, before any browser run or write-ledger entry.
  The recovery step asks the user to re-learn with `api-anything add <site> <op> ... --write`.
- Write permission, send-once rules, duplicate refusal, readback, private-address checks and result
  truncation are unchanged. A write that may have run still directs the caller to check the site
  before any retry, rather than treating a heal or login as permission to repeat it.

Own-profile cookie refresh for reads and a read's tier-3 run may refresh session values. A write's
normal transport can still record cookies from the response, and its readback is a separate read,
not a retry of the write.

`closeHost()` closes the shared browser. A host call already closes it when it is the last user, so
this matters only for calls still running. Host calls create no background jobs to drain.
Finish outstanding calls before closing; this is not a write-cancellation API.

## Bun and compiled hosts

The `bun` export condition resolves directly to `src/host.ts`; Node resolves to `dist/host.js`
with declarations in `dist/host.d.ts`. Sources ship with the package for this condition.
Login, cookie import, registry, report, share and MCP modules are not eagerly imported by `/host`.

A compiled Bun executable must extract the bundled JSON and notes, then call
`setBundledDir(absoluteDirectory)` before discovery or calling. All default spec, notes and
publishing-name lookups use that directory. The override lasts for the process. The host owns
extraction and cleanup; the library never extracts or downloads specs.
Keep `playwright-core` external when compiling, and make it available at runtime for browser tiers.
Its optional BiDi dependencies and browser-driver assets are not a self-contained Bun bundle.

Run the offline scratch-directory source-import and compiled-binary check with (`BUN` names a Bun
that is not on PATH):

```sh
node --import tsx test/smoke-host-bun.ts
```
