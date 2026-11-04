#!/usr/bin/env node
/** api-anything CLI. Compact JSON on stdout; every failure also prints one `next:` line on stderr. */
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { BATCH_CONCURRENCY, BATCH_MAX, type BatchItem, callReads } from "./batch.js";
import { browserAvailable, closeBrowser, ProfileInUse } from "./browser.js";
import { verifySite } from "./checks.js";
import { botWall, emptyResults, htmlFinds, loginPath, signInForm } from "./classify.js";
import { launchOf, printConfig } from "./clients.js";
import { describeOperation } from "./describe.js";
import { type CallResult, call, heal, type Tier } from "./execute.js";
import { capOutput, extract, getPath, innerJson, pick, returnedFields, splitPick } from "./extract.js";
import {
  addOperation,
  type CaptureFile,
  capturePage,
  captureTrigger,
  fillTrigger,
  loadCapture,
  PROFILE_HINT,
  revertHeal,
  stoppedHint,
  stoppedIn,
  unplaced,
} from "./heal.js";
import { buildRequest, unknownArgs } from "./http.js";
import { answerShare } from "./identity.js";
import { AmbiguousProfile } from "./import.js";
import { type Candidate, capturePages, matches, pageUrls, rankCandidates } from "./learn.js";
import { learnSite } from "./learnsite.js";
import {
  cookieNames,
  importSession,
  importWarning,
  knownGuests,
  logout,
  resolveLoginTarget,
  windowLogin,
  windowRetry,
} from "./login.js";
import { type Outline, outline } from "./outline.js";
import { pagingFlag, pagingHints } from "./paging.js";
import { plan, uploadName } from "./publish.js";
import { pull, RegistryError, reportInterface, search } from "./registry.js";
import { settle } from "./report.js";
import { getResult, type ResultView, viewProblem } from "./results.js";
import { captureLive, redact } from "./secrets.js";
import { loadSession, placeholders } from "./session.js";
import { AGENTS, type Agent, askYesNo, setup, summary } from "./setup.js";
import { shareOps } from "./share.js";
import { refreshSkills } from "./skill.js";
import {
  CheckSchema,
  HtmlRecipeSchema,
  MatchSchema,
  type Operation,
  type Paging,
  type Param,
  type Readback,
  readbackName,
  TriggerStepSchema,
} from "./spec.js";
import { card, stats } from "./stats.js";
import { status } from "./status.js";
import {
  exportSite,
  KEEP_CALLS_DAYS,
  listSites,
  loadHeals,
  loadSite,
  siteNotes,
  updateSite,
  userSitesDir,
} from "./store.js";
import type { Exchange, TriggerStep } from "./types.js";
import { readbackProblems, SHARED_NOTE } from "./vet.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

/** capture/inspect --outline: the scout's summary of one exchange's response. */
function outlineOf(e: Exchange | undefined, values: string[]): { outline?: Outline } {
  const r = e?.response;
  const o = r?.body ? outline(r.contentType, r.body, values) : undefined;
  return o && Object.keys(o).length ? { outline: o } : {};
}

/** A multi-line error (a zod report) on one line, so JSON output keeps all of it. */
const oneLine = (m: string) =>
  m
    .replace(/(^|\s*\n\s*)(✖\s*)?/g, " ")
    .replace(/\s*→\s*(at\s+)?/g, " at ")
    .trim();

