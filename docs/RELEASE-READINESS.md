# Release readiness — 0.4.0, 2026-11-06

Ready to publish. Agents and tools beyond MCP can use it now (an HTTP server with REST, OpenAPI and
MCP over HTTP; a Python client), and five security issues (#108 to #112) are fixed.

## New

- `api-anything serve` (#120): REST, `/openapi.json` (OpenAPI 3.1, one typed path per read) and MCP
  over HTTP at `/mcp`, on loopback with a bearer token, a shared limit on running calls, and Host and
  Origin checks. docs/SERVE.md.
- A Python client in `python/` (#114), installed from this repository (not on PyPI yet): `Client`,
  tools for agent frameworks, typed code generation. docs/PYTHON.md.
- Output schemas on the MCP tools (#115); `data` is left open so a repaired operation never fails a
  strict client.
- `--changes` / `--changes-only` with `--watch <name>`, `--max-age`, a per-site request budget, and
  `shutdown()` for scripts (#117).
- Sessions, captures and snapshots encrypted at rest with a key in the OS keychain (#108, #118).
- Setup asks which agents to connect (#112); background verification is its own opt-in, default no,
  and local-only mode stops all registry traffic (#110); `setup --pin` (#109); a site's first browser
  cookie import needs a person, approved per domain and profile (#111) (#121).
- The catalog: an install funnel in `/v1/stats`, and `/v1/try` for a few public reads with no
  install (#116, #122). Deployed 2026-11-06 with migrations 0008 to 0010; all 114 bundled sites seeded.

## Breaking

- `setup` with no terminal and no `--agents` connects no agent; it prints the command for each.
  Scripts pass `--agents <name>` or `--agents all`.
- A first `login` from a browser profile with no terminal is refused. Use `--window`, `--cookies`,
  or `API_ANYTHING_ALLOW_IMPORT=<domain>`.
- Sealed files start with a non-JSON line, so 0.3.2 refuses them. Don't delete them to downgrade;
  `logout <site>` and log in again instead.

## Verified

- `REQUIRE_BROWSER=1 npm test`: 1304 tests, 1303 passed. The one failure, `test/browser.test.ts`
  (a navigation timeout under load), passed 10 of 10 on three reruns. `npm run check` and
  `npm run lint` are clean; CI is green on Node 22 and 24 and on Python 3.9 and 3.13.
- Live, logged out, `api-anything verify` on every bundled site from one empty home: 716 cases
  passed, 6 failed, 19 inconclusive, 8 skipped. All six failures are example items that no longer
  exist (HTTP 404 or 410, answered as `input`).
- The Python client run against a real `serve`: records data, changes with a watcher, the cache,
  input errors, a batch across two sites, tools and `run_tool`. The `git+https` install works on
  Python 3.9.
- `serve` by hand: OpenAPI 3.1 with 309 paths and unique operation ids; 401 without the token;
  403 for a foreign Origin; a malformed request target answers 400 and the server keeps serving.
- `examples/mentions.mjs duckdb` from an empty home: 66 mentions from 5 of 6 sources in 1.9 s,
  process exit in 2.1 s (Reddit challenged plain HTTP and answered `blocked`).

## Known issues

- Stale examples: `aldi.applianceDetails`, `gumtree.getListingMetadata`, `workable.getJob` and
  `workday.getJob` (removed listings and postings).
- `google-flights.priceCalendar` answers batchexecute error 13.
- Reddit challenges plain HTTP from many networks.
- Linux and Windows key stores are written to their documented interfaces but untested on those
  systems. api-anything's own Chrome profile is not sealed.

# Release readiness — 0.3.2, 2026-10-31

Ready to publish. The limits of 0.3.0 still apply.

## Verified

- `REQUIRE_BROWSER=1 npm test` passed (1080 tests) with `npm run check` and `npm run lint` on the
  launch fixes (#87); CI is green on Node 22 and 24.
- Live, logged out, `api-anything verify` on every bundled site from one empty home: 247 cases
  passed, 3 failed, 4 inconclusive, 8 skipped (linkedin needs a login; dominos-au ships no examples).
  97 of the 99 operations that need no account answered with data.
- New: `reddit` (`search`, `hot`), passing `verify reddit` 4 of 4 from an empty home at tier 2.
- Fixed: `youtube.search` (headers past Node's 16 KB limit now send a read on, and the plain retry
  answers at tier 1), `amazon.search` titles on results with a brand row, `setup` wiring agents
  from a leftover directory, `Retry-After: 0` read as a rate limit, `Available-Dictionary` kept in
  learned requests.

## Known issues

- `google-flights.priceCalendar` answers batchexecute error 13; `aldi.applianceDetails`'s example
  product is gone (HTTP 410).
- Reddit challenges plain HTTP from many networks: a first call can take about 12 s through Chrome.

# Release readiness — 0.3.0, 2026-10-29

Ready to publish. The same limits as 0.2.0 apply: this is not a claim that every website, every
operation, or unattended account action works.

## Verified

- `npm run lint`, `npm run check` and `npm test` (Chrome included) pass; CI is green on Node 22 and
  24, and gitleaks finds no leaks. `npm audit --omit=dev`: 0 vulnerabilities (zod 4.6.6+).
- Live, logged out, each of the 81 bundled read operations was called once with its example args in
  a fresh home: 70 answered (69 at tier 1, `goodreads.getWorkId` at tier 2); `youtube.search` hit a
  one-off response-header overflow and answered on a second call.
- `examples/teach-once.sh arxiv.org` learns `hn-demo.links` and returns 30 of 30 arxiv.org links at
  tier 1 (Hacker News refuses Chrome's identity headers from Node, so the read is sent once more
  without them).

## Known issues

- `google-flights.priceCalendar` answers batchexecute error 13 (Google changed it); 0.2.0 fails the
  same way. Re-learning it is the fix; `search` and `top` work.
- `aldi.applianceDetails`'s example product is gone (HTTP 410); the op answers for a live product id.
- `linkedin` (5 ops) needs `api-anything login linkedin`; `dominos-au` ships no example values.
- The registry Worker must be deployed with this client for a shared write to carry its readback.

# Release readiness — 0.2.0 and earlier, 2026-09-27

Ready for an early developer release of the local framework and its documented read workflows.
This is not a claim that every website, every operation, or unattended account action works.

## Verified

- `npm run check` and `npm test`: 416 tests passed, zero skipped, including real Chrome against
  localhost fixtures. Tests do not make external requests.
- `npm audit --omit=dev`: zero reported vulnerabilities at release time.
- Fresh GitHub clone → `npm ci` → pack → global install passed. Direct GitHub `npx` also passed.
  Global `npm install -g github:...` failed under npm 11.6.2; the documented pack-first route avoids it.
- A packed production-only install exposes all eight sites and 17 operations. A real stdio MCP
  client discovers all five tools, calls Hacker News, and receives structured failures.
- All 17 bundled read operations returned successful direct-HTTP responses in live checks.
  LinkedIn used an existing authorized session; the other sites were logged out. Flight calendar
  dates were checked against the requested interval. These are point-in-time checks on macOS,
  not a continuous availability guarantee or cross-platform acceptance run.
- The quickstart learned a new Hacker News domain-filter operation with github.com/github.io,
  then returned 30 arxiv.org links through tier 1 using a third input.
- `examples/research.mjs anthropic --linkedin` returned five stories and enriched three companies
  by passing company IDs from search into detail calls. It performs only reads.
- A local messaging fixture proves that one learned operation accepts different recipients and
  content, sends nothing during learning, refuses writes by default, and sends each authorized
  call once. No real LinkedIn message was sent or claimed delivered.
- A forced live Google Flights browser fallback refused the datepicker's unrelated date range.
  Direct calendar replay works; automatic repair of arbitrary datepicker ranges is not promised.

## Launch demos, later on 2026-09-27

The three README demos were run again and recorded, each against a fresh `API_ANYTHING_HOME`.
First, a fresh GitHub clone went through `npm ci` and the pack install with an empty npm cache,
then made a Hacker News call at tier 1. Second, `hn-demo.links` was learned from two domains and
returned 30 of 30 arxiv.org links at tier 1. Third, the research workflow ran five reads, all at
tier 1, using a copied LinkedIn session. After the example scripts changed, `npm run check` and
all 416 tests passed again. Commands, recordings and captured output are in
[demos](demos/README.md).

## Release fixes

- Keep distinct session tokens separate by operation and request position. Preserve and refresh
  every credential in compound fields; do not forward secondary credentials across origins.
- Strip discovered credential copies and refuse saving a spec if a detected secret remains.
- Return captured browser data only when established parameter slots match the caller's args.
  Healing may move a parameter but cannot invent a new prefix/suffix to make wrong data fit.
- Recognize explicit JSON write rejection even when the learned response recipe is HTML or
  embedded data. A changed receipt shape does not turn an accepted write into a retry.
- Package the research example and add CLI, Codex/MCP, skill, and demo setup instructions.

Independent standards and spec reviews reproduced the release blockers. Their fixes have
focused regressions, and the final candidate passed the full suite before landing.

## Reproduce

```sh
npm ci
npm run check
REQUIRE_BROWSER=1 npm test   # fails, not skips, when Chrome is missing
npm run smoke:pack           # pack, install the tarball outside the checkout, run `sites`, `ops` and the library
npm run demo -- 'agent memory'
```

CI runs all but the demo on every pull request and push to main, plus a gitleaks scan (pinned
release, checked by SHA-256) of the working tree and the full history. Before a release, check the
latest `main` run is green on both Node versions, including the `secrets` job.

Follow [Setup and demos](QUICKSTART.md) for a clean global install, MCP setup, teaching a new
operation, and LinkedIn session import/enrichment. Browser tests require Google Chrome; a run
that skips them is not the release gate. Raw captures and account data stay out of the repository.

## Public claim boundary

The framework learns reusable, parameterized operations from browser traffic and calls them via
CLI, library or MCP. An agent chooses the requests, examples and extraction fields. Recovery is
bounded and can fail explicitly. It is not a hosted REST service or automatic coverage of a whole
website. LinkedIn messaging is not bundled. Real write workflows need their own authorized
recipient, delivery/read-back check and site-specific operation before being advertised.
