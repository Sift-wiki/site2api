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
  // Show plan.request to the user. For a write, obtain approval for this exact plan first.
  const result = await callPlanned(plan); // writes are refused unless allowWrites: true
  console.log(result);
}
await closeHost();
```

## Approval

`CallPlan` is either `{ok: false, result: CallResult}` or a successful plan with `site`, `op`,
`readOnly`, `signedIn`, default-filled `args`, a redacted `request`, and a SHA-256 `fingerprint`.
`signedIn` is conservative: any stored cookie or session value counts, even an expired or guest
cookie. It is not proof of a valid login. `hosts` lists base, request and trigger hostnames.
An operation's `pages` lists its trigger's origin and path before the first parameter, without
query or fragment.

`planCall` validates args and headers without sending. Its credential placeholders follow CLI
`--dry`, with a further live-value redaction pass for copies in arguments or literals.
Generated UUID slots show `<generated:uuid>` and lookup-derived slots show `<derived:path>`.
Planning never sends a lookup and cannot know its eventual value. The fingerprint binds the
entire installed spec and source as well as args, the template hash and redacted request. This
also catches changed write flags, triggers, readbacks and trust metadata.

`callPlanned` re-plans synchronously before `call()`. A changed fingerprint or modified preview
returns `class: "refused"` without sending, with `write: "not_sent"` for writes. Credential
rotation under the same placeholders does not by itself invalidate approval. Keep the plan in
trusted host memory; it is not a signed token for accepting arbitrary plans from an untrusted
client. `args` are execution inputs and may contain caller-provided secrets; only `request` is
redacted display text. Do not log the whole plan.

The only call options are `allowWrites`, `maxTier`, `timeoutMs`, `fetchImpl` and `minIntervalMs`.
The host must grant `allowWrites` separately for an approved write. There is no force, again,
idempotency override, or operation-learning option. Pacing is at least one second per site,
including the existing jitter; a smaller `minIntervalMs` cannot disable it.

## Call-only execution

Host calls always set `CallOptions.callOnly`. Direct library callers can also set it.

- No rescan, recapture, operation replacement, registry adoption or bundled upgrades.
- No registry calls, reports, sharing, verification jobs or other background work.
- No cookie import from the user's everyday browser. An auth failure asks the user to run
  `api-anything login <site>`. A drift asks for `api-anything heal <site> <op>`.
- Site spec files remain byte-identical. Calls still update local sessions, pacing, cool-downs,
  remembered tiers, the write ledger, call log and capped-result storage.
- The HTTP, page-fetch and own-profile trigger-run tiers remain available. Those transports may
  make the operation's derived lookups and readback requests. Browser tiers load the site's pages
  and resources as before. No example-argument probes are sent in call-only mode.
- Write permission, send-once rules, duplicate refusal, readback, private-address checks and result
  truncation are unchanged. A write that may have run still directs the caller to check the site
  before any retry, rather than treating a heal or login as permission to repeat it.

Own-profile cookie refresh and a read's tier-3 run may refresh session values. A write's
intercept-only auth recapture is disabled. These choices keep calling intact without learning or
importing an everyday-browser session. CLI calls without `callOnly` retain their existing behavior.

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