const HELP: Record<string, string> = {
  login: `api-anything login <site|url> [--profile "Chrome/Profile 1"] [--window] [--cookies <file>]
  By default imports the site's cookies from your everyday browser (you are almost always already
  signed in there, so no password and no re-doing 2FA). Prints which profile was used and the cookie
  NAMES only (plus the profile's display name and Google account). The imported session is the SAME
  one as your browser: if the site logs it out, both go.
  <site|url>  a site name (linkedin), a domain (linkedin.com, www.linkedin.com) or a URL
  --profile   the browser profile to import from, e.g. "Chrome/Profile 1". Needed when several
              profiles are signed in to the site (possibly different people's accounts): login
              then lists them with their names and emails instead of guessing. The choice is
              remembered: a later automatic re-import uses the same profile.
  --window    open a visible browser window to sign in by hand (an independent session); also the
              automatic fallback when nothing is importable. This is where you solve 2FA/captchas.
              It counts only if a login cookie appears or changes while it is open; else ok:false
              and the stored session is kept.
  --cookies   import a cookies.txt (Netscape) or JSON export (Cookie-Editor / Playwright), for CI
  Output: loggedIn, renewed (new login cookies), and a warning when the cookies show no sign-in or
  are the ones the session already had. Cookies every signed-out visitor gets never count.`,
  logout: `api-anything logout <site>
  Clears the stored cookie jar and this site's cookies in api-anything's browser profile.`,
  capture: `api-anything capture <url> [--steps <json>] [--soft-from <url>] [--example k=v]... [--write] [--limit n] [--outline]
  Loads the page in the browser and lists the requests it made, noise filtered and ranked (requests carrying
  the --example values first). Saves everything as a capture id for: add --from <id> --pick-request <n>,
  and for: inspect <id> <n>. Captures hold cookie values; the newest 20 are kept, none past 24 h.
  --steps      JSON array of {action: click|fill|press|wait|goto, selector?, value?, ms?}
  --soft-from  load this page first, then navigate in-app to <url> (SPAs only fire their data XHRs that way)
  --write      abort every non-GET request, and every xhr/fetch sent during --steps, before it leaves the browser.
               Without it, a POST, PUT, PATCH or DELETE sent once the steps run is stopped too (a GraphQL query
               passes): the page loads as usual, and a click that would place an order places none
  --outline    for the top 3 candidates, summarize the response instead of making you inspect it: where the
               example values are, a suggested --extract and --pick fields with samples, JSON the page
               embeds (a ready --embedded regex), and a repeated HTML list as a ready --html recipe
  Output: capture (the id), candidates, next (what to do). blocked: the bot challenge the site served.
  pageStatus: the page's own HTTP error, when a request it loaded is recommended all the same.
  stopped: the requests the steps sent that were stopped without --write (method and path); nothing was sent.
  pages: lists the capture loaded two pages of (a "Show more" in --steps): the two requests, the paging
  found (the param and where page 1's answer gives its value), and the add flags that learn the list.`,
  inspect: `api-anything inspect <captureId> [<requestId>] [--extract <path>] [--pick a,b] [--html <json>] [--embedded <regex>] [--outline] [--example k=v]
  No browser. Without a request id, lists every request in the capture. With one, shows its request and
  response through add's recipe flags, so a recipe is tried here first: --extract (also spelled --path),
  --pick, --html, --embedded. A path, selector or regex that finds nothing fails (exit 1). An empty
  list at a path is a result, and so is an --html items selector "<container> <item>" whose container
  is on the page with no item in it (data: [], with a note).
  --outline summarizes the response (as capture --outline does) instead of printing it.
  Without a request id it also lists pages, as capture does.
  A request's URL and body show the run's cookie and storage values as refs ([cookie:x]), except
  one equal to an --example value.`,
  add: `api-anything add <site> <op> --trigger <url-template> --example k=v [--example2 k=v] [options]
  Runs the trigger twice in the browser (with --example, then --example2 or --example again), picks the request
  carrying the example values, and saves the learned operation to ~/.api-anything/sites/<site>.json.
  --trigger       page URL with {param} placeholders, e.g. https://site.com/u/{name}
  --steps <json>  UI steps after load, [{action: click|fill|press|wait|goto, selector?, value?, ms?}];
                  {param} is filled in selector/value
  --soft-from     neutral page to load first, then navigate in-page to the trigger
  --match k=v     pin the request: method=, host=, path= (* = one segment), operationName= (or JSON).
                  Without --write, a POST, PUT, PATCH or DELETE the steps send is stopped unless it is this
                  one (or a GraphQL query), and one on the page's own site fails the add before run 2
  --from <id> --pick-request <n>   learn from a saved capture instead of running the trigger (no browser).
                  Every add saves its own runs as captures, so a wrong recipe is fixed this way: add the op
                  again --from the capture it was learned from, with the recipe flags (--extract, --pick,
                  --html, --embedded). With no --example the op's stored examples are used, so the capture
                  must carry them; from a capture made with other values, pass those with --example
  --from2 <id>    a second capture, made with the --example2 values, for the two-run diff; with --from,
                  --example2 needs it: capture the page again with those values
  --extract <path>  dot/bracket path into the response; [*] collects from every array item (sections[*].items)
  --pick a,b.c,name=x.y  fields kept per item; name=path renames the key, name=path~regex keeps regex group 1
  --html <json>   {"items":"<css>","fields":{"name":"<css>[@attr]"}} for server-rendered pages;
                  "all:<css>[@attr]" returns every match as a list (genres, tags); "empty":"<css>" names the
                  element a page with no results shows instead of the list, so such a page answers []
  --embedded <regex>  JSON inside the page: group 1 marks where the JSON value starts; then --extract
  --public <name,...>  a header, or a credential-like field such as api_key, whose value is the same for every
                  visitor (a web app's bearer): kept literal unless the value is in a cookie or the page's
                  storage. A per-session field (token, csrf) stays a reference. Only when it is not the user's
  --write         the op changes state: it is learned from intercepted, aborted requests only. A request a
                  --write capture aborted, or an existing write learned again, needs --write: neither is
                  ever saved as a read
  --description <text>  what the op is for; an op added again with no --example keeps the one it had ("" clears it)
  --enum name=a,b,c  the values a param takes: the site's whole set (its picker's options), not only the
                  example's; a call with another is refused as input, and nothing is sent
  --min name=n, --max name=n  bounds on a param's value read as a number (a page, a count, a price)
  --paging <param>[=<path>]  a read whose list pages: <param> takes the next page, and <path> (in the
                  whole response, before --extract) is where the response gives the next page's cursor,
                  which a call returns as nextPage (hasMore false: the site said there is no next page).
                  Without =<path> the pages are numbered, and a call says nothing about the next one.
                  The param must be in the request: to page by a cursor, learn the op from the request
                  that loads page 2 ("Show more"), so the cursor is a param. <path>~<regex> keeps the
                  regex's group 1 from the string there (a next-page URL: meta.next_page~[?&]page=([^&#]*)).
                  capture lists the pages it finds, and add warns when the capture shows this list pages
                  An op learned again keeps its params' allowed values and descriptions, its checks,
                  its paging and its readback.
  Output: preview (what a call returns, from the captured response), warnings (read them), captures.
  replaced: an op of that name was learned again. unproven: example 2 was answered with example 1's
  data, or (example 2 changing several params of a read) one of them sent alone in example 1's args was,
  so nothing shows the server reads those params (publish refuses the op until it does).
  An op whose captured response is a bot challenge, a sign-in page, a rate limit or a server failure
  is not saved.`,
  call: `api-anything call <site> <op> [k=v ...] [--json <args-object>] [--fields a,b] [--max-chars n] [--allow-writes] [--again] [--idempotency-key <k>] [--max-tier 1|2|3] [--force] [--dry]
  Calls an operation: {ok, class, data, tier, healed?, heal?, ms, next?}; a failure also says retry
  (safe, after_wait, after_fix, no), retryAfterMs and nextCall, and a write says write (not_sent,
  not_applied, accepted, may_have_applied, applied: its readback found it). A paged read says
  nextPage (pass it as the op's paging param) and hasMore. A call that healed the op says how and
  what changed in its request in heal (undo: api-anything revert <site> <op>). --dry prints the
  request with credentials redacted.
  --json -         read the args object from stdin (at most 4 MiB); k=v args override its keys
  --fields a,b     project each extracted item (pick paths, including name=path); not site args
  --max-chars n    data budget, 256 to 200000 JSON characters (default 20000)
  A cut answer has resultId and more: retrieve it locally with api-anything result, not nextPage.
  --again          send a write refused as a duplicate (the same args within 10 minutes, and the
                    first may have gone through): only when the user checked the site
  --idempotency-key <k>  on the first call: a repeat of the write with the same key returns that
                    call's record (added only to a retry, the retry is still a duplicate)
  --force           send even while the site cools down: after a rate limit (its Retry-After, or
                    3 minutes) or a block at every tier (10 minutes) calls answer without sending.
                    A forced call that succeeds ends the wait; one limited or blocked again starts
                    it over. A login for the site also ends the wait`,
  batch: `api-anything batch [--input <file> | -] [--concurrency 1..4] [--limit 1..200] [--max-tier 1|2|3]
  Read JSONL {id?, site, op, args?} from a file or stdin (the default), at most 4 MiB.
  Write one JSONL {id, site, op, ...callResult} per line in input order. Missing ids are 1-based
  line numbers. A malformed line answers input without echoing its contents. Empty input is empty.
  Sequential by default; concurrency is across sites only, with the usual pacing and cool-downs.
  --limit lowers the 200-line cap; oversized input is rejected before any calls. Sites must already
  be installed (pull one first). Writes answer input: "writes are not batched". No caching.
  Exit 0 if every item is ok, otherwise 1. Failures do not stop later items.`,
  result: `api-anything result <resultId> [--offset n] [--fields a,b] [--max-chars n] [--format json]
  Reads a kept answer locally, with no site request or spec change. offset is an item index.
  Use the fields/maxChars/format in more to continue the same view. fields uses call's pick paths.
  With --format json, data is a serialized-JSON fragment and offset counts characters: concatenate
  fragments and JSON.parse once complete. This recovers oversized single items and objects.
  Answers expire after 15 minutes, or sooner when 20 newer answers displace them.`,
  verify: `api-anything verify [site ...] [--user] [--strict]
  Calls every read operation with its stored example args and its checks, healing as needed (a stale
  mark does not hold a heal back here), and judges each case: pass, fail, or inconclusive (a challenge,
  a sign-in page, a rate limit, or a server that failed or could not be reached: it says nothing about
  the op). The outcomes are kept per op, for publish, each case with since (when it began answering
  this outcome); the output says which ops are newlyFailing, recovered, and failingSince when. A read
  learned signed in is skipped ("needs login") while no login is on record for the site. A write is
  never sent: it gets a preflight (its template builds from its example and the session, a missing
  session value needs a trigger run, the login it was learned with against the jar now, how its
  readback's own cases did, and how many of its writes in the ledger were sent and never confirmed).
  An op marked unproven loses the mark when two passing cases that differ only in its unproven params
  answer differently. A paged read also asks for the page after its example's ("next page"): an
  answer with only page 1's items again fails. No site means every known site; --user means the
  user's own (in ~/.api-anything/sites).
  Exit 0: every counted case passed. 1: a case failed, or a site could not be verified. 2: nothing
  failed and a case was inconclusive. --strict exits 1 for an inconclusive case, or a write whose
  preflight is not ok; otherwise a preflight never sets the exit code.`,
  check: `api-anything check <site> <op> [k=v ...] --expect result|empty|input [--purpose <text>]
  Records a check on a read: args a human confirmed on the site, and what the site answers them with
  (result: data; empty: no data, the site's own no-results; input: the site refuses the args). verify
  runs it; publish refuses while one fails, and shares the checks with the spec, so use only public
  values. Choose values that exclude something: an empty check (a filter no row passes) shows a param
  the server ignores. A check with the same args replaces the old one; remove one by editing the spec.`,
  readback: `api-anything readback <site> <write-op> <read-op> [k=v ...] [--find <field>=<value>]
  How a write's call proves it landed: after the write is sent and accepted (or may have run), the
  call runs <read-op> once with these args (a read, never a second send). Finding it makes the
  call's write "applied"; not finding it changes nothing (the site may show it later). A value may
  be {param}, filled from the write's args: list={list}. --find title={title}: an item of the read's
  result whose title equals the write's; without --find, any data counts. Use something only this
  write makes (a title the caller chose, an id), or an older item can pass for it. Replaces the op's
  readback; remove one by editing the spec.`,
  sites: `api-anything sites
  Lists known sites (user specs in ~/.api-anything/sites win over bundled ones).`,
  ops: `api-anything ops <site> [<op> --schema]
  Lists a site's operations and params (with each param's format), and the site's notes: caveats,
  arg formats and login advice from <site>.md beside its spec.
  <op> --schema prints its portable contract: params as JSON Schema, output hints, and links.
  No request is sent. Unknown output types stay unknown; values are never coerced.`,
  heal: `api-anything heal <site> <op> [k=v ...]
  Forces a heal (rescan, then recapture) even when the op is marked stale. Reads only.`,
  heals: `api-anything heals [site]
  Lists the last 20 heals and reverts (of one site, or all), newest first: when, which op, how (rescan,
  recapture, revert) and what changed in its request template, one line each, with {param} and
  cookie:/session: refs in place of values. A call that heals says the same in its heal field.`,
  status: `api-anything status [site]
  What this machine knows of each op's health, from local files only (nothing is sent): a site's
  cool-down, an op's stale mark, the tier calls start at (remembered) beside the op's own (minTier),
  its last heal, its last verify outcome, its writes of the last 24 h by what each did, and from the
  call log (calls.jsonl, 30 days kept) the calls of the last 24 h and 7 days: count, ok rate, tiers,
  heals, median ms, and the last call's class. degraded: the last 24 h ran at a higher tier, or with
  an ok rate 20 points lower, than the 6 days before. problems lists each one with its next step.
  Without a site: every site with something on record here.`,
  stats: `api-anything stats [--days n] [--card]
  What this machine's calls did, from the local call log only (nothing is sent): calls, okRate, sent
  (calls that sent a request), tiers (1 is plain HTTP, 2 and 3 use Chrome), plainHttp (share of sent
  calls at tier 1), sites, ops, topSites, medianMs (of sent calls), heals and writes. saved estimates
  the browser-agent time the calls stood in for: each ok call that sent a request counts as 2.5 s,
  less its own time (bench/ measured about 3.2 s a call on Google Flights, more on Goodreads); its
  assumption field says so. window.firstCall: the oldest call in the window.
  --days   the window, 1 to 30 (the log keeps 30 days); default 30
  --card   print a few plain lines to paste into a post instead of JSON`,
  revert: `api-anything revert <site> <op>
  Puts back the op as it was before its last heal (heals.jsonl keeps it), and logs the revert; run it
  again to take back the heal before that. Refused when the op has no heal to take back, or changed
  after it (learned again or edited). A pulled spec's copy keeps its shared record, and the op gets back
  the registry version it was. The next call sends the old request: if the site really changed, it
  drifts and may heal again, so learn the op again with add if the heal was wrong.`,
  export: `api-anything export <site> [--out <file>] [--keep-examples] [--force]
  Writes a shareable spec: examples and response shapes stripped, and refused if a live cookie or
  session value is inside. --keep-examples keeps param examples you confirmed are public (so verify works).`,
  search: `api-anything search <words | domain | url>
  Finds sites someone already turned into operations: the shared registry and the specs on this
  machine, best match first, each op with its params and its status in the registry. Words match a
  site's name, its description and what its operations do and return ("book ratings"); a domain or a
  URL matches the sites whose operations use it (news.ycombinator.com). Each match says whether it is
  installed; pull one that is not. A match may list the site's own agent interfaces (an MCP server, an
  OpenAPI document); a domain search finds a site that has only those. API_ANYTHING_REGISTRY overrides
  the registry's URL.`,
  interface: `api-anything interface mcp|openapi <url>
  Tells the registry a site offers its own agent interface: an MCP server or an OpenAPI document, https
  on the site's own domain. Once installs on enough distinct networks said so, search lists it beside
  the site's operations, and a domain search finds a site that has only it. Signed with this install's
  key; nothing else is sent.`,
  pull: `api-anything pull <site>
  Fetches a site someone shared from the registry into ~/.api-anything/registry, so you can call it
  without learning it. Someone else wrote it: it is checked against the shared rules first, and its
  writes still need --allow-writes. Prints each op (method, hosts, write, login, status) and the
  warnings a human should read; a pull again names what changed. API_ANYTHING_REGISTRY overrides the
  registry's URL.`,
  publish: `api-anything publish <site> [op ...] [--yes]
  Shares the ops of a site you learned (all of them, or the ones named) with the registry, so others
  can call them instead of learning the site again. Without --yes it only previews: exactly what each
  upload sends, what was stripped, the warnings, and what may be yours (an email, an account id, a
  literal typed into the page). The param examples are sent: they must be values anyone may see. It
  refuses an op holding a live cookie or session value, or failing its checks. --yes sends them, signed
  with this install's key; an op that needed a login or writes is reviewed before others get it.`,
  mcp: `api-anything mcp [--allow-writes] [--sites a,b] [--print-config] [--no-learn]
  Serves list_sites, find_sites, list_operations, call_operation, call_batch, get_result, get_job, site_status, login and learn_site over
  stdio MCP, and call_write_operation with --allow-writes. list_operations and call_operation pull a
  shared site an agent asks for, with its reads only: its writes need a human's api-anything pull. Its
  login only refreshes a session a human imported here. A call still running after about 25 s answers
  class pending with a job, which get_job waits for. With sharing on, an idle server checks a few new
  shared operations a day, over plain HTTP with no cookies, and reports how calls went. learn_site
  learns a read (as learn does); writes are learned here with add --write.
  --sites a,b     also serve each operation of these sites as a tool of its own (goodreads__searchBooks),
                  with its args' JSON Schema: no list_operations step first. Costs tokens per op
  --print-config  print the command or config entry that adds this server to Claude Code, Codex,
                  Gemini CLI, VS Code, Cursor and Claude Desktop, with absolute paths and the other
                  flags given, instead of serving
  --no-learn      hide learn_site`,
  setup: `api-anything setup [--yes | --no-share] [--share-only] [--agents claude-code,codex,cursor,claude-desktop,hermes,gemini,vscode] [--dry-run]
  Connects the MCP server (npx -y api-anything mcp) to each agent found on this machine: Claude Code,
  Codex, Cursor, Claude Desktop, Hermes, Gemini CLI, VS Code. Installs the skill for Claude Code
  (~/.claude/skills), for Hermes (~/.hermes/skills) and for Codex, Cursor, Gemini CLI and VS Code
  (~/.agents/skills); Claude Desktop takes skills only by upload. Checks for a Chromium browser, makes
  this install's key, and asks whether to help build the shared catalog (default yes). Other entries
  in an agent's config are never changed; a file is backed up to <file>.bak-api-anything before its
  first edit. Running it again changes nothing. Afterwards, any command (the MCP server included)
  updates a skill copy setup installed when a newer api-anything runs, unless the copy was edited.
  --yes        share: answer the question yes without asking
  --no-share   do not share; answer the question no
  --share-only record --yes or --no-share and nothing else: no agent, skill or key is touched. learn_site
               asks the question the first time something could be shared; this records the answer
               given in chat, and changes it later
  --agents     connect these agents only, found or not
  --dry-run    print what would change, and change nothing`,
  learn: `api-anything learn <trigger> --args k=v --args2 k=v --args3 k=v [--site s] [--op o] [--intent text] [options]
  Learns a read in one step and returns the answer to --args (as MCP learn_site does): runs the page with
  --args and --args2, picks the request carrying them and the fields from the first run's outline, saves
  the op with --args2 as its example, calls it with --args3 (kept as the op's check) and once with no
  cookies, then shares it when sharing is on and it is public. A login op is shared only on your yes.
  First, when the registry has a read for the same page on that domain, it calls that with --args and
  answers with reused: no browser, nothing learned (--fresh, a recipe or --from learns anyway).
  <trigger>   page URL with {param} placeholders, e.g. https://site.com/search?q={q}
  --args      the values you want the answer for
  --args2     another real value of the same kind (the op's shared example)
  --args3     a third, different from both (the holdout check)
  --from <id> --from2 <id>   learn again from an earlier learn's captures, with no browser
  --fresh     learn the page even when a shared op answers for it (its data was not what you wanted)
  --pick-request <n>, --extract, --pick, --html, --embedded   choose the request and the recipe (see add)
  --steps <json>  UI steps after load, as add's ({param} filled): a click on "Show more" loads page 2
  --paging <param>[=<path>]  the list pages (see add). Without it, a list both runs load two pages of
              is learned with the paging they show; a cursor param is then the op's own, never in --args.
              Numbered pages without a cursor: put the page in --args, --args2 and --args3, and --paging page
  Output: data, signature, chosen and alternatives (request and recipe), proof, shared; or data and reused.
  paging, nextPage and hasMore: a list learned with its paging, and how to ask for the page after data.`,
};

