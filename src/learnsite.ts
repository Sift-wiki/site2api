/**
 * One call that learns a read a site lacks, proves it and shares it (docs/REGISTRY.md, "Learning an
 * operation that does not exist"). It is `add` with the user's args as example 1 and the agent's second
 * value as example 2, the request and recipe taken from run 1's outline unless the agent chose them;
 * then a holdout call through call(), a replay with no cookies, and shareOps.
 */
import { readFileSync } from "node:fs";
import { browserAvailable, ProfileInUse } from "./browser.js";
import { type Proof, recordCases } from "./checks.js";
import { botWall, judge } from "./classify.js";
import { cleanCall } from "./clean.js";
import { asText } from "./codec.js";
import { DEADLINE, DeadlineExceeded, within } from "./deadline.js";
import { siteOf, slugOf } from "./domain.js";
import { call, type NextCall } from "./execute.js";
import { capOutput, extract } from "./extract.js";
import {
  type AddInput,
  addOperation,
  type CaptureFile,
  CaptureUnavailable,
  capturePage,
  fillTrigger,
  loadCapture,
  loginWall,
  NotARead,
  PROFILE_HINT,
} from "./heal.js";
import { buildRequest } from "./http.js";
import { answerShare, loadSettings, localOnly, QUESTION } from "./identity.js";
import { type Args, capturePages, lookedUp, pageUrls, rankCandidates } from "./learn.js";
import { resolveLoginTarget } from "./login.js";
import { lookupOp } from "./lookup.js";
import { outline } from "./outline.js";
import { pagingHints } from "./paging.js";
import { spelled } from "./publish.js";
import { pull, registryRequest, sharedName } from "./registry.js";
import type { Evidence, ServedSite } from "./registry-api.js";
import { summarize } from "./search.js";
import { captureLive, redact } from "./secrets.js";
import { safeName } from "./session.js";
import { HOLDOUT_PURPOSE, type ShareOutcome, shareOps } from "./share.js";
import { CheckSchema, type Operation, type Paging } from "./spec.js";
import { loadSite, updateSite } from "./store.js";
import type { Exchange, TriggerStep } from "./types.js";
import { badAddress, LIMITS, notARead } from "./vet.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

export type Recipe = Pick<NonNullable<AddInput["response"]>, "extract" | "pick" | "html" | "embedded">;

export interface LearnSiteInput {
  /** a site name; default: named from the trigger's host, as `login <url>` names one */
  site?: string;
  /** the operation's name; default: from the trigger's path */
  op?: string;
  /** the page URL with `{param}` placeholders */
  trigger: string;
  /** the user's own request: run 1, and the data returned */
  args: Args;
  /** another real value of the same kind: run 2, and the op's stored (published) example */
  args2: Args;
  /** a third: the holdout call, recorded as the op's check */
  args3: Args;
  /** what the op is for; becomes its description unless it holds one of the user's values */
  intent?: string;
  /** a request id from run 1 (`chosen` and `alternatives` list them) */
  pickRequest?: number;
  extract?: string;
  pick?: string[];
  html?: Recipe["html"];
  embedded?: string;
  /** an earlier result's `captures` (run 1, run 2): learn again with other choices and no browser */
  captures?: [string, string];
  /** learn the page anew even when an op someone shared answers for it (`reused` was not what the user wanted) */
  fresh?: boolean;
  /** refused: a write is learned with the CLI's `add --write`, which intercepts it */
  write?: boolean;
  /** UI steps after load, as `add --steps` takes them ({param} filled): a click on "Show more" loads page 2 */
  steps?: TriggerStep[];
  /**
   * the list pages, as `add --paging` says it. Without it, a list both runs load two pages of is
   * learned with the paging they show (`pagedOf`).
   */
  paging?: Paging;
}

export interface LearnSiteOptions {
  /** asks the user whether to share an op that needs their yes; undefined: they could not be asked */
  consent?: (message: string) => Promise<boolean | undefined>;
  minIntervalMs?: number;
  /**
   * MCP's address rule (`learnTool.publicOnly`): what is ranked, shown, learned, replayed and saved is
   * https on a public host, as the trigger is, and the saved op keeps the rule (`Operation.publicOnly`)
   */
  publicOnly?: boolean;
}

interface Choice {
  request: number;
  method: string;
  url: string;
  type?: string;
  carries?: string[];
  recipe?: Recipe;
  /** field -> sample, for a `pick` */
  fields?: Record<string, string>;
}

export interface LearnSiteResult {
  ok: boolean;
  class?: "refused";
  site?: string;
  op?: string;
  /** `name(params) -> fields` */
  signature?: string;
  /** the answer to the user's own request (run 1) */
  data?: unknown;
  truncated?: string;
  chosen?: Choice & { recipe: Recipe; auto: boolean };
  /** the op's paging; auto: found in both runs, not given */
  paging?: Paging & { auto: boolean };
  /** the page after `data`: pass it as the paging param (see CallResult.nextPage) */
  nextPage?: string | number;
  hasMore?: boolean;
  alternatives?: Choice[];
  proof?: {
    holdout: { args: Args; ok: boolean; class: string; tier?: 1 | 2 | 3; reason?: string };
    cleanReplay: Evidence["cleanReplay"];
    cleanReason?: string;
  };
  shared?: ShareOutcome;
  /** an op someone shared for the same page answered: nothing was learned or uploaded */
  reused?: { site: string; op: string; status?: string };
  warnings?: string[];
  captures?: string[];
  saved?: string;
  error?: string;
  next?: string;
  nextCall?: NextCall;
}

