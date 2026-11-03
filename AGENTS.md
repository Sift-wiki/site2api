# Instructions for coding agents

`docs/DESIGN.md` is the authoritative spec. Read it before changing behavior. `docs/research/`
holds the evidence behind it, including the api-anything bugs that must not come back.

## Layout

| file | job |
|---|---|
| `src/types.ts` | contract between the browser layer and the core; add optional fields only |
| `src/spec.ts` | zod schema of a site spec |
| `src/codec.ts` | read and write values through decoded request layers; untouched bytes stay identical |
| `src/learn.ts` | exchanges + example args -> Operation |
| `src/paging.ts` | paging found in a capture (two pages of one list), and the stand-in for a short page value |
| `src/confirm.ts` | a write's recorded `confirm()` dialogs: the digest, and which ones a tier-3 run accepts |
| `src/secrets.ts` | what counts as a credential, the scan that finds one in a spec, and `redact` for messages |
| `src/outline.ts` | a compact summary of a captured response, for choosing a request and a recipe |
| `src/classify.ts` | response -> ok/drift/auth/rate/blocked/input/error; `judge` also extracts |
| `src/extract.ts` | parse, extract, pick, cap |
| `src/http.ts` | tier 1: fill the template, send with Node fetch |
| `src/browser.ts` | Chrome via playwright-core: trigger capture, tier 2 page fetch, login |
| `src/heal.ts` | add, rescan, recapture, tier-3 trigger runs, captures |
| `src/execute.ts` | `call()`: the tier ladder, classifier actions, heal guards, write rules |
| `src/session.ts`, `src/store.ts` | `~/.api-anything`: cookie jar, specs, heal log, state, write ledger, call log, export |
| `src/status.ts` | `status`: each op's health from the local files only, each problem with its `next` |
| `src/checks.ts` | `verify`: run each read's example and checks, judge pass/fail/inconclusive, keep the record `publish` gates on |
| `src/vet.ts` | the shared rules a spec someone else wrote must pass: on pull, publish, load and in CI |
| `src/registry.ts` | the registry service's client (`docs/REGISTRY.md`, wire contract `src/registry-api.ts`): `pull`, `search`, the bundled upgrade |
| `src/publish.ts`, `src/share.ts` | what an upload sends and the scans before it (`publish` previews it); `shareOps` sends what the rules allow, signed; the heal-back |
| `src/report.ts`, `src/background.ts` | reports of calls of registry versions, in the background; an idle MCP server's verification of candidates |
| `src/registry-api.ts` | the wire contract with the registry service: endpoints' types, request signing, version hashing |
| `src/search.ts`, `src/domain.ts` | pure pieces the registry service shares: an op's summary, the index entry, query scoring; host to site |
| `src/identity.ts` | the install's Ed25519 key, signed request headers, and `settings.json` (whether to share) |
| `src/clean.ts` | a call with no cookies or session values, over plain HTTP: whether an op is public |
| `src/learnsite.ts` | `learn_site`: add's two runs with the user's args, the pick from the outline, a holdout call, a clean replay, then share |
| `src/setup.ts` | `setup`: connect the MCP server and the skill to each agent, the key, the one question |
| `src/skill.ts` | the skill folder's copies: install, the stamp, and refreshing an untouched older copy |
| `src/login.ts`, `src/import.ts` | sign in by importing the everyday browser's cookies; re-import on `auth` |
| `src/cli.ts`, `src/mcp.ts`, `src/mcp-learn.ts`, `src/index.ts`, `src/host.ts` | entry points; `mcp-learn.ts` is the MCP `learn_site` tool; `host.ts` is `api-anything/host`, call-only (docs/HOST.md) |
| `src/profile-state.ts`, `src/sqlite.ts` | whether api-anything's own Chrome profile may hold a site's sign-in: a cookie name not known to be anonymous, offline; node:sqlite opened read-only |
| `src/jobs.ts` | an MCP call still running at its deadline answers with a job; identical calls join it |
| `src/clients.ts` | `mcp --print-config`: how each MCP client adds the server, with absolute paths |
| `registry/` | the registry service: a Cloudflare Worker with D1 (docs/REGISTRY.md) |
| `skills/api-anything/` | the agent skill: a short `SKILL.md` core, and `references/` for authoring and writes; it never restates a tool description or `--help` |

## Rules

- Keep modules small. Don't add speculative abstractions. Comment only a non-obvious why.
- Never put a credential in a spec: refs (`cookie:x`, `session:x`) only. Any change to learning
  must keep the "no credential in the serialized spec" tests passing.
- Writes: never perform one to learn or heal it (intercept and abort). Send it once per call and
  retry only on 400/401/403/404. Require `allowWrites` at every entry point.
- No site-specific code in `src/`. Add the pattern to `test/fixture/server.ts` instead.
- Healing is reactive: always send the stored template first.
- A spec in `sites/` must pass `vetShared` (`test/registry.test.ts` checks every one): pulled specs
  run with other people's sessions.
- Tests use `node:test` and never touch the network beyond localhost.

## Commands

```sh
npm run check                                  # tsc over src and test, no emit
npm run lint                                   # Biome: format and lint, no changes
npm run format                                 # Biome: apply formatting and safe fixes
npm test                                       # all tests
node --import tsx --test test/<file>.test.ts   # one file
npm run cli -- <command>                       # run the CLI from source
```

Don't commit AI attribution trailers.