const USAGE = `api-anything ${VERSION}: turn a website into operations an agent can call.

  api-anything setup [--yes | --no-share] [--dry-run]
  api-anything learn <url-template> --args k=v --args2 k=v --args3 k=v
  api-anything login <site|url> [--profile ... | --window | --cookies <file>]
  api-anything logout <site>
  api-anything capture <url> [--steps ...]
  api-anything add <site> <op> --trigger <url-template> --example k=v [--example2 k=v] [--write]
  api-anything call <site> <op> [k=v ...] [--allow-writes]
  api-anything batch [--input <file> | -] [--concurrency 1..4] [--limit 1..200]
  api-anything result <resultId> [--offset n] [--fields a,b] [--max-chars n]
  api-anything inspect <captureId> [<requestId>]
  api-anything search <words|domain> | pull <site> | publish <site> [--yes]
  api-anything interface mcp|openapi <url>
  api-anything check <site> <op> [k=v ...] --expect result|empty|input
  api-anything readback <site> <write-op> <read-op> [k=v ...] [--find field=value]
  api-anything verify [site ...] [--user] [--strict] | sites | ops <site> | heal <site> <op> | export <site>
  api-anything heals [site] | revert <site> <op> | status [site]
  api-anything stats [--days n] [--card]
  api-anything mcp [--allow-writes] [--sites a,b] [--print-config]

api-anything <command> --help for details. Data lives in ~/.api-anything (API_ANYTHING_HOME overrides).`;

const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);

