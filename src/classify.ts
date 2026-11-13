/** Classify every response, never by status code alone. See DESIGN.md "Failure classifier". */
import type { HTMLElement } from "node-html-parser";
import { BodyTooDeep, templateRefs } from "./codec.js";
import {
  extract,
  extractEmbedded,
  extractHtml,
  getPath,
  getPathRegex,
  inferShape,
  PageTooLarge,
  parseBody,
  parsePage,
  parseShown,
  pick,
  pickEntry,
  splitRegex,
  tagsOf,
} from "./extract.js";
import { siteOf } from "./session.js";
import type { Operation, ResponseSpec } from "./spec.js";

export type Class = "ok" | "drift" | "auth" | "rate" | "blocked" | "input" | "error";
export interface Classified {
  class: Class;
  reason: string;
  /**
   * drift: the response came back fine but without the data (extract path, selector or embedded
   * JSON missing). blocked: a bare 403 with no wall or login markers, which is also how a site
   * refuses one entity ("This profile can't be accessed"). Bad args look the same either way, so
   * the caller checks the example args before healing or climbing tiers.
   */
  missing?: boolean;
  /**
   * the server says it failed (a 5xx, or an error status in the body standing for one), or a call
   * could not reach it: nothing is learned about the request
   */
  server?: boolean;
  /** rate: how long the server's Retry-After asks the caller to wait */
  retryAfterMs?: number;
  /** a write's 2xx whose answer says plainly that the service refused it: it did not run */
  rejected?: boolean;
  /**
   * the address of a same-site page the request was redirected to instead of its data (a consent,
   * terms or "verify it's you" step), for a human to finish in the browser
   */
  unfinished?: string;
  /**
   * drift: picked fields the learned shape typed, which no item carries now, or none with that type.
   * The rest of the data is there: `judge` extracts it, for a call whose example args still carry them.
   */
  lost?: string[];
}
export interface Observed {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** final URL after redirects, when known */
  url?: string;
  /** the first answer was a redirect, followed to `url` */
  redirected?: boolean;
}