/** What `next` says while setup's question was never answered. */
const ASK = `sharing was never set up on this install: ask the user once, in these words: "${QUESTION}" On yes, run api-anything setup --yes --share-only; on no, api-anything setup --no-share --share-only. Either answer is kept, and never asked again`;

/**
 * The registry's site for the trigger's domain (`name`), when one of its reads is behind the same page:
 * pulled as an agent pulls (reads only, the shared rules, a candidate called with no cookies) and called
 * with the user's args. Undefined when there is none, or its call does not answer with data: then it is
 * learned. A user's own copy under that name is called as it is, never pulled over.
 */
async function reuse(
  input: LearnSiteInput,
  name: string | undefined,
  askOnce: () => Promise<void>,
  o: LearnSiteOptions,
): Promise<LearnSiteResult | undefined> {
  if (!name) return undefined;
  let local: ReturnType<typeof loadSite>;
  try {
    local = loadSite(name);
  } catch {
    return undefined;
  }
  const match = (ops: Operation[]) =>
    ops.flatMap((op) => {
      const args = op.readOnly ? sameTrigger(op, input.trigger, input.args) : undefined;
      return args ? [{ op, args }] : [];
    })[0];
  if (!local || local.source === "registry")
    try {
      // only a site with an op for this page is pulled; what is called is the pulled copy, vetted
      const served = await registryRequest<ServedSite>(`/v1/sites/${name}`, {
        cap: LIMITS.file + LIMITS.notes + 64 * 1024,
        timeoutMs: 5000,
      });
      if (!match(served.operations.map((x) => x.operation))) return undefined;
      await pull(name, { by: "agent" });
      local = loadSite(name);
    } catch {
      return undefined;
    }
  const found = local && match(local.site.operations);
  if (!found) return undefined;
  // its report is what promotes it: the question is asked before the call, if it never was
  await askOnce();
  const op = found.op.name;
  const r = await call(name, op, found.args, { minIntervalMs: o.minIntervalMs });
  if (!r.ok || empty(r.data)) return undefined;
  const answer = capOutput(r.data);
  const status = found.op.version?.status;
  return {
    ok: true,
    site: name,
    op,
    signature: summarize(found.op).op,
    data: answer.data,
    ...(answer.truncated ? { truncated: answer.truncated } : {}),
    reused: { site: name, op, ...(status ? { status } : {}) },
    next: `${loadSettings().askedAt || localOnly() ? "" : `${ASK}. `}this is ${name}.${op}, shared by others: call_operation it from now on. If data is not what the user wanted, call learn_site again with the same input plus fresh: true to learn your own`,
  };
}

/** Replaced by tests: the real shareOps belongs to the registry client. */
export const hooks = { share: shareOps };

const clip = (u: string) => (u.length > 160 ? `${u.slice(0, 157)}...` : u);

/** The registrable domain of a URL, or undefined when it is none. */
const domainOf = (url: string) => {
  try {
    return siteOf(new URL(url).hostname.toLowerCase());
  } catch {
    return undefined;
  }
};
const empty = (d: unknown) =>
  d === undefined || d === null || (Array.isArray(d) && !d.length) || (typeof d === "object" && !Object.keys(d).length);

/** The recipe run 1's outline suggests for one request, if it can read the example values out of it. */
function suggest(e: Exchange, carries: string[], values: string[]): Pick<Choice, "recipe" | "fields"> | undefined {
  const r = e.response;
  const o = r?.body ? outline(r.contentType, r.body, values) : undefined;
  if (!o) return undefined;
  // a JSON answer is learnable only from a request that carries the args
  if (o.json)
    return carries.length && o.json.at
      ? { recipe: o.json.extract ? { extract: o.json.extract } : {}, fields: o.json.fields }
      : undefined;
  if (o.list) return { recipe: { html: { items: o.list.items, fields: o.list.fields } }, fields: o.list.sample };
  const block = o.embedded?.find((b) => b.at) ?? o.embedded?.find((b) => b.regex.startsWith("application/ld"));
  if (block)
    return {
      recipe: { embedded: { regex: block.regex }, ...(block.extract ? { extract: block.extract } : {}) },
      fields: block.fields,
    };
  return undefined;
}

/**
 * The best-ranked data request of a run that carries no example value but holds one an earlier request
 * that carries them looked up (`lookedUp`), with what it looked up.
 */