class Fail extends Error {
  constructor(
    message: string,
    readonly next: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function kv(list: string[] | undefined): Record<string, string> {
  const args: Record<string, string> = {};
  for (const item of list ?? []) {
    const eq = item.indexOf("=");
    if (eq < 1) throw new Fail(`expected k=v, got "${item}"`, "write args as name=value");
    args[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return args;
}

/** The command being run: a hint about one of its flags points at its own --help. */
let command = "";

function json<T>(text: string | undefined, schema: z.ZodType<T>, flag: string): T | undefined {
  if (text === undefined) return undefined;
  try {
    return schema.parse(JSON.parse(text));
  } catch (e) {
    // a ZodError's own message is its issue list as JSON
    const why = e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message;
    throw new Fail(`--${flag}: ${oneLine(why)}`, `api-anything ${command} --help shows --${flag}`);
  }
}

/** --steps. An unknown action is named here, with the ones that exist: the schema's report would not say which it was. */
function stepsOf(text: string | undefined): TriggerStep[] | undefined {
  const actions: readonly string[] = TriggerStepSchema.shape.action.options;
  const given = json(text, z.unknown(), "steps");
  const bad = (Array.isArray(given) ? given : [])
    .map((s) => s?.action)
    .find((a) => typeof a === "string" && !actions.includes(a));
  if (bad)
    throw new Fail(
      `--steps: unknown action "${bad}"${/upload/i.test(bad) ? " (file uploads are not supported)" : ""}; the actions are ${actions.join(", ")}`,
      `api-anything ${command} --help shows --steps`,
    );
  return json(text, z.array(TriggerStepSchema), "steps");
}

const needBrowser = () => {
  if (!browserAvailable())
    throw new Fail(
      "no Chromium browser is installed (Google Chrome, Brave, Edge or Chromium)",
      "install one, or set API_ANYTHING_BROWSER to the path of any Chromium executable, then retry",
    );
};

function requireSite(name: string | undefined) {
  if (!name) throw new Fail("missing <site>", "api-anything sites");
  const r = loadSite(name);
  if (!r)
    throw new Fail(
      `no site "${name}"`,
      `api-anything search ${name} finds a shared spec to pull; else api-anything capture and add learn it`,
    );
  return r;
}

const examplesOf = (op: Operation) =>
  Object.fromEntries(op.params.flatMap((p) => (p.example !== undefined ? [[p.name, p.example]] : [])));

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  example: { type: "string", multiple: true },
  example2: { type: "string", multiple: true },
  trigger: { type: "string" },
  steps: { type: "string" },
  "soft-from": { type: "string" },
  match: { type: "string", multiple: true },
  from: { type: "string" },
  "pick-request": { type: "string" },
  fresh: { type: "boolean" },
  from2: { type: "string" },
  embedded: { type: "string" },
  public: { type: "string" },
  path: { type: "string" },
  "keep-examples": { type: "boolean" },
  extract: { type: "string" },
  pick: { type: "string" },
  fields: { type: "string" },
  "max-chars": { type: "string" },
  offset: { type: "string" },
  format: { type: "string" },
  html: { type: "string" },
  write: { type: "boolean" },
  description: { type: "string" },
  json: { type: "string" },
  input: { type: "string" },
  concurrency: { type: "string" },
  "allow-writes": { type: "boolean" },
  again: { type: "boolean" },
  "idempotency-key": { type: "string" },
  "max-tier": { type: "string" },
  dry: { type: "boolean" },
  limit: { type: "string" },
  out: { type: "string" },
  force: { type: "boolean" },
  yes: { type: "boolean" },
  user: { type: "boolean" },
  strict: { type: "boolean" },
  window: { type: "boolean" },
  cookies: { type: "string" },
  profile: { type: "string" },
  outline: { type: "boolean" },
  schema: { type: "boolean" },
  enum: { type: "string", multiple: true },
  min: { type: "string", multiple: true },
  max: { type: "string", multiple: true },
  expect: { type: "string" },
  purpose: { type: "string" },
  args: { type: "string", multiple: true },
  args2: { type: "string", multiple: true },
  args3: { type: "string", multiple: true },
  site: { type: "string" },
  op: { type: "string" },
  intent: { type: "string" },
  agents: { type: "string" },
  "dry-run": { type: "boolean" },
  "no-share": { type: "boolean" },
  "share-only": { type: "boolean" },
  "no-learn": { type: "boolean" },
  paging: { type: "string" },
  find: { type: "string" },
  sites: { type: "string" },
  "print-config": { type: "boolean" },
  days: { type: "string" },
  card: { type: "boolean" },
} as const;

/** What a command gets: the flags, the positionals after the command name, and the parsed --steps. */
interface Parsed {
  v: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];
  pos: string[];
  steps?: TriggerStep[];
}

async function cmdLogin({ v, pos }: Parsed): Promise<number> {
  const target = pos[0];
  if (!target) throw new Fail("missing <site|url>", "api-anything login <site|url>");
  let t: ReturnType<typeof resolveLoginTarget>;
  try {
    t = resolveLoginTarget(target);
  } catch (e) {
    throw new Fail(
      (e as Error).message,
      "api-anything sites lists known sites; or pass a domain (linkedin.com) or a full https:// URL",
    );
  }
  const { site, url, loginCookies } = t;

  // The visible-window flow: --window, or the automatic fallback when nothing is importable.
  const runWindow = async (reason?: string) => {
    needBrowser();
    process.stderr.write(
      `${reason ? `${reason} ` : ""}Sign in to ${url} in the browser window, then close it or press Enter here.\n`,
    );
    const w = await windowLogin(site, url, { loginCookies });
    if (!w.ok)
      throw new Fail(w.reason, windowRetry(site, `api-anything login ${site} --window`), {
        site,
        source: "window",
        cookies: cookieNames(w.cookies),
      });
    out({ ok: true, site, source: "window", cookies: cookieNames(w.cookies), loggedIn: true, renewed: w.renewed });
    return 0;
  };

  if (v.window) return runWindow();

  // what a signed-out visit is given, so those names do not pass for a sign-in
  const guest = await knownGuests(site, url, loginCookies);
  let imported: Awaited<ReturnType<typeof importSession>>;
  try {
    imported = await importSession(site, url, { loginCookies, profile: v.profile, file: v.cookies, guest });
  } catch (e) {
    if (!(e instanceof AmbiguousProfile)) throw e;
    throw new Fail(
      e.message,
      `ask the user which account to use, then: api-anything login ${site} --profile "<Browser/Profile>" (one of candidates[].profile)`,
      { candidates: e.candidates },
    );
  }
  if (!imported) {
    if (v.cookies) throw new Fail(`no cookies for ${site} in ${v.cookies}`, "check the export is for the right site");
    if (v.profile)
      throw new Fail(
        `no importable cookies in profile "${v.profile}"`,
        `run: api-anything login ${site} (scans every profile), or --window`,
      );
    return runWindow("No signed-in session found in your browsers.");
  }
  out({
    ok: true,
    site,
    source: imported.source,
    ...(imported.source !== "file" ? { profile: `${imported.browser}/${imported.profile}` } : {}),
    ...(imported.name ? { profileName: imported.name } : {}),
    ...(imported.email ? { account: imported.email } : {}),
    cookies: cookieNames(imported.cookies),
    loggedIn: imported.signedIn,
    renewed: imported.renewed,
    ...withWarning(importWarning(url, imported)),
  });
  return 0;
}

const withWarning = (warning: string | undefined) => (warning ? { warning } : {});

async function cmdLogout({ pos }: Parsed): Promise<number> {
  const site = pos[0];
  if (!site) throw new Fail("missing <site>", "api-anything logout <site>");
  await logout(site);
  out({ ok: true, site, loggedOut: true });
  return 0;
}

function positive(text: string | undefined, flag: string): number | undefined {
  if (text === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(text))
    throw new Fail(`--${flag} must be a positive integer, got "${text}"`, `api-anything ${command} --help`);
  return Number(text);
}

/** The main frame's last document: a widget's iframe (a reCAPTCHA frame) is a document too. */
function mainDocument(c: CaptureFile): Exchange | undefined {
  const pages = capturePages(c).map((u) => u.split("#")[0]);
  return c.exchanges.filter((e) => e.resourceType === "document" && e.response && pages.includes(e.request.url)).at(-1);
}

/**
 * What the page a capture ended on says about learning from it. `stop`: nothing to learn here, the
 * navigation ended on a login path that shows a sign-in form, or the page itself answered an HTTP error. `also`: the page shows
 * a sign-in form, as a public page may too, so that is said next to the recommendation and never
 * instead of it. `status`: the page's HTTP error, when a request it loaded is recommended all the same.
 */
function pageSays(
  c: CaptureFile,
  ranked: Candidate[],
  values: string[],
): { stop?: string; also?: string; status?: number } {
  const page = mainDocument(c);
  if (!page?.response) return {};
  const { status, body = "" } = page.response;
  // A login path is where sign-in pages live, and where a public /docs/login/... page may too: it takes the form as well.
  if (loginPath(c.finalUrl) && signInForm(body))
    return {
      stop: `the page is a sign-in page: ask the user to run api-anything login <site>, then capture again (api-anything inspect ${c.id} ${page.id} shows the page, if it is what you wanted)`,
    };
  // What would be learned from: the candidates' answers. A beacon that echoes the page is not one.
  const asked = values.filter((x) => x.length >= 3).map((x) => x.toLowerCase());
  const answers = ranked.map((r) => (c.exchanges.find((e) => e.id === r.id)?.response?.body ?? "").toLowerCase());
  const unseen = asked.length > 0 && !answers.some((a) => asked.some((x) => a.includes(x)));
  const also = !signInForm(body)
    ? undefined
    : unseen
      ? `none of the example values is in what these requests returned, and the page shows a sign-in form: check the example values (api-anything inspect ${c.id} <id> shows a response); if the data is missing, ask the user to run api-anything login <site>, then capture again`
      : "the page also shows a sign-in form: if the data you want is missing, ask the user to run api-anything login <site> first";
  // An error is a dead end when the erroring page is itself what would be recommended, not when a
  // data request it loaded is (a static host's 404 fallback serving the app).
  if (status >= 400 && (ranked[0]?.id ?? page.id) === page.id)
    return { stop: `the page answered HTTP ${status}: check the URL, then capture again${also ? `; ${also}` : ""}` };
  return { ...(also ? { also } : {}), ...(status >= 400 ? { status } : {}) };
}

async function cmdCapture({ v, pos, steps }: Parsed): Promise<number> {
  const url = pos[0];
  if (!url) throw new Fail("missing <url>", "api-anything capture <url>");
  needBrowser();
  const limit = positive(v.limit, "limit") ?? 15;
  const examples = kv(v.example);
  const c = await capturePage({ url, steps, softFrom: v["soft-from"], write: v.write, args: examples });
  const halted = v.write ? undefined : stoppedIn(c, c.url);
  const stopped = halted ? [...halted.site, ...halted.elsewhere] : [];
  const ranked = rankCandidates(c.exchanges, examples, { pages: pageUrls(c.exchanges, capturePages(c)) });
  const values = Object.values(examples).map(String);
  // the URLs shown carry the run's live values as the refs a spec would hold there
  const live = captureLive(c, values);
  const candidates = ranked.slice(0, limit).map((x, i) => {
    const url = redact(x.url, live, { named: true });
    return {
      id: x.id,
      kind: x.resourceType,
      method: x.method,
      url: url.length > 160 ? `${url.slice(0, 157)}...` : url,
      ...(x.status !== undefined ? { status: x.status } : {}),
      ...(x.contentType ? { type: x.contentType.split(";")[0] } : {}),
      ...(x.operationName ? { operationName: x.operationName } : {}),
      ...(x.hits.length ? { carries: x.hits } : {}),
      size: x.size,
      ...(v.outline && i < 3
        ? outlineOf(
            c.exchanges.find((e) => e.id === x.id),
            values,
          )
        : {}),
    };
  });
  const top = ranked[0];
  const html = top && /html/i.test(top.contentType ?? "");
  // a bot wall is not fixed by picking another request or writing a recipe
  const doc = mainDocument(c);
  const topEx = top && c.exchanges.find((e) => e.id === top.id);
  const wall = [doc, topEx]
    .map(
      (e) =>
        e?.response && botWall({ status: e.response.status, headers: e.response.headers, body: e.response.body ?? "" }),
    )
    .find(Boolean);
  const page: ReturnType<typeof pageSays> = wall ? {} : pageSays(c, ranked, values);
  const pages = pagesOf(c, values);
  const learn = `${
    html
      ? `the best candidate is the HTML page (server-rendered): api-anything inspect ${c.id} ${top.id} to read it, then add <site> <op> --from ${c.id} --pick-request ${top.id} --example k=v with --html '<recipe>' or --embedded '<regex>'`
      : `api-anything add <site> <op> --from ${c.id} --pick-request <id> --example k=v (api-anything inspect ${c.id} <id> shows a response)`
  }${pages.length ? `; requests ${pages[0]!.requests.join(" and ")} are two pages of one list: to learn it with its paging, add ${pages[0]!.flags} with the other --example values` : ""}`;
  out({
    capture: c.id,
    finalUrl: c.finalUrl,
    requests: c.exchanges.length,
    candidates,
    ...(pages.length ? { pages } : {}),
    ...(wall ? { blocked: wall } : {}),
    ...(page.status ? { pageStatus: page.status } : {}),
    ...(stopped.length ? { stopped } : {}),
    next: wall
      ? `the site served a bot challenge (${wall}): ask the user to run api-anything login <site> --window (clear the challenge in the window), then capture again`
      : halted?.site.length
        ? stoppedHint(halted.site, "capture again")
        : (page.stop ?? (page.also ? `${learn}; ${page.also}` : learn)),
  });
  return 0;
}

/**
 * JSON inside strings parsed in place (batchexecute's `wrb.fr` payloads, a form's f.req), so the
 * default view shows the data instead of an envelope around one long string.
 */
function unlayer(v: unknown, layers = 0): unknown {
  if (typeof v === "string") {
    const inner = layers < 5 ? innerJson(v) : undefined;
    return inner !== null && typeof inner === "object" ? unlayer(inner, layers + 1) : v;
  }
  if (Array.isArray(v)) return v.map((x) => unlayer(x, layers));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unlayer(x, layers)]));
  return v;
}

