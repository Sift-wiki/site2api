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

`signedIn` is a caution, not proof of a valid login. Any stored cookie or session value counts,
even an expired, empty or guest value. If the call can use browser tiers, planning also checks
api-anything's own Chrome profile for cookie names on the site's registrable domains, including
request, lookup, trigger and inline readback domains. It reads only `host_key` and `name` from
the profile's Cookies SQLite database, read-only, without decryption or Keychain access.
A running, locked, unreadable or incomplete existing profile counts as signed in, as does an
uncheckpointed cookie journal. A nonexistent profile does not. No everyday-browser profile is
opened. `hostSites()` and `hostSite()` use the default cap of 3; a plan with `maxTier: 1` does
not inspect the profile. A write planned at tier 1 cannot climb, but its readback can still use the
approved cap. When a URL's origin cannot be resolved offline, any cookie in the own profile counts
conservatively, rather than assuming that an omitted hostname is signed out.

`hosts` lists known HTTP(S) hostnames from the base URL, requests, derived lookups, trigger URLs,
soft-navigation pages, `goto` steps, and inline readbacks and their lookups/triggers.
An operation's `pages` lists only its own trigger's static origin and path before the first path
parameter, without query or fragment. URLs with a templated hostname or port, fully templated
URLs, non-HTTP(S) URLs and unparseable entries are omitted, never represented with a placeholder
hostname. An omitted URL does not drop its site from discovery. These are discovery hints, not an
exhaustive list of resources or redirects a page can load.

`planCall` validates args and headers without sending. Its credential placeholders follow CLI
`--dry`, with a further live-value redaction pass for copies in arguments or literals. It applies
execution's session filters without saving them: unbound values in someone else's spec and all
session credentials disallowed for an agent-pulled operation are absent in both preview and send.
Generated UUID slots show `<generated:uuid>` and lookup-derived slots show `<derived:path>`.
Planning never sends a lookup and cannot know its eventual value.

At tier 1, `request` previews the materialized request. At tier 2, it previews the page fetch, with
`cookie: "<browser-profile cookies>"` instead of the per-site jar when profile cookies may go.
The browser chooses those cookies; the jar does not identify the account that will be used.
At tier 3, `request` is only the stored template for context. The site page sends the request;
`trigger` shows the filled URL, optional `softFrom`, and UI steps that will run, with live values
redacted. The host must show that trigger as well as the tier before obtaining write approval.
Neither browser tier is an exact wire-request or account-identity preview.

The fingerprint binds the tier and cap, the entire installed spec and source, args, the template
hash, the redacted request and the displayed trigger. This also catches changed write flags,
triggers, readbacks and trust metadata.

`callPlanned` re-plans synchronously before `call()`. A changed fingerprint or modified preview
returns `class: "refused"` without sending, with `write: "not_sent"` for writes. Credential
rotation under the same placeholders does not by itself invalidate approval. Keep the plan in
trusted host memory; it is not a signed token for accepting arbitrary plans from an untrusted
client. `args` are execution inputs and may contain caller-provided secrets; `request` and `trigger`
are redacted display text. Do not log the whole plan.
If re-planning itself fails, its original input/error/blocked result is returned, including its
reason and recovery step, rather than an approval-mismatch message.

The only call options are `allowWrites`, `maxTier`, `timeoutMs`, `fetchImpl` and `minIntervalMs`.
An omitted `maxTier` reuses the plan's cap; changing it requires re-planning and approval.
The host must grant `allowWrites` separately for an approved write. There is no force, again,
idempotency override, or operation-learning option. Pacing is at least one second per site,
including the existing jitter; a smaller `minIntervalMs` cannot disable it.

## Call-only execution

Host calls always set `CallOptions.callOnly`. Direct library callers can also set it.

- No rescan, recapture, operation replacement, registry adoption or bundled upgrades.
- No registry calls, reports, sharing, verification jobs or other background work.
- No cookie import from the user's everyday browser. An auth failure asks the user to run
  `api-anything login <site>`. A read's drift asks for `api-anything heal <site> <op>`.
  A write's drift asks for `api-anything add <site> <op> ... --write`, never `heal`.
- Site spec files remain byte-identical. Calls still update local sessions, pacing, cool-downs,
  remembered tiers, the write ledger, call log and capped-result storage.
- The HTTP, page-fetch and own-profile trigger-run tiers remain available. Those transports may
  make the operation's derived lookups and readback requests. Browser tiers load the site's pages
  and resources as before. No example-argument probes are sent in call-only mode.
- A write stays at its planned starting tier. Any failure returns without a transport escalation,
  cookie-refresh resend, intercept recapture or other retry, even after a definite non-execution.
  A read can still climb within the approved cap and refresh cookies/session values.
- Write permission, send-once rules, duplicate refusal, readback, private-address checks and result
  truncation are unchanged. A write that may have run still directs the caller to check the site
  before any retry, rather than treating a heal or login as permission to repeat it.

Own-profile cookie refresh for reads and a read's tier-3 run may refresh session values. A write's
normal transport can still record cookies from the response, and its readback is a separate read,
not a retry of the write. These choices keep calling intact without learning or importing an
everyday-browser session. CLI calls without `callOnly` retain their existing behavior.

`closeHost()` closes the shared browser. Host calls create no background jobs to drain.
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

Run the offline scratch-directory source-import and compiled-binary check with:

```sh
BUN=~/.local/share/bun-1.4.4/bun node --import tsx test/smoke-host-bun.ts
```