function lookedUpData(run: CaptureFile, args: Args): { id: number; why: string } | undefined {
  const pages = pageUrls(run.exchanges, capturePages(run));
  const data = rankCandidates(run.exchanges, args, { pages }).filter(
    (c) => !c.hits.length && c.status !== undefined && c.status >= 200 && c.status < 300 && c.size > 0,
  );
  for (const c of data) {
    const e = run.exchanges.find((x) => x.id === c.id)!;
    const [hit] = lookedUp(run.exchanges, e, args, pages);
    if (hit)
      return {
        id: c.id,
        why: `${hit.leaf.at.join(" > ")} is ${hit.path} in the answer of request ${hit.lookup.id} (GET ${new URL(hit.lookup.request.url).pathname}), which carries ${hit.params.join(", ")}`,
      };
  }
  return undefined;
}

/** The recipe reads something out of this answer. */
function resolves(r: Recipe, body: string | undefined): boolean {
  if (!body) return false;
  try {
    const d = within(
      () => extract({ format: r.html ? "html" : r.embedded ? "embedded" : "json", ...r }, body),
      DEADLINE.read,
    );
    return !empty(d);
  } catch {
    return false;
  }
}

/** A name from the trigger's last word of path (`/search?q=` -> search), else get<FirstParam>. */
function opName(trigger: string, args: Args): string {
  const word = new URL(trigger).pathname
    .split("/")
    .filter((s) => /^[A-Za-z][\w-]{2,}$/.test(s))
    .at(-1);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (word)
    return word
      .split(/[-_]+/)
      .map((w, i) => (i ? cap(w) : w.toLowerCase()))
      .join("");
  return `get${cap((Object.keys(args)[0] ?? "page").replace(/[^\w]/g, ""))}`;
}

/**
 * The op as if run 1 had been made with `args`: the request template holds the captured values where
 * the params go (a call overwrites them), and those values are the user's own request.
 */
function asExample(op: Operation, args: Args): Operation {
  const none = { cookies: [], values: {} };
  const params = { ...op, slots: op.slots.filter((s) => s.param !== undefined) };
  return {
    ...op,
    request: within(() => buildRequest(params, args, none), DEADLINE.args),
    // a lookup carries the args too: run 1's would say what the user asked
    slots: op.slots.map((s) =>
      s.from
        ? {
            ...s,
            from: { ...s.from, request: within(() => buildRequest(lookupOp(op, s.from!), args, none), DEADLINE.args) },
          }
        : s,
    ),
    params: op.params.map((p) => ({ ...p, example: args[p.name] ?? p.example })),
  };
}

/**
 * The user's params whose values the op still spells, read as a heal-back's request is (`spelled`: as
 * they are, encoded, in base64, or as a slug): shared, they say what the user asked.
 */
function revealed(op: Operation, args: Args): string[] {
  const { learnedAt: _, ...rest } = op;
  return spelled(rest, args);
}

/**
 * The site a trigger learns into by default: a site this machine has on that host (its session is
 * there), else the name the registry already serves the domain under (a seed's: goodreads.com is
 * goodreads), else a new one named as the registry names it (`slugOf`: crates.io is crates-io).
 */
async function defaultSiteName(trigger: string, registryName: () => Promise<string | undefined>): Promise<string> {
  const found = resolveLoginTarget(trigger).site;
  if (loadSite(found)) return found;
  const host = new URL(trigger).hostname;
  const domain = siteOf(host);
  const shared = await registryName();
  const taken = shared && loadSite(shared)?.site;
  return safeName(shared && !(taken && siteOf(new URL(taken.baseUrl).hostname) !== domain) ? shared : slugOf(host));
}

const HOLE = /^\{(\w+)\}$/;

/** A page URL as its parts in order: host (no www.), each path segment, each query key; placeholders kept. */
function parts(url: string): [string, string][] | undefined {
  const dec = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  try {
    const u = new URL(url);
    return [
      ["host", u.hostname.toLowerCase().replace(/^www\./, "")],
      ...u.pathname
        .split("/")
        .filter(Boolean)
        .map((v, i): [string, string] => [`path ${i}`, dec(v)]),
      ...[...u.searchParams]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]): [string, string] => [`query ${k}`, v]),
    ];
  } catch {
    return undefined;
  }
}

/**
 * `args` by `op`'s param names when its trigger is the same page as `trigger`: placeholders at the same
 * places, whatever their names, and every other part the same. Undefined when it is another page, or
 * the args leave a required param unset or name one the op lacks.
 */
export function sameTrigger(op: Operation, trigger: string, args: Args): Args | undefined {
  const a = parts(op.trigger.url);
  const b = parts(trigger);
  if (!a || !b || a.length !== b.length) return undefined;
  const names: Record<string, string> = {};
  for (const [i, [k, v]] of a.entries()) {
    const [k2, v2] = b[i]!;
    const [p, q] = [HOLE.exec(v), HOLE.exec(v2)];
    if (k !== k2 || !p !== !q) return undefined;
    if (p && q) names[q[1]!] = p[1]!;
    else if (v !== v2) return undefined;
  }
  const out: Args = {};
  for (const [k, v] of Object.entries(args)) {
    const to = names[k] ?? k;
    if (!op.params.some((x) => x.name === to)) return undefined;
    out[to] = v;
  }
  return op.params.some((x) => x.required && out[x.name] === undefined && x.default === undefined) ? undefined : out;
}