function cmdInspect({ v, pos }: Parsed): number {
  const [id, reqId] = pos;
  if (!id) throw new Fail("missing <captureId>", "api-anything inspect --help");
  const c = loadCapture(id);
  // the requests shown carry the run's live values as refs, as capture's candidates do
  const live = captureLive(c, Object.values(kv(v.example)).map(String));
  const shown = (s: string) => redact(s, live, { named: true });
  if (reqId === undefined) {
    out({
      capture: c.id,
      url: c.url,
      requests: c.exchanges.map((e) => ({
        id: e.id,
        kind: e.resourceType,
        method: e.request.method,
        url: shown(e.request.url).slice(0, 160),
        ...(e.response
          ? {
              status: e.response.status,
              type: e.response.contentType.split(";")[0],
              size: e.response.body?.length ?? 0,
            }
          : {}),
        ...(e.aborted ? { aborted: true } : {}),
      })),
      ...withPages(pagesOf(c, Object.values(kv(v.example)).map(String))),
    });
    return 0;
  }
  const e = c.exchanges.find((x) => x.id === Number(reqId));
  if (!e) throw new Fail(`no request ${reqId} in capture ${id}`, `api-anything inspect ${id}`);
  if (v.outline) {
    out({
      id: e.id,
      request: { method: e.request.method, url: shown(e.request.url) },
      ...outlineOf(e, Object.values(kv(v.example)).map(String)),
    });
    return 0;
  }
  const html = json(v.html, HtmlRecipeSchema, "html");
  const path = v.extract ?? v.path;
  const body = e.response?.body ?? "";
  // A recipe that finds nothing says so: no data field, or [] from a selector, reads as "no results".
  const nothing = (what: string) =>
    new Fail(
      `${what} in request ${e.id}'s response`,
      `api-anything inspect ${id} ${e.id} --outline --example k=v suggests a recipe; with no recipe flag it prints the whole response`,
    );
  let data: unknown = body;
  let note: string | undefined;
  if (html) {
    data = extract({ format: "html", html }, body, e.request.url);
    if (!(data as unknown[]).length) {
      // a results page with no results is an answer, as a call would give it; a selector that is not there is not
      const why = emptyResults(body, html);
      if (!why) throw nothing(`the --html items selector "${html.items}" matched nothing`);
      note = `no items: ${why}, so this is a page with no results`;
    } else if (!htmlFinds(html, data as Parameters<typeof htmlFinds>[1])) {
      const fields = Object.keys(html.fields).join(", ");
      throw nothing(
        `the --html items selector "${html.items}" matched ${(data as unknown[]).length} items but none of their fields (${fields})`,
      );
    }
  } else if (v.embedded) {
    data = extract({ format: "embedded", embedded: { regex: v.embedded } }, body);
    if (data === undefined) throw nothing("the --embedded regex found no JSON");
  } else if (!/html/i.test(e.response?.contentType ?? "")) {
    try {
      data = extract({ format: "json" }, body);
    } catch {
      // not JSON: show the text
    }
  }
  if (path) {
    data = getPath(data, path);
    // an empty list at the path is a result; a path that is not there is not
    if (data === undefined) throw nothing(`nothing at "${path}"`);
  }
  if (v.pick) {
    const fields = splitPick(v.pick);
    const before = data;
    data = pick(data, fields);
    // pick drops an item with none of the fields, so a misspelled field empties the list: not "no results"
    if (Array.isArray(before) && before.length && !(data as unknown[]).length)
      throw nothing(`none of the ${before.length} items has a picked field (${fields.join(", ")})`);
  }
  const sent = e.request.body === undefined ? undefined : shown(e.request.body);
  const form =
    sent !== undefined &&
    /x-www-form-urlencoded/i.test(e.request.headers["content-type"] ?? "") &&
    !/^\s*[[{]/.test(sent);
  const shownBody =
    sent === undefined ? undefined : form ? unlayer(Object.fromEntries(new URLSearchParams(sent))) : unlayer(sent);
  out({
    id: e.id,
    request: {
      method: e.request.method,
      url: shown(e.request.url),
      ...(shownBody !== undefined ? { body: capOutput(shownBody, 4000).data } : {}),
    },
    ...(e.response ? { status: e.response.status, type: e.response.contentType } : { aborted: !!e.aborted }),
    ...capOutput(unlayer(data)),
    ...(note ? { note } : {}),
  });
  return 0;
}

/** One shell word, quoted: a space, a quote or JSON in a hint's command pastes as a single argument. */
const sh = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The lists capture `c` loaded two pages of (`pagingHints`), each with the add flags that learn the
 * list from its second page. The cursor shows the run's live values as refs, as capture's URLs do.
 */
function pagesOf(c: CaptureFile, values: string[]) {
  const live = captureLive(c, values);
  return pagingHints(c.exchanges).map((h) => ({
    requests: [h.previous, h.request],
    paging: h.paging,
    flags: `--from ${c.id} --pick-request ${h.request} --example ${sh(`${h.paging.param}=${redact(h.value, live, { named: true })}`)} --paging ${sh(pagingFlag(h.paging))}`,
  }));
}
const withPages = (pages: ReturnType<typeof pagesOf>) => (pages.length ? { pages } : {});

/**
 * The command that repeats how capture `c` was made, with the second example's values where the
 * first's sit in its URL and steps. Undefined when they sit in neither: there is nothing to swap.
 */
function captureAgain(
  c: CaptureFile,
  ex1: Record<string, string>,
  ex2: Record<string, string>,
  write: boolean,
): string | undefined {
  const made = captureTrigger(c, ex1);
  if (!Object.keys(ex2).length || Object.keys(ex1).some((k) => !(k in ex2)) || unplaced(made, ex2).length)
    return undefined;
  const t = fillTrigger(made, ex2);
  return [
    `api-anything capture ${sh(t.url)}`,
    ...(t.softFrom ? [`--soft-from ${sh(t.softFrom)}`] : []),
    ...(t.steps ? [`--steps ${sh(JSON.stringify(t.steps))}`] : []),
    ...(write ? ["--write"] : []),
    ...Object.entries(ex2).map(([k, x]) => `--example ${sh(`${k}=${x}`)}`),
  ].join(" ");
}

/** --enum, --min and --max, by param name. */
function allowedOf(v: Parsed["v"]): Record<string, Pick<Param, "enum" | "min" | "max">> {
  const out: Record<string, Pick<Param, "enum" | "min" | "max">> = {};
  for (const [k, x] of Object.entries(kv(v.enum))) {
    const values = x
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!values.length) throw new Fail(`--enum ${k}= lists no value`, "api-anything add --help");
    out[k] = { ...out[k], enum: values };
  }
  for (const flag of ["min", "max"] as const)
    for (const [k, x] of Object.entries(kv(v[flag]))) {
      if (!/^-?\d+(\.\d+)?$/.test(x)) throw new Fail(`--${flag} ${k}=${x}: not a number`, "api-anything add --help");
      out[k] = { ...out[k], [flag]: Number(x) };
    }
  return out;
}

/** --paging <param>[=<path to the next cursor>] */
function pagingOf(flag: string | undefined): Paging | undefined {
  if (flag === undefined) return undefined;
  const eq = flag.indexOf("=");
  const param = (eq < 0 ? flag : flag.slice(0, eq)).trim();
  const next = eq < 0 ? undefined : flag.slice(eq + 1).trim();
  if (!param || next === "")
    throw new Fail(`--paging ${flag}: give <param> or <param>=<path>`, "api-anything add --help");
  return { param, ...(next ? { next } : {}) };
}

/** What a repair says it changed: the op was kept, and one thing in it replaced. */
async function cmdAdd({ v, pos, steps }: Parsed): Promise<number> {
  const [site, name] = pos;
  if (!site || !name) throw new Fail("missing <site> <op>", "api-anything add --help");
  if (!v.trigger && !v.from) throw new Fail("missing --trigger (or --from <captureId>)", "api-anything add --help");
  const ex1 = kv(v.example);
  const ex2 = v.example2 ? kv(v.example2) : undefined;
  const matchText =
    v.match?.length === 1 && v.match[0]!.trim().startsWith("{")
      ? v.match[0]
      : v.match
        ? JSON.stringify(kv(v.match))
        : undefined;
  const match = json(matchText, MatchSchema, "match");
  const html = json(v.html, HtmlRecipeSchema, "html");
  if (!v.from) needBrowser();
  if (v.from2 && !ex2)
    throw new Fail("--from2 needs --example2 (the values that capture was made with)", "api-anything add --help");
  if (v.from && ex2 && !v.from2) {
    const c = loadCapture(v.from);
    const write = !!(c.write || v.write);
    const again = captureAgain(c, ex1, ex2, write);
    throw new Fail(
      "--example2 with --from needs --from2: a capture holds one run",
      `${
        again
          ? `capture the page again with the second example's values: ${again}`
          : `the first example's values are not in capture ${c.id}'s url or steps, so the command cannot be written out: capture that page again the way ${c.id} was made (${["its url", c.softFrom && "--soft-from", c.steps && "--steps", write && "--write"].filter(Boolean).join(", ")}), with the second example's values`
      }; then run this add again with --from2 <the new capture's id>`,
    );
  }
  const r = await addOperation({
    site,
    op: name,
    trigger: v.trigger
      ? { url: v.trigger, ...(steps ? { steps } : {}), ...(v["soft-from"] ? { softFrom: v["soft-from"] } : {}) }
      : undefined,
    examples: ex2 ? [ex1, ex2] : [ex1],
    match,
    write: v.write,
    description: v.description,
    response: {
      ...(v.extract ? { extract: v.extract } : {}),
      ...(v.pick ? { pick: splitPick(v.pick) } : {}),
      ...(html ? { html } : {}),
      ...(v.embedded ? { embedded: { regex: v.embedded } } : {}),
    },
    public: v.public ? v.public.split(",").map((s) => s.trim().toLowerCase()) : undefined,
    from: v.from
      ? { capture: loadCapture(v.from), id: v["pick-request"] ? Number(v["pick-request"]) : undefined }
      : undefined,
    from2: v.from2 ? loadCapture(v.from2) : undefined,
    allowed: allowedOf(v),
    paging: pagingOf(v.paging),
  });
  const op = r.operation;
  const c = v.from && !v.paging && !op.paging ? loadCapture(v.from) : undefined;
  // the request learned, or the one before it, is one of two pages of a list the capture loaded
  const paged =
    c &&
    pagesOf(c, Object.values(ex1)).find((pg) =>
      pg.requests.some((id) => {
        const e = c.exchanges.find((x) => x.id === id);
        return e && matches(op.match, e.request);
      }),
    );
  if (paged)
    r.warnings.push(
      `requests ${paged.requests.join(" and ")} of capture ${c!.id} are two pages of this list: to page it, add it again with ${paged.flags} and its other --example values`,
    );
  out({
    ok: true,
    site,
    op: op.name,
    ...(r.replaced ? { replaced: true } : {}),
    request: `${op.request.method} ${op.request.url.split("?")[0]}`,
    params: op.params.map((p) => `${p.name}:${p.type}`),
    readOnly: op.readOnly,
    minTier: op.minTier,
    match: op.match,
    ...(op.response.extract ? { extract: op.response.extract } : {}),
    ...(op.paging ? { paging: op.paging } : {}),
    ...(op.readback ? { readback: op.readback } : {}),
    ...(r.preview ? { preview: r.preview } : {}),
    ...(op.unproven ? { unproven: op.unproven.params } : {}),
    warnings: r.warnings,
    ...(r.captures.length ? { captures: r.captures } : {}),
    saved: r.path,
    next: `api-anything call ${site} ${op.name} ${op.params.map((p) => `${p.name}=...`).join(" ")}`.trim(),
  });
  return 0;
}