// [vendor, interstitial, integration]. The interstitial pattern is the challenge page's own
// structure. The integration pattern is a script a vendor also puts on ordinary pages (AWS WAF's
// challenge.js SDK, DataDome's tags.js, Imperva's resource script): it only counts on an answer
// whose status is a challenge's own.
const CHALLENGES: [string, RegExp | undefined, RegExp?][] = [
  [
    "Cloudflare",
    /<title>Just a moment\.\.\.<\/title>|cf-chl-|_cf_chl_opt|Attention Required! \| Cloudflare/i,
    /challenges\.cloudflare\.com/i,
  ],
  ["Akamai", /bm-verify|\/_sec\/cp_challenge|errors\.edgesuite\.net/i],
  ["DataDome", /captcha-delivery\.com/i, /datadome/i],
  ["PerimeterX", /px-captcha|Press & Hold/i, /_pxAppId|perimeterx/i],
  [
    "AWS WAF",
    /awsWafCookieDomainList|gokuProps|<title>Human Verification<\/title>/i,
    // both runs bounded: unbounded, a body of `/__challenge_x/` openings is rescanned from each one
    /AwsWafIntegration|\.awswaf\.com|\/__challenge_[\w-]{1,128}\/[^"']{0,512}challenge\.js/i,
  ],
  ["Amazon", /automated access to Amazon data|\/errors\/validateCaptcha/i],
  ["Imperva", /Incapsula incident/i, /_Incapsula_Resource/i],
  // the open-source proof-of-work wall many small sites put in front of scrapers
  ["Anubis", /<script id="anubis-main"|Making sure you(?:'|&#39;)re not a bot!/i],
  ["Kasada", undefined, /\/[0-9a-f]{8}-[0-9a-f-]{27}\/[0-9a-f]{8}-[0-9a-f-]{27}\/ips\.js/i],
  // a proof-of-work page that solves itself and resubmits (Reddit)
  ["JavaScript", /name=["']?js_challenge|[?&]js_challenge=1/i],
  ["reCAPTCHA", /Prove your humanity/i],
];
// A CAPTCHA widget is the challenge on a bare page, and a guard on the login when it sits in a sign-in form.
const CAPTCHA_WIDGET = /google\.com\/recaptcha|g-recaptcha|hcaptcha\.com/i;
// What bot walls answer with: 202 (AWS WAF's JS challenge), 403, 405 (AWS WAF's CAPTCHA), 429, 503.
const CHALLENGE_STATUS = new Set([202, 403, 405, 429, 503]);
// An interstitial's title gives it away even when the page is too big for the body scan.
const CHALLENGE_TITLE =
  /<title[^>]*>[^<]*(prove your humanity|human verification|just a moment|attention required|are you a (human|robot)|verify you are (a )?human|robot check)/i;

// What a server says when the session is missing, as opposed to a page that shows a password field.
const LOGIN_SAID =
  /"require_login"\s*:\s*true|login_required|not logged in|(log|sign) ?in to continue|please (log|sign) ?in|authentication required|bad authentication|could not authenticate|bad guest token|invalid session|session (has )?expired|invalid (application-id or )?api[ _-]?key|api[ _-]?key (is )?(invalid|expired)/i;
const LOGIN = new RegExp(`${LOGIN_SAID.source}|type=["']password["']|accounts\\.google\\.com\\/ServiceLogin`, "i");
const USER_FIELD = /name=["']?(user(name)?|e-?mail|login|session_key)\b/i;
const LOGIN_ACTION = /log_?in|sign_?in|sign-in|session/i;
/**
 * A sign-in form: a password field next to a username field, a current-password hint, or a form posting to a login path.
 * The whole body is read, since the form may sit deep in a large page, one input or form tag at a time (`tagsOf`).
 */
export function signInForm(body: string): boolean {
  if (!/type=["']?password/i.test(body)) return false;
  if (/autocomplete=["']?(current-password|username)/i.test(body)) return true;
  for (const tag of tagsOf(body, "input")) if (USER_FIELD.test(tag.text)) return true;
  // every action= of the tag, not only its first (a data-action before the real one)
  for (const tag of tagsOf(body, "form"))
    for (const action of tag.text.matchAll(/action=["']?([^"'>\s]*)/gi)) if (LOGIN_ACTION.test(action[1]!)) return true;
  return false;
}
const LOGIN_URL = /\/(login|signin|sign_in|sign-in|accounts\/login|i\/flow\/login|onboarding|ServiceLogin)(\/|$|\?)/i;
/** The URL's path is a sign-in page's, whether it was asked for or redirected to. */
export function loginPath(url: string): boolean {
  try {
    return LOGIN_URL.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
/**
 * A document that is a login page. Only what the page says or shows counts: every logged-out page
 * can link a sign-in page (Google's Sign-in button goes to ServiceLogin), and a login redirect is
 * judged by the final URL.
 */
const loginPage = (body: string) => LOGIN_SAID.test(body) || signInForm(body);
const RATE = /rate.?limit|too many requests|please wait a few minutes|slow down/i;
const DRIFT =
  /PersistedQueryNotFound|persisted query not found|must be defined|cannot be null|query not found|unknown (field|argument|operation)|cannot query field/i;

const ok = (reason = "ok"): Classified => ({ class: "ok", reason });
const is = (c: Class, reason: string): Classified => ({ class: c, reason });
const missing = (reason: string): Classified => ({ class: "drift", reason, missing: true });
// A CSRF *failure*, not a page that merely carries a token (every server-rendered form has a
// csrf-token meta or a csrfmiddlewaretoken field). The gap stays inside one message: no quote or tag.
const CSRF_FAILED =
  /(csrf|xsrf)[^"<>\n]{0,40}?(missing|invalid|mismatch|incorrect|expired|fail|not (set|found|valid|match))|(invalid|missing|bad|expired|can'?t verify|could not verify|requires? an? (valid|matching))[^"<>\n]{0,30}?(csrf|xsrf|authenticity)|InvalidAuthenticityToken/i;
// Instagram sends "require_login": false on its rate-limit answers, so the key alone means nothing.
const REQUIRE_LOGIN = /"require_login"\s*:\s*true|login_required/i;
const snippet = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 160);

/** The vendor challenging here. `rides`: the marker also sits on ordinary pages, so a sign-in form explains it. */
function challenge(body: string, status: number): { vendor: string; rides: boolean } | undefined {
  const head = body.slice(0, 200_000);
  const first = CHALLENGES.find(
    ([, page, sdk]) => !!page?.test(head) || (CHALLENGE_STATUS.has(status) && !!sdk?.test(head)),
  );
  // one interstitial marker anywhere on the page settles it, whichever vendor is named first
  if (first) return { vendor: first[0], rides: !CHALLENGES.some(([, page]) => page?.test(head)) };
  return CAPTCHA_WIDGET.test(head) ? { vendor: "reCAPTCHA", rides: true } : undefined;
}

/**
 * The bot wall this response is, if any ("Cloudflare challenge page (HTTP 403)"). A real HTML page
 * may mention recaptcha; challenge pages are small, non-2xx, or where data was expected.
 * `hasData`: the op's recipe finds its data on this page. A title alone ("Robot check-in: how our
 * warehouse robots work") is then an ordinary page; a vendor's interstitial markers still count.
 */
export function botWall(r: Observed, wantsJson = false, hasData?: () => boolean): string | undefined {
  const body = r.body ?? "";
  const ct = (r.headers["content-type"] ?? "").toLowerCase();
  const isHtml = ct.includes("html") || /^\s*<(!doctype|html)/i.test(body);
  if (r.headers["cf-mitigated"] === "challenge") return "Cloudflare challenge (cf-mitigated)";
  // Kasada's headers ride on its sites' ordinary answers too: only its challenge status is a wall, and
  // not on a sign-in form (an interstitial's markers on that page are still caught below).
  const kasada = Object.keys(r.headers).some((k) => k.toLowerCase().startsWith("x-kpsdk"));
  if (kasada && CHALLENGE_STATUS.has(r.status) && !signInForm(body)) return `Kasada challenge (HTTP ${r.status})`;
  if (r.status >= 400 || (isHtml && (wantsJson || body.length < 64_000))) {
    const c = challenge(body, r.status);
    // A widget on a sign-in form asks for a login, which no transport tier gets past. An interstitial's
    // own markers are a wall whatever form the page carries.
    if (c && !(c.rides && signInForm(body))) return `${c.vendor} challenge page (HTTP ${r.status})`;
  }
  if (isHtml && CHALLENGE_TITLE.test(body.slice(0, 20_000)) && !hasData?.()) return `challenge page (HTTP ${r.status})`;
  return undefined;
}

type HtmlRecipe = NonNullable<Operation["response"]["html"]>;
/** Items with a field found: a selector renamed under every field leaves items holding nothing. */
export function htmlFinds(recipe: HtmlRecipe, items: ReturnType<typeof extractHtml>): boolean {
  if (!Object.keys(recipe.fields).length) return items.length > 0;
  return items.some((item) => Object.values(item).some((v) => (Array.isArray(v) ? v.length > 0 : !!v)));
}

/** The html/embedded recipe finds data here (a non-empty list, or a value). Never throws. */
function recipeFinds(op: Operation, body: string): boolean {
  try {
    if (op.response.format === "html")
      return !!op.response.html && htmlFinds(op.response.html, extractHtml(body, op.response.html));
    if (op.response.format === "embedded") {
      const d = extract(op.response, body);
      return d !== undefined && !(Array.isArray(d) && !d.length);
    }
  } catch {
    /* a bad recipe finds nothing */
  }
  return false;
}

/**
 * An items selector's container: the part before its last compound ("ul.results li.r" -> "ul.results",
 * "#search > div.item" -> "#search"). Undefined for a single compound or a selector list.
 */
function containerOf(selector: string): { container: string; item: string } | undefined {
  selector = selector.trim();
  let depth = 0;
  let quote = "";
  let cut = -1;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (depth === 0 && c === ",") return undefined;
    else if (depth === 0 && /[\s>+~]/.test(c)) cut = i;
  }
  const container = selector
    .slice(0, cut)
    .replace(/[\s>+~]+$/, "")
    .trim();
  const item = selector.slice(cut + 1).trim();
  return cut > 0 && container && item ? { container, item } : undefined;
}

/**
 * Why this is a results page with no results, or undefined when nothing shows it is one: the recipe's
 * `empty` element is shown on the page, or the items' container is on the page and holds nothing of
 * the items' tag (any element, when the selector names no tag). Items there under another class are
 * a renamed selector (drift), not zero results.
 */
export function emptyResults(body: string, recipe: { items: string; empty?: string }): string | undefined {
  try {
    // shown, as the items are: a no-results message a page keeps hidden under its list says nothing
    if (recipe.empty && parseShown(body).querySelector(recipe.empty)) return `"${recipe.empty}" is on the page`;
    const parts = containerOf(recipe.items);
    if (!parts) return undefined;
    const box = parsePage(body).querySelector(parts.container);
    if (!box) return undefined;
    const tag = /^[a-z][a-z0-9-]*/i.exec(parts.item)?.[0];
    return box.querySelector(tag ?? "*") ? undefined : `the container of "${recipe.items}" is on the page and empty`;
  } catch {
    return undefined;
  }
}

/** The longest wait a Retry-After is taken at: a huge one would be Infinity, which JSON sends as null. */
export const MAX_RETRY_AFTER_MS = 24 * 3600_000;

/** " (retry after 120 s)" and its wait in ms, from a Retry-After header in seconds or as an HTTP date. */
function retryAfter(headers: Record<string, string>, now = Date.now()): { text: string; ms?: number } {
  const v = headers["retry-after"]?.trim();
  if (!v) return { text: "" };
  const wait = (ms: number) => Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS);
  if (/^\d+$/.test(v)) return { text: ` (the server says retry after ${v} s)`, ms: wait(Number(v) * 1000) };
  const t = Date.parse(v);
  return Number.isNaN(t)
    ? { text: "" }
    : { text: ` (the server says retry after ${new Date(t).toISOString()})`, ms: wait(t - now) };
}

/** A GraphQL errors array's verdict; `input` for a not-found entity. */
function graphqlErrors(errors: unknown[], extra = ""): Classified {
  const msg = errors.map((e) => (e as { message?: unknown })?.message ?? JSON.stringify(e)).join("; ");
  const types = errors
    .map((e) =>
      String(
        (e as { type?: unknown; extensions?: { code?: unknown } })?.type ??
          (e as { extensions?: { code?: unknown } })?.extensions?.code ??
          "",
      ),
    )
    .join(" ");
  if (DRIFT.test(msg)) return is("drift", `GraphQL: ${snippet(msg)}`);
  if (LOGIN.test(msg)) return is("auth", `GraphQL: ${snippet(msg)}`);
  if (RATE.test(msg)) return is("rate", `GraphQL: ${snippet(msg)}`);
  if (/NOT_FOUND/i.test(types) || /not found|could not resolve|does not exist|no such/i.test(msg))
    return is("input", `GraphQL: ${snippet(msg)}`);
  return is("error", `GraphQL errors${extra}: ${snippet(msg)}`);
}

// gRPC's canonical codes 1-16, in order, as the HTTP status Google's own gateways answer them with.
const GRPC: Record<string, number> = {
  CANCELLED: 499,
  UNKNOWN: 500,
  INVALID_ARGUMENT: 400,
  DEADLINE_EXCEEDED: 504,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  PERMISSION_DENIED: 403,
  RESOURCE_EXHAUSTED: 429,
  FAILED_PRECONDITION: 400,
  ABORTED: 409,
  OUT_OF_RANGE: 400,
  UNIMPLEMENTED: 501,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DATA_LOSS: 500,
  UNAUTHENTICATED: 401,
};
const GRPC_NAMES = Object.keys(GRPC);

/** A batchexecute RPC's status when it answered one instead of its payload: `["wrb.fr", id, null, null, null, [13]]`. */
function rpcStatus(entry: unknown): number | undefined {
  if (!Array.isArray(entry) || entry[0] !== "wrb.fr") return undefined;
  const [, , payload, , , status] = entry as unknown[];
  return payload == null && Array.isArray(status) && typeof status[0] === "number" && status[0] ? status[0] : undefined;
}

/**
 * The status of the RPC the extract path reads (`[0][0][2]...` passes through it): none when that RPC is
 * absent, never another one's. Without such a path, the first RPC that failed.
 */
function batchexecuteCode(data: unknown, extract = ""): number | undefined {
  const steps = extract.match(/^(\[\d+\])+/)?.[0];
  if (steps) {
    let at = data;
    for (const [, i] of steps.matchAll(/\[(\d+)\]/g)) {
      at = Array.isArray(at) ? at[Number(i)] : undefined;
      if (Array.isArray(at) && at[0] === "wrb.fr") return rpcStatus(at);
    }
    return undefined;
  }
  const first = (x: unknown, depth: number): number | undefined => {
    if (!Array.isArray(x) || depth > 2) return undefined;
    return rpcStatus(x) ?? x.reduce<number | undefined>((c, y) => c ?? first(y, depth + 1), undefined);
  };
  return first(data, 0);
}

/**
 * An error a 2xx answer carries in its body instead of data, as the HTTP status it stands for:
 * a batchexecute status, `{"error": {"status": "UNAVAILABLE"}}`, `{"error": {"code": 503}}`, a JSON-RPC error.
 */
function inBandError(data: unknown, extract?: string): { status: number; said: string } | undefined {
  const rpc = batchexecuteCode(data, extract);
  if (rpc !== undefined) {
    const name = GRPC_NAMES[rpc - 1];
    return { status: name ? GRPC[name]! : 500, said: `batchexecute error ${rpc}${name ? ` (${name})` : ""}` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const { error, jsonrpc } = data as { error?: unknown; jsonrpc?: unknown };
  if (!error || typeof error !== "object") return undefined;
  const { code, status } = error as { code?: unknown; status?: unknown };
  if (typeof status === "string" && Object.hasOwn(GRPC, status))
    return { status: GRPC[status]!, said: `error ${status}` };
  if (typeof code !== "number") return undefined;
  // -32601 method not found, -32603 internal and -32000..-32099 server errors; the rest are a bad request
  if (jsonrpc !== undefined && code <= -32000 && code >= -32768) {
    const status = code === -32601 ? 404 : code === -32603 || code >= -32099 ? 500 : 400;
    return { status, said: `JSON-RPC error ${code}` };
  }
  return code >= 400 && code < 600 ? { status: code, said: `error ${code}` } : undefined;
}

// What a write's answer says when the service refused it (after Pomerado's commit check). An error
// field holds an error unless it is empty, zero, false or a word for none (`error: null`, `userErrors: []`).
const NONE = /^\s*(0+|none|null|false|ok|success|n\/a|no errors?( found)?)?\s*\.?\s*$/i;
function filled(v: unknown, depth = 0): boolean {
  if (v === null || v === undefined || v === false || v === 0) return false;
  if (typeof v === "string") return !NONE.test(v);
  if (typeof v !== "object" || depth > 3) return true;
  return (Array.isArray(v) ? v : Object.values(v)).some((x) => filled(x, depth + 1));
}
// Names compared lower-cased without _ and -. Up to two levels down, the error fields' family
// (`{data: {save: {validationErrors}}}`); deeper, to four, only error, errors and userErrors.
const ERROR_NEAR =
  /^((user|validation|field|form|mutation)?errors?|error(message|msg|text|code|description|details?)s?|haserrors?|err|errmsg)$/;
const ERROR_DEEP = /^(error|errors|usererrors)$/;
const SUCCEEDED = /^(is)?(success|successful|succeeded|ok)$/;
// A status enum, not prose: a message can name what the write was about ("Error report sent").
const STATUS_WORD = /\b(errors?|fail(s|ed|ure)?|invalid|forbidden|unauthori[sz]ed)\b/i;

/**
 * A write's JSON answer that says it was refused: an error field that holds one (4 levels down),
 * `ok`/`success` false (2 levels), a numeric `status` of 400 or more (1 level, as `status`), or an
 * error word as the whole root `status`/`state`/`result`. "queued" or "pending" is accepted work.
 */
function refusal(data: unknown): { said: string; status?: number } | undefined {
  let budget = 2000;
  const visit = (v: unknown, depth: number): { said: string; status?: number } | undefined => {
    if (depth > 4 || v === null || typeof v !== "object" || --budget < 0) return undefined;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 50)) {
        const found = visit(x, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    for (const [key, field] of Object.entries(v)) {
      const name = key.toLowerCase().replace(/[_-]/g, "");
      const text = typeof field === "string" ? field : (JSON.stringify(field) ?? "");
      const said = `${key} is ${snippet(text)}`;
      if (depth <= 2 && SUCCEEDED.test(name) && field === false) return { said };
      // named fields only: a setting for what to do on an error (notifyOnError) is none
      if ((depth <= 2 ? ERROR_NEAR : ERROR_DEEP).test(name)) {
        if (field === true ? /^(has)?errors?$/.test(name) : filled(field)) return { said };
        continue;
      }
      if (depth <= 1 && /^status(code)?$/.test(name) && typeof field === "number" && field >= 400 && field < 600)
        return { said, status: field };
      if (
        depth === 0 &&
        /^(status|state|result|outcome)$/.test(name) &&
        typeof field === "string" &&
        field.trim().split(/[\s_-]+/).length <= 3 &&
        STATUS_WORD.test(field.replace(/[_-]+/g, " "))
      )
        return { said };
      const found = visit(field, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(data, 0);
}

/** A refusal's class by the answer's wording: a lost session or a limit says so; anything else is an error. */
const refusedAs = (text: string, reason: string): Classified =>
  is(LOGIN_SAID.test(text) ? "auth" : RATE.test(text) ? "rate" : "error", reason);

/** `error=title_blank`, `status=failed`: a redirect's query or fragment that names an error. */
function errorInQuery(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    for (const [k, v] of [...u.searchParams, ...new URLSearchParams(u.hash.slice(1))]) {
      if (/error|fail/i.test(k) && !/^(0|false|none)$/i.test(v)) return v ? `${k}=${v}` : k;
      if (/^(error|errors|fail|failed|failure|invalid)$/i.test(v)) return `${k}=${v}`;
    }
  } catch {
    /* not a URL */
  }
  return undefined;
}

/** The final URL is the write's own form page: its trigger's address, a `{param}` there matching any one segment. */
function onForm(op: Operation, url: string | undefined): boolean {
  if (!url) return false;
  try {
    const t = new URL(op.trigger.url.replace(/\{[^{}]+\}/g, "0p0"));
    const u = new URL(url);
    const path = t.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("0p0", "[^/]+");
    return u.origin === t.origin && new RegExp(`^${path}/?$`).test(u.pathname);
  } catch {
    return false;
  }
}

// What a server-rendered form shows when it refused the post: Django's errorlist, Rails'
// field_with_errors and error_explanation; an alert counts only when its words are an error's.
const FORM_ERRORS = ".errorlist, .field_with_errors, #error_explanation";
const ALERTS = '[role="alert"], .alert-danger, .alert-error, .flash-error, .error-message, .form-error, .errors';
const ERROR_WORDS =
  /\b(errors?|fail(s|ed|ure)?|invalid|forbidden|unauthori[sz]ed|required|must|cannot|can't|could ?n[o']t|unable|not valid|already (taken|exists|in use)|too (long|short)|please (enter|select|choose|provide|fill|correct))\b/i;
/** Hidden by the markup itself (a client-side check's template); a stylesheet's hiding is not seen. */
function hidden(el: HTMLElement | null): boolean {
  for (let e = el; e; e = e.parentNode as HTMLElement | null) {
    if (!e.getAttribute) continue;
    if (/^(template|script|noscript)$/i.test(e.tagName ?? "")) return true;
    if (e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true") return true;
    if (/(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(e.getAttribute("style") ?? "")) return true;
  }
  return false;
}
/** The error a form page shows, if any. Never throws. */
function formError(body: string): string | undefined {
  try {
    const doc = parsePage(body);
    const shown = (sel: string, words: boolean) =>
      doc.querySelectorAll(sel).find((el) => {
        const t = el.text.replace(/\s+/g, " ").trim();
        return !hidden(el) && (words ? ERROR_WORDS.test(t) : !!t || el.classList.contains("field_with_errors"));
      });
    const el = shown(FORM_ERRORS, false) ?? shown(ALERTS, true);
    return el ? snippet(el.text) || "a field marked as an error" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A read's request redirected off its path to an HTML page of the same site, with no sign-in or
 * challenge there (both are judged before): a consent, terms or "verify it's you" step. Only for an
 * op that holds a credential or was learned signed in, and only after a real redirect: an SPA serving
 * its shell at the request's own address is drift.
 */
function unfinishedPage(op: Operation, r: Observed): string | undefined {
  if (!r.redirected || !r.url) return undefined;
  const holds = op.slots.some((s) => !!s.ref || (s.template !== undefined && templateRefs(s.template).length > 0));
  if (!holds && !op.learnedLoggedIn) return undefined;
  try {
    const to = new URL(r.url);
    const from = new URL(op.request.url);
    if (to.pathname === from.pathname || siteOf(to.hostname) !== siteOf(from.hostname)) return undefined;
  } catch {
    return undefined;
  }
  return r.url;
}

/** A path as the learned shape keys it: `a[0].b` and `a[*].b` -> `a[].b`, `a["x.y"]` -> `a.x.y`. */
export const shapeKey = (path: string) =>
  path
    .replace(/\[(\d+|\*)\]/g, "[]")
    .replace(/\["((?:[^"\\]|\\.)*)"\]/g, (_m, k: string) => `.${JSON.parse(`"${k}"`) as string}`)
    .replace(/^\./, "");

/** A learned shape key relative to the extract path's target; undefined outside it. */
export function underTarget(extract: string | undefined, k: string): string | undefined {
  if (!extract) return k;
  const prefix = shapeKey(extract);
  // a trailing [*] returns the items themselves, as a list: compare them as "[]..." like any list
  if (extract.endsWith("[*]") && (k === prefix || k.startsWith(`${prefix}.`) || k.startsWith(`${prefix}[]`)))
    return `[]${k.slice(prefix.length)}`;
  if (k.startsWith(`${prefix}.`)) return k.slice(prefix.length + 1);
  if (k.startsWith(`${prefix}[]`)) return k.slice(prefix.length);
  return undefined;
}

/** Learned shape and value, scoped to the extract path when it resolves: other subtrees may come and go. */
function shapeScope(
  op: Operation,
  data: unknown,
  target: unknown,
): { expected: Record<string, string>; value: unknown } {
  const shape = op.response.shape ?? {};
  const ex = op.response.extract;
  if (!ex) return { expected: shape, value: data };
  const expected: Record<string, string> = {};
  for (const [k, t] of Object.entries(shape)) {
    const at = underTarget(ex, k);
    if (at !== undefined) expected[at] = t;
  }
  return { expected, value: target };
}

/** The learned shape's entries for the picked fields: their names are in the pick already. */
export function pickedShape(res: ResponseSpec): Record<string, string> | undefined {
  if (!res.shape || !res.pick?.length) return undefined;
  const keys = new Set(
    res.pick.flatMap((p) => {
      const k = shapeKey(pickEntry(p).path);
      return [k, `[].${k}`];
    }),
  );
  const kept = Object.entries(res.shape).filter(([k]) => keys.has(underTarget(res.extract, k) ?? ""));
  return kept.length ? Object.fromEntries(kept) : undefined;
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * Picked fields the learned shape typed (not null) that no item carries now, or none with that type:
 * the answer would come back without them. A field learned null, or missing from the learned item, is
 * optional. A field that keeps its type and changes its meaning is not seen.
 */
function picksLost(op: Operation, expected: Record<string, string>, target: unknown): { name: string; why: string }[] {
  const list = Array.isArray(target);
  const items = (list ? target : [target]).filter((x) => x !== null && typeof x === "object");
  if (!op.response.pick?.length || !items.length) return [];
  const out: { name: string; why: string }[] = [];
  for (const p of op.response.pick) {
    const { name, path } = pickEntry(p);
    // a [*] path collects a list per item: the shape types its elements, not the list
    if (path.includes("[*]")) continue;
    const want = expected[`${list ? "[]." : ""}${shapeKey(path)}`];
    if (!want || want === "null") continue;
    const now = items.map((x) => getPath(x, path)).filter((v) => v !== undefined);
    if (!now.length) out.push({ name, why: `picked field ${name} disappeared from the response` });
    else if (!now.some((v) => v === null || typeOf(v) === want))
      out.push({ name, why: `picked field ${name} is now ${typeOf(now[0])}, learned as ${want}` });
  }
  return out;
}

/** Share of the learned shape still present with the same type; null matches anything. */
function shapeKept(expected: Record<string, string>, data: unknown): number {
  const now = inferShape(data, 2000);
  const paths = Object.keys(expected);
  const kept = paths.filter(
    (p) => now[p] !== undefined && (now[p] === expected[p] || now[p] === "null" || expected[p] === "null"),
  );
  return kept.length / paths.length;
}

/**
 * Why the pick leaves nothing of a non-empty list: no item has a picked field. pick drops items with
 * none (an ad, a shelf), so a list of only those empties too: missing data, which the example args
 * tell from drift.
 */
function pickEmptied(op: Operation, list: unknown): string | undefined {
  const fields = op.response.pick;
  if (!fields?.length || !Array.isArray(list) || !list.length) return undefined;
  if ((pick(list, fields) as unknown[]).length) return undefined;
  return `none of the ${list.length} items has a picked field (${fields.join(", ")})`;
}

function mentionsParam(op: Operation, body: string): boolean {
  const names = new Set(op.params.map((p) => p.name));
  for (const s of op.slots) {
    if (!s.param) continue;
    // the nearest named step: json:/legs/0/origin/airports/0 names "airports", not "0"
    const tokens = s.at.flatMap((st) =>
      st.startsWith("json:") ? st.slice(5).split("/") : [st.slice(st.indexOf(":") + 1)],
    );
    const name = tokens.reverse().find((t) => t && !/^\d+$/.test(t));
    if (name) names.add(name);
  }
  return [...names].some((n) => n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body));
}

export function classify(op: Operation, r: Observed): Classified {
  return classifyResponse(op, r, () => parseBody(r.body ?? "", op.response.xssiPrefix));
}

function classifyResponse(
  op: Operation,
  r: Observed,
  readJson: () => unknown,
  readTarget = (data: unknown) => getPath(data, op.response.extract),
): Classified {
  const body = r.body ?? "";
  const ct = (r.headers["content-type"] ?? "").toLowerCase();
  const isHtml = ct.includes("html") || /^\s*<(!doctype|html)/i.test(body);
  const wantsJson = op.response.format === "json";

  const wall = botWall(r, wantsJson, () => recipeFinds(op, body));
  if (wall) return is("blocked", wall);

  const { text: wait, ms: waitMs } = retryAfter(r.headers);
  const rate = (reason: string): Classified => ({
    ...is("rate", reason),
    ...(waitMs !== undefined ? { retryAfterMs: waitMs } : {}),
  });
  if (r.status === 429) return rate(`HTTP 429${wait}`);
  // Unavailable For Legal Reasons: refused to this network or region, the same at every tier
  if (r.status === 451)
    return is(
      "blocked",
      `HTTP 451: not available from this network or region${body.trim() ? `: ${snippet(body)}` : ""}`,
    );
  // a failure that names its wait (a 503 in maintenance, a 403 lockout) is a limit: sooner meets it again.
  // Retry-After: 0 names none (Reddit sends it on its network block page), so the status decides.
  if (r.status >= 400 && waitMs) return rate(`HTTP ${r.status}${wait}: ${snippet(body)}`);
  if (r.status >= 400 && REQUIRE_LOGIN.test(body)) return is("auth", `HTTP ${r.status}: ${snippet(body)}`);
  if (r.status >= 400 && RATE.test(body)) return rate(`HTTP ${r.status}${wait}: ${snippet(body)}`);
  // Laravel answers a stale CSRF token with 419, Rails with 422 InvalidAuthenticityToken. A bot
  // wall answers 419 too (Hacker News: "Sorry" to a non-browser claiming Chrome), so the reason
  // names CSRF only when the body does.
  const csrf = CSRF_FAILED.test(body) || (r.status === 419 && /page expired/i.test(body));
  if (r.status === 419 || ((r.status === 400 || r.status === 422) && csrf)) {
    return is("auth", `HTTP ${r.status}: ${csrf ? "CSRF check failed: " : ""}${snippet(body)}`);
  }
  if (r.status === 401) return is("auth", `HTTP 401: ${snippet(body)}`);
  if (r.status === 403) {
    return LOGIN.test(body) || CSRF_FAILED.test(body)
      ? is("auth", `HTTP 403 with login markers: ${snippet(body)}`)
      : { ...is("blocked", `HTTP 403 with no login or challenge markers: ${snippet(body)}`), missing: true };
  }
  if (r.url) {
    try {
      const u = new URL(r.url);
      if (LOGIN_URL.test(u.pathname) && !LOGIN_URL.test(new URL(op.request.url).pathname)) {
        return is("auth", `redirected to ${u.pathname}`);
      }
    } catch {
      /* not a URL; ignore */
    }
  }
  if (r.status === 404 || r.status === 410) {
    // With the param in the path, 404 usually means that entity doesn't exist. With a rotating id
    // in the path too (Next.js /_next/data/<buildId>/...), it may be a deploy: let the caller check.
    // A read's 404 is ambiguous either way (/api/user?name=nosuch): the example args tell.
    if (!op.slots.some((s) => s.param && s.at[0]!.startsWith("path:"))) {
      return op.readOnly
        ? missing(`HTTP ${r.status} on a templated API path`)
        : is("drift", `HTTP ${r.status} on a templated API path`);
    }
    return op.volatile.some((v) => v.at[0]!.startsWith("path:"))
      ? missing(`HTTP ${r.status}`)
      : is("input", `HTTP ${r.status}: not found`);
  }
  if (r.status === 400 && DRIFT.test(body)) return is("drift", `HTTP 400 schema error: ${snippet(body)}`);
  // a 400/422 form page (a signup's "username taken") shows a password field; only the wording counts
  if ((r.status === 400 || r.status === 422) && LOGIN_SAID.test(body))
    return is("auth", `HTTP ${r.status} with login markers: ${snippet(body)}`);
  if (r.status === 400 && mentionsParam(op, body)) return is("input", `HTTP 400: ${snippet(body)}`);
  if (r.status >= 500) return { ...is("error", `HTTP ${r.status}: ${snippet(body)}`), server: true };
  if (r.status < 200 || r.status >= 300) return is("error", `HTTP ${r.status}: ${snippet(body)}`);
  // A redirect gives no body of its own: one whose address names an error may carry a refusal, or
  // may follow a post that ran (Post/Redirect/Get), so it is neither done nor refused.
  const named = !op.readOnly && r.redirected ? errorInQuery(r.url) : undefined;
  if (named)
    return is("error", `redirected to ${r.url}, which names an error (${named}): the write may or may not have run`);
  // 201 with a Location: the resource was created, whatever its body names
  if (!op.readOnly && r.status === 201 && r.headers.location) return ok(`HTTP 201, created at ${r.headers.location}`);

  let data: unknown;
  try {
    data = readJson();
  } catch (error) {
    if (!op.readOnly) {
      if (isHtml && !/html/i.test(op.response.contentType ?? "") && signInForm(body))
        return is("auth", "a sign-in form where the write's answer was expected");
      // the form answered with its errors (nothing ran), or the post redirected back to it, showing one
      const shown = isHtml && (!r.redirected || onForm(op, r.url)) ? formError(body) : undefined;
      if (shown && r.redirected)
        return is("error", `redirected back to the form, which shows "${shown}": the write may or may not have run`);
      if (shown)
        return { ...is("error", `the service refused the write: the form answered "${shown}"`), rejected: true };
      return ok(`HTTP ${r.status}, ${body.trim() ? "non-JSON body" : "empty body"}`);
    }
    if (wantsJson) {
      if (isHtml && LOGIN.test(body)) return is("auth", "HTML login page where JSON was expected");
      const away = isHtml ? unfinishedPage(op, r) : undefined;
      if (away)
        return {
          ...is(
            "error",
            `redirected to ${away}, a page of the site with no sign-in form or challenge where JSON was expected: a step (consent, terms, verify it's you) to finish in the browser`,
          ),
          unfinished: away,
        };
      if (!body.trim()) return missing(`HTTP ${r.status} with an empty body`);
      // A body no reader here can walk is not a moved shape: nothing was compared, and healing would
      // re-learn from the same answer. The site did send JSON, so say what its depth did rather than
      // quoting it back, and let the caller see the cause instead of a snippet.
      if (error instanceof BodyTooDeep) return is("error", `response is not JSON: ${error.message}`);
      return is("drift", isHtml ? "HTML where JSON was expected" : `response is not JSON: ${snippet(body)}`);
    }
  }
  const d = data as { errors?: unknown; data?: unknown } | null;
  const errors = d && typeof d === "object" && Array.isArray(d.errors) && d.errors.length ? d.errors : undefined;
  // An error status in the body is judged as that status: a server's own failure is not moved data.
  const judgedAs = (e: { status: number; said: string }): Classified => {
    const as = `HTTP ${r.status} carrying ${e.said}, judged as HTTP ${e.status}`;
    // A read's bad request names no param here: like missing data, the example args tell bad args from drift.
    if (op.readOnly && e.status === 400) return missing(as);
    const c = classify(op, { ...r, status: e.status });
    const own = `HTTP ${e.status}`;
    const reason = c.reason.startsWith(own) ? as + c.reason.slice(own.length) : `${as}: ${c.reason}`;
    // a write refused with a 4xx did not run; a server's failure (5xx) is as ambiguous as that status
    return { ...c, reason, ...(!op.readOnly && e.status < 500 ? { rejected: true } : {}) };
  };
  const inBand = () => {
    const e = inBandError(data, op.response.extract);
    return e && judgedAs(e);
  };
  if (!op.readOnly) {
    if (errors && Object.keys(d!).every((k) => k === "data" || k === "errors" || k === "extensions")) {
      const c = graphqlErrors(errors);
      const payload = d!.data;
      // By the GraphQL spec no data at all is a request error (nothing ran), and null data an execution
      // that failed, as is null under every root field. A payload that is there may have partly run.
      if (payload && typeof payload === "object" && Object.values(payload).some((v) => v != null))
        return { ...c, reason: `the write may have partly run: ${c.reason}` };
      const why =
        payload === undefined
          ? "GraphQL errors and no data: a request error, so nothing ran"
          : "GraphQL errors with null data";
      return { ...c, reason: `the service refused the write (${why}): ${c.reason}`, rejected: true };
    }
    const e = inBand();
    if (e) return e;
    const no = refusal(data);
    if (no?.status) return judgedAs({ status: no.status, said: no.said });
    if (no) return { ...refusedAs(body, `the service refused the write (${no.said})`), rejected: true };
    return ok();
  }
  if (errors && d!.data == null) return graphqlErrors(errors, " with null data");
  // Partial data: errors next to a null target (a rate limit, a not-found user) are the answer, not a successful null.
  if (errors && op.response.extract && readTarget(data) == null)
    return graphqlErrors(errors, ` and a null "${op.response.extract}"`);

  if (op.response.format === "html") {
    if (!op.response.html) return ok();
    const items = extractHtml(body, op.response.html);
    if (htmlFinds(op.response.html, items)) return ok();
    if (loginPage(body)) return is("auth", "login page instead of content");
    if (emptyResults(body, op.response.html)) return ok("no results");
    const fields = Object.keys(op.response.html.fields).join(", ");
    return missing(
      items.length
        ? `selector "${op.response.html.items}" matched ${items.length} items but none of their fields (${fields})`
        : `selector "${op.response.html.items}" matched nothing`,
    );
  }
  if (op.response.format === "embedded") {
    const found = extract({ ...op.response, pick: undefined }, body);
    const emptied = pickEmptied(op, found);
    if (found !== undefined && !emptied) return ok();
    if (loginPage(body)) return is("auth", "login page instead of content");
    return missing(emptied ?? "embedded data not found");
  }

  // An empty list where the results go is a search with no results, not missing data.
  const target = readTarget(data);
  if (Array.isArray(target) && !target.length) return ok("no results");
  let gone: string | undefined;
  const scope = op.response.shape ? shapeScope(op, data, target) : undefined;
  // A site that renamed the picked fields: a shared spec has no learned shape to tell, and "no results" would lie.
  const emptied = pickEmptied(op, target);
  if (op.response.extract && target === undefined) gone = `extract path "${op.response.extract}" missing`;
  else if (emptied) gone = emptied;
  else if (scope && Object.keys(scope.expected).length >= 4 && shapeKept(scope.expected, scope.value) < 0.5) {
    gone = "response shape changed (under half of the learned key paths remain)";
  }
  // Only where the target is absent: without an extract path the whole body is the answer, and a null
  // target next to an error is the error, not a successful null. Data whose shape changed stays drift.
  if (!op.response.extract || target == null) {
    const e = inBand();
    if (e) return e;
  }
  if (!gone) {
    const lost = scope ? picksLost(op, scope.expected, target) : [];
    if (!lost.length) return ok();
    return { ...missing(lost.map((l) => l.why).join("; ")), lost: lost.map((l) => l.name) };
  }
  // Instagram answers "login_required" and "please wait" as 200 JSON; only trust the wording when the data is gone.
  if (REQUIRE_LOGIN.test(body)) return is("auth", `${gone}: ${snippet(body)}`);
  if (RATE.test(body)) return is("rate", `${gone}: ${snippet(body)}`);
  if (LOGIN.test(body)) return is("auth", `${gone}: ${snippet(body)}`);
  return missing(gone);
}

export interface Judged extends Classified {
  /** extracted and picked; when ok, or drift with `lost` */
  data?: unknown;
  /** the next page's cursor or number, from `paging.next` in the whole answer; only when ok */
  nextPage?: string | number;
  /** true with a nextPage; false when the answer says there is none (null, "" or false there) */
  hasMore?: boolean;
}

/**
 * What the whole answer says about the next page. Nothing at the path says nothing: a moved path
 * must not read as the last page.
 */
function pageOf(op: Operation, body: string, json: () => unknown): Pick<Judged, "nextPage" | "hasMore"> {
  const at = op.paging?.next;
  const res = op.response;
  if (!at || res.format === "html") return {};
  try {
    const whole = res.format === "embedded" ? res.embedded && extractEmbedded(body, res.embedded.regex) : json();
    // `path~regex` reads the cursor out of a string (a next-page URL); null, "" or false there is still the last page
    const raw = getPath(whole, splitRegex(at).path);
    const v = raw === null || raw === "" || raw === false ? raw : getPathRegex(whole, at);
    if ((typeof v === "string" && v !== "") || (typeof v === "number" && Number.isFinite(v)))
      return { nextPage: v, hasMore: true };
    return v === null || v === "" || v === false ? { hasMore: false } : {};
  } catch {
    return {};
  }
}

/** classify, then extract when ok. Never throws: a bad selector or regex in the spec is an error. */
export function judge(op: Operation, r: Observed): Judged {
  let parsed: unknown;
  let read = false;
  let target: unknown;
  let selected = false;
  const readJson = () => {
    if (!read) {
      parsed = parseBody(r.body ?? "", op.response.xssiPrefix);
      read = true;
    }
    return parsed;
  };
  const readTarget = (data: unknown) => {
    if (!selected) {
      target = getPath(data, op.response.extract);
      selected = true;
    }
    return target;
  };
  let c: Classified;
  try {
    c = classifyResponse(op, r, readJson, readTarget);
  } catch (e) {
    // nothing was compared, and the same page comes back: an error, with its own words
    if (e instanceof PageTooLarge) return is("error", e.message);
    return is("error", `the op's response recipe failed: ${(e as Error).message}`);
  }
  if (c.class !== "ok" && !c.lost) return c;
  try {
    // from the whole answer, before extract and pick throw the rest away
    const page = pageOf(op, r.body, readJson);
    // r.url is the page's final address (redirects included): it is where a relative @href/@src lives
    if (op.response.format !== "json") return { ...c, data: extract(op.response, r.body, r.url), ...page };
    const data = readTarget(readJson());
    return {
      ...c,
      data: data !== undefined && op.response.pick?.length ? pick(data, op.response.pick) : data,
      ...page,
    };
  } catch (e) {
    // a write's non-JSON answer: hand back its text
    if (!op.readOnly) return { ...c, data: r.body.trim() ? r.body.slice(0, 1000) : null };
    // not drift: a heal would read the same page again
    if (e instanceof PageTooLarge) return is("error", e.message);
    return is("drift", `extract failed: ${(e as Error).message}`);
  }
}