/** A captured request as an op with no slots yet, for `notARead`. */
const asRequest = (e: Exchange) => ({
  request: { method: e.request.method, url: e.request.url, headers: e.request.headers, body: e.request.body },
  slots: [],
  params: [],
});

const endpointOf = (e: Exchange) => {
  const u = new URL(e.request.url);
  return `${e.request.method.toUpperCase()} ${u.origin}${u.pathname}`;
};

interface Paged {
  paging: Paging;
  auto: boolean;
  /** run 1's requests for page 1 (the user's answer) and page 2 (the op is learned from it); none for numbered pages */
  page1?: number;
  page2?: number;
  examples: [Args, Args];
}

/**
 * How the chosen request's list pages. The agent's `paging`, else the paging both runs show for that
 * list (`pagingHints`, the same param, place and path in each): one run alone could be two unrelated
 * requests that happen to look like pages. A cursor op is learned from page 2's request with its cursor
 * as the example, as `add --paging` is. A string says why the agent's paging cannot be learned.
 */
export function pagedOf(
  input: LearnSiteInput,
  c1: CaptureFile,
  c2: CaptureFile,
  chosen: Exchange,
): Paged | string | undefined {
  const want = input.paging;
  const examples: [Args, Args] = [input.args, input.args2];
  if (want && !want.next)
    return want.param in input.args
      ? { paging: want, auto: false, examples }
      : `numbered pages are asked for by an arg: put ${want.param} in args, args2 and args3 (the page each asks for)`;
  const hints = pagingHints(c1.exchanges).filter(
    (h) =>
      h.paging.next &&
      [h.previous, h.request].some((id) => {
        const e = c1.exchanges.find((x) => x.id === id);
        return e && endpointOf(e) === endpointOf(chosen);
      }),
  );
  const h1 = (want && hints.find((h) => h.paging.param === want.param)) ?? (hints.length === 1 ? hints[0] : undefined);
  const why = (s: string) => (want ? s : undefined);
  if (!h1)
    return why(
      `run 1 loaded no second page of request ${chosen.id}'s list: give steps that load it (a click on its "Show more" or next-page button)`,
    );
  const paging = want ?? h1.paging;
  if (paging.param in input.args)
    return why(`paging param ${paging.param} is one of args: a cursor is the site's answer to page 1, never an arg`);
  const h2 = pagingHints(c2.exchanges).find(
    (h) =>
      h.at.join() === h1.at.join() &&
      (want || (h.paging.param === h1.paging.param && h.paging.next === h1.paging.next)),
  );
  if (!h2) return why(`run 2 loaded no second page of the list where run 1 did (${h1.at.join(" > ")})`);
  return {
    paging,
    auto: !want,
    page1: h1.previous,
    page2: h1.request,
    examples: [
      { ...input.args, [paging.param]: h1.value },
      { ...input.args2, [paging.param]: h2.value },
    ],
  };
}

function checkArgs(input: LearnSiteInput): string | undefined {
  const keys = (a: Args) => Object.keys(a).sort().join(",");
  if (!Object.keys(input.args ?? {}).length)
    return "args is empty: give the value(s) the user asked for, by param name";
  for (const [label, a] of [
    ["args2", input.args2],
    ["args3", input.args3],
  ] as const) {
    if (!a || keys(a) !== keys(input.args)) return `${label} must set the same params as args (${keys(input.args)})`;
  }
  const same = (a: Args, b: Args) => Object.keys(a).every((k) => asText(a[k]) === asText(b[k]));
  if (same(input.args3, input.args) || same(input.args3, input.args2))
    return "args3 must differ from args and args2: it is the holdout, used as neither example";
  return undefined;
}