/** Bound input bytes before parsing; a JSON parser's error may quote a credential from stdin. */
async function readInput(source = "-"): Promise<string> {
  const stream = source === "-" ? process.stdin : createReadStream(source);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += b.length;
    if (bytes > 4 * 1024 * 1024) throw new Fail("input exceeds 4 MiB", `api-anything ${command} --help`);
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdBatch({ v, pos }: Parsed): Promise<number> {
  if (pos.length > 1 || (pos.length && pos[0] !== "-") || (v.input !== undefined && pos.length))
    throw new Fail("pass --input <file> or -, not both", "api-anything batch --help");
  const maxItems = positive(v.limit, "limit") ?? BATCH_MAX;
  const concurrency = positive(v.concurrency, "concurrency") ?? 1;
  if (maxItems > BATCH_MAX || concurrency > BATCH_CONCURRENCY)
    throw new Fail("batch limits: --limit 1..200, --concurrency 1..4", "api-anything batch --help");
  if (v["max-tier"] !== undefined && !/^[123]$/.test(v["max-tier"]))
    throw new Fail("--max-tier must be 1, 2 or 3", "api-anything batch --help");
  const text = await readInput(v.input);
  const lines = text === "" ? [] : text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > maxItems)
    throw new Fail(`batch exceeds ${maxItems} lines; nothing was sent`, "split the input into smaller batches");
  const items = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null; // callReads gives this line an input result, without quoting its contents
    }
  }) as BatchItem[];
  let code = 0;
  for await (const r of callReads(items, {
    maxItems,
    concurrency,
    maxTier: v["max-tier"] ? (Number(v["max-tier"]) as Tier) : undefined,
  })) {
    if (!out(r)) await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
    if (!r.ok) code = 1;
  }
  return code;
}

function callView(v: Parsed["v"]): ResultView {
  const view = {
    ...(v.fields !== undefined ? { fields: splitPick(v.fields) } : {}),
    ...(v["max-chars"] !== undefined ? { maxChars: Number(v["max-chars"]) } : {}),
  };
  const problem = viewProblem(view);
  if (problem) throw new Fail(problem, "use --fields a,b and --max-chars 256..200000");
  return view;
}

async function cmdResult({ v, pos }: Parsed): Promise<number> {
  if (pos.length !== 1) throw new Fail("expected <resultId>", "api-anything result --help");
  if (v.format !== undefined && v.format !== "json")
    throw new Fail("--format must be json", "api-anything result --help");
  const r = getResult(pos[0]!, {
    ...callView(v),
    ...(v.offset !== undefined ? { offset: Number(v.offset) } : {}),
    ...(v.format === "json" ? { format: "json" as const } : {}),
  });
  out(r);
  if (!r.ok) process.stderr.write("next: check the resultId and continuation; expired results cannot be recovered\n");
  return r.ok ? 0 : 1;
}

async function cmdCall({ v, pos }: Parsed): Promise<number> {
  const [site, name, ...rest] = pos;
  if (!site || !name) throw new Fail("missing <site> <op>", "api-anything call --help");
  if (v["max-tier"] !== undefined && !/^[123]$/.test(v["max-tier"]))
    throw new Fail(`--max-tier must be 1, 2 or 3, got "${v["max-tier"]}"`, "pass --max-tier 1, 2 or 3");
  const view = callView(v);
  let base: Record<string, unknown> = {};
  if (v.json) {
    if (v.json === "-") {
      const text = await readInput();
      try {
        base = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
      } catch {
        throw new Fail("--json - expects one JSON args object on stdin", "api-anything call --help");
      }
    } else base = json(v.json, z.record(z.string(), z.unknown()), "json") ?? {};
  }
  const args = { ...base, ...kv(rest) };
  // A shared site this machine lacks is fetched first, as MCP does: an agent with a shell finds it by name.
  // It is marked as an agent's pull, so MCP keeps its writes hidden until a human runs pull.
  let pulled = false;
  try {
    if (!loadSite(site)) pulled = !!(await pull(site, { by: "agent" }));
  } catch {
    // not shared, or refused: call() answers "no site" with its next step
  }
  if (v.dry) {
    const { site: s } = requireSite(site);
    const op = s.operations.find((o) => o.name === name);
    if (!op) throw new Fail(`no operation "${name}" on ${site}`, `api-anything ops ${site}`);
    const unknown = unknownArgs(op, args);
    if (unknown) throw new Fail(unknown, `api-anything ops ${site}`);
    const request = buildRequest(op, args, placeholders(loadSession(site)));
    out({ ok: true, dry: true, request, ...(pulled ? { pulled: site } : {}) });
    return 0;
  }
  const maxTier = v["max-tier"] ? (Number(v["max-tier"]) as Tier) : undefined;
  const r = await call(site, name, args, {
    allowWrites: v["allow-writes"],
    again: v.again,
    idempotencyKey: v["idempotency-key"],
    maxTier,
    ignoreCoolDown: v.force,
    view,
  });
  out(pulled ? { ...r, pulled: site } : r);
  if (r.heal) process.stderr.write(healNote(site, name, r.heal));
  if (!r.ok) process.stderr.write(`next: ${r.next}\n`);
  return r.ok ? 0 : 1;
}

/** A heal, for the human at the terminal: how, what changed, and how to take it back. */
function healNote(site: string, op: string, h: NonNullable<CallResult["heal"]>): string {
  const undo = h.strategy === "registry" ? "" : `undo: api-anything revert ${site} ${op}\n`;
  return `healed ${op} by ${h.strategy}:\n${h.changes.map((c) => `  ${c}\n`).join("")}${undo}`;
}

/** The last 20 heals and reverts, newest first, with what each changed. */
function cmdHeals({ pos }: Parsed): number {
  const site = pos[0] ? requireSite(pos[0]).site.name : undefined;
  const heals = loadHeals(site)
    .slice(-20)
    .reverse()
    .map(({ previous, saved: _s, diff, changes, ...h }) => ({
      ...h,
      changes: changes ?? [diff],
      ...(h.strategy !== "revert" && !previous ? { revertible: false } : {}),
    }));
  out({ ok: true, heals });
  return 0;
}

function cmdStatus({ pos }: Parsed): number {
  out(status(pos[0] ? requireSite(pos[0]).site.name : undefined));
  return 0;
}

function cmdStats({ v, pos }: Parsed): number {
  if (pos.length) throw new Fail(`stats takes no site (got "${pos[0]}")`, "api-anything stats [--days n] [--card]");
  const days = v.days === undefined ? KEEP_CALLS_DAYS : Number(v.days);
  if (!Number.isInteger(days) || days < 1 || days > KEEP_CALLS_DAYS)
    throw new Fail(
      `--days must be a whole number from 1 to ${KEEP_CALLS_DAYS} (the call log keeps ${KEEP_CALLS_DAYS} days), got "${v.days}"`,
      `api-anything stats --days ${KEEP_CALLS_DAYS}`,
    );
  const s = stats(days);
  if (v.card) process.stdout.write(card(s));
  else out(s);
  return 0;
}

function cmdRevert({ pos }: Parsed): number {
  const [site, name] = pos;
  if (!site || !name) throw new Fail("missing <site> <op>", "api-anything revert <site> <op>");
  const { site: s } = requireSite(site);
  if (!s.operations.some((o) => o.name === name))
    throw new Fail(`no operation "${name}" on ${s.name}`, `api-anything ops ${s.name}`);
  try {
    const r = revertHeal(site, name);
    out({
      ok: true,
      site: r.site,
      op: name,
      reverted: { at: r.reverted.at, strategy: r.reverted.strategy },
      changes: r.changes,
    });
    return 0;
  } catch (e) {
    throw new Fail((e as Error).message, `api-anything heals ${site} lists ${name}'s heals`);
  }
}

/** The user's own specs: those in ~/.api-anything/sites, bundled and pulled ones aside. */
function userSites(): string[] {
  const dir = userSitesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

/**
 * Exit 0 when every counted case passed, 1 when any failed (or a site could not be verified), 2 when
 * the only non-passing cases were inconclusive. --strict exits 1 for an inconclusive case or a write
 * whose preflight is not ok too; without it a preflight never sets the exit code, since nothing was
 * sent to judge.
 */
async function cmdVerify({ v, pos }: Parsed): Promise<number> {
  if (v.user && pos.length)
    throw new Fail("--user takes no site names", "api-anything verify --user, or name the sites");
  const names = pos.length ? pos.map((p) => requireSite(p).site.name) : v.user ? userSites() : listSites();
  const results: Record<string, unknown>[] = [];
  const proven: string[] = [];
  const newlyFailing: string[] = [];
  const recovered: string[] = [];
  const failingSince: Record<string, string> = {};
  for (const name of names) {
    try {
      const r = await verifySite(name);
      results.push(
        ...r.results.map((c) => ({
          site: name,
          ...c,
          ok: "outcome" in c ? c.outcome === "pass" : "preflight" in c ? c.preflight.ok : false,
        })),
      );
      proven.push(...r.proven.map((op) => `${name}/${op}`));
      newlyFailing.push(...r.newlyFailing.map((op) => `${name}/${op}`));
      recovered.push(...r.recovered.map((op) => `${name}/${op}`));
      for (const [op, since] of Object.entries(r.failingSince)) failingSince[`${name}/${op}`] = since;
    } catch (e) {
      results.push({ site: name, ok: false, error: oneLine((e as Error).message) });
    }
  }
  const count = (o: string) => results.filter((r) => r.outcome === o).length;
  const errors = results.filter((r) => r.error).length;
  const unready = results.filter((r) => r.preflight && !r.ok).length;
  const failed = count("fail") + errors > 0;
  const inconclusive = count("inconclusive") > 0;
  const ok = !failed && !inconclusive && (!v.strict || !unready);
  const own = names.length === 1 ? loadSite(names[0]!) : undefined;
  // a site the user learned and just saw work is one others could use
  const share = ok && own?.source === "user" && !own.site.shared;
  out({
    ok,
    counts: {
      pass: count("pass"),
      fail: count("fail"),
      inconclusive: count("inconclusive"),
      skipped: results.filter((r) => r.skipped).length,
      preflight: results.filter((r) => r.preflight).length,
    },
    results,
    ...(proven.length ? { proven } : {}),
    newlyFailing,
    recovered,
    failingSince,
    ...(share
      ? { next: `api-anything publish ${own.site.name} previews sharing it, so others need not learn it` }
      : {}),
  });
  if (failed)
    process.stderr.write(
      "next: a failing case is a broken op or a wrong check: follow each failing case's own next hint once (change a check only when the site's own page answers its args the other way), then report what still fails\n",
    );
  else if (inconclusive)
    process.stderr.write(
      "next: an inconclusive case tested nothing: follow its next hint (login, or wait), then verify again\n",
    );
  else if (v.strict && unready)
    process.stderr.write("next: a write's preflight found something a call would need first: follow its next hint\n");
  if (failed) return 1;
  if (inconclusive) return v.strict ? 1 : 2;
  return v.strict && unready ? 1 : 0;
}

async function cmdCheck({ v, pos }: Parsed): Promise<number> {
  const [site, name, ...rest] = pos;
  if (!site || !name) throw new Fail("missing <site> <op>", "api-anything check --help");
  const op = requireSite(site).site.operations.find((o) => o.name === name);
  if (!op) throw new Fail(`no operation "${name}" on ${site}`, `api-anything ops ${site}`);
  if (!op.readOnly) throw new Fail(`${name} is a write: a check would send it`, "checks are for reads only");
  const parsed = CheckSchema.safeParse({
    args: kv(rest),
    expect: v.expect,
    ...(v.purpose ? { purpose: v.purpose } : {}),
  });
  if (!parsed.success)
    throw new Fail(
      v.expect === undefined ? "missing --expect" : `--expect must be result, empty or input, got "${v.expect}"`,
      "api-anything check --help",
    );
  const check = parsed.data;
  const unknown = Object.keys(check.args).filter((k) => !op.params.some((p) => p.name === k));
  if (unknown.length)
    throw new Fail(
      `unknown arg ${unknown.join(", ")}; ${name} takes ${op.params.map((p) => p.name).join(", ") || "no args"}`,
      `api-anything ops ${site}`,
    );
  const missing = op.params.filter((p) => p.required && p.default === undefined && check.args[p.name] === undefined);
  if (missing.length && check.expect !== "input")
    throw new Fail(`missing ${missing.map((p) => p.name).join(", ")}`, "a check gives every required param");
  const key = (a: Record<string, unknown>) => JSON.stringify(Object.entries(a).sort());
  let replaced = false;
  const path = updateSite(site, (cur) => {
    if (!cur) throw new Error(`site "${site}" disappeared`);
    return {
      ...cur,
      operations: cur.operations.map((o) => {
        if (o.name !== name) return o;
        replaced = !!o.checks?.some((c) => key(c.args) === key(check.args));
        return { ...o, checks: [...(o.checks ?? []).filter((c) => key(c.args) !== key(check.args)), check] };
      }),
    };
  });
  out({
    ok: true,
    site,
    op: name,
    check,
    ...(replaced ? { replaced: true } : {}),
    saved: path,
    next: `api-anything verify ${site}`,
  });
  return 0;
}

/** readback <site> <write> <read> [k=v ...] [--find field=value]: how a write's call proves it landed. */
function cmdReadback({ v, pos }: Parsed): number {
  const [site, name, readOp, ...rest] = pos;
  if (!site || !name || !readOp) throw new Fail("missing <site> <write-op> <read-op>", "api-anything readback --help");
  const s = requireSite(site).site;
  const op = s.operations.find((o) => o.name === name);
  if (!op) throw new Fail(`no operation "${name}" on ${site}`, `api-anything ops ${site}`);
  let find: Readback["find"];
  if (v.find !== undefined) {
    const eq = v.find.indexOf("=");
    if (eq < 1) throw new Fail(`--find ${v.find}: give <field>=<value>`, "api-anything readback --help");
    find = { field: v.find.slice(0, eq), equals: v.find.slice(eq + 1) };
  }
  const readback: Readback = { op: readOp, args: kv(rest), ...(find ? { find } : {}) };
  const problems = readbackProblems(s, { ...op, readback });
  if (problems.length)
    throw new Fail(problems.join("; "), `api-anything ops ${site} shows the params of ${name} and ${readOp}`);
  const path = updateSite(site, (cur) => {
    if (!cur) throw new Error(`site "${site}" disappeared`);
    return { ...cur, operations: cur.operations.map((o) => (o.name === name ? { ...o, readback } : o)) };
  });
  out({
    ok: true,
    site,
    op: name,
    readback,
    saved: path,
    next: `api-anything call ${site} ${name} ... --allow-writes`,
  });
  return 0;
}

function cmdSites(): number {
  out(
    listSites().map((name) => {
      try {
        const r = loadSite(name)!;
        return {
          name,
          source: r.source,
          operations: r.site.operations.length,
          ...(r.site.description ? { description: r.site.description } : {}),
        };
      } catch (e) {
        return { name, error: (e as Error).message };
      }
    }),
  );
  return 0;
}

function cmdOps({ pos, v }: Parsed): number {
  const { site } = requireSite(pos[0]);
  if (v.schema) {
    if (pos.length !== 2) throw new Fail("--schema needs <site> <op>", "api-anything ops <site> <op> --schema");
    if (!site.operations.some((o) => o.name === pos[1]))
      throw new Fail(`no operation "${pos[1]}" on ${site.name}`, `api-anything ops ${site.name}`);
    out(describeOperation(site, pos[1]!));
    return 0;
  }
  if (pos.length !== 1) throw new Fail("use <op> with --schema", `api-anything ops ${site.name} <op> --schema`);
  const notes = siteNotes(site.name);
  const about = (p: Operation["params"][number]) => [
    ...(p.description ? [p.description] : []),
    ...(p.example !== undefined ? [`e.g. ${JSON.stringify(p.example)}`] : []),
    ...(p.hint ? [p.hint] : p.pattern ? [`matches /${p.pattern}/`] : []),
    ...(p.enum ? [`one of ${p.enum.join(", ")}`] : []),
    ...(p.min !== undefined || p.max !== undefined ? [`${p.min ?? ""}..${p.max ?? ""}`] : []),
  ];
  out({
    site: site.name,
    baseUrl: site.baseUrl,
    operations: site.operations.map((o) => ({
      name: o.name,
      ...(o.description ? { description: o.description } : {}),
      readOnly: o.readOnly,
      ...(returnedFields(o.response) ? { returns: returnedFields(o.response) } : {}),
      params: o.params.map(
        (p) => `${p.name}:${p.type}${p.required ? "" : "?"}${about(p).length ? ` (${about(p).join("; ")})` : ""}`,
      ),
      ...(o.minTier > 1 ? { minTier: o.minTier } : {}),
      ...(o.checks?.length ? { checks: o.checks.length } : {}),
      ...(o.paging
        ? { pages: o.paging.next ? `by ${o.paging.param}: pass the result's nextPage` : `by ${o.paging.param}` }
        : {}),
      ...(o.readback ? { readback: readbackName(o.readback) } : {}),
      ...(o.unproven ? { unproven: o.unproven.reason } : {}),
      trigger: o.trigger.url,
    })),
    ...(site.shared ? { shared: SHARED_NOTE } : {}),
    ...(notes ? { notes } : {}),
  });
  return 0;
}

async function cmdHeal({ pos }: Parsed): Promise<number> {
  const [site, name, ...rest] = pos;
  if (!site || !name) throw new Fail("missing <site> <op>", "api-anything heal <site> <op>");
  const op = requireSite(site).site.operations.find((o) => o.name === name);
  const r = await heal(site, name, { ...(op ? examplesOf(op) : {}), ...kv(rest) });
  out(r);
  if (!r.ok) process.stderr.write(`next: ${r.next}\n`);
  return r.ok ? 0 : 1;
}

function cmdExport({ v, pos }: Parsed): number {
  requireSite(pos[0]);
  const r = exportSite(pos[0]!, { keepExamples: v["keep-examples"] });
  if (r.secrets.length && !v.force) {
    throw new Fail(
      `refusing to export: ${r.secrets.length} live credential(s) in the spec`,
      "remove them (re-add the op or edit the spec); --force only if a human confirmed they are public",
      { secrets: r.secrets },
    );
  }
  for (const w of r.warnings) process.stderr.write(`warning: ${w}\n`);
  const text = `${JSON.stringify(r.spec, null, 2)}\n`;
  if (v.out) {
    writeFileSync(v.out, text);
    out({ ok: true, out: v.out, warnings: r.warnings.length });
  } else process.stdout.write(text);
  return 0;
}

async function cmdSearch({ pos }: Parsed): Promise<number> {
  const query = pos.join(" ").trim();
  if (!query) throw new Fail("missing <words | domain | url>", "api-anything search book ratings");
  const r = await search(query);
  const top = r.matches[0];
  out({
    ok: true,
    query,
    matches: r.matches,
    ...(r.registryError ? { registryError: r.registryError } : {}),
    ...(r.matches.length ? { shared: SHARED_NOTE } : {}),
    next: !top
      ? "nothing matched. Broaden the query or check api-anything sites before learning. Words find only sites whose operations other installs confirmed: if you know the site's domain or a page URL, search with that, which also finds unconfirmed ones; else learn it with api-anything learn"
      : !top.operations.length && top.interfaces?.length
        ? `${top.domain} offers its own agent interface: ${top.interfaces.map((i) => `${i.kind} ${i.url}`).join(", ")}`
        : r.matches.every((m) => m.unmatched.length)
          ? `partial lexical matches, not guarantees for the unmatched constraints: check that ${top.domain} is the site meant, then api-anything ${top.installed ? "ops" : "pull"} ${top.site}; read its notes and warnings, then try the core capabilities or broaden the query before learning a new site`
          : top.installed
            ? `check that ${top.domain} is the site meant, then api-anything ops ${top.site} lists its operations`
            : `check that ${top.domain} is the site meant (a lookalike name can point elsewhere), then api-anything pull ${top.site} fetches it; read its warnings with the user before the first call`,
  });
  return 0;
}

async function cmdInterface({ pos }: Parsed): Promise<number> {
  const [kind, url] = pos;
  if ((kind !== "mcp" && kind !== "openapi") || !url)
    throw new Fail("usage: interface mcp|openapi <url>", "api-anything interface --help");
  out({ ok: true, ...(await reportInterface(kind, url)) });
  return 0;
}

async function cmdPull({ pos }: Parsed): Promise<number> {
  if (!pos[0]) throw new Fail("missing <site>", "api-anything pull <site>");
  let r: Awaited<ReturnType<typeof pull>>;
  try {
    r = await pull(pos[0]);
  } catch (e) {
    const missing = /^no shared spec/.test((e as Error).message);
    throw new Fail(
      (e as Error).message,
      missing
        ? `nobody shared ${pos[0]} yet: learn it with api-anything capture and add, then share it with api-anything publish`
        : e instanceof RegistryError
          ? "the registry request failed, not the spec: check the network (and API_ANYTHING_REGISTRY if it is set), then retry"
          : "do not edit the pulled spec to get past this; learn the site with capture and add instead",
    );
  }
  out({
    ok: true,
    ...r,
    next: r.shadowedBy
      ? `your own copy ${r.shadowedBy} wins over the pulled one; delete it to use the pulled spec`
      : `read the warnings with the user before the first call; api-anything ops ${r.site} lists the ops`,
  });
  return 0;
}

async function cmdPublish({ v, pos }: Parsed): Promise<number> {
  const [name, ...ops] = pos;
  const { site } = requireSite(name);
  const again = `api-anything publish ${[site.name, ...ops].join(" ")}`;
  let p: ReturnType<typeof plan>;
  try {
    // the preview shows what --yes sends: with the user's yes, their notes go too
    p = plan(site.name, { ops, consent: true, as: await uploadName(site.name) });
  } catch (e) {
    throw new Fail(oneLine((e as Error).message), `api-anything ops ${site.name}`);
  }
  if (p.errors.length)
    throw new Fail(
      `refusing to publish ${p.site}: ${p.errors.length} problem(s)`,
      "fix each one (a live value: re-add the op so learning makes it a ref; a failing check: see api-anything verify) and preview again",
      { errors: p.errors },
    );
  if (!v.yes) {
    out({
      ok: true,
      site: p.site,
      ...(p.as ? { as: `${p.as}: the registry names a new site after its domain, so it goes up under that name` } : {}),
      uploads: p.ops.map((o) => o.upload),
      operations: p.operations,
      stripped: p.stripped,
      warnings: p.warnings,
      personal: p.personal,
      checks: p.checks,
      public: "each upload is public: anyone can fetch it from the registry, param examples included",
      next: `show the user each upload and every warning and personal item; only with their explicit OK: ${again} --yes`,
    });
    return 0;
  }
  const shared = await shareOps(
    site.name,
    p.ops.map((o) => o.op),
    { evidence: {}, consent: true },
  );
  const ok = shared.every((s) => s.shared);
  out({
    ok,
    shared,
    next: ok
      ? "others can call them now; one that needed a login or writes is served to others once a maintainer reviews it"
      : "fix the reason given for each op that was not shared, then run it again",
  });
  return ok ? 0 : 1;
}

async function cmdSetup({ v }: Parsed): Promise<number> {
  if (v.yes && v["no-share"]) throw new Fail("--yes and --no-share contradict each other", "pass one of them");
  if (v["share-only"]) {
    if (!v.yes && !v["no-share"])
      throw new Fail("--share-only records an answer: pass --yes or --no-share with it", "api-anything setup --help");
    const share = !!v.yes;
    if (!v["dry-run"]) answerShare(share);
    out({ ok: true, ...(v["dry-run"] ? { dryRun: true } : {}), share, shareAsked: true });
    process.stderr.write(
      `Sharing: ${v["dry-run"] ? "would be " : ""}${share ? "on. Turn it off with api-anything setup --no-share --share-only" : "off. Turn it on with api-anything setup --yes --share-only"}\n`,
    );
    return 0;
  }
  const agents = v.agents?.split(",").map((a) => a.trim());
  const unknown = agents?.filter((a) => !(AGENTS as readonly string[]).includes(a));
  if (unknown?.length)
    throw new Fail(
      `unknown agent ${unknown.join(", ")}; the agents are ${AGENTS.join(", ")}`,
      "api-anything setup --help",
    );
  const r = await setup({
    agents: agents as Agent[] | undefined,
    dryRun: v["dry-run"],
    share: v.yes ? true : v["no-share"] ? false : undefined,
    ask: process.stdin.isTTY && process.stderr.isTTY ? askYesNo : undefined,
  });
  out(r);
  process.stderr.write(`${summary(r)}\n`);
  return r.ok ? 0 : 1;
}

async function cmdLearn({ v, pos, steps }: Parsed): Promise<number> {
  const trigger = pos[0];
  if (!trigger) throw new Fail("missing <trigger>", "api-anything learn --help");
  if ((v.from === undefined) !== (v.from2 === undefined))
    throw new Fail("--from and --from2 go together: the two captures of an earlier learn", "api-anything learn --help");
  const r = await learnSite(
    {
      trigger,
      args: kv(v.args),
      args2: kv(v.args2),
      args3: kv(v.args3),
      ...(v.site ? { site: v.site } : {}),
      ...(v.op ? { op: v.op } : {}),
      ...(v.intent ? { intent: v.intent } : {}),
      ...(v["pick-request"] !== undefined ? { pickRequest: Number(v["pick-request"]) } : {}),
      ...(v.extract ? { extract: v.extract } : {}),
      ...(v.pick ? { pick: splitPick(v.pick) } : {}),
      ...(v.html ? { html: json(v.html, HtmlRecipeSchema, "html") } : {}),
      ...(v.embedded ? { embedded: v.embedded } : {}),
      ...(v.from && v.from2 ? { captures: [v.from, v.from2] as [string, string] } : {}),
      ...(v.fresh ? { fresh: true } : {}),
      ...(v.write ? { write: true } : {}),
      ...(v.paging ? { paging: pagingOf(v.paging) } : {}),
      ...(steps ? { steps } : {}),
    },
    { consent: process.stdin.isTTY && process.stderr.isTTY ? askYesNo : undefined },
  );
  out(r);
  if (r.next) process.stderr.write(`next: ${r.next}\n`);
  return r.ok ? 0 : 1;
}

async function cmdMcp({ v }: Parsed): Promise<number> {
  if (v["no-learn"]) (await import("./mcp-learn.js")).learnTool.enabled = false;
  const sites = (v.sites ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sites) if (!loadSite(s)) throw new Fail(`no site "${s}"`, "api-anything sites lists them");
  if (v["print-config"]) {
    const flags = [
      ...(v["allow-writes"] ? ["--allow-writes"] : []),
      ...(sites.length ? ["--sites", sites.join(",")] : []),
      ...(v["no-learn"] ? ["--no-learn"] : []),
    ];
    process.stdout.write(`${printConfig(launchOf(fileURLToPath(import.meta.url), flags))}\n`);
    return 0;
  }
  const { serveStdio } = await import("./mcp.js");
  await serveStdio({ allowWrites: v["allow-writes"], sites });
  return -1; // keep serving
}

type Flag = keyof typeof OPTIONS;
/** Each command and the flags it takes: run() refuses any other, so none is silently ignored. */
const COMMANDS: Record<string, { run: (p: Parsed) => number | Promise<number>; flags: Flag[] }> = {
  login: { run: cmdLogin, flags: ["profile", "window", "cookies"] },
  logout: { run: cmdLogout, flags: [] },
  capture: { run: cmdCapture, flags: ["steps", "soft-from", "example", "write", "limit", "outline"] },
  inspect: { run: cmdInspect, flags: ["path", "extract", "pick", "html", "embedded", "outline", "example"] },
  add: {
    run: cmdAdd,
    flags: [
      "trigger",
      "example",
      "example2",
      "steps",
      "soft-from",
      "match",
      "from",
      "pick-request",
      "from2",
      "extract",
      "pick",
      "html",
      "embedded",
      "public",
      "write",
      "description",
      "enum",
      "min",
      "max",
      "paging",
    ],
  },
  batch: { run: cmdBatch, flags: ["input", "concurrency", "limit", "max-tier"] },
  call: {
    run: cmdCall,
    flags: ["json", "allow-writes", "again", "idempotency-key", "max-tier", "force", "dry", "fields", "max-chars"],
  },
  result: { run: cmdResult, flags: ["offset", "fields", "max-chars", "format"] },
  verify: { run: cmdVerify, flags: ["user", "strict"] },
  check: { run: cmdCheck, flags: ["expect", "purpose"] },
  readback: { run: cmdReadback, flags: ["find"] },
  sites: { run: cmdSites, flags: [] },
  ops: { run: cmdOps, flags: ["schema"] },
  heal: { run: cmdHeal, flags: [] },
  heals: { run: cmdHeals, flags: [] },
  status: { run: cmdStatus, flags: [] },
  stats: { run: cmdStats, flags: ["days", "card"] },
  revert: { run: cmdRevert, flags: [] },
  export: { run: cmdExport, flags: ["out", "keep-examples", "force"] },
  search: { run: cmdSearch, flags: [] },
  interface: { run: cmdInterface, flags: [] },
  pull: { run: cmdPull, flags: [] },
  publish: { run: cmdPublish, flags: ["yes"] },
  mcp: { run: cmdMcp, flags: ["allow-writes", "sites", "print-config", "no-learn"] },
  setup: { run: cmdSetup, flags: ["yes", "no-share", "share-only", "agents", "dry-run"] },
  learn: {
    run: cmdLearn,
    flags: [
      "args",
      "args2",
      "args3",
      "site",
      "op",
      "intent",
      "pick-request",
      "extract",
      "pick",
      "html",
      "embedded",
      "from",
      "from2",
      "fresh",
      "write",
      "paging",
      "steps",
    ],
  },
};

async function run(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  const [cmd, ...pos] = positionals;
  if (v.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  // an own key only: `toString` is on every object
  const c = cmd && Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!cmd || !c) {
    process.stdout.write(`${USAGE}\n`);
    if (!cmd || v.help) return 0;
    process.stderr.write(`next: unknown command "${cmd}"; see the list above\n`);
    return 1;
  }
  if (v.help) {
    process.stdout.write(`${HELP[cmd]}\n`);
    return 0;
  }
  const extra = Object.keys(v).filter((k) => !c.flags.includes(k as Flag));
  if (extra.length)
    throw new Fail(`${cmd} does not take --${extra.join(", --")}`, `api-anything ${cmd} --help lists its flags`);
  command = cmd;
  // setup installs the skill itself, and says so in its summary
  if (cmd !== "setup")
    for (const r of refreshSkills())
      if (r.skill === "updated")
        process.stderr.write(
          `api-anything: updated the skill at ${r.skillDir}${r.skillBackup ? ` (the old copy is in ${r.skillBackup})` : ""}\n`,
        );
  return c.run({ v, pos, steps: stepsOf(v.steps) });
}

try {
  const code = await run(process.argv.slice(2));
  if (code >= 0) {
    // the answer is out: reports and heal-backs get a moment, never a wait the user notices
    await settle(1500);
    await closeBrowser();
    process.exitCode = code;
  }
} catch (e) {
  await closeBrowser();
  const f = e instanceof Fail ? e : undefined;
  // Playwright errors carry the whole browser command line after the first line
  out({ ok: false, error: oneLine((e as Error).message), ...(f?.extra ?? {}) });
  const next =
    f?.next ??
    (e instanceof ProfileInUse ? PROFILE_HINT : `api-anything ${process.argv[2] ?? ""} --help`.replace(/\s+/g, " "));
  process.stderr.write(`next: ${next}\n`);
  process.exitCode = 1;
}