export async function learnSite(input: LearnSiteInput, o: LearnSiteOptions = {}): Promise<LearnSiteResult> {
  if (input.write)
    return {
      ok: false,
      class: "refused",
      error: "learn_site learns reads only: a write would be sent while it is learned",
      next: "a write is learned with the CLI, which intercepts it: api-anything add <site> <op> --trigger <url> --example k=v --write, run by the user or in your shell",
      nextCall: { action: "report" },
    };
  if (!/^https?:\/\//i.test(input.trigger ?? ""))
    return {
      ok: false,
      error: "trigger must be a full http(s) page URL",
      next: "pass the page URL with {param} placeholders",
    };
  const bad = checkArgs(input);
  if (bad) return { ok: false, error: bad, next: "fix the args and call again", nextCall: { action: "fix_args" } };

  // a page on this machine or the network is never shared: the registry is not asked about it
  let named: Promise<string | undefined> | undefined;
  const registryName = () =>
    (named ??= badAddress(input.trigger)
      ? Promise.resolve(undefined)
      : sharedName(siteOf(new URL(input.trigger).hostname)));
  // setup's question, asked at most once per call and once ever
  let prompted = false;
  const askOnce = async () => {
    if (prompted || loadSettings().askedAt || localOnly()) return;
    prompted = true;
    const yes = await o.consent?.(QUESTION).catch(() => undefined);
    if (yes !== undefined) answerShare(yes);
  };

  // An op someone shared for the same page answers with no browser and nothing learned, and its call's
  // report confirms it. A relearn (fresh, captures, a pick or a recipe) wants this run's own choices.
  const relearn =
    input.fresh ||
    input.captures ||
    input.pickRequest !== undefined ||
    input.extract ||
    input.pick?.length ||
    input.html ||
    input.embedded ||
    input.steps?.length ||
    input.paging;
  const reused = relearn ? undefined : await reuse(input, await registryName(), askOnce, o);
  if (reused) return reused;

  let site: string;
  try {
    site = input.site ? safeName(input.site) : await defaultSiteName(input.trigger, registryName);
  } catch (e) {
    return { ok: false, error: (e as Error).message, next: "pass site: a short name (letters, digits, . _ -)" };
  }
  const existing = loadSite(site)?.site;
  // One name is one site, as pull holds it (registry.ts) and the default name does (`defaultSiteName`):
  // an operation saved under a site on another registrable domain would be called as that site's.
  if (existing && domainOf(existing.baseUrl) !== domainOf(input.trigger))
    return {
      ok: false,
      class: "refused",
      site,
      error: `site "${site}" is ${clip(existing.baseUrl)}, another site than the trigger's: a name holds one site`,
      next: "leave site out (it is named from the trigger), or pass a name no site has",
      nextCall: { action: "fix_args" },
    };
  let op = input.op ?? opName(input.trigger, input.args);
  const taken = (name: string) => existing?.operations.find((x) => x.name === name && x.trigger.url !== input.trigger);
  if (!input.op) for (let n = 2; taken(op); n++) op = `${opName(input.trigger, input.args)}${n}`;
  // a name the caller gave is not renamed: another page's operation under it is not replaced
  else if (taken(op))
    return {
      ok: false,
      class: "refused",
      site,
      op,
      error: `${site} already has an operation ${op} for another page (${clip(taken(op)!.trigger.url)}): learn_site replaces an operation only by learning its own page again`,
      next: "pass another op name, or leave op out",
      nextCall: { action: "fix_args" },
    };
  const fail = (error: string, next: string, extra: Partial<LearnSiteResult> = {}): LearnSiteResult => ({
    ok: false,
    site,
    op,
    error,
    next,
    ...extra,
  });

  // the two runs: run 1 is the user's request, run 2 the second example
  let c1: CaptureFile;
  let c2: CaptureFile;
  try {
    if (input.captures) {
      // one instant for the pair: a pair valid when the learn began is not half-refused at the 24 h edge
      const admitted = Date.now();
      c1 = loadCapture(input.captures[0], admitted);
      c2 = loadCapture(input.captures[1], admitted);
    } else {
      if (!browserAvailable())
        return fail(
          "learning needs a Chromium browser (Google Chrome, Brave, Edge or Chromium), and none is installed",
          "ask the user to install one, or to set API_ANYTHING_BROWSER to any Chromium executable",
          { nextCall: { action: "install_browser" } },
        );
      const trigger = { url: input.trigger, ...(input.steps?.length ? { steps: input.steps } : {}) };
      const t1 = fillTrigger(trigger, input.args);
      const url1 = t1.url;
      c1 = await capturePage(t1);
      const wall = loginWall(c1, url1);
      if (wall)
        return fail(
          `the page landed on a sign-in page (${wall}): the site needs an account`,
          `ask the user to run api-anything login ${site}; then learn again`,
          { nextCall: { action: "login", site }, captures: [c1.id] },
        );
      c2 = await capturePage(fillTrigger(trigger, input.args2));
    }
  } catch (e) {
    if (e instanceof ProfileInUse) return fail(e.message, PROFILE_HINT, { nextCall: { action: "retry" } });
    if (e instanceof CaptureUnavailable)
      return fail(e.message, e.recapture ? "learn again without captures: the two runs are made afresh" : e.next);
    return fail((e as Error).message.split("\n")[0]!, "check the trigger URL, then learn again");
  }
  const captures = [c1.id, c2.id];
  // The rule holds for what the page requested, not only for the trigger typed: a request to this
  // machine or the local network (the page's redirect, a request its script sent, a capture of another
  // page) is no part of the run. Never ranked, shown in alternatives, picked, learned or replayed.
  const hidden = new Set<number>();
  if (o.publicOnly) {
    const open = (c: CaptureFile) => ({ ...c, exchanges: c.exchanges.filter((e) => !badAddress(e.request.url)) });
    for (const e of c1.exchanges) if (badAddress(e.request.url)) hidden.add(e.id);
    c1 = open(c1);
    c2 = open(c2);
  }

  // the request and the recipe: the agent's, else the outline's
  const values = Object.values(input.args).map(asText);
  // the URLs shown carry the run's live values as the refs a spec would hold there
  const live = captureLive(c1, values);
  const shownUrl = (u: string) => clip(redact(u, live, { named: true }));
  const ranked = rankCandidates(c1.exchanges, input.args, { pages: pageUrls(c1.exchanges, capturePages(c1)) });
  const exchange = (id: number) => c1.exchanges.find((e) => e.id === id);
  const refusal = (id: number) => notARead(asRequest(exchange(id)!));
  const options: Choice[] = ranked.slice(0, 6).map((c) => ({
    request: c.id,
    method: c.method,
    url: shownUrl(c.url),
    ...(c.contentType ? { type: c.contentType.split(";")[0] } : {}),
    ...(c.hits.length ? { carries: c.hits } : {}),
    ...suggest(exchange(c.id)!, c.hits, values),
  }));
  const given: Recipe = {
    ...(input.extract ? { extract: input.extract } : {}),
    ...(input.pick?.length ? { pick: input.pick } : {}),
    ...(input.html ? { html: input.html } : {}),
    ...(input.embedded ? { embedded: { regex: input.embedded } } : {}),
  };
  const told = Object.keys(given).length > 0;
  let chosen: Choice | undefined;
  if (input.pickRequest !== undefined) {
    if (hidden.has(input.pickRequest))
      return fail(
        `request ${input.pickRequest} is not https on a public host: learn_site learns only requests to public hosts, and sent nothing`,
        "pick a request from alternatives; a page on this machine or the local network is learned with the CLI, by the user",
        { class: "refused", alternatives: options, captures, nextCall: { action: "relearn", site, op } },
      );
    const e = exchange(input.pickRequest);
    if (!e)
      return fail(`no request ${input.pickRequest} in run 1 (capture ${c1.id})`, "pick one of alternatives[].request", {
        alternatives: options,
        captures,
        nextCall: { action: "relearn", site, op },
      });
    chosen = options.find((x) => x.request === e.id) ?? {
      request: e.id,
      method: e.request.method,
      url: shownUrl(e.request.url),
      ...suggest(e, [], values),
    };
  } else {
    // a request that is no read is picked only when nothing else would do, and then refused below
    const reads = [...options.filter((x) => !refusal(x.request)), ...options.filter((x) => refusal(x.request))];
    chosen = told
      ? (reads.find((x) => resolves(given, exchange(x.request)?.response?.body)) ?? reads[0])
      : reads.find((x) => x.recipe);
  }
  const page = c1.exchanges.filter((e) => e.resourceType === "document" && e.response).at(-1)?.response;
  const wall = page && botWall({ status: page.status, headers: page.headers, body: page.body ?? "" });
  if (!chosen && wall)
    return fail(
      `the site served a bot challenge (${wall})`,
      `ask the user to run api-anything login ${site} --window and clear it; then learn again`,
      { captures, nextCall: { action: "login", site, mode: "window" } },
    );
  if (!chosen && page && page.status >= 400)
    return fail(
      `the page answered HTTP ${page.status}`,
      page.status === 429 ? "the site is rate limiting: wait a few minutes, then learn again" : "check the trigger URL",
      { captures, nextCall: page.status === 429 ? { action: "retry" } : { action: "fix_args" } },
    );
  // the data may be keyed by a value the page looked up (a slug's id): its request carries no example value
  const derived = chosen ? undefined : lookedUpData(c1, input.args);
  if (!chosen && derived) {
    const e = exchange(derived.id)!;
    const shown: Choice = {
      request: e.id,
      method: e.request.method,
      url: shownUrl(e.request.url),
      ...(e.response?.contentType ? { type: e.response.contentType.split(";")[0] } : {}),
    };
    return fail(
      `no request in run 1 carries the example values in an answer that could be read, but request ${derived.id} takes a value an earlier request looked up: ${derived.why}`,
      `learn again with captures (no browser), pickRequest ${derived.id} and a recipe (extract and pick) for its answer: the lookup is learned with it`,
      {
        alternatives: [shown, ...options.filter((x) => x.request !== e.id)].slice(0, 6),
        captures,
        nextCall: { action: "relearn", site, op },
      },
    );
  }
  if (!chosen)
    return fail(
      "no request in run 1 carries the example values in an answer that could be read: the data may need a click, a login, or other example values",
      "look at alternatives, then learn again with captures (no browser), pickRequest and a recipe (extract and pick, html, or embedded)",
      { alternatives: options, captures, nextCall: { action: "relearn", site, op } },
    );
  const recipe = told ? given : (chosen.recipe ?? {});
  const alternatives = options.filter((x) => x.request !== chosen.request).slice(0, 5);
  const shown = { ...chosen, recipe, auto: input.pickRequest === undefined && !told };
  // Before anything is sent: a write saved as a read would be sent by the holdout call and the clean
  // replay, and by every call after. The rules about params are asked again once it is learned.
  const notRead = (why: string) =>
    fail(
      `${why}. learn_site learns reads only, and sent nothing`,
      "pick a request from alternatives that reads; a write is learned with the CLI, which intercepts it: api-anything add <site> <op> --trigger <url> --example k=v --write, run by the user",
      { class: "refused", chosen: shown, alternatives, captures, nextCall: { action: "relearn", site, op } },
    );
  const early = refusal(chosen.request);
  if (early)
    return notRead(`request ${chosen.request} (${chosen.method} ${chosen.url.split("?")[0]}) is not a read: ${early}`);

  const paged = pagedOf(input, c1, c2, exchange(chosen.request)!);
  if (typeof paged === "string")
    return fail(
      paged,
      "learn again with captures (no browser) and a fixed paging, or without captures and with steps that load page 2",
      {
        chosen: shown,
        alternatives,
        captures,
        nextCall: { action: "relearn", site, op },
      },
    );

  // add, with the same functions, credential checks and refusals
  const warnings: string[] = [];
  const mentions =
    input.intent && values.some((v) => v.length >= 3 && input.intent!.toLowerCase().includes(v.toLowerCase()));
  if (mentions)
    warnings.push("intent holds one of the user's values, so it is not the op's description (that is shared)");
  let added: Awaited<ReturnType<typeof addOperation>>;
  try {
    added = await addOperation({
      site,
      op,
      trigger: { url: input.trigger, ...(input.steps?.length ? { steps: input.steps } : {}) },
      examples: paged?.examples ?? [input.args, input.args2],
      ...(input.intent && !mentions ? { description: input.intent } : {}),
      response: recipe,
      from: { capture: c1, id: paged?.page2 ?? chosen.request },
      from2: c2,
      ...(paged ? { paging: paged.paging } : {}),
      readsOnly: true,
      ...(o.publicOnly ? { publicOnly: true } : {}),
    });
  } catch (e) {
    const m = (e as Error).message.split("\n")[0]!;
    if (e instanceof NotARead) return notRead(m);
    const login = /api-anything login/.test(m);
    return fail(
      m,
      login
        ? `ask the user to run api-anything login ${site}; then learn again`
        : "learn again with captures (no browser) and another pickRequest from alternatives, or a recipe",
      {
        chosen: shown,
        alternatives,
        captures,
        nextCall: login ? { action: "login", site } : { action: "relearn", site, op },
      },
    );
  }
  warnings.push(...added.warnings);

  // the user's answer, from run 1: page 1 of a list that pages
  const answered = exchange(paged?.page1 ?? chosen.request)!;
  const res = answered.response!;
  let j: ReturnType<typeof judge>;
  try {
    j = within(
      () =>
        judge(added.operation, {
          status: res.status,
          headers: res.headers,
          body: res.body ?? "",
          url: answered.request.url,
        }),
      DEADLINE.read,
    );
  } catch (e) {
    if (!(e instanceof DeadlineExceeded)) throw e;
    j = { class: "error", reason: `the answer was not read: ${e.message}` };
  }
  if (j.class !== "ok" || empty(j.data))
    return fail(
      `the op was saved, but on run 1's answer it reads ${j.class === "ok" ? "no data" : `${j.class}: ${j.reason}`}`,
      "learn again with captures (no browser) and another pickRequest from alternatives, or a recipe",
      { chosen: shown, alternatives, captures, warnings, nextCall: { action: "relearn", site, op } },
    );
  const answer = capOutput(j.data);

  // the shared example is args2, never the user's own request
  let own = false;
  const saved = updateSite(site, (cur) => ({
    ...cur!,
    operations: cur!.operations.map((x) => {
      if (x.name !== op) return x;
      try {
        return asExample(x, input.args2);
      } catch {
        own = true; // the user's values stay, which keeps it from being shared
        return x;
      }
    }),
  }));

  const holdout = await call(site, op, input.args3, { minIntervalMs: o.minIntervalMs });
  const held = holdout.ok && !empty(holdout.data);
  const check = CheckSchema.safeParse({
    args: input.args3,
    expect: "result",
    purpose: HOLDOUT_PURPOSE,
  });
  if (held && check.success)
    updateSite(site, (cur) => ({
      ...cur!,
      operations: cur!.operations.map((x) => {
        if (x.name !== op) return x;
        // an earlier learn_site's holdout gives way to this one, which ran on this version of the op
        const key = JSON.stringify(Object.entries(check.data.args).sort());
        const rest = (x.checks ?? []).filter(
          (c) => c.purpose !== HOLDOUT_PURPOSE && JSON.stringify(Object.entries(c.args).sort()) !== key,
        );
        return { ...x, checks: [...rest, check.data] };
      }),
    }));
  else if (held)
    warnings.push("args3 has a value that is not text, a number or a boolean, so it is not kept as a check");

  const now = loadSite(site)!.site.operations.find((x) => x.name === op)!;
  // a minTier 3 op needs the page for every call: plain HTTP says nothing about whether it is public
  const clean =
    now.minTier > 1
      ? undefined
      : await cleanCall(now, input.args2, { site, minIntervalMs: o.minIntervalMs, publicOnly: o.publicOnly });
  const cleanReplay: Evidence["cleanReplay"] = !clean
    ? "skipped"
    : clean.class === "ok" || clean.class === "blocked"
      ? clean.class
      : "failed";

  const proof: NonNullable<LearnSiteResult["proof"]> = {
    holdout: {
      args: input.args3,
      ok: held,
      class: holdout.ok && !held ? "empty" : holdout.class,
      ...(holdout.tier ? { tier: holdout.tier } : {}),
      ...(!held && holdout.reason ? { reason: holdout.reason } : {}),
    },
    cleanReplay,
    ...(clean && clean.class !== "ok" ? { cleanReason: clean.reason } : {}),
  };
  const proven: Proof = {
    learnedLoggedIn: now.learnedLoggedIn,
    cleanReplay,
    holdout: { args: input.args3, ok: true, ...(holdout.tier ? { tier: holdout.tier } : {}) },
    ...(holdout.tier ? { tier: holdout.tier } : {}),
  };
  // The holdout was the check's case: with no other check, publish needs no verify first, and sends
  // what this run proved when the user shares it later.
  if (held && check.success && now.checks?.length === 1)
    recordCases(
      site,
      now,
      [
        {
          op,
          case: "check 1",
          expect: "result",
          outcome: "pass",
          got: "result",
          args: check.data.args,
          purpose: HOLDOUT_PURPOSE,
          ...(holdout.tier ? { tier: holdout.tier } : {}),
          ...(holdout.healed ? { healed: true } : {}),
          ms: holdout.ms,
        },
      ],
      proven,
    );

  let shared: ShareOutcome;
  let next: string | undefined;
  // run 1's cursor too: it can carry what the user asked (a cursor that encodes the query). Where the
  // op could not be given args2, every one of the user's values is in it, one too short to read for too.
  const run1 = paged ? paged.examples[0] : input.args;
  const reveals = own ? Object.keys(run1) : revealed(now, run1);
  if (!held) {
    shared = { site, op, shared: false, reason: "the holdout call did not answer with data" };
    next = `it answered the user's request, but not args3: if args3 has results on the site, the op may be wrong; learn again with captures ${captures.join(" ")} and another pickRequest or recipe`;
  } else if (reveals.length) {
    shared = {
      site,
      op,
      shared: false,
      reason: `the learned request still spells the user's ${reveals.join(", ")} (as it is, encoded or as a slug), so sharing it would say what they asked`,
    };
  } else {
    const evidence: Partial<Evidence> = { clientVersion: VERSION, ...proven };
    // the user has their answer whatever sharing does
    const share = async (consent?: true): Promise<ShareOutcome> => {
      try {
        const [one] = await hooks.share(site, [op], { evidence, ...(consent ? { consent } : {}) });
        return one ?? { site, op, shared: false, reason: "sharing answered nothing" };
      } catch (e) {
        return { site, op, shared: false, reason: (e as Error).message.split("\n")[0] };
      }
    };
    // the first time something could be shared, setup's question is asked if it never was
    await askOnce();
    shared = await share();
    const publish = `api-anything publish ${site} ${op} --yes`;
    if (shared.needsConsent) {
      const found = shared.personal?.length ? shared.personal : undefined;
      // The values a yes makes public, read from the saved op and not from this call's input: its
      // params' examples and every check's args (one the user recorded before is still there), and the
      // holdout's, which go as evidence.
      const examples = Object.fromEntries(
        now.params.flatMap((p) => (p.example === undefined ? [] : [[p.name, p.example]])),
      );
      const sets = [examples, ...(now.checks ?? []).map((c) => c.args), input.args3].map((a) => JSON.stringify(a));
      const yes = await o
        .consent?.(
          `${site} ${op} ${shared.reason ? `(${shared.reason}) ` : ""}works. Share it with the api-anything catalog? Anyone can then fetch the request's shape and the example values ${[...new Set(sets)].join(" and ")}; your cookies and session values are never sent.${found ? ` Check first, it may hold something of yours: ${found.join("; ")}.` : ""}`,
        )
        .catch(() => undefined);
      if (yes) shared = await share(true);
      else if (yes === undefined)
        next = `ask the user whether to share ${op} with the catalog (${shared.reason ?? "it needs their yes"})${found ? `, showing them what may be theirs: ${found.join("; ")}` : ""}; only on their yes, run: ${publish}`;
    }
    if (!shared.shared && !loadSettings().askedAt && !localOnly()) {
      next = next
        ? `${next}. ${ASK}`
        : shared.reason?.startsWith("refused")
          ? ASK
          : `${ASK}. On yes, also share ${op}: ${publish}`;
    }
  }

  return {
    ok: true,
    site,
    op,
    signature: summarize(now).op,
    data: answer.data,
    ...(answer.truncated ? { truncated: answer.truncated } : {}),
    chosen: shown,
    ...(paged ? { paging: { ...paged.paging, auto: paged.auto } } : {}),
    ...(j.nextPage !== undefined ? { nextPage: j.nextPage } : {}),
    ...(j.hasMore !== undefined ? { hasMore: j.hasMore } : {}),
    alternatives,
    proof,
    shared,
    warnings,
    captures,
    saved,
    ...(next ? { next } : {}),
  };
}
